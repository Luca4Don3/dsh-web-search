/** Tavily REST 请求与响应适配。 */
import { BackendError } from "../core.js";
import { collectSources, normalizeSource, parseResponseObject, validateOptionalKey, } from "../protocol.js";
export function buildTavilyRequest(query, maxResults, key, channel) {
    const apiKey = validateOptionalKey("tavily", key, channel);
    const headers = {
        accept: "application/json",
        "content-type": "application/json",
    };
    if (channel === "free")
        headers["X-Tavily-Access-Mode"] = "keyless";
    else
        headers.authorization = `Bearer ${apiKey}`;
    return {
        url: "https://api.tavily.com/search",
        method: "POST",
        headers,
        body: JSON.stringify({
            query,
            search_depth: "basic",
            auto_parameters: false,
            include_answer: false,
            include_raw_content: false,
            max_results: maxResults,
        }),
    };
}
export function parseTavilyResponse(body, maxResults) {
    const record = parseResponseObject("tavily", body);
    if (!Array.isArray(record.results)) {
        throw new BackendError("tavily 响应缺少结果数组", "protocol_error");
    }
    return collectSources("tavily", record.results, maxResults, (item) => {
        if (item === null || typeof item !== "object" || Array.isArray(item))
            return undefined;
        const result = item;
        return normalizeSource({
            url: result.url,
            title: result.title,
            snippet: result.content,
            publishedAt: result.published_date,
        });
    });
}
