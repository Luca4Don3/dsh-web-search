/**
 * URL 与目标地址安全策略。
 *
 * `web_fetch` 与 `web_search` 的本质区别是它会访问调用方给出的任意 URL，
 * 因此这里是把守服务端请求伪造（SSRF）的唯一入口：
 * - 只允许 http / https，且拒绝在 URL 中内嵌用户名与密码。
 * - 只允许解析到公网地址的目标；回环、内网、链路本地、云元数据与各类保留段一律拒绝。
 * - 解析与校验在同一次操作内完成，返回被校验过的具体地址，随后由传输层绑定该地址建连，
 *   避免「先校验域名、再由 HTTP 客户端重新解析到别的地址」这种 DNS 重绑定窗口。
 */
export interface ResolvedTarget {
    /** 规范化后的原始 URL（不含凭据）。 */
    readonly url: URL;
    /** 已通过校验的目标 IP 字面量。 */
    readonly address: string;
    /** 已通过校验的地址族。 */
    readonly family: 4 | 6;
}
/** 文本形式的 IP 是否允许作为抓取目标。 */
export declare function isPublicIPAddress(value: string): boolean;
/**
 * 校验并解析抓取目标。
 * 非法协议、内嵌凭据、非公网地址与不受支持的端口都会返回固定分类的 FetchError，
 * 错误文本不回显调用方给出的原 URL。
 */
export declare function resolveFetchTarget(rawUrl: string, signal?: AbortSignal, lookupFn?: (hostname: string, options: {
    all: true;
    verbatim: true;
}) => Promise<Array<{
    address: string;
    family: number;
}>>): Promise<ResolvedTarget>;
