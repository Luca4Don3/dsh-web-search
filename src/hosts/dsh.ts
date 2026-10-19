/**
 * DSH 宿主适配层：把搜索与抓取内核注册为 `ctx.web` 的两个提供方。
 *
 * - 搜索提供方 id 固定为 `free-first`，保持既有安装与补丁配置不变。
 * - 抓取提供方 id 为 `local-first`：官方插件已占用 `http`，复用同一 id 会触发
 *   `WEB_DUPLICATE_PROVIDER`，因此这里使用独立 id，由补丁显式选择。
 * - 不创建模型工具、不替换官方网页抓取；两个提供方都可以单独关闭。
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import {
	WebError,
	type WebFetchProvider,
	type WebFetchRequest,
	type WebFetchResult,
	type WebSearchProvider,
	type WebSearchRequest,
	type WebSearchResult,
} from "@deepseek-ai/dsh-web";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createSearchEngine, clampResults, renderOutcome, type SearchOutcomeResult } from "../search/engine.js";
import type { SearchEngine } from "../search/contracts.js";
import { fetchPage, FetchError } from "../fetch/index.js";
import { DEFAULT_TIMEOUT_MS as DEFAULT_FETCH_TIMEOUT_MS, readWebFetchConfig } from "../fetch/config.js";

export const name = "web-search";
export const inject = ["web"];
export const PROVIDER_ID = "free-first";
export const FETCH_PROVIDER_ID = "local-first";

/** 没有秘密值、凭据源或可由模型覆盖的费用开关。 */
export const Config = z.object({
	allowBillable: z.boolean().default(false),
	timeoutMs: z.number().step(1).min(1).max(60_000).default(25_000),
	totalTimeoutMs: z.number().step(1).min(1_000).max(600_000).default(90_000),
	maxResponseBytes: z.number().step(1).min(1).max(20 * 1024 * 1024).default(5 * 1024 * 1024),
	maxChars: z.number().step(1).min(1).max(200_000).default(24_000),
	retries: z.number().step(1).min(0).max(3).default(1),
	cooldownOverrideMs: z.number().step(1).min(0).max(86_400_000),
	stateDirectory: z.string(),
	/** 抓取侧的整次预算，与搜索预算相互独立。 */
	fetchTimeoutMs: z.number().step(1).min(1).max(60_000).default(20_000),
	fetchMaxResponseBytes: z.number().step(1).min(1).max(20 * 1024 * 1024).default(5 * 1024 * 1024),
	fetchMaxChars: z.number().step(1).min(1).max(200_000).default(24_000),
	fetchMaxRedirects: z.number().step(1).min(1).max(5).default(3),
});

export interface DshConfig {
  allowBillable?: boolean;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  maxResponseBytes?: number;
  maxChars?: number;
  retries?: number;
  cooldownOverrideMs?: number;
  stateDirectory?: string;
  fetchTimeoutMs?: number;
  fetchMaxResponseBytes?: number;
  fetchMaxChars?: number;
  fetchMaxRedirects?: number;
}

/** 遵循官方 DSH_HOME 的路径规则，但不读取任何宿主配置或凭据文件。 */
export function defaultStateDirectory(env: Readonly<Record<string, string | undefined>> = process.env): string {
	const selected = env.DSH_HOME?.trim();
	const base = selected === undefined || selected.length === 0 ? join(homedir(), ".dsh") : selected;
	const expanded = base === "~" ? homedir() : base.startsWith("~/") || base.startsWith("~\\") ? join(homedir(), base.slice(2)) : base;
	return join(resolve(expanded), "config", "web-search");
}

/** 搜索提供方：把内核结果收敛为 DSH 的 `WebSearchResult`。 */
export class FreeFirstProvider implements WebSearchProvider {
	readonly id = PROVIDER_ID;
	private disposed = false;

	constructor(private readonly engine: SearchEngine, private readonly maxChars: number) {}

	available(): boolean {
		return !this.disposed;
	}

	async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
		if (this.disposed) throw new WebError("搜索提供方已关闭", "WEB_PROVIDER_UNAVAILABLE");
		try {
			const result = await this.engine.search({ query: request.query, ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }) }, signal);
			return {
				...(result.content === undefined ? {} : { content: result.content }),
				sources: result.sources,
				truncated: result.truncated,
			};
		} catch (error) {
			// 不把底层异常或因果链带到宿主的会话与诊断中。
			throw new WebError(safeMessage(error), safeCode(error), { cause: undefined });
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.engine.dispose();
	}
}

/** 抓取提供方：非 2xx 是结果而不是异常，符合 DSH 对抓取层的约定。 */
export class LocalFirstFetchProvider implements WebFetchProvider {
	readonly id = FETCH_PROVIDER_ID;
	private disposed = false;

	constructor(private readonly config: ReturnType<typeof readWebFetchConfig>) {}

	available(): boolean {
		return !this.disposed;
	}

