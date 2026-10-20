/**
 * 密钥脱敏：唯一实现。
 *
 * 上游可能以多种形式回显密钥（原文、JSON 转义、网址组件编码、标准表单编码、
 * base64），只按原文替换会漏掉编码形式。搜索内核、Pi 适配层与认证层都必须走这里，
 * 否则同一份响应在不同宿主会得到不同的遮蔽结果。
 */
/** 单个密钥需要遮蔽的全部编码形态，按长度降序以便先替换长串。 */
export declare function secretVariants(secret: string): string[];
/** 把一组密钥展开成全部需要遮蔽的形态。 */
export declare function expandSecrets(secrets: readonly (string | undefined)[]): string[];
export declare function redactSecrets(value: string, secrets: readonly (string | undefined)[]): string;
