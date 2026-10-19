/** 只保存 HMAC 作用域与冷却元数据的私有状态仓库。 */
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, parse, resolve, sep } from "node:path";
const SAFE = "状态存储不可用";
const BACKENDS = new Set(["exa", "tavily", "parallel", "firecrawl", "tinyfish"]);
const REASONS = new Set(["rate_limited", "quota_exhausted"]);
const MAX_BYTES = 128 * 1024;
const MAX_ENTRIES = 512;
const LOCK_WAIT_MS = 300;
class StateCancelled extends Error {
    constructor() { super("状态操作已取消"); }
}
function abortCheck(signal) { if (signal?.aborted)
    throw new StateCancelled(); }
function owner() { return process.getuid?.(); }
function safeMode(stat) {
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && owner() !== undefined && stat.uid === owner() && (Number(stat.mode) & 0o077) === 0;
}
function validateState(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const row = value;
    if (row.version !== 1 || Object.keys(row).some((key) => !["version", "salt", "entries"].includes(key)))
        return undefined;
    if (typeof row.salt !== "string" || !/^[A-Za-z0-9+/]{43}=$/u.test(row.salt))
        return undefined;
    const salt = Buffer.from(row.salt, "base64");
    if (salt.length !== 32 || salt.toString("base64") !== row.salt || !Array.isArray(row.entries) || row.entries.length > MAX_ENTRIES)
        return undefined;
    const entries = [];
    for (const value of row.entries) {
        if (!value || typeof value !== "object" || Array.isArray(value))
            return undefined;
        const entry = value;
        if (Object.keys(entry).some((key) => !["scope", "backend", "channel", "reason", "failures", "until", "lastAt", "updatedAt", "cleared"].includes(key)))
            return undefined;
        if (typeof entry.scope !== "string" || !/^[a-f0-9]{64}$/u.test(entry.scope) || !BACKENDS.has(entry.backend) ||
            (entry.channel !== "anonymous" && entry.channel !== "key") || !REASONS.has(entry.reason) ||
            !Number.isSafeInteger(entry.failures) || entry.failures < 0 || entry.failures > 1_000_000 ||
            ![entry.until, entry.lastAt, entry.updatedAt].every((n) => Number.isSafeInteger(n) && n >= 0) ||
            (entry.cleared !== undefined && typeof entry.cleared !== "boolean"))
            return undefined;
        entries.push({ scope: entry.scope, backend: entry.backend, channel: entry.channel, reason: entry.reason,
            failures: entry.failures, until: entry.until, lastAt: entry.lastAt, updatedAt: entry.updatedAt,
            ...(entry.cleared === true ? { cleared: true } : {}) });
    }
    return { version: 1, salt: row.salt, entries };
}
async function ensureDirectory(base) {
    const absolute = resolve(base);
    if (absolute === parse(absolute).root)
        throw new Error(SAFE);
    let current = parse(absolute).root;
    for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
        current = join(current, part);
        let created = false;
        try {
            await lstat(current);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            try {
                await mkdir(current, { mode: 0o700 });
                created = true;
            }
            catch (createError) {
                if (createError.code !== "EEXIST")
                    throw createError;
            }
        }
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error(SAFE);
        if (current === absolute && (owner() === undefined || stat.uid !== owner() || (Number(stat.mode) & 0o077) !== 0))
            throw new Error(SAFE);
        if (created && (stat.mode & 0o077) !== 0)
            throw new Error(SAFE);
    }
}
async function readSecure(path, maxBytes) {
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw new Error(SAFE);
    }
    try {
        const before = await lstat(path);
        const stat = await handle.stat();
        if (!safeMode(stat) || before.isSymbolicLink() || before.dev !== stat.dev || before.ino !== stat.ino || stat.size > maxBytes)
            throw new Error(SAFE);
        const bytes = Buffer.alloc(maxBytes + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > maxBytes)
            throw new Error(SAFE);
        const after = await lstat(path);
        if (after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino)
            throw new Error(SAFE);
        return bytes.subarray(0, bytesRead);
    }
    finally {
        await handle.close();
    }
}
function parseLock(bytes) {
    try {
        const value = JSON.parse(bytes.toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value))
            return undefined;
        const row = value;
        if (Object.keys(row).length !== 3 || row.version !== 1 || !Number.isSafeInteger(row.pid) || row.pid < 1 ||
            typeof row.nonce !== "string" || !/^[a-f0-9]{48}$/u.test(row.nonce))
            return undefined;
        return { pid: row.pid, nonce: row.nonce };
    }
    catch {
        return undefined;
    }
}
async function lockRecord(path) {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile() || (owner() !== undefined && before.uid !== owner()) || (before.mode & 0o077) !== 0 || before.size > 512)
        throw new Error(SAFE);
    const bytes = await readSecure(path, 512);
    if (bytes === undefined)
        return undefined;
    const record = parseLock(bytes);
    const after = await lstat(path);
    if (!record || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino)
        throw new Error(SAFE);
    return { stat: after, record };
}
function definitelyExited(pid) {
    try {
        process.kill(pid, 0);
        return false;
    }
    catch (error) {
        return error.code === "ESRCH";
    }
}
async function recoverDeadLock(path) {
    // 单独的排他恢复门闩避免多个回收者误删新持有者的主锁。
    // 门闩自身损坏或崩溃遗留时失败关闭，不递归偷取未知锁。
    const gatePath = `${path}.recovery`;
    let gate;
    try {
        gate = await open(gatePath, "wx+", 0o600);
    }
    catch (error) {
        if (error.code === "EEXIST")
            return false;
        throw error;
    }
    const nonce = randomBytes(24).toString("hex");
    const gateStat = await gate.stat();
    try {
        if (!safeMode(gateStat))
            throw new Error(SAFE);
        await gate.writeFile(JSON.stringify({ version: 1, pid: process.pid, nonce }), "utf8");
        await gate.sync();
        // 正常持有者也可能在检查期间释放或替换文件；此时重试而非永久降级。
        // 无法确认的格式、权限或存活状态均不删除，最终有界失败。
        try {
            return await recoverObservedLock(path);
        }
        catch {
            return false;
        }
    }
    finally {
        await releaseLock(gatePath, { handle: gate, dev: gateStat.dev, ino: gateStat.ino, nonce });
    }
}
async function recoverObservedLock(path) {
    let observed;
    try {
        observed = await lockRecord(path);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
    if (!observed || observed.record.pid === process.pid || !definitelyExited(observed.record.pid))
        return false;
    const held = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const stat = await held.stat();
        if (stat.dev !== observed.stat.dev || stat.ino !== observed.stat.ino || !safeMode(stat))
            return false;
        const buf = Buffer.alloc(512);
        const { bytesRead } = await held.read(buf, 0, buf.length, 0);
        const again = parseLock(buf.subarray(0, bytesRead));
        const current = await lstat(path);
        if (!again || again.pid !== observed.record.pid || again.nonce !== observed.record.nonce || current.isSymbolicLink() ||
            current.dev !== stat.dev || current.ino !== stat.ino || !definitelyExited(again.pid))
            return false;
        await unlink(path);
        return true;
    }
    finally {
        await held.close();
    }
}
async function acquireLock(path, signal) {
    const nonce = randomBytes(24).toString("hex");
    const end = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        abortCheck(signal);
        try {
            const handle = await open(path, "wx+", 0o600);
            try {
                await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, nonce }), "utf8");
                await handle.sync();
                const stat = await handle.stat();
                if (!safeMode(stat))
                    throw new Error(SAFE);
                return { handle, dev: stat.dev, ino: stat.ino, nonce };
            }
            catch (error) {
                await handle.close();
                throw error;
            }
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            if (await recoverDeadLock(path))
                continue;
            if (Date.now() >= end)
                throw new Error(SAFE);
            await new Promise((resolveDelay, reject) => {
                const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolveDelay(); }, 10);
                const stop = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); reject(new StateCancelled()); };
                signal?.addEventListener("abort", stop, { once: true });
                if (signal?.aborted)
                    stop();
            });
        }
    }
}
async function releaseLock(path, held) {
    try {
        const stat = await lstat(path);
        const bytes = await readSecure(path, 512);
        const record = bytes === undefined ? undefined : parseLock(bytes);
        if (!stat.isSymbolicLink() && stat.isFile() && stat.dev === held.dev && stat.ino === held.ino && record?.pid === process.pid && record.nonce === held.nonce) {
            await unlink(path);
        }
    }
    finally {
        await held.handle.close().catch(() => undefined);
    }
}
function mergeEntry(oldEntry, incoming) {
    if (!oldEntry)
        return { ...incoming };
    if (oldEntry.cleared || incoming.cleared) {
        if (incoming.updatedAt > oldEntry.updatedAt)
            return { ...incoming };
        if (oldEntry.updatedAt > incoming.updatedAt)
            return { ...oldEntry };
        if (oldEntry.cleared !== incoming.cleared)
            return oldEntry.cleared ? { ...incoming } : { ...oldEntry };
    }
    const latest = incoming.updatedAt > oldEntry.updatedAt ? incoming : oldEntry;
    return { ...latest, failures: Math.max(oldEntry.failures, incoming.failures), until: Math.max(oldEntry.until, incoming.until), lastAt: Math.max(oldEntry.lastAt, incoming.lastAt) };
}
async function atomicWrite(path, state, signal) {
    abortCheck(signal);
    const tmp = join(dirname(path), `.dsh-state-tmp-${process.pid}-${randomBytes(12).toString("hex")}`);
    const handle = await open(tmp, "wx", 0o600);
    let created;
    let renamed = false;
    try {
        created = await handle.stat();
        abortCheck(signal);
        await handle.writeFile(JSON.stringify(state), "utf8");
        abortCheck(signal);
        await handle.sync();
        await handle.close();
        abortCheck(signal);
        const stat = await lstat(tmp);
        if (!safeMode(stat) || stat.dev !== created.dev || stat.ino !== created.ino)
            throw new Error(SAFE);
        abortCheck(signal);
        await rename(tmp, path);
        renamed = true;
    }
    finally {
        await handle.close().catch(() => undefined);
        if (!renamed && created) {
            // 仅清理由本次排他创建且身份、归属、权限仍匹配的临时文件。
            const stat = await lstat(tmp).catch(() => undefined);
            if (stat && safeMode(stat) && stat.dev === created.dev && stat.ino === created.ino)
                await unlink(tmp);
        }
    }
}
/** 显式路径才会访问磁盘；仅认可本项目协议文件，绝不 chmod 或追随链接。 */
export function createPrivateStateStore(directory, options = {}) {
    const base = resolve(directory);
    const statePath = join(base, "state.json");
    const lockPath = join(base, ".quota-state.lock");
    const unsupported = (options.platform ?? process.platform) === "win32" || owner() === undefined;
    let blocked = false;
    const withLock = async (signal, fn) => {
        abortCheck(signal);
        await ensureDirectory(base);
        abortCheck(signal);
        const lock = await acquireLock(lockPath, signal);
        try {
            abortCheck(signal);
            return await fn();
        }
        finally {
            await releaseLock(lockPath, lock);
        }
    };
    const readState = async (signal) => {
        abortCheck(signal);
        const directory = await opendir(base);
        for await (const entry of directory) {
            abortCheck(signal);
            if (!["state.json", ".quota-state.lock", ".quota-state.lock.recovery"].includes(entry.name))
                throw new Error(SAFE);
        }
        const bytes = await readSecure(statePath, MAX_BYTES);
        abortCheck(signal);
        if (bytes === undefined)
            return undefined;
        let value;
        try {
            value = JSON.parse(bytes.toString("utf8"));
        }
        catch {
            throw new Error(SAFE);
        }
        const state = validateState(value);
        if (!state)
            throw new Error(SAFE);
        return state;
    };
    return {
        async load(signal) {
            if (signal?.aborted)
                return { status: "cancelled" };
            if (unsupported)
                return { status: "unavailable", reason: "unsupported_platform" };
            if (blocked)
                return { status: "unavailable" };
            try {
                const state = await withLock(signal, async () => {
                    const loaded = await readState(signal);
                    if (loaded)
                        return loaded;
                    const initial = { version: 1, salt: randomBytes(32).toString("base64"), entries: [] };
                    await atomicWrite(statePath, initial, signal);
                    return initial;
                });
                abortCheck(signal);
                return { status: "ok", state };
            }
            catch (error) {
                if (error instanceof StateCancelled)
                    return { status: "cancelled" };
                blocked = true;
                return { status: "unavailable" };
            }
        },
        async save(next, signal) {
            if (signal?.aborted)
                return "cancelled";
            if (blocked || unsupported)
                return "unavailable";
            try {
                const checked = validateState(next);
                if (!checked)
                    return "unavailable";
                return await withLock(signal, async () => {
                    const current = await readState(signal);
                    if (!current || current.salt !== checked.salt)
                        return "unavailable";
                    const merged = new Map(current.entries.map((entry) => [`${entry.scope}:${entry.reason}`, entry]));
                    for (const entry of checked.entries) {
                        const key = `${entry.scope}:${entry.reason}`;
                        merged.set(key, mergeEntry(merged.get(key), entry));
                    }
                    if (merged.size > MAX_ENTRIES)
                        return "unavailable";
                    await atomicWrite(statePath, { version: 1, salt: checked.salt, entries: [...merged.values()] }, signal);
                    return "saved";
                });
            }
            catch (error) {
                return error instanceof StateCancelled ? "cancelled" : "unavailable";
            }
        },
    };
}
