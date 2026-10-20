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
import { type WebFetchProvider, type WebFetchRequest, type WebFetchResult, type WebSearchProvider, type WebSearchRequest, type WebSearchResult } from "@deepseek-ai/dsh-web";
import { createSearchEngine, clampResults, renderOutcome, type SearchOutcomeResult } from "../search/engine.js";
import type { SearchEngine } from "../search/contracts.js";
import { type FetchDependencies } from "../fetch/index.js";
import { readWebFetchConfig } from "../fetch/config.js";
export declare const name = "web-search";
export declare const inject: string[];
export declare const PROVIDER_ID = "free-first";
export declare const FETCH_PROVIDER_ID = "local-first";
/** 没有秘密值、凭据源或可由模型覆盖的费用开关。 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    allowBillable: z<boolean, boolean, "defined">;
    timeoutMs: z<number, number, "defined">;
    totalTimeoutMs: z<number, number, "defined">;
    maxResponseBytes: z<number, number, "defined">;
    maxChars: z<number, number, "defined">;
    retries: z<number, number, "defined">;
    cooldownOverrideMs: z<number, number, "plain">;
    stateDirectory: z<string, string, "plain">;
    /** 抓取侧的整次预算，与搜索预算相互独立。 */
    fetchTimeoutMs: z<number, number, "defined">;
    fetchMaxResponseBytes: z<number, number, "defined">;
    fetchMaxChars: z<number, number, "defined">;
    fetchMaxRedirects: z<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    allowBillable: z<boolean, boolean, "defined">;
    timeoutMs: z<number, number, "defined">;
    totalTimeoutMs: z<number, number, "defined">;
    maxResponseBytes: z<number, number, "defined">;
    maxChars: z<number, number, "defined">;
    retries: z<number, number, "defined">;
    cooldownOverrideMs: z<number, number, "plain">;
    stateDirectory: z<string, string, "plain">;
    /** 抓取侧的整次预算，与搜索预算相互独立。 */
    fetchTimeoutMs: z<number, number, "defined">;
    fetchMaxResponseBytes: z<number, number, "defined">;
    fetchMaxChars: z<number, number, "defined">;
    fetchMaxRedirects: z<number, number, "defined">;
}>>, "plain">;
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
export declare function defaultStateDirectory(env?: Readonly<Record<string, string | undefined>>): string;
/** 搜索提供方：把内核结果收敛为 DSH 的 `WebSearchResult`。 */
export declare class FreeFirstProvider implements WebSearchProvider {
    private readonly engine;
    private readonly maxChars;
    readonly id = "free-first";
    private disposed;
    constructor(engine: SearchEngine, maxChars: number);
    available(): boolean;
    search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
    dispose(): Promise<void>;
}
/** 抓取提供方：非 2xx 是结果而不是异常，符合 DSH 对抓取层的约定。 */
export declare class LocalFirstFetchProvider implements WebFetchProvider {
    private readonly config;
    /** 传输层依赖：生产用默认实现，测试可注入离线替身。 */
    private readonly dependencies;
    readonly id = "local-first";
    private disposed;
    /** 在途抓取的取消控制器：卸载时必须一并撤销，否则旧请求仍会返回正文。 */
    private readonly active;
    constructor(config: ReturnType<typeof readWebFetchConfig>, 
    /** 传输层依赖：生产用默认实现，测试可注入离线替身。 */
    dependencies?: FetchDependencies);
    available(): boolean;
    fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>;
    dispose(): void;
}
/** 测试用依赖注入不进入宿主配置，不调用真实凭据服务。 */
export declare function createPlugin(dependencies?: {
    fetch?: typeof globalThis.fetch;
    env?: Readonly<Record<string, string | undefined>>;
    resolveKey?: Parameters<typeof createSearchEngine>[1] extends infer D ? (D extends {
        resolveKey?: infer R;
    } ? R : never) : never;
    clock?: () => number;
}): {
    name: string;
    inject: string[];
    Config: z<Schemastery.ObjectS<NoInfer<{
        allowBillable: z<boolean, boolean, "defined">;
        timeoutMs: z<number, number, "defined">;
        totalTimeoutMs: z<number, number, "defined">;
        maxResponseBytes: z<number, number, "defined">;
        maxChars: z<number, number, "defined">;
        retries: z<number, number, "defined">;
        cooldownOverrideMs: z<number, number, "plain">;
        stateDirectory: z<string, string, "plain">;
        /** 抓取侧的整次预算，与搜索预算相互独立。 */
        fetchTimeoutMs: z<number, number, "defined">;
        fetchMaxResponseBytes: z<number, number, "defined">;
        fetchMaxChars: z<number, number, "defined">;
        fetchMaxRedirects: z<number, number, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        allowBillable: z<boolean, boolean, "defined">;
        timeoutMs: z<number, number, "defined">;
        totalTimeoutMs: z<number, number, "defined">;
        maxResponseBytes: z<number, number, "defined">;
        maxChars: z<number, number, "defined">;
        retries: z<number, number, "defined">;
        cooldownOverrideMs: z<number, number, "plain">;
        stateDirectory: z<string, string, "plain">;
        /** 抓取侧的整次预算，与搜索预算相互独立。 */
        fetchTimeoutMs: z<number, number, "defined">;
        fetchMaxResponseBytes: z<number, number, "defined">;
        fetchMaxChars: z<number, number, "defined">;
        fetchMaxRedirects: z<number, number, "defined">;
    }>>, "plain">;
    apply(ctx: Context, config?: DshConfig): void;
};
/** 默认导出遵循官方宿主插件的命名导出约定。 */
export declare function apply(ctx: Context, config?: DshConfig): void;
export type { SearchOutcomeResult };
export { clampResults, renderOutcome };
