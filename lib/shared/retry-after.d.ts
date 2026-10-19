/**
 * `Retry-After` 解析：秒数或 HTTP 日期，统一返回毫秒。
 *
 * 搜索与抓取对上限的要求不同，因此上限由调用方传入，而不是写死在解析里：
 * - 搜索侧把它当作冷却时长，上限 24 小时；
 * - 抓取侧只用于诊断，保留原始值不钳制。
 */
export declare const RETRY_AFTER_MAX_MS: number;
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
export declare function parseRetryAfter(value: string | null | undefined, options?: RetryAfterOptions): number | undefined;
/** 解析 Node `IncomingHttpHeaders` 里可能是数组的同名头，取第一个值。 */
export declare function parseRetryAfterHeader(value: string | string[] | undefined, options?: RetryAfterOptions): number | undefined;
