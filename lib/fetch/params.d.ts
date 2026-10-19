/**
 * 抓取参数与结构化结果的共享定义。
 *
 * 这里刻意不 import TypeBox：参数 schema 属于宿主适配层，
 * 内核只使用模式枚举与结果结构。
 */
/** 内容提取模式：auto 自动判断，article 走正文提取，text 只取纯文本。 */
export declare const FETCH_MODES: readonly ["auto", "article", "text"];
export type FetchMode = (typeof FETCH_MODES)[number];
/** 抓取结果的结构化详情；两个宿主都以它为基础渲染。 */
export interface FetchDetails {
    requestedUrl: string;
    finalUrl?: string;
    title?: string;
    contentType?: string;
    provider?: "direct" | "jina";
    statusCode?: number;
    extractedChars?: number;
    truncated?: boolean;
    redirectCount?: number;
    durationMs?: number;
    errorKind?: string;
}
