import { BackendError, type SearchErrorKind } from "./core.js";
import type { ProviderId, SearchDependencies, SearchEngine, SearchOptions, SearchRequest, SearchSource } from "./contracts.js";
import { createQuotaManager } from "../quota/core.js";
/** 一次尝试：某个后端的某个通道。 */
export interface RouteStep {
    readonly backend: ProviderId;
    readonly channel: "free" | "key";
    /** key 通道使用的凭据；仅存在于内存，绝不写入日志、session 或落盘内容。 */
    readonly apiKey?: string;
}
/** 结构化的单次调用结果，供宿主渲染与诊断。 */
export interface SearchOutcomeResult {
    readonly backend: ProviderId;
    readonly channel: "free" | "key";
    readonly accessTier: "anonymous" | "billable";
    readonly text: string;
    readonly sources: readonly SearchSource[];
    readonly attempts: number;
    readonly failures: readonly SearchFailure[];
    readonly warnings: readonly string[];
    readonly quotaPersistence: "not_initialized" | "persistent" | "memory_only" | "degraded";
    readonly truncated: boolean;
}
/** 结构化失败记录；宿主可自行格式化，不强制使用同一种文案。 */
export interface SearchFailure {
    readonly label: string;
    readonly kind: SearchErrorKind | "unknown" | "cooldown" | "missing_key" | "budget_exhausted";
    readonly message: string;
    /** 上游给出的恢复时长；宿主据此区分 Retry-After 与固定退避。 */
    readonly retryAfterMs?: number;
}
export interface EngineOptions extends SearchOptions {
    readonly strategy?: "free-first" | "key-first";
    /**
     * 复用调用方已有的额度管理器。
     *
     * 生产环境每次搜索新建实例即可；但宿主可能持有常驻管理器（例如 Pi 的
     * `/web-search-auth` 菜单要读取冷却状态），此时必须共用同一个实例，
     * 否则菜单看到的永远是一份空快照。
     */
    readonly quotaManager?: ReturnType<typeof createQuotaManager>;
}
/** 对外错误只包含固定中文诊断与稳定代码，不保留上游异常或因果链。 */
export declare class SearchError extends Error {
    readonly code: string;
    /**
     * @param code 稳定的错误码，宿主按它路由。
     * @param detail 可选的诊断细节（已脱敏）。追加在固定文案之后，
     *   让调用方能看出具体是哪个服务商失败了，而不是只得到一句总述。
     */
    constructor(code: string, detail?: string);
}
/** 整次调用总预算耗尽；与单请求超时区分，出现后不再尝试任何后续通道。 */
export declare class BudgetExhaustedError extends BackendError {
    constructor(message?: string);
}
/** 只接受 1..20 的整数结果条数。 */
export declare function clampResults(value: number | undefined): number;
/** 渲染模型可见正文；两个宿主共用同一形态，避免行为漂移。 */
export declare function renderOutcome(query: string, outcome: {
    backend: ProviderId;
    text: string;
    sources: readonly SearchSource[];
}, maxChars: number, spillNote?: string): string;
declare function renderSources(sources: readonly SearchSource[], fallback: string): string;
export { renderSources };
export { readResponseTextLimited, DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES } from "../shared/response-body.js";
export { parseMcpResponse } from "./mcp-protocol.js";
/** 脱敏统一走 `shared/redact`，Pi 与 DSH 使用同一份编码形态展开逻辑。 */
export { redactSecrets, expandSecrets } from "../shared/redact.js";
/** 构造独立搜索引擎；不读取宿主配置，只使用调用方给出的选项与依赖。 */
/** 正文落盘回调：返回写入路径与内容是否完整。 */
export type SpillWriter = (text: string) => Promise<{
    path: string;
    complete: boolean;
}>;
/** 内核实例：在公开契约之外提供宿主诊断与呈现所需的附加能力。 */
export interface DetailedSearchEngine extends SearchEngine {
    searchDetailed(request: SearchRequest, signal?: AbortSignal): Promise<SearchOutcomeResult>;
    searchWithSpill(request: SearchRequest, spill: SpillWriter, signal?: AbortSignal, cleanupSpill?: (path: string) => void): Promise<SearchOutcomeResult & {
        spillPath?: string;
        spillComplete?: boolean;
        spillFailed?: boolean;
    }>;
}
export declare function createSearchEngine(options?: EngineOptions, deps?: SearchDependencies): DetailedSearchEngine;
/** 兜底来源提取：并行 JSON → Exa 分块 → 逐行扫描。 */
export declare function extractSources(text: string, maxResults?: number): SearchSource[];
