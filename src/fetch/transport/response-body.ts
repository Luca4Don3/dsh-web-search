/**
 * 抓取侧的正文读取入口。
 *
 * 字节计数、取消竞速与清理逻辑统一在 `src/shared/response-body.ts`；
 * 本文件只提供抓取特有的两件事：按 `content-type` 声明解码，以及
 * `FetchError` 分类。这样搜索与抓取不会各自漂移一套读流实现。
 */
import { FetchError } from "../errors.js";
import { readTextLimited } from "../../shared/response-body.js";

function abortError(signal?: AbortSignal): FetchError {
	const reason = signal?.reason;
	if (reason instanceof FetchError && (reason.kind === "timeout" || reason.kind === "aborted" || reason.kind === "response_too_large")) {
		return reason;
	}
	return new FetchError("操作已取消", "aborted");
}

/**
 * 读取完整正文并按实际字节数限制大小；失败或超限时不返回部分正文。
 * charset 可显式指定，省略时从响应 content-type 读取，未声明则使用 UTF-8。
 */
export async function readResponseTextLimited(
	response: Response,
	maxBytes: number,
	controller?: AbortController,
	charset?: string,
): Promise<string> {
	return readTextLimited(response, maxBytes, {
		signal: controller?.signal ?? new AbortController().signal,
		...(controller === undefined ? {} : { abortRequest: () => controller.abort() }),
		decode: "declared",
		...(charset === undefined ? {} : { charset }),
		errors: {
			aborted: () => abortError(controller?.signal),
			tooLarge: () => new FetchError("响应体超过上限", "response_too_large"),
			unreadable: () => new FetchError("响应正文不可读取", "network_error"),
			undecodable: () => new FetchError("目标声明了不支持的字符集", "unsupported_content"),
		},
	});
}
