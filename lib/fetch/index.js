/**
 * 抓取内核：本地优先读取公开网页并输出可读 Markdown。
 *
 * - 只读取调用方给出的公开 URL，不执行网页脚本，不携带 Cookie / Authorization。
 * - 初始解析、逐跳重定向、连接与正文读取共享同一绝对截止时间。
 * - 同步提取前后检查截止时间，不返回过期结果；不启用任何远程回退。
 * - 与宿主无关：DSH 适配层把它包装成 `ctx.web` 的 fetch provider，
 *   Pi 适配层把它包装成 `web_fetch` 工具。
 */
import { FetchError } from "./errors.js";
import { resolveFetchTarget } from "./transport/url-policy.js";
import { httpFetch } from "./transport/http-client.js";
import { createFetchDeadline } from "./transport/deadline.js";
import { extractContent } from "./extract/index.js";
export { FetchError };
/** 只保留来源与路径：签名 URL、令牌等查询参数不得进入对外结果。 */
export function safeDisplayUrl(value) {
    return `${value.origin}${value.pathname}`;
}
/** 抓取一个公开 URL；配置由调用方读取并传入，内核不读环境变量。 */
export async function fetchPage(request, config, dependencies = {}, signal) {
    const startedAt = Date.now();
    if (signal?.aborted)
        throw new FetchError("操作已取消", "aborted", {});
    const url = typeof request.url === "string" ? request.url.trim() : "";
    if (url.length === 0)
        throw new FetchError("url 不能为空", "invalid_url", {});
    const mode = request.mode ?? "auto";
    const maxChars = request.maxChars ?? config.maxChars;
    if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 200_000) {
        throw new FetchError("maxChars 超出允许范围", "invalid_url", {});
    }
    if (mode !== "auto" && mode !== "article" && mode !== "text")
        throw new FetchError("mode 不受支持", "invalid_url", {});
    // 先做完整的目标校验，再决定是否发起任何连接。
    const resolveTarget = dependencies.resolveTarget ?? resolveFetchTarget;
    const deadline = createFetchDeadline(config.timeoutMs, signal);
    try {
        const target = await deadline.run(() => resolveTarget(url, deadline.signal));
        const fetchPageImpl = dependencies.fetchPage ?? ((input) => httpFetch({
            url: input.url,
            target: { url: input.url, address: input.target.address, family: input.target.family },
            signal: input.signal,
            timeoutMs: input.timeoutMs,
            deadlineMs: input.deadlineMs,
            maxResponseBytes: input.maxResponseBytes,
            maxRedirects: input.maxRedirects,
            resolveTarget,
        }).then((result) => ({
            body: result.body,
            contentType: result.headers["content-type"] ?? "",
            finalUrl: result.finalUrl,
            redirectCount: result.redirectCount,
            statusCode: result.status,
        })));
        const fetched = await deadline.run(() => fetchPageImpl({
            url: target.url,
            target,
            signal: deadline.signal,
            timeoutMs: config.timeoutMs,
            deadlineMs: deadline.deadlineMs,
            maxResponseBytes: config.maxResponseBytes,
            maxRedirects: config.maxRedirects,
        }));
        const extract = dependencies.extract ?? extractContent;
        deadline.check();
        // 把截止时间检查传进提取流水线：同步转换无法被定时器抢占，
        // 只能在阶段之间主动检查，否则 5MB 页面会连续阻塞到超时之后。
        const extracted = extract(fetched.body, fetched.contentType, mode, maxChars, fetched.finalUrl, deadline.check);
        // 同步提取不可被计时器抢占，完成后必须检查真实时钟，不返回过期正文。
        deadline.check();
        return {
            requestedUrl: safeDisplayUrl(target.url),
            finalUrl: safeDisplayUrl(fetched.finalUrl),
            contentType: fetched.contentType,
            statusCode: fetched.statusCode,
            redirectCount: fetched.redirectCount,
            ...(extracted.title === undefined ? {} : { title: extracted.title }),
            markdown: extracted.markdown,
            extractedChars: extracted.markdown.length,
            truncated: extracted.truncated,
            durationMs: Date.now() - startedAt,
        };
    }
    finally {
        deadline.dispose();
    }
}
