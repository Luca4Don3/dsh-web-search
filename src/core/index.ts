/** DSH 独立免费优先搜索核心；不访问宿主凭据或用户配置。 */
import { Agent, fetch as undiciFetch } from "undici";
import { isAbsolute } from "node:path";
import type { ProviderId, SearchDependencies, SearchEngine, SearchOptions, SearchRequest, SearchResult, SearchSource } from "../contracts.js";
import { DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES, CoreFault, readResponseTextLimited } from "./body.js";
import { QuotaManager, parseUsageBody, safeRetryAfter } from "./quota.js";
import { buildRequest, classifyHttp, errorDetail, mapCoreFault, parseProviderResponse, ProviderFault, type FailureKind, type RequestSpec } from "./protocol.js";

export { readResponseTextLimited, DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES } from "./body.js";
export { parseMcpResponse } from "./protocol.js";

const ANONYMOUS_ORDER: readonly ProviderId[] = ["exa", "tavily", "parallel", "firecrawl", "tinyfish"];
const BILLABLE_ORDER: readonly Exclude<ProviderId, "tinyfish">[] = ["exa", "tavily", "parallel", "firecrawl"];
const KEY_ENV: Readonly<Record<Exclude<ProviderId, "tinyfish">, string>> = {
  exa: "EXA_API_KEY", tavily: "TAVILY_API_KEY", parallel: "PARALLEL_API_KEY", firecrawl: "FIRECRAWL_API_KEY",
};
const KEY_PATTERN = /^[\x21-\x7e]{1,4096}$/u;
const SAFE_MESSAGES: Readonly<Record<string, string>> = {
  INVALID_CONFIG: "搜索配置无效", INVALID_REQUEST: "搜索请求无效", SEARCH_FAILED: "所有搜索通道均不可用",
  TIMEOUT: "搜索超时", ABORTED: "搜索已取消", DISPOSED: "搜索引擎已关闭",
  KEY_RESOLUTION_FAILED: "无法安全读取计费密钥", INVALID_KEY: "计费密钥格式不安全",
  OUTPUT_TOO_SMALL: "输出预算不足以保留有效来源",
};

/** 对外错误只包含固定中文诊断与稳定代码，不保留上游异常或因果链。 */
export class SearchError extends Error {
  readonly code: string;
  constructor(code: string) {
    const safeCode = Object.hasOwn(SAFE_MESSAGES, code) ? code : "SEARCH_FAILED";
    super(SAFE_MESSAGES[safeCode]!);
    this.name = "SearchError";
    this.code = safeCode;
  }
}

interface Settings {
  allowBillable: boolean; timeoutMs: number; maxResponseBytes: number; maxChars: number; retries: number; cooldownOverrideMs?: number; stateDirectory?: string;
}
interface Context {
  controller: AbortController; signal: AbortSignal; deadline: number; failure?: "TIMEOUT" | "ABORTED" | "DISPOSED";
  check(): void; abort(code: "TIMEOUT" | "ABORTED" | "DISPOSED"): void;
}
interface KeyRecord { value?: string; valid: boolean; }
interface Outcome { backend: ProviderId; tier: "anonymous" | "billable"; content?: string; sources: SearchSource[]; truncated: boolean; }

