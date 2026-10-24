import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, access } from "node:fs/promises";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import WebRuntime from "@deepseek-ai/dsh-web";
import { createPlugin, FreeFirstProvider, defaultStateDirectory } from "../lib/index.js";
import { createSearchEngine } from "../lib/search/engine.js";

const hit = "Title: 离线文档\nURL: https://example.test/docs\nHighlights:\n中文摘要";
const reply = () => new Response(JSON.stringify({ result: { content: [{ type: "text", text: hit }] } }));
async function stateDirectory() {
  await mkdir(".temp/sdk", { recursive: true });
  return mkdtemp(join(process.cwd(), ".temp/sdk/state-"));
}

test("真实宿主 WebRuntime 加载单一聚合提供方，保留已有搜索及抓取", async () => {
  const ctx = new Context();
  const runtime = await ctx.plugin(WebRuntime, { searchProvider: "free-first", fetchProvider: "http" });
  let officialSearchCalls = 0;
  ctx.web.registerSearchProvider({ id: "deepseek-official", available: () => true, search: async () => { officialSearchCalls++; return { sources: [], truncated: false }; } });
  const fetched = { url: "https://example.test/", statusCode: 200, body: { kind: "text", content: "原有抓取" }, truncated: false };
  ctx.web.registerFetchProvider({ id: "http", available: () => true, fetch: async () => fetched });
  const calls = [];
  const plugin = createPlugin({ env: {}, fetch: async (url) => { calls.push(String(url)); return reply(); } });
  const fiber = await ctx.plugin(plugin, { stateDirectory: await stateDirectory(), retries: 0 });
  try {
    const result = await ctx.web.search({ query: "隔离查询", maxResults: 3 });
    assert.equal(result.sources.length, 1);
    assert.equal(result.truncated, false);
    assert.equal(result.sources[0].title, "离线文档");
    assert.equal(officialSearchCalls, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(await ctx.web.fetch({ url: fetched.url }), fetched);
    assert.ok(!Object.hasOwn(result, "backend") && !Object.hasOwn(result, "accessTier"));
    await fiber.dispose();
    await assert.rejects(ctx.web.search({ query: "卸载后" }), (error) => error.code === "WEB_PROVIDER_CONFIGURED_MISSING");
    assert.deepEqual(await ctx.web.fetch({ url: fetched.url }), fetched);
  } finally { await fiber.dispose(); await runtime.dispose(); }
});

test("真实 Cordis 卸载取消在途请求并支持重新注册，无凭据服务读取", async () => {
  const ctx = new Context();
  const runtime = await ctx.plugin(WebRuntime, { searchProvider: "free-first" });
  let signal;
  const directory = await stateDirectory();
  const fiber = await ctx.plugin(createPlugin({ env: {}, fetch: (_url, init) => { signal = init.signal; return new Promise(() => {}); } }), { stateDirectory: directory });
  const result = ctx.web.search({ query: "挂起调用" }).then(() => null, (error) => error);
  while (!signal) await new Promise((resolve) => setTimeout(resolve, 1));
  await fiber.dispose();
  const error = await result;
  assert.equal(error.code, "DISPOSED");
  assert.equal(error.cause, undefined);
  assert.equal(signal.aborted, true);
  const replacement = await ctx.plugin(createPlugin({ env: {}, fetch: async () => reply() }), { stateDirectory: directory });
  try { assert.equal((await ctx.web.search({ query: "重新加载" })).sources.length, 1); }
  finally { await replacement.dispose(); await runtime.dispose(); }
});

test("默认路径遵循官方 DSH_HOME，未使用的实例关闭不写任何状态", async () => {
  assert.equal(defaultStateDirectory({ DSH_HOME: "/synthetic/dsh-home" }), "/synthetic/dsh-home/config/web-search");
  const parent = await stateDirectory();
  const directory = join(parent, "unused");
  const engine = createSearchEngine({ stateDirectory: directory }, { env: {} });
  const provider = new FreeFirstProvider(engine);
  assert.equal(provider.available(), true);
  await provider.dispose();
  assert.equal(provider.available(), false);
  await assert.rejects(access(directory));
  await assert.rejects(provider.search({ query: "已关闭" }), (error) => error.code === "WEB_PROVIDER_UNAVAILABLE");
});
