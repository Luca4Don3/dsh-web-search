import z from "@deepseek-ai/schemastery";
import { WebError, } from "@deepseek-ai/dsh-web";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createSearchEngine, clampResults, renderOutcome } from "../search/engine.js";
import { fetchPage, FetchError } from "../fetch/index.js";
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
/** 遵循官方 DSH_HOME 的路径规则，但不读取任何宿主配置或凭据文件。 */
export function defaultStateDirectory(env = process.env) {
    const selected = env.DSH_HOME?.trim();
    const base = selected === undefined || selected.length === 0 ? join(homedir(), ".dsh") : selected;
    const expanded = base === "~" ? homedir() : base.startsWith("~/") || base.startsWith("~\\") ? join(homedir(), base.slice(2)) : base;
    return join(resolve(expanded), "config", "web-search");
}
/** 搜索提供方：把内核结果收敛为 DSH 的 `WebSearchResult`。 */
export class FreeFirstProvider {
    engine;
    maxChars;
    id = PROVIDER_ID;
    disposed = false;
    constructor(engine, maxChars) {
        this.engine = engine;
        this.maxChars = maxChars;
    }
    available() {
        return !this.disposed;
    }
    async search(request, signal) {
        if (this.disposed)
            throw new WebError("搜索提供方已关闭", "WEB_PROVIDER_UNAVAILABLE");
        try {
            const result = await this.engine.search({ query: request.query, ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }) }, signal);
            return {
                ...(result.content === undefined ? {} : { content: result.content }),
                sources: result.sources,
                truncated: result.truncated,
            };
        }
        catch (error) {
            // 不把底层异常或因果链带到宿主的会话与诊断中。
            throw new WebError(safeMessage(error), safeCode(error), { cause: undefined });
        }
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        await this.engine.dispose();
    }
}
/** 抓取提供方：非 2xx 是结果而不是异常，符合 DSH 对抓取层的约定。 */
export class LocalFirstFetchProvider {
    config;
    dependencies;
    id = FETCH_PROVIDER_ID;
    disposed = false;
    /** 在途抓取的取消控制器：卸载时必须一并撤销，否则旧请求仍会返回正文。 */
    active = new Set();
    constructor(config, 
    /** 传输层依赖：生产用默认实现，测试可注入离线替身。 */
    dependencies = {}) {
        this.config = config;
        this.dependencies = dependencies;
    }
    available() {
        return !this.disposed;
    }
    async fetch(request, signal) {
        if (this.disposed)
            throw new WebError("抓取提供方已关闭", "WEB_PROVIDER_UNAVAILABLE");
        const controller = new AbortController();
        this.active.add(controller);
        const forward = () => controller.abort();
        signal?.addEventListener("abort", forward, { once: true });
        if (signal?.aborted === true)
            controller.abort();
        try {
            const outcome = await fetchPage({ url: request.url }, this.config, this.dependencies, controller.signal);
            // 取消可能晚于响应到达：卸载后不得再把正文交出去。
            if (this.disposed)
                throw new WebError("抓取提供方已关闭", "WEB_PROVIDER_UNAVAILABLE");
            return {
                url: outcome.finalUrl,
                statusCode: outcome.statusCode,
                body: { kind: "text", content: outcome.markdown },
                truncated: outcome.truncated,
            };
        }
        catch (error) {
            if (this.disposed)
                throw new WebError("抓取提供方已关闭", "WEB_PROVIDER_UNAVAILABLE");
            // DSH 要求：成功取回的非 2xx 响应是结果；只有无法安全取回才是 WebError。
            if (error instanceof FetchError && error.options?.statusCode !== undefined) {
                // 错误状态同样要报告**最终**地址：重定向后报错时不能退回初始地址。
                return {
                    url: error.options.finalUrl ?? request.url,
                    statusCode: error.options.statusCode,
                    body: { kind: "text", content: "" },
                    truncated: false,
                };
            }
            throw new WebError(fetchMessage(error), fetchCode(error));
        }
        finally {
            signal?.removeEventListener("abort", forward);
            this.active.delete(controller);
        }
    }
    dispose() {
        this.disposed = true;
        // 卸载即撤销全部在途请求。
        for (const controller of this.active)
            controller.abort();
        this.active.clear();
    }
}
const SEARCH_CODES = new Set([
    "invalid_config", "invalid_request", "response_too_large", "timeout", "aborted",
    "quota_preflight", "invalid_key", "rate_limited", "network_error", "protocol_error", "budget_exhausted",
]);
function safeCode(error) {
    // 内核的稳定错误码优先：DISPOSED / TIMEOUT / ABORTED 等必须原样透出，
    // 否则宿主无法区分"已卸载"和"搜索失败"。
    const stable = error?.code;
    if (stable === "DISPOSED" || stable === "TIMEOUT" || stable === "ABORTED" || stable === "INVALID_REQUEST" || stable === "INVALID_CONFIG" || stable === "INVALID_KEY") {
        return stable;
    }
    const kind = error?.kind;
    return typeof kind === "string" && SEARCH_CODES.has(kind) ? `WEB_SEARCH_${kind.toUpperCase()}` : "WEB_SEARCH_FAILED";
}
function safeMessage(error) {
    const message = error instanceof Error ? error.message : "";
    return message.length === 0 ? "搜索失败" : message.slice(0, 500);
}
function fetchCode(error) {
    return error instanceof FetchError ? `WEB_FETCH_${error.kind.toUpperCase()}` : "WEB_FETCH_FAILED";
}
function fetchMessage(error) {
    return error instanceof FetchError ? error.message : "抓取失败";
}
/** 测试用依赖注入不进入宿主配置，不调用真实凭据服务。 */
export function createPlugin(dependencies = {}) {
    return {
        name,
        inject,
        Config,
        apply(ctx, config = {}) {
            const stateDirectory = config.stateDirectory ?? defaultStateDirectory(dependencies.env);
            if (typeof stateDirectory !== "string" || stateDirectory.length === 0 || !isAbsolute(stateDirectory)) {
                throw new WebError("冷却状态目录必须为绝对路径", "WEB_SEARCH_INVALID_CONFIG");
            }
            let engine;
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
                    ...(dependencies.resolveKey === undefined ? {} : { resolveKey: dependencies.resolveKey }),
                    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
                });
            }
            catch {
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
            let unregisterSearch;
            let unregisterFetch;
            try {
                unregisterSearch = ctx.web.registerSearchProvider(provider);
                unregisterFetch = ctx.web.registerFetchProvider(fetcher);
            }
            catch (error) {
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
export function apply(ctx, config = {}) {
    createPlugin().apply(ctx, config);
}
export { clampResults, renderOutcome };
