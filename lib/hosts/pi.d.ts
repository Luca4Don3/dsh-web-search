/**
 * Pi Web Search 扩展
 *
 * 通过 JSON-RPC 2.0 直连 Exa / Parallel 的远程 MCP 端点，并直连 Tavily /
 * Firecrawl / SerpApi 的原生 HTTP 接口，为 Pi 提供统一的 `web_search` 工具。
 * 四个匿名通道默认启用；任何密钥通道都需要显式计费授权。
 *
 * 设计要点：
 * - 单请求预算可注入（默认 25 秒），外部取消信号会被转发且立即生效。
 * - 响应体既可能是直接 JSON，也可能是 SSE（`data:` 事件块），两种都解析。
 * - 所有匿名通道先于所有 Key 通道；默认禁止计费，所有真实 Key 均按可能计费处理。
 * - 失败按错误类型决策：额度/鉴权直接换通道，限流与 5xx 退避重试，取消立即终止。
 * - 模型可见正文截断到 MAX_TEXT_CHARS，原文落盘供模型按需 read。
 * - Exa / Parallel key 解析顺序：环境变量优先，其次系统密钥库
 *   （macOS Keychain / Linux secret-tool，用 `/web-search-auth` 查看与删除）。
 *   key 不写入 session、不进入命令行参数、不落盘；错误文本统一脱敏。
 *
 * @module pi-web-search
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type SecretStore } from "../auth/credentials.js";
import type { ChannelHealth } from "../search/channel-health.js";
import { createQuotaManager } from "../quota/core.js";
import type { SearchSource as WebSource } from "../search/contracts.js";
export type { WebSource };
/** 扩展的可注入选项（测试用）。 */
export interface WebSearchOptions {
    /** 系统密钥库；默认按平台选择（macOS Keychain / Linux secret-tool）。测试注入 fake，不触碰真实密钥库。 */
    credentialStore?: SecretStore;
    /** 可注入的旧式通道冷却状态；仅显式注入时与额度管理器双写兼容状态。 */
    channelHealth?: ChannelHealth;
    /** 可注入额度管理器；默认无注入的生产实例使用 Pi 私有配置目录持久化。 */
    quotaManager?: ReturnType<typeof createQuotaManager>;
    /** 与注入的旧式冷却状态共享测试时钟；不注入时使用真实时间。 */
    quotaClock?: () => number;
}
/** 注册 `web_search` 工具与 `/web-search-auth` 命令。 */
export default function piWebSearch(pi: ExtensionAPI, options?: WebSearchOptions): void;
