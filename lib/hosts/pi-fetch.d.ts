/**
 * Pi 宿主适配层：把 `web_fetch` 注册为模型工具。
 *
 * 执行逻辑全部委托给宿主无关内核 {@link fetchPage}：目标校验、逐跳重定向、
 * 绝对截止时间、字符集解码与正文提取都只有一份实现。这里只保留
 * Pi 特有的部分——参数 schema、错误到 Pi 工具错误的映射、以及 details 形态。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type WebFetchConfig } from "../fetch/config.js";
import { type FetchErrorKind } from "../fetch/errors.js";
import { type FetchDetails, type FetchMode } from "../fetch/params.js";
import { extractContent } from "../fetch/extract/index.js";
import { resolveFetchTarget } from "../fetch/transport/url-policy.js";
import { httpFetch } from "../fetch/transport/http-client.js";
import { type FetchDependencies } from "../fetch/index.js";
/** web_fetch 工具的模型可见参数表。 */
export declare const WebFetchParams: Type.TObject<{
    url: Type.TString;
    mode: Type.TOptional<Type.TUnion<Type.TLiteral<"auto" | "text" | "article">[]>>;
    maxChars: Type.TOptional<Type.TInteger>;
}>;
export type WebFetchDetails = FetchDetails;
export type { WebFetchConfig, FetchErrorKind, FetchMode };
/** 抓取与提取的依赖；默认走真实实现，测试可整体注入。 */
export interface WebFetchDependencies extends FetchDependencies {
}
/** 可注入配置与依赖；测试只替换需要替换的部分。 */
export interface WebFetchOptions extends WebFetchDependencies {
    config?: () => WebFetchConfig;
}
/** 注册 `web_fetch` 工具。 */
export default function piWebFetch(pi: ExtensionAPI, options?: WebFetchOptions): void;
export { extractContent, resolveFetchTarget, httpFetch };
