/**
 * 共享模块的回归：合并两侧重复实现后，这些语义必须保持不变。
 *
 * 覆盖 `parseRetryAfter`（含抓取不钳制、搜索钳制 24 小时两种用法）与
 * 统一后的有界读取（搜索入口固定 UTF-8，抓取入口按声明解码）。
 */
import assert from "node:assert/strict";
import test from "node:test";

const retry = await import(new URL("../lib/shared/retry-after.js", import.meta.url));
const shared = await import(new URL("../lib/shared/response-body.js", import.meta.url));
const fetchBody = await import(new URL("../lib/fetch/transport/response-body.js", import.meta.url));

const DAY_MS = 24 * 60 * 60 * 1000;

test("retry-after：秒数、HTTP 日期与非法值", () => {
	assert.equal(retry.parseRetryAfter("2"), 2000);
	assert.equal(retry.parseRetryAfter(" 3 "), 3000);
	assert.equal(retry.parseRetryAfter("0"), 0);
	assert.equal(retry.parseRetryAfter(null), undefined);
	assert.equal(retry.parseRetryAfter(""), undefined);
	assert.equal(retry.parseRetryAfter("not-a-number"), undefined);
	const now = Date.parse("2026-01-01T00:00:00Z");
	assert.equal(retry.parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", { now }), 30_000);
	// 已过去的日期钳到 0，不返回负值。
	assert.equal(retry.parseRetryAfter("Wed, 31 Dec 2025 00:00:00 GMT", { now }), 0);
});

test("retry-after：搜索钳制 24 小时，抓取保留原值", () => {
	const huge = String(72 * 60 * 60);
	assert.equal(retry.parseRetryAfter(huge, { maxMs: retry.RETRY_AFTER_MAX_MS }), DAY_MS);
	assert.equal(retry.parseRetryAfter(huge), 72 * 60 * 60 * 1000);
});

test("retry-after：数组头取第一个值", () => {
	assert.equal(retry.parseRetryAfterHeader(["5"]), 5000);
	assert.equal(retry.parseRetryAfterHeader(["5", "9"]), 5000);
	assert.equal(retry.parseRetryAfterHeader(undefined), undefined);
});

test("共享读取：搜索入口固定 UTF-8，超限与取消保持既有分类", async () => {
	assert.equal(await shared.readResponseTextLimited(new Response("你好"), 6, new AbortController()), "你好");
	await assert.rejects(
		shared.readResponseTextLimited(new Response("你好"), 5, new AbortController()),
		(error) => error.kind === "response_too_large" && error.tooLarge === true,
	);
	// 搜索入口不做字符集探测：GBK 字节按 UTF-8 解出替换字符，而不是失败。
	const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
	const text = await shared.readResponseTextLimited(new Response(gbk), 16, new AbortController());
	assert.ok(text.length > 0);
	const controller = new AbortController();
	const pending = shared.readResponseTextLimited(new Response(new ReadableStream({ pull() { return new Promise(() => {}); } })), 16, controller);
	setTimeout(() => controller.abort(), 5);
	await assert.rejects(pending, (error) => error.name === "AbortError");
});

test("共享读取：抓取入口按声明字符集解码并保留 FetchError 分类", async () => {
	const response = new Response(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]), { headers: { "content-type": "text/plain; charset=gbk" } });
	assert.equal(await fetchBody.readResponseTextLimited(response, 16), "中文");
	await assert.rejects(
		fetchBody.readResponseTextLimited(new Response("text", { headers: { "content-type": "text/plain; charset=no-such" } }), 32),
		(error) => error.kind === "unsupported_content",
	);
});

test("共享读取：两侧共用同一份字节计数，恰好达到上限不算超限", async () => {
	const body = new TextEncoder().encode("汉A");
	assert.equal(await shared.readResponseTextLimited(new Response(body), body.byteLength, new AbortController()), "汉A");
	assert.equal(await fetchBody.readResponseTextLimited(new Response(body), body.byteLength), "汉A");
	await assert.rejects(
		fetchBody.readResponseTextLimited(new Response(body), body.byteLength - 1),
		(error) => error.kind === "response_too_large",
	);
});

test("上限常量只有一处定义，两处导出指向同一个值", () => {
	assert.equal(shared.DEFAULT_MAX_RESPONSE_BYTES, 5 * 1024 * 1024);
	assert.equal(shared.MAX_RESPONSE_BYTES, 20 * 1024 * 1024);
	return import(new URL("../lib/fetch/config.js", import.meta.url)).then((config) => {
		assert.equal(config.DEFAULT_MAX_RESPONSE_BYTES, shared.DEFAULT_MAX_RESPONSE_BYTES);
		assert.equal(config.MAX_RESPONSE_BYTES, shared.MAX_RESPONSE_BYTES);
	});
});
