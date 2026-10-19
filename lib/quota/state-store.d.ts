export type QuotaBackend = "exa" | "parallel" | "tavily" | "firecrawl" | "serpapi" | "tinyfish";
export type QuotaChannel = "anonymous" | "key";
export type QuotaFailureReason = "rate_limited" | "quota_exhausted";
export interface PersistedQuotaEntry {
    scopeId: string;
    backend: QuotaBackend;
    channel: QuotaChannel;
    reason: QuotaFailureReason;
    failureCount: number;
    until: number;
    lastFailureAt: number;
    updatedAt: number;
    cleared?: boolean;
}
export interface PersistedQuotaState {
    version: 1;
    salt: string;
    entries: PersistedQuotaEntry[];
}
export type QuotaStateLoadResult = {
    status: "ok";
    state: PersistedQuotaState;
} | {
    status: "missing";
} | {
    status: "unavailable" | "corrupt" | "unknown_version";
    reason: string;
};
export type QuotaStateSaveResult = {
    status: "saved" | "memory_only";
} | {
    status: "unavailable";
    reason: string;
};
export interface QuotaStateStore {
    readonly kind?: "memory" | "private";
    load(): Promise<QuotaStateLoadResult>;
    save(state: PersistedQuotaState): Promise<QuotaStateSaveResult>;
}
/** 默认内存状态仓库；新 manager 实例不共享，测试可自行注入。 */
export declare function createMemoryQuotaStateStore(): QuotaStateStore;
/** 私有磁盘仓库；只有显式构造后才访问该目录。 */
export declare function createPrivateQuotaStateStore(directory: string): QuotaStateStore;
