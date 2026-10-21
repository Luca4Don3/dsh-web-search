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
import piWebSearch, { type WebSearchOptions } from "./src/hosts/pi.js";
import piWebFetch, { type WebFetchOptions } from "./src/hosts/pi-fetch.js";

/**
 * 两个适配层的选项合并。两侧字段互不重叠：
 * 搜索侧是凭据存储 / 额度管理器 / 时钟，抓取侧是解析与传输注入点。
 */
export type PiEntryOptions = WebSearchOptions & WebFetchOptions;

/**
 * 确保本扩展注册的工具出现在激活列表里。
 *
 * Pi 恢复旧会话时会用会话记录里的 `toolsAdded` 覆盖工具集：如果会话创建时
 * `web_fetch` 还不存在，恢复后即使扩展已经注册了它，它也不会被激活。
 * 这里只补本扩展自己的工具，不触碰其他扩展或内置工具。
 */
function ensureOwnToolsActive(pi: ExtensionAPI): void {
	const wanted = ["web_search", "web_fetch"] as const;
	const active = pi.getActiveTools();
	const missing = wanted.filter((name) => !active.includes(name));
	if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
}

/**
 * 注册 `web_search` 与 `web_fetch` 两个工具，以及 `/web-search-auth` 命令。
 *
 * 两个工具各自独立注册与测试；这里只做组合，失败时不会静默吞掉另一半。
 */
export default function dshWebSearch(pi: ExtensionAPI, options: PiEntryOptions = {}): void {
	piWebSearch(pi, options);
	piWebFetch(pi, options);
	// 加载阶段 runtime 尚未绑定，getActiveTools 会抛错；等会话事件再补。
	// session_start 覆盖启动与恢复，session_tree 覆盖 fork / switchSession 后的重新恢复。
	const restore = (): void => {
		try {
			ensureOwnToolsActive(pi);
		} catch {
			// 事件触发时 runtime 仍不可用：下一个会话事件会重试。
		}
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);
}

export { piWebSearch, piWebFetch };
