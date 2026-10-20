/**
 * 搜索内核与宿主之间的结构化契约。
 *
 * 这里刻意不依赖 DSH 的 `WebSearchRequest`，也不依赖 Pi 的 TypeBox 参数，
 * 让同一份内核可以在两个宿主中复用，并保持离线可测。
 */

export const PROVIDERS = ["exa", "tavily", "parallel", "firecrawl", "serpapi", "tinyfish"] as const;
export type ProviderId = (typeof PROVIDERS)[number];
/** TinyFish 只有 keyless 匿名通道，永远不会解析凭据。 */
export type KeyProviderId = Exclude<ProviderId, "tinyfish">;

export interface SearchRequest {
  readonly query: string;
  readonly maxResults?: number;
  /** 显式指定后端时只尝试它；缺省表示按路由顺序尝试全部候选。 */
  readonly provider?: ProviderId | "auto";
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

/** 只允许非秘密配置；计费授权来自宿主可信配置，而不是搜索请求。 */
export interface SearchOptions {
  readonly allowBillable?: boolean;

  readonly timeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxChars?: number;
  readonly retries?: number;
  readonly cooldownOverrideMs?: number;
  readonly stateDirectory?: string;
}

/** 注入点只用于离线测试与宿主适配；生产取钥只在授权分支中执行。 */
export interface SearchDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly resolveKey?: (provider: KeyProviderId, signal: AbortSignal) => string | undefined | Promise<string | undefined>;
  /** 授权后需要解析的计费后端；缺省为内核登记的全部计费后端。 */
  readonly keyProviders?: readonly KeyProviderId[];
  /** 是否允许密钥包含空格等空白可打印字符（Pi 兼容旧行为）。 */
  readonly allowWhitespaceKeys?: boolean;
  /** 是否把底层异常文本（脱敏后）带进失败诊断；默认不带。 */
  readonly includeErrorDetail?: boolean;
  readonly clock?: () => number;
}

export interface SearchEngine {
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult>;
  /** 停止接受新调用，撤销所有在途请求，收尾自身客户端与状态写入。 */
  dispose(): Promise<void>;
}
