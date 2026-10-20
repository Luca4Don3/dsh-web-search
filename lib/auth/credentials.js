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
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
/** 凭据最长长度；仅接受非空、无空白的 ASCII 可打印 token。 */
export const MAX_SECRET_CHARS = 4096;
/** 校验凭据，不截断、不规范化，也不包含凭据内容的错误信息。 */
export function isValidSecretValue(value) {
    return (typeof value === "string" &&
        value.length > 0 &&
        value.length <= MAX_SECRET_CHARS &&
        /^[\x21-\x7E]+$/u.test(value));
}
/** 系统密钥库的 service 前缀；条目名为 `${SECRET_SERVICE_PREFIX}-${backend}`。 */
export const SECRET_SERVICE_PREFIX = "pi-web-search";
/** Linux Secret Service 用来归组条目的 service 属性值。 */
export const SECRET_TOOL_SERVICE = "pi-web-search";
function invalidSecretResult() {
    return { status: "unavailable", reason: "凭据无效（须为 1–4096 个非空白 ASCII 可打印字符）" };
}
/** macOS 系统自带的 security 命令行路径。 */
const SECURITY_BIN = "/usr/bin/security";
/** macOS security 的读取子命令。 */
const SECURITY_LOOKUP = "find-generic-password";
const SECURITY_DELETE = "delete-generic-password";
/** macOS Swift 解释器与静态 Security Framework 适配器。 */
const SWIFT_BIN = "/usr/bin/swift";
const MACOS_KEYCHAIN_HELPER = fileURLToPath(new URL("./macos-keychain.swift", import.meta.url));
/** Linux Secret Service 的命令行工具。 */
const SECRET_TOOL_BIN = "secret-tool";
/** macOS security 找不到条目时的退出码（errSecItemNotFound）。 */
const MAC_NOT_FOUND_EXIT = 44;
/** secret-tool lookup 无匹配时的退出码。 */
const SECRET_TOOL_NOT_FOUND_EXIT = 1;
/** 单次密钥库命令的最长执行时间，超时即杀掉子进程并按不可用处理。 */
export const EXEC_TIMEOUT_MS = 5_000;
/** Swift 首次解释/编译适配器可能较慢，写入单独给予更长超时。 */
export const WRITE_EXEC_TIMEOUT_MS = 30_000;
/**
 * 真实执行一个子进程。
 * stdin 只在需要时写入并立即关闭；stdout / stderr 只缓存在内存，
 * 由调用方决定是否使用，不会进入日志。
 * 超过 timeoutMs 仍未结束时杀掉子进程并 reject（由调用方归为 unavailable），
 * 避免密钥库挂起把整个搜索或菜单永久卡住。
 */
