/** 五个固定服务的纯请求构造、协议解析与来源校验。 */
import type { ProviderId, SearchSource } from "../contracts.js";
import { CoreFault } from "./body.js";

export interface RequestSpec { url: string; headers: Record<string, string>; body: string; }
export interface Parsed { sources: SearchSource[]; content?: string; truncated?: boolean; }
export type FailureKind = "rate" | "exhausted" | "server" | "network" | "too_large" | "protocol" | "invalid_key";
export class ProviderFault extends Error {
  constructor(readonly kind: FailureKind, readonly retryAfter?: number) { super(kind); this.name = "ProviderFault"; }
}
const EXA_URL = "https://mcp.exa.ai/mcp";
const PARALLEL_URL = "https://search.parallel.ai/mcp";
const TINYFISH_URL = "https://agent.tinyfish.ai/mcp";
const EXHAUSTION = /quota|credit|balance|insufficient|payment required|no remaining|(?:ran|run) out of searches|monthly.*limit|daily.*limit|额度|余额不足|积分不足/u;
const LIMIT = /rate limit|too many requests|too many requests|throttl/u;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/giu;

export function isHttpUrl(value: string): boolean {
  try { const url = new URL(value); return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password; }
  catch { return false; }
}
function cleanText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
function source(value: unknown): SearchSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.url !== "string") return undefined;
  const url = row.url.trim();
  if (!isHttpUrl(url)) return undefined;
  const title = cleanText(row.title);
  const snippet = cleanText(row.snippet ?? row.content ?? row.description);
  const publishedAt = cleanText(row.publishedAt ?? row.published_date ?? row.publish_date ?? row.date);
  return { url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}), ...(publishedAt ? { publishedAt } : {}) };
}
function collect(values: unknown, maxResults: number, map: (value: unknown) => SearchSource | undefined = source): SearchSource[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: SearchSource[] = [];
  for (const value of values) {
    const item = map(value);
    if (!item || seen.has(item.url)) continue;
    seen.add(item.url);
    result.push(item);
    if (result.length >= maxResults) break;
  }
  return result;
}

export function buildRequest(provider: ProviderId, query: string, maxResults: number, key?: string): RequestSpec {
  if (provider === "tavily" || provider === "firecrawl") {
    const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
    if (provider === "tavily" && !key) headers["X-Tavily-Access-Mode"] = "keyless";
    if (key) headers.authorization = `Bearer ${key}`;
    return provider === "tavily"
      ? { url: "https://api.tavily.com/search", headers, body: JSON.stringify({ query, search_depth: "basic", auto_parameters: false, include_answer: false, include_raw_content: false, max_results: maxResults }) }
      : { url: "https://api.firecrawl.dev/v2/search", headers, body: JSON.stringify({ query, limit: maxResults, sources: ["web"] }) };
  }
  const headers: Record<string, string> = { accept: "application/json, text/event-stream", "content-type": "application/json" };
  if (provider === "tinyfish") {
    headers["X-TinyFish-Access-Mode"] = "keyless";
    return { url: TINYFISH_URL, headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query } } }) };
  }
  const payload = provider === "exa"
    ? { name: "web_search_exa", arguments: { query, type: "auto", numResults: maxResults, livecrawl: "fallback", contextMaxCharacters: 10_000 } }
    : { name: "web_search", arguments: { objective: query, search_queries: [query] } };
  if (provider === "parallel" && key) headers.authorization = `Bearer ${key}`;
  return { url: provider === "exa" ? `${EXA_URL}${key ? `?exaApiKey=${encodeURIComponent(key)}` : ""}` : PARALLEL_URL,
    headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: payload }) };
}

