/**
 * 搜索内核：匿名优先的路由、额度预检、总预算与有界取消。
 *
 * 与宿主无关：既不 import DSH 的 `ctx.web`，也不 import Pi 的 `ExtensionAPI`。
 * 宿主适配层只负责把请求翻译成 {@link SearchRequest}，并把结果渲染成各自形态。
 *
 * 设计要点：
 * - 所有匿名通道先于所有计费通道；默认禁止计费，所有真实 Key 均按可能计费处理。
 * - 单请求预算与整次调用预算分离：前者约束一次 HTTP，后者约束整次调用。
 * - 失败按类型决策：额度/鉴权直接换通道，限流与 5xx 有界退避重试，取消立即终止。
 * - 模型可见正文截断到 maxChars；脱敏、渲染与落盘由宿主适配层负责。
 */
import { fetch as undiciFetch } from "undici";
import { BackendError, errorDetailFrom, httpKind, isHttpUrl, messageKind } from "./core.js";
import { buildTinyFishHeaders, buildTinyFishPayload, parseTinyFishResults, TINYFISH_MCP_URL } from "./providers/tinyfish.js";
import { apiHttpKind, buildApiRequest, isApiBackend, parseApiResponse } from "./search-api.js";
import { ANONYMOUS_PROVIDER_ORDER, BILLABLE_PROVIDER_ORDER, getProviderMetadata, isProviderId } from "./registry.js";
import { parseMcpBlocks } from "./mcp-protocol.js";
import { DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES, readResponseTextLimited } from "../shared/response-body.js";
import { parseRetryAfter, RETRY_AFTER_MAX_MS } from "../shared/retry-after.js";
import { expandSecrets, redactSecrets } from "../shared/redact.js";
import { createQuotaManager } from "../quota/core.js";
import { createPrivateQuotaStateStore } from "../quota/state-store.js";
import { lookupUsage } from "../quota/usage.js";
/** 对外错误只包含固定中文诊断与稳定代码，不保留上游异常或因果链。 */
export class SearchError extends Error {
    code;
    /**
     * @param code 稳定的错误码，宿主按它路由。
     * @param detail 可选的诊断细节（已脱敏）。追加在固定文案之后，
     *   让调用方能看出具体是哪个服务商失败了，而不是只得到一句总述。
     */
    constructor(code, detail) {
        const safe = SAFE_MESSAGES[code];
        super(`${safe ?? SAFE_MESSAGES.INVALID_REQUEST}${detail === undefined || detail.length === 0 ? "" : ` — ${detail}`}`);
        this.name = "SearchError";
        this.code = safe === undefined ? "INVALID_REQUEST" : code === "BUDGET_EXHAUSTED" ? "TIMEOUT" : code;
    }
}
const SAFE_MESSAGES = {
    INVALID_CONFIG: "搜索配置无效",
    INVALID_REQUEST: "搜索请求无效",
    SEARCH_FAILED: "所有搜索通道均不可用",
    TIMEOUT: "搜索超时",
    // 兼容既有约定：预算耗尽在错误码上仍属于超时类别（TIMEOUT），
    // 但文案与诊断标记要能区分"总预算用尽"与"单请求超时"。
    BUDGET_EXHAUSTED: "整次搜索的总时间预算已用尽",
    ABORTED: "搜索已取消",
    DISPOSED: "搜索引擎已关闭",
    KEY_RESOLUTION_FAILED: "无法安全读取计费密钥",
    INVALID_KEY: "计费密钥格式不安全",
    OUTPUT_TOO_SMALL: "输出预算不足以保留有效来源",
};
const DEFAULT_NUM_RESULTS = 8;
const MAX_TEXT_CHARS = 24_000;
const RETRY_BASE_MS = 400;
const RETRY_MAX_WAIT_MS = 5_000;
const USER_AGENT = "dsh-web-search/0.2.0";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
const KEY_ENV = {
    exa: "EXA_API_KEY",
    parallel: "PARALLEL_API_KEY",
    tavily: "TAVILY_API_KEY",
    firecrawl: "FIRECRAWL_API_KEY",
    serpapi: "SERPAPI_API_KEY",
};
/**
 * 默认解析集合：全部计费后端，与 `BILLABLE_PROVIDER_ORDER` 保持一致。
 *
 * 早期 DSH 实现只解析四家、SerpApi 仅 Pi 可用，这使同一个包在两个宿主上的
 * 能力不同。既然对外承诺是一份内核，这里统一为全集；宿主如需限制，
 * 通过 {@link SearchDependencies.keyProviders} 显式收窄。
 */
