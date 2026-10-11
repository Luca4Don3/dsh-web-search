/** 同实例额度缓存、独立消费者刷新、保守预留与私有冷却状态。 */
import { createHmac, randomBytes } from "node:crypto";
import { createPrivateStateStore, type QuotaState, type StateBackend, type StateChannel, type StateEntry, type StateReason, type StateStore } from "./state.js";
import { CoreFault } from "./body.js";
import type { SearchDependencies, SearchOptions } from "../contracts.js";

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
  private initPromise?: Promise<void>;
  private persistence: "memory_only" | "persistent" | "degraded";
  private revision = 0;
  private persistedRevision = 0;
  private capacityReached = false;
  private closed = false;
  private flushTail: Promise<unknown> = Promise.resolve();
  private readonly store?: StateStore;
  private readonly now: () => number;

  constructor(options: SearchOptions, deps: SearchDependencies) {
    this.now = deps.clock ?? Date.now;
    if (options.stateDirectory !== undefined) this.store = createPrivateStateStore(options.stateDirectory);
    this.persistence = this.store ? "persistent" : "memory_only";
  }
  private scope(backend: StateBackend, channel: StateChannel, key?: string): string {
    return createHmac("sha256", this.salt).update(JSON.stringify([backend, channel, channel === "key" ? key : null])).digest("hex");
  }
  initialize(signal?: AbortSignal): Promise<void> {
    if (!this.initPromise) this.initPromise = (async () => {
      if (!this.store) return;
      const loaded = await this.store.load(signal);
      if (loaded.status === "ok") {
        this.salt = Buffer.from(loaded.state.salt, "base64");
        for (const entry of loaded.state.entries) this.records.set(`${entry.scope}:${entry.backend}:${entry.channel}:${entry.reason}`, entry);
      } else this.persistence = "degraded";
    })().catch(() => { this.persistence = this.store ? "degraded" : "memory_only"; });
    return this.initPromise;
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
  recordFailure(backend: StateBackend, channel: StateChannel, key: string | undefined, reason: StateReason, retryAfter?: number, override?: number): void {
    const id = this.scope(backend, channel, key);
    const k = `${id}:${backend}:${channel}:${reason}`;
    const now = this.now();
    if (!this.records.has(k) && this.records.size >= MAX_ENTRIES) {
      for (const [oldKey, entry] of this.records) if (entry.cleared || entry.until <= now) this.records.delete(oldKey);
      if (this.records.size >= MAX_ENTRIES) { this.capacityReached = true; this.persistence = "degraded"; return; }
    }
    const previous = this.records.get(k);
    const failures = Math.min(1_000_000, (previous && !previous.cleared && now - previous.lastAt < 90 * MAX_COOLDOWN ? previous.failures : 0) + 1);
    const ladder = reason === "rate_limited" ? RATE_STEPS : EXHAUST_STEPS;
    const duration = override ?? (retryAfter === undefined ? ladder[Math.min(failures - 1, ladder.length - 1)]! : Math.min(retryAfter, MAX_COOLDOWN));
    this.records.set(k, { scope: id, backend, channel, reason, failures, until: now + Math.max(0, Math.min(duration, MAX_COOLDOWN)), lastAt: now, updatedAt: now });
    this.revision++;
  }
  recordSuccess(backend: StateBackend, channel: StateChannel, key: string | undefined): void {
    const id = this.scope(backend, channel, key);
    for (const reason of ["rate_limited", "quota_exhausted"] as const) {
      const k = `${id}:${backend}:${channel}:${reason}`;
      const old = this.records.get(k);
      if (old && !old.cleared) {
        this.records.set(k, { ...old, cleared: true, failures: 0, until: this.now(), updatedAt: this.now() });
        this.revision++;
      }
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
  flush(signal?: AbortSignal): Promise<"saved" | "memory_only" | "degraded"> {
    const run = async (): Promise<"saved" | "memory_only" | "degraded"> => {
      // 从未初始化的实例关闭时不能触碰宿主目录。
      if (!this.initPromise) return "memory_only";
      await this.initPromise;
      if (!this.store) return "memory_only";
      if (this.revision === this.persistedRevision) return this.persistence === "degraded" ? "degraded" : "saved";
      const revision = this.revision;
      const state: QuotaState = { version: 1, salt: this.salt.toString("base64"), entries: [...this.records.values()] };
      const result = await this.store.save(state, signal);
      if (result === "saved") { this.persistedRevision = revision; this.persistence = "persistent"; return "saved"; }
      this.persistence = "degraded"; return "degraded";
    };
    const next = this.flushTail.then(run, run); this.flushTail = next.catch(() => undefined); return next;
  }
  dispose(): void {
    this.closed = true;
    for (const flight of this.flights.values()) { flight.abandoned = true; flight.controller.abort(); }
  }
  get warning(): string | undefined {
    return this.capacityReached ? "冷却状态容量已满，已停止发送新的搜索请求。" : this.persistence === "degraded" ? "冷却状态未能安全保存；本次仅在当前进程有效。" : undefined;
  }
}
