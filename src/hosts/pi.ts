/**
 * Pi 宿主适配层：注册 `web_search` 与 `/web-search-auth`。
 *
 * 执行逻辑全部委托给宿主无关内核 {@link createSearchEngine}；本层只保留
 * Pi 特有的三件事：凭据解析（环境变量 / 系统密钥库）、正文落盘、details 形态。
 * 路由、重试、额度预检、冷却、脱敏与渲染都只有内核一份实现。
 *
 * @module dsh-web-search/hosts/pi
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createSecretStore, type SecretStore } from "../auth/credentials.js";
import { registerAuthCommand } from "../auth/ui.js";
import { BACKENDS, emptyPlanKeys, resolvePlanKeys } from "../auth/resolve.js";
import type { ChannelHealth } from "../search/channel-health.js";
import { getRoutingStatus, readRoutingConfig } from "../search/routing.js";
import { createQuotaManager } from "../quota/core.js";
import { createPrivateQuotaStateStore } from "../quota/state-store.js";
import { clampResults, createSearchEngine, MAX_QUERY_CHARS, renderOutcome, redactSecrets } from "../search/engine.js";
import { getProviderMetadata, isProviderId, PROVIDER_IDS } from "../search/registry.js";
import { readMaxResponseBytes } from "../shared/response-body.js";
import { readSearchRequestConfig } from "../search/config.js";
import { clipDiagnostic, MAX_FAILURE_SUMMARY_CHARS } from "../search/core.js";
import { discardSpillFile, spillFullText } from "../search/spill-store.js";
import type { SearchSource as WebSource } from "../search/contracts.js";

export type { WebSource };

/** 默认返回条数。 */
const DEFAULT_NUM_RESULTS = 8;
/** 模型可见正文上限，超出部分被截断并显式告知模型。 */
const MAX_TEXT_CHARS = 24_000;

/** 工具参数表。 */
const WebSearchParams = Type.Object({
	query: Type.String({
		description:
			"The query. Describe the page you want in natural language instead of stacking keywords, e.g. 'a blog post comparing React and Vue performance'.",
		maxLength: MAX_QUERY_CHARS,
	}),
	maxResults: Type.Optional(
		Type.Integer({
			description: `Number of results to return. Defaults to ${DEFAULT_NUM_RESULTS}.`,
			minimum: 1,
			maximum: 20,
		}),
	),
	provider: Type.Optional(
		Type.Union([Type.Literal("auto"), ...PROVIDER_IDS.map((backend) => Type.Literal(backend))], {
			description: "先按固定顺序尝试所有匿名通道；仅在显式授权后逐个尝试可能计费的 Key 通道。",
		}),
	),
});

/** 统一创建可被运行时识别的取消错误，不传播底层错误文本。 */
function createAbortError(): DOMException {
	return new DOMException("web_search aborted", "AbortError");
}

/** 预算耗尽的统一错误：与内核保持同一分类标记，宿主可见。 */
function budgetExhaustedError(): Error {
	const error = new Error("整次搜索的总时间预算已用尽 [budget_exhausted]");
	(error as { code?: string }).code = "TIMEOUT";
	return error;
}

/**
 * 用剩余预算约束只受外部取消影响的异步阶段（凭据解析）。
 *
 * 与内核的 `withinBudget` 同义：先到期者胜出，取消优先于预算；
 * 输掉竞争的一方继续在后台推进，其迟到拒绝必须被消费。
 */
async function withinDeadline<T>(promise: Promise<T>, totalMs: number, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted === true) {
		void promise.catch(() => undefined);
		throw createAbortError();
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const expire = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(budgetExhaustedError()), totalMs);
		onAbort = () => reject(createAbortError());
		signal?.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([promise, expire]);
	} catch (error) {
		void promise.catch(() => undefined);
		throw error;
	} finally {
		clearTimeout(timer);
		if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
	}
}

/** 取消状态可在异步等待期间改变，每次检查都重新读取。 */
function isAborted(signal?: AbortSignal): boolean {
	return signal?.aborted === true;
}

/**
 * 把内核的持久化警告翻译成面向用户的固定文案。
 *
 * 预算耗尽导致的跳过与写盘失败要能区分：前者是"本次没写"，后者是"写不进去"。
 */
