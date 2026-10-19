function readInteger(env, name, fallback, min, max) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "")
        return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} 配置无效：必须是 ${min}..${max} 范围内的安全整数`);
    }
    return value;
}
export function readSearchRequestConfig(env = process.env) {
    return {
        retries: readInteger(env, "PI_WEB_SEARCH_RETRIES", 1, 0, 3),
        // 与内核的接受范围保持一致：外层放行的值不应在内核处被二次拒绝。
        timeoutMs: readInteger(env, "PI_WEB_SEARCH_TIMEOUT_MS", 25_000, 100, 120_000),
        totalTimeoutMs: readInteger(env, "PI_WEB_SEARCH_TOTAL_TIMEOUT_MS", 90_000, 1_000, 600_000),
    };
}
