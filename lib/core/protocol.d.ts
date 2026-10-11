/** 五个固定服务的纯请求构造、协议解析与来源校验。 */
import type { ProviderId, SearchSource } from "../contracts.js";
export interface RequestSpec {
    url: string;
    headers: Record<string, string>;
    body: string;
}
export interface Parsed {
    sources: SearchSource[];
    content?: string;
    truncated?: boolean;
}
export type FailureKind = "rate" | "exhausted" | "server" | "network" | "too_large" | "protocol" | "invalid_key";
export declare class ProviderFault extends Error {
    readonly kind: FailureKind;
    readonly retryAfter?: number | undefined;
    constructor(kind: FailureKind, retryAfter?: number | undefined);
}
export declare function isHttpUrl(value: string): boolean;
export declare function buildRequest(provider: ProviderId, query: string, maxResults: number, key?: string): RequestSpec;
export declare function parseMcpResponse(body: string): string | undefined;
export declare function parseProviderResponse(provider: ProviderId, body: string, maxResults: number): Parsed;
export declare function classifyHttp(status: number, detail: string): FailureKind;
export declare function errorDetail(body: string): string;
export declare function mapCoreFault(error: unknown): FailureKind;