const DEFAULT_KEY_PROVIDERS = BILLABLE_PROVIDER_ORDER;
/** 整次调用的绝对截止时间：单调时钟锚定，不受系统时间调整影响。 */
class TotalBudget {
    startedAt = performance.now();
    deadlineMs;
    constructor(totalMs) {
        this.deadlineMs = this.startedAt + totalMs;
    }
    remainingMs() {
        return this.deadlineMs - performance.now();
    }
    get exhausted() {
        return this.remainingMs() <= 0;
    }
}
/** 整次调用总预算耗尽；与单请求超时区分，出现后不再尝试任何后续通道。 */
export class BudgetExhaustedError extends BackendError {
    constructor(message = "整次搜索的总时间预算已用尽，未再尝试后续通道") {
        super(message, "budget_exhausted");
    }
}
function abortError() {
    return new DOMException("web_search aborted", "AbortError");
}
function isAborted(signal) {
    return signal?.aborted === true;
}
/** Exa 免费 MCP 的精确额度提示；仅允许有限标点/空白变化，不匹配普通摘要。 */
function isExaFreeRateLimitNotice(text) {
    return /^\s*You['’‘]ve\s+hit\s+Exa['’‘]s\s+free\s+MCP\s+rate\s+limit\b(?:[\s.!?…:;,—–-]|$)/iu.test(text);
}
function stepLabel(step) {
    return step.channel === "key" ? `${step.backend}(key)` : step.backend;
}
/** 搜索把 Retry-After 当作冷却时长，因此上限为 24 小时。 */
function retryAfterMs(value) {
    return parseRetryAfter(value, { maxMs: RETRY_AFTER_MAX_MS });
}
/** 只接受 1..20 的整数结果条数。 */
export function clampResults(value) {
    const result = value ?? DEFAULT_NUM_RESULTS;
    if (!Number.isSafeInteger(result) || result < 1 || result > 20)
        throw new SearchError("INVALID_REQUEST");
    return result;
}
function validateOptions(options) {
    const int = (value, fallback, min, max, name) => {
        const result = value ?? fallback;
        if (!Number.isSafeInteger(result) || result < min || result > max)
            throw new SearchError("INVALID_CONFIG");
        void name;
        return result;
    };
    if (options.allowBillable !== undefined && typeof options.allowBillable !== "boolean")
        throw new SearchError("INVALID_CONFIG");
    if (options.strategy !== undefined && options.strategy !== "free-first" && options.strategy !== "key-first") {
        throw new SearchError("INVALID_CONFIG");
    }
    if (options.allowBillable === true && options.strategy === "key-first") {
        throw new SearchError("INVALID_CONFIG");
    }
    const timeoutMs = int(options.timeoutMs, 25_000, 1, 60_000, "timeoutMs");
    // 未显式给出总预算时，按 DSH 历史语义让单请求预算同时约束整次调用；
    // 显式设置 totalTimeoutMs 时才允许整次调用比单请求更长。
    const totalFallback = Math.min(600_000, Math.max(1, timeoutMs));
    return {
        ...options,
        allowBillable: options.allowBillable ?? false,
        strategy: options.strategy ?? "free-first",
        timeoutMs,
        totalTimeoutMs: int(options.totalTimeoutMs, totalFallback, 1, 600_000, "totalTimeoutMs"),
        maxResponseBytes: int(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1, MAX_RESPONSE_BYTES, "maxResponseBytes"),
        maxChars: int(options.maxChars, MAX_TEXT_CHARS, 1, 200_000, "maxChars"),
        retries: int(options.retries, 1, 0, 3, "retries"),
    };
}
/** 渲染模型可见正文；两个宿主共用同一形态，避免行为漂移。 */
export function renderOutcome(query, outcome, maxChars, spillNote) {
    const label = getProviderMetadata(outcome.backend).label;
    const heading = `[${label}] search: ${query}`;
    const body = renderBody(outcome);
    if (body.length <= maxChars)
        return `${heading}\n\n${body}`;
    return `${heading}\n\n${body.slice(0, maxChars)}\n\n[content truncated to ${maxChars} chars${spillNote === undefined ? "" : `; full text: ${spillNote}`}]`;
}
/** REST 后端的正文形态统一为 Markdown 来源列表。 */
function renderBody(outcome) {
    // Exa 返回的是大模型友好的文本布局（Title / URL / Highlights），直接透传；
    // 其余后端归一化为带链接的 Markdown 来源列表，避免把原始 JSON 塞给模型。
    if (outcome.backend === "exa" && outcome.text.length > 0)
        return outcome.text;
    return renderSources(outcome.sources, outcome.text);
}
function renderSources(sources, fallback) {
    if (sources.length === 0)
        return fallback;
    return sources
        .map((source, index) => {
        const title = source.title ?? source.url;
        const meta = source.publishedAt !== undefined ? ` (${source.publishedAt})` : "";
        const snippet = source.snippet !== undefined ? `\n   ${source.snippet}` : "";
        return `${index + 1}. [${title}](${source.url})${meta}${snippet}`;
    })
        .join("\n");
}
export { renderSources };
export { readResponseTextLimited, DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES } from "../shared/response-body.js";
export { parseMcpResponse } from "./mcp-protocol.js";
/** 脱敏统一走 `shared/redact`，Pi 与 DSH 使用同一份编码形态展开逻辑。 */
export { redactSecrets, expandSecrets } from "../shared/redact.js";
export function createSearchEngine(options = {}, deps = {}) {
    const settings = validateOptions(options);
    const stateDirectory = options.stateDirectory;
    // 未给出状态目录时只用进程内状态：不猜测、不创建任何用户目录。
    const quota = options.quotaManager ?? createQuotaManager({
        ...(stateDirectory === undefined ? {} : { stateStore: createPrivateQuotaStateStore(stateDirectory) }),
        ...(deps.clock === undefined ? {} : { clock: deps.clock }),
        deadlineMs: Math.min(settings.timeoutMs, 2_000),
        maxResponseBytes: settings.maxResponseBytes,
        ...(settings.cooldownOverrideMs === undefined ? {} : { cooldownMs: settings.cooldownOverrideMs }),
        // 额度查询必须复用同一网络注入：否则测试与宿主自定义的 fetch 会被绕过。
        ...(() => {
            const fetcher = deps.fetch;
            if (fetcher === undefined)
                return {};
            return {
                lookup: (input, options = {}) => lookupUsage(input, { ...options, fetch: fetcher }),
            };
        })(),
    });
    let disposed = false;
    /** 是否真正触发过额度初始化；未初始化时关闭实例不写任何状态。 */
    let initializedOnce = false;
    const active = new Set();
    const env = deps.env ?? process.env;
    // 生产使用实例私有的 undici fetch；测试可注入替换，不影响宿主全局。
    const fetcher = (deps.fetch ?? undiciFetch);
    const checkAborted = (signal) => {
        if (isAborted(signal))
            throw abortError();
    };
    /** 在总预算内等待任意异步阶段；预算耗尽抛 BudgetExhaustedError。 */
    async function withinBudget(promise, budget, signal) {
        checkAborted(signal);
        const remaining = budget.remainingMs();
        if (remaining <= 0) {
            void promise.catch(() => undefined);
            throw new BudgetExhaustedError();
        }
        let timer;
        let onAbort;
        const expire = new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(isAborted(signal) ? abortError() : new BudgetExhaustedError()), remaining);
            onAbort = () => reject(abortError());
            signal?.addEventListener("abort", onAbort, { once: true });
        });
        try {
            return await Promise.race([promise, expire]);
        }
        catch (error) {
            void promise.catch(() => undefined);
            throw error;
        }
        finally {
            clearTimeout(timer);
            if (onAbort)
                signal?.removeEventListener("abort", onAbort);
        }
    }
    /**
         * 解析凭据：只在显式授权计费后执行，且一次性并发解析全部所需后端。
         *
         * 并发是语义的一部分：串行 await 会让第一个挂起的读取直接吃掉整段预算，
         * 使其余后端从未被尝试。
         */
    async function resolveKeys(signal) {
        const providers = deps.keyProviders ?? DEFAULT_KEY_PROVIDERS;
        checkAborted(signal);
        const values = await Promise.all(providers.map(async (provider) => {
            const value = deps.resolveKey === undefined
                ? env[KEY_ENV[provider]]
                : await deps.resolveKey(provider, signal ?? new AbortController().signal);
            return [provider, value];
        }));
        checkAborted(signal);
        const keys = new Map();
        for (const [provider, value] of values) {
            if (value === undefined || value === "") {
                keys.set(provider, undefined);
                continue;
            }
            // 默认严格：只接受可打印 ASCII。Pi 宿主历史上允许粘贴带空格的密钥，
            // 通过 {@link SearchDependencies.allowWhitespaceKeys} 显式放宽。
            const pattern = deps.allowWhitespaceKeys === true ? /^[\x20-\x7e]{1,4096}$/u : /^[\x21-\x7e]{1,4096}$/u;
            if (typeof value !== "string" || !pattern.test(value))
                throw new SearchError("INVALID_KEY");
            keys.set(provider, value);
        }
        return keys;
    }
    /** 构造本次调用的候选顺序：匿名永远先于计费，显式指定时只尝试该后端。 */
    function candidatesFor(request, allowBillable) {
        const provider = request.provider ?? "auto";
        if (provider !== "auto" && !isProviderId(provider))
            throw new Error("未知的搜索 provider");
        const anonymous = provider === "auto"
            ? [...ANONYMOUS_PROVIDER_ORDER]
            : getProviderMetadata(provider).supportedTiers.includes("anonymous") ? [provider] : [];
        const billable = allowBillable
            ? provider === "auto" ? [...BILLABLE_PROVIDER_ORDER] : [provider]
            : [];
        if (!allowBillable && provider !== "auto" && anonymous.length === 0) {
            throw new Error(`${provider} 已被禁用：需要显式授权可能计费的通道`);
        }
        return [
            ...anonymous.map((backend) => ({ backend, channel: "free" })),
            ...billable.map((backend) => ({ backend, channel: "key" })),
        ];
    }
    async function searchOnce(step, request, budget, signal, controller) {
        const { backend, channel } = step;
        const credential = channel === "key" ? step.apiKey : undefined;
        const quotaChannel = channel === "free" ? "anonymous" : "key";
        let attempts = 0;
        for (let round = 0;; round++) {
            checkAborted(signal);
            if (budget.exhausted)
                throw new BudgetExhaustedError();
            const cooldown = quota.getCooldown(backend, quotaChannel, credential, settings.cooldownOverrideMs);
            if (cooldown !== undefined)
                throw new BackendError(`通道正在冷却，剩余约 ${Math.ceil(cooldown.remainingMs / 1000)} 秒；本次未发送网络请求`, "quota_preflight");
            try {
                const result = await dispatchOnce(step, request, budget, signal, controller, () => { attempts++; });
                return { ...result, attempts };
            }
            catch (error) {
                if (isAborted(signal))
                    throw abortError();
                if (error instanceof BudgetExhaustedError)
                    throw error;
                // 单请求预算与整次预算共用同一截止时间：只要已经耗尽，就不再重试后续通道。
                if (budget.exhausted)
                    throw new BudgetExhaustedError();
                // 失败也是一次真实尝试：带上次数，宿主才能正确报告 attemptCount。
                if (error instanceof BackendError) {
                    error.attempts = attempts;
                    if (Object.getOwnPropertyDescriptor(error, "detail") === undefined) {
                        Object.assign(error, { detail: { backend, channel, kind: error.kind, ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) } });
                    }
                }
                if (!(error instanceof BackendError) || !error.retryable || error.kind === "rate_limited" || round >= settings.retries)
                    throw error;
                const wait = Math.min(RETRY_MAX_WAIT_MS, Math.max(RETRY_BASE_MS * 2 ** round, error.retryAfterMs ?? 0));
                await sleep(wait, signal, budget.deadlineMs);
            }
        }
    }
    /** 单次请求：额度预检 → 发送 → 有界读体 → 解析。 */
    async function dispatchOnce(step, request, budget, signal, controller, onDispatch) {
        const { backend, channel } = step;
        const credential = channel === "key" ? step.apiKey : undefined;
        let reservation;
        let dispatched = false;
        const child = new AbortController();
        const cancelChild = () => child.abort();
        controller.signal.addEventListener("abort", cancelChild, { once: true });
        const remaining = budget.remainingMs();
        const singleWait = Math.max(1, Math.min(settings.timeoutMs, remaining));
        const budgetBound = remaining < settings.timeoutMs;
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.abort();
        }, singleWait);
        try {
            if (channel === "key" && (backend === "tavily" || backend === "firecrawl")) {
                if (credential === undefined)
                    throw new BackendError("缺少计费授权或密钥", "invalid_key");
                const balance = await quota.lookupBalance({
                    backend,
                    channel: "key",
                    credential,
                    allowBillable: true,
                    signal: child.signal,
                    maxResponseBytes: settings.maxResponseBytes,
                    // 与后续 getCooldown 使用同一个覆盖值，否则预检会被已有冷却挡住。
                    ...(settings.cooldownOverrideMs === undefined ? {} : { cooldownOverrideMs: settings.cooldownOverrideMs }),
                });
                checkAborted(signal);
                if (timedOut)
                    throw new BackendError(`${backend} 额度预检超时`, "timeout");
                if (balance.state === "unknown") {
                    if (balance.reason === "rate_limited") {
                        quota.recordFailure(backend, "key", "rate_limited", { credential, retryAfterMs: balance.retryAfterMs, ...(settings.cooldownOverrideMs === undefined ? {} : { cooldownMs: settings.cooldownOverrideMs }) });
                    }
                    throw new BackendError("额度状态未知，未发送搜索请求", "quota_preflight");
                }
                if (balance.remaining === 0) {
                    quota.recordFailure(backend, "key", "quota_exhausted", { credential, ...(settings.cooldownOverrideMs === undefined ? {} : { cooldownMs: settings.cooldownOverrideMs }) });
                    throw new BackendError("当前余额不足以支付本次搜索，未发送搜索请求", "quota_preflight");
                }
                const result = quota.reserve({ backend, channel: "key", credential, allowBillable: true, operation: "search", maxResults: request.maxResults, ...(settings.cooldownOverrideMs === undefined ? {} : { cooldownOverrideMs: settings.cooldownOverrideMs }) });
                if (result.status === "denied")
                    throw new BackendError("额度预留被拒绝，未发送搜索请求", "quota_preflight");
                reservation = result.reservation;
            }
            checkAborted(signal);
            const spec = buildSpec(step, request.query, request.maxResults);
            if (reservation !== undefined && !reservation.dispatch())
                throw new BackendError("额度预留已失效，未发送搜索请求", "quota_preflight");
            dispatched = true;
            onDispatch();
            const pending = Promise.resolve().then(() => fetcher(spec.url, {
                method: spec.method,
                headers: spec.headers,
                ...(spec.body === undefined ? {} : { body: spec.body }),
                signal: child.signal,
            }));
            void pending.catch(() => undefined);
            const response = await waitForAbort(pending, child.signal);
            if (!response.ok) {
                let detail = "";
                try {
                    const body = await readResponseTextLimited(response, settings.maxResponseBytes, child);
                    detail = errorDetailFrom(safeJson(body)) ?? "";
                }
                catch (error) {
                    if (isAborted(signal))
                        throw abortError();
                    if (timedOut)
                        throw error;
                    if (error instanceof BackendError && error.kind === "response_too_large")
                        throw error;
                }
                const kind = isApiBackend(backend) ? apiHttpKind(backend, response.status, detail) : httpKind(response.status, detail);
                throw new BackendError(`${backend} HTTP ${response.status}${detail.length === 0 ? "" : `：${detail}`}`, kind, kind === "rate_limited" ? retryAfterMs(response.headers.get("retry-after")) : undefined);
            }
            const body = await readResponseTextLimited(response, settings.maxResponseBytes, child);
            const parsed = parseResult(step, body, request.maxResults);
            quota.recordSuccess(backend, channel === "free" ? "anonymous" : "key", credential);
            return parsed;
        }
        catch (error) {
            if (isAborted(signal))
                throw abortError();
            // 两种超时必须分开处理：
            // - 通道打满的是「本次可用预算」→ 整次调用已无剩余，停止并报预算耗尽；
            // - 通道只打满单请求预算、总预算仍有余 → 切换下一家继续尝试。
            if (budget.exhausted || (timedOut && budgetBound)) {
                // 附带已尝试通道的诊断，调用方能看出预算是在哪一家耗尽的。
                const spent = new BackendError("预算耗尽", "budget_exhausted");
                Object.assign(spent, { detail: { backend, channel, kind: "budget_exhausted" } });
                throw spent;
            }
            if (timedOut)
                throw new BackendError(`${backend} timed out after ${singleWait}ms`, "timeout");
            // 未知异常保留其脱敏后的诊断：只报固定文案会让"网络错误"与"协议错误"
            // 无法区分，也不利于宿主排查。密钥遮蔽在返回前统一处理。
            // 是否把底层诊断带给调用方由宿主决定：DSH 要求公开错误不保留底层内容，
            // Pi 需要它来区分网络错误与协议错误（密钥在返回前统一遮蔽）。
            const rawDetail = deps.includeErrorDetail === true && error instanceof Error && error.message.length > 0 ? `：${error.message}` : "";
            const failure = error instanceof BackendError ? error : new BackendError(`搜索请求失败${rawDetail}`, "network_error");
            // 结构化分类供宿主更新冷却观察面；不进入对外文案。
            Object.assign(failure, { detail: { backend, channel, kind: failure.kind, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) } });
            if (dispatched) {
                if (failure.kind === "rate_limited") {
                    quota.recordFailure(backend, channel === "free" ? "anonymous" : "key", "rate_limited", { ...(credential === undefined ? {} : { credential }), ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }), ...(settings.cooldownOverrideMs === undefined ? {} : { cooldownMs: settings.cooldownOverrideMs }) });
                }
                else if (failure.kind === "quota_exhausted") {
                    quota.recordFailure(backend, channel === "free" ? "anonymous" : "key", "quota_exhausted", { ...(credential === undefined ? {} : { credential }), ...(settings.cooldownOverrideMs === undefined ? {} : { cooldownMs: settings.cooldownOverrideMs }) });
                }
            }
            throw failure;
        }
        finally {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", cancelChild);
            if (reservation !== undefined) {
                if (dispatched)
                    reservation.settle();
                else
                    reservation.release();
            }
        }
    }
    function buildSpec(step, query, numResults) {
        const { backend, channel } = step;
        if (isApiBackend(backend))
            return buildApiRequest(backend, query, numResults, channel === "key" ? step.apiKey : undefined, channel);
        const headers = { accept: "application/json, text/event-stream", "content-type": "application/json", "user-agent": USER_AGENT };
        if (backend === "parallel" && channel === "key" && step.apiKey !== undefined)
            headers.authorization = `Bearer ${step.apiKey}`;
        if (backend === "tinyfish")
            Object.assign(headers, buildTinyFishHeaders());
        const payload = backend === "exa"
            ? { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search_exa", arguments: { query, type: "auto", numResults, livecrawl: "fallback", contextMaxCharacters: 10_000 } } }
            : backend === "tinyfish"
                ? { jsonrpc: "2.0", id: 1, method: "tools/call", params: buildTinyFishPayload(query) }
                : { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search", arguments: { objective: query, search_queries: [query] } } };
        const url = backend === "exa"
            ? (channel === "key" && step.apiKey !== undefined ? `${EXA_MCP_URL}?exaApiKey=${encodeURIComponent(step.apiKey)}` : EXA_MCP_URL)
            : backend === "tinyfish" ? TINYFISH_MCP_URL : PARALLEL_MCP_URL;
        return { url, method: "POST", headers, body: JSON.stringify(payload) };
    }
    function parseResult(step, body, numResults) {
        const { backend, channel } = step;
        if (isApiBackend(backend)) {
            const sources = parseApiResponse(backend, body, numResults);
            return { text: renderSources(sources, ""), sources };
        }
        const blocks = parseMcpBlocks(body);
        if (blocks === undefined || blocks.length === 0)
            throw new BackendError(`${backend} 未返回可用结果`, "protocol_error");
        const text = blocks.join("\n\n");
        if (backend === "exa" && channel === "free" && blocks.some(isExaFreeRateLimitNotice))
            throw new BackendError(text.trim(), "quota_exhausted");
        const seen = new Set();
        const sources = blocks
            .flatMap((block) => {
            if (backend !== "tinyfish")
                return extractSources(block);
            let structured = false;
            try {
                JSON.parse(block);
                structured = true;
            }
            catch {
                // JSON 解码失败不代表服务错误可以忽略。
            }
            if (structured || /^\s*[\[{]/.test(block))
                return parseTinyFishResults(block, numResults);
            const kind = messageKind(block) ?? (/\brate_limited\b/i.test(block) ? "rate_limited" : undefined);
            if (kind !== undefined || /\bprovider_error\b/i.test(block))
                throw new BackendError(block, kind ?? "protocol_error");
            return [];
        })
            .filter((source) => {
            if (seen.has(source.url))
                return false;
            seen.add(source.url);
            return true;
        })
            .slice(0, numResults);
        if (sources.length === 0)
            throw new BackendError(`${backend} 未返回可用的搜索来源`, "protocol_error");
        return { text, sources };
    }
    async function runSearch(request, signal) {
        if (disposed)
            throw new SearchError("DISPOSED");
        if (!request || typeof request !== "object" || typeof request.query !== "string")
            throw new SearchError("INVALID_REQUEST");
        const query = request.query.trim();
        if (query.length === 0 || query.length > 2_000)
            throw new SearchError("INVALID_REQUEST");
        const maxResults = clampResults(request.maxResults);
        const budget = new TotalBudget(settings.totalTimeoutMs);
        const controller = new AbortController();
        active.add(controller);
        const forward = () => controller.abort();
        signal?.addEventListener("abort", forward, { once: true });
        if (isAborted(signal))
            controller.abort();
        try {
            checkAborted(controller.signal);
            // 状态目录不可用（未知文件、权限、平台不支持）只降级为警告，不阻断搜索。
            initializedOnce = true;
            await withinBudget(Promise.resolve().then(() => quota.initialize()), budget, controller.signal);
            checkAborted(controller.signal);
            const keys = settings.allowBillable === true ? await withinBudget(resolveKeys(controller.signal), budget, controller.signal) : new Map();
            // 展开一次全部编码形态，后续正文与来源替换都复用这一份列表。
            const secrets = settings.allowBillable === true ? expandSecrets([...keys.values()]) : [];
            const candidates = candidatesFor(request, settings.allowBillable === true);
            const failures = [];
            const warnings = [];
            let attempts = 0;
            for (const candidate of candidates) {
                checkAborted(controller.signal);
                if (budget.exhausted)
                    throw new BudgetExhaustedError();
                const apiKey = candidate.channel === "key" ? keys.get(candidate.backend) : undefined;
                if (candidate.channel === "key" && apiKey === undefined) {
                    failures.push({ label: stepLabel(candidate), kind: "missing_key", message: "未配置密钥，已跳过且未发送请求" });
                    continue;
                }
                const step = { ...candidate, ...(apiKey === undefined ? {} : { apiKey }) };
                try {
                    const result = await searchOnce(step, { query, maxResults }, budget, controller.signal, controller);
                    attempts += result.attempts;
                    checkAborted(controller.signal);
                    const text = redactSecrets(result.text, secrets);
                    const sources = result.sources.map((source) => ({
                        url: redactSecrets(source.url, secrets),
                        ...(source.title === undefined ? {} : { title: redactSecrets(source.title, secrets) }),
                        ...(source.snippet === undefined ? {} : { snippet: redactSecrets(source.snippet, secrets) }),
                        ...(source.publishedAt === undefined ? {} : { publishedAt: redactSecrets(source.publishedAt, secrets) }),
                    }));
                    // 持久化是收尾动作：写不进去只提示，不丢弃已取得的结果。
                    try {
                        await withinBudget(Promise.resolve().then(() => quota.flush()), budget, controller.signal);
                    }
                    catch (error) {
                        if (error instanceof BudgetExhaustedError || isAborted(controller.signal))
                            throw error;
                        warnings.push("QUOTA_STATE_IO_UNAVAILABLE");
                    }
                    const snapshot = quota.snapshot();
                    if (snapshot.persistence === "degraded")
                        warnings.push(snapshot.persistenceReason ?? "QUOTA_STATE_IO_UNAVAILABLE");
                    return {
                        backend: step.backend,
                        channel: step.channel,
                        accessTier: step.channel === "free" ? "anonymous" : "billable",
                        text,
                        sources,
                        attempts,
                        failures,
                        warnings,
                        quotaPersistence: snapshot.persistence,
                        truncated: result.text.length > settings.maxChars,
                    };
                }
                catch (error) {
                    checkAborted(controller.signal);
                    // 预算耗尽立即结束整次调用：不再尝试任何后续通道，也不转成"全部不可用"。
                    if (error instanceof BudgetExhaustedError)
                        throw new SearchError("BUDGET_EXHAUSTED", "[budget_exhausted]");
                    if (error instanceof BackendError && error.kind === "budget_exhausted") {
                        const where = error.detail?.backend;
                        // 带上分类标记：宿主与测试都需要能把它与普通超时区分开。
                        throw new SearchError("BUDGET_EXHAUSTED", `${where === undefined ? "" : `在 ${where} 耗尽 `}[budget_exhausted]`);
                    }
                    // 失败记录之后若预算已耗尽，本次调用必须归类为超时：
                    // 继续把后续通道计入"不可用"会掩盖真正原因。
                    if (budget.exhausted)
                        throw new BudgetExhaustedError();
                    // 失败的通道同样消耗了一次真实请求，必须计入 attemptCount。
                    attempts += error instanceof BackendError ? (error.attempts ?? 0) : 0;
                    failures.push({
                        label: stepLabel(step),
                        kind: error instanceof BackendError ? error.kind : "unknown",
                        message: redactSecrets(error instanceof BackendError ? error.message : "未知错误", secrets),
                        // 冷却时长的原始依据：宿主据此区分 Retry-After 与固定退避。
                        ...(error instanceof BackendError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
                    });
                }
            }
            const label = failures.map((failure) => `${failure.label}[${failure.kind}]: ${failure.message}`).join(" | ");
            const error = new SearchError("SEARCH_FAILED", label.length === 0 ? undefined : label);
            // 失败明细同时挂在错误上：宿主需要据此更新自己的冷却观察面，
            // 又不必重新解析文案。这里只放已脱敏的结构化字段。
            error.failures = failures;
            throw error;
        }
        catch (error) {
            if (isAborted(signal)) {
                // 取消或超时前已记录的冷却仍要落盘：不能依赖正常完成路径。
                if (initializedOnce)
                    await Promise.race([quota.flush().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 250))]);
                throw new SearchError("ABORTED");
            }
            if (disposed)
                throw new SearchError("DISPOSED");
            if (error instanceof SearchError)
                throw error;
            // 配置与凭据错误必须原样上抛：把它们折叠成"全部不可用"会让调用方
            // 无法区分"没配密钥"和"密钥非法"。
            if (error instanceof BackendError && (error.kind === "invalid_key" || error.kind === "quota_preflight")) {
                const code = error.kind === "invalid_key" ? "INVALID_KEY" : "SEARCH_FAILED";
                throw new SearchError(code);
            }
            // 预算耗尽与单请求超时都归类为超时，但保留"总预算用尽"的可辨语义。
            // 外层兜底同样带分类标记，保证任何一条预算耗尽路径都可被识别。
            if (error instanceof BudgetExhaustedError)
                throw new SearchError("BUDGET_EXHAUSTED", "[budget_exhausted]");
            if (error instanceof BackendError && error.kind === "timeout")
                throw new SearchError("TIMEOUT");
            throw new SearchError("SEARCH_FAILED");
        }
        finally {
            signal?.removeEventListener("abort", forward);
            active.delete(controller);
        }
    }
    return {
        async searchDetailed(request, signal) {
            return runSearch(request, signal);
        },
        /**
         * 与 {@link SearchEngine.searchDetailed} 相同，但正文超限时额外落盘并带回路径。
         *
         * 落盘是宿主呈现策略而不是搜索语义：DSH 直接截断，Pi 需要保留完整正文供模型
         * `read`。放进内核是为了让两个宿主共用同一条执行路径，而不是各自再写一遍编排。
         */
        async searchWithSpill(request, spill, signal) {
            const result = await runSearch(request, signal);
            if (result.text.length <= settings.maxChars)
                return result;
            try {
                const written = await spill(result.text);
                return { ...result, spillPath: written.path, spillComplete: written.complete };
            }
            catch {
                // 落盘失败不影响已经取得的结果，但必须让宿主能给出提示。
                return { ...result, spillFailed: true };
            }
        },
        async search(request, signal) {
            const result = await runSearch(request, signal);
            return buildBoundedResult(result, settings.maxChars);
        },
        async dispose() {
            if (disposed)
                return;
            disposed = true;
            for (const controller of active)
                controller.abort();
            // 从未初始化过额度状态时不写任何文件：未使用的实例关闭必须无副作用。
            if (!initializedOnce)
                return;
            let timer;
            await Promise.race([quota.flush().catch(() => "degraded"), new Promise((resolve) => { timer = setTimeout(resolve, 250); })]);
            if (timer)
                clearTimeout(timer);
        },
    };
}
/**
 * 把结果裁剪到 maxChars：来源字段与正文共同受同一字符预算。
 * 先保证至少一条可用来源，再按剩余预算填充正文；放不下时明确置 truncated。
 */
function buildBoundedResult(result, maxChars) {
    // 持久化退化时在正文里给出固定提示：调用方必须能看出冷却状态没有落盘。
    const warning = result.warnings.length === 0 ? "" : "冷却状态未能安全保存；本次仅在当前进程有效。\n";
    let remaining = maxChars - warning.length;
    let truncated = result.truncated;
    const sources = [];
    for (const raw of result.sources) {
        if (raw.url.length > remaining) {
            truncated = true;
            continue;
        }
        remaining -= raw.url.length;
        const item = { url: raw.url };
        for (const field of ["title", "snippet", "publishedAt"]) {
            const value = raw[field];
            if (value === undefined)
                continue;
            if (value.length <= remaining) {
                item[field] = value;
                remaining -= value.length;
            }
            else if (remaining > 0) {
                // 不切开代理对：末尾是高位代理时少取一个字符。
                const end = /[\uD800-\uDBFF]/u.test(value.charAt(remaining - 1)) ? remaining - 1 : remaining;
                item[field] = value.slice(0, Math.max(0, end));
                remaining = 0;
                truncated = true;
            }
            else {
                truncated = true;
            }
        }
        sources.push(item);
    }
    if (sources.length === 0)
        throw new SearchError("OUTPUT_TOO_SMALL");
    let content;
    if (remaining > 0 && result.text.length > 0) {
        content = result.text.length <= remaining ? result.text : result.text.slice(0, remaining);
        if (result.text.length > remaining)
            truncated = true;
    }
    if (warning.length > 0)
        content = warning + (content ?? "");
    return {
        ...(content === undefined || content.length === 0 ? {} : { content }),
        sources,
        truncated,
        backend: result.backend,
        accessTier: result.accessTier,
    };
}
function safeJson(body) {
    try {
        return JSON.parse(body);
    }
    catch {
        return undefined;
    }
}
/** 超时或取消时立即返回，并消费不遵守 AbortSignal 的迟到结果。 */
function waitForAbort(promise, signal) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            callback();
        };
        const onAbort = () => finish(() => reject(abortError()));
        signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve(promise).then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
        if (signal.aborted)
            onAbort();
    });
}
/** 可被外部取消与总预算同时中断的等待。 */
function sleep(ms, signal, deadlineMs) {
    return new Promise((resolve, reject) => {
        let timer;
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
        };
        const abort = () => {
            cleanup();
            reject(abortError());
        };
        const remaining = deadlineMs - performance.now();
        if (remaining <= 0) {
            reject(new BudgetExhaustedError());
            return;
        }
        timer = setTimeout(() => {
            cleanup();
            resolve();
        }, Math.min(ms, remaining));
        if (isAborted(signal))
            abort();
        else
            signal?.addEventListener("abort", abort, { once: true });
    });
}
/** 兜底来源提取：并行 JSON → Exa 分块 → 逐行扫描。 */
export function extractSources(text, maxResults = 20) {
    const fromJson = parseParallelJson(text);
    if (fromJson !== undefined && fromJson.length > 0)
        return fromJson.slice(0, maxResults);
    const seen = new Set();
    const sources = [];
    for (const block of text.split(/\r?\n(?:-{3,}|\*{3,})\r?\n/u)) {
        const source = parseExaBlock(block);
        if (source === undefined || seen.has(source.url))
            continue;
        seen.add(source.url);
        sources.push(source);
    }
    if (sources.length > 0)
        return sources.slice(0, maxResults);
    return extractSourcesByLines(text).slice(0, maxResults);
}
function parseParallelJson(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    const envelope = parsed;
    if (envelope === null || typeof envelope !== "object" || !Array.isArray(envelope.results))
        return undefined;
    const seen = new Set();
    const sources = [];
    for (const item of envelope.results) {
        if (item === null || typeof item !== "object")
            continue;
        const url = typeof item.url === "string" ? item.url : undefined;
        if (url === undefined || url.length === 0 || seen.has(url) || !isHttpUrl(url))
            continue;
        seen.add(url);
        const title = typeof item.title === "string" ? item.title.trim() : undefined;
        const excerpt = Array.isArray(item.excerpts) ? item.excerpts.find((value) => typeof value === "string" && value.trim().length > 0) : undefined;
        const publishedAt = typeof item.publish_date === "string" && item.publish_date.length > 0 ? item.publish_date : undefined;
        sources.push({
            url,
            ...(title === undefined || title.length === 0 ? {} : { title }),
            ...(excerpt === undefined ? {} : { snippet: excerpt.trim() }),
            ...(publishedAt === undefined ? {} : { publishedAt }),
        });
    }
    return sources;
}
function parseExaBlock(block) {
    let title;
    let url;
    let snippet;
    let inHighlights = false;
    for (const line of block.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0)
            continue;
        if (trimmed.startsWith("Title:")) {
            title = trimmed.slice("Title:".length).replace(/^\s*(?:\d+[.)]?|[-*•])\s*/u, "").replace(/^title:\s*/iu, "").trim();
            continue;
        }
        if (trimmed.startsWith("URL:")) {
            url = trimmed.slice("URL:".length).trim();
            continue;
        }
        if (trimmed.startsWith("Highlights:")) {
            inHighlights = true;
            continue;
        }
        if (inHighlights && snippet === undefined) {
            const candidate = trimmed.replace(/^(?:content|snippet|excerpt):\s*/iu, "").replace(/^###\s*/u, "").trim();
            if (candidate.length > 0 && !/^\.{3,}$/u.test(candidate))
                snippet = candidate;
        }
    }
    if (url === undefined || !isHttpUrl(url))
        return undefined;
    return {
        url,
        ...(title === undefined || title.length === 0 ? {} : { title }),
        ...(snippet === undefined ? {} : { snippet }),
    };
}
function extractSourcesByLines(text) {
    const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    const seen = new Set();
    const sources = [];
    const isUrlLine = (line) => line === undefined || line.length === 0 || /^(?:url|link|source):/iu.test(line) || /^https?:\/\//u.test(line);
    for (let index = 0; index < lines.length; index++) {
        const matches = lines[index].matchAll(/https?:\/\/[^\s<>()"'\]`]+/gu);
        for (const match of matches) {
            const url = match[0].replace(/[.,;:!?)\]]+$/u, "");
            if (seen.has(url) || !isHttpUrl(url))
                continue;
            seen.add(url);
            const previous = index > 0 ? lines[index - 1] : undefined;
            const next = index + 1 < lines.length ? lines[index + 1] : undefined;
            const title = isUrlLine(previous) ? undefined : previous;
            const snippet = isUrlLine(next) ? undefined : next;
            sources.push({
                url,
                ...(title === undefined ? {} : { title }),
                ...(snippet === undefined ? {} : { snippet }),
            });
        }
    }
    return sources;
}
