/**
 * Web Search 认证语义层
 *
 * 把「key 从哪来、当前是什么状态、如何安全地配置」收敛到一处，供工具入口与
 * `/web-search-auth` 菜单共用：
 * - 解析顺序固定为「环境变量优先，其次系统密钥库」。
 * - 每次搜索只为可能用到的后端各解析一次，结果只在内存中流转。
 * - 系统密钥库读取失败不阻断匿名搜索，但状态要在菜单里区分
 *   unavailable（密钥库不可用）与 not_configured（可用但没配）。
 * - 所有对外文本（错误、说明）都经 {@link redactSecrets} 处理，key 永不外泄。
 *
 * @module pi-web-search-auth
 */
import { redactSecrets } from "../shared/redact.js";
import { type SecretBackend, type SecretStore } from "./credentials.js";
/** 后端标识（与存储层共用）。 */
export type Backend = SecretBackend;
/** 凭据来源。 */
export type AuthSource = "env" | "keychain" | "secret-tool";
/** 单个后端的认证状态。 */
export interface BackendStatus {
    backend: Backend;
    /** configured：已配置；not_configured：密钥库可用但无条目；credential_free：零凭据通道，无需密钥；unavailable：密钥库不可用。 */
    state: "configured" | "not_configured" | "credential_free" | "unavailable";
    /** 仅在 configured 时给出凭据来源。 */
    source?: AuthSource;
    /** 仅在 unavailable 时给出不含敏感信息的诊断原因。 */
    reason?: string;
}
/** 认证菜单、凭据解析与搜索能力共用同一注册表。 */
export declare const BACKENDS: readonly Backend[];
/** 仅可能计费的后端进入凭据解析；纯匿名后端（如 TinyFish keyless）不读取任何密钥。 */
export declare const KEY_BACKENDS: readonly Backend[];
/** 运行时白名单，避免非法选择进入凭据操作。 */
export declare function isBackend(value: unknown): value is Backend;
/** 匿名能力来自注册表，不能以是否配置密钥判断费用。 */
export declare function hasFreeChannel(backend: Backend): boolean;
/** 后端对应的环境变量名。 */
export declare function envVarName(backend: Backend): string;
/** 不读取环境或密钥库的空凭据映射。 */
export declare function emptyPlanKeys(): Record<Backend, string | undefined>;
/** 读取环境变量中的 key；空白视为未配置。 */
export declare function envKey(backend: Backend): string | undefined;
/**
 * 解析单个后端的 key：环境变量优先，其次系统密钥库。
 * 任何读取失败都静默回退为 undefined，保证匿名搜索不被密钥库问题阻断。
 */
export declare function resolveBackendKey(backend: Backend, store: SecretStore, signal?: AbortSignal): Promise<string | undefined>;
/**
 * 为一次搜索解析路由所需的全部 key：每个可能用到的后端只读一次密钥库。
 * 显式指定后端时只解析该后端，auto 解析全部后端。
 */
export declare function resolvePlanKeys(provider: "auto" | Backend, store: SecretStore, signal?: AbortSignal): Promise<Record<Backend, string | undefined>>;
/** 查询单个后端的认证状态；不抛错，密钥库失败归入 unavailable。 */
export declare function probeBackendStatus(backend: Backend, store: SecretStore): Promise<BackendStatus>;
/**
 * 把可能混入的来源文本中的 key 抹掉。
 *
 * 实现已统一到 {@link ../shared/redact.js}：认证层与搜索内核共用同一份编码形态覆盖
 * （原文、JSON 转义、网址组件编码、标准表单编码、base64 及大小写混用）。
 * 这里只做转出，保持既有调用点不变。
 */
export { redactSecrets };
/** 单行诊断文本的长度上限。 */
export declare const MAX_DIAGNOSTIC_CHARS = 300;
/** 先脱敏、再截断，避免截断把 key 的片段留在文本里。 */
export declare function safeDiagnostic(error: unknown, secrets?: readonly (string | undefined)[]): string;
/** 一个后端的配置说明：命令只从 stdin / 交互提示读取 key，绝不放进参数。 */
export interface ConfigGuide {
    backend: Backend;
    kind: SecretStore["kind"];
    /** 供菜单显示的多行说明。 */
    lines: string[];
}
/** 生成单后端的配置说明（安全终端命令）。 */
export declare function configGuide(backend: Backend, kind: SecretStore["kind"]): ConfigGuide;
