/**
 * `Retry-After` 解析：秒数或 HTTP 日期，统一返回毫秒。
 *
 * 搜索与抓取对上限的要求不同，因此上限由调用方传入，而不是写死在解析里：
 * - 搜索侧把它当作冷却时长，上限 24 小时；
 * - 抓取侧只用于诊断，保留原始值不钳制。
 */
export const RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;

export interface RetryAfterOptions {
	/** 结果上限（毫秒）。省略表示不钳制。 */
	readonly maxMs?: number;
	/** 当前时间，测试可注入。 */
	readonly now?: number;
}

/**
 * 解析单个 header 值。
 *
 * 空值、非法数字与非法日期都返回 `undefined`，调用方据此使用自身的退避阶梯。
 */
export function parseRetryAfter(value: string | null | undefined, options: RetryAfterOptions = {}): number | undefined {
	if (value === null || value === undefined) return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	const clamp = (ms: number): number => (options.maxMs === undefined ? ms : Math.min(ms, options.maxMs));
	const seconds = Number(trimmed);
	if (Number.isFinite(seconds) && seconds >= 0) return clamp(Math.ceil(seconds * 1000));
	const at = Date.parse(trimmed);
	if (Number.isNaN(at)) return undefined;
	return clamp(Math.max(0, at - (options.now ?? Date.now())));
}

/** 解析 Node `IncomingHttpHeaders` 里可能是数组的同名头，取第一个值。 */
export function parseRetryAfterHeader(value: string | string[] | undefined, options: RetryAfterOptions = {}): number | undefined {
	if (value === undefined) return undefined;
	return parseRetryAfter(Array.isArray(value) ? value[0] : value, options);
}