function quotaWarningText(warnings: readonly string[]): string {
	if (warnings.includes("QUOTA_STATE_FLUSH_TIMEOUT")) return "额度状态写入跳过：整次调用总时间预算已用尽";
	return `额度状态写入退化：${warnings.join(", ")}`;
}

/** Pi 端的默认状态目录：`$PI_AGENT_DIR/config/web-search`。 */
export function piStateDirectory(): string {
	return join(getAgentDir(), "config", "web-search");
}

/** 目录不可创建时内核会降级为进程内状态，搜索本身仍然可用。 */
function ensureStateDirectory(path: string): string {
	try {
		mkdirSync(path, { recursive: true, mode: 0o700 });
	} catch {
		// 保持降级语义，不阻断搜索。
	}
	return path;
}

/** 扩展的可注入选项（测试用）。 */
export interface WebSearchOptions {
	/** 系统密钥库；默认按平台选择（macOS Keychain / Linux secret-tool）。测试注入 fake，不触碰真实密钥库。 */
	credentialStore?: SecretStore;
	/** 可注入的旧式通道冷却状态；仅显式注入时与额度管理器双写兼容状态。 */
	channelHealth?: ChannelHealth;
	/** 可注入额度管理器；默认无注入的生产实例使用 Pi 私有配置目录持久化。 */
	quotaManager?: ReturnType<typeof createQuotaManager>;
	/** 与注入的旧式冷却状态共享测试时钟；不注入时使用真实时间。 */
	quotaClock?: () => number;
}

