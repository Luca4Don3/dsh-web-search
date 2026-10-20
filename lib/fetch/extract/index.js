/**
 * 本地正文提取：HTML → 可读 Markdown，Markdown 与纯文本直通，JSON 取文本字段。
 * 使用轻量规则处理静态 HTML，不执行脚本，也不引入重型解析依赖。
 */
import { randomBytes } from "node:crypto";
import { FetchError } from "../errors.js";
import { safeSlice } from "../../shared/truncate.js";
const ENTITIES = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'",
    "&nbsp;": " ", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…",
};
/** 只解码常见命名实体与数字实体一次；不递归解码。 */
export function decodeEntities(value) {
    return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|mdash|ndash|hellip);|&#x([0-9a-f]+);|&#(\d+);/giu, (match, hex, dec) => {
        if (hex !== undefined)
            return safeCodePoint(Number.parseInt(hex, 16));
        if (dec !== undefined)
            return safeCodePoint(Number.parseInt(dec, 10));
        return ENTITIES[match.toLowerCase()] ?? match;
    });
}
function safeCodePoint(value) {
    if (!Number.isFinite(value) || value < 0 || value > 0x10ffff)
        return "";
    try {
        return String.fromCodePoint(value);
    }
    catch {
        return "";
    }
}
function tagEnd(html, from) {
    let quote = "";
    for (let index = from; index < html.length; index++) {
        const character = html[index];
        if (quote !== "") {
            if (character === quote)
                quote = "";
        }
        else if (character === '"' || character === "'") {
            quote = character;
        }
        else if (character === ">") {
            return index + 1;
        }
    }
    return -1;
}
/**
 * 从左至右找下一个指定标签；遇到未结束的标签时停止，避免反复回扫坏 HTML。
 *
 * 扫描时跟踪"是否位于某个标签的属性值里"：属性值中的 `<main>` 只是字面量，
 * 不能当成真实结构，否则 `data-example="<main>…"` 就能劫持正文选择。
 * 每个字符只前进一次，因此整体仍与输入长度成线性。
 */
function findTagToken(html, tag, from) {
    const wanted = tag.toLowerCase();
    let cursor = from;
    let quote = "";
    let inTag = false;
    // 从 `from` 开始时一定位于标签之外：调用方传的都是上一个标签的 end。
    while (cursor < html.length) {
        const character = html[cursor];
        if (quote !== "") {
            if (character === quote)
                quote = "";
            cursor++;
            continue;
        }
        if (character === ">") {
            inTag = false;
            cursor++;
            continue;
        }
        if (character === "<") {
            // 只有标签之外的小于号才可能是结构起点。
            const closing = html[cursor + 1] === "/";
            const nameStart = cursor + (closing ? 2 : 1);
            const nameEnd = nameStart + wanted.length;
            const isTarget = html.slice(nameStart, nameEnd).toLowerCase() === wanted;
            const boundary = html[nameEnd];
            const boundaryOk = boundary === undefined || boundary === " " || boundary === "\t" || boundary === "\n" || boundary === "\r" || boundary === "\f" || boundary === "/" || boundary === ">";
            if (isTarget && boundaryOk) {
                const end = tagEnd(html, nameEnd);
                if (end < 0)
                    return undefined;
                const attributes = closing ? "" : html.slice(nameEnd, end - 1);
                return { start: cursor, end, closing, selfClosing: !closing && isSelfClosingMarkup(attributes), attributes };
            }
            inTag = true;
            cursor++;
            continue;
        }
        if (inTag && (character === '"' || character === "'")) {
            quote = character;
            cursor++;
            continue;
        }
        cursor++;
    }
    return undefined;
}
/**
 * 判断标签末尾的 `/` 是不是自闭合标记。
 *
 * `<br/>` 与 `<div class="a"/>` 是自闭合；但 `<main id=x/>` 里的 `/` 属于
 * 无引号属性值 `x/`，HTML 允许该写法，不能把它当成空元素跳过。
 */
