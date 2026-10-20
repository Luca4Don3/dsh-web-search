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
import { SECRET_SERVICE_PREFIX, SECRET_TOOL_SERVICE, } from "./credentials.js";
import { getProviderMetadata, hasAnonymousChannel, isProviderId, PROVIDER_IDS, supportsKeyChannel, } from "../search/registry.js";
/** 认证菜单、凭据解析与搜索能力共用同一注册表。 */
export const BACKENDS = PROVIDER_IDS;
/** 仅可能计费的后端进入凭据解析；纯匿名后端（如 TinyFish keyless）不读取任何密钥。 */
export const KEY_BACKENDS = BACKENDS.filter(supportsKeyChannel);
/** 运行时白名单，避免非法选择进入凭据操作。 */
export function isBackend(value) {
    return isProviderId(value);
}
/** 匿名能力来自注册表，不能以是否配置密钥判断费用。 */
export function hasFreeChannel(backend) {
    return hasAnonymousChannel(backend);
}
/** 后端对应的环境变量名。 */
export function envVarName(backend) {
    return getProviderMetadata(backend).envVar;
}
/** 不读取环境或密钥库的空凭据映射。 */
export function emptyPlanKeys() {
    return Object.fromEntries(BACKENDS.map((backend) => [backend, undefined]));
}
/** 读取环境变量中的 key；空白视为未配置。 */
export function envKey(backend) {
    const value = process.env[envVarName(backend)];
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function abortError() {
    return new DOMException("操作已取消", "AbortError");
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw abortError();
}
/** 允许上层取消等待，同时消费底层稍后到达的结果或异常。 */
function waitForAbort(promise, signal) {
    if (signal === undefined)
        return promise;
    if (signal.aborted) {
        // 凭据读取可能在构造 Promise 时同步触发取消，仍须消费其迟到的拒绝。
        void promise.catch(() => undefined);
        return Promise.reject(abortError());
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (settle) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            settle();
        };
        const onAbort = () => finish(() => reject(abortError()));
        signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve(promise).then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
        if (signal.aborted)
            onAbort();
    });
}
/**
 * 解析单个后端的 key：环境变量优先，其次系统密钥库。
 * 任何读取失败都静默回退为 undefined，保证匿名搜索不被密钥库问题阻断。
 */
export async function resolveBackendKey(backend, store, signal) {
    throwIfAborted(signal);
    const fromEnv = envKey(backend);
    if (fromEnv !== undefined)
        return fromEnv;
    let result;
    try {
        result = await store.read(backend, signal);
    }
    catch {
        throwIfAborted(signal);
        return undefined;
    }
    throwIfAborted(signal);
    return result.status === "found" ? result.value : undefined;
}
/**
 * 为一次搜索解析路由所需的全部 key：每个可能用到的后端只读一次密钥库。
 * 显式指定后端时只解析该后端，auto 解析全部后端。
 */
export async function resolvePlanKeys(provider, store, signal) {
    throwIfAborted(signal);
    const needed = provider === "auto" ? KEY_BACKENDS : [provider].filter(supportsKeyChannel);
    const entries = await waitForAbort(Promise.all(needed.map(async (backend) => [
        backend,
        await resolveBackendKey(backend, store, signal),
    ])), signal);
    throwIfAborted(signal);
    const keys = emptyPlanKeys();
    for (const [backend, key] of entries)
        keys[backend] = key;
    return keys;
}
/** 查询单个后端的认证状态；不抛错，密钥库失败归入 unavailable。 */
export async function probeBackendStatus(backend, store) {
    // 零凭据通道（如 TinyFish keyless）既不读密钥环境变量也不读密钥库，
    // 否则「查看状态」本身就会变成一次未经授权的凭据访问。
    if (!supportsKeyChannel(backend))
        return { backend, state: "credential_free" };
    const fromEnv = envKey(backend);
    if (fromEnv !== undefined)
        return { backend, state: "configured", source: "env" };
    let result;
    try {
        result = await store.read(backend);
    }
    catch {
        return { backend, state: "unavailable", reason: "系统密钥库读取异常" };
    }
    if (result.status === "found") {
        return { backend, state: "configured", source: store.kind === "none" ? undefined : store.kind };
    }
    if (result.status === "missing")
        return { backend, state: "not_configured" };
    return { backend, state: "unavailable", reason: result.reason };
}
/**
 * 把可能混入的来源文本中的 key 抹掉。
 *
 * 实现已统一到 {@link ../shared/redact.js}：认证层与搜索内核共用同一份编码形态覆盖
 * （原文、JSON 转义、网址组件编码、标准表单编码、base64 及大小写混用）。
 * 这里只做转出，保持既有调用点不变。
 */
export { redactSecrets };
/** 单行诊断文本的长度上限。 */
export const MAX_DIAGNOSTIC_CHARS = 300;
/** 先脱敏、再截断，避免截断把 key 的片段留在文本里。 */
export function safeDiagnostic(error, secrets = []) {
    const raw = error instanceof Error ? error.message : String(error);
    const safe = redactSecrets(raw, secrets);
    return safe.length > MAX_DIAGNOSTIC_CHARS ? `${safe.slice(0, MAX_DIAGNOSTIC_CHARS)}…` : safe;
}
/** 生成单后端的配置说明（安全终端命令）。 */
export function configGuide(backend, kind) {
    const variable = envVarName(backend);
    if (kind === "keychain") {
        const service = `${SECRET_SERVICE_PREFIX}-${backend}`;
        return {
            backend,
            kind,
            lines: [
                `macOS Keychain（service: ${service}）`,
                "在终端交互模式运行 /web-search-auth，选择「添加或修改密钥」，通过自定义掩码输入保存。",
                "写入使用静态 macos-keychain.swift 适配器与系统 Security Framework，需可用的 Swift 命令行工具。",
                "密钥仅通过 stdin 传递，写入后从系统密钥库重读验证；不进入命令参数、会话或配置文件。",
            ],
        };
    }
    if (kind === "secret-tool") {
        return {
            backend,
            kind,
            lines: [
                `Linux Secret Service（service: ${SECRET_TOOL_SERVICE}, provider: ${backend}）`,
                "推荐在终端交互模式运行 /web-search-auth，通过自定义掩码输入保存并重读验证。",
                "也可在终端执行下面的命令，回车后按提示粘贴密钥：",
                `  secret-tool store --label="Pi web search: ${backend}" service ${SECRET_TOOL_SERVICE} provider ${backend}`,
                "注意：不要把 key 写在命令参数里，只通过交互提示输入。",
            ],
        };
    }
    return {
        backend,
        kind,
        lines: [
            hasFreeChannel(backend)
                ? "当前平台没有系统密钥库，此后端未提供密钥时仍可使用免 key 通道。"
                : "当前平台没有系统密钥库，此后端必须配置密钥，没有免 key 通道。",
            `如需使用自有 key，请通过外部 secret manager 在启动 Pi 时安全注入 ${variable}；不要把 key 放进 shell 命令或启动文件。`,
            "可使用外部密钥管理工具安全注入环境；Exa / Parallel / Tavily / Firecrawl 另有匿名通道。",
            "配置密钥不代表允许计费；只有显式设置 PI_WEB_SEARCH_ALLOW_BILLABLE=true 才启用认证搜索。",
        ],
    };
}
