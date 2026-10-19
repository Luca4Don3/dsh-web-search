import type { QuotaBackend } from "./state-store.js";
export type QuotaUnknownReason = "authorization_required" | "unsupported_backend" | "lookup_failed" | "invalid_response" | "timeout" | "aborted" | "rate_limited";
export type QuotaLookupResult = {
    state: "known";
    remaining: number;
    eligibility: "not_verified";
    observedAt?: number;
} | {
    state: "unknown";
    reason: QuotaUnknownReason;
    retryAfterMs?: number;
};
export interface QuotaLookupInput {
    backend: QuotaBackend;
    credential: string;
    allowBillable: boolean;
    signal?: AbortSignal;
}
export interface QuotaLookupOptions {
    deadlineMs?: number;
    maxResponseBytes?: number;
    clock?: () => number;
    fetch?: typeof globalThis.fetch;
}
/** key.limit 明确为 null 仅表示没有 key 专属上限；账户计划与按量余额仍须有限且可验证。 */
export declare function parseTavilyUsage(value: unknown): QuotaLookupResult;
/** Firecrawl 的 planCredits 与账期日期不能证明剩余额度或免费资格。 */
export declare function parseFirecrawlUsage(value: unknown): QuotaLookupResult;
/** 仅明确授权的 key 可调用；单次 GET 的总期限覆盖 fetch 与有界解压正文读取。 */
export declare function lookupUsage(input: QuotaLookupInput, options?: QuotaLookupOptions): Promise<QuotaLookupResult>;