function isSelfClosingMarkup(attributes) {
    const trimmed = attributes.trimEnd();
    if (!trimmed.endsWith("/"))
        return false;
    const before = trimmed[trimmed.length - 2];
    return before === undefined || before === " " || before === "\t" || before === "\n" || before === "\r" || before === "\f" || before === '"' || before === "'";
}
function findClosingTag(html, tag, from) {
    let cursor = from;
    for (let token = findTagToken(html, tag, cursor); token !== undefined; token = findTagToken(html, tag, cursor)) {
        cursor = token.end;
        if (token.closing)
            return token;
    }
    return undefined;
}
/** 单次栈扫描同名标签；嵌套配对正确，未闭合标签不会导致候选逐个重扫全文。 */
function findElementRange(html, tag, from = 0, accept, raw) {
    const stack = [];
    let best;
    let earliestAcceptedStart;
    let cursor = from;
    const inRawText = raw === undefined ? undefined : rangeChecker(raw);
    for (let token = findTagToken(html, tag, cursor); token !== undefined; token = findTagToken(html, tag, cursor)) {
        cursor = token.end;
        // 原始文本区域里的同名标签只是字面量，配对时必须整体跳过：
        // 否则 <textarea></main></textarea> 里的 </main> 会提前结束外层容器。
        if (inRawText !== undefined && inRawText(token.start))
            continue;
        if (token.closing) {
            const open = stack.pop();
            if (open?.start === earliestAcceptedStart)
                earliestAcceptedStart = undefined;
            if (open?.accepted) {
                const range = { start: open.start, contentStart: open.contentStart, contentEnd: token.start, end: token.end, attributes: open.attributes };
                if (best === undefined || range.start < best.start)
                    best = range;
            }
        }
        else if (!token.selfClosing) {
            const accepted = accept === undefined || accept(token.attributes);
            stack.push({ start: token.start, contentStart: token.end, attributes: token.attributes, accepted });
            if (accepted && earliestAcceptedStart === undefined)
                earliestAcceptedStart = token.start;
        }
        if (best !== undefined && (earliestAcceptedStart === undefined || earliestAcceptedStart >= best.start))
            return best;
    }
    return best;
}
function stripSiteHeaders(html) {
    const ranges = [];
    const open = [];
    let cursor = 0;
    while (cursor < html.length) {
        const token = findTagToken(html, "header", cursor);
        const segmentEnd = token === undefined ? html.length : token.start;
        // 把两个 header 标签之间的内容记到**最内层** header 上。
        // 每个字符因此只被扫描一次：嵌套越深也不会重复统计外层子树。
        if (open.length > 0 && segmentEnd > cursor) {
            const segment = html.slice(cursor, segmentEnd);
            const top = open[open.length - 1];
            if (!top.article && /<h[1-3]\b/iu.test(segment))
                top.article = true;
            if (!top.nav && /<nav\b/iu.test(segment))
                top.nav = true;
            top.links += (segment.match(/<a\b/giu) ?? []).length;
            top.textChars += segment.replace(/<[^>]*>/gu, "").trim().length;
        }
        if (token === undefined)
            break;
        cursor = token.end;
        if (token.selfClosing)
            continue;
        if (!token.closing) {
            open.push({ start: token.start, contentStart: token.end, article: false, nav: false, links: 0, textChars: 0 });
            continue;
        }
        const popped = open.pop();
        if (popped === undefined)
            continue;
        // 带文章级标题的 header 属于正文结构，任何情况下都保留。
        if (popped.article)
            continue;
        if (popped.nav || (popped.links >= 3 && popped.textChars < 200))
            ranges.push({ start: popped.start, end: token.end });
    }
    if (ranges.length === 0)
        return html;
    // 嵌套 header 会产生互相包含的范围：先按升序合并，再一次性拼接保留区间。
    // 直接按闭合顺序倒序删除会因为坐标失效而删到后面的正常正文。
    ranges.sort((left, right) => left.start - right.start);
    const merged = [];
    for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (last !== undefined && range.start <= last.end)
            last.end = Math.max(last.end, range.end);
        else
            merged.push({ ...range });
    }
    const parts = [];
    let kept = 0;
    for (const range of merged) {
        parts.push(html.slice(kept, range.start));
        kept = range.end;
    }
    parts.push(html.slice(kept));
    return parts.join("");
}
function removeElements(html, tags) {
    for (const tag of tags) {
        const parts = [];
        let cursor = 0;
        while (cursor < html.length) {
            const range = findElementRange(html, tag, cursor);
            if (range === undefined)
                break;
            parts.push(html.slice(cursor, range.start), " ");
            cursor = range.end;
        }
        if (cursor === 0)
            continue;
        parts.push(html.slice(cursor));
        html = parts.join("");
    }
    return html;
}
function stripComments(html) {
    const parts = [];
    let cursor = 0;
    while (true) {
        const start = html.indexOf("<!--", cursor);
        if (start < 0)
            break;
        const end = html.indexOf("-->", start + 4);
        if (end < 0) {
            parts.push(html.slice(cursor, start), " ");
            return parts.join("");
        }
        parts.push(html.slice(cursor, start), " ");
        cursor = end + 3;
    }
    if (cursor === 0)
        return html;
    parts.push(html.slice(cursor));
    return parts.join("");
}
function removeRawElements(html, tag) {
    const parts = [];
    let cursor = 0;
    let scan = 0;
    while (scan < html.length) {
        const opening = findTagToken(html, tag, scan);
        if (opening === undefined)
            break;
        scan = opening.end;
        if (opening.closing)
            continue;
        if (opening.selfClosing) {
            parts.push(html.slice(cursor, opening.start), " ");
            cursor = opening.end;
            continue;
        }
        const closing = findClosingTag(html, tag, opening.end);
        if (closing === undefined) {
            parts.push(html.slice(cursor, opening.start), " ");
            return parts.join("");
        }
        parts.push(html.slice(cursor, opening.start), " ");
        cursor = closing.end;
        scan = cursor;
    }
    if (cursor === 0)
        return html;
    parts.push(html.slice(cursor));
    return parts.join("");
}
/** 逐个剔除活动内容；未闭合脚本等按安全策略丢弃至输入末尾。 */
export function stripNoise(html) {
    let cleaned = stripComments(html);
    for (const tag of ["script", "style", "noscript", "template"])
        cleaned = removeRawElements(cleaned, tag);
    // 不在这里删 header：文章常把主标题与摘要放在 <header> 里，
    // 全局剔除会把正文头部一起丢掉。站点级 header 由 pickContainer 在回退到
    // body 时才处理。
    return removeElements(cleaned, ["nav", "aside", "footer"]);
}
/** 原始文本区域：内部内容不参与标签解析，其中的容器标签不构成正文候选。 */
function rawTextRanges(html) {
    const ranges = [];
    // iframe/xmp/noembed/noframes/plaintext 同样是"到结束标签为止都是文本"的容器，
    // 里面的 <main>/<article> 只是字面量，不构成正文候选。
    for (const tag of ["textarea", "title", "iframe", "xmp", "noembed", "noframes", "plaintext"]) {
        let cursor = 0;
        for (let token = findTagToken(html, tag, cursor); token !== undefined; token = findTagToken(html, tag, cursor)) {
            cursor = token.end;
            if (token.closing || token.selfClosing)
                continue;
            const closing = findClosingTag(html, tag, cursor);
            if (closing === undefined) {
                ranges.push({ start: token.start, end: html.length });
                break;
            }
            ranges.push({ start: token.start, end: closing.end });
            cursor = closing.end;
        }
    }
    return ranges.sort((left, right) => left.start - right.start);
}
/**
 * 生成"某位置是否落在区间内"的判定器。
 *
 * 区间已排序且调用方按位置单调递增查询，所以用游标前进而不是每次从头扫：
 * 早前版本对每个候选重扫全部前缀区间，是平方级。
 */
