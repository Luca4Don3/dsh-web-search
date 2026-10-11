/** 仅注册 DSH 的搜索能力，不创建模型工具或网页抓取提供方。 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { type WebSearchProvider, type WebSearchRequest, type WebSearchResult } from "@deepseek-ai/dsh-web";
import type { SearchDependencies, SearchEngine, SearchOptions } from "./contracts.js";
export declare const name = "web-search";
export declare const inject: string[];
export declare const PROVIDER_ID = "free-first";
export type Config = SearchOptions;
/** 没有秘密值、凭据源或可由模型覆盖的费用开关。 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    allowBillable: z<boolean, boolean, "defined">;
    timeoutMs: z<number, number, "defined">;
    maxResponseBytes: z<number, number, "defined">;
    maxChars: z<number, number, "defined">;
    retries: z<number, number, "defined">;
    cooldownOverrideMs: z<number, number, "plain">;
    stateDirectory: z<string, string, "plain">;
}>>, Schemastery.ObjectT<NoInfer<{
    allowBillable: z<boolean, boolean, "defined">;
    timeoutMs: z<number, number, "defined">;
    maxResponseBytes: z<number, number, "defined">;
    maxChars: z<number, number, "defined">;
    retries: z<number, number, "defined">;
    cooldownOverrideMs: z<number, number, "plain">;
    stateDirectory: z<string, string, "plain">;
}>>, "plain">;
/** 遵循官方 DSH_HOME 的路径规则，但不读取任何宿主配置或凭据文件。 */
export declare function defaultStateDirectory(env?: Readonly<Record<string, string | undefined>>): string;
/** 提供方生命期与搜索核心分离，便于用假依赖验证真实 Cordis 注册。 */
export declare class FreeFirstProvider implements WebSearchProvider {
    private readonly engine;
    readonly id = "free-first";
    private disposed;
    constructor(engine: SearchEngine);
    available(): boolean;
    search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
    dispose(): Promise<void>;
}
/** 测试用依赖注入不进入宿主配置，不调用真实凭据服务。 */
export declare function createPlugin(dependencies?: SearchDependencies): {
    name: string;
    inject: string[];
    Config: z<Schemastery.ObjectS<NoInfer<{
        allowBillable: z<boolean, boolean, "defined">;
        timeoutMs: z<number, number, "defined">;
        maxResponseBytes: z<number, number, "defined">;
        maxChars: z<number, number, "defined">;
        retries: z<number, number, "defined">;
        cooldownOverrideMs: z<number, number, "plain">;
        stateDirectory: z<string, string, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
        allowBillable: z<boolean, boolean, "defined">;
        timeoutMs: z<number, number, "defined">;
        maxResponseBytes: z<number, number, "defined">;
        maxChars: z<number, number, "defined">;
        retries: z<number, number, "defined">;
        cooldownOverrideMs: z<number, number, "plain">;
        stateDirectory: z<string, string, "plain">;
    }>>, "plain">;
    apply(ctx: Context, config?: Config): void;
};
/** 默认导出遵循官方宿主插件的命名导出约定。 */
export declare function apply(ctx: Context, config?: Config): void;
