/**
 * 有界的响应正文读取：按解压后字节计数、增量解码 UTF-8。
 *
 * 同时接受 `AbortController` 与 `AbortSignal` 两种调用形态：
 * 内核内部用控制器以便超限时主动撤销网络；外部调用方可以只传信号。
 * 两种形态的行为完全一致，超限与取消都抛出带分类的错误。
 */
import { BackendError } from "../search/core.js";

export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

const INVALID_LIMIT_MESSAGE = "响应体上限必须是正整数";
const TOO_LARGE_MESSAGE = "响应体超过允许的大小上限";
const MAX_RESPONSE_LIMIT = MAX_RESPONSE_BYTES;

function isValidLimit(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 1 && value <= MAX_RESPONSE_LIMIT;
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
 * 后者，并通过 `tooLarge` 布尔字段给旧调用方一个明确判断，而不是复制两套名字。
 */
class ResponseTooLargeError extends BackendError {
	readonly tooLarge = true;
	constructor() {
		super(TOO_LARGE_MESSAGE, "response_too_large");
	}
}

function tooLargeError(): ResponseTooLargeError {
	return new ResponseTooLargeError();
}

/** 把可选的控制器或信号统一成“信号 + 主动中止”两个能力。 */
function resolveAbort(input: AbortController | AbortSignal, onAbort?: () => void): { signal: AbortSignal; abort(): void } {
	if (typeof (input as AbortController).abort === "function" && "signal" in input) {
		const controller = input as AbortController;
		return { signal: controller.signal, abort: () => controller.abort() };
	}
	const signal = input as AbortSignal;
	return { signal, abort: () => onAbort?.() };
}

/**
 * 按流累计 UTF-8 字节数并增量解码。取消和超限时都中止请求、取消 reader，
 * 且不等待底层取消完成，避免不遵守 AbortSignal 的模拟流拖住调用方。
 */
export async function readResponseTextLimited(
	response: Response,
	maxBytes: number,
	abortInput: AbortController | AbortSignal,
	abort?: () => void,
): Promise<string> {
	if (!isValidLimit(maxBytes)) throw new Error(INVALID_LIMIT_MESSAGE);
	const { signal, abort: abortRequest } = resolveAbort(abortInput, abort);
	if (signal.aborted) throw createReadAbortError();
	const body = response.body;
	if (body === null) return "";

	let reader: ReadableStreamDefaultReader<Uint8Array>;
	try {
		reader = body.getReader();
	} catch {
		abortRequest();
		throw tooLargeError();
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
	const cancelReader = (): void => {
		if (cancelled) return;
		cancelled = true;
		try {
			const pending = reader.cancel();
			if (pending) void Promise.resolve(pending).catch(() => undefined);
		} catch {
			// 取消失败不改变对外分类。
		}
	};
	let onAbort: (() => void) | undefined;
	const abortPromise = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(createReadAbortError());
		signal.addEventListener("abort", onAbort, { once: true });
	});
	abortPromise.catch(() => undefined);
	if (signal.aborted) {
		onAbort?.();
		throw createReadAbortError();
	}
	let pendingRead: Promise<unknown> | undefined;
	let completed = false;
	try {
		const decoder = new TextDecoder();
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
			if (signal.aborted) throw createReadAbortError();
			if (result.type === "error") throw result.error;
			if (result.value.done) {
				const tail = decoder.decode();
				if (tail.length > 0) parts.push(tail);
				completed = true;
				return parts.join("");
			}
			totalBytes += result.value.value.byteLength;
			if (totalBytes > maxBytes) {
				abortRequest();
				cancelReader();
				throw tooLargeError();
			}
			const decoded = decoder.decode(result.value.value, { stream: true });
			if (decoded.length > 0) parts.push(decoded);
		}
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
		if (!completed && !signal.aborted) abortRequest();
		if (!completed) cancelReader();
		releaseLock();
		if (pendingRead !== undefined) void pendingRead.then(releaseLock, releaseLock);
	}
}
