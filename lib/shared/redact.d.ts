/**
 * 密钥脱敏：唯一实现。
 *
 * 上游可能以多种形式回显密钥（原文、JSON 转义、URL 编码、base64），
 * 只按原文替换会漏掉编码形式。搜索内核与 Pi 适配层都必须走这里，
 * 否则不同宿主对同一份响应会得到不同的遮蔽结果。
 */
/** 单个密钥需要遮蔽的全部编码形态，按长度降序以便先替换长串。 */
export declare function secretVariants(secret: string): string[];
/** 把一组密钥展开成全部需要遮蔽的形态。 */
export declare function expandSecrets(secrets: readonly (string | undefined)[]): string[];
/**
 * 替换全部命中项。
 *
 * 接受原始密钥或已展开的变体：调用方可以只传原始密钥（这里再展开），
 * 也可以传入 {@link expandSecrets} 的结果以避免重复计算。
 */
export declare function redactSecrets(value: string, secrets: readonly (string | undefined)[]): string;
