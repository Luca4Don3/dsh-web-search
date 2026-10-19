/**
 * 抓取内核：本地优先读取公开网页并输出可读 Markdown。
 *
 * - 只读取调用方给出的公开 URL，不执行网页脚本，不携带 Cookie / Authorization。
 * - 初始解析、逐跳重定向、连接与正文读取共享同一绝对截止时间。
 * - 同步提取前后检查截止时间，不返回过期结果；不启用任何远程回退。
 * - 与宿主无关：DSH 适配层把它包装成 `ctx.web` 的 fetch provider，
 *   Pi 适配层把它包装成 `web_fetch` 工具。
 */
import { FetchError, type FetchErrorKind } from "./errors.js";
import { resolveFetchTarget } from "./transport/url-policy.js";
import { extractContent } from "./extract/index.js";
import type { FetchMode } from "./params.js";
import type { WebFetchConfig } from "./config.js";
export type { WebFetchConfig, FetchErrorKind, FetchMode };
export { FetchError };
/** 抓取与提取的依赖；默认走真实实现，测试可整体注入。 */
export interface FetchDependencies {
    resolveTarget?: (url: string, signal?: AbortSignal) => ReturnType<typeof resolveFetchTarget>;
    fetchPage?: (request: {
        url: URL;
        target: {
            address: string;
            family: 4 | 6;
        };
        signal?: AbortSignal;
        timeoutMs: number;
        deadlineMs: number;
        maxResponseBytes: number;
        maxRedirects: number;
    }) => Promise<{
        body: string;
        contentType: string;
        finalUrl: URL;
        redirectCount: number;
        statusCode: number;
    }>;
    extract?: typeof extractContent;
}
/** 一次抓取的完整结果；宿主自行决定渲染形态。 */
export interface FetchOutcome {
    readonly requestedUrl: string;
    readonly finalUrl: string;
    readonly contentType: string;
    readonly statusCode: number;
    readonly redirectCount: number;
    readonly title?: string;
    readonly markdown: string;
    readonly extractedChars: number;
    readonly truncated: boolean;
    readonly durationMs: number;
}
export interface FetchRequest {
    readonly url: string;
    readonly mode?: FetchMode;
    readonly maxChars?: number;
}
/** 只保留来源与路径：签名 URL、令牌等查询参数不得进入对外结果。 */
export declare function safeDisplayUrl(value: URL): string;
/** 抓取一个公开 URL；配置由调用方读取并传入，内核不读环境变量。 */
export declare function fetchPage(request: FetchRequest, config: WebFetchConfig, dependencies?: FetchDependencies, signal?: AbortSignal): Promise<FetchOutcome>;
