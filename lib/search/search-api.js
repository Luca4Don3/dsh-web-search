/** 原生 REST 服务提供方的薄兼容分发层；不执行网络请求。 */
import { httpKind } from "./core.js";
import { parseFirecrawlResponse, buildFirecrawlRequest } from "./providers/firecrawl.js";
import { parseSerpApiResponse, buildSerpApiRequest } from "./providers/serpapi.js";
import { parseTavilyResponse, buildTavilyRequest } from "./providers/tavily.js";
/** 单一服务提供方表同时驱动识别、请求构造、解析与 HTTP 错误分类。 */
const API_PROVIDERS = {
    tavily: {
        build: buildTavilyRequest,
        parse: parseTavilyResponse,
        httpKind: (status, detail) => (status === 432 || status === 433 ? "quota_exhausted" : httpKind(status, detail)),
    },
    firecrawl: {
        build: buildFirecrawlRequest,
        parse: parseFirecrawlResponse,
        httpKind: (status, detail) => status === 402 ? "quota_exhausted" : status === 429 ? "rate_limited" : httpKind(status, detail),
    },
    serpapi: {
        build: buildSerpApiRequest,
        parse: parseSerpApiResponse,
        httpKind,
    },
};
export function isApiBackend(backend) {
    return Object.prototype.hasOwnProperty.call(API_PROVIDERS, backend);
}
/** 兼容统一入口的 REST 请求构造；免费通道与密钥通道严格隔离。 */
export function buildApiRequest(backend, query, numResults, key, channel = "key") {
    return API_PROVIDERS[backend].build(query, numResults, key, channel);
}
/** 保留统一入口使用的原生响应解析接口。 */
export function parseApiResponse(backend, body, maxResults) {
    return API_PROVIDERS[backend].parse(body, maxResults);
}
/** 按服务提供方规则分类 HTTP 错误，其余情况沿用通用分类。 */
export function apiHttpKind(backend, status, detail) {
    return isApiBackend(backend) ? API_PROVIDERS[backend].httpKind(status, detail) : httpKind(status, detail);
}
