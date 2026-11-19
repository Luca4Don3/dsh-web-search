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
import { fetchPage, FetchError, safeDisplayUrl, type FetchDependencies } from "../fetch/index.js";
import { DEFAULT_TIMEOUT_MS as DEFAULT_FETCH_TIMEOUT_MS, readWebFetchConfig } from "../fetch/config.js";
import { DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES } from "../shared/response-body.js";

export const name = "web-search";
export const inject = ["web"];
export const PROVIDER_ID = "free-first";
export const FETCH_PROVIDER_ID = "local-first";

/** 没有秘密值、凭据源或可由模型覆盖的费用开关。 */
export const Config = z.object({
	allowBillable: z.boolean().default(false),
	timeoutMs: z.number().step(1).min(1).max(60_000).default(25_000),
	totalTimeoutMs: z.number().step(1).min(1_000).max(600_000).default(90_000),
	maxResponseBytes: z.number().step(1).min(1).max(MAX_RESPONSE_BYTES).default(DEFAULT_MAX_RESPONSE_BYTES),
	maxChars: z.number().step(1).min(1).max(200_000).default(24_000),
	retries: z.number().step(1).min(0).max(3).default(1),
	cooldownOverrideMs: z.number().step(1).min(0).max(86_400_000),
	stateDirectory: z.string(),
	/** 抓取侧的整次预算，与搜索预算相互独立。 */
	fetchTimeoutMs: z.number().step(1).min(1).max(60_000).default(20_000),
	fetchMaxResponseBytes: z.number().step(1).min(1).max(MAX_RESPONSE_BYTES).default(DEFAULT_MAX_RESPONSE_BYTES),
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

/** 对外展示的地址：只保留 origin 与 pathname，不泄露查询串与片段。 */
function displayUrl(value: string): string {
	try {
		return safeDisplayUrl(new URL(value));
	} catch {
		return "";
	}
}

/** 抓取提供方：非 2xx 是结果而不是异常，符合 DSH 对抓取层的约定。 */
export class LocalFirstFetchProvider implements WebFetchProvider {
	readonly id = FETCH_PROVIDER_ID;
	private disposed = false;
	/** 在途抓取的取消控制器：卸载时必须一并撤销，否则旧请求仍会返回正文。 */
	private readonly active = new Set<AbortController>();

	constructor(
		private readonly config: ReturnType<typeof readWebFetchConfig>,
		/** 传输层依赖：生产用默认实现，测试可注入离线替身。 */
		private readonly dependencies: FetchDependencies = {},
	) {}

	available(): boolean {
		return !this.disposed;
	}

	async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
		if (this.disposed) throw new WebError("抓取提供方已关闭", "WEB_PROVIDER_UNAVAILABLE");
		const controller = new AbortController();
		this.active.add(controller);
		const forward = (): void => controller.abort();
		signal?.addEventListener("abort", forward, { once: true });
		if (signal?.aborted === true) controller.abort();
		try {
			const outcome = await fetchPage({ url: request.url }, this.config, this.dependencies, controller.signal);
			// 取消可能晚于响应到达：卸载后不得再把正文交出去。
			if (this.disposed) throw new WebError("抓取提供方已关闭", "WEB_PROVIDER_UNAVAILABLE");
			return {
				url: outcome.finalUrl,
				statusCode: outcome.statusCode,
				body: { kind: "text", content: outcome.markdown },
				truncated: outcome.truncated,
			};
		} catch (error) {
			if (this.disposed) throw new WebError("抓取提供方已关闭", "WEB_PROVIDER_UNAVAILABLE");
			// DSH 要求：成功取回的非 2xx 响应是结果；只有无法安全取回才是 WebError。
			if (error instanceof FetchError && error.options?.statusCode !== undefined) {
				// 错误状态同样要报告**最终**地址：重定向后报错时不能退回初始地址。
				// 地址必须在对外边界脱敏：完整 URL 可能带签名或 token 查询串，
				// 成功路径只用 origin+pathname，错误路径不能反而泄露更多。
				return {
					url: displayUrl(error.options.finalUrl ?? request.url),
					statusCode: error.options.statusCode,
					body: { kind: "text", content: "" },
					truncated: false,
				};
			}
			throw new WebError(fetchMessage(error), fetchCode(error));
		} finally {
			signal?.removeEventListener("abort", forward);
			this.active.delete(controller);
		}
	}

	dispose(): void {
		this.disposed = true;
		// 卸载即撤销全部在途请求。
		for (const controller of this.active) controller.abort();
		this.active.clear();
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

/**
 * 注册成功后核对宿主实际生效的提供方选择（DSH 0.2.2 起官方默认搜索改用自家
 * API；本插件依赖 bundle patch 显式选中自己的 id）。不一致只告警、不抛错：
 * 用户可能有意改选官方提供方，插件理应安静地让位，但「装了却没生效」必须可见。
 *
 * 读取失败（宿主没有暴露 config、Volatile 形状不同）时保持静默 —— 这是一条
 * 诊断，不是新的宿主契约要求。
 */
function warnIfNotSelected(ctx: { readonly logger?: { warn?: (message: string) => void } | undefined }, web: unknown): void {
	try {
		// 宿主的 config 在类型上是 private；这里只做运行时读取，不依赖公开类型。
		const holder = web as {
			readonly config?: { readonly searchProvider?: { get?: () => unknown }; readonly fetchProvider?: { get?: () => unknown } } | undefined;
		} | null | undefined;
		// logger 挂在 Cordis 的 ctx 上，不在 web 服务上（web 内部用的是 this.ctx.logger）。
		const logger = ctx.logger;
		if (typeof logger?.warn !== "function") return;
		const selectedSearch = typeof holder?.config?.searchProvider?.get === "function" ? holder.config.searchProvider.get() : undefined;
		const selectedFetch = typeof holder?.config?.fetchProvider?.get === "function" ? holder.config.fetchProvider.get() : undefined;
		// 环境变量是官方文档里的等价来源（不是隐藏优先级链），一并认。
		const envSearch = typeof process === "undefined" ? undefined : process.env.DSH_WEB_SEARCH_PROVIDER;
		const envFetch = typeof process === "undefined" ? undefined : process.env.DSH_WEB_FETCH_PROVIDER;
		const search = selectedSearch ?? envSearch;
		const fetch = selectedFetch ?? envFetch;
		if (search !== undefined && search !== PROVIDER_ID) {
			logger.warn(`dsh-web-search: 当前搜索提供方是「${String(search)}」，本插件的 ${PROVIDER_ID} 已注册但未被选中；如需启用请让 profile 补丁的 web.searchProvider 指向 ${PROVIDER_ID}`);
		}
		if (fetch !== undefined && fetch !== FETCH_PROVIDER_ID) {
			logger.warn(`dsh-web-search: 当前抓取提供方是「${String(fetch)}」，本插件的 ${FETCH_PROVIDER_ID} 已注册但未被选中；如需启用请让 profile 补丁的 web.fetchProvider 指向 ${FETCH_PROVIDER_ID}`);
		}
	} catch {
		// 诊断失败不影响插件本身。
	}
}

/** 测试用依赖注入不进入宿主配置，不调用真实凭据服务。 */
export function createPlugin(dependencies: { fetch?: typeof globalThis.fetch; env?: Readonly<Record<string, string | undefined>>; resolveKey?: Parameters<typeof createSearchEngine>[1] extends infer D ? (D extends { resolveKey?: infer R } ? R : never) : never; clock?: () => number } = {}) {
	return {
		name,
		inject,
		Config,
		apply(ctx: Context, config: DshConfig = {}): void {
			// 使用宿主提供的注册接口，不按单一版本号分支，也不自动安装或替换宿主依赖。
			const web = ctx.web;
			if (typeof web?.registerSearchProvider !== "function" || typeof web?.registerFetchProvider !== "function") {
				throw new WebError("当前宿主缺少网页搜索或抓取注册接口", "WEB_SEARCH_UNSUPPORTED_HOST");
			}
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
				PI_WEB_FETCH_MAX_RESPONSE_BYTES: String(config.fetchMaxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES),
				PI_WEB_FETCH_MAX_CHARS: String(config.fetchMaxChars ?? 24_000),
				PI_WEB_FETCH_MAX_REDIRECTS: String(config.fetchMaxRedirects ?? 3),
			});
			const fetcher = new LocalFirstFetchProvider(fetchConfig);
			let unregisterSearch: (() => void) | undefined;
			let unregisterFetch: (() => void) | undefined;
			try {
				unregisterSearch = web.registerSearchProvider(provider);
				unregisterFetch = web.registerFetchProvider(fetcher);
			} catch (error) {
				// 注册表不能留下「已注册但已 dispose」的死提供方：fetch 注册失败时
				// 先撤销已成功的 search 注册，再释放两个实例。
				try {
					unregisterSearch?.();
				} catch {
					// 撤销失败不掩盖原始错误。
				}
				void provider.dispose().catch(() => undefined);
				fetcher.dispose();
				throw error;
			}
			// DSH 0.2.2 起官方默认搜索切到自家 API（base bundle 的 web 行会给出
			// searchProvider / fetchProvider）。本插件靠 bundle patch 显式选中
			// free-first / local-first；一旦补丁没有真正生效（被删改、补丁层顺序
			// 变化、或被官方默认覆盖），提供方虽然注册成功却永远不会被选中 ——
			// 静默失效且没有任何报错。注册后读回宿主实际生效的选择，不一致就明确
			// 告警，把「看起来装了、其实没用」变成可见的诊断。
			warnIfNotSelected(ctx, web);
			ctx.effect(() => async () => {
				unregisterSearch?.();
				unregisterFetch?.();
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
