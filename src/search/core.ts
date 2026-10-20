/** 搜索后端共用的结果类型、错误分类与响应校验；不访问网络或凭据。 */
import type { SearchSource } from "./contracts.js";

/** 兼容旧名称：来源结构与内核契约一致。 */
export type WebSource = SearchSource;

export type SearchErrorKind =
	| "quota_preflight" | "quota_exhausted" | "rate_limited" | "invalid_key" | "server_error"
	| "network_error" | "timeout" | "aborted" | "protocol_error" | "response_too_large" | "budget_exhausted";

/** 带分类的错误；请求层回填实际尝试次数。 */
export class BackendError extends Error {
	attempts = 0;

	constructor(message: string, readonly kind: SearchErrorKind, readonly retryAfterMs?: number) {
		super(message);
		this.name = "BackendError";
	}

	get retryable(): boolean {
		return this.kind === "rate_limited" || this.kind === "server_error" || this.kind === "network_error";
	}
}

export function statusKind(status: number): SearchErrorKind {
	if (status === 401 || status === 403) return "invalid_key";
	if (status === 402) return "quota_exhausted";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "server_error";
	return "protocol_error";
}

/** 错误分类只看开头：上游错误文本可能很长甚至是恶意的，不需要整段扫描。 */
const CLASSIFY_MAX_CHARS = 8_192;

export function messageKind(message: string): SearchErrorKind | undefined {
	// 分类是同步运算，异步超时抢不动它：必须自己保证代价有界。
	const text = (message.length > CLASSIFY_MAX_CHARS ? message.slice(0, CLASSIFY_MAX_CHARS) : message).toLowerCase();
	// 中文额度提示也必须被识别；此前只覆盖英文关键词，会把额度错误误判为协议错误。
	// 注意 "monthly ... limit" 不能写成 /monthly.*limit/：输入反复出现 monthly
	// 却没有 limit 时，每个起点都要扫到结尾，复杂度是平方级的（ReDoS）。
	if (
		/quota|credit|balance|insufficient|payment required|no remaining|(?:ran|run) out of searches|额度|余额不足|积分不足/.test(text) ||
		(text.includes("monthly") && text.includes("limit"))
	) {
		return "quota_exhausted";
	}
	if (/rate limit|too many requests|限流|请求过多/.test(text)) return "rate_limited";
	if (/unauthoriz|forbidden|invalid api key|authentication|api key/.test(text)) return "invalid_key";
	return undefined;
}

export function httpKind(status: number, detail: string): SearchErrorKind {
	return messageKind(detail) ?? statusKind(status);
}

/**
 * 只接受不含内嵌凭据的可点击网页链接。
 *
 * 脚本、本地文件与内联数据不是可引用的来源；带内嵌凭据的地址
 * （用户信息段不是空的那种）也不行，那会把凭据带进搜索结果。
 */
export function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.username.length > 0 || url.password.length > 0) return false;
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

/** 单条诊断文本的上限：足够定位问题，又不会把会话或错误结果撑大。 */
export const MAX_DIAGNOSTIC_CHARS = 300;

/** 多条失败汇总的上限。 */
export const MAX_FAILURE_SUMMARY_CHARS = 1_024;

/**
 * 裁剪诊断文本。
 *
 * 只负责长度，不做脱敏：调用方必须**先**完整脱敏再调用这里。
 * 反过来先截断会让密钥在中间被切断，留下无法再被匹配的凭据片段。
 */
export function clipDiagnostic(text: string, max = MAX_DIAGNOSTIC_CHARS): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 提取各服务的错误文本；调用方必须在输出前脱敏。 */
export function errorDetailFrom(payload: unknown): string | undefined {
	if (payload === null || typeof payload !== "object") return undefined;
	const record = payload as Record<string, unknown>;
	for (const candidate of [record.error, record.detail]) {
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
		if (candidate !== null && typeof candidate === "object") {
			const inner = candidate as Record<string, unknown>;
			for (const value of [inner.message, inner.error]) {
				if (typeof value === "string" && value.length > 0) return value;
			}
		}
	}
	return typeof record.message === "string" && record.message.length > 0 ? record.message : undefined;
}
