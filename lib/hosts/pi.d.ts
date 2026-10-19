import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type SecretStore } from "../auth/credentials.js";
import type { ChannelHealth } from "../search/channel-health.js";
import { createQuotaManager } from "../quota/core.js";
import { getProviderMetadata } from "../search/registry.js";
import type { SearchSource as WebSource } from "../search/contracts.js";
export type { WebSource };
/** Pi 端的默认状态目录：`$PI_AGENT_DIR/config/web-search`。 */
export declare function piStateDirectory(): string;
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
export { getProviderMetadata };
