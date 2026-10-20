/**
 * 本地正文提取：HTML → 可读 Markdown，Markdown 与纯文本直通，JSON 取文本字段。
 * 使用轻量规则处理静态 HTML，不执行脚本，也不引入重型解析依赖。
 */
import type { FetchMode } from "../params.js";
export interface ExtractionResult {
    readonly title?: string;
    readonly markdown: string;
    readonly truncated: boolean;
}
/** 只解码常见命名实体与数字实体一次；不递归解码。 */
export declare function decodeEntities(value: string): string;
/** 逐个剔除活动内容；未闭合脚本等按安全策略丢弃至输入末尾。 */
export declare function stripNoise(html: string): string;
/** 依次选择 main、article、常见文档容器与 body；同名嵌套元素会完整配对。 */
export declare function pickContainer(html: string): string;
/**
 * 取 `<title>` 或 og:title。
 *
 * 不用正则找 meta：`<meta[^>]+...` 在标签未闭合时会从每个候选起点回扫剩余文本，
 * 对攻击者可控的网页就是平方级的同步耗时。这里改为单次线性标签扫描。
 */
export declare function extractTitle(html: string): string | undefined;
/** 去掉标签并解码实体一次。 */
export declare function stripTags(html: string): string;
/** 块级边界转成换行，避免标题、段落、列表与表格内容粘连。 */
export declare function blockify(html: string): string;
/** `<pre>` 转为 Markdown 围栏代码块，保留代码中的空白与实体解码结果。 */
export declare function fencedCode(html: string): string;
/** 转换 HTML 行内代码，保留代码自身空格、制表符与空行。 */
export declare function inlineCode(html: string): string;
/** 将链接转为 Markdown；仅允许 http(s)，可选地解析相对地址。 */
export declare function links(html: string, baseUrl?: URL): string;
/** 标题转 Markdown 标题，层级最多到 6。 */
export declare function headings(html: string): string;
/** 列表项转 Markdown 列表。 */
export declare function listItems(html: string): string;
/** 表格转 Markdown 表格，保留单元格内的行内链接与代码。 */
export declare function tables(html: string): string;
/** 仅供 HTML/JSON 整理使用；直读 Markdown 与纯文本不会经过此空白压缩。 */
export declare function tidy(text: string): string;
/** HTML 提取结果可能带标题；其余分支只保证正文。 */
type ExtractionBase = {
    markdown: string;
    title?: string;
};
/** HTML → Markdown；代码先隔离，经过其他转换后再恢复，避免解码的 `<T>` 被当作标签。 */
export declare function htmlToMarkdown(html: string, baseUrl?: URL): ExtractionBase;
/** Markdown 直读不规整空白，避免损坏代码缩进、制表符与空行。 */
export declare function markdownToMarkdown(body: string): ExtractionBase;
/** 纯文本直读不规整空白，保留缩进、制表符、尖括号与空行。 */
export declare function textToMarkdown(body: string): ExtractionBase;
/** JSON：取常见文本字段与 http(s) 链接拼成可读正文，不把原始 JSON 整块灌给模型。 */
export declare function jsonToMarkdown(body: string): ExtractionBase;
/**
 * 按内容类型与模式选择提取路径。可选 baseUrl 只用于本地链接绝对化，不会触发请求。
 * 只有内容长度严格大于 maxChars 时才设置 truncated。
 */
export declare function extractContent(body: string, contentType: string, mode: FetchMode, maxChars: number, baseUrl?: URL): ExtractionResult;
export {};
