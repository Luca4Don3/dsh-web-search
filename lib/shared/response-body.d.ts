export declare const DEFAULT_MAX_RESPONSE_BYTES: number;
export declare const MAX_RESPONSE_BYTES: number;
/** 读取 `PI_WEB_SEARCH_MAX_RESPONSE_BYTES` / `DSH_WEB_SEARCH_MAX_RESPONSE_BYTES`，非法值明确失败。 */
export declare function readMaxResponseBytes(env?: Record<string, string | undefined>): number;
/** 取消/超限/不可读等场景的错误构造；两侧各自注入以保持既有分类。 */
export interface ReadErrorFactory {
    /** 调用方已取消。 */
    aborted(): Error;
    /** 解压后正文超过上限。 */
    tooLarge(): Error;
    /** 正文无法取得 reader。 */
    unreadable?(): Error;
    /** 按声明字符集解码失败（仅在解码策略严格时使用）。 */
    undecodable?(): Error;
}
/** 解码策略：`utf8` 固定 UTF-8；`declared` 读取 content-type 的 charset。 */
export type DecodeStrategy = "utf8" | "declared";
export interface ReadOptions {
    /** 中止信号；超限时会调用 `abortRequest` 主动撤销网络。 */
    readonly signal: AbortSignal;
    /** 超限/取消时主动中止底层请求；省略时只取消 reader。 */
    abortRequest?: () => void;
    /** 解码策略，默认 `utf8`。 */
    readonly decode?: DecodeStrategy;
    /** 显式字符集；仅 `declared` 策略使用，省略时从响应头读取。 */
    readonly charset?: string;
    readonly errors: ReadErrorFactory;
    /** `declared` 策略下，解码失败时是否立即失败；默认 true。 */
    readonly fatalDecode?: boolean;
}
/** 搜索 / 额度查询入口：固定 UTF-8，接受控制器或信号。 */
export declare function readResponseTextLimited(response: Response, maxBytes: number, abortInput: AbortController | AbortSignal, abort?: () => void): Promise<string>;
/** 抓取入口：按声明字符集解码；错误由抓取侧注入以保持既有分类。 */
export declare function readTextLimited(response: Response, maxBytes: number, options: ReadOptions): Promise<string>;
