/**
 * 第四轮审查的回归测试。
 *
 * 覆盖上一轮引入的状态一致性回归（序号语义）、查询串泄露，
 * 以及两处正文提取边界；并补齐此前缺失的 T01／T02／V01 回归。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const extract = await import(new URL("../lib/fetch/extract/index.js", import.meta.url));
const dsh = await import(new URL("../lib/hosts/dsh.js", import.meta.url));
const fetchErrors = await import(new URL("../lib/fetch/errors.js", import.meta.url));

const jiti = createJiti(import.meta.url);
const { createQuotaManager } = await jiti.import(fileURLToPath(new URL("../src/quota/core.ts", import.meta.url)));
const { createPrivateQuotaStateStore } = await jiti.import(fileURLToPath(new URL("../src/quota/state-store.ts", import.meta.url)));
const pi = await jiti.import(fileURLToPath(new URL("../src/hosts/pi.ts", import.meta.url)));
const plugin = pi.default ?? pi;

const run = (html) => extract.extractContent(html, "text/html", "auto", 24_000).markdown;

// ---- 状态一致性 ----

// 与项目其余测试一致：夹具放项目 .temp/，不进入版本库。
const ROOT = fileURLToPath(new URL("../.temp/round4-fixtures/", import.meta.url));
mkdirSync(ROOT, { recursive: true });

function quotaFixture() {
	const dir = mkdtempSync(join(ROOT, "case-"));
	let now = 0;
	const credential = "synthetic-credential";
	const make = () => createQuotaManager({
		stateStore: createPrivateQuotaStateStore(dir),
		clock: () => now,
		lookup: async () => ({ state: "known", remaining: 100, eligibility: "not_verified" }),
	});
	const entries = () => readdirSync(dir).filter((name) => name.startsWith("scope-"))
		.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")).entry);
	return { dir, credential, make, entries, setNow: (value) => { now = value; }, getNow: () => now };
}

test("旧快照重放不得覆盖较新的清除", async () => {
	const fixture = quotaFixture();
	const older = fixture.make();
	await older.initialize();
	fixture.setNow(1_000);
	older.recordFailure("tavily", "key", "rate_limited", { credential: fixture.credential });
	await older.flush();
	// 新实例在失败写盘之后加载，才看得到这条记录并清除它。
	const newer = fixture.make();
	await newer.initialize();
	fixture.setNow(2_000);
	newer.recordSuccess("tavily", "key", fixture.credential);
	await newer.flush();
	// 旧实例带着旧快照再次保存。
	await older.flush();
	const reloaded = fixture.make();
	await reloaded.initialize();
	assert.equal(reloaded.getCooldown("tavily", "key", fixture.credential), undefined, "旧失败不应被重新写活");
});

test("旧格式条目迁移后，新失败不被旧墓碑吞掉", async () => {
	const fixture = quotaFixture();
	const seed = fixture.make();
	await seed.initialize();
	await seed.flush();
	fixture.setNow(1_000_000);
	const first = fixture.make();
	await first.initialize();
	first.recordFailure("tavily", "key", "rate_limited", { credential: fixture.credential });
	await first.flush();
	const scopeId = fixture.entries()[0].scopeId;
	// 模拟升级前的旧文件：没有 sequence，只有墙钟时间戳。
	writeFileSync(join(fixture.dir, `scope-${scopeId}-rate_limited.json`), JSON.stringify({
		version: 1,
		entry: {
			scopeId, backend: "tavily", channel: "key", reason: "rate_limited",
			failureCount: 0, until: 2_000_000, lastFailureAt: 1_000_000, updatedAt: 1_000_000, cleared: true,
		},
	}));
	const fresh = fixture.make();
	await fresh.initialize();
	fixture.setNow(1_100_000);
	fresh.recordFailure("tavily", "key", "rate_limited", { credential: fixture.credential });
	await fresh.flush();
	const entry = fixture.entries()[0];
	assert.ok(entry.sequence > 1_000_000, `新事件序号 ${entry.sequence} 必须大于旧时间戳`);
	assert.notEqual(entry.cleared, true);
});

test("未变化的条目不会被重复重写", async () => {
	const fixture = quotaFixture();
	const manager = fixture.make();
	await manager.initialize();
	fixture.setNow(500);
	manager.recordFailure("tavily", "key", "rate_limited", { credential: fixture.credential });
	await manager.flush();
	manager.recordFailure("firecrawl", "key", "quota_exhausted", { credential: fixture.credential });
	await manager.flush();
	const before = new Map(fixture.entries().map((entry) => [entry.scopeId, entry.sequence]));
	fixture.setNow(600);
	manager.recordFailure("tavily", "key", "rate_limited", { credential: fixture.credential });
	await manager.flush();
	const after = new Map(fixture.entries().map((entry) => [entry.scopeId, entry.sequence]));
	const unchanged = [...before].filter(([scopeId, sequence]) => after.get(scopeId) === sequence);
	assert.equal(unchanged.length, 1, "只有发生事件的条目应获得新序号");
});

// ---- 查询串泄露 ----

test("错误结果的地址不泄露查询串", async () => {
	const provider = new dsh.LocalFirstFetchProvider(
		{ maxChars: 24_000, timeoutMs: 5_000, deadlineMs: 5_000, maxResponseBytes: 5_242_880, maxRedirects: 3, maxAttempts: 1, userAgent: "test", allowPrivateHosts: false },
		{
			resolveTarget: async () => ({ address: "203.0.113.10", family: 4 }),
			fetchPage: async () => {
				throw new fetchErrors.FetchError("目标不存在", "http_error", {
					statusCode: 404,
					finalUrl: "https://final.example.test/missing?token=SECRET&sig=abc",
				});
			},
		},
	);
	const result = await provider.fetch({ url: "https://start.example.test/?token=INITIAL" });
	assert.equal(result.statusCode, 404);
	assert.equal(result.url, "https://final.example.test/missing");
	assert.ok(!result.url.includes("SECRET") && !result.url.includes("INITIAL"));
});

// ---- 正文提取边界 ----

test("iframe 与 xmp 内的仿冒容器不抢占正文", () => {
	for (const tag of ["iframe", "xmp"]) {
		const markdown = run(`<html><body><${tag}><main>伪正文</main></${tag}><article>真实文章</article></body></html>`);
		assert.ok(markdown.includes("真实文章"), `${tag} 内应取到真实文章`);
		assert.ok(!markdown.includes("伪正文"), `${tag} 内的容器不应被选中`);
	}
});

test("没有语义容器时保留文章头部，只剔除站点导航", () => {
	const article = run("<html><body><header><h1>文章标题</h1><p>摘要内容</p></header><p>正文</p></body></html>");
	assert.ok(article.includes("文章标题"));
	assert.ok(article.includes("摘要内容"));

	const nav = run('<html><body><header><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></header><p>正文</p></body></html>');
	assert.ok(!nav.includes(">A<") && !nav.includes(" A "), "链接密集的菜单条应被剔除");
	assert.ok(nav.includes("正文"));

	const navTag = run('<html><body><header><nav><a href="/x">菜单项</a></nav></header><p>正文</p></body></html>');
	assert.ok(!navTag.includes("菜单项"));
});

// ---- Pi 适配层的校验与预算 ----

function setupTool(store) {
	let tool;
	plugin({ registerTool: (value) => { tool = value; }, registerCommand() {} }, { credentialStore: store });
	return tool;
}

test("超长查询在读取凭据之前被拒绝", async () => {
	const saved = { ...process.env };
	let reads = 0;
	try {
		process.env.PI_WEB_SEARCH_ALLOW_BILLABLE = "true";
		const tool = setupTool({ kind: "none", async read() { reads += 1; return { status: "missing" }; } });
		await assert.rejects(tool.execute("long", { query: "x".repeat(3_000), provider: "exa" }), /不得超过/u);
		assert.equal(reads, 0, "非法请求不得触发凭据读取");
	} finally {
		process.env = saved;
	}
});

test("预算耗尽后不再派发请求", async () => {
	const saved = { ...process.env };
	const oldFetch = globalThis.fetch;
	let requests = 0;
	try {
		process.env.PI_WEB_SEARCH_TOTAL_TIMEOUT_MS = "1000";
		process.env.PI_WEB_SEARCH_TIMEOUT_MS = "1000";
		process.env.PI_WEB_SEARCH_ALLOW_BILLABLE = "true";
		const tool = setupTool({
			kind: "none",
			async read() {
				// 同步阻塞超过整次预算：模拟事件循环被占住。
				const started = Date.now();
				while (Date.now() - started < 1_080) { /* busy wait */ }
				return { status: "missing" };
			},
		});
		globalThis.fetch = async () => { requests += 1; return new Response("{}", { status: 200 }); };
		await assert.rejects(tool.execute("overdue", { query: "q", provider: "serpapi" }));
		assert.equal(requests, 0, "预算已过期时不得再发请求");
	} finally {
		globalThis.fetch = oldFetch;
		process.env = saved;
	}
});

