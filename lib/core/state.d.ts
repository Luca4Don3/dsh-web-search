export type StateBackend = "exa" | "tavily" | "parallel" | "firecrawl" | "tinyfish";
export type StateChannel = "anonymous" | "key";
export type StateReason = "rate_limited" | "quota_exhausted";
export interface StateEntry {
    scope: string;
    backend: StateBackend;
    channel: StateChannel;
    reason: StateReason;
    failures: number;
    until: number;
    lastAt: number;
    updatedAt: number;
    cleared?: boolean;
}
export interface QuotaState {
    version: 1;
    salt: string;
    entries: StateEntry[];
}
export type StoreResult = {
    status: "ok";
    state: QuotaState;
} | {
    status: "missing";
} | {
    status: "cancelled";
} | {
    status: "unavailable";
    reason?: "unsupported_platform";
};
export type SaveResult = "saved" | "unavailable" | "cancelled";
export interface StateStore {
    load(signal?: AbortSignal): Promise<StoreResult>;
    save(state: QuotaState, signal?: AbortSignal): Promise<SaveResult>;
}
/** 显式路径才会访问磁盘；仅认可本项目协议文件，绝不 chmod 或追随链接。 */
export declare function createPrivateStateStore(directory: string, options?: {
    platform?: NodeJS.Platform;
}): StateStore;
