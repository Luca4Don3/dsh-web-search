import type { SearchDependencies, SearchEngine, SearchOptions } from "../contracts.js";
export { readResponseTextLimited, DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES } from "./body.js";
export { parseMcpResponse } from "./protocol.js";
/** 对外错误只包含固定中文诊断与稳定代码，不保留上游异常或因果链。 */
export declare class SearchError extends Error {
    readonly code: string;
    constructor(code: string);
}
/** 构造独立搜索引擎；生产网络使用本实例私有的 undici Agent。 */
export declare function createSearchEngine(options?: SearchOptions, deps?: SearchDependencies): SearchEngine;