function rangeChecker(ranges) {
    let index = 0;
    return (position) => {
        while (index < ranges.length && ranges[index].end <= position)
            index++;
        const current = ranges[index];
        return current !== undefined && current.start <= position;
    };
}
const CONTENT_DIV = /(?:markdown-body|md-content|documentation|docs-content|post-content|article-content|entry-content|content-body)/iu;
/** 依次选择 main、article、常见文档容器与 body；同名嵌套元素会完整配对。 */
export function pickContainer(html) {
    const candidates = [
        { tag: "main" },
        { tag: "article" },
        { tag: "div", accept: (attributes) => CONTENT_DIV.test(attributes) },
        { tag: "body" },
    ];
    // 文本输入区域里的 <main>/<article> 只是被当作代码保存的字面量，
    // 不能当成正文候选，否则真实文章会被伪容器挤掉。
    const raw = rawTextRanges(html);
    for (const candidate of candidates) {
        let from = 0;
        while (from < html.length) {
            const range = findElementRange(html, candidate.tag, from, candidate.accept, raw);
            if (range === undefined)
                break;
            from = range.end;
            const content = html.slice(range.contentStart, range.contentEnd);
            if (content.trim().length === 0)
                continue;
            // 选中 main/article/文档容器时，其中的 header 属于文章本身，必须保留；
            // 只有回退到 body 时才把站点级 header 当噪声剔除。
            return candidate.tag === "body" ? stripSiteHeaders(content) : content;
        }
    }
    return stripSiteHeaders(html);
}
/**
 * 在标签属性串里读取某个属性的值。
 *
 * 按属性语法逐段解析，因此顺序无关、等号两侧允许空白，属性名也按完整名字比较
 * （`data-og:title` 不会被当成 `og:title`）。整个过程对属性串是线性的。
 */
