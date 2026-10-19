/** 有界、可取消的流式响应正文读取。 */
/**
 * 读取完整正文并按实际字节数限制大小；失败或超限时不返回部分正文。
 * charset 可显式指定，省略时从响应 content-type 读取，未声明则使用 UTF-8。
 */
export declare function readResponseTextLimited(response: Response, maxBytes: number, controller?: AbortController, charset?: string): Promise<string>;
