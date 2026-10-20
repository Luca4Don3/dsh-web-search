/** 只渲染掩码的终端密钥输入；不使用带明文渲染、撤销栈或剪切环的普通输入组件。 */

import {
	CURSOR_MARKER,
	decodeKittyPrintable,
	matchesKey,
	truncateToWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";
import { isValidSecretValue, MAX_SECRET_CHARS } from "./credentials.js";

/**
 * xterm 的 modifyOtherKeys 协议：`ESC [ 27 ; modifier ; codepoint ~`。
 *
 * 常用于输入需要 Shift 的符号（`!`、`@`、`#`…）。这类序列不是 Kitty 协议，
 * `decodeKittyPrintable` 认不出来；早前版本把它当作"未知转义"整体丢弃，
 * 用户手输 `!` 时字符消失，最后却提示"已保存并验证"。
 */
function decodeModifyOtherKeys(data: string): string | undefined {
	const match = /^\u001b\[27;(\d+);(\d+)~$/u.exec(data);
	if (match === null) return undefined;
	const modifier = Number(match[1]);
	const code = Number(match[2]);
	// 无法打印的码点不是密钥输入。
	if (!Number.isSafeInteger(code) || code < 0x21 || code > 0x7e) return "";
	// 只有无修饰（1）与仅 Shift（2）时，码点才等同于字符本身。
	// Ctrl/Alt/Meta 组合是快捷键（如 Ctrl+! ），既不能插入字符，也不该报错——
	// 返回空串表示"已识别的快捷键"，与"完全不认识的转义"区分开。
	return modifier === 1 || modifier === 2 ? String.fromCodePoint(code) : "";
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const INPUT_ERROR = "密钥须为非空、无空白的可打印字符，最多 4096 个字符。";

export class MaskedInput implements Component, Focusable {
	focused = false;
	private value = "";
	private cursor = 0;
	private error = "";
	private closed = false;
	private pasting = false;
	private pasteValue = "";
	private pasteTail = "";
	private pasteInvalid = false;

	constructor(
		private readonly title: string,
		private readonly done: (value: string | undefined) => void,
		private readonly requestRender: () => void = () => undefined,
	) {}

	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.finish(undefined);
			return;
		}
		if (this.pasting) {
			this.consumePaste(data);
		} else {
			const start = data.indexOf(PASTE_START);
			if (start >= 0) {
				if (start > 0) this.insert(data.slice(0, start));
				this.pasting = true;
				this.pasteValue = "";
				this.pasteTail = "";
				this.pasteInvalid = false;
				this.consumePaste(data.slice(start + PASTE_START.length));
			} else if (matchesKey(data, "enter") || data === "\n") {
				if (this.error.length === 0 && isValidSecretValue(this.value)) this.finish(this.value);
				else this.error = INPUT_ERROR;
			} else if (matchesKey(data, "backspace")) {
				if (this.cursor > 0) {
					this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
					this.cursor--;
				}
				this.error = "";
			} else if (matchesKey(data, "delete")) {
				this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
				this.error = "";
			} else if (matchesKey(data, "ctrl+u")) {
				this.value = "";
				this.cursor = 0;
				this.error = "";
			} else if (matchesKey(data, "left")) {
				this.cursor = Math.max(0, this.cursor - 1);
			} else if (matchesKey(data, "right")) {
				this.cursor = Math.min(this.value.length, this.cursor + 1);
			} else if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) {
				this.cursor = 0;
			} else if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) {
				this.cursor = this.value.length;
			} else {
				const printable = decodeKittyPrintable(data) ?? decodeModifyOtherKeys(data);
				// 未识别的终端转义序列不能被当作密钥，也不能渲染出来；
				// 但也不能静默丢弃——用户会以为字符已输入，最后保存成错误的密钥。
				if (printable !== undefined) this.insert(printable);
				else if (data.includes("\x1b")) this.error = "无法识别该按键；请改用粘贴输入。";
				else this.insert(data);
			}
		}
		this.requestRender();
	}

	private insert(text: string): void {
		if (text.length === 0) return;
		if (!/^[\x21-\x7E]+$/u.test(text) || this.value.length + text.length > MAX_SECRET_CHARS) {
			this.error = INPUT_ERROR;
			return;
		}
		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
		this.error = "";
	}

	/** 流式识别跨数据块的粘贴结束标记；超长或含控制字符的粘贴整体拒绝，不截断密钥。 */
	private consumePaste(data: string): void {
		const chunk = this.pasteTail + data;
		this.pasteTail = "";
		const end = chunk.indexOf(PASTE_END);
		let content = chunk;
		if (end < 0) {
			let tailLength = Math.min(chunk.length, PASTE_END.length - 1);
			while (tailLength > 0 && !PASTE_END.startsWith(chunk.slice(-tailLength))) tailLength--;
			if (tailLength > 0) {
				this.pasteTail = chunk.slice(-tailLength);
				content = chunk.slice(0, -tailLength);
			}
		} else content = chunk.slice(0, end);
		if (!this.pasteInvalid) {
			if (
				(content.length > 0 && !/^[\x21-\x7E]+$/u.test(content)) ||
				this.value.length + this.pasteValue.length + content.length > MAX_SECRET_CHARS
			) {
				this.pasteInvalid = true;
				this.pasteValue = "";
			} else this.pasteValue += content;
		}
		if (end < 0) return;
		this.pasting = false;
		if (this.pasteInvalid) this.error = INPUT_ERROR;
		else this.insert(this.pasteValue);
		this.pasteValue = "";
		this.pasteTail = "";
		this.pasteInvalid = false;
		const remaining = chunk.slice(end + PASTE_END.length);
		if (remaining.length > 0) this.handleInput(remaining);
	}

	render(width: number): string[] {
		const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		const clip = (text: string): string => truncateToWidth(text, columns, "");
		const prefix = columns >= 3 ? "> " : "";
		const available = columns - prefix.length;
		let input = "";
		if (available > 0) {
			const start = Math.max(0, this.cursor - available + 1);
			const before = "*".repeat(this.cursor - start);
			const at = this.cursor < this.value.length ? "*" : " ";
			const after = "*".repeat(Math.min(this.value.length - this.cursor - (at === "*" ? 1 : 0), available - before.length - 1));
			input = prefix + before + (this.focused ? CURSOR_MARKER : "") + `\x1b[7m${at}\x1b[27m` + after;
		}
		return [clip(this.title), input, clip(this.error || "回车保存 · 退出键取消 · 控制键加 U 清空")];
	}

	invalidate(): void {}

	private finish(value: string | undefined): void {
		this.dispose();
		this.done(value);
	}

	/** 清除组件对凭据的引用；字符串的物理内存擦除不由 JavaScript 保证。 */
	dispose(): void {
		this.closed = true;
		this.value = "";
		this.cursor = 0;
		this.pasteValue = "";
		this.pasteTail = "";
		this.pasting = false;
		this.error = "";
	}
}