function classifyMessage(message: string): FailureKind {
  if (EXHAUSTION.test(message.toLowerCase())) return "exhausted";
  if (LIMIT.test(message.toLowerCase())) return "rate";
  return "protocol";
}
function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new ProviderFault("protocol"); }
}
function mcpPayload(text: string): string | undefined {
  const value = parseJson(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, any>;
  if (row.error !== undefined) {
    const message = typeof row.error === "string" ? row.error : typeof row.error?.message === "string" ? row.error.message : "";
    throw new ProviderFault(classifyMessage(message));
  }
  const texts: string[] = Array.isArray(row.result?.content) ? row.result.content.filter((item: any) => item && (item.type === undefined || item.type === "text") && typeof item.text === "string" && item.text.length > 0).map((item: any) => item.text) : [];
  const resultText = texts.length > 0 ? texts.join("\n") : undefined;
  if (row.result?.isError === true) throw new ProviderFault(classifyMessage(resultText ?? ""));
  return resultText;
}
export function parseMcpResponse(body: string): string | undefined {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    try { const value = mcpPayload(trimmed); if (value !== undefined) return value; } catch (error) { if (error instanceof ProviderFault) throw error; }
  }
  let data: string[] = [];
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("data:")) { data.push(line.slice(5).trimStart()); continue; }
    if (!line.trim()) {
      if (data.length) {
        const event = data.join("\n"); data = [];
        if (event !== "[DONE]") {
          try { const value = mcpPayload(event); if (value !== undefined) return value; } catch (error) { if (error instanceof ProviderFault) throw error; }
        }
      }
    }
  }
  if (data.length) {
    const event = data.join("\n");
    if (event !== "[DONE]") { try { return mcpPayload(event); } catch (error) { if (error instanceof ProviderFault) throw error; } }
  }
  return undefined;
}

