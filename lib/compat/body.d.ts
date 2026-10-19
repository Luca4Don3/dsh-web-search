/** 有界读取解压后的响应流，并在取消或超限时消费迟到结果。 */
export declare class CoreFault extends Error {
    readonly kind: "aborted" | "timeout" | "too_large" | "network" | "protocol" | "rate" | "exhausted" | "other";
    constructor(kind: "aborted" | "timeout" | "too_large" | "network" | "protocol" | "rate" | "exhausted" | "other");
}
export declare const DEFAULT_MAX_RESPONSE_BYTES: number;
export declare const MAX_RESPONSE_BYTES: number;
/** 以字节计数，超限不返回部分正文；signal 忽略者也不会拖住调用方。 */
export declare function readResponseTextLimited(response: Response, maxBytes: number, signal: AbortSignal, abortNetwork?: () => void): Promise<string>;
