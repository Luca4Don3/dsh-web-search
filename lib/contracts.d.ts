/** 核心与宿主通过结构化接口协作，不依赖 Pi 或 DSH 的模型工具。 */
export declare const PROVIDERS: readonly ["exa", "tavily", "parallel", "firecrawl", "tinyfish"];
export type ProviderId = (typeof PROVIDERS)[number];
export type KeyProviderId = Exclude<ProviderId, "tinyfish">;
export interface SearchRequest {
    readonly query: string;
    readonly maxResults?: number;
}
export interface SearchSource {
    readonly url: string;
    readonly title?: string;
    readonly snippet?: string;
    readonly publishedAt?: string;
}
export interface SearchResult {
    readonly content?: string;
    readonly sources: readonly SearchSource[];
    readonly truncated: boolean;
    readonly backend: ProviderId;
    readonly accessTier: "anonymous" | "billable";
}
/** 只允许非秘密配置；计费授权来自宿主可信配置，而非搜索请求。 */
export interface SearchOptions {
    readonly allowBillable?: boolean;
    readonly timeoutMs?: number;
    readonly maxResponseBytes?: number;
    readonly maxChars?: number;
    readonly retries?: number;
    readonly cooldownOverrideMs?: number;
    readonly stateDirectory?: string;
}
/** 注入点用于离线测试；生产取钥只在授权分支中执行。 */
export interface SearchDependencies {
    readonly fetch?: typeof globalThis.fetch;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly resolveKey?: (provider: KeyProviderId, signal: AbortSignal) => string | undefined | Promise<string | undefined>;
    readonly clock?: () => number;
}
export interface SearchEngine {
    search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult>;
    /** 停止接受新调用，撤销所有在途请求，收尾自身客户端与状态写入。 */
    dispose(): Promise<void>;
}
