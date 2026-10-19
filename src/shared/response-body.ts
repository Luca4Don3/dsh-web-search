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

function isValidLimit(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 1 && value <= MAX_RESPONSE_BYTES;
}

/** 读取 `PI_WEB_SEARCH_MAX_RESPONSE_BYTES` / `DSH_WEB_SEARCH_MAX_RESPONSE_BYTES`，非法值明确失败。 */
export function readMaxResponseBytes(env: Record<string, string | undefined> = process.env): number {
	const raw = env.PI_WEB_SEARCH_MAX_RESPONSE_BYTES ?? env.DSH_WEB_SEARCH_MAX_RESPONSE_BYTES;
	if (raw === undefined) return DEFAULT_MAX_RESPONSE_BYTES;
	const trimmed = raw.trim();
	if (!/^\d+$/u.test(trimmed)) throw new Error("响应体上限必须是十进制正整数");
	const value = Number(trimmed);
	if (!isValidLimit(value)) throw new Error(INVALID_LIMIT_MESSAGE);
	return value;
}

function createReadAbortError(): DOMException {
	return new DOMException("Response body reading aborted", "AbortError");
}

/**
 * 超限错误：`kind` 统一为 `response_too_large`。
 *
 * 合并前 DSH 侧叫 `too_large`，Pi 侧叫 `response_too_large`；合并后只保留
 * 后者，并通过 `tooLarge` 布尔字段给旧调用方一个明确判断。
 */
class ResponseTooLargeError extends BackendError {
	readonly tooLarge = true;
	constructor() {
		super(TOO_LARGE_MESSAGE, "response_too_large");
	}
}

/** 取消/超限/不可读等场景的错误构造；两侧各自注入以保持既有分类。 */
export interface ReadErrorFactory {
	/** 调用方已取消。 */
	aborted(): Error;
	/** 解压后正文超过上限。 */
	tooLarge(): Error;
	/** 正文无法取得 reader。 */
	unreadable?(): Error;
	/** 按声明字符集解码失败（仅在解码策略严格时使用）。 */
	undecodable?(): Error;
}

/** 解码策略：`utf8` 固定 UTF-8；`declared` 读取 content-type 的 charset。 */
export type DecodeStrategy = "utf8" | "declared";

export interface ReadOptions {
	/** 中止信号；超限时会调用 `abortRequest` 主动撤销网络。 */
	readonly signal: AbortSignal;
	/** 超限/取消时主动中止底层请求；省略时只取消 reader。 */
	abortRequest?: () => void;
	/** 解码策略，默认 `utf8`。 */
	readonly decode?: DecodeStrategy;
	/** 显式字符集；仅 `declared` 策略使用，省略时从响应头读取。 */
	readonly charset?: string;
	readonly errors: ReadErrorFactory;
	/** `declared` 策略下，解码失败时是否立即失败；默认 true。 */
	readonly fatalDecode?: boolean;
}

function getCharset(response: Response, explicit?: string): string {
	if (explicit !== undefined) return explicit.trim();
	const contentType = response.headers.get("content-type") ?? "";
	const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/iu.exec(contentType);
	return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "utf-8").trim();
}

function decoderFor(response: Response, options: ReadOptions): TextDecoder {
	if (options.decode !== "declared") return new TextDecoder();
	const charset = getCharset(response, options.charset);
	// 抓取侧要求未知字符集明确失败；搜索侧不走这条路径，因此不影响其行为。
	return new TextDecoder(charset, { fatal: options.fatalDecode ?? true });
}

function cancelUnlockedBody(response: Response): void {
	try {
		const cancellation = response.body?.cancel();
		if (cancellation !== undefined) void Promise.resolve(cancellation).catch(() => undefined);
	} catch {
		// 被其他 reader 锁定时由 AbortController 负责停止底层请求。
	}
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
	try {
		const pending = reader.cancel();
		if (pending) void Promise.resolve(pending).catch(() => undefined);
	} catch {
		// 取消失败不改变对外分类。
	}
}