function exaSources(text: string, maxResults: number): SearchSource[] {
  const parsed: SearchSource[] = [];
  for (const block of text.split(/\r?\n(?:-{3,}|\*{3,})\r?\n/u)) {
    let title: string | undefined;
    let url: string | undefined;
    let snippet: string | undefined;
    let highlights = false;
    for (const raw of block.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("Title:")) title = line.slice(6).replace(/^\s*(?:\d+[.)]?|[-*•])\s*/u, "").replace(/^title:\s*/iu, "").trim();
      else if (line.startsWith("URL:")) url = line.slice(4).trim();
      else if (line.startsWith("Highlights:")) highlights = true;
      else if (highlights && !snippet && line && !/^\.{3,}$/u.test(line)) snippet = line.replace(/^(?:content|snippet|excerpt):\s*/iu, "").replace(/^###\s*/u, "").trim();
    }
    const item = url ? source({ url, title, snippet }) : undefined;
    if (item) parsed.push(item);
  }
  if (parsed.length) return unique(parsed, maxResults);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i]!.matchAll(URL_RE)) {
      const url = match[0]!.replace(/[.,;:!?)\]]+$/u, "");
      if (!isHttpUrl(url)) continue;
      const before = lines[i - 1]; const after = lines[i + 1];
      parsed.push({ url, ...(before && !/^(?:url|link|source):/iu.test(before) && !isHttpUrl(before) ? { title: before } : {}),
        ...(after && !/^(?:url|link|source):/iu.test(after) && !isHttpUrl(after) ? { snippet: after } : {}) });
    }
  }
  return unique(parsed, maxResults);
}
function unique(values: SearchSource[], maxResults: number): SearchSource[] {
  const seen = new Set<string>(); return values.filter((item) => { if (seen.has(item.url)) return false; seen.add(item.url); return true; }).slice(0, maxResults);
}
function parallelJson(text: string, maxResults: number): SearchSource[] | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!value || typeof value !== "object" || !Array.isArray((value as any).results)) return undefined;
  parseProviderError(value as Record<string, any>);
  return collect((value as any).results, maxResults, (item) => {
    if (!item || typeof item !== "object") return undefined;
    const row = item as Record<string, any>;
    const excerpts = Array.isArray(row.excerpts) ? row.excerpts.find((entry: unknown) => typeof entry === "string" && entry.trim()) : undefined;
    return source({ ...row, snippet: excerpts });
  });
}
function parseProviderError(row: Record<string, any>): never | void {
  const detail = [row.error, row.detail, row.message].map((value) => typeof value === "string" ? value : value?.message ?? value?.error).find((value) => typeof value === "string" && value.length);
  if (detail) throw new ProviderFault(classifyMessage(detail));
  if (row.success === false || ["error", "detail", "message"].some((key) => Object.hasOwn(row, key))) throw new ProviderFault("protocol");
}
export function parseProviderResponse(provider: ProviderId, body: string, maxResults: number): Parsed {
  if (provider === "exa" || provider === "parallel" || provider === "tinyfish") {
    const text = parseMcpResponse(body);
    if (text === undefined) throw new ProviderFault("protocol");
    if (provider === "exa" && /^\s*You['’‘]ve\s+hit\s+Exa['’‘]s\s+free\s+MCP\s+rate\s+limit\b(?:[\s.!?…:;,—–-]|$)/iu.test(text)) throw new ProviderFault("exhausted");
    let sources: SearchSource[] = [];
    let truncated = false;
    if (provider === "tinyfish") {
      let envelope: unknown;
      try { envelope = JSON.parse(text); } catch { envelope = undefined; }
      if (envelope && typeof envelope === "object" && !Array.isArray(envelope)) {
        const row = envelope as Record<string, any>; parseProviderError(row);
        sources = collect(row.results, maxResults + 1, source);
        truncated = sources.length > maxResults;
        sources = sources.slice(0, maxResults);
      }
    } else if (provider === "parallel") {
      const jsonSources = parallelJson(text, maxResults + 1);
      const candidates = jsonSources ?? exaSources(text, maxResults + 1);
      truncated = candidates.length > maxResults;
      sources = candidates.slice(0, maxResults);
    } else {
      sources = exaSources(text, maxResults);
      truncated = exaSources(text, maxResults + 1).length > maxResults;
    }
    if (!sources.length) throw new ProviderFault("protocol");
    return { sources, content: text, truncated };
  }
  const value = parseJson(body);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderFault("protocol");
  const row = value as Record<string, any>; parseProviderError(row);
  const rawSources = provider === "tavily" ? row.results : row.data?.web;
  const sources = provider === "tavily" ? collect(rawSources, maxResults + 1, (item) => {
    if (!item || typeof item !== "object") return undefined;
    const row = item as Record<string, any>;
    return source({ ...row, snippet: row.content, publishedAt: row.published_date });
  }) : collect(rawSources, maxResults + 1, (item) => {
    if (!item || typeof item !== "object") return undefined;
    const row = item as Record<string, any>;
    return source({ ...row, snippet: row.description, publishedAt: row.publish_date ?? row.publishedAt });
  });
  if (!sources.length) throw new ProviderFault("protocol");
  return { sources: sources.slice(0, maxResults), truncated: sources.length > maxResults };
}

export function classifyHttp(status: number, detail: string): FailureKind {
  if (detail && EXHAUSTION.test(detail.toLowerCase())) return "exhausted";
  if (status === 429) return "rate";
  if (status === 402) return "exhausted";
  if (status === 401 || status === 403) return "invalid_key";
  if (status >= 500) return "server";
  return "protocol";
}
export function errorDetail(body: string): string {
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const row = value as Record<string, any>;
      const detail = [row.error, row.detail, row.message].map((entry) => typeof entry === "string" ? entry : entry?.message ?? entry?.error).find((entry) => typeof entry === "string");
      return detail ?? "";
    }
  } catch { /* HTTP 错误可使用普通文本，但不会向外传播。 */ }
  return body.slice(0, 4096);
}

export function mapCoreFault(error: unknown): FailureKind {
  if (error instanceof ProviderFault) return error.kind;
  if (error instanceof CoreFault) return error.kind === "too_large" ? "too_large" : error.kind === "network" ? "network" : "protocol";
  return "network";
}
