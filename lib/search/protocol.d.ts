/** 原生 REST 服务提供方的共用协议；只负责离线解析，不执行网络请求。 */
import { type WebSource } from "./core.js";
export interface RequestSpec {
    url: string;
    method: "POST" | "GET";
    headers: Record<string, string>;
    body?: string;
}
export type ApiChannel = "free" | "key";
/** 检查通道凭据组合，不在错误文本中包含凭据。 */
export declare function requireKey(backend: string, key: string | undefined, channel: ApiChannel): string;
/** 为可免费使用的服务验证通道，确保密钥不会误入免费请求。 */
export declare function validateOptionalKey(backend: string, key: string | undefined, channel: ApiChannel): string | undefined;
/** 解码响应对象，统一拒绝 JSON 错误、错误字段与失败标记。 */
export declare function parseResponseObject(backend: string, body: string): Record<string, unknown>;
export interface SourceFields {
    url: unknown;
    title?: unknown;
    snippet?: unknown;
    publishedAt?: unknown;
}
/** 将服务字段映射为仅含公开字段的来源；摘要保留原始完整长度。 */
export declare function normalizeSource(fields: SourceFields): WebSource | undefined;
/** 校验结果数组、清理链接并按 URL 去重和限制数量。 */
export declare function collectSources(backend: string, items: unknown[], maxResults: number, mapItem: (item: unknown) => WebSource | undefined): WebSource[];
/** 兼容 DSH 0.1.x 的按 provider 解析入口。 */
export { parseProviderResponse } from "./compat.js";
export type { Parsed } from "./compat.js";
