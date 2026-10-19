/**
 * DSH 0.1.x 协议层的兼容导出。
 *
 * 旧版 `parseProviderResponse(provider, body, maxResults)` 返回
 * `{ sources, content?, truncated? }`；新内核把解析拆到了
 * {@link parseApiResponse} 与 {@link parseMcpBlocks}。这里用一层薄适配
 * 保持旧调用方可用，行为与内核保持一致。
 */
import { messageKind } from "./core.js";
import type { ProviderId } from "./contracts.js";
import type { SearchSource } from "./contracts.js";
export interface Parsed {
    sources: SearchSource[];
    content?: string;
    truncated?: boolean;
}
/** 按 provider 解析响应体；非法结构统一抛出带分类的错误。 */
export declare function parseProviderResponse(provider: ProviderId, body: string, maxResults: number): Parsed;
export { messageKind };
