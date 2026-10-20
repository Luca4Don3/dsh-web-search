/**
 * 按字符预算截断，但不把代理对切成两半。
 *
 * 直接 `slice` 可能停在高位代理之后，留下一个孤立码元：
 * 内容 `isWellFormed()` 为 false，按 UTF-8 编码时变成替换字符。
 */
/** 截断到 `maxLength` 个 UTF-16 码元；若边界落在代理对中间则回退一位。 */
export declare function safeSlice(value: string, maxLength: number): string;
