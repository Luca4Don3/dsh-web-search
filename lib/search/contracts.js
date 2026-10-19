/**
 * 搜索内核与宿主之间的结构化契约。
 *
 * 这里刻意不依赖 DSH 的 `WebSearchRequest`，也不依赖 Pi 的 TypeBox 参数，
 * 让同一份内核可以在两个宿主中复用，并保持离线可测。
 */
export const PROVIDERS = ["exa", "tavily", "parallel", "firecrawl", "serpapi", "tinyfish"];