/** 注册 `web_search` 工具与 `/web-search-auth` 命令。 */
export default function piWebSearch(pi: ExtensionAPI, options: WebSearchOptions = {}): void {
	const store: SecretStore = options.credentialStore ?? createSecretStore();
	const channelHealth = options.channelHealth;
	// 任一依赖被注入都说明调用方自己掌管状态：此时不得产生宿主目录副作用。
	const injectedTestBoundary = options.credentialStore !== undefined
		|| options.channelHealth !== undefined
		|| options.quotaManager !== undefined;
	const quotaManager = options.quotaManager ?? createQuotaManager(injectedTestBoundary
		? { ...(options.quotaClock === undefined ? {} : { clock: options.quotaClock }) }
		: {
			stateStore: createPrivateQuotaStateStore(piStateDirectory()),
			...(options.quotaClock === undefined ? {} : { clock: options.quotaClock }),
		});
	registerAuthCommand(pi, store, () => getRoutingStatus(
		readRoutingConfig(),
		channelHealth?.snapshot().channels ?? [],
		quotaManager.snapshot(),
	));

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"先尝试匿名搜索；所有已配置 API Key 均按可能计费处理，额度预检不代表免费。只有显式授权后才使用 Key 通道；返回可引用来源。",
		parameters: WebSearchParams,
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
		async execute(_toolCallId, params, signal) {
			// 执行全部委托给宿主无关内核；本层只保留 Pi 特有的三件事：
			// 凭据解析（环境变量 / 系统密钥库）、落盘回调、以及 details 形态。
			if (isAborted(signal)) throw createAbortError();
			const routing = readRoutingConfig();
			const query = params.query.trim();
			if (query.length === 0) throw new Error("query must not be empty");
			// 请求校验必须先于凭据访问：超长查询不该触发一次密钥库读取。
			if (query.length > MAX_QUERY_CHARS) throw new Error(`query 不得超过 ${MAX_QUERY_CHARS} 个字符`);
			const provider = params.provider ?? "auto";
			if (provider !== "auto" && !isProviderId(provider)) throw new Error("未知的搜索后端");
			const numResults = clampResults(params.maxResults);

			// 配置必须在读取任何凭据与发送任何请求之前完成校验：
			// 非法配置不应触发密钥库访问，也不应产生网络流量。
			const requestConfig = readSearchRequestConfig();
			const maxResponseBytes = readMaxResponseBytes();

			// 整次调用只有一个绝对截止时间：凭据解析、搜索与收尾都从它倒扣。
			// 各阶段分别计时会让总耗时翻倍（凭据用满一轮，引擎再拿满一轮）。
			//
			// 用单调时钟锚定：墙钟回拨不能把预算变长。这里不把过期值提升为
			// 一毫秒——那会让已经过期的调用仍然派发一次真实请求。
			const startedAt = performance.now();
			const remainingMs = (): number => requestConfig.totalTimeoutMs - (performance.now() - startedAt);
			const requireBudget = (): number => {
				const left = remainingMs();
				if (left <= 0) throw budgetExhaustedError();
				// 单调时钟返回浮点毫秒，而内核按整数校验参数：向上取整后交出去。
				return Math.ceil(left);
			};

			// 未授权计费时绝不读取密钥环境变量或系统密钥库。
			const keys = routing.allowBillable
				? await withinDeadline(resolvePlanKeys(provider, store, signal), requireBudget(), signal)
				: emptyPlanKeys();
			if (isAborted(signal)) throw createAbortError();
			const secrets = BACKENDS.map((backend) => keys[backend]);

			// 兼容旧式通道健康状态：注入时先按它短路，避免冷却期仍然发请求。
			if (channelHealth !== undefined) {
				const candidate = provider === "auto" ? "exa" : provider;
				const cooldown = channelHealth.getCooldown(candidate as never, routing.allowBillable ? "key" : "free")
					?? channelHealth.getCooldown(candidate as never, "free");
				if (cooldown !== undefined && routing.allowBillable !== true) {
					throw new Error(`通道正在冷却，剩余约 ${Math.ceil(cooldown.remainingMs / 1000)} 秒；本次未发送网络请求`);
				}
			}

			// 凭据阶段可能耗掉大部分预算：进入搜索前再核实一次同一绝对截止时间。
			const budget = requireBudget();
			const engine = createSearchEngine({
				// 复用常驻管理器：菜单与本次搜索必须看到同一份冷却状态。
				quotaManager,
				allowBillable: routing.allowBillable,
				strategy: routing.strategy,
				timeoutMs: Math.min(requestConfig.timeoutMs, budget),
				// 只把剩下的时间交给引擎，不再从零起算。
				totalTimeoutMs: budget,
				maxResponseBytes,
				retries: requestConfig.retries,
				// 只有真正走磁盘持久化时才创建宿主目录：
				// 注入内存管理器或测试替身时不应产生任何文件系统副作用。
				...(injectedTestBoundary ? {} : { stateDirectory: ensureStateDirectory(piStateDirectory()) }),
				...(routing.cooldownOverrideMs === undefined ? {} : { cooldownOverrideMs: routing.cooldownOverrideMs }),
			}, {
				resolveKey: async (backend) => keys[backend],
				// TinyFish 是零凭据通道，不在解析集合内。
				keyProviders: BACKENDS.filter((backend) => backend !== "tinyfish"),
				// Pi 的历史行为：允许粘贴含空格的密钥，并把脱敏后的底层诊断带进错误。
				allowWhitespaceKeys: true,
				includeErrorDetail: true,
				// 沿用 Pi 进程的 fetch：测试与宿主都可能替换 globalThis.fetch，
				// 内核默认的私有 undici 实例会绕过它们。
				fetch: globalThis.fetch,
			});

			try {
				const outcome = await engine.searchWithSpill(
					{ query, maxResults: numResults, provider },
					(text) => spillFullText(text),
					signal,
					// 落盘被取消时后台可能仍会完成写入，按路径回收那份残留文件。
					(path) => { void discardSpillFile(path).catch(() => undefined); },
				);
				if (isAborted(signal)) throw createAbortError();

				// 先补记本次调用中失败过的通道，再清除成功通道的冷却：
				// 匿名限流后切到 Key 成功时，匿名通道的冷却记录必须保留。
				if (channelHealth !== undefined) {
					for (const failure of outcome.failures) {
						const reason = failure.kind === "rate_limited" ? "rate_limited" : failure.kind === "quota_exhausted" ? "quota_exhausted" : undefined;
						if (reason === undefined) continue;
						const keyed = failure.label.endsWith("(key)");
						channelHealth.recordFailure(failure.label.replace(/\(key\)$/u, "") as never, keyed ? "key" : "free", reason, {
							...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
						});
					}
				}
				channelHealth?.recordSuccess(outcome.backend, outcome.channel);
				// 上游可能回显密钥：正文、来源与查询一律在进入模型上下文前脱敏。
				const safeQuery = redactSecrets(query, secrets);
				const sources = outcome.sources.map((source) => ({
					url: redactSecrets(source.url, secrets),
					...(source.title === undefined ? {} : { title: redactSecrets(source.title, secrets) }),
					...(source.snippet === undefined ? {} : { snippet: redactSecrets(source.snippet, secrets).slice(0, 200) }),
					...(source.publishedAt === undefined ? {} : { publishedAt: redactSecrets(source.publishedAt, secrets) }),
				})).slice(0, numResults);
				const text = redactSecrets(outcome.text, secrets);
				const truncated = text.length > MAX_TEXT_CHARS;
				// 汇总同样限长：单条已裁剪，多条累加仍可能撑大会话。
				const fallbackReason = outcome.failures.length > 0
					? clipDiagnostic(
						outcome.failures.map((failure) => `${failure.label}[${failure.kind}]: ${failure.message}`).join(" | "),
						MAX_FAILURE_SUMMARY_CHARS,
					)
					: undefined;
				return {
					content: [{ type: "text" as const, text: renderOutcome(safeQuery, { backend: outcome.backend, text, sources }, MAX_TEXT_CHARS, outcome.spillPath) }],
					details: {
						provider: outcome.backend,
						channel: outcome.channel,
						accessTier: outcome.accessTier,
						query: safeQuery,
						numResults,
						sourceCount: sources.length,
						sources,
						truncated,
						attemptCount: outcome.attempts,
						quotaPersistence: outcome.quotaPersistence,
						...(outcome.warnings.length > 0 ? { quotaWarning: quotaWarningText(outcome.warnings) } : {}),
						...(fallbackReason === undefined ? {} : { fallbackReason }),
						...(outcome.spillPath === undefined ? {} : { fullTextPath: outcome.spillPath, fullTextComplete: outcome.spillComplete === true }),
						...(outcome.spillFailed === true ? { fullTextWarning: "正文已截断，完整正文落盘失败。" } : {}),
					},
				};
			} catch (error) {
				// Pi 的工具契约要求取消时抛 DOMException(AbortError)，而不是普通 Error。
				if (signal?.aborted === true) throw createAbortError();
				if (error instanceof Error && (error as { code?: string }).code === "ABORTED") throw createAbortError();
				// 兼容旧式通道健康状态：注入时按结构化失败明细双写，供既有观察面与菜单读取。
				if (channelHealth !== undefined) {
					const failures = (error as { failures?: readonly { label: string; kind: string }[] }).failures ?? [];
					for (const failure of failures) {
						const reason = failure.kind === "rate_limited" ? "rate_limited" : failure.kind === "quota_exhausted" ? "quota_exhausted" : undefined;
						if (reason === undefined) continue;
						const keyed = failure.label.endsWith("(key)");
						const backend = failure.label.replace(/\(key\)$/u, "");
						const retryAfterMs = (failure as { retryAfterMs?: number }).retryAfterMs;
						channelHealth.recordFailure(backend as never, keyed ? "key" : "free", reason, {
							...(retryAfterMs === undefined ? {} : { retryAfterMs }),
							// Retry-After 优先于固定冷却：有明确恢复时间时不套用覆盖值。
							...(retryAfterMs !== undefined || routing.cooldownOverrideMs === undefined ? {} : { cooldownMs: routing.cooldownOverrideMs }),
						});
					}
				}
				// 未授权计费时明确告知：可能计费的通道没有被尝试过。
				if (routing.allowBillable !== true && error instanceof Error && !String(error.message).includes("未获授权")) {
					// 指出具体开关，用户才能知道该改哪一个环境变量。
					error.message = `${error.message} | 可能计费通道未获授权，未尝试（PI_WEB_SEARCH_ALLOW_BILLABLE=false）`;
				}
				throw error;
			} finally {
				await engine.dispose();
			}
		},
	});
}

export { getProviderMetadata };
