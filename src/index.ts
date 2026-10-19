/**
 * DSH 入口：注册搜索与抓取两个提供方。
 *
 * 宿主无关的内核在 `./search` 与 `./fetch`；Pi 入口在 `./hosts/pi`，
 * 通过包的 `./pi` 子路径导出。
 */
export { apply, createPlugin, name, inject, Config, PROVIDER_ID, FETCH_PROVIDER_ID, defaultStateDirectory } from "./hosts/dsh.js";
export type { DshConfig } from "./hosts/dsh.js";
export { FreeFirstProvider, LocalFirstFetchProvider } from "./hosts/dsh.js";
export { createSearchEngine } from "./search/engine.js";
export { fetchPage } from "./fetch/index.js";
