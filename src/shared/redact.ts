/**
 * 密钥脱敏：唯一实现。
 *
 * 上游可能以多种形式回显密钥（原文、JSON 转义、URL 编码、base64），
 * 只按原文替换会漏掉编码形式。搜索内核与 Pi 适配层都必须走这里，
 * 否则不同宿主对同一份响应会得到不同的遮蔽结果。
 */

/** 百分号转义的正则片段：`%2b`、`%2B`、`%2b` 混用都要命中。 */
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/gu;

/**
 * 把一个已编码的字符串转成"只对十六进制大小写不敏感"的正则。
 *
 * 不能整体加 `i` 标志：密钥本身的字母大小写必须保持敏感，
 * 否则 `Key` 与 `key` 会被当成同一个密钥。
 */
function encodedPattern(encoded: string): string {
	let pattern = "";
	for (let index = 0; index < encoded.length; index++) {
		const character = encoded[index]!;
		const hex = encoded.slice(index + 1, index + 3);
		if (character === "%" && /^[0-9a-f]{2}$/iu.test(hex)) {
			pattern += "%";
			for (const digit of hex) {
				const lower = digit.toLowerCase();
				const upper = digit.toUpperCase();
				pattern += lower === upper ? digit : `[${upper}${lower}]`;
			}
			index += 2;
		} else {
			pattern += REGEX_SPECIALS.test(character) ? `\\${character}` : character;
			REGEX_SPECIALS.lastIndex = 0;
		}
	}
	return pattern;
}

/** 单个密钥需要遮蔽的全部编码形态，按长度降序以便先替换长串。 */
export function secretVariants(secret: string): string[] {
	if (secret.length === 0) return [];
	const values = new Set<string>([secret]);
	values.add(JSON.stringify(secret).slice(1, -1));
	const encoded = encodeURIComponent(secret);
	values.add(encoded);
	values.add(encodeURIComponent(encoded));
	values.add(encoded.replace(/%[0-9A-F]{2}/gu, (part) => part.toLowerCase()));
	values.add(Buffer.from(secret, "utf8").toString("base64"));
	values.add(Buffer.from(secret, "utf8").toString("base64url"));
	return [...values].filter((value) => value.length > 0).sort((left, right) => right.length - left.length);
}

/** 把一组密钥展开成全部需要遮蔽的形态。 */
export function expandSecrets(secrets: readonly (string | undefined)[]): string[] {
	const values = new Set<string>();
	for (const secret of secrets) {
		if (secret === undefined) continue;
		for (const variant of secretVariants(secret)) values.add(variant);
	}
	return [...values].sort((left, right) => right.length - left.length);
}

/** 每个密钥可匹配的正则集合：字面量形态 + 十六进制大小写不敏感的编码形态。 */
function secretMatchers(secret: string): RegExp[] {
	const matchers: RegExp[] = [];
	const seen = new Set<string>();
	for (const variant of secretVariants(secret)) {
		for (const source of [variant, encodedPattern(variant)]) {
			if (source.length === 0 || seen.has(source)) continue;
			seen.add(source);
			// 不含百分号转义的形态用字面量更快，但仍按同一顺序替换。
			matchers.push(source === variant ? new RegExp(matchLiteral(variant), "gu") : new RegExp(source, "gu"));
		}
	}
	return matchers.sort((left, right) => right.source.length - left.source.length);
}

function matchLiteral(value: string): string {
	let pattern = "";
	for (const character of value) {
		pattern += REGEX_SPECIALS.test(character) ? `\\${character}` : character;
		REGEX_SPECIALS.lastIndex = 0;
	}
	return pattern;
}

/**
 * 替换全部命中项。
 *
 * 接受原始密钥：字面量与编码形态都在这里展开。百分号转义的十六进制
 * 字母大小写不敏感（`%2b` 与 `%2B` 等价），其余字符保持大小写敏感。
 */
export function redactSecrets(value: string, secrets: readonly (string | undefined)[]): string {
	let safe = value;
	for (const secret of secrets) {
		if (secret === undefined || secret.length === 0) continue;
		for (const matcher of secretMatchers(secret)) safe = safe.replace(matcher, "***");
	}
	return safe;
}
