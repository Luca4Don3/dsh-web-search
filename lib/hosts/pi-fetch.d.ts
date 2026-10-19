/**
 * web_fetch：本地优先的网页正文抓取扩展。
 *
 * - 只读取调用方给出的公开 URL，不执行网页脚本，不携带 Cookie / Authorization。
 * - 初始解析、逐跳重定向、连接与正文读取共享同一绝对截止时间。
 * - 同步提取前后检查截止时间，不返回过期结果；不启用任何远程回退。
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type FetchDetails, type FetchMode } from "../fetch/params.js";
import { Type } from "typebox";
import { type WebFetchConfig } from "../fetch/config.js";
import { type FetchErrorKind } from "../fetch/errors.js";
import { resolveFetchTarget } from "../fetch/transport/url-policy.js";
import { extractContent } from "../fetch/extract/index.js";
/** web_fetch 工具的模型可见参数表。 */
export declare const WebFetchParams: Type.TObject<{
    url: Type.TString;
    mode: Type.TOptional<Type.TUnion<Type.TLiteral<"auto" | "text" | "article">[]>>;
    maxChars: Type.TOptional<Type.TInteger>;
}>;
export type WebFetchDetails = FetchDetails;
export type { WebFetchConfig, FetchErrorKind, FetchMode };
/** 抓取与提取的依赖；默认走真实实现，测试可整体注入。 */
export interface WebFetchDependencies {
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
/** 可注入配置与依赖；测试只替换需要替换的部分。 */
export interface WebFetchOptions extends WebFetchDependencies {
    config?: () => WebFetchConfig;
}
/** 注册 `web_fetch` 工具。 */
export default function piWebFetch(pi: ExtensionAPI, options?: WebFetchOptions): void;
