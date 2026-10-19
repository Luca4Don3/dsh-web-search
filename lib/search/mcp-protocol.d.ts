/**
 * 单个协议消息的首个可用文本。
 *
 * DSH 语义：返回字符串；Pi 内核需要逐块解析，用 {@link parseMcpBlocks}。
 * 两者共享同一解析与错误分类，不重复实现。
 */
export declare function parseMcpResponse(body: string): string | undefined;
/** 保留原有终止语义：直接响应或首个可用事件，不合并不同协议消息。 */
export declare function parseMcpBlocks(body: string): string[] | undefined;
