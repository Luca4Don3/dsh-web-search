/** SerpApi REST 请求与 Google organic_results 响应适配。 */
import { BackendError } from "../core.js";
import { collectSources, normalizeSource, parseResponseObject, requireKey, } from "../protocol.js";
export function buildSerpApiRequest(query, maxResults, key, channel) {
    const apiKey = requireKey("serpapi", key, channel);
    const params = new URLSearchParams({ engine: "google", q: query, api_key: apiKey, num: String(maxResults) });
    return {
        url: `https://serpapi.com/search.json?${params.toString()}`,
        method: "GET",
        headers: { accept: "application/json" },
    };
}
export function parseSerpApiResponse(body, maxResults) {
    const record = parseResponseObject("serpapi", body);
    const metadata = record.search_metadata;
    if (metadata !== null &&
        typeof metadata === "object" &&
        metadata.status === "Error") {
        throw new BackendError("serpapi 搜索状态为 Error", "protocol_error");
    }
    if (!Array.isArray(record.organic_results)) {
        throw new BackendError("serpapi 响应缺少结果数组", "protocol_error");
    }
    return collectSources("serpapi", record.organic_results, maxResults, (item) => {
        if (item === null || typeof item !== "object" || Array.isArray(item))
            return undefined;
        const result = item;
        return normalizeSource({
            url: result.link,
            title: result.title,
            snippet: result.snippet,
            publishedAt: result.date,
        });
    });
}
