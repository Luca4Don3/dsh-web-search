/**
 * 密钥脱敏：唯一实现。
 *
 * 上游可能以多种形式回显密钥（原文、JSON 转义、网址组件编码、标准表单编码、
 * base64），只按原文替换会漏掉编码形式。搜索内核、Pi 适配层与认证层都必须走这里，
 * 否则同一份响应在不同宿主会得到不同的遮蔽结果。
 */

/** 与搜索内核一致的密钥长度上限：脱敏覆盖范围内不存在"被跳过"的合法密钥。 */
export const MAX_SECRET_CHARS = 4096;

/** 正则元字符：逐个转义，避免密钥里的符号被当成模式。 */
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

/** 标准表单编码（`application/x-www-form-urlencoded`）。 */
function formEncode(value: string): string {
	return new URLSearchParams({ v: value }).toString().slice(2);
}

/** 单个密钥需要遮蔽的全部编码形态，按长度降序以便先替换长串。 */
export function secretVariants(secret: string): string[] {
	if (secret.length === 0) return [];
	const values = new Set<string>([secret]);
	values.add(JSON.stringify(secret).slice(1, -1));

	const uriEncoded = encodeURIComponent(secret);
	values.add(uriEncoded);
	values.add(encodeURIComponent(uriEncoded));
	values.add(uriEncoded.replace(/%[0-9A-F]{2}/gu, (part) => part.toLowerCase()));

	// 表单编码与网址组件编码并不等价：空格是 `+` 而非 `%20`，波浪号被转义为 `%7E`。
	// 认证层历史上已覆盖这一形态，共享化时不能丢掉。
	const formEncoded = formEncode(secret);
	if (formEncoded !== secret) values.add(formEncoded);
	values.add(formEncode(formEncoded));
	values.add(formEncoded.replace(/%[0-9A-F]{2}/gu, (part) => part.toLowerCase()));
	// 空格的两种写法可以互换，交叉形态也要承认。
	if (formEncoded.includes("+")) values.add(formEncoded.replace(/\+/gu, "%20"));
	if (uriEncoded.includes("%20")) values.add(uriEncoded.replace(/%20/gu, "+"));

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

/** 字面量形态的正则源：仅转义元字符。 */
function matchLiteral(value: string): string {
	let pattern = "";
	for (const character of value) {
		pattern += REGEX_SPECIALS.test(character) ? `\\${character}` : character;
		REGEX_SPECIALS.lastIndex = 0;
	}
	return pattern;
}

/** 每个密钥可匹配的正则集合：字面量形态 + 十六进制大小写不敏感的编码形态。 */
function secretMatchers(secret: string): RegExp[] {
	const matchers: RegExp[] = [];
	const seen = new Set<string>();
	for (const variant of secretVariants(secret)) {
		for (const source of [matchLiteral(variant), encodedPattern(variant)]) {
			if (source.length === 0 || seen.has(source)) continue;
			seen.add(source);
			matchers.push(new RegExp(source, "gu"));
		}
	}
	return matchers;
}

/**
 * 替换全部命中项。
 *
 * 百分号转义的十六进制字母大小写不敏感（`%2b` 与 `%2B` 等价），
 * 其余字符保持大小写敏感。用平直的正则逐个替换，不做跨形态的贪婪匹配。
 */
/** 十六进制位的大小写不敏感形式：`B` 写作 `[Bb]`，数字原样。 */
function hexPair(byte: number): string {
	const hex = byte.toString(16).toUpperCase().padStart(2, "0");
	let pattern = "";
	for (const digit of hex) pattern += digit >= "A" ? `[${digit}${digit.toLowerCase()}]` : digit;
	return pattern;
}

/**
 * 任意"部分百分号编码"形态的正则。
 *
 * `encodeURIComponent` 只产出一种标准写法，但上游可以合法地把任意一个字符
 * 单独转义（`F` → `%46`），一次标准解码就还原出完整密钥。
 * 这里把每个字符展开成"原形或它的转义"，覆盖任意组合。
 *
 * 只对含 `%` 的文本启用，并限定密钥长度，避免在长文本上引入可观的匹配开销。
 */
function flexibleEncodedPattern(secret: string): string {
	let pattern = "";
	for (const character of secret) {
		const code = character.codePointAt(0);
		if (code === undefined || code > 0x7f) {
			pattern += REGEX_SPECIALS.test(character) ? `\\${character}` : character;
			REGEX_SPECIALS.lastIndex = 0;
			continue;
		}
		const literal = REGEX_SPECIALS.test(character) ? `\\${character}` : character;
		REGEX_SPECIALS.lastIndex = 0;
		pattern += `(?:${literal}|%${hexPair(code)})`;
	}
	return pattern;
}

export function redactSecrets(value: string, secrets: readonly (string | undefined)[]): string {
	const matchers: RegExp[] = [];
	for (const secret of secrets) {
		if (secret === undefined || secret.length === 0) continue;
		matchers.push(...secretMatchers(secret));
	}
	// 跨**全部**密钥按长度降序：若短密钥先替换，会把长密钥的匹配切断，
	// 只留下前缀被遮蔽、后缀仍然外泄。排序必须覆盖所有密钥的所有形态。
	matchers.sort((left, right) => right.source.length - left.source.length);
	let safe = value;
	for (const matcher of matchers) {
		matcher.lastIndex = 0;
		safe = safe.replace(matcher, "***");
	}
	// 标准写法之外，再覆盖"任意字符被单独转义"的等价表示。
	// 没有百分号的文本不需要走这条较重的路径。
	if (!value.includes("%")) return safe;
	// flexible 阶段也必须**跨全部密钥按长度降序**：短密钥先命中会把长密钥的
	// 匹配切碎（`%41BCDEFGH` 若先匹配 ABCD，会留下 `***EFGH`）。
	//
	// 这里覆盖全部合法密钥长度（内核上限 4096）。早前版本设了 128 字符的静默
	// 上限，超出者完全跳过编码覆盖——长 token（JWT、自建代理凭据）因此不受保护。
	// 实测 630 KB 文本 + 5 个 4096 字符密钥约 44 ms，无需为此降级。
	const flexible = secrets
		.filter((secret): secret is string => typeof secret === "string" && secret.length >= 4 && secret.length <= MAX_SECRET_CHARS)
		.sort((left, right) => right.length - left.length);
	for (const secret of flexible) {
		safe = safe.replace(new RegExp(flexibleEncodedPattern(secret), "gu"), "***");
	}
	return safe;
}
