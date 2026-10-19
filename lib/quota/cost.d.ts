/** 只估算本轮证实的 web search 费用；不对未来 fetch 或其他后端猜价。 */
import type { QuotaBackend } from "./state-store.js";
export type QuotaOperation = "search" | "fetch";
/** search：Tavily basic 固定 1；Firecrawl sources:web 每开始 10 条 2 积分。 */
export declare function estimateSearchCost(backend: QuotaBackend, maxResults: number, operation?: QuotaOperation): number | undefined;
