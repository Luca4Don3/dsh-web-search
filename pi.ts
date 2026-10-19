/**
 * Pi 扩展入口。
 *
 * Pi 的包管理器按 `package.json` 的 `pi.extensions` 加载本文件，
 * 因此这里只引入 Pi 宿主适配层，绝不触碰任何 DSH 专属依赖。
 *
 * 同一个包在 DSH 侧由 `lib/index.js`（Cordis 插件）加载，
 * 两边共享 `src/` 下的宿主无关内核。
 *
 * @module dsh-web-search/pi-entry
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piWebSearch, { type PiWebSearchOptions } from "./src/hosts/pi.js";
import piWebFetch, { type WebFetchOptions } from "./src/hosts/pi-fetch.js";

export interface PiEntryOptions extends PiWebSearchOptions, WebFetchOptions {}

/**
 * 注册 `web_search` 与 `web_fetch` 两个工具，以及 `/web-search-auth` 命令。
 *
 * 两个工具各自独立注册与测试；这里只做组合，失败时不会静默吞掉另一半。
 */
export default function dshWebSearch(pi: ExtensionAPI, options: PiEntryOptions = {}): void {
	piWebSearch(pi, options);
	piWebFetch(pi, options);
}

export { piWebSearch, piWebFetch };
