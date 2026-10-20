/** 额度状态存储：只保存 HMAC scope 标识和冷却元数据，不保存凭据或请求内容。 */
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
const BACKENDS = new Set(["exa", "parallel", "tavily", "firecrawl", "serpapi", "tinyfish"]);
const REASONS = new Set(["rate_limited", "quota_exhausted"]);
const MAX_ENTRIES = 512;
/** 冷却结束超过这个时长就不再保留：与额度管理器的历史保留期一致。 */
const EXPIRED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_STATE_FILES = MAX_ENTRIES;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_ENTRY_BYTES = 4096;
const LOCK_WAIT_MS = 250;
const LOCK_RETRY_MS = 10;
const SAFE_UNAVAILABLE = "QUOTA_STATE_IO_UNAVAILABLE";
const SAFE_CORRUPT = "QUOTA_STATE_CORRUPT";
const SAFE_UNKNOWN = "QUOTA_STATE_UNKNOWN_VERSION";
const SAFE_LOCK_TIMEOUT = "QUOTA_STATE_LOCK_TIMEOUT";
const SAFE_LOCK_UNAVAILABLE = "QUOTA_STATE_LOCK_UNAVAILABLE";
/** 条目数达到上限：这是容量问题，不是文件损坏，诊断必须能区分。 */
const SAFE_CAPACITY = "QUOTA_STATE_CAPACITY_EXCEEDED";
function cloneState(state) {
    return { version: 1, salt: state.salt, entries: state.entries.map((entry) => ({ ...entry })) };
}
function validateState(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return undefined;
    try {
        if (Buffer.byteLength(JSON.stringify(value)) > MAX_STATE_BYTES)
            return undefined;
    }
    catch {
        return undefined;
    }
    const record = value;
    if (record.version !== 1)
        return "unknown_version";
    if (Object.keys(record).some((key) => !["version", "salt", "entries"].includes(key)))
        return undefined;
    if (typeof record.salt !== "string" || !/^[A-Za-z0-9+/]{43}=$/u.test(record.salt))
        return undefined;
    const salt = Buffer.from(record.salt, "base64");
    if (salt.byteLength !== 32 || salt.toString("base64") !== record.salt)
        return undefined;
    if (!Array.isArray(record.entries) || record.entries.length > MAX_ENTRIES)
        return undefined;
    const entries = [];
    for (const item of record.entries) {
        if (item === null || typeof item !== "object" || Array.isArray(item))
            return undefined;
        const row = item;
        if (Object.keys(row).some((key) => !["scopeId", "backend", "channel", "reason", "failureCount", "until", "lastFailureAt", "updatedAt", "sequence", "cleared"].includes(key)))
            return undefined;
        if (typeof row.scopeId !== "string" || !/^[a-f0-9]{64}$/u.test(row.scopeId))
            return undefined;
        if (!BACKENDS.has(row.backend) || (row.channel !== "anonymous" && row.channel !== "key") || !REASONS.has(row.reason))
            return undefined;
        if (!Number.isSafeInteger(row.failureCount) || row.failureCount < 0 || row.failureCount > 1_000_000)
            return undefined;
        for (const field of ["until", "lastFailureAt", "updatedAt"]) {
            if (!Number.isSafeInteger(row[field]) || row[field] < 0)
                return undefined;
        }
        if (row.sequence !== undefined && (!Number.isSafeInteger(row.sequence) || row.sequence < 0))
            return undefined;
        if (row.cleared !== undefined && typeof row.cleared !== "boolean")
            return undefined;
        entries.push({
            scopeId: row.scopeId,
            backend: row.backend,
            channel: row.channel,
            reason: row.reason,
            failureCount: row.failureCount,
            until: row.until,
            lastFailureAt: row.lastFailureAt,
            updatedAt: row.updatedAt,
            ...(row.sequence === undefined ? {} : { sequence: row.sequence }),
            ...(row.cleared === true ? { cleared: true } : {}),
        });
    }
    return { version: 1, salt: record.salt, entries };
}
function entryKey(entry) {
    return `${entry.scopeId}:${entry.reason}`;
}
/**
 * 判断两次事件谁更新。
 *
 * 优先用逻辑序号：墙钟回拨后 `updatedAt` 不再可靠，旧事件会被误认为更新。
 * 旧文件没有序号时退回墙钟比较，保持向后兼容。
 */
