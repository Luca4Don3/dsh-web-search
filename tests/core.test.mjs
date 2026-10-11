import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const core = await import(new URL("../lib/core/index.js", import.meta.url));
const hit = { url: "https://example.test/page", title: "离线结果", snippet: "测试摘要" };
const mcp = (text) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }), { headers: { "content-type": "application/json" } });
function replyFor(provider) {
  if (provider === "exa") return mcp("Title: Exa 结果\nURL: https://exa.example/page\nHighlights:\nExa 摘要");
  if (provider === "parallel") return mcp(JSON.stringify({ results: [{ url: "https://parallel.example/page", title: "Parallel", excerpts: ["并行摘要"] }] }));
  if (provider === "tinyfish") return mcp(JSON.stringify({ query: "离线查询", results: [{ url: "https://tinyfish.example/page", title: "TinyFish", snippet: "轻量摘要" }] }));
  if (provider === "tavily") return new Response(JSON.stringify({ results: [{ ...hit, content: hit.snippet }] }));
  return new Response(JSON.stringify({ success: true, data: { web: [{ ...hit, description: hit.snippet }] } }));
}
const hosts = ["mcp.exa.ai", "api.tavily.com", "search.parallel.ai", "api.firecrawl.dev", "agent.tinyfish.ai"];

test("五家匿名通道依序回退并解析各自结构", async () => {
  const providers = ["exa", "tavily", "parallel", "firecrawl", "tinyfish"];
  for (let target = 0; target < providers.length; target++) {
    const calls = [];
    const engine = core.createSearchEngine({ retries: 0 }, { fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return calls.length <= target ? new Response("离线失败", { status: 503 }) : replyFor(providers[target]);
    } });
    const result = await engine.search({ query: "离线查询" });
    assert.equal(result.backend, providers[target]);
    assert.equal(result.accessTier, "anonymous");
    assert.equal(result.sources.length, 1);
    assert.equal(new URL(calls.at(-1).url).hostname, hosts[target]);
    assert.equal(calls.length, target + 1);
    if (providers[target] === "tavily") assert.equal(calls.at(-1).init.headers["X-Tavily-Access-Mode"], "keyless");
    if (providers[target] === "tinyfish") assert.equal(calls.at(-1).init.headers["X-TinyFish-Access-Mode"], "keyless");
    await engine.dispose();
  }
});

test("默认路径不读取环境密钥；授权时先解析四把密钥但匿名成功不走付费或额度接口", async () => {
  let envReads = 0;
  const env = new Proxy({}, { get(_target, property) { if (["EXA_API_KEY", "TAVILY_API_KEY", "PARALLEL_API_KEY", "FIRECRAWL_API_KEY", "TINYFISH_API_KEY"].includes(String(property))) envReads++; return "unused-secret-value"; } });
  let calls = 0;
  const free = core.createSearchEngine({}, { env, fetch: async () => { calls++; return replyFor("exa"); } });
  await free.search({ query: "free" });
  assert.equal(envReads, 0);
  assert.equal(calls, 1);
  await free.dispose();

  const resolved = [];
  const authorized = core.createSearchEngine({ allowBillable: true }, {
    resolveKey: async (provider) => { resolved.push(provider); return `KEY_${provider}_123456`; },
    fetch: async (_url, init) => { calls++; assert.equal(init.headers.authorization, undefined); return replyFor("exa"); },
  });
  const result = await authorized.search({ query: "free first" });
  assert.deepEqual([...resolved].sort(), ["exa", "firecrawl", "parallel", "tavily"]);
  assert.equal(calls, 2);
  assert.equal(result.accessTier, "anonymous");
  await authorized.dispose();
});

test("授权后的搜索正文、来源字段及编码形式均脱敏", async () => {
  const secret = "EXA_secret-Value_12345";
  const encoded = encodeURIComponent(secret);
  const base64 = Buffer.from(secret).toString("base64");
  let count = 0;
  const engine = core.createSearchEngine({ allowBillable: true, retries: 0 }, {
    resolveKey: async (provider) => provider === "exa" ? secret : `OTHER_${provider}_secret_123`,
    fetch: async (url) => {
      count++;
      if (count <= 5) return new Response("offline", { status: 503 });
      assert.match(String(url), /exaApiKey=/u);
      return mcp(`Title: ${secret}\nURL: https://result.example/page?token=${encoded}\nHighlights:\n包含 ${encoded} 与 ${base64}`);
    },
  });
  const result = await engine.search({ query: "脱敏" });
  assert.equal(result.accessTier, "billable");
  const visible = JSON.stringify(result);
  for (const value of [secret, encoded, base64]) assert.equal(visible.includes(value), false);
  assert.equal(result.sources[0].url.startsWith("https://"), true);
  await engine.dispose();
});

test("来源与正文共同受字符预算限制，截断标志准确", async () => {
  const results = Array.from({ length: 20 }, (_, index) => ({ url: `https://long.example/${index}`, title: "标题".repeat(40), content: "摘要".repeat(400) }));
  const engine = core.createSearchEngine({ maxChars: 180, retries: 0 }, { fetch: async () => new Response(JSON.stringify({ results })) });
  const result = await engine.search({ query: "预算", maxResults: 20 });
  const total = (result.content?.length ?? 0) + result.sources.reduce((sum, source) => sum + source.url.length + (source.title?.length ?? 0) + (source.snippet?.length ?? 0) + (source.publishedAt?.length ?? 0), 0);
  assert.ok(total <= 180);
  assert.equal(result.truncated, true);
  assert.ok(result.sources.length <= 20);
  await engine.dispose();
});

test("请求和配置在密钥及网络访问前验证，公开错误不保留底层 cause", async () => {
  let reads = 0;
  let calls = 0;
  const env = new Proxy({}, { get() { reads++; return "SECRET_12345678"; } });
  const engine = core.createSearchEngine({ allowBillable: true }, { env, fetch: async () => { calls++; throw new Error("SECRET_12345678"); } });
  await assert.rejects(engine.search({ query: "x", maxResults: 0 }), (error) => error.code === "INVALID_REQUEST");
  assert.equal(reads, 0);
  assert.equal(calls, 0);
  assert.throws(() => core.createSearchEngine({ timeoutMs: 0 }), (error) => error.code === "INVALID_CONFIG");
  await engine.dispose();

  const failed = core.createSearchEngine({ retries: 0 }, { fetch: async () => { throw new Error("不得外泄的底层内容"); } });
  await assert.rejects(failed.search({ query: "失败" }), (error) => error instanceof core.SearchError && error.cause === undefined && !error.message.includes("底层内容"));
  await failed.dispose();
});
