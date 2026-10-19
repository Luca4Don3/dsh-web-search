/**
 * 有界的响应正文读取：按解压后字节计数、增量解码。
 *
 * 搜索与抓取共用这一份字节计数、取消竞速与清理逻辑；两者的差异只在
 * {@link ReadOptions} 里声明，而不是复制两套实现：
 * - 解码：抓取按 `content-type` 声明解码（支持 GBK 等）且未知字符集明确失败；
 *   搜索固定 UTF-8，与历史行为逐字节一致。
 * - 错误：两侧各自注入错误工厂，保持既有的错误分类不变。
 *
 * 因此 {@link readResponseTextLimited}（搜索/额度）与
 * {@link readTextLimited}（抓取）是同一实现的两种配置，而不是两份代码。
 */
import { BackendError } from "../search/core.js";
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const INVALID_LIMIT_MESSAGE = "响应体上限必须是正整数";
const TOO_LARGE_MESSAGE = "响应体超过允许的大小上限";
function isValidLimit(value) {
    return Number.isSafeInteger(value) && value >= 1 && value <= MAX_RESPONSE_BYTES;
}
/** 读取 `PI_WEB_SEARCH_MAX_RESPONSE_BYTES` / `DSH_WEB_SEARCH_MAX_RESPONSE_BYTES`，非法值明确失败。 */
export function readMaxResponseBytes(env = process.env) {
    const raw = env.PI_WEB_SEARCH_MAX_RESPONSE_BYTES ?? env.DSH_WEB_SEARCH_MAX_RESPONSE_BYTES;
    if (raw === undefined)
        return DEFAULT_MAX_RESPONSE_BYTES;
    const trimmed = raw.trim();
    if (!/^\d+$/u.test(trimmed))
        throw new Error("响应体上限必须是十进制正整数");
    const value = Number(trimmed);
    if (!isValidLimit(value))
        throw new Error(INVALID_LIMIT_MESSAGE);
    return value;
}
function createReadAbortError() {
    return new DOMException("Response body reading aborted", "AbortError");
}
/**
 * 超限错误：`kind` 统一为 `response_too_large`。
 *
 * 合并前 DSH 侧叫 `too_large`，Pi 侧叫 `response_too_large`；合并后只保留
 * 后者，并通过 `tooLarge` 布尔字段给旧调用方一个明确判断。
 */
class ResponseTooLargeError extends BackendError {
    tooLarge = true;
    constructor() {
        super(TOO_LARGE_MESSAGE, "response_too_large");
    }
}
function getCharset(response, explicit) {
    if (explicit !== undefined)
        return explicit.trim();
    const contentType = response.headers.get("content-type") ?? "";
    const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/iu.exec(contentType);
    return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "utf-8").trim();
}
function decoderFor(response, options) {
    if (options.decode !== "declared")
        return new TextDecoder();
    const charset = getCharset(response, options.charset);
    // 抓取侧要求未知字符集明确失败；搜索侧不走这条路径，因此不影响其行为。
    return new TextDecoder(charset, { fatal: options.fatalDecode ?? true });
}
function cancelUnlockedBody(response) {
    try {
        const cancellation = response.body?.cancel();
        if (cancellation !== undefined)
            void Promise.resolve(cancellation).catch(() => undefined);
    }
    catch {
        // 被其他 reader 锁定时由 AbortController 负责停止底层请求。
    }
}
function cancelReader(reader) {
    try {
        const pending = reader.cancel();
        if (pending)
            void Promise.resolve(pending).catch(() => undefined);
    }
    catch {
        // 取消失败不改变对外分类。
    }
}
/**
 * 核心实现：两侧共用。
 *
 * 超限与取消都会中止底层请求、取消 reader，且不等待可能挂起的清理，
 * 避免不遵守 AbortSignal 的模拟流拖住调用方。
 */