function readAttribute(attributes, name) {
    const target = name.toLowerCase();
    let cursor = 0;
    while (cursor < attributes.length) {
        while (cursor < attributes.length && isSpace(attributes.charCodeAt(cursor)))
            cursor++;
        if (cursor >= attributes.length)
            break;
        const nameStart = cursor;
        while (cursor < attributes.length) {
            const code = attributes.charCodeAt(cursor);
            if (isSpace(code) || code === 61 /* = */)
                break;
            cursor++;
        }
        const attributeName = attributes.slice(nameStart, cursor).toLowerCase();
        while (cursor < attributes.length && isSpace(attributes.charCodeAt(cursor)))
            cursor++;
        let value = "";
        if (attributes.charCodeAt(cursor) === 61 /* = */) {
            cursor++;
            while (cursor < attributes.length && isSpace(attributes.charCodeAt(cursor)))
                cursor++;
            const quote = attributes[cursor];
            if (quote === '"' || quote === "'") {
                const end = attributes.indexOf(quote, cursor + 1);
                value = attributes.slice(cursor + 1, end < 0 ? attributes.length : end);
                cursor = end < 0 ? attributes.length : end + 1;
            }
            else {
                const valueStart = cursor;
                while (cursor < attributes.length && !isSpace(attributes.charCodeAt(cursor)))
                    cursor++;
                value = attributes.slice(valueStart, cursor);
            }
        }
        if (attributeName === target)
            return value;
    }
    return undefined;
}
function isSpace(code) {
    return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}
/**
 * 取 `<title>` 或 og:title。
 *
 * 不用正则找 meta：`<meta[^>]+...` 在标签未闭合时会从每个候选起点回扫剩余文本，
 * 对攻击者可控的网页就是平方级的同步耗时。这里改为单次线性标签扫描。
 */
