/** 搜索后端共用的结果类型、错误分类与响应校验；不访问网络或凭据。 */
import type { SearchSource } from "./contracts.js";
/** 兼容旧名称：来源结构与内核契约一致。 */
export type WebSource = SearchSource;
export type SearchErrorKind = "quota_preflight" | "quota_exhausted" | "rate_limited" | "invalid_key" | "server_error" | "network_error" | "timeout" | "aborted" | "protocol_error" | "response_too_large" | "budget_exhausted";
/** 带分类的错误；请求层回填实际尝试次数。 */
export declare class BackendError extends Error {
    readonly kind: SearchErrorKind;
    readonly retryAfterMs?: number | undefined;
    attempts: number;
    constructor(message: string, kind: SearchErrorKind, retryAfterMs?: number | undefined);
    get retryable(): boolean;
}
export declare function statusKind(status: number): SearchErrorKind;
export declare function messageKind(message: string): SearchErrorKind | undefined;
export declare function httpKind(status: number, detail: string): SearchErrorKind;
/**
 * 只接受不含内嵌凭据的可点击网页链接。
 *
 * 脚本、本地文件与内联数据不是可引用的来源；`https://user:pass@host` 也不行，
 * 那会把凭据带进搜索结果。
 */
export declare function isHttpUrl(value: string): boolean;
/** 提取各服务的错误文本；调用方必须在输出前脱敏。 */
export declare function errorDetailFrom(payload: unknown): string | undefined;
