/** Firecrawl REST 请求与响应适配。 */
import { type WebSource } from "../core.js";
import { type ApiChannel, type RequestSpec } from "../protocol.js";
export declare function buildFirecrawlRequest(query: string, maxResults: number, key: string | undefined, channel: ApiChannel): RequestSpec;
export declare function parseFirecrawlResponse(body: string, maxResults: number): WebSource[];
