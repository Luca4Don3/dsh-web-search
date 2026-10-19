/** 原生 REST 服务提供方的薄兼容分发层；不执行网络请求。 */
import { type SearchErrorKind, type WebSource } from "./core.js";
import type { ApiChannel, RequestSpec } from "./protocol.js";
export type ApiBackend = "tavily" | "firecrawl" | "serpapi";
export type { RequestSpec } from "./protocol.js";
export declare function isApiBackend(backend: string): backend is ApiBackend;
/** 兼容统一入口的 REST 请求构造；免费通道与密钥通道严格隔离。 */
export declare function buildApiRequest(backend: ApiBackend, query: string, numResults: number, key?: string, channel?: ApiChannel): RequestSpec;
/** 保留统一入口使用的原生响应解析接口。 */
export declare function parseApiResponse(backend: ApiBackend, body: string, maxResults: number): WebSource[];
/** 按服务提供方规则分类 HTTP 错误，其余情况沿用通用分类。 */
export declare function apiHttpKind(backend: string, status: number, detail: string): SearchErrorKind;
