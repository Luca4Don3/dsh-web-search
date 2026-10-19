/**
 * Web Search 系统密钥库访问层
 *
 * 负责系统密钥库中 API key 的读、写、删。支持的平台：
 * - macOS：`/usr/bin/security` 读取/删除，静态 Swift Security 适配器写入
 * - Linux：`secret-tool`（Secret Service）
 * - 其他平台：不支持，只能使用环境变量
 *
 * 安全约束（务必保持）：
 * - key 只通过 stdin 传递；绝不进入 argv、日志、会话或错误信息。
 * - 错误信息只含退出码，不含 stdout / stderr 内容。
 * - 读取失败（命令缺失、密钥库锁定、权限不足）与「没有条目」必须区分：
 *   前者返回 unavailable，后者返回 missing。
 *
 * 该模块可注入 runner 与平台，测试用 fake 覆盖，不触碰真实 Keychain / Secret Service。
 *
 * @module pi-web-search-credentials
 */
import type { ProviderId } from "../search/contracts.js";
/** 与搜索注册表保持一致的凭据后端标识。 */
export type SecretBackend = ProviderId;
/** 凭据最长长度；仅接受非空、无空白的 ASCII 可打印 token。 */
export declare const MAX_SECRET_CHARS = 4096;
/** 校验凭据，不截断、不规范化，也不包含凭据内容的错误信息。 */
export declare function isValidSecretValue(value: unknown): value is string;
/** 系统密钥库的 service 前缀；条目名为 `${SECRET_SERVICE_PREFIX}-${backend}`。 */
export declare const SECRET_SERVICE_PREFIX = "pi-web-search";
/** Linux Secret Service 用来归组条目的 service 属性值。 */
export declare const SECRET_TOOL_SERVICE = "pi-web-search";
/** 一次子进程调用的结果；仅保留退出码与输出供内部判断。 */
export interface ExecResult {
    /** 进程退出码，spawn 失败时为 1。 */
    code: number;
    /** stdout（读取密码时即密码本身，绝不可外传）。 */
    stdout: string;
    /** stderr（可能包含系统提示，绝不可外传）。 */
    stderr: string;
}
/** 可注入的子进程执行器，便于测试。 */
export type ExecRunner = (bin: string, args: string[], stdin?: string, timeoutMs?: number, signal?: AbortSignal) => Promise<ExecResult>;
/** 读取结果三态：找到 / 无条目 / 不可用（含诊断原因）。 */
export type SecretReadResult = {
    status: "found";
    value: string;
} | {
    status: "missing";
} | {
    status: "unavailable";
    reason: string;
};
/** 删除结果三态：已删除 / 无条目 / 不可用（含诊断原因）。 */
export type SecretClearResult = {
    status: "deleted";
} | {
    status: "missing";
} | {
    status: "unavailable";
    reason: string;
};
/** 写入结果；验证失败或密钥库不可用时绝不报告成功。 */
export type SecretWriteResult = {
    status: "written";
} | {
    status: "unavailable";
    reason: string;
};
/** 凭据存储抽象；测试注入 fake，生产按平台选择实现。 */
export interface SecretStore {
    /** 实际使用的密钥库类型；none 表示该平台没有系统密钥库。 */
    readonly kind: "keychain" | "secret-tool" | "none";
    /** 读取某个后端的 key；不可用或失败时返回 unavailable，绝不抛错。 */
    read(backend: SecretBackend, signal?: AbortSignal): Promise<SecretReadResult>;
    /** 写入某个后端的 key，并从密钥库重读验证；失败时返回 unavailable，绝不抛错。 */
    write(backend: SecretBackend, value: string): Promise<SecretWriteResult>;
    /** 删除某个后端的 key；失败时返回 unavailable，绝不抛错。 */
    clear(backend: SecretBackend): Promise<SecretClearResult>;
}
/** 单次密钥库命令的最长执行时间，超时即杀掉子进程并按不可用处理。 */
export declare const EXEC_TIMEOUT_MS = 5000;
/** Swift 首次解释/编译适配器可能较慢，写入单独给予更长超时。 */
export declare const WRITE_EXEC_TIMEOUT_MS = 30000;
/**
 * 真实执行一个子进程。
 * stdin 只在需要时写入并立即关闭；stdout / stderr 只缓存在内存，
 * 由调用方决定是否使用，不会进入日志。
 * 超过 timeoutMs 仍未结束时杀掉子进程并 reject（由调用方归为 unavailable），
 * 避免密钥库挂起把整个搜索或菜单永久卡住。
 */
export declare function spawnExec(bin: string, args: string[], stdin?: string, timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;
/** 取配置账号名：优先 $USER，回退系统用户名。与配置命令里的 `-a "$USER"` 对齐。 */
export declare function currentAccount(): string;
/** macOS Keychain 实现。 */
export declare class MacKeychainStore implements SecretStore {
    private readonly run;
    private readonly account;
    readonly kind: "keychain";
    constructor(run?: ExecRunner, account?: string);
    read(backend: SecretBackend, signal?: AbortSignal): Promise<SecretReadResult>;
    write(backend: SecretBackend, value: string): Promise<SecretWriteResult>;
    clear(backend: SecretBackend): Promise<SecretClearResult>;
    /** 返回执行结果，或命令缺失时的诊断文本。 */
    private call;
    private service;
}
/** Linux Secret Service（secret-tool）实现。 */
export declare class SecretToolStore implements SecretStore {
    private readonly run;
    readonly kind: "secret-tool";
    constructor(run?: ExecRunner);
    read(backend: SecretBackend, signal?: AbortSignal): Promise<SecretReadResult>;
    write(backend: SecretBackend, value: string): Promise<SecretWriteResult>;
    clear(backend: SecretBackend): Promise<SecretClearResult>;
    private call;
}
/** 无系统密钥库的平台：读取、写入、删除均返回 unavailable。 */
export declare class NoopSecretStore implements SecretStore {
    private readonly platform;
    readonly kind: "none";
    constructor(platform?: string);
    private get reason();
    read(_backend: SecretBackend, _signal?: AbortSignal): Promise<SecretReadResult>;
    write(_backend: SecretBackend, _value: string): Promise<SecretWriteResult>;
    clear(_backend: SecretBackend): Promise<SecretClearResult>;
}
/** 按平台选择系统密钥库实现。 */
export declare function createSecretStore(platform?: string, run?: ExecRunner): SecretStore;
