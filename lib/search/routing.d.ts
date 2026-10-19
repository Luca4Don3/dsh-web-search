/** Web Search 路由配置与纯状态接口；不读取、不保存任何密钥。 */
import type { ProviderId } from "./contracts.js";
import type { QuotaSnapshot } from "../quota/contracts.js";
export type RoutingStrategy = "free-first" | "key-first";
export type SearchChannel = "free" | "key";
export type Provider = "auto" | ProviderId;
export interface RoutingConfig {
    strategy: RoutingStrategy;
    allowBillable: boolean;
    freeCooldownMs: number;
    /** 仅显式设置环境变量时存在；undefined 使用额度管理器的分原因退避阶梯。 */
    cooldownOverrideMs?: number;
}
export interface RoutingStep {
    backend: ProviderId;
    channel: SearchChannel;
}
/** 不含凭据内容的冷却通道状态。 */
export interface RoutingChannelStatus {
    backend: ProviderId;
    channel: SearchChannel;
    coolingDown: boolean;
    until: number;
    remainingMs: number;
    reason: string;
    nextProbeAt?: number;
}
/** 可供认证界面展示的路由状态，刻意不包含任何密钥字段。 */
export interface RoutingStatus {
    strategy: RoutingStrategy;
    allowBillable: boolean;
    freeCooldownMs: number;
    channels: RoutingChannelStatus[];
    quota?: {
        persistence: QuotaSnapshot["persistence"];
        persistenceReason?: string;
        cooldowns: RoutingChannelStatus[];
    };
}
/** 读取并校验路由环境变量；显式非法值不会静默回退。 */
export declare function readRoutingConfig(env?: Readonly<Record<string, string | undefined>>): RoutingConfig;
/** 构造无需读取凭据的候选顺序；所有匿名后端先尝试，再按独立付费顺序延迟解析 Key。 */
export declare function buildRouteCandidates(provider: Provider, config: RoutingConfig): RoutingStep[];
/** 按配置生成纯路由步骤；旧 `keys` 参数只作筛选，不读取或返回凭据。 */
export declare function buildRoutePlan(provider: Provider, keys: Readonly<Record<ProviderId, string | undefined>>, config: RoutingConfig): RoutingStep[];
/** 组装供状态界面使用的数据，不携带密钥配置或凭据内容。 */
export declare function getRoutingStatus(config?: RoutingConfig, channels?: readonly RoutingChannelStatus[], quotaSnapshot?: QuotaSnapshot): RoutingStatus;
