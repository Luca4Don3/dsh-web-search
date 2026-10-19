/** 按后端与认证通道隔离的进程内冷却状态。 */
import { BACKENDS } from "../auth/resolve.js";
const DEFAULT_COOLDOWN_MS = 1_800_000;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
function validateCooldown(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COOLDOWN_MS) {
        throw new Error("通道冷却时长必须为 0 到 86400000 之间的安全整数");
    }
}
function stateKey(backend, channel) {
    return `${backend}:${channel}`;
}
/** 创建独立的内存状态；不同实例不会共享冷却记录。 */
export function createChannelHealth(options = {}) {
    const defaultCooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    validateCooldown(defaultCooldownMs);
    const clock = options.clock ?? Date.now;
    const entries = new Map();
    const getCooldown = (backend, channel) => {
        const key = stateKey(backend, channel);
        const entry = entries.get(key);
        if (entry === undefined)
            return undefined;
        const now = clock();
        if (entry.until <= now) {
            entries.delete(key);
            return undefined;
        }
        return { ...entry, remainingMs: entry.until - now };
    };
    return {
        cooldownMs: defaultCooldownMs,
        getCooldown,
        recordFailure(backend, channel, reason, failureOptions = {}) {
            const configuredMs = failureOptions.cooldownMs ?? defaultCooldownMs;
            validateCooldown(configuredMs);
            const duration = failureOptions.retryAfterMs ?? configuredMs;
            if (!Number.isSafeInteger(duration) || duration < 0) {
                throw new Error("Retry-After 冷却时长必须为非负安全整数");
            }
            const key = stateKey(backend, channel);
            if (configuredMs === 0 || duration === 0) {
                entries.delete(key);
                return undefined;
            }
            const now = clock();
            const until = Math.min(Number.MAX_SAFE_INTEGER, now + Math.min(duration, MAX_COOLDOWN_MS));
            const entry = {
                backend,
                channel,
                coolingDown: true,
                until,
                remainingMs: Math.max(0, until - now),
                reason,
            };
            entries.set(key, entry);
            return { ...entry };
        },
        recordSuccess(backend, channel) {
            entries.delete(stateKey(backend, channel));
        },
        snapshot() {
            const channels = [];
            for (const backend of BACKENDS) {
                for (const channel of ["free", "key"]) {
                    const entry = getCooldown(backend, channel);
                    if (entry !== undefined)
                        channels.push(entry);
                }
            }
            return { cooldownMs: defaultCooldownMs, channels };
        },
    };
}
