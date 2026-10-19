import { type QuotaOperation } from "./cost.js";
import type { QuotaCooldown, QuotaSnapshot } from "./contracts.js";
import { type QuotaBackend, type QuotaChannel, type QuotaFailureReason, type QuotaStateStore } from "./state-store.js";
import { type QuotaLookupInput, type QuotaLookupOptions, type QuotaLookupResult, type QuotaUnknownReason } from "./usage.js";
export type { QuotaBackend, QuotaChannel, QuotaFailureReason, QuotaSnapshot, QuotaStateStore };
export type { QuotaCooldown } from "./contracts.js";
export type { QuotaLookupInput, QuotaLookupOptions, QuotaLookupResult, QuotaUnknownReason };
export interface QuotaFailureOptions {
    credential?: string;
    cooldownMs?: number;
    retryAfterMs?: number;
}
export interface QuotaManagerOptions {
    clock?: () => number;
    lookup?: (input: QuotaLookupInput, options?: QuotaLookupOptions) => Promise<QuotaLookupResult>;
    stateStore?: QuotaStateStore;
    /** 查询接口从 fetch 到解压正文共用的总期限，默认 2000 毫秒。 */
    deadlineMs?: number;
    /** 传给既有 readResponseTextLimited 的解压后正文上限，默认 5 MiB。 */
    maxResponseBytes?: number;
    /** 未提供时用分原因阶梯；0 禁用所有冷却，但仍记录当前历史计数。 */
    cooldownMs?: number;
}
export interface QuotaScope {
    backend: QuotaBackend;
    channel: QuotaChannel;
    credential?: string;
}
export interface QuotaBalanceInput extends QuotaScope {
    allowBillable: boolean;
    signal?: AbortSignal;
    /** 每次执行实际配置的解压后响应体上限。 */
    maxResponseBytes?: number;
    /** 显式固定冷却覆盖；undefined 使用分原因退避阶梯，0 表示禁用冷却。 */
    cooldownOverrideMs?: number;
}
export type QuotaBalance = QuotaLookupResult & {
    cached?: boolean;
};
export interface QuotaReservationInput {
    backend: QuotaBackend;
    channel: "key";
    credential: string;
    allowBillable: boolean;
    operation: QuotaOperation;
    maxResults: number;
    /** 显式固定冷却覆盖；与 {@link QuotaBalanceInput} 使用同一约定。 */
    cooldownOverrideMs?: number;
}
export interface QuotaReservation {
    readonly id: string;
    readonly cost: number;
    /** 必须紧邻真实 dispatch 调用；从此刻起无论结果如何均先扣预估费用。 */
    dispatch(): boolean;
    /** 仅未 dispatch 时释放预留；dispatch 后不会退款。 */
    release(): boolean;
    /** 可选可信 actualCost 只校正估算，不把失败/超时当成退款依据。 */
    settle(actualCost?: number): boolean;
}
export type QuotaReserveResult = {
    status: "reserved";
    cost: number;
    availableBefore: number;
    reservation: QuotaReservation;
} | {
    status: "denied";
    reason: "authorization_required" | "unsupported_operation" | "unknown_balance" | "insufficient_credits";
    available?: number;
};
/** 创建实例隔离的额度管理器；默认状态仓库是内存，不读取任何用户配置目录。 */
export declare function createQuotaManager(options?: QuotaManagerOptions): {
    initialize: () => Promise<void>;
    restore: () => Promise<void>;
    getCooldown: (backend: QuotaBackend, channel: QuotaChannel, credentialOrCooldown?: string | number, cooldownMs?: number) => QuotaCooldown | undefined;
    recordFailure: (backend: QuotaBackend, channel: QuotaChannel, reason: QuotaFailureReason, failureOptions?: QuotaFailureOptions) => QuotaCooldown | undefined;
    recordSuccess: (backend: QuotaBackend, channel: QuotaChannel, credentialOrCooldown?: string | number, cooldownMs?: number) => void;
    lookupBalance: (input: QuotaBalanceInput) => Promise<QuotaBalance>;
    getBalance: (input: QuotaBalanceInput) => Promise<QuotaBalance>;
    reserve: (input: QuotaReservationInput) => QuotaReserveResult;
    flush: () => Promise<{
        status: "persisted" | "memory_only" | "degraded";
        reason?: string;
    }>;
    snapshot: () => QuotaSnapshot;
    readonly: {
        balanceCacheMs: number;
        failureCacheMs: number;
    };
};
