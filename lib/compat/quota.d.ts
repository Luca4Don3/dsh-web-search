import { type StateBackend, type StateChannel, type StateReason, type StateStore } from "./state.js";
import type { SearchDependencies, SearchOptions } from "../search/contracts.js";
type Balance = {
    known: true;
    remaining: number;
} | {
    known: false;
    retryAfter?: number;
};
type Reservation = {
    cost: number;
    dispatch(): boolean;
    release(): void;
    settle(): void;
};
type Lookup = (backend: "tavily" | "firecrawl", key: string, signal: AbortSignal) => Promise<Balance>;
type PersistenceResult = "saved" | "memory_only" | "degraded";
export declare function safeRetryAfter(value: string | null): number | undefined;
export declare function parseUsageBody(backend: "tavily" | "firecrawl", text: string): Balance;
/** 余额与预留只在当前实例内有效，不提供跨账户或跨进程账单硬限制。 */
export declare class QuotaManager {
    private salt;
    private records;
    private balances;
    private ledgers;
    private flights;
    private initialization?;
    private initialized;
    private initializationUnavailable;
    private unsupportedPlatform;
    private pendingMutations;
    private persistence;
    private revision;
    private persistedRevision;
    private capacityReached;
    private closed;
    private writer?;
    private writeScheduled;
    private readonly store?;
    private readonly now;
    constructor(options: SearchOptions, deps: SearchDependencies, store?: StateStore);
    private scope;
    initialize(signal?: AbortSignal): Promise<void>;
    cooldown(backend: StateBackend, channel: StateChannel, key: string | undefined, override?: number): StateReason | undefined;
    private remember;
    private applyMutation;
    recordFailure(backend: StateBackend, channel: StateChannel, key: string | undefined, reason: StateReason, retryAfter?: number, override?: number): void;
    recordSuccess(backend: StateBackend, channel: StateChannel, key: string | undefined): void;
    private waitFor;
    balance(backend: "tavily" | "firecrawl", key: string, signal: AbortSignal, lookup: Lookup, override?: number): Promise<Balance>;
    reserve(backend: "tavily" | "firecrawl", key: string, maxResults: number, override?: number): Reservation | undefined;
    private schedulePersistence;
    private startWriter;
    flush(signal?: AbortSignal): Promise<PersistenceResult>;
    dispose(): void;
    get warning(): string | undefined;
}
export {};
