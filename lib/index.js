import z from "@deepseek-ai/schemastery";
import { WebError } from "@deepseek-ai/dsh-web";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createSearchEngine, SearchError } from "./core/index.js";
export const name = "web-search";
export const inject = ["web"];
export const PROVIDER_ID = "free-first";
/** 没有秘密值、凭据源或可由模型覆盖的费用开关。 */
export const Config = z.object({
    allowBillable: z.boolean().default(false),
    timeoutMs: z.number().step(1).min(1).max(60_000).default(25_000),
    maxResponseBytes: z.number().step(1).min(1).max(20 * 1024 * 1024).default(5 * 1024 * 1024),
    maxChars: z.number().step(1).min(1).max(200_000).default(24_000),
    retries: z.number().step(1).min(0).max(1).default(1),
    cooldownOverrideMs: z.number().step(1).min(0).max(86_400_000),
    stateDirectory: z.string(),
});
/** 遵循官方 DSH_HOME 的路径规则，但不读取任何宿主配置或凭据文件。 */
export function defaultStateDirectory(env = process.env) {
    const selected = env.DSH_HOME?.trim();
    const base = selected === undefined || selected.length === 0 ? join(homedir(), ".dsh") : selected;
    const expanded = base === "~" ? homedir() : base.startsWith("~/") || base.startsWith("~\\") ? join(homedir(), base.slice(2)) : base;
    return join(resolve(expanded), "config", "web-search");
}
/** 提供方生命期与搜索核心分离，便于用假依赖验证真实 Cordis 注册。 */
export class FreeFirstProvider {
    engine;
    id = PROVIDER_ID;
    disposed = false;
    constructor(engine) {
        this.engine = engine;
    }
    available() {
        return !this.disposed;
    }
    async search(request, signal) {
        if (this.disposed)
            throw new WebError("搜索提供方已关闭", "WEB_PROVIDER_UNAVAILABLE");
        try {
            const result = await this.engine.search(request, signal);
            return {
                ...(result.content === undefined ? {} : { content: result.content }),
                sources: result.sources,
                truncated: result.truncated,
            };
        }
        catch (error) {
            // 不把底层异常或因果链带到宿主的会话与诊断中。
            if (error instanceof SearchError)
                throw new WebError(error.message, error.code);
            throw new WebError("搜索失败", "WEB_SEARCH_FAILED");
        }
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        await this.engine.dispose();
    }
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
                engine = createSearchEngine({ ...config, stateDirectory }, dependencies);
            }
            catch {
                throw new WebError("插件配置无效", "WEB_SEARCH_INVALID_CONFIG");
            }
            const provider = new FreeFirstProvider(engine);
            let unregister;
            try {
                unregister = ctx.web.registerSearchProvider(provider);
            }
            catch (error) {
                void provider.dispose().catch(() => undefined);
                throw error;
            }
            ctx.effect(() => async () => {
                unregister();
                await provider.dispose();
            }, "web-search.lifecycle");
        },
    };
}
/** 默认导出遵循官方宿主插件的命名导出约定。 */
export function apply(ctx, config = {}) {
    createPlugin().apply(ctx, config);
}
