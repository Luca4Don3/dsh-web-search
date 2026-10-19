/** 安全的有界 HTTP 传输：逐跳校验目标，并在请求全程共享绝对截止时间。 */
import { type ResolvedTarget } from "./url-policy.js";
export interface HttpFetchRequest {
    /** 规范化后的目标 URL。 */
    readonly url: URL;
    /** 已校验的目标地址；连接只允许使用它。 */
    readonly target: ResolvedTarget;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
    /** 可传入先前创建的截止时刻，避免初始 DNS 后重置预算。 */
    readonly deadlineMs?: number;
    readonly maxResponseBytes: number;
    /** 重定向上限，默认 3。 */
    readonly maxRedirects?: number;
    /** 每一跳重新解析目标；默认策略会使用 signal 取消 DNS 等待。 */
    readonly resolveTarget?: (url: string, signal?: AbortSignal) => Promise<ResolvedTarget>;
}
export interface HttpFetchResponse {
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly finalUrl: URL;
    readonly redirectCount: number;
}
/** 只发送固定请求头，不转发调用方任何头。 */
export declare function buildHeaders(url: URL): Record<string, string>;
/** 带逐跳目标校验与单一绝对截止时间的完整抓取。 */
export declare function httpFetch(input: HttpFetchRequest): Promise<HttpFetchResponse>;