async function readLimited(response, maxBytes, options) {
    if (!isValidLimit(maxBytes))
        throw new Error(INVALID_LIMIT_MESSAGE);
    const { signal, errors } = options;
    const abortRequest = options.abortRequest;
    if (signal.aborted) {
        cancelUnlockedBody(response);
        throw errors.aborted();
    }
    const body = response.body;
    if (body === null || body === undefined)
        return "";
    let decoder;
    try {
        decoder = decoderFor(response, options);
    }
    catch (error) {
        cancelUnlockedBody(response);
        abortRequest?.();
        if (options.decode === "declared" && errors.undecodable !== undefined)
            throw errors.undecodable();
        throw error;
    }
    let reader;
    try {
        reader = body.getReader();
    }
    catch {
        cancelUnlockedBody(response);
        abortRequest?.();
        throw errors.unreadable?.() ?? errors.tooLarge();
    }
    let cancelled = false;
    let released = false;
    const releaseLock = () => {
        if (released)
            return;
        released = true;
        try {
            reader.releaseLock();
        }
        catch {
            // 已释放或仍在读取时忽略：清理不能覆盖原始错误。
        }
    };
    const cancel = () => {
        if (cancelled)
            return;
        cancelled = true;
        cancelReader(reader);
    };
    let onAbort;
    const abortPromise = new Promise((_resolve, reject) => {
        onAbort = () => reject(errors.aborted());
        signal.addEventListener("abort", onAbort, { once: true });
    });
    abortPromise.catch(() => undefined);
    if (signal.aborted) {
        onAbort?.();
        throw errors.aborted();
    }
    let pendingRead;
    let completed = false;
    try {
        const parts = [];
        let totalBytes = 0;
        for (;;) {
            const read = Promise.resolve().then(() => reader.read());
            const outcome = read.then((value) => ({ type: "read", value }), (error) => ({ type: "error", error }));
            void outcome.then(() => {
                if (cancelled)
                    releaseLock();
            });
            pendingRead = outcome;
            const result = (await Promise.race([outcome, abortPromise]));
            pendingRead = undefined;
            if (signal.aborted)
                throw errors.aborted();
            if (result.type === "error")
                throw result.error;
            if (result.value.done) {
                try {
                    const tail = decoder.decode();
                    if (tail.length > 0)
                        parts.push(tail);
                }
                catch (error) {
                    // 流结束时的残缺字节同样属于解码失败，必须先按声明分类再抛出。
                    if (options.decode === "declared" && errors.undecodable !== undefined)
                        throw errors.undecodable();
                    throw error;
                }
                completed = true;
                return parts.join("");
            }
            totalBytes += result.value.value.byteLength;
            if (totalBytes > maxBytes) {
                abortRequest?.();
                cancel();
                throw errors.tooLarge();
            }
            try {
                const decoded = decoder.decode(result.value.value, { stream: true });
                if (decoded.length > 0)
                    parts.push(decoded);
            }
            catch (error) {
                if (options.decode === "declared" && errors.undecodable !== undefined)
                    throw errors.undecodable();
                throw error;
            }
        }
    }
    finally {
        if (onAbort)
            signal.removeEventListener("abort", onAbort);
        if (!completed && !signal.aborted)
            abortRequest?.();
        if (!completed)
            cancel();
        releaseLock();
        if (pendingRead !== undefined)
            void pendingRead.then(releaseLock, releaseLock);
    }
}
/** 搜索 / 额度查询入口：固定 UTF-8，接受控制器或信号。 */
export async function readResponseTextLimited(response, maxBytes, abortInput, abort) {
    const isController = typeof abortInput.abort === "function" && "signal" in abortInput;
    const signal = isController ? abortInput.signal : abortInput;
    const abortRequest = isController ? () => abortInput.abort() : abort;
    return readLimited(response, maxBytes, {
        signal,
        ...(abortRequest === undefined ? {} : { abortRequest }),
        decode: "utf8",
        errors: {
            aborted: () => createReadAbortError(),
            tooLarge: () => new ResponseTooLargeError(),
        },
    });
}
/** 抓取入口：按声明字符集解码；错误由抓取侧注入以保持既有分类。 */
export async function readTextLimited(response, maxBytes, options) {
    return readLimited(response, maxBytes, options);
}
