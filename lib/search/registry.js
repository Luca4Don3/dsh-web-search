export const PROVIDER_IDS = ["exa", "parallel", "tavily", "firecrawl", "serpapi", "tinyfish"];
/**
 * 匿名候选顺序。TinyFish 只有 keyless 匿名通道，且服务端强制每日限额较小、
 * 可能为共享额度池，因此排在最后作为补充，不作为主力通道。
 */
export const ANONYMOUS_PROVIDER_ORDER = ["exa", "tavily", "parallel", "firecrawl", "tinyfish"];
export const BILLABLE_PROVIDER_ORDER = ["exa", "tavily", "parallel", "firecrawl", "serpapi"];
export const PROVIDERS = {
    exa: { id: "exa", label: "Exa", protocol: "mcp", envVar: "EXA_API_KEY", supportedTiers: ["anonymous", "billable"] },
    parallel: { id: "parallel", label: "Parallel", protocol: "mcp", envVar: "PARALLEL_API_KEY", supportedTiers: ["anonymous", "billable"] },
    tavily: { id: "tavily", label: "Tavily", protocol: "rest", envVar: "TAVILY_API_KEY", supportedTiers: ["anonymous", "billable"] },
    firecrawl: { id: "firecrawl", label: "Firecrawl", protocol: "rest", envVar: "FIRECRAWL_API_KEY", supportedTiers: ["anonymous", "billable"] },
    serpapi: { id: "serpapi", label: "SerpApi", protocol: "rest", envVar: "SERPAPI_API_KEY", supportedTiers: ["billable"] },
    // keyless 匿名通道不读取任何密钥；envVar 仅用于说明与后续可能的认证通道，当前不参与凭据解析。
    tinyfish: { id: "tinyfish", label: "TinyFish", protocol: "mcp", envVar: "TINYFISH_API_KEY", supportedTiers: ["anonymous"] },
};
/** 判断输入是否为目录中登记的 provider。 */
export function isProviderId(value) {
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}
/** 查询 provider 元数据；无效输入只给出固定诊断，不回显输入值。 */
export function getProviderMetadata(provider) {
    if (!isProviderId(provider))
        throw new Error("未知的搜索 provider");
    return PROVIDERS[provider];
}
/** 查表判断 provider 是否支持匿名通道。 */
export function hasAnonymousChannel(provider) {
    return getProviderMetadata(provider).supportedTiers.includes("anonymous");
}
/** 查表判断 provider 是否支持可能计费的密钥通道；仅这些后端才解析凭据。 */
export function supportsKeyChannel(provider) {
    return getProviderMetadata(provider).supportedTiers.includes("billable");
}
