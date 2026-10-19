/** 搜索 provider 的纯元数据目录；不依赖认证、凭据或运行时状态。 */
import type { ProviderId } from "./contracts.js";
export declare const PROVIDER_IDS: readonly ["exa", "parallel", "tavily", "firecrawl", "serpapi", "tinyfish"];
export type AccessTier = "anonymous" | "free-key" | "billable";
/**
 * 匿名候选顺序。TinyFish 只有 keyless 匿名通道，且服务端强制每日限额较小、
 * 可能为共享额度池，因此排在最后作为补充，不作为主力通道。
 */
export declare const ANONYMOUS_PROVIDER_ORDER: readonly ["exa", "tavily", "parallel", "firecrawl", "tinyfish"];
export declare const BILLABLE_PROVIDER_ORDER: readonly ["exa", "tavily", "parallel", "firecrawl", "serpapi"];
export declare const PROVIDERS: Readonly<Record<ProviderId, {
    readonly id: ProviderId;
    readonly label: string;
    readonly protocol: "mcp" | "rest";
    readonly envVar: string;
    readonly supportedTiers: readonly AccessTier[];
}>>;
/** 判断输入是否为目录中登记的 provider。 */
export declare function isProviderId(value: unknown): value is ProviderId;
/** 查询 provider 元数据；无效输入只给出固定诊断，不回显输入值。 */
export declare function getProviderMetadata(provider: unknown): (typeof PROVIDERS)[ProviderId];
/** 查表判断 provider 是否支持匿名通道。 */
export declare function hasAnonymousChannel(provider: unknown): boolean;
/** 查表判断 provider 是否支持可能计费的密钥通道；仅这些后端才解析凭据。 */
export declare function supportsKeyChannel(provider: unknown): boolean;
