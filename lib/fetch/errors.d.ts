/**
 * web_fetch 的抓取错误类型与分类。
 *
 * 与 web-search 的错误分类刻意保持相似但相互独立：两个扩展可分别安装，
 * 不互相 import，避免升级其中一个破坏另一个。
 */
/** 抓取失败的固定分类；`details.errorKind` 只使用这些值。 */
export type FetchErrorKind = "invalid_url" | "blocked_url" | "http_error" | "network_error" | "timeout" | "aborted" | "response_too_large" | "unsupported_content" | "extraction_failed" | "remote_unavailable" | "remote_blocked";
/** 带分类的抓取错误；分类是固定字符串，不回显调用方输入或上游原文。 */
export declare class FetchError extends Error {
    readonly kind: FetchErrorKind;
    readonly options?: {
        readonly statusCode?: number;
        readonly retryAfterMs?: number;
    } | undefined;
    constructor(message: string, kind: FetchErrorKind, options?: {
        readonly statusCode?: number;
        readonly retryAfterMs?: number;
    } | undefined);
    get retryable(): boolean;
}
/** 把未知异常统一收敛为带分类的抓取错误；异常原文不进入分类。 */
export declare function toFetchError(error: unknown, fallbackKind?: FetchErrorKind): FetchError;