export function spawnExec(bin, args, stdin, timeoutMs = EXEC_TIMEOUT_MS, signal) {
    if (signal?.aborted)
        return Promise.reject(new DOMException("操作已取消", "AbortError"));
    return new Promise((resolve, reject) => {
        // 独立进程组：超时后要能终止整棵进程树。只 kill 直接子进程时，
        // 它派生的子进程仍会继续运行并可能访问密钥库，"超时即停止"不成立。
        const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timer;
        let onAbort;
        // 独立进程组不再接收终端 Ctrl+C；进程退出时补一次整组清理，
        // 避免宿主被中断后留下仍在访问密钥库的子进程。
        const onExit = () => {
            if (child.pid === undefined || process.platform === "win32")
                return;
            try {
                process.kill(-child.pid, "SIGKILL");
            }
            catch { /* 已退出 */ }
        };
        process.on("exit", onExit);
        /** 只允许第一个结果生效，并清理本次调用创建的定时器和取消监听。 */
        const finish = (settle) => {
            if (settled)
                return;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            if (onAbort !== undefined)
                signal?.removeEventListener("abort", onAbort);
            process.removeListener("exit", onExit);
            settle();
        };
        const kill = () => {
            if (child.pid !== undefined) {
                if (process.platform === "win32") {
                    // Windows 没有进程组信号：用 taskkill 终止整棵进程树。
                    try {
                        spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" }).unref();
                        return;
                    }
                    catch {
                        // 退回直接终止。
                    }
                }
                else {
                    try {
                        process.kill(-child.pid, "SIGKILL");
                        return;
                    }
                    catch {
                        // 进程组可能已不存在，继续尝试直接终止。
                    }
                }
            }
            try {
                child.kill("SIGKILL");
            }
            catch {
                // 子进程可能已退出；取消/超时仍按固定错误结束。
            }
        };
        timer = setTimeout(() => {
            kill();
            finish(() => reject(new Error(`凭据库命令超时（超过 ${timeoutMs}ms）`)));
        }, timeoutMs);
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("error", (error) => finish(() => reject(error)));
        child.on("close", (code) => finish(() => resolve({ code: code ?? 1, stdout, stderr })));
        onAbort = () => {
            if (settled)
                return;
            kill();
            finish(() => reject(new DOMException("操作已取消", "AbortError")));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
            onAbort();
            return;
        }
        // 写入失败（如进程提前退出）不额外抛出：退出码已足够说明问题。
        child.stdin?.on("error", () => undefined);
        if (stdin !== undefined)
            child.stdin?.write(stdin);
        child.stdin?.end();
    });
}
/** 去掉子进程输出末尾的换行，不改动 key 内容；空白结果视为无。 */
function readSecretValue(stdout) {
    const value = stdout.replace(/\r?\n$/u, "");
    return value.length > 0 ? value : undefined;
}
/** 取配置账号名：优先 $USER，回退系统用户名。与配置命令里的 `-a "$USER"` 对齐。 */
export function currentAccount() {
    const user = process.env.USER;
    if (typeof user === "string" && user.trim().length > 0)
        return user.trim();
    try {
        return userInfo().username;
    }
    catch {
        return "";
    }
}
/** macOS Keychain 实现。 */
export class MacKeychainStore {
    run;
    account;
    kind = "keychain";
    constructor(run = spawnExec, account = currentAccount()) {
        this.run = run;
        this.account = account;
    }
    async read(backend, signal) {
        // 读：find-generic-password -a <account> -s <service> -w，密码在 stdout。
        const result = await this.call([
            SECURITY_LOOKUP,
            "-a",
            this.account,
            "-s",
            this.service(backend),
            "-w",
        ], signal);
        if (typeof result === "string")
            return { status: "unavailable", reason: result };
        if (result.code === MAC_NOT_FOUND_EXIT)
            return { status: "missing" };
        if (result.code !== 0) {
            return { status: "unavailable", reason: `security 读取失败（退出码 ${result.code}）` };
        }
        const value = readSecretValue(result.stdout);
        return value === undefined ? { status: "missing" } : { status: "found", value };
    }
    async write(backend, value) {
        if (!isValidSecretValue(value))
            return invalidSecretResult();
        let result;
        try {
            result = await this.run(SWIFT_BIN, [MACOS_KEYCHAIN_HELPER, this.account, this.service(backend)], value, WRITE_EXEC_TIMEOUT_MS);
        }
        catch (error) {
            const timedOut = error instanceof Error && error.message.startsWith("凭据库命令超时");
            return {
                status: "unavailable",
                reason: timedOut ? "macOS Keychain 写入超时（系统密钥库无响应）" : "macOS Keychain 写入失败（系统密钥库不可用）",
            };
        }
        if (result.code !== 0) {
            return { status: "unavailable", reason: `macOS Keychain 写入失败（退出码 ${result.code}）` };
        }
        const verified = await this.read(backend);
        if (verified.status === "found" && verified.value === value)
            return { status: "written" };
        return { status: "unavailable", reason: "macOS Keychain 写入后验证失败" };
    }
    async clear(backend) {
        const result = await this.call([
            SECURITY_DELETE,
            "-a",
            this.account,
            "-s",
            this.service(backend),
        ]);
        if (typeof result === "string")
            return { status: "unavailable", reason: result };
        if (result.code === 0)
            return { status: "deleted" };
        if (result.code === MAC_NOT_FOUND_EXIT)
            return { status: "missing" };
        return { status: "unavailable", reason: `security 删除失败（退出码 ${result.code}）` };
    }
    /** 返回执行结果，或命令缺失时的诊断文本。 */
    async call(args, signal) {
        try {
            return await this.run(SECURITY_BIN, args, undefined, undefined, signal);
        }
        catch (error) {
            if (error instanceof Error && error.message.startsWith("凭据库命令超时")) {
                return "security 命令执行超时（系统密钥库无响应）";
            }
            return "security 命令不可用（系统密钥库无法访问）";
        }
    }
    service(backend) {
        return `${SECRET_SERVICE_PREFIX}-${backend}`;
    }
}
/** Linux Secret Service（secret-tool）实现。 */
export class SecretToolStore {
    run;
    kind = "secret-tool";
    constructor(run = spawnExec) {
        this.run = run;
    }
    async read(backend, signal) {
        const result = await this.call(["lookup", "service", SECRET_TOOL_SERVICE, "provider", backend], undefined, signal);
        if (typeof result === "string")
            return { status: "unavailable", reason: result };
        if (result.code === SECRET_TOOL_NOT_FOUND_EXIT) {
            // 无匹配项通常是空 stderr；少数实现会写明「未找到」，也按 missing 处理。
            // 其余 stderr 视为 D-Bus / 锁定 / 会话故障，不能误报为未配置。
            const stderr = result.stderr.trim();
            if (stderr.length === 0 || /no such secret|secret.*not found|no matching secret/iu.test(stderr)) {
                return { status: "missing" };
            }
            return { status: "unavailable", reason: "secret-tool 读取失败（退出码 1，密钥库不可用）" };
        }
        if (result.code !== 0) {
            return { status: "unavailable", reason: `secret-tool 读取失败（退出码 ${result.code}）` };
        }
        const value = readSecretValue(result.stdout);
        return value === undefined ? { status: "missing" } : { status: "found", value };
    }
    async write(backend, value) {
        if (!isValidSecretValue(value))
            return invalidSecretResult();
        const result = await this.call(["store", `--label=Pi web search: ${backend}`, "service", SECRET_TOOL_SERVICE, "provider", backend], value);
        if (typeof result === "string")
            return { status: "unavailable", reason: result };
        if (result.code !== 0) {
            return { status: "unavailable", reason: `secret-tool 写入失败（退出码 ${result.code}）` };
        }
        const verified = await this.read(backend);
        if (verified.status === "found" && verified.value === value)
            return { status: "written" };
        return { status: "unavailable", reason: "secret-tool 写入后验证失败" };
    }
    async clear(backend) {
        // secret-tool clear 对不存在的条目也返回 0，先 lookup 才能区分删除与未配置。
        const existing = await this.read(backend);
        if (existing.status === "unavailable")
            return existing;
        if (existing.status === "missing")
            return { status: "missing" };
        const result = await this.call(["clear", "service", SECRET_TOOL_SERVICE, "provider", backend]);
        if (typeof result === "string")
            return { status: "unavailable", reason: result };
        if (result.code === 0)
            return { status: "deleted" };
        return { status: "unavailable", reason: `secret-tool 删除失败（退出码 ${result.code}）` };
    }
    async call(args, stdin, signal) {
        try {
            return await this.run(SECRET_TOOL_BIN, args, stdin, undefined, signal);
        }
        catch (error) {
            if (error instanceof Error && error.message.startsWith("凭据库命令超时")) {
                return "secret-tool 命令执行超时（系统密钥库无响应）";
            }
            return "secret-tool 命令不可用（系统密钥库无法访问）";
        }
    }
}
/** 无系统密钥库的平台：读取、写入、删除均返回 unavailable。 */
export class NoopSecretStore {
    platform;
    kind = "none";
    constructor(platform = process.platform) {
        this.platform = platform;
    }
    get reason() {
        return `平台 ${this.platform} 没有支持的系统密钥库`;
    }
    async read(_backend, _signal) {
        return { status: "unavailable", reason: this.reason };
    }
    async write(_backend, _value) {
        return { status: "unavailable", reason: this.reason };
    }
    async clear(_backend) {
        return { status: "unavailable", reason: this.reason };
    }
}
/** 按平台选择系统密钥库实现。 */
export function createSecretStore(platform = process.platform, run = spawnExec) {
    if (platform === "darwin")
        return new MacKeychainStore(run);
    if (platform === "linux")
        return new SecretToolStore(run);
    return new NoopSecretStore(platform);
}
