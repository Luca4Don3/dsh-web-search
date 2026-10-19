/** SerpApi REST 请求与 Google organic_results 响应适配。 */
import { type WebSource } from "../core.js";
import { type ApiChannel, type RequestSpec } from "../protocol.js";
export declare function buildSerpApiRequest(query: string, maxResults: number, key: string | undefined, channel: ApiChannel): RequestSpec;
export declare function parseSerpApiResponse(body: string, maxResults: number): WebSource[];
