/**
 * 抓取参数与结构化结果的共享定义。
 *
 * 这里刻意不 import TypeBox：参数 schema 属于宿主适配层，
 * 内核只使用模式枚举与结果结构。
 */
/** 内容提取模式：auto 自动判断，article 走正文提取，text 只取纯文本。 */
export const FETCH_MODES = ["auto", "article", "text"];
