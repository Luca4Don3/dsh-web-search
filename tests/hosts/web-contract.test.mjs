/** 官方 Cordis/Web 服务是真实实现；搜索传输为离线替身，抓取只连接临时回环服务器。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import WebRuntime, { WebError } from "@deepseek-ai/dsh-web";
import { createPlugin, FreeFirstProvider, LocalFirstFetchProvider } from "./lib/index.js";
import { readWebFetchConfig } from "./lib/fetch/config.js";

const hit = "Title: 匿名文档\nURL: https://example.test/docs\nHighlights:\n离线摘要";
const reply = () => new Response(JSON.stringify({ result: { content: [{ type: "text", text: hit }] } }));
async function directory() {
  await mkdir("state", { recursive: true });
  return mkdtemp(join(process.cwd(), "state", "test-"));
}
function plugin(fetch = async () => reply()) {
  return createPlugin({ env: {}, fetch, resolveKey: async () => { assert.fail("匿名模式不得读取凭据"); } });
}
const pinned = { searchProvider: "free-first", fetchProvider: "local-first" };
async function withContext(fn, config = pinned) {
  const ctx = new Context();
  await ctx.plugin(WebRuntime, config);
  try { await fn(ctx); }
  finally { await ctx.fiber.dispose(); }
}
function code(expected) {
  return (error) => error instanceof WebError && error.code === expected;
}

test("匿名提供方不依赖凭据/LLM 服务；保持注册 API、固定 id 和原生返回结构", async () => {
  await withContext(async (ctx) => {
    let calls = 0;
    await ctx.plugin(plugin(async (_url, init) => {
      calls++;
      assert.equal(new Headers(init.headers).has("authorization"), false);
      return reply();
    }), { stateDirectory: await directory(), retries: 0 });
    const result = await ctx.web.search({ query: "无凭据搜索", maxResults: 1 });
    assert.deepEqual(result.sources.map((source) => source.title), ["匿名文档"]);
    assert.equal(result.truncated, false);
    assert.equal(calls, 1);
    assert.ok(!Object.hasOwn(result, "backend") && !Object.hasOwn(result, "accessTier"));
    // 此地址在 DNS/HTTP 前即被拒绝，验证默认插件确实注册了抓取，而不是替换工具。
    await assert.rejects(ctx.web.fetch({ url: "http://127.0.0.1/" }), code("WEB_FETCH_BLOCKED_URL"));
    assert.equal(ctx.tools, undefined);
  });
});

test("必需 web 依赖支持迟到、撤销和重新提供；无 tools/凭据依赖", async () => {
  const ctx = new Context();
  const fiber = await ctx.plugin(plugin(), { stateDirectory: await directory() });
  try {
    assert.equal(fiber.state, 0); // Cordis PENDING
    assert.equal(ctx.web, undefined);
    const runtime = await ctx.plugin(WebRuntime, pinned);
    await fiber.await();
    assert.equal(fiber.state, 2); // ACTIVE
    assert.equal((await ctx.web.search({ query: "依赖已到达" })).sources.length, 1);
    await runtime.dispose();
    await fiber.await();
    assert.equal(fiber.state, 0);
    await ctx.plugin(WebRuntime, pinned);
    await fiber.await();
    assert.equal((await ctx.web.search({ query: "依赖重新提供" })).sources.length, 1);
  } finally { await ctx.fiber.dispose(); }
});

test("取消及卸载撤销在途搜索；卸载后不残留 provider，重复卸载与重载安全", async () => {
  await withContext(async (ctx) => {
    let arrived;
    const started = new Promise((resolve) => { arrived = resolve; });
    let signal;
    const fiber = await ctx.plugin(plugin((_url, init) => {
      signal = init.signal;
      arrived();
      return new Promise(() => {});
    }), { stateDirectory: await directory() });
    const pending = ctx.web.search({ query: "在途搜索" });
    const rejected = assert.rejects(pending, code("DISPOSED"));
    await started;
    await fiber.dispose();
    await fiber.dispose();
    await rejected;
    assert.equal(signal.aborted, true);
    await assert.rejects(ctx.web.search({ query: "卸载后" }), code("WEB_PROVIDER_CONFIGURED_MISSING"));
    await assert.rejects(ctx.web.fetch({ url: "https://example.test/" }), code("WEB_PROVIDER_CONFIGURED_MISSING"));
    await ctx.plugin(plugin(), { stateDirectory: await directory() });
    assert.equal((await ctx.web.search({ query: "重载" })).sources.length, 1);
  });
});

test("外部 AbortSignal 原样生效且不泄露 cause", async () => {
  await withContext(async (ctx) => {
    let arrived;
    const started = new Promise((resolve) => { arrived = resolve; });
    let signal;
    await ctx.plugin(plugin((_url, init) => { signal = init.signal; arrived(); return new Promise(() => {}); }), { stateDirectory: await directory() });
    const controller = new AbortController();
    const pending = ctx.web.search({ query: "调用方取消" }, controller.signal);
    const rejected = assert.rejects(pending, (error) => code("ABORTED")(error) && error.cause === undefined);
    await started;
    controller.abort(new Error("不得传播的取消原因"));
    await rejected;
    assert.equal(signal.aborted, true);
  });
});

test("与官方 http/search provider 共存：显式选择不变，不依赖注册顺序", async () => {
  await withContext(async (ctx) => {
    const original = { url: "https://example.test/", statusCode: 200, body: { kind: "text", content: "官方抓取" }, truncated: false };
    ctx.web.registerFetchProvider({ id: "http", available: () => true, fetch: async () => original });
    ctx.web.registerSearchProvider({ id: "official", available: () => true, search: async () => { assert.fail("不可隐式切换官方搜索"); } });
    const fiber = await ctx.plugin(plugin(), { stateDirectory: await directory() });
    assert.equal((await ctx.web.search({ query: "显式搜索" })).sources.length, 1);
    assert.deepEqual(await ctx.web.fetch({ url: original.url }), original);
    await fiber.dispose();
    assert.deepEqual(await ctx.web.fetch({ url: original.url }), original);
  }, { searchProvider: "free-first", fetchProvider: "http" });
});

test("重复抓取 id 导致加载失败时不遗留已注册搜索；解除冲突可重新加载", async () => {
  await withContext(async (ctx) => {
    const unregister = ctx.web.registerFetchProvider({ id: "local-first", available: () => true, fetch: async () => { assert.fail("冲突占位"); } });
    const candidate = ctx.plugin(plugin(), { stateDirectory: await directory() });
    await assert.rejects(candidate, code("WEB_DUPLICATE_PROVIDER"));
    await assert.rejects(ctx.web.search({ query: "失败清理" }), code("WEB_PROVIDER_CONFIGURED_MISSING"));
    unregister();
    await ctx.plugin(plugin(), { stateDirectory: await directory() });
    assert.equal((await ctx.web.search({ query: "冲突解除" })).sources.length, 1);
  });
});

async function withServer(fn) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    if (request.url === "/hold") return;
    response.writeHead(request.url === "/missing" ? 404 : 200, { "content-type": "text/html" });
    response.end("<main><h1>匿名抓取</h1><p>本地正文</p></main>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  try { await fn(origin, requests); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
function localProvider(origin) {
  return new LocalFirstFetchProvider(readWebFetchConfig({ PI_WEB_FETCH_TIMEOUT_MS: "2000" }), {
    // 仅测试注入允许这个临时回环来源；生产 SSRF 策略未放宽。
    resolveTarget: async (rawUrl) => {
      const url = new URL(rawUrl);
      assert.equal(url.origin, origin);
      return { url, address: "127.0.0.1", family: 4 };
    },
  });
}

test("真实 Web 服务到本地 HTTP 抓取链：无认证头、正文提取、非 2xx 是结果", async () => {
  await withServer(async (origin, requests) => {
    await withContext(async (ctx) => {
      const provider = localProvider(origin);
      ctx.web.registerFetchProvider(provider);
      try {
        const result = await ctx.web.fetch({ url: origin + "/article" });
        assert.equal(result.statusCode, 200);
        assert.match(result.body.content, /匿名抓取.*本地正文/su);
        assert.equal(result.body.kind, "text");
        assert.equal(result.truncated, false);
        assert.equal((await ctx.web.fetch({ url: origin + "/missing" })).statusCode, 404);
        assert.equal(requests.length, 2);
        for (const request of requests) {
          assert.equal(request.headers.authorization, undefined);
          assert.equal(request.headers.cookie, undefined);
        }
      } finally { provider.dispose(); }
    });
  });
});

test("原生宿主中的抓取卸载会撤销真实在途 HTTP，不返回迟到正文", async () => {
  await withServer(async (origin) => {
    await withContext(async (ctx) => {
      const provider = localProvider(origin);
      let arrived;
      const started = new Promise((resolve) => { arrived = resolve; });
      const original = provider.fetch.bind(provider);
      const fiber = await ctx.plugin({ name: "fetch-lifecycle-fixture", inject: ["web"], apply(child) {
        child.web.registerFetchProvider({ id: provider.id, available: () => provider.available(), fetch(request, signal) { const pending = original(request, signal); arrived(); return pending; } });
        child.effect(() => () => provider.dispose());
      } });
      const pending = ctx.web.fetch({ url: origin + "/hold" });
      const rejected = assert.rejects(pending, code("WEB_PROVIDER_UNAVAILABLE"));
      await started;
      await fiber.dispose();
      await rejected;
      assert.equal(provider.available(), false);
      await assert.rejects(ctx.web.fetch({ url: origin + "/article" }), code("WEB_PROVIDER_CONFIGURED_MISSING"));
    });
  });
});

test("省略 ready 的匿名 provider 在新增 readiness 宿主上仍默认可用", async () => {
  const provider = new FreeFirstProvider({ search: async () => ({ sources: [], truncated: false }), dispose: async () => {} }, 24000);
  const fetcher = new LocalFirstFetchProvider(readWebFetchConfig({}));
  assert.equal(provider.ready, undefined);
  assert.equal(fetcher.ready, undefined);
  await withContext(async (ctx) => {
    ctx.web.registerSearchProvider(provider);
    if (typeof ctx.web.hasReadySearchProvider === "function") {
      for (const llmProvider of [undefined, "deepseek", "openai", "offline-no-credentials"]) {
        assert.equal(ctx.web.hasReadySearchProvider(llmProvider), true);
      }
    }
    assert.deepEqual(await ctx.web.search({ query: "默认 ready" }), { sources: [], truncated: false });
  });
  await provider.dispose();
  fetcher.dispose();
});
