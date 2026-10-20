/** 额度核心：HMAC scope、冷却历史、额度查询缓存和进程内同步预留。 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES } from "../shared/response-body.js";
import { estimateSearchCost } from "./cost.js";
import { createMemoryQuotaStateStore, } from "./state-store.js";
import { lookupUsage, } from "./usage.js";
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const BALANCE_CACHE_MS = 5 * 60 * 1000;
const FAILURE_CACHE_MS = 30 * 1000;
const RATE_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000, 1_800_000];
const QUOTA_BACKOFF_MS = [1_800_000, 3_600_000, 7_200_000, 14_400_000];
function abortError() {
    return new DOMException("Quota lookup aborted", "AbortError");
}
function validateDuration(value, name) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > MAX_COOLDOWN_MS)) {
        throw new Error(`${name} must be an integer from 0 to 86400000`);
    }
}
function validateRetryAfter(value) {
    if (value === undefined)
        return undefined;
    if (!Number.isSafeInteger(value) || value < 0)
        throw new Error("retryAfterMs must be a non-negative safe integer");
    return Math.min(value, MAX_COOLDOWN_MS);
}
function safeLookupResult(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return { state: "unknown", reason: "invalid_response" };
    const row = value;
    if (row.state === "known") {
        if (!Number.isSafeInteger(row.remaining) || typeof row.remaining !== "number" || row.remaining < 0 || row.eligibility !== "not_verified") {
            return { state: "unknown", reason: "invalid_response" };
        }
        return {
            state: "known",
            remaining: row.remaining,
            eligibility: "not_verified",
            ...(Number.isSafeInteger(row.observedAt) && row.observedAt >= 0 ? { observedAt: row.observedAt } : {}),
        };
    }
    const reasons = new Set([
        "authorization_required", "unsupported_backend", "lookup_failed", "invalid_response", "timeout", "aborted", "rate_limited",
    ]);
    if (row.state === "unknown" && reasons.has(row.reason)) {
        return {
            state: "unknown",
            reason: row.reason,
            ...(Number.isSafeInteger(row.retryAfterMs) && row.retryAfterMs >= 0
                ? { retryAfterMs: Math.min(row.retryAfterMs, MAX_COOLDOWN_MS) }
                : {}),
        };
    }
    return { state: "unknown", reason: "invalid_response" };
}
function lookupIsAborted(value) {
    return value.state === "unknown" && value.reason === "aborted";
}
function statusKey(scopeId, reason) {
    return `${scopeId}:${reason}`;
}
function cloneLookupResult(value) {
    return { ...value };
}
/** 创建实例隔离的额度管理器；默认状态仓库是内存，不读取任何用户配置目录。 */
export function createQuotaManager(options = {}) {
    const clock = options.clock ?? Date.now;
    const defaultCooldownMs = options.cooldownMs;
    validateDuration(defaultCooldownMs, "cooldownMs");
    const deadlineMs = options.deadlineMs ?? 2_000;
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000)
        throw new Error("deadlineMs must be from 1 to 60000");
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES)
        throw new Error("maxResponseBytes is outside the supported range");
    const stateStore = options.stateStore ?? createMemoryQuotaStateStore();
    const lookup = options.lookup ?? lookupUsage;
    const records = new Map();
    const balances = new Map();
    const ledgers = new Map();
    const flights = new Map();
    let salt = randomBytes(32);
    let initialized;
    let initializationComplete = false;
    let persistence = "not_initialized";
    let persistenceReason;
    const safePersistenceReasons = new Set([
        "QUOTA_STATE_IO_UNAVAILABLE", "QUOTA_STATE_CORRUPT", "QUOTA_STATE_UNKNOWN_VERSION",
        "QUOTA_STATE_LOCK_TIMEOUT", "QUOTA_STATE_LOCK_UNAVAILABLE",
    ]);
    const quotaEpochs = new Map();
    let flushTail = Promise.resolve();
    /**
     * 事件序号：只在**产生新事件**时递增，用于判断条目的先后。
     *
     * 不能由保存阶段统一抬序——那样旧实例即使没有新事件，重新保存也会把
     * 旧失败"变新"，覆盖掉别的实例已经写入的清除。
     */
    let eventSequence = 0;
    /**
     * 已有新事件、但尚未分配序号的记录键。
     *
     * 序号选在**保存时**分配，而不是事件发生时：多实例部署下本地计数可能
     * 落后于别的实例已写入的事件，事件发生时无法知道磁盘上的最高值。
     * 保存前会先读一次磁盘最高序号，再为这批新事件逐个递增。
     */
    // 用计数而不是集合：同一个键在写盘期间可能再次产生事件，
    // 保存成功时只能扣减本次快照里的那份，否则会把新事件一并清掉。
    const pendingEvents = new Map();
    const noteEvent = (key) => {
        pendingEvents.set(key, (pendingEvents.get(key) ?? 0) + 1);
    };
    const initialize = () => {
        if (initialized !== undefined)
            return initialized;
        initialized = (async () => {
            let loaded;
            try {
                loaded = await stateStore.load();
            }
            catch {
                loaded = { status: "unavailable", reason: "QUOTA_STATE_IO_UNAVAILABLE" };
            }
            if (loaded.status === "ok") {
                salt = Buffer.from(loaded.state.salt, "base64");
                let highest = 0;
                for (const entry of loaded.state.entries) {
                    // 旧文件没有序号：用既有的墙钟时间戳补齐，保证迁移后新旧事件仍可比。
                    // 否则升级后第一个新序号会小于旧墓碑的时间戳，被旧墓碑吞掉。
                    const sequence = entry.sequence ?? entry.updatedAt;
                    records.set(statusKey(entry.scopeId, entry.reason), { ...entry, sequence });
                    if (sequence > highest)
                        highest = sequence;
                }
                eventSequence = highest;
                persistence = stateStore.kind === "private" ? "persistent" : "memory_only";
                persistenceReason = undefined;
                pruneHistory();
            }
            else if (loaded.status === "missing") {
                persistence = stateStore.kind === "private" ? "persistent" : "memory_only";
                persistenceReason = undefined;
            }
            else {
                persistence = "degraded";
                persistenceReason = safePersistenceReasons.has(loaded.reason) ? loaded.reason : "QUOTA_STATE_IO_UNAVAILABLE";
            }
            initializationComplete = true;
        })();
        return initialized;
    };
    const assertInitialized = () => {
        if (!initializationComplete)
            throw new Error("QUOTA_MANAGER_NOT_INITIALIZED");
    };
    const scopeIdFor = (scope) => {
        assertInitialized();
        if (scope.channel === "key" && (typeof scope.credential !== "string" || scope.credential.length === 0)) {
            throw new Error("A key credential is required for keyed quota state");
        }
        const message = JSON.stringify([scope.backend, scope.channel, scope.channel === "key" ? scope.credential : null]);
        return createHmac("sha256", salt).update(message, "utf8").digest("hex");
    };
    function pruneHistory() {
        const now = clock();
        for (const [key, record] of records) {
            if (now - record.lastFailureAt > MAX_HISTORY_AGE_MS)
                records.delete(key);
        }
    }
    const recordFailure = (backend, channel, reason, failureOptions = {}) => {
        assertInitialized();
        validateDuration(failureOptions.cooldownMs, "cooldownMs");
        const retryAfterMs = validateRetryAfter(failureOptions.retryAfterMs);
        const scope = { backend, channel, ...(failureOptions.credential === undefined ? {} : { credential: failureOptions.credential }) };
        const scopeId = scopeIdFor(scope);
        const key = statusKey(scopeId, reason);
        const now = clock();
        const previous = records.get(key);
        const historicalCount = previous !== undefined && !previous.cleared && now - previous.lastFailureAt <= MAX_HISTORY_AGE_MS
            ? previous.failureCount
            : 0;
        const failureCount = Math.min(1_000_000, historicalCount + 1);
        const ladder = reason === "rate_limited" ? RATE_BACKOFF_MS : QUOTA_BACKOFF_MS;
        const steppedDuration = ladder[Math.min(failureCount - 1, ladder.length - 1)];
        const duration = failureOptions.cooldownMs ?? defaultCooldownMs ?? (retryAfterMs ?? steppedDuration);
        const retryDuration = retryAfterMs ?? duration;
        const actualDuration = duration === 0 ? 0 : Math.min(retryDuration, MAX_COOLDOWN_MS);
        const until = Math.min(Number.MAX_SAFE_INTEGER, now + actualDuration);
        const entry = {
            scopeId,
            backend,
            channel,
            reason,
            failureCount,
            until,
            lastFailureAt: now,
            updatedAt: now,
        };
        records.set(key, entry);
        noteEvent(key);
        if (reason === "quota_exhausted") {
            quotaEpochs.set(scopeId, (quotaEpochs.get(scopeId) ?? 0) + 1);
            balances.delete(scopeId);
        }
        return actualDuration === 0 ? undefined : cooldownFrom(entry, now);
    };
    const cooldownFrom = (entry, now) => ({
        backend: entry.backend,
        channel: entry.channel,
        reason: entry.reason,
        until: entry.until,
        remainingMs: Math.max(0, entry.until - now),
        failureCount: entry.failureCount,
        ...(entry.reason === "quota_exhausted" ? { nextProbeAt: entry.until } : {}),
    });
    const getCooldown = (backend, channel, credentialOrCooldown, cooldownMs) => {
        assertInitialized();
        const override = typeof credentialOrCooldown === "number" ? credentialOrCooldown : cooldownMs;
        validateDuration(override, "cooldownMs");
        // 调用级显式覆盖优先；未提供覆盖时才回落到实例默认值。
        if (override === 0)
            return undefined;
        if (override === undefined && defaultCooldownMs === 0)
            return undefined;
        const credential = typeof credentialOrCooldown === "string" ? credentialOrCooldown : undefined;
        const scopeId = scopeIdFor({ backend, channel, ...(credential === undefined ? {} : { credential }) });
        const now = clock();
        let active;
        for (const reason of ["rate_limited", "quota_exhausted"]) {
            const entry = records.get(statusKey(scopeId, reason));
            if (entry !== undefined && !entry.cleared && entry.until > now && (active === undefined || entry.until > active.until))
                active = entry;
        }
        return active === undefined ? undefined : cooldownFrom(active, now);
    };
    const recordSuccess = (backend, channel, credentialOrCooldown, cooldownMs) => {
        assertInitialized();
        validateDuration(typeof credentialOrCooldown === "number" ? credentialOrCooldown : cooldownMs, "cooldownMs");
        const credential = typeof credentialOrCooldown === "string" ? credentialOrCooldown : undefined;
        const scopeId = scopeIdFor({ backend, channel, ...(credential === undefined ? {} : { credential }) });
        const now = clock();
        if (!["rate_limited", "quota_exhausted"].some((reason) => records.has(statusKey(scopeId, reason))))
            return;
        for (const reason of ["rate_limited", "quota_exhausted"]) {
            const key = statusKey(scopeId, reason);
            const previous = records.get(key);
            records.set(key, {
                scopeId,
                backend,
                channel,
                reason,
                failureCount: 0,
                until: now,
                lastFailureAt: previous?.lastFailureAt ?? now,
                updatedAt: now,
                cleared: true,
            });
            // 清除也是一次新事件：必须拿到递增序号，否则回拨后的清除会被旧失败压过。
            noteEvent(key);
        }
    };
    const lookupBalance = async (input) => {
        await initialize();
        if (input.allowBillable !== true || input.channel !== "key" || typeof input.credential !== "string" || input.credential.length === 0) {
            return { state: "unknown", reason: "authorization_required" };
        }
        if (input.signal?.aborted)
            throw abortError();
        const responseLimit = input.maxResponseBytes ?? maxResponseBytes;
        if (!Number.isSafeInteger(responseLimit) || responseLimit < 1 || responseLimit > MAX_RESPONSE_BYTES) {
            throw new Error("maxResponseBytes is outside the supported range");
        }
        validateDuration(input.cooldownOverrideMs, "cooldownOverrideMs");
        const cooldownOptions = input.cooldownOverrideMs === undefined ? {} : { cooldownMs: input.cooldownOverrideMs };
        const credential = input.credential;
        const scopeId = scopeIdFor({ backend: input.backend, channel: "key", credential });
        const now = clock();
        const currentCooldown = getCooldown(input.backend, "key", credential, input.cooldownOverrideMs);
        if (currentCooldown !== undefined) {
            return { state: "unknown", reason: currentCooldown.reason === "rate_limited" ? "rate_limited" : "lookup_failed", ...(currentCooldown.reason === "rate_limited" ? { retryAfterMs: currentCooldown.remainingMs } : {}) };
        }
        const cached = balances.get(scopeId);
        if (cached !== undefined && cached.expiresAt > now)
            return { ...cloneLookupResult(cached.value), cached: true };
        let flight = flights.get(scopeId);
        if (flight === undefined) {
            const created = { scopeId, quotaEpoch: quotaEpochs.get(scopeId) ?? 0, controller: new AbortController(), waiters: new Set(), promise: Promise.resolve({ state: "unknown", reason: "lookup_failed" }) };
            flights.set(scopeId, created);
            created.promise = Promise.resolve().then(() => lookup({
                backend: input.backend,
                credential,
                allowBillable: true,
                signal: created.controller.signal,
            }, { deadlineMs, maxResponseBytes: responseLimit, clock })).then((result) => {
                const safe = safeLookupResult(result);
                if (created.controller.signal.aborted || lookupIsAborted(safe))
                    return { state: "unknown", reason: "aborted" };
                if (created.quotaEpoch !== (quotaEpochs.get(scopeId) ?? 0))
                    return { state: "unknown", reason: "lookup_failed" };
                const expiresAt = clock() + (safe.state === "known" ? BALANCE_CACHE_MS : FAILURE_CACHE_MS);
                balances.set(scopeId, { value: safe, expiresAt });
                if (safe.state === "known") {
                    const oldLedger = ledgers.get(scopeId);
                    if (oldLedger !== undefined && oldLedger.reservations.size > 0) {
                        oldLedger.observedRemaining = Math.min(oldLedger.observedRemaining, safe.remaining);
                        // 有 reservation 时不重置 debited；新观测可能已包含这些请求，重复扣减是有意保守的。
                    }
                    else {
                        ledgers.set(scopeId, { observedRemaining: safe.remaining, debited: 0, reservations: oldLedger?.reservations ?? new Map() });
                    }
                    if (safe.remaining === 0)
                        recordFailure(input.backend, "key", "quota_exhausted", { credential, ...cooldownOptions });
                }
                else if (safe.reason === "rate_limited") {
                    recordFailure(input.backend, "key", "rate_limited", {
                        credential,
                        ...cooldownOptions,
                        ...(safe.retryAfterMs === undefined ? {} : { retryAfterMs: safe.retryAfterMs }),
                    });
                }
                return safe;
            }).catch(() => {
                if (created.controller.signal.aborted)
                    return { state: "unknown", reason: "aborted" };
                const failure = { state: "unknown", reason: "lookup_failed" };
                balances.set(scopeId, { value: failure, expiresAt: clock() + FAILURE_CACHE_MS });
                return failure;
            }).finally(() => {
                if (flights.get(scopeId) === created)
                    flights.delete(scopeId);
            });
            flight = created;
        }
        return waitForFlight(flight, input.signal);
    };
    function waitForFlight(flight, signal) {
        if (signal?.aborted)
            return Promise.reject(abortError());
        const waiter = Symbol("quota-waiter");
        flight.waiters.add(waiter);
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (callback) => {
                if (settled)
                    return;
                settled = true;
                signal?.removeEventListener("abort", onAbort);
                flight.waiters.delete(waiter);
                callback();
            };
            const onAbort = () => finish(() => {
                reject(abortError());
                if (flight.waiters.size === 0) {
                    flight.controller.abort();
                    if (flights.get(flight.scopeId) === flight)
                        flights.delete(flight.scopeId);
                }
            });
            signal?.addEventListener("abort", onAbort, { once: true });
            flight.promise.then((value) => finish(() => resolve({ ...cloneLookupResult(value), cached: false })), () => finish(() => resolve({ state: "unknown", reason: "lookup_failed", cached: false })));
            if (signal?.aborted)
                onAbort();
        });
    }
    const reserve = (input) => {
        assertInitialized();
        if (input.allowBillable !== true)
            return { status: "denied", reason: "authorization_required" };
        const cost = estimateSearchCost(input.backend, input.maxResults, input.operation);
        if (cost === undefined)
            return { status: "denied", reason: "unsupported_operation" };
        const scopeId = scopeIdFor({ backend: input.backend, channel: "key", credential: input.credential });
        validateDuration(input.cooldownOverrideMs, "cooldownOverrideMs");
        if (getCooldown(input.backend, "key", input.credential, input.cooldownOverrideMs) !== undefined)
            return { status: "denied", reason: "unknown_balance" };
        const cached = balances.get(scopeId);
        if (cached === undefined || cached.expiresAt <= clock() || cached.value.state !== "known")
            return { status: "denied", reason: "unknown_balance" };
        let ledger = ledgers.get(scopeId);
        if (ledger === undefined) {
            ledger = { observedRemaining: cached.value.remaining, debited: 0, reservations: new Map() };
            ledgers.set(scopeId, ledger);
        }
        else {
            // 余额缓存会被刷新：沿用旧快照会让后续预留按过期的余额放行。
            ledger.observedRemaining = cached.value.remaining;
        }
        const reservedTotal = [...ledger.reservations.values()].reduce((total, reservation) => total + (reservation.dispatched ? 0 : reservation.cost), 0);
        const available = Math.max(0, ledger.observedRemaining - ledger.debited - reservedTotal);
        if (cost > available)
            return { status: "denied", reason: "insufficient_credits", available };
        const id = randomUUID();
        const held = { cost, quotaEpoch: quotaEpochs.get(scopeId) ?? 0, dispatched: false, settled: false };
        ledger.reservations.set(id, held);
        let chargedCost = cost;
        const reservation = {
            id,
            cost,
            dispatch() {
                if (held.settled || held.dispatched)
                    return false;
                const freshBalance = balances.get(scopeId);
                if (held.quotaEpoch !== (quotaEpochs.get(scopeId) ?? 0) || getCooldown(input.backend, "key", input.credential, input.cooldownOverrideMs) !== undefined || freshBalance === undefined ||
                    freshBalance.expiresAt <= clock() || freshBalance.value.state !== "known")
                    return false;
                // 派发前按**最新**余额复核：预留到派发之间缓存可能刷新成更小的值，
                // 只看预留时的快照会让两次旧预留都派发成功，总成本超过实际余额。
                const latestRemaining = freshBalance.value.remaining;
                ledger.observedRemaining = latestRemaining;
                if (cost > Math.max(0, latestRemaining - ledger.debited))
                    return false;
                held.dispatched = true;
                ledger.debited = safeAdd(ledger.debited, cost);
                return true;
            },
            release() {
                if (held.settled || held.dispatched)
                    return false;
                held.settled = true;
                ledger.reservations.delete(id);
                return true;
            },
            settle(actualCost) {
                if (held.settled)
                    return false;
                if (!held.dispatched) {
                    if (actualCost !== undefined)
                        return false;
                    held.settled = true;
                    ledger.reservations.delete(id);
                    return true;
                }
                if (actualCost !== undefined) {
                    if (!Number.isSafeInteger(actualCost) || actualCost < 0)
                        throw new Error("actualCost must be a non-negative safe integer");
                    ledger.debited = Math.max(0, ledger.debited + actualCost - chargedCost);
                    chargedCost = actualCost;
                }
                held.settled = true;
                ledger.reservations.delete(id);
                return true;
            },
        };
        return { status: "reserved", cost, availableBefore: available, reservation };
    };
    const flush = () => {
        const run = async () => {
            await initialize();
            pruneHistory();
            // 保存前同步磁盘最高序号：别的实例可能已经写入更大的事件序号，
            // 本地计数若落后，这批新事件会被合并掉（失败阶数与冷却都不推进）。
            let base = eventSequence;
            const diskByKey = new Map();
            try {
                const disk = await stateStore.load();
                if (disk.status === "ok") {
                    for (const entry of disk.state.entries) {
                        const value = entry.sequence ?? entry.updatedAt;
                        if (value > base)
                            base = value;
                        diskByKey.set(statusKey(entry.scopeId, entry.reason), entry);
                    }
                }
            }
            catch {
                // 读不到磁盘就退回本地计数：宁可保守，也不阻断保存。
            }
            // 记下本次要落盘的待办计数：保存期间可能出现新事件，不能一并清空。
            const snapshot = new Map(pendingEvents);
            for (const key of snapshot.keys()) {
                const record = records.get(key);
                if (record === undefined)
                    continue;
                const diskRecord = diskByKey.get(key);
                // 本地可能是从更早的快照启动的：磁盘上已有更高的失败阶数时，
                // 这次事件应接着它推进，而不是把计数压低后合并成旧值。
                if (diskRecord !== undefined && diskRecord.cleared !== true && diskRecord.failureCount > record.failureCount) {
                    record.failureCount = Math.min(1_000_000, diskRecord.failureCount + 1);
                    record.until = Math.max(record.until, diskRecord.until);
                }
                base += 1;
                record.sequence = base;
            }
            const state = {
                version: 1,
                salt: salt.toString("base64"),
                entries: [...records.values()].map((entry) => ({ ...entry })),
            };
            try {
                const result = await stateStore.save(state);
                if (result.status === "unavailable") {
                    persistence = "degraded";
                    persistenceReason = safePersistenceReasons.has(result.reason) ? result.reason : "QUOTA_STATE_IO_UNAVAILABLE";
                    return { status: "degraded", reason: persistenceReason };
                }
                if (result.status === "memory_only") {
                    persistence = "memory_only";
                    persistenceReason = undefined;
                    return { status: "memory_only" };
                }
                persistence = "persistent";
                persistenceReason = undefined;
                // 保存成功后才提交序号基线并清理待办，失败时下次会重新分配更大的序号。
                // 只扣减本次快照里的计数：写盘期间新增的事件必须留到下一次保存。
                eventSequence = base;
                for (const [key, count] of snapshot) {
                    const left = (pendingEvents.get(key) ?? 0) - count;
                    if (left <= 0)
                        pendingEvents.delete(key);
                    else
                        pendingEvents.set(key, left);
                }
                return { status: "persisted" };
            }
            catch {
                persistence = "degraded";
                persistenceReason = "QUOTA_STATE_IO_UNAVAILABLE";
                return { status: "degraded", reason: persistenceReason };
            }
        };
        const next = flushTail.then(run, run);
        flushTail = next.catch(() => undefined);
        return next;
    };
    const snapshot = () => {
        const now = clock();
        const cooldowns = [];
        for (const record of records.values()) {
            if (record.cleared || record.until <= now)
                continue;
            cooldowns.push(cooldownFrom(record, now));
        }
        return {
            persistence,
            ...(persistenceReason === undefined ? {} : { persistenceReason }),
            cooldowns: cooldowns.map((entry) => ({ ...entry })),
        };
    };
    return {
        initialize,
        restore: initialize,
        getCooldown,
        recordFailure,
        recordSuccess,
        lookupBalance,
        getBalance: lookupBalance,
        reserve,
        flush,
        snapshot,
        readonly: {
            balanceCacheMs: BALANCE_CACHE_MS,
            failureCacheMs: FAILURE_CACHE_MS,
        },
    };
}
function safeAdd(left, right) {
    const sum = left + right;
    return Number.isSafeInteger(sum) ? sum : Number.MAX_SAFE_INTEGER;
}