function orderKey(entry) {
    return entry.sequence ?? entry.updatedAt;
}
/** 并发更新只延长冷却、保留较大失败阶数；清除时间更新必须避免丢失新失败。 */
function conservativeMerge(current, incoming) {
    if (current === undefined)
        return { ...incoming };
    if (current.backend !== incoming.backend || current.channel !== incoming.channel || current.reason !== incoming.reason)
        return { ...current };
    const incomingWins = orderKey(incoming) > orderKey(current);
    const currentWins = orderKey(current) > orderKey(incoming);
    if (current.cleared || incoming.cleared) {
        if (incomingWins)
            return { ...incoming };
        if (currentWins)
            return { ...current };
        if (current.cleared !== incoming.cleared)
            return current.cleared ? { ...incoming } : { ...current };
    }
    return {
        ...((incomingWins ? incoming : current)),
        failureCount: Math.max(current.failureCount, incoming.failureCount),
        until: Math.max(current.until, incoming.until),
        lastFailureAt: Math.max(current.lastFailureAt, incoming.lastFailureAt),
        updatedAt: Math.max(current.updatedAt, incoming.updatedAt),
        sequence: Math.max(current.sequence ?? 0, incoming.sequence ?? 0),
    };
}
/** 尽力删除单个状态文件；不存在或删除失败都不影响保存本身。 */
async function removeFile(path) {
    try {
        await unlink(path);
    }
    catch {
        // 文件可能已被别的实例回收：忽略即可，保存继续。
    }
}
async function ensureDirectory(directory) {
    const absolute = resolve(directory);
    if (!isAbsolute(absolute))
        throw new Error(SAFE_UNAVAILABLE);
    const root = parse(absolute).root;
    let current = root;
    const parts = absolute.slice(root.length).split(sep).filter(Boolean);
    if (parts.length === 0)
        throw new Error(SAFE_UNAVAILABLE);
    for (const part of parts) {
        current = join(current, part);
        let wasMissing = false;
        let stat;
        try {
            stat = await lstat(current);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            wasMissing = true;
            // 逐级创建并检查，不使用递归 mkdir 跟随未知的祖先符号链接。
            try {
                await mkdir(current, { mode: 0o700 });
            }
            catch (createError) {
                if (createError.code !== "EEXIST")
                    throw createError;
            }
            stat = await lstat(current);
        }
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error(SAFE_UNAVAILABLE);
        if (wasMissing || current === absolute) {
            if (process.getuid !== undefined && stat.uid !== process.getuid())
                throw new Error(SAFE_UNAVAILABLE);
            // 不修改已有目录权限；新建的每一级和状态目录都必须私有。
            if ((stat.mode & 0o077) !== 0)
                throw new Error(SAFE_UNAVAILABLE);
        }
    }
}
async function readPrivateFile(path, maxBytes) {
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) {
            throw new Error(SAFE_UNAVAILABLE);
        }
        const buffer = Buffer.alloc(maxBytes + 1);
        let total = 0;
        while (total < buffer.byteLength) {
            const { bytesRead } = await handle.read(buffer, total, buffer.byteLength - total, total);
            if (bytesRead === 0)
                break;
            total += bytesRead;
        }
        if (total > maxBytes)
            throw new Error(SAFE_UNAVAILABLE);
        return buffer.subarray(0, total);
    }
    finally {
        await handle.close();
    }
}
async function safeReadStateFile(path) {
    const bytes = await readPrivateFile(path, MAX_ENTRY_BYTES);
    if (bytes === undefined)
        return "missing";
    let decoded;
    try {
        decoded = JSON.parse(bytes.toString("utf8"));
    }
    catch {
        return "corrupt";
    }
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded))
        return "corrupt";
    const row = decoded;
    if (row.version !== 1)
        return "unknown_version";
    if (Object.keys(row).some((key) => !["version", "entry"].includes(key)))
        return "corrupt";
    const checked = validateState({ version: 1, salt: Buffer.alloc(32).toString("base64"), entries: [row.entry] });
    if (checked === undefined || checked === "unknown_version")
        return "corrupt";
    return checked.entries[0];
}
async function atomicWrite(path, bytes) {
    const directory = dirname(path);
    const temporary = join(directory, `.quota-tmp-${process.pid}-${randomBytes(12).toString("hex")}`);
    const handle = await open(temporary, "wx", 0o600);
    try {
        await handle.writeFile(bytes, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    const stat = await lstat(temporary);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid()))
        throw new Error(SAFE_UNAVAILABLE);
    await rename(temporary, path);
}
async function acquireLock(path) {
    const nonce = randomBytes(24).toString("hex");
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        try {
            const handle = await open(path, "wx+", 0o600);
            try {
                await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, nonce }), "utf8");
                await handle.sync();
                const stat = await handle.stat();
                if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0)
                    throw new Error(SAFE_LOCK_UNAVAILABLE);
                return { handle, nonce };
            }
            catch (error) {
                await handle.close();
                throw error;
            }
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            if (Date.now() >= deadline)
                return "timeout";
            await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
        }
    }
}
async function releaseLock(path, lock) {
    try {
        const own = await lock.handle.stat();
        const current = await lstat(path);
        if (current.isSymbolicLink() || !current.isFile() || current.dev !== own.dev || current.ino !== own.ino ||
            (process.getuid !== undefined && current.uid !== process.getuid()) || (current.mode & 0o077) !== 0)
            return false;
        const buffer = Buffer.alloc(512);
        const { bytesRead } = await lock.handle.read(buffer, 0, buffer.byteLength, 0);
        const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
            return false;
        const record = parsed;
        if (record.version !== 1 || record.pid !== process.pid || record.nonce !== lock.nonce || Object.keys(record).length !== 3)
            return false;
        const latest = await lstat(path);
        if (latest.isSymbolicLink() || latest.dev !== own.dev || latest.ino !== own.ino)
            return false;
        await unlink(path);
        return true;
    }
    catch {
        return false;
    }
    finally {
        await lock.handle.close().catch(() => undefined);
    }
}
function entryFileName(entry) {
    return `scope-${entry.scopeId}-${entry.reason}.json`;
}
const ENTRY_PATTERN = /^scope-([a-f0-9]{64})-(rate_limited|quota_exhausted)\.json$/u;
/** 本模块自己创建的文件名；其他文件一律视为不可安全接管。 */
const KNOWN_ENTRY = /^(?:quota-salt\.json|\.quota-state\.lock(?:\.[a-f0-9]+\.recovery)?|scope-[a-f0-9]{64}-(?:rate_limited|quota_exhausted)\.json|\.quota-tmp-\d+-[a-f0-9]+\.tmp)$/u;
async function readEntries(directory) {
    const names = await readdir(directory);
    const scopeFiles = names.filter((name) => name.startsWith("scope-"));
    // 超过容量上限时明确报告容量问题：按"损坏"上报会让使用者去排查不存在的文件损坏。
    if (scopeFiles.length > MAX_STATE_FILES)
        return { status: "corrupt", reason: SAFE_CAPACITY };
    const entries = new Map();
    for (const name of scopeFiles) {
        const match = ENTRY_PATTERN.exec(name);
        if (match === null)
            return { status: "corrupt", reason: SAFE_CORRUPT };
        const row = await safeReadStateFile(join(directory, name));
        if (row === "unknown_version")
            return { status: "unknown_version", reason: SAFE_UNKNOWN };
        if (row === "corrupt" || row === "missing")
            return { status: "corrupt", reason: SAFE_CORRUPT };
        if (row.scopeId !== match[1] || row.reason !== match[2])
            return { status: "corrupt", reason: SAFE_CORRUPT };
        const key = entryKey(row);
        if (entries.has(key))
            return { status: "corrupt", reason: SAFE_CORRUPT };
        entries.set(key, row);
    }
    return { status: "ok", entries };
}
function checkSalt(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const row = value;
    return validateState({ ...row, entries: [] });
}
/** 默认内存状态仓库；新 manager 实例不共享，测试可自行注入。 */
export function createMemoryQuotaStateStore() {
    let state;
    return {
        kind: "memory",
        async load() {
            return state === undefined ? { status: "missing" } : { status: "ok", state: cloneState(state) };
        },
        async save(next) {
            state = cloneState(next);
            return { status: "memory_only" };
        },
    };
}
/** 私有磁盘仓库；只有显式构造后才访问该目录。 */
export function createPrivateQuotaStateStore(directory) {
    const base = resolve(directory);
    const saltPath = join(base, "quota-salt.json");
    const lockPath = join(base, ".quota-state.lock");
    let blocked;
    const readSalt = async () => {
        const bytes = await readPrivateFile(saltPath, 1024);
        if (bytes === undefined)
            return "missing";
        let decoded;
        try {
            decoded = JSON.parse(bytes.toString("utf8"));
        }
        catch {
            return "corrupt";
        }
        const checked = checkSalt(decoded);
        if (checked === "unknown_version")
            return "unknown_version";
        return checked === undefined ? "corrupt" : checked;
    };
    const load = async () => {
        try {
            await ensureDirectory(base);
            const lock = await acquireLock(lockPath);
            if (lock === "timeout") {
                blocked = { status: "unavailable", reason: SAFE_LOCK_TIMEOUT };
                return blocked;
            }
            // 读取已经成功：清掉之前记录的瞬时失败，避免一次锁竞争让实例永久退化。
            blocked = undefined;
            let saltState;
            try {
                saltState = await readSalt();
                if (saltState === "missing") {
                    const names = await readdir(base);
                    // 只认本模块自己的文件；其他任何文件（含用户的 state.json）都视为不可安全接管。
                    if (names.some((name) => !KNOWN_ENTRY.test(name)))
                        saltState = "corrupt";
                    else {
                        const generated = JSON.stringify({ version: 1, salt: randomBytes(32).toString("base64") });
                        const handle = await open(saltPath, "wx", 0o600);
                        try {
                            await handle.writeFile(generated, "utf8");
                            await handle.sync();
                        }
                        finally {
                            await handle.close();
                        }
                        saltState = await readSalt();
                    }
                }
                if (saltState === "unknown_version") {
                    blocked = { status: "unknown_version", reason: SAFE_UNKNOWN };
                    return blocked;
                }
                if (saltState === "corrupt" || saltState === "missing") {
                    blocked = { status: "corrupt", reason: SAFE_CORRUPT };
                    return blocked;
                }
                // 持锁读取完整快照，避免并发写入只恢复部分冷却记录。
                const read = await readEntries(base);
                if (read.status !== "ok") {
                    blocked = read;
                    return blocked;
                }
                if (read.entries.size > MAX_ENTRIES) {
                    blocked = { status: "corrupt", reason: SAFE_CORRUPT };
                    return blocked;
                }
                return { status: "ok", state: { version: 1, salt: saltState.salt, entries: [...read.entries.values()] } };
            }
            finally {
                if (!(await releaseLock(lockPath, lock)))
                    throw new Error(SAFE_LOCK_UNAVAILABLE);
            }
        }
        catch {
            blocked = { status: "unavailable", reason: SAFE_UNAVAILABLE };
            return blocked;
        }
    };
    const saveLocked = async (state) => {
        if (blocked !== undefined)
            return { status: "unavailable", reason: "reason" in blocked ? blocked.reason : SAFE_CORRUPT };
        const checked = validateState(state);
        if (checked === undefined || checked === "unknown_version")
            return { status: "unavailable", reason: SAFE_CORRUPT };
        let saltState = await readSalt();
        if (saltState === "unknown_version")
            return { status: "unavailable", reason: SAFE_UNKNOWN };
        if (saltState === "corrupt")
            return { status: "unavailable", reason: SAFE_CORRUPT };
        if (saltState === "missing") {
            const names = await readdir(base);
            if (names.some((name) => !KNOWN_ENTRY.test(name)))
                return { status: "unavailable", reason: SAFE_CORRUPT };
            const encoded = JSON.stringify({ version: 1, salt: checked.salt });
            try {
                const handle = await open(saltPath, "wx", 0o600);
                try {
                    await handle.writeFile(encoded, "utf8");
                    await handle.sync();
                }
                finally {
                    await handle.close();
                }
            }
            catch (error) {
                if (error.code !== "EEXIST")
                    throw error;
            }
            saltState = await readSalt();
        }
        if (saltState === "unknown_version")
            return { status: "unavailable", reason: SAFE_UNKNOWN };
        if (saltState === "corrupt" || saltState === "missing" || saltState.salt !== checked.salt)
            return { status: "unavailable", reason: SAFE_CORRUPT };
        const read = await readEntries(base);
        if (read.status !== "ok")
            return { status: "unavailable", reason: read.reason };
        // 序号由事件的产生方（额度管理器）分配，这里只负责比较与落盘。
        // 若在保存阶段统一抬序，没有新事件的旧实例也会把旧失败"变新"，
        // 覆盖掉别处已经写入的清除。
        const migrated = (entry) => entry.sequence === undefined ? { ...entry, sequence: entry.updatedAt } : entry;
        const mergedEntries = new Map([...read.entries].map(([key, entry]) => [key, migrated(entry)]));
        const updates = [];
        for (const incoming of checked.entries.map(migrated)) {
            const key = entryKey(incoming);
            const previous = mergedEntries.get(key);
            const merged = conservativeMerge(previous, incoming);
            if (JSON.stringify(previous) !== JSON.stringify(merged))
                updates.push(merged);
            mergedEntries.set(key, merged);
        }
        // 容量按"仍然有效"的条目计算，并顺手回收早已过期的文件。
        // 否则轮换凭据后残留的旧作用域会永久占满配额，新冷却再也写不进去。
        //
        // 时间基准取**本次提交里的最大 updatedAt**，而不是墙钟 `Date.now()`：
        // 额度管理器用的是注入时钟（测试里可以是很小的逻辑时间），
        // 用墙钟判断会把仍然有效的记录误判成过期并删除。
        const referenceNow = checked.entries.reduce((max, entry) => Math.max(max, entry.updatedAt), 0);
        const reclaimed = [];
        if (referenceNow > 0) {
            const retentionCutoff = referenceNow - EXPIRED_RETENTION_MS;
            for (const [key, entry] of mergedEntries) {
                if (entry.until >= retentionCutoff)
                    continue;
                mergedEntries.delete(key);
                reclaimed.push(key);
            }
        }
        if (mergedEntries.size > MAX_ENTRIES)
            return { status: "unavailable", reason: SAFE_CAPACITY };
        for (const key of reclaimed) {
            const [scopeId, reason] = key.split(":");
            if (scopeId === undefined || reason === undefined)
                continue;
            await removeFile(join(base, entryFileName({ scopeId, reason: reason })));
        }
        for (const entry of updates) {
            // 已被回收的过期条目不再写回。
            if (!mergedEntries.has(entryKey(entry)))
                continue;
            await atomicWrite(join(base, entryFileName(entry)), JSON.stringify({ version: 1, entry }));
        }
        return { status: "saved" };
    };
    const save = async (state) => {
        try {
            await ensureDirectory(base);
            const checked = validateState(state);
            if (checked === undefined || checked === "unknown_version")
                return { status: "unavailable", reason: SAFE_CORRUPT };
            const lock = await acquireLock(lockPath);
            if (lock === "timeout")
                return { status: "unavailable", reason: SAFE_LOCK_TIMEOUT };
            let result;
            try {
                result = await saveLocked(checked);
            }
            finally {
                if (!(await releaseLock(lockPath, lock)))
                    result = { status: "unavailable", reason: SAFE_LOCK_UNAVAILABLE };
            }
            return result;
        }
        catch {
            return { status: "unavailable", reason: SAFE_UNAVAILABLE };
        }
    };
    return { kind: "private", load, save };
}
