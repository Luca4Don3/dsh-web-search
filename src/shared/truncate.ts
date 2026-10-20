/**
 * 按字符预算截断，但不把代理对切成两半。
 *
 * 直接 `slice` 可能停在高位代理之后，留下一个孤立码元：
 * 内容 `isWellFormed()` 为 false，按 UTF-8 编码时变成替换字符。
 */

/** 截断到 `maxLength` 个 UTF-16 码元；若边界落在代理对中间则回退一位。 */
export function safeSlice(value: string, maxLength: number): string {
	let end = Math.max(0, Math.min(value.length, maxLength));
	if (end > 0 && end < value.length) {
		const current = value.charCodeAt(end);
		const previous = value.charCodeAt(end - 1);
		if (current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) end--;
	}
	return value.slice(0, end);
}
