/**
 * `/web-search-auth` 命令的交互菜单
 *
 * - 状态：区分凭据来源、路由策略、付费开关与独立通道冷却。
 * - 添加 / 修改：仅在终端模式中使用自绘掩码组件，二次确认后写入系统密钥库。
 * - 删除：二次确认后只删除系统密钥库条目，环境变量不受影响。
 * - 不支持安全输入或系统密钥库时明确失败，不退化为明文输入或明文文件。
 *
 * @module pi-web-search-auth-ui
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type SecretStore } from "./credentials.js";
import { type RoutingStatus } from "../search/routing.js";
/** 认证命令名。 */
export declare const AUTH_COMMAND = "web-search-auth";
/** 搜索与认证菜单共用同一实例的状态，仅返回无凭据的数据。 */
export type RoutingStatusReader = () => RoutingStatus;
/** 注册 `/web-search-auth` 命令。 */
export declare function registerAuthCommand(pi: ExtensionAPI, store: SecretStore, readStatus?: RoutingStatusReader): void;