function validateOptions(options: SearchOptions): Settings {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new SearchError("INVALID_CONFIG");
  const int = (value: number | undefined, fallback: number, min: number, max: number): number => {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < min || result > max) throw new SearchError("INVALID_CONFIG");
    return result;
  };
  if (options.allowBillable !== undefined && typeof options.allowBillable !== "boolean") throw new SearchError("INVALID_CONFIG");
  const timeoutMs = int(options.timeoutMs, 25_000, 1, 60_000);
  const maxResponseBytes = int(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1, MAX_RESPONSE_BYTES);
  const maxChars = int(options.maxChars, 24_000, 1, 200_000);
  const retries = int(options.retries, 1, 0, 1);
  if (options.cooldownOverrideMs !== undefined && (!Number.isSafeInteger(options.cooldownOverrideMs) || options.cooldownOverrideMs < 0 || options.cooldownOverrideMs > 86_400_000)) throw new SearchError("INVALID_CONFIG");
  if (options.stateDirectory !== undefined && (typeof options.stateDirectory !== "string" || options.stateDirectory.length === 0 || !isAbsolute(options.stateDirectory))) throw new SearchError("INVALID_CONFIG");
  return { allowBillable: options.allowBillable ?? false, timeoutMs, maxResponseBytes, maxChars, retries,
    ...(options.cooldownOverrideMs === undefined ? {} : { cooldownOverrideMs: options.cooldownOverrideMs }),
    ...(options.stateDirectory === undefined ? {} : { stateDirectory: options.stateDirectory }) };
}
function validateRequest(request: SearchRequest): { query: string; maxResults: number } {
  if (!request || typeof request !== "object" || typeof request.query !== "string") throw new SearchError("INVALID_REQUEST");
  const query = request.query.trim();
  if (!query || query.length > 2_000) throw new SearchError("INVALID_REQUEST");
  const maxResults = request.maxResults ?? 8;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 20) throw new SearchError("INVALID_REQUEST");
  return { query, maxResults };
}
function createContext(timeoutMs: number, signal: AbortSignal | undefined, isDisposed: () => boolean): { context: Context; clear(): void } {
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  const context: Context = {
    controller, signal: controller.signal, deadline,
    abort(code) { if (!context.failure) { context.failure = code; controller.abort(); } },
    check() {
      if (context.failure) throw new CoreFault(context.failure === "TIMEOUT" ? "timeout" : "aborted");
      if (isDisposed()) { context.abort("DISPOSED"); throw new CoreFault("aborted"); }
      if (performance.now() >= deadline) { context.abort("TIMEOUT"); throw new CoreFault("timeout"); }
      if (signal?.aborted) { context.abort("ABORTED"); throw new CoreFault("aborted"); }
    },
  };
  const onAbort = (): void => context.abort("ABORTED");
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => context.abort("TIMEOUT"), timeoutMs);
  if (signal?.aborted) context.abort("ABORTED");
  return { context, clear: () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); } };
}
function raceSignal<T>(promise: PromiseLike<T> | T, signal: AbortSignal, fault: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => { if (settled) return; settled = true; signal.removeEventListener("abort", abort); fn(); };
    const abort = (): void => finish(() => reject(fault()));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
    if (signal.aborted) abort();
  });
}
function contextFault(context: Context): CoreFault {
  return new CoreFault(context.failure === "TIMEOUT" ? "timeout" : "aborted");
}
function safeKey(value: unknown): KeyRecord {
  if (value === undefined || value === "") return { valid: true };
  return typeof value === "string" ? { value, valid: KEY_PATTERN.test(value) } : { valid: false };
}
async function resolveKeys(context: Context, deps: SearchDependencies): Promise<Map<Exclude<ProviderId, "tinyfish">, KeyRecord>> {
  context.check();
  const providers = Object.keys(KEY_ENV) as Array<Exclude<ProviderId, "tinyfish">>;
  const records = new Map<Exclude<ProviderId, "tinyfish">, KeyRecord>();
  if (deps.resolveKey) {
    const pending = providers.map((provider) => Promise.resolve().then(() => { context.check(); return deps.resolveKey!(provider, context.signal); }));
    const settled = await raceSignal(Promise.allSettled(pending), context.signal, () => contextFault(context));
    context.check();
    for (let index = 0; index < providers.length; index++) {
      const result = settled[index]!;
      if (result.status === "rejected") throw new SearchError("KEY_RESOLUTION_FAILED");
      records.set(providers[index]!, safeKey(result.value));
    }
  } else {
    const env = deps.env ?? process.env;
    for (const provider of providers) {
      context.check();
      records.set(provider, safeKey(env[KEY_ENV[provider]]));
    }
  }
  if ([...records.values()].some((record) => !record.valid)) throw new SearchError("INVALID_KEY");
  return records;
}
function secretVariants(records: Map<Exclude<ProviderId, "tinyfish">, KeyRecord>): string[] {
  const values = new Set<string>();
  for (const record of records.values()) {
    const key = record.value;
    if (!key) continue;
    values.add(key);
    values.add(JSON.stringify(key).slice(1, -1));
    const encoded = encodeURIComponent(key);
    values.add(encoded);
    values.add(encodeURIComponent(encoded));
    values.add(encoded.replace(/%[0-9A-F]{2}/gu, (part) => part.toLowerCase()));
    const uri = encodeURI(key);
    values.add(uri);
    values.add(uri.replace(/%[0-9A-F]{2}/gu, (part) => part.toLowerCase()));
    values.add(Buffer.from(key, "utf8").toString("base64"));
    values.add(Buffer.from(key, "utf8").toString("base64url"));
  }
  return [...values].filter(Boolean).sort((a, b) => b.length - a.length);
}
function redact(value: string, secrets: readonly string[]): string {
  let safe = value;
  for (const secret of secrets) safe = safe.split(secret).join("[已隐藏]");
  return safe;
}
function abortBody(response: Response): void {
  try { const pending = response.body?.cancel(); if (pending) void Promise.resolve(pending).catch(() => undefined); } catch { /* 忽略清理异常。 */ }
}
function retryAfter(headers: Headers): number | undefined { return safeRetryAfter(headers.get("retry-after")); }
function apiFailure(status: number, body: string, headers: Headers): ProviderFault {
  const kind = classifyHttp(status, errorDetail(body));
  return new ProviderFault(kind, retryAfter(headers));
}
function sourceField(value: string | undefined, budget: number): { value?: string; used: number; cut: boolean } {
  if (value === undefined || budget <= 0) return { used: 0, cut: value !== undefined };
  if (value.length <= budget) return { value, used: value.length, cut: false };
  const end = /[\uD800-\uDBFF]/u.test(value.charAt(budget - 1)) ? budget - 1 : budget;
  return { value: value.slice(0, end), used: end, cut: true };
}
function buildResult(outcome: Outcome, maxChars: number, secrets: string[], warning?: string): SearchResult {
  let remaining = maxChars - (warning?.length ?? 0);
  let truncated = outcome.truncated;
  const sources: SearchSource[] = [];
  for (const raw of outcome.sources) {
    const url = redact(raw.url, secrets);
    if (!/^https?:\/\//iu.test(url) || url.length > remaining) { truncated = true; continue; }
    remaining -= url.length;
    const item: { url: string; title?: string; snippet?: string; publishedAt?: string } = { url };
    for (const field of ["title", "snippet", "publishedAt"] as const) {
      const rawValue = raw[field];
      if (rawValue === undefined) continue;
      const fitted = sourceField(redact(rawValue, secrets), remaining);
      if (fitted.value !== undefined && fitted.value.length > 0) { item[field] = fitted.value; remaining -= fitted.used; }
      truncated ||= fitted.cut;
    }
    sources.push(item);
  }
  if (sources.length === 0) throw new SearchError("OUTPUT_TOO_SMALL");
  let content = outcome.content === undefined ? "" : redact(outcome.content, secrets);
  remaining += warning?.length ?? 0;
  const prefix = warning ? warning : "";
  if (prefix) {
    const fitted = sourceField(prefix, remaining);
    content = fitted.value ?? "";
    remaining -= fitted.used;
    truncated ||= fitted.cut;
    if (outcome.content && remaining > 0) {
      const separator = content && remaining > 0 ? "\n" : "";
      const room = Math.max(0, remaining - separator.length);
      const fittedPart = sourceField(redact(outcome.content, secrets), room);
      content += separator + (fittedPart.value ?? "");
      truncated ||= fittedPart.cut;
    } else if (outcome.content) truncated = true;
  } else {
    const fitted = sourceField(content, remaining);
    content = fitted.value ?? "";
    truncated ||= fitted.cut;
  }
  return { ...(content ? { content } : {}), sources, truncated, backend: outcome.backend, accessTier: outcome.tier };
}

/** 构造独立搜索引擎；生产网络使用本实例私有的 undici Agent。 */
export function createSearchEngine(options: SearchOptions = {}, deps: SearchDependencies = {}): SearchEngine {
  const settings = validateOptions(options);
  let disposed = false;
  const active = new Set<Context>();
  const quota = new QuotaManager(options, deps);
  const privateAgent = deps.fetch ? undefined : new Agent({ connections: 8, pipelining: 1 });
  const fetcher = deps.fetch ?? (undiciFetch as unknown as typeof globalThis.fetch);

  const wait = <T>(promise: PromiseLike<T> | T, context: Context): Promise<T> => raceSignal(promise, context.signal, () => contextFault(context));
  const childController = (context: Context): { controller: AbortController; clean(): void } => {
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    context.signal.addEventListener("abort", cancel, { once: true });
    if (context.signal.aborted) controller.abort();
    return { controller, clean: () => context.signal.removeEventListener("abort", cancel) };
  };

  async function fetchAndRead(spec: RequestSpec, context: Context, headers = spec.headers, onDispatch?: () => void): Promise<{ response: Response; body: string }> {
    context.check();
    const child = childController(context);
    try {
      const init = { method: "POST", headers, body: spec.body, signal: child.controller.signal, redirect: "error" } as RequestInit & { dispatcher?: Agent };
      if (privateAgent) init.dispatcher = privateAgent;
      let raw: Promise<Response>;
      try {
        context.check();
        onDispatch?.();
        raw = Promise.resolve(fetcher(spec.url, init));
      } catch (error) {
        if (error instanceof ProviderFault) throw error;
        if (context.failure) throw contextFault(context);
        throw new ProviderFault("network");
      }
      const pending = raw.then((response) => {
        if (child.controller.signal.aborted) abortBody(response);
        return response;
      });
      void pending.catch(() => undefined);
      let response: Response;
      try { response = await wait(pending, context); }
      catch (error) { if (context.failure) throw contextFault(context); throw new ProviderFault("network"); }
      context.check();
      if (!response.ok) {
        let body = "";
        try { body = await readResponseTextLimited(response, settings.maxResponseBytes, child.controller.signal, () => child.controller.abort()); }
        catch (error) {
          if (context.failure) throw contextFault(context);
          if (error instanceof CoreFault && error.kind === "too_large") throw new ProviderFault("too_large");
          // 读取失败不盖过可信 HTTP 状态；仅体积超限优先。
        }
        context.check();
        throw apiFailure(response.status, body, response.headers);
      }
      const body = await readResponseTextLimited(response, settings.maxResponseBytes, child.controller.signal, () => child.controller.abort());
      context.check();
      return { response, body };
    } finally { child.controller.abort(); child.clean(); }
  }

  async function usageLookup(backend: "tavily" | "firecrawl", key: string, signal: AbortSignal): Promise<{ known: true; remaining: number } | { known: false; retryAfter?: number }> {
    const { context, clear } = createContext(Math.min(settings.timeoutMs, 2_000), signal, () => disposed);
    const url = backend === "tavily" ? "https://api.tavily.com/usage" : "https://api.firecrawl.dev/v2/team/credit-usage";
    const child = childController(context);
    try {
      context.check();
      const init = { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${key}` }, signal: child.controller.signal, redirect: "error" } as RequestInit & { dispatcher?: Agent };
      if (privateAgent) init.dispatcher = privateAgent;
      let pending: Promise<Response>;
      try { pending = Promise.resolve(fetcher(url, init)); } catch { return { known: false }; }
      pending = pending.then((response) => { if (child.controller.signal.aborted) abortBody(response); return response; });
      void pending.catch(() => undefined);
      let response: Response;
      try { response = await wait(pending, context); } catch (error) { if (context.failure) throw contextFault(context); return { known: false }; }
      context.check();
      if (response.status === 429) {
        try { await readResponseTextLimited(response, settings.maxResponseBytes, child.controller.signal, () => child.controller.abort()); } catch (error) {
          if (context.failure) throw contextFault(context);
          if (error instanceof CoreFault && error.kind === "too_large") return { known: false };
        }
        return { known: false, retryAfter: retryAfter(response.headers) };
      }
      if (!response.ok) { abortBody(response); return { known: false }; }
      const body = await readResponseTextLimited(response, settings.maxResponseBytes, child.controller.signal, () => child.controller.abort());
      context.check();
      return parseUsageBody(backend, body);
    } catch { return { known: false }; }
    finally { child.controller.abort(); child.clean(); clear(); }
  }

  async function attempt(provider: ProviderId, query: string, maxResults: number, tier: "anonymous" | "billable", key: string | undefined,
    context: Context): Promise<Outcome> {
    let reservation: ReturnType<QuotaManager["reserve"]> = undefined;
    let dispatched = false;
    const backend = provider;
    if (quota.cooldown(backend, tier === "anonymous" ? "anonymous" : "key", key, settings.cooldownOverrideMs)) throw new ProviderFault("rate");
    if (tier === "billable" && (provider === "tavily" || provider === "firecrawl")) {
      const balance = await quota.balance(provider, key!, context.signal, (service, credential, signal) => usageLookup(service, credential, signal), settings.cooldownOverrideMs);
      context.check();
      if (!balance.known) {
        if (balance.retryAfter !== undefined) quota.recordFailure(provider, "key", key, "rate_limited", balance.retryAfter, settings.cooldownOverrideMs);
        throw new ProviderFault("invalid_key");
      }
      if (balance.remaining === 0) throw new ProviderFault("exhausted");
      reservation = quota.reserve(provider, key!, maxResults, settings.cooldownOverrideMs);
      if (!reservation) throw new ProviderFault("invalid_key");
    }
    try {
      context.check();
      if (quota.cooldown(backend, tier === "anonymous" ? "anonymous" : "key", key, settings.cooldownOverrideMs)) throw new ProviderFault("rate");
      const spec = buildRequest(provider, query, maxResults, tier === "billable" ? key : undefined);
      const { response, body } = await fetchAndRead(spec, context, spec.headers, () => {
        if (reservation && !reservation.dispatch()) throw new ProviderFault("invalid_key");
        dispatched = true;
      });
      context.check();
      let parsed;
      try { parsed = parseProviderResponse(provider, body, maxResults); }
      catch (error) {
        if (error instanceof ProviderFault) throw error;
        throw new ProviderFault("protocol");
      }
      context.check();
      quota.recordSuccess(provider, tier === "anonymous" ? "anonymous" : "key", key);
      return { backend: provider, tier, sources: parsed.sources, ...(parsed.content === undefined ? {} : { content: parsed.content }), truncated: parsed.truncated ?? false };
    } catch (error) {
      if (context.failure) throw contextFault(context);
      const kind = error instanceof ProviderFault ? error.kind : mapCoreFault(error);
      if (dispatched && (kind === "rate" || kind === "exhausted")) {
        quota.recordFailure(provider, tier === "anonymous" ? "anonymous" : "key", key, kind === "rate" ? "rate_limited" : "quota_exhausted",
          error instanceof ProviderFault ? error.retryAfter : undefined, settings.cooldownOverrideMs);
      }
      throw error instanceof ProviderFault ? error : new ProviderFault(kind);
    } finally {
      if (reservation) { if (dispatched) reservation.settle(); else reservation.release(); }
    }
  }

  async function search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult> {
    if (disposed) throw new SearchError("DISPOSED");
    const { query, maxResults } = validateRequest(request);
    const { context, clear } = createContext(settings.timeoutMs, signal, () => disposed);
    active.add(context);
    try {
      context.check();
      await wait(quota.initialize(context.signal), context);
      context.check();
      const keys = settings.allowBillable ? await resolveKeys(context, deps) : new Map<Exclude<ProviderId, "tinyfish">, KeyRecord>();
      const secrets = settings.allowBillable ? secretVariants(keys) : [];
      let outcome: Outcome | undefined;
      let lastError: unknown;
      for (const provider of ANONYMOUS_ORDER) {
        context.check();
        try {
          outcome = await retryChannel(provider, query, maxResults, "anonymous", undefined, context);
          break;
        } catch (error) {
          if (context.failure) throw contextFault(context);
          lastError = error;
        }
      }
      if (!outcome && settings.allowBillable) {
        for (const provider of BILLABLE_ORDER) {
          const key = keys.get(provider)?.value;
          if (!key) continue;
          context.check();
          try {
            outcome = await retryChannel(provider, query, maxResults, "billable", key, context);
            break;
          } catch (error) {
            if (context.failure) throw contextFault(context);
            lastError = error;
          }
        }
      }
      context.check();
      const flush = await wait(quota.flush(context.signal), context);
      context.check();
      if (!outcome) throw new SearchError("SEARCH_FAILED");
      const warning = quota.warning ?? (flush === "degraded" ? "冷却状态未能安全保存；本次仅在当前进程有效。" : undefined);
      return buildResult(outcome, settings.maxChars, secrets, warning);
    } catch (error) {
      if (error instanceof SearchError) throw error;
      if (context.failure === "TIMEOUT" || error instanceof CoreFault && error.kind === "timeout") throw new SearchError("TIMEOUT");
      if (context.failure === "DISPOSED" || disposed) throw new SearchError("DISPOSED");
      if (context.failure === "ABORTED" || signal?.aborted || error instanceof CoreFault && error.kind === "aborted") throw new SearchError("ABORTED");
      throw new SearchError("SEARCH_FAILED");
    } finally { clear(); active.delete(context); }
  }

  async function retryChannel(provider: ProviderId, query: string, maxResults: number, tier: "anonymous" | "billable", key: string | undefined, context: Context): Promise<Outcome> {
    for (let round = 0; ; round++) {
      context.check();
      try { return await attempt(provider, query, maxResults, tier, key, context); }
      catch (error) {
        if (context.failure) throw contextFault(context);
        if (!(error instanceof ProviderFault) || (error.kind !== "network" && error.kind !== "server") || round >= settings.retries) throw error;
        const delay = Math.min(5_000, error.retryAfter ?? 100 * 2 ** round);
        context.check();
        await new Promise<void>((resolve, reject) => {
          const finish = (): void => { clearTimeout(timer); context.signal.removeEventListener("abort", abort); };
          const timer = setTimeout(() => { finish(); resolve(); }, delay);
          const abort = (): void => { finish(); reject(contextFault(context)); };
          context.signal.addEventListener("abort", abort, { once: true });
          if (context.signal.aborted) abort();
        });
        context.check();
      }
    }
  }

  return {
    search,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      for (const context of active) context.abort("DISPOSED");
      quota.dispose();
      try { void privateAgent?.destroy().catch(() => undefined); } catch { /* 仅销毁本实例网络客户端。 */ }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([quota.flush().catch(() => "degraded" as const), new Promise<void>((resolve) => { timer = setTimeout(resolve, 250); })]);
      if (timer) clearTimeout(timer);
    },
  };
}
