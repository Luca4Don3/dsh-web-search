import { BackendError, messageKind } from "./core.js";

/** 只保留单条协议消息内合法的非空文本块，不拼接不同响应。 */
function parsePayload(line: string): string[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object") return undefined;
	const envelope = parsed as { error?: unknown; result?: { content?: unknown; isError?: boolean } };
	if (envelope.error !== undefined) {
		const error = envelope.error;
		const detail = typeof error === "string" ? error
			: error !== null && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
		const message = typeof detail === "string" && detail.length > 0 ? detail : "MCP search error";
		const kind = messageKind(message) ?? "protocol_error";
		// 诊断同时保留原始文本与固定分类名：宿主可展示可读消息，测试可按分类断言。
		throw new BackendError(`[${kind}] ${message}`, kind);
	}
	const content = envelope.result?.content;
	const texts: string[] = [];
	if (Array.isArray(content)) {
		for (const entry of content) {
			if (entry !== null && typeof entry === "object" && entry.type === "text"
				&& typeof entry.text === "string" && entry.text.trim().length > 0) texts.push(entry.text);
		}
	}
	if (envelope.result?.isError === true) {
		const message = texts.length > 0 ? texts.join("\n\n") : "MCP search tool failed";
		const kind = messageKind(message) ?? "protocol_error";
		throw new BackendError(`[${kind}] ${message}`, kind);
	}
	return texts.length > 0 ? texts : undefined;
}

/**
 * 单个协议消息的首个可用文本。
 *
 * DSH 语义：返回字符串；Pi 内核需要逐块解析，用 {@link parseMcpBlocks}。
 * 两者共享同一解析与错误分类，不重复实现。
 */
export function parseMcpResponse(body: string): string | undefined {
	const blocks = parseMcpBlocks(body);
	return blocks === undefined ? undefined : blocks.join("\n");
}

/** 保留原有终止语义：直接响应或首个可用事件，不合并不同协议消息。 */
export function parseMcpBlocks(body: string): string[] | undefined {
	const trimmed = body.trim();
	if (trimmed.startsWith("{")) {
		const direct = parsePayload(trimmed);
		if (direct !== undefined) return direct;
	}
	let buffer: string[] = [];
	const flush = (): string[] | undefined => {
		if (buffer.length === 0) return undefined;
		const payload = buffer.join("\n");
		buffer = [];
		return parsePayload(payload);
	};
	for (const line of trimmed.split("\n")) {
		if (line.startsWith("data:")) {
			buffer.push(line.slice("data:".length).trimStart());
			continue;
		}
		if (line.trim().length === 0) {
			const found = flush();
			if (found !== undefined) return found;
		}
	}
	return flush();
}
