/** 同实例额度缓存、独立消费者刷新、保守预留与私有冷却状态。 */
import { createHmac, randomBytes } from "node:crypto";
import { createPrivateStateStore, type QuotaState, type StateBackend, type StateChannel, type StateEntry, type StateReason, type StateStore } from "./state.js";
import { CoreFault } from "./body.js";
import type { SearchDependencies, SearchOptions } from "../search/contracts.js";

const RATE_STEPS = [60_000, 120_000, 300_000, 600_000, 1_800_000] as const;
const EXHAUST_STEPS = [1_800_000, 3_600_000, 7_200_000, 14_400_000] as const;
const BALANCE_TTL = 300_000;
const FAILURE_TTL = 30_000;
const MAX_COOLDOWN = 86_400_000;
const MAX_SCOPES = 256;
const MAX_ENTRIES = 512;
type Balance = { known: true; remaining: number } | { known: false; retryAfter?: number };
type Reservation = { cost: number; dispatch(): boolean; release(): void; settle(): void };
type Lookup = (backend: "tavily" | "firecrawl", key: string, signal: AbortSignal) => Promise<Balance>;
interface Flight { promise: Promise<Balance>; controller: AbortController; consumers: number; abandoned: boolean; settled: boolean; }
interface Initialization { promise: Promise<void>; controller: AbortController; consumers: number; settled: boolean; }
type PersistenceResult = "saved" | "memory_only" | "degraded";
interface Writer { promise: Promise<PersistenceResult>; controller: AbortController; }
type Mutation = { backend: StateBackend; channel: StateChannel; key?: string; at: number } &
  ({ kind: "failure"; reason: StateReason; retryAfter?: number; override?: number } | { kind: "success" });
const WRITE_BUDGET_MS = 1_000;

