export declare const DEFAULT_MAX_RESPONSE_BYTES: number;
export declare const MAX_RESPONSE_BYTES: number;
/** 读取 `PI_WEB_SEARCH_MAX_RESPONSE_BYTES` / `DSH_WEB_SEARCH_MAX_RESPONSE_BYTES`，非法值明确失败。 */
export declare function readMaxResponseBytes(env?: Record<string, string | undefined>): number;
/**
 * 按流累计 UTF-8 字节数并增量解码。取消和超限时都中止请求、取消 reader，
 * 且不等待底层取消完成，避免不遵守 AbortSignal 的模拟流拖住调用方。
 */
export declare function readResponseTextLimited(response: Response, maxBytes: number, abortInput: AbortController | AbortSignal, abort?: () => void): Promise<string>;
