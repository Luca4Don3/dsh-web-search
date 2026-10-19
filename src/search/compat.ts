/**
 * DSH 0.1.x 协议层的兼容导出。
 *
 * 旧版 `parseProviderResponse(provider, body, maxResults)` 返回
 * `{ sources, content?, truncated? }`；新内核把解析拆到了
 * {@link parseApiResponse} 与 {@link parseMcpBlocks}。这里用一层薄适配
 * 保持旧调用方可用，行为与内核保持一致。
 */
import { BackendError, errorDetailFrom, messageKind } from "./core.js";
import type { ProviderId } from "./contracts.js";
import type { SearchSource } from "./contracts.js";
import { parseApiResponse } from "./search-api.js";
import { parseMcpBlocks } from "./mcp-protocol.js";
import { extractSources } from "./engine.js";

export interface Parsed {
	sources: SearchSource[];
	content?: string;
	truncated?: boolean;
}

/** 按 provider 解析响应体；非法结构统一抛出带分类的错误。 */
export function parseProviderResponse(provider: ProviderId, body: string, maxResults: number): Parsed {
	if (provider === "tavily" || provider === "firecrawl" || provider === "serpapi") {
		// 显式出现错误字段（即使值为 null）都视为协议错误：不能把失败响应当成功结果。
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			throw new BackendError(`${provider} 返回了非法 JSON`, "protocol_error");
		}
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			const record = parsed as Record<string, unknown>;
			if (["error", "detail", "message"].some((field) => Object.hasOwn(record, field))) {
				const detail = errorDetailFrom(record);
				throw new BackendError(detail ?? `${provider} 响应包含错误字段`, detail === undefined ? "protocol_error" : messageKind(detail) ?? "protocol_error");
			}
		}
		const sources = parseApiResponse(provider, body, maxResults);
		return { sources, truncated: false };
	}
	const blocks = parseMcpBlocks(body);
	if (blocks === undefined) throw new BackendError(`${provider} 未返回可用结果`, "protocol_error");
	const text = blocks.join("\n\n");
	if (provider === "exa" && /^\s*You['’‘]ve\s+hit\s+Exa['’‘]s\s+free\s+MCP\s+rate\s+limit\b/iu.test(text)) {
		throw new BackendError("[quota_exhausted] Exa free MCP rate limit", "quota_exhausted");
	}
	const sources = blocks.flatMap((block) => extractSources(block, maxResults)).slice(0, maxResults);
	if (sources.length === 0) throw new BackendError(`${provider} 未返回可用的搜索来源`, "protocol_error");
	return { sources, content: text, truncated: false };
}

export { messageKind };