export function safeRetryAfter(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const number = Number(value.trim());
  const date = Date.parse(value);
  const ms = Number.isFinite(number) && number >= 0 ? Math.ceil(number * 1000) : Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
  return ms === undefined ? undefined : Math.min(ms, MAX_COOLDOWN);
}
function validCredit(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
export function parseUsageBody(backend: "tavily" | "firecrawl", text: string): Balance {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { known: false }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { known: false };
  const row = value as Record<string, any>;
  if (backend === "firecrawl") {
    const remaining = row.data?.remainingCredits;
    return row.success === true && validCredit(remaining) ? { known: true, remaining } : { known: false };
  }
  const { key, account } = row;
  if (!key || typeof key !== "object" || Array.isArray(key) || !account || typeof account !== "object" || Array.isArray(account)) return { known: false };
  if (![account.plan_usage, account.plan_limit, account.paygo_usage, account.paygo_limit].every(validCredit)) return { known: false };
  const total = Math.max(0, account.plan_limit - account.plan_usage) + Math.max(0, account.paygo_limit - account.paygo_usage);
  if (!Number.isSafeInteger(total)) return { known: false };
  if (key.limit === null) return { known: true, remaining: total };
  if (!validCredit(key.usage) || !validCredit(key.limit)) return { known: false };
  return { known: true, remaining: Math.min(total, Math.max(0, key.limit - key.usage)) };
}

/** 余额与预留只在当前实例内有效，不提供跨账户或跨进程账单硬限制。 */
export class QuotaManager {
  private salt = randomBytes(32);
  private records = new Map<string, StateEntry>();
  private balances = new Map<string, { value: Balance; expires: number }>();
  private ledgers = new Map<string, { observed: number; debited: number; held: Map<symbol, { cost: number; dispatched: boolean }> }>();
  private flights = new Map<string, Flight>();
  private initialization?: Initialization;
  private initialized: boolean;
  private initializationUnavailable = false;
  private unsupportedPlatform = false;
  private pendingMutations: Mutation[] = [];
  private persistence: "memory_only" | "persistent" | "degraded";
  private revision = 0;
  private persistedRevision = 0;
  private capacityReached = false;
  private closed = false;
  private writer?: Writer;
  private writeScheduled = false;
  private readonly store?: StateStore;
  private readonly now: () => number;

  constructor(options: SearchOptions, deps: SearchDependencies, store?: StateStore) {
    this.now = deps.clock ?? Date.now;
    this.store = store ?? (options.stateDirectory === undefined ? undefined : createPrivateStateStore(options.stateDirectory));
    this.persistence = this.store ? "persistent" : "memory_only";
    this.initialized = this.store === undefined;
  }
  private scope(backend: StateBackend, channel: StateChannel, key?: string): string {
    return createHmac("sha256", this.salt).update(JSON.stringify([backend, channel, channel === "key" ? key : null])).digest("hex");
  }
  async initialize(signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (signal.aborted) throw new CoreFault("aborted");
    if (this.initialized) return;
    let flight = this.initialization;
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController();
      const job: Initialization = { promise: Promise.resolve(), controller, consumers: 0, settled: false };
      const pending = Promise.resolve().then(async () => {
        if (controller.signal.aborted) throw new CoreFault("aborted");
        const loaded = await this.store!.load(controller.signal);
        if (controller.signal.aborted || this.initialization !== job || loaded.status === "cancelled") throw new CoreFault("aborted");
        if (loaded.status === "ok") {
          this.salt = Buffer.from(loaded.state.salt, "base64");
          this.records = new Map(loaded.state.entries.map((entry) => [`${entry.scope}:${entry.backend}:${entry.channel}:${entry.reason}`, entry]));
          // 盐值确定前只暂存有界内存事件；恢复后按原时间重放，绝不落盘密钥。
          const revision = this.revision;
          for (const mutation of this.pendingMutations) this.applyMutation(mutation);
          this.revision = revision;
          this.persistence = "persistent";
        } else {
          this.initializationUnavailable = true;
          this.unsupportedPlatform = loaded.status === "unavailable" && loaded.reason === "unsupported_platform";
          this.persistence = "degraded";
        }
        this.pendingMutations = [];
        this.initialized = true;
      });
      job.promise = this.waitFor(pending, controller.signal).catch((error) => {
        if (controller.signal.aborted || error instanceof CoreFault && error.kind === "aborted") throw new CoreFault("aborted");
        if (this.initialization === job) {
          this.initializationUnavailable = true; this.persistence = "degraded";
          this.pendingMutations = []; this.initialized = true;
        }
      }).finally(() => {
        job.settled = true;
        if (this.initialization === job) this.initialization = undefined;
      });
      this.initialization = job; flight = job;
    }
    flight.consumers++;
    try { await this.waitFor(flight.promise, signal); }
    finally {
      flight.consumers--;
      if (flight.consumers === 0 && !flight.settled) {
        flight.controller.abort();
        if (this.initialization === flight) this.initialization = undefined;
      }
    }
  }
  cooldown(backend: StateBackend, channel: StateChannel, key: string | undefined, override?: number): StateReason | undefined {
    if (this.capacityReached) return "rate_limited";
    if (override === 0) return undefined;
    const id = this.scope(backend, channel, key);
    for (const reason of ["rate_limited", "quota_exhausted"] as const) {
      const entry = this.records.get(`${id}:${backend}:${channel}:${reason}`);
      if (entry && !entry.cleared && entry.until > this.now()) return reason;
    }
    return undefined;
  }
  private remember(mutation: Mutation): boolean {
    if (this.closed) return false;
    if (this.store && !this.initialized) {
      if (this.pendingMutations.length >= MAX_ENTRIES) { this.capacityReached = true; this.persistence = "degraded"; return false; }
      this.pendingMutations.push(mutation);
    }
    return true;
  }
  private applyMutation(mutation: Mutation): void {
    const { backend, channel, key, at: now } = mutation;
    const id = this.scope(backend, channel, key);
    if (mutation.kind === "success") {
      for (const reason of ["rate_limited", "quota_exhausted"] as const) {
        const k = `${id}:${backend}:${channel}:${reason}`;
        const old = this.records.get(k);
        if (old && !old.cleared && old.updatedAt <= now) {
          this.records.set(k, { ...old, cleared: true, failures: 0, until: now, updatedAt: now });
          this.revision++;
        }
      }
      return;
    }
    const { reason, override, retryAfter } = mutation;
    const k = `${id}:${backend}:${channel}:${reason}`;
    if (!this.records.has(k) && this.records.size >= MAX_ENTRIES) {
      for (const [oldKey, entry] of this.records) if (entry.cleared || entry.until <= now) this.records.delete(oldKey);
      if (this.records.size >= MAX_ENTRIES) { this.capacityReached = true; this.persistence = "degraded"; return; }
    }
    const previous = this.records.get(k);
    const failures = Math.min(1_000_000, (previous && !previous.cleared && now - previous.lastAt < 90 * MAX_COOLDOWN ? previous.failures : 0) + 1);
    const ladder = reason === "rate_limited" ? RATE_STEPS : EXHAUST_STEPS;
    const duration = override ?? (retryAfter === undefined ? ladder[Math.min(failures - 1, ladder.length - 1)]! : Math.min(retryAfter, MAX_COOLDOWN));
    this.records.set(k, { scope: id, backend, channel, reason, failures,
      until: Math.max(now + Math.max(0, Math.min(duration, MAX_COOLDOWN)), previous && !previous.cleared ? previous.until : 0),
      lastAt: Math.max(now, previous?.lastAt ?? 0), updatedAt: Math.max(now, previous?.updatedAt ?? 0) });
    this.revision++;
  }
  recordFailure(backend: StateBackend, channel: StateChannel, key: string | undefined, reason: StateReason, retryAfter?: number, override?: number): void {
    const mutation: Mutation = { kind: "failure", backend, channel, key, reason, retryAfter, override, at: this.now() };
    if (this.remember(mutation)) { this.applyMutation(mutation); this.schedulePersistence(); }
  }
  recordSuccess(backend: StateBackend, channel: StateChannel, key: string | undefined): void {
    const mutation: Mutation = { kind: "success", backend, channel, key, at: this.now() };
    const revision = this.revision;
    if (this.remember(mutation)) {
      this.applyMutation(mutation);
      if (this.store && !this.initialized && this.revision === revision) this.revision++;
      this.schedulePersistence();
    }
  }
  private waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => { if (settled) return; settled = true; signal.removeEventListener("abort", abort); fn(); };
      const abort = (): void => finish(() => reject(new CoreFault("aborted")));
      signal.addEventListener("abort", abort, { once: true });
      promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
      if (signal.aborted) abort();
    });
  }
  async balance(backend: "tavily" | "firecrawl", key: string, signal: AbortSignal, lookup: Lookup, override?: number): Promise<Balance> {
    if (signal.aborted || this.closed) throw new CoreFault("aborted");
    await this.initialize(signal);
    if (signal.aborted || this.closed) throw new CoreFault("aborted");
    const id = this.scope(backend, "key", key);
    const cached = this.balances.get(id);
    if (cached && cached.expires > this.now()) return cached.value;
    let flight = this.flights.get(id);
    if (!flight) {
      for (const [scope, entry] of this.balances) if (entry.expires <= this.now() && !this.ledgers.get(scope)?.held.size) {
        this.balances.delete(scope); this.ledgers.delete(scope);
      }
      if (!this.balances.has(id) && this.balances.size + this.flights.size >= MAX_SCOPES) return { known: false };
      const controller = new AbortController();
      const job: Flight = { promise: Promise.resolve({ known: false }), controller, consumers: 0, abandoned: false, settled: false };
      const timer = setTimeout(() => controller.abort(), 2_000);
      const pending = Promise.resolve().then(() => { if (controller.signal.aborted) throw new CoreFault("aborted"); return lookup(backend, key, controller.signal); });
      job.promise = this.waitFor(pending, controller.signal).catch(() => ({ known: false } as Balance)).then((candidate) => {
        if (job.abandoned || this.closed) return { known: false } as Balance;
        const safe: Balance = candidate?.known === true && validCredit(candidate.remaining) ? { known: true, remaining: candidate.remaining }
          : { known: false, ...(!candidate.known && validCredit(candidate.retryAfter) ? { retryAfter: Math.min(candidate.retryAfter, MAX_COOLDOWN) } : {}) };
        this.balances.set(id, { value: safe, expires: this.now() + (safe.known ? BALANCE_TTL : FAILURE_TTL) });
        const ledger = this.ledgers.get(id);
        if (safe.known) {
          if (ledger?.held.size) ledger.observed = Math.min(ledger.observed, safe.remaining);
          else this.ledgers.set(id, { observed: safe.remaining, debited: 0, held: new Map() });
          if (safe.remaining === 0) this.recordFailure(backend, "key", key, "quota_exhausted", undefined, override);
        }
        return safe;
      }).finally(() => {
        job.settled = true; clearTimeout(timer);
        if (this.flights.get(id) === job) this.flights.delete(id);
      });
      this.flights.set(id, job); flight = job;
    }
    flight.consumers++;
    try { return await this.waitFor(flight.promise, signal); }
    finally {
      flight.consumers--;
      if (flight.consumers === 0 && !flight.settled) {
        flight.abandoned = true; flight.controller.abort();
        if (this.flights.get(id) === flight) this.flights.delete(id);
      }
    }
  }
  reserve(backend: "tavily" | "firecrawl", key: string, maxResults: number, override?: number): Reservation | undefined {
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 20 || this.closed) return undefined;
    const cost = backend === "tavily" ? 1 : 2 * Math.ceil(maxResults / 10);
    const id = this.scope(backend, "key", key);
    const balance = this.balances.get(id);
    if (!balance || balance.expires <= this.now() || !balance.value.known || this.cooldown(backend, "key", key, override)) return undefined;
    let ledger = this.ledgers.get(id);
    if (!ledger) { ledger = { observed: balance.value.remaining, debited: 0, held: new Map() }; this.ledgers.set(id, ledger); }
    const reserved = (): number => [...ledger!.held.values()].reduce((sum, entry) => sum + (entry.dispatched ? 0 : entry.cost), 0);
    if (cost > Math.max(0, ledger.observed - ledger.debited - reserved())) return undefined;
    const token = Symbol("quota-reservation");
    const held = { cost, dispatched: false };
    ledger.held.set(token, held);
    let settled = false;
    return {
      cost,
      dispatch: () => {
        const latest = this.balances.get(id);
        if (settled || held.dispatched || this.closed || balance.expires <= this.now() || !latest?.value.known || latest.expires <= this.now()
          || this.cooldown(backend, "key", key, override) || cost > ledger!.observed - ledger!.debited - reserved() + cost) return false;
        held.dispatched = true; ledger!.debited = Math.min(Number.MAX_SAFE_INTEGER, ledger!.debited + cost); return true;
      },
      release: () => { if (!settled && !held.dispatched) { settled = true; ledger!.held.delete(token); } },
      settle: () => { if (!settled) { settled = true; ledger!.held.delete(token); } },
    };
  }
  private schedulePersistence(): void {
    if (!this.store || this.closed || this.writer || this.writeScheduled || this.initializationUnavailable || this.revision === this.persistedRevision) return;
    this.writeScheduled = true;
    queueMicrotask(() => {
      this.writeScheduled = false;
      if (!this.closed) void this.flush().catch(() => undefined);
    });
  }
  private startWriter(): Writer {
    const controller = new AbortController();
    const job: Writer = { promise: Promise.resolve("degraded"), controller };
    let outcome: PersistenceResult = "degraded";
    const timer = setTimeout(() => { this.persistence = "degraded"; controller.abort(); }, WRITE_BUDGET_MS);
    job.promise = Promise.resolve().then(async () => {
      try {
        await this.initialize(controller.signal);
        if (this.initializationUnavailable) return "degraded" as const;
        // 单个工作项最多写两份合并快照；新事件只增加版本，不堆积写入 Promise。
        for (let round = 0; round < 2 && this.revision !== this.persistedRevision; round++) {
          if (controller.signal.aborted) throw new CoreFault("aborted");
          const revision = this.revision;
          const state: QuotaState = { version: 1, salt: this.salt.toString("base64"), entries: [...this.records.values()] };
          const result = await this.store!.save(state, controller.signal);
          if (controller.signal.aborted || result !== "saved") throw new CoreFault("aborted");
          this.persistedRevision = revision;
          this.persistence = "persistent";
        }
        outcome = "saved";
        return outcome;
      } catch {
        this.persistence = "degraded";
        return "degraded" as const;
      }
    }).finally(() => {
      clearTimeout(timer);
      if (this.writer === job) this.writer = undefined;
      if (outcome === "saved") this.schedulePersistence();
    });
    this.writer = job;
    return job;
  }
  async flush(signal?: AbortSignal): Promise<PersistenceResult> {
    if (signal?.aborted) throw new CoreFault("aborted");
    // 从未使用的实例关闭时不能触碰宿主目录。
    if (!this.store || !this.initialized && this.revision === 0) return "memory_only";
    if (this.initializationUnavailable) return "degraded";
    const target = this.revision;
    if (target === this.persistedRevision) return this.persistence === "degraded" ? "degraded" : "saved";
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), WRITE_BUDGET_MS);
    const consumer = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
    try {
      while (this.persistedRevision < target) {
        const writer = this.writer ?? this.startWriter();
        const result = await this.waitFor(writer.promise, AbortSignal.any([consumer, writer.controller.signal]));
        if (result !== "saved") return result;
      }
      return "saved";
    } catch {
      if (signal?.aborted) throw new CoreFault("aborted");
      this.persistence = "degraded";
      return "degraded";
    } finally { clearTimeout(timer); }
  }
  dispose(): void {
    this.closed = true;
    for (const flight of this.flights.values()) { flight.abandoned = true; flight.controller.abort(); }
  }
  get warning(): string | undefined {
    return this.capacityReached ? "冷却状态容量已满，已停止发送新的搜索请求。"
      : this.unsupportedPlatform ? "当前平台尚不支持安全冷却持久化；本次仅在当前进程有效。"
      : this.persistence === "degraded" ? "冷却状态未能安全保存；本次仅在当前进程有效。" : undefined;
  }
}
