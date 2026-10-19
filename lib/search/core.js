/** 带分类的错误；请求层回填实际尝试次数。 */
export class BackendError extends Error {
    kind;
    retryAfterMs;
    attempts = 0;
    constructor(message, kind, retryAfterMs) {
        super(message);
        this.kind = kind;
        this.retryAfterMs = retryAfterMs;
        this.name = "BackendError";
    }
    get retryable() {
        return this.kind === "rate_limited" || this.kind === "server_error" || this.kind === "network_error";
    }
}
export function statusKind(status) {
    if (status === 401 || status === 403)
        return "invalid_key";
    if (status === 402)
        return "quota_exhausted";
    if (status === 429)
        return "rate_limited";
    if (status >= 500)
        return "server_error";
    return "protocol_error";
}
export function messageKind(message) {
    const text = message.toLowerCase();
    // 中文额度提示也必须被识别；此前只覆盖英文关键词，会把额度错误误判为协议错误。
    if (/quota|credit|balance|insufficient|payment required|no remaining|(?:ran|run) out of searches|monthly.*limit|额度|余额不足|积分不足/.test(text)) {
        return "quota_exhausted";
    }
    if (/rate limit|too many requests|限流|请求过多/.test(text))
        return "rate_limited";
    if (/unauthoriz|forbidden|invalid api key|authentication|api key/.test(text))
        return "invalid_key";
    return undefined;
}
export function httpKind(status, detail) {
    return messageKind(detail) ?? statusKind(status);
}
/** 只接受可点击的网页链接，不把脚本、本地文件或内联数据当作来源。 */
/** 只接受不含内嵌凭据的 http(s) 链接：`https://user:pass@host` 不是可引用来源。 */
export function isHttpUrl(value) {
    try {
        const url = new URL(value);
        if (url.username.length > 0 || url.password.length > 0)
            return false;
        return url.protocol === "http:" || url.protocol === "https:";
    }
    catch {
        return false;
    }
}
/** 提取各服务的错误文本；调用方必须在输出前脱敏。 */
export function errorDetailFrom(payload) {
    if (payload === null || typeof payload !== "object")
        return undefined;
    const record = payload;
    for (const candidate of [record.error, record.detail]) {
        if (typeof candidate === "string" && candidate.length > 0)
            return candidate;
        if (candidate !== null && typeof candidate === "object") {
            const inner = candidate;
            for (const value of [inner.message, inner.error]) {
                if (typeof value === "string" && value.length > 0)
                    return value;
            }
        }
    }
    return typeof record.message === "string" && record.message.length > 0 ? record.message : undefined;
}
