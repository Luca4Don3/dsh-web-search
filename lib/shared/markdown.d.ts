/**
 * Markdown 输出转义；提取器与搜索结果渲染共用同一套语义。
 *
 * 上游网页完全控制标题与摘要文本。若不转义，标题里的 `](` 可以提前闭合
 * 链接目标，让工具生成的引用指向攻击者指定的地址；标题里的换行还能凭空
 * 生成新的列表项，看起来像是工具自己输出的引用。
 */
/** 转义链接标签里的结构性字符。 */
export declare function escapeMarkdownLabel(label: string): string;
/**
 * 折叠换行与连续空白。
 *
 * 标题/摘要里的换行会在渲染结果里生成独立的列表项，等于让上游凭空插入内容。
 */
export declare function collapseLineBreaks(value: string): string;
/**
 * 转义 URL 里的括号。
 *
 * `[label](https://en.wikipedia.org/wiki/Foo_(bar))` 会在第一个 `)` 处提前闭合，
 * 链接被截断成 `.../Foo_(bar`。百分号编码后语义不变，链接完整。
 */
export declare function escapeMarkdownUrl(url: string): string;
