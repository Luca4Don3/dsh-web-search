/**
 * web_fetch 的配置读取与严格校验。
 *
 * 所有取值都来自环境变量，非法配置在发起任何网络请求之前失败，
 * 并且错误文本不回显调用方给出的原值。
 */
/** 默认整次抓取总预算，包含初始解析、所有跳转与正文读取。 */
export declare const DEFAULT_TIMEOUT_MS = 20000;
/** 默认解压后响应体上限，与 web-search 的响应体上限保持一致。 */
export declare const DEFAULT_MAX_RESPONSE_BYTES = 5242880;
export declare const MAX_RESPONSE_BYTES = 20971520;
/** 默认模型可见正文字符上限。 */
export declare const DEFAULT_MAX_CHARS = 24000;
export declare const MAX_CHARS_LIMIT = 200000;
/** 默认最大重定向次数。 */
export declare const DEFAULT_MAX_REDIRECTS = 3;
export declare const MAX_REDIRECTS_LIMIT = 5;
/** 当前仅实现本地抓取；远程回退必须保持关闭。 */
export type RemoteFallback = "off";
export interface WebFetchConfig {
    readonly timeoutMs: number;
    readonly maxResponseBytes: number;
    readonly maxChars: number;
    readonly maxRedirects: number;
    readonly remoteFallback: RemoteFallback;
}
/** 从环境变量读取抓取配置；未设置时全部使用默认值。 */
export declare function readWebFetchConfig(source?: Record<string, string | undefined>): WebFetchConfig;
