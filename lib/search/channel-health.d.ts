/** 按后端与认证通道隔离的进程内冷却状态。 */
import { type Backend } from "../auth/resolve.js";
import type { RoutingChannelStatus, SearchChannel } from "./routing.js";
export type ChannelHealthReason = "quota_exhausted" | "rate_limited";
export interface ChannelHealthOptions {
    /** 默认冷却毫秒数；允许 0 禁用，最大 24 小时。 */
    cooldownMs?: number;
    /** 单调测试时钟，返回毫秒时间戳。 */
    clock?: () => number;
}
export interface ChannelHealthFailureOptions {
    /** 本次配置的冷却时间；未提供时使用创建实例时的默认值。 */
    cooldownMs?: number;
    /** Retry-After 原始解析毫秒数，优先于默认冷却时长。 */
    retryAfterMs?: number;
}
export interface ChannelHealthSnapshot {
    cooldownMs: number;
    channels: RoutingChannelStatus[];
}
export interface ChannelHealth {
    readonly cooldownMs: number;
    getCooldown(backend: Backend, channel: SearchChannel): RoutingChannelStatus | undefined;
    recordFailure(backend: Backend, channel: SearchChannel, reason: ChannelHealthReason, options?: ChannelHealthFailureOptions): RoutingChannelStatus | undefined;
    recordSuccess(backend: Backend, channel: SearchChannel): void;
    snapshot(): ChannelHealthSnapshot;
}
/** 创建独立的内存状态；不同实例不会共享冷却记录。 */
export declare function createChannelHealth(options?: ChannelHealthOptions): ChannelHealth;
