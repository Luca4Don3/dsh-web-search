/**
 * 额度内核的纯类型切片。
 *
 * 拆出来是为了让 `search/routing.ts` 这类纯模块只依赖类型，
 * 不把 Node 的 fs / crypto 拖进任何依赖图。
 */

export type QuotaBackend = "exa" | "parallel" | "tavily" | "firecrawl" | "serpapi" | "tinyfish";
export type QuotaChannel = "anonymous" | "key";
export type QuotaFailureReason = "rate_limited" | "quota_exhausted";

export interface QuotaCooldown {
	backend: QuotaBackend;
	channel: QuotaChannel;
	reason: QuotaFailureReason;
	until: number;
	remainingMs: number;
	failureCount: number;
	/** 额度冷却仅是建议探测时间，不代表真实额度重置时间。 */
	nextProbeAt?: number;
}

export interface QuotaSnapshot {
	persistence: "not_initialized" | "persistent" | "memory_only" | "degraded";
	persistenceReason?: string;
	cooldowns: QuotaCooldown[];
}