/**
 * 核心实现：两侧共用。
 *
 * 超限与取消都会中止底层请求、取消 reader，且不等待可能挂起的清理，
 * 避免不遵守 AbortSignal 的模拟流拖住调用方。
 */
async function readLimited(response: Response, maxBytes: number, options: ReadOptions): Promise<string> {
	if (!isValidLimit(maxBytes)) throw new Error(INVALID_LIMIT_MESSAGE);
	const { signal, errors } = options;
	const abortRequest = options.abortRequest;
	if (signal.aborted) {
		cancelUnlockedBody(response);
		throw errors.aborted();
	}
	const body = response.body;
	if (body === null || body === undefined) return "";

	let decoder: TextDecoder;
	try {
		decoder = decoderFor(response, options);
	} catch (error) {
		cancelUnlockedBody(response);
		abortRequest?.();
		if (options.decode === "declared" && errors.undecodable !== undefined) throw errors.undecodable();
		throw error;
	}

	let reader: ReadableStreamDefaultReader<Uint8Array>;
	try {
		reader = body.getReader();
	} catch {
		cancelUnlockedBody(response);
		abortRequest?.();
		throw errors.unreadable?.() ?? errors.tooLarge();
	}

	let cancelled = false;
	let released = false;
	const releaseLock = (): void => {
		if (released) return;
		released = true;
		try {
			reader.releaseLock();
		} catch {
			// 已释放或仍在读取时忽略：清理不能覆盖原始错误。
		}
	};
	const cancel = (): void => {
		if (cancelled) return;
		cancelled = true;
		cancelReader(reader);
	};
	let onAbort: (() => void) | undefined;
	const abortPromise = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(errors.aborted());
		signal.addEventListener("abort", onAbort, { once: true });
	});
	abortPromise.catch(() => undefined);
	if (signal.aborted) {
		onAbort?.();
		throw errors.aborted();
	}
	let pendingRead: Promise<unknown> | undefined;
	let completed = false;
	try {
		const parts: string[] = [];
		let totalBytes = 0;
		for (;;) {
			const read = Promise.resolve().then(() => reader.read());
			type Outcome = { type: "read"; value: ReadableStreamReadResult<Uint8Array> } | { type: "error"; error: unknown };
			const outcome: Promise<Outcome> = read.then(
				(value) => ({ type: "read", value }) as Outcome,
				(error) => ({ type: "error", error }) as Outcome,
			);
			void outcome.then(() => {
				if (cancelled) releaseLock();
			});
			pendingRead = outcome;
			const result = (await Promise.race([outcome, abortPromise])) as Outcome;
			pendingRead = undefined;
			if (signal.aborted) throw errors.aborted();
			if (result.type === "error") throw result.error;
			if (result.value.done) {
				try {
					const tail = decoder.decode();
					if (tail.length > 0) parts.push(tail);
				} catch (error) {
					// 流结束时的残缺字节同样属于解码失败，必须先按声明分类再抛出。
					if (options.decode === "declared" && errors.undecodable !== undefined) throw errors.undecodable();
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
				if (decoded.length > 0) parts.push(decoded);
			} catch (error) {
				if (options.decode === "declared" && errors.undecodable !== undefined) throw errors.undecodable();
				throw error;
			}
		}
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
		if (!completed && !signal.aborted) abortRequest?.();
		if (!completed) cancel();
		releaseLock();
		if (pendingRead !== undefined) void pendingRead.then(releaseLock, releaseLock);
	}
}

/** 搜索 / 额度查询入口：固定 UTF-8，接受控制器或信号。 */
export async function readResponseTextLimited(
	response: Response,
	maxBytes: number,
	abortInput: AbortController | AbortSignal,
	abort?: () => void,
): Promise<string> {
	const isController = typeof (abortInput as AbortController).abort === "function" && "signal" in abortInput;
	const signal = isController ? (abortInput as AbortController).signal : (abortInput as AbortSignal);
	const abortRequest = isController ? () => (abortInput as AbortController).abort() : abort;
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
export async function readTextLimited(
	response: Response,
	maxBytes: number,
	options: ReadOptions,
): Promise<string> {
	return readLimited(response, maxBytes, options);
}