	async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
		if (this.disposed) throw new WebError("抓取提供方已关闭", "WEB_PROVIDER_UNAVAILABLE");
		try {
			const outcome = await fetchPage({ url: request.url }, this.config, {}, signal);
			return {
				url: outcome.finalUrl,
				statusCode: outcome.statusCode,
				body: { kind: "text", content: outcome.markdown },
				truncated: outcome.truncated,
			};
		} catch (error) {
			// DSH 要求：成功取回的非 2xx 响应是结果；只有无法安全取回才是 WebError。
			if (error instanceof FetchError && error.options?.statusCode !== undefined) {
				return { url: request.url, statusCode: error.options.statusCode, body: { kind: "text", content: "" }, truncated: false };
			}
			throw new WebError(fetchMessage(error), fetchCode(error));
		}
	}

	dispose(): void {
		this.disposed = true;
	}
}

const SEARCH_CODES = new Set([
	"invalid_config", "invalid_request", "response_too_large", "timeout", "aborted",
	"quota_preflight", "invalid_key", "rate_limited", "network_error", "protocol_error", "budget_exhausted",
]);

function safeCode(error: unknown): string {
	// 内核的稳定错误码优先：DISPOSED / TIMEOUT / ABORTED 等必须原样透出，
	// 否则宿主无法区分"已卸载"和"搜索失败"。
	const stable = (error as { code?: unknown } | null)?.code;
	if (stable === "DISPOSED" || stable === "TIMEOUT" || stable === "ABORTED" || stable === "INVALID_REQUEST" || stable === "INVALID_CONFIG" || stable === "INVALID_KEY") {
		return stable;
	}
	const kind = (error as { kind?: unknown } | null)?.kind;
	return typeof kind === "string" && SEARCH_CODES.has(kind) ? `WEB_SEARCH_${kind.toUpperCase()}` : "WEB_SEARCH_FAILED";
}

function safeMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	return message.length === 0 ? "搜索失败" : message.slice(0, 500);
}

function fetchCode(error: unknown): string {
	return error instanceof FetchError ? `WEB_FETCH_${error.kind.toUpperCase()}` : "WEB_FETCH_FAILED";
}

function fetchMessage(error: unknown): string {
	return error instanceof FetchError ? error.message : "抓取失败";
}

/** 测试用依赖注入不进入宿主配置，不调用真实凭据服务。 */
export function createPlugin(dependencies: { fetch?: typeof globalThis.fetch; env?: Readonly<Record<string, string | undefined>>; resolveKey?: Parameters<typeof createSearchEngine>[1] extends infer D ? (D extends { resolveKey?: infer R } ? R : never) : never; clock?: () => number } = {}) {
	return {
		name,
		inject,
		Config,
		apply(ctx: Context, config: DshConfig = {}): void {
			const stateDirectory = config.stateDirectory ?? defaultStateDirectory(dependencies.env);
			if (typeof stateDirectory !== "string" || stateDirectory.length === 0 || !isAbsolute(stateDirectory)) {
				throw new WebError("冷却状态目录必须为绝对路径", "WEB_SEARCH_INVALID_CONFIG");
			}
			let engine: SearchEngine;
			try {
				engine = createSearchEngine({
					allowBillable: config.allowBillable ?? false,
					...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
					...(config.totalTimeoutMs === undefined ? {} : { totalTimeoutMs: config.totalTimeoutMs }),
					...(config.maxResponseBytes === undefined ? {} : { maxResponseBytes: config.maxResponseBytes }),
					...(config.maxChars === undefined ? {} : { maxChars: config.maxChars }),
					...(config.retries === undefined ? {} : { retries: config.retries }),
					...(config.cooldownOverrideMs === undefined ? {} : { cooldownOverrideMs: config.cooldownOverrideMs }),
					stateDirectory,
				}, {
					...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
					...(dependencies.env === undefined ? {} : { env: dependencies.env }),
					...(dependencies.resolveKey === undefined ? {} : { resolveKey: dependencies.resolveKey as never }),
					...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
				});
			} catch {
				throw new WebError("插件配置无效", "WEB_SEARCH_INVALID_CONFIG");
			}
			const provider = new FreeFirstProvider(engine, config.maxChars ?? 24_000);
			const fetchConfig = readWebFetchConfig({
				PI_WEB_FETCH_TIMEOUT_MS: String(config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS),
				PI_WEB_FETCH_MAX_RESPONSE_BYTES: String(config.fetchMaxResponseBytes ?? 5 * 1024 * 1024),
				PI_WEB_FETCH_MAX_CHARS: String(config.fetchMaxChars ?? 24_000),
				PI_WEB_FETCH_MAX_REDIRECTS: String(config.fetchMaxRedirects ?? 3),
			});
			const fetcher = new LocalFirstFetchProvider(fetchConfig);
			let unregisterSearch: () => void;
			let unregisterFetch: () => void;
			try {
				unregisterSearch = ctx.web.registerSearchProvider(provider);
				unregisterFetch = ctx.web.registerFetchProvider(fetcher);
			} catch (error) {
				void provider.dispose().catch(() => undefined);
				fetcher.dispose();
				throw error;
			}
			ctx.effect(() => async () => {
				unregisterSearch();
				unregisterFetch();
				await provider.dispose();
				fetcher.dispose();
			}, "web-search.lifecycle");
		},
	};
}

/** 默认导出遵循官方宿主插件的命名导出约定。 */
export function apply(ctx: Context, config: DshConfig = {}): void {
	createPlugin().apply(ctx, config);
}

export type { SearchOutcomeResult };
export { clampResults, renderOutcome };
