import { Type } from "typebox";
import { DEFAULT_MAX_CHARS, MAX_CHARS_LIMIT, readWebFetchConfig } from "../fetch/config.js";
import { FetchError } from "../fetch/errors.js";
import { FETCH_MODES } from "../fetch/params.js";
import { extractContent } from "../fetch/extract/index.js";
import { resolveFetchTarget } from "../fetch/transport/url-policy.js";
import { httpFetch } from "../fetch/transport/http-client.js";
import { fetchPage } from "../fetch/index.js";
/** web_fetch 工具的模型可见参数表。 */
export const WebFetchParams = Type.Object({
    url: Type.String({
        description: "The absolute http(s) URL to read. Only public addresses are reachable; private, loopback and cloud metadata addresses are refused.",
    }),
    mode: Type.Optional(Type.Union(FETCH_MODES.map((mode) => Type.Literal(mode)), {
        description: "How to extract the body. Defaults to auto.",
    })),
    maxChars: Type.Optional(Type.Integer({
        description: `Maximum characters of body text returned to the model. Defaults to ${DEFAULT_MAX_CHARS}.`,
        minimum: 1,
        maximum: MAX_CHARS_LIMIT,
    })),
});
/** 把配置读取收敛为一次调用，便于测试注入。 */
function resolveConfig(override) {
    try {
        const config = (override ?? readWebFetchConfig)();
        // 远程回退尚未实现：明确失败，而不是静默忽略。
        if (config.remoteFallback !== "off")
            throw new FetchError("远程回退尚未实现，请将 PI_WEB_FETCH_REMOTE_FALLBACK 设为 off", "remote_blocked");
        return config;
    }
    catch (error) {
        if (error instanceof FetchError && error.kind === "remote_blocked")
            throw error;
        throw new FetchError("web_fetch 配置无效", "blocked_url", {});
    }
}
/** 注册 `web_fetch` 工具。 */
export default function piWebFetch(pi, options = {}) {
    pi.registerTool({
        name: "web_fetch",
        label: "Web Fetch",
        description: "读取一个公开 URL 并返回适合模型阅读的正文。本地直接抓取优先，不执行网页脚本，不携带任何凭据；私有与内网地址一律拒绝。",
        parameters: WebFetchParams,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        async execute(_toolCallId, params, signal) {
            const startedAt = Date.now();
            if (signal?.aborted)
                throw new FetchError("操作已取消", "aborted", {});
            const config = resolveConfig(options.config);
            const url = typeof params.url === "string" ? params.url.trim() : "";
            if (url.length === 0)
                throw new FetchError("url 不能为空", "invalid_url", {});
            const mode = params.mode ?? "auto";
            const maxChars = params.maxChars ?? config.maxChars;
            if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > MAX_CHARS_LIMIT) {
                throw new FetchError("maxChars 超出允许范围", "invalid_url", {});
            }
            if (mode !== "auto" && mode !== "article" && mode !== "text")
                throw new FetchError("mode 不受支持", "invalid_url");
            // 全部执行逻辑由内核完成：本层不再自行编排截止时间、重定向与提取。
            const outcome = await fetchPage({ url, mode: mode, maxChars }, config, {
                ...(options.resolveTarget === undefined ? {} : { resolveTarget: options.resolveTarget }),
                ...(options.fetchPage === undefined ? {} : { fetchPage: options.fetchPage }),
                ...(options.extract === undefined ? {} : { extract: options.extract }),
            }, signal);
            return {
                content: [{ type: "text", text: outcome.markdown }],
                details: {
                    requestedUrl: outcome.requestedUrl,
                    finalUrl: outcome.finalUrl,
                    contentType: outcome.contentType,
                    statusCode: outcome.statusCode,
                    redirectCount: outcome.redirectCount,
                    ...(outcome.title === undefined ? {} : { title: outcome.title }),
                    provider: "direct",
                    extractedChars: outcome.extractedChars,
                    truncated: outcome.truncated,
                    durationMs: Date.now() - startedAt,
                },
            };
        },
    });
}
export { extractContent, resolveFetchTarget, httpFetch };