test("墙钟回拨不延长总预算", async () => {
	const saved = { ...process.env };
	const oldFetch = globalThis.fetch;
	const realNow = Date.now;
	let requests = 0;
	try {
		process.env.PI_WEB_SEARCH_TOTAL_TIMEOUT_MS = "1000";
		process.env.PI_WEB_SEARCH_TIMEOUT_MS = "1000";
		process.env.PI_WEB_SEARCH_ALLOW_BILLABLE = "true";
		const tool = setupTool({
			kind: "none",
			async read() {
				await new Promise((resolve) => setTimeout(resolve, 700));
				// 凭据阶段把墙钟往回拨五秒：单调预算不应因此变长。
				Date.now = () => realNow() - 5_000;
				return { status: "missing" };
			},
		});
		globalThis.fetch = async () => {
			requests += 1;
			await new Promise((resolve) => setTimeout(resolve, 700));
			return new Response("{}", { status: 200 });
		};
		const started = realNow();
		let failed = false;
		try {
			await tool.execute("skew", { query: "q", provider: "exa" });
		} catch {
			failed = true;
		}
		const elapsed = realNow() - started;
		assert.equal(failed, true, "回拨后仍应按原预算超时");
		assert.ok(elapsed < 1_600, `实际耗时 ${elapsed}ms，不应被回拨延长`);
	} finally {
		Date.now = realNow;
		globalThis.fetch = oldFetch;
		process.env = saved;
	}
});