export function extractTitle(html) {
    for (let token = findTagToken(html, "meta", 0); token !== undefined; token = findTagToken(html, "meta", token.end)) {
        if (token.closing)
            continue;
        const key = (readAttribute(token.attributes, "property") ?? readAttribute(token.attributes, "name") ?? "").trim().toLowerCase();
        if (key !== "og:title")
            continue;
        const content = readAttribute(token.attributes, "content");
        if (content === undefined)
            continue;
        const text = decodeEntities(content.trim());
        if (text.length > 0)
            return text;
    }
    const title = findElementRange(html, "title");
    if (title !== undefined) {
        const text = decodeEntities(html.slice(title.contentStart, title.contentEnd).trim());
        return text.length > 0 ? text : undefined;
    }
    return undefined;
}
/** 标签只扫描一次；未结束的标签不反复回扫剩余内容。 */
function replaceMarkup(html, replace) {
    const parts = [];
    let cursor = 0;
    for (;;) {
        const start = html.indexOf("<", cursor);
        if (start < 0)
            break;
        const end = tagEnd(html, start + 1);
        if (end < 0)
            break;
        parts.push(html.slice(cursor, start), replace(html.slice(start, end)));
        cursor = end;
    }
    parts.push(html.slice(cursor));
    return parts.join("");
}
function stripMarkupRaw(html) {
    return replaceMarkup(html, () => " ");
}
/** 去掉标签并解码实体一次。 */
export function stripTags(html) {
    return decodeEntities(stripMarkupRaw(html));
}
/** 块级边界转成换行，避免标题、段落、列表与表格内容粘连。 */
export function blockify(html) {
    return replaceMarkup(html, (tag) => {
        const name = /^<\/?([a-z][\w:-]*)\b/iu.exec(tag)?.[1]?.toLowerCase();
        return name !== undefined && /^(?:br|p|div|section|article|main|li|ul|ol|table|thead|tbody|tr|h[1-6]|pre|blockquote|dl|dt|dd|figure|figcaption|header|footer)$/u.test(name) ? "\n" : tag;
    });
}
function codeText(html) {
    const text = replaceMarkup(html, (tag) => /^<br\b/iu.test(tag) ? "\n" : "");
    return decodeEntities(text);
}
function chooseFence(code) {
    const runs = code.match(/`+/gu) ?? [];
    const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
    return "`".repeat(Math.max(3, longest + 1));
}
function fencedValue(code, language = "") {
    const fence = chooseFence(code);
    return `${fence}${language}\n${code}${code.endsWith("\n") ? "" : "\n"}${fence}`;
}
function inlineValue(code) {
    const runs = code.match(/`+/gu) ?? [];
    const delimiter = "`".repeat(Math.max(1, runs.reduce((max, run) => Math.max(max, run.length), 0) + 1));
    const pad = code.startsWith("`") || code.endsWith("`") || (code.startsWith(" ") && code.endsWith(" "));
    return `${delimiter}${pad ? " " : ""}${code}${pad ? " " : ""}${delimiter}`;
}
function replacePairedElements(html, tag, replace) {
    const parts = [];
    let copied = 0;
    let scan = 0;
    while (scan < html.length) {
        const opening = findTagToken(html, tag, scan);
        if (opening === undefined)
            break;
        scan = opening.end;
        if (opening.closing || opening.selfClosing)
            continue;
        const closing = findClosingTag(html, tag, opening.end);
        if (closing === undefined)
            break;
        parts.push(html.slice(copied, opening.start), replace(html.slice(opening.end, closing.start), opening.attributes));
        copied = closing.end;
        scan = copied;
    }
    parts.push(html.slice(copied));
    return parts.join("");
}
/**
 * 选一个不出现在正文里的占位符前缀。
 *
 * 旧实现逐字符追加下划线并反复 includes：正文若含该前缀加长串下划线，
 * 每次增长都要重扫全文，代价随共同前缀长度平方增长。
 *
 * 这里保持前缀定长：冲突时换一个带随机后缀的候选，最多尝试固定次数。
 * 既避免平方级扫描，也不会把正文里的长串下划线带进占位符本身。
 */
function uniquePrefix(source, base = "\uE000webfetch-code") {
    if (!source.includes(base))
        return base;
    for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = base + "-" + randomBytes(4).toString("hex");
        if (!source.includes(candidate))
            return candidate;
    }
    // 极端构造下仍要给出结果：长度固定，且碰撞概率可忽略。
    return base + "-" + randomBytes(16).toString("hex");
}
function isolateCode(html, source, asText = false) {
    const prefix = uniquePrefix(source);
    const values = new Map();
    let next = 0;
    const token = (value, block) => {
        const key = `${prefix}-${next++}\uE001`;
        values.set(key, value);
        return block ? `\n${key}\n` : key;
    };
    let result = replacePairedElements(html, "pre", (inner, attributes) => {
        const value = codeText(inner);
        if (asText)
            return token(value, true);
        const language = /(?:language|lang)-([\w+-]+)/iu.exec(`${attributes} ${inner}`)?.[1] ?? "";
        return token(fencedValue(value, language), true);
    });
    if (!asText) {
        result = replacePairedElements(result, "code", (inner) => token(inlineValue(codeText(inner)), false));
    }
    return { html: result, values };
}
function restoreTokens(text, values) {
    const first = values.keys().next().value;
    if (first === undefined)
        return text;
    const prefix = first.slice(0, first.lastIndexOf("-") + 1);
    const tokenPattern = new RegExp(`${prefix}\\d+\\uE001`, "gu");
    return text.replace(tokenPattern, (token) => values.get(token) ?? token);
}
/** `<pre>` 转为 Markdown 围栏代码块，保留代码中的空白与实体解码结果。 */
export function fencedCode(html) {
    return replacePairedElements(html, "pre", (inner, attributes) => {
        const code = codeText(inner);
        const language = /(?:language|lang)-([\w+-]+)/iu.exec(`${attributes} ${inner}`)?.[1] ?? "";
        return `\n${fencedValue(code, language)}\n`;
    });
}
/** 转换 HTML 行内代码，保留代码自身空格、制表符与空行。 */
export function inlineCode(html) {
    return replacePairedElements(html, "code", (inner) => inlineValue(codeText(inner)));
}
function safeHref(href, baseUrl) {
    const decoded = decodeEntities(href.trim()).replace(/\s/gu, (character) => encodeURIComponent(character));
    try {
        const url = baseUrl === undefined ? new URL(decoded) : new URL(decoded, baseUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:")
            return undefined;
        return url.toString().replace(/[()]/gu, (character) => character === "(" ? "%28" : "%29");
    }
    catch {
        return undefined;
    }
}
function escapeMarkdownLabel(label) {
    return label.replace(/[\\[\]`]/gu, (character) => `\\${character}`);
}
function protectForFinalDecode(value) {
    return value.replace(/[&<>]/gu, (character) => character === "&" ? "&amp;" : character === "<" ? "&lt;" : "&gt;");
}
function convertLinks(html, baseUrl, deferFinalDecode = false) {
    return replacePairedElements(html, "a", (inner, attributes) => {
        // 必须按完整属性名取 href：正则的 `\bhref` 会把 data-href 也匹配上，
        // 让页面上无关的属性劫持模型的引用地址。
        const href = readAttribute(attributes, "href");
        const rawLabel = stripMarkupRaw(inner).replace(/\s+/gu, " ").trim();
        const label = escapeMarkdownLabel(decodeEntities(rawLabel));
        if (label.length === 0)
            return "";
        const safe = href === undefined ? undefined : safeHref(href, baseUrl);
        const outputLabel = deferFinalDecode ? protectForFinalDecode(label) : label;
        if (safe === undefined)
            return outputLabel;
        const outputHref = deferFinalDecode ? protectForFinalDecode(safe) : safe;
        return `[${outputLabel}](${outputHref})`;
    });
}
/** 将链接转为 Markdown；仅允许 http(s)，可选地解析相对地址。 */
export function links(html, baseUrl) {
    return convertLinks(html, baseUrl);
}
function inlineText(html) {
    return stripMarkupRaw(html).replace(/\s+/gu, " ").trim();
}
/** 标题转 Markdown 标题，层级最多到 6。 */
export function headings(html) {
    for (let level = 1; level <= 6; level++) {
        html = replacePairedElements(html, `h${level}`, (inner) => {
            const text = inlineText(inner);
            return text.length === 0 ? "" : `\n${"#".repeat(level)} ${text}\n`;
        });
    }
    return html;
}
/** 列表项转 Markdown 列表。 */
export function listItems(html) {
    return replacePairedElements(html, "li", (inner) => {
        const text = inlineText(inner);
        return text.length === 0 ? "" : `\n- ${text}\n`;
    });
}
/** 表格转 Markdown 表格，保留单元格内的行内链接与代码。 */
export function tables(html) {
    return replacePairedElements(html, "table", (inner) => {
        const rows = [];
        replacePairedElements(inner, "tr", (row) => {
            const cells = [];
            let cursor = 0;
            let th = findTagToken(row, "th", cursor);
            let td = findTagToken(row, "td", cursor);
            for (;;) {
                const opening = th === undefined ? td : td === undefined || th.start < td.start ? th : td;
                if (opening === undefined)
                    break;
                const tag = opening === th ? "th" : "td";
                cursor = opening.end;
                if (!opening.closing && !opening.selfClosing) {
                    const closing = findClosingTag(row, tag, cursor);
                    if (closing === undefined)
                        break;
                    cells.push(inlineText(row.slice(opening.end, closing.start)));
                    cursor = closing.end;
                }
                if (th !== undefined && th.start < cursor)
                    th = findTagToken(row, "th", cursor);
                if (td !== undefined && td.start < cursor)
                    td = findTagToken(row, "td", cursor);
            }
            if (cells.some((cell) => cell.length > 0))
                rows.push(cells);
            return "";
        });
        if (rows.length === 0)
            return "";
        // 不按最宽行补齐全部行，避免稀疏畸形表格扩张为行数乘最大列数。
        const normalized = rows.map((row) => row.map((cell) => cell.replace(/\|/gu, "\\|")));
        const width = normalized[0].length;
        const line = (cells) => `| ${cells.join(" | ")} |`;
        const separator = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;
        return `\n${line(normalized[0])}\n${separator}\n${normalized.slice(1).map(line).join("\n")}\n`;
    });
}
/** 仅供 HTML/JSON 整理使用；直读 Markdown 与纯文本不会经过此空白压缩。 */
export function tidy(text) {
    return text
        .replace(/\r\n?/gu, "\n")
        .replace(/[ \t\f\v]+/gu, " ")
        .replace(/ *\n */gu, "\n")
        .replace(/\n{3,}/gu, "\n\n")
        .trim();
}
/** HTML → Markdown；代码先隔离，经过其他转换后再恢复，避免解码的 `<T>` 被当作标签。 */
export function htmlToMarkdown(html, baseUrl) {
    const cleaned = stripNoise(html);
    const title = extractTitle(cleaned);
    const isolated = isolateCode(pickContainer(cleaned), cleaned);
    const withLinks = convertLinks(isolated.html, baseUrl, true);
    const withTables = tables(withLinks);
    const withHeadings = headings(withTables);
    const withLists = listItems(withHeadings);
    const markdown = restoreTokens(tidy(decodeEntities(stripMarkupRaw(blockify(withLists)))), isolated.values);
    return { ...(title === undefined ? {} : { title }), markdown };
}
function htmlToText(html) {
    const cleaned = stripNoise(html);
    const isolated = isolateCode(pickContainer(cleaned), cleaned, true);
    const flattened = decodeEntities(stripMarkupRaw(blockify(isolated.html)));
    return restoreTokens(tidy(flattened), isolated.values);
}
/** Markdown 直读不规整空白，避免损坏代码缩进、制表符与空行。 */
export function markdownToMarkdown(body) {
    const markdown = body;
    const heading = body.match(/^\s{0,3}#{1,6}\s+(.+)$/mu);
    return { ...(heading?.[1] === undefined ? {} : { title: heading[1].trim() }), markdown };
}
/** 纯文本直读不规整空白，保留缩进、制表符、尖括号与空行。 */
export function textToMarkdown(body) {
    return { markdown: body };
}
/** JSON：取常见文本字段与 http(s) 链接拼成可读正文，不把原始 JSON 整块灌给模型。 */
export function jsonToMarkdown(body) {
    let parsed;
    try {
        parsed = JSON.parse(body);
    }
    catch {
        return { markdown: "" };
    }
    const texts = [];
    const visit = (value, depth) => {
        if (depth > 6 || texts.length > 400)
            return;
        if (typeof value === "string") {
            const text = value.trim();
            if (text.length > 0)
                texts.push(text);
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value)
                visit(item, depth + 1);
            return;
        }
        if (value !== null && typeof value === "object") {
            for (const [key, item] of Object.entries(value)) {
                if (["url", "href", "link"].includes(key.toLowerCase()) && typeof item === "string" && /^https?:\/\//iu.test(item)) {
                    texts.push(`- ${item}`);
                    continue;
                }
                visit(item, depth + 1);
            }
        }
    };
    visit(parsed, 0);
    const markdown = tidy(texts.join("\n"));
    const title = typeof parsed?.title === "string" ? parsed.title : undefined;
    return { ...(title === undefined ? {} : { title }), markdown };
}
/** 内容类型归一化；忽略参数与大小写差异。 */
function normalizeContentType(contentType) {
    const [main] = contentType.split(";");
    const parts = (main ?? "").trim().toLowerCase().split("/");
    return { type: parts[0] ?? "", subtype: parts[1] ?? "" };
}
/** 没有内容类型时按内容判断是否 HTML。 */
function looksLikeHtml(body) {
    return /^\s*<(?:!doctype html|html|head|body|main|article|div|p)\b/iu.test(body);
}
function openFenceAtEnd(text) {
    let open;
    let lineStart = 0;
    for (const line of text.split("\n")) {
        const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
        if (fence !== null) {
            const marker = fence[1];
            if (open === undefined) {
                if (!(marker[0] === "`" && fence[2].includes("`")))
                    open = { marker, start: lineStart };
            }
            else if (marker[0] === open.marker[0] && marker.length >= open.marker.length && /^[ \t]*$/u.test(fence[2])) {
                open = undefined;
            }
        }
        lineStart += line.length + 1;
    }
    return open;
}
function truncationNotice(maxChars) {
    const full = "\n\n（正文已截断）";
    if (maxChars >= full.length)
        return full;
    if (maxChars >= 3)
        return "截断…";
    return maxChars > 0 ? "…" : "";
}
function truncateMarkdown(markdown, maxChars) {
    const limit = Math.max(0, maxChars);
    const notice = truncationNotice(limit);
    let prefix = safeSlice(markdown, limit - notice.length);
    for (let attempt = 0; attempt < 8; attempt++) {
        const open = openFenceAtEnd(prefix);
        if (open === undefined)
            return `${prefix}${notice}`;
        const closing = `${prefix.endsWith("\n") ? "" : "\n"}${open.marker}`;
        if (prefix.length + closing.length + notice.length <= limit)
            return `${prefix}${closing}${notice}`;
        const nextLength = limit - closing.length - notice.length;
        if (nextLength <= open.start) {
            prefix = safeSlice(markdown, open.start);
            return `${safeSlice(prefix, limit - notice.length)}${notice}`;
        }
        prefix = safeSlice(markdown, nextLength);
    }
    return `${safeSlice(markdown, limit - notice.length)}${notice}`;
}
/**
 * 按内容类型与模式选择提取路径。可选 baseUrl 只用于本地链接绝对化，不会触发请求。
 * 只有内容长度严格大于 maxChars 时才设置 truncated。
 */
export function extractContent(body, contentType, mode, maxChars, baseUrl) {
    // 与 fetchPage 使用同一套模式校验：提取入口本身也要拒绝未知模式，
    // 否则直接调用方会静默拿到非预期分支的结果。
    if (mode !== "auto" && mode !== "article" && mode !== "text")
        throw new FetchError("mode 不受支持", "invalid_url");
    const { type, subtype } = normalizeContentType(contentType);
    const isHtml = subtype === "html" || subtype === "xhtml+xml" || (type === "" && looksLikeHtml(body));
    const isMarkdown = subtype === "markdown" || subtype === "x-markdown" || subtype === "md";
    const isJson = subtype === "json" || subtype.endsWith("+json");
    const isText = subtype === "plain" || subtype.startsWith("text/");
    const base = isJson
        ? jsonToMarkdown(body)
        : isMarkdown
            ? markdownToMarkdown(body)
            : isHtml
                ? mode === "text"
                    ? { markdown: htmlToText(body) }
                    : htmlToMarkdown(body, baseUrl)
                : isText
                    ? textToMarkdown(body)
                    : undefined;
    if (base === undefined)
        throw new FetchError("目标内容类型不受支持", "unsupported_content");
    if (base.markdown.trim().length === 0)
        throw new FetchError("未能从响应中提取到正文", "extraction_failed");
    const truncated = base.markdown.length > maxChars;
    const markdown = truncated ? truncateMarkdown(base.markdown, maxChars) : base.markdown;
    return { ...(base.title === undefined ? {} : { title: base.title }), markdown, truncated };
}
