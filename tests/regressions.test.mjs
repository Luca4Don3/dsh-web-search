/**
 * 针对已报告问题的回归测试。
 *
 * 每个用例对应一个曾经真实发生、且未被既有测试覆盖的缺陷：
 * 1. 单通道超时不应终止整次搜索
 * 2. 密钥的编码形态必须在两个宿主上都被遮蔽
 * 3. 两个宿主的计费后端范围一致
 */
import assert from "node:assert/strict";
import test from "node:test";

const engineMod = await import(new URL("../lib/search/engine.js", import.meta.url));
const redact = await import(new URL("../lib/shared/redact.js", import.meta.url));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("单通道超时后继续尝试后续通道，不终止整次搜索", async () => {
  let calls = 0;
  const engine = engineMod.createSearchEngine(
    { timeoutMs: 40, totalTimeoutMs: 5_000, retries: 0 },
    {
      env: {},
      fetch: async (url) => {
        calls += 1;
        // 第一家常驻不返回，模拟慢服务商。
        if (String(url).includes("mcp.exa.ai")) {
          await delay(500);
          return new Response("slow", { status: 200 });
        }
        return new Response(JSON.stringify({ results: [{ url: "https://ok.test/", title: "成功" }] }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  try {
    const result = await engine.search({ query: "慢服务商" });
    assert.notEqual(result.backend, "exa", "超时通道不应被当作成功结果");
    assert.ok(calls >= 2, `应继续尝试后续通道，实际只发起了 ${calls} 次`);
  } finally {
    await engine.dispose();
  }
});

test("整次总预算耗尽仍然终止，不与单通道超时混淆", async () => {
  const engine = engineMod.createSearchEngine(
    { timeoutMs: 200, totalTimeoutMs: 60, retries: 0 },
    { env: {}, fetch: () => new Promise(() => {}) },
  );
  try {
    await assert.rejects(engine.search({ query: "总预算" }), (error) => error.code === "TIMEOUT");
  } finally {
    await engine.dispose();
  }
});

test("密钥的全部编码形态都被遮蔽，两个宿主共用同一实现", async () => {
  // 虚构密钥，仅用于验证遮蔽逻辑。
  const key = "sk-regression-fake-0123456789";
  const forms = [
    key,
    encodeURIComponent(key),
    Buffer.from(key, "utf8").toString("base64"),
    Buffer.from(key, "utf8").toString("base64url"),
  ];
  for (const form of forms) {
    const text = `片段 ${form} 结束`;
    const masked = redact.redactSecrets(text, [key]);
    assert.ok(!masked.includes(form), `${form} 未被遮蔽`);
    assert.ok(masked.includes("***"), "遮蔽结果应包含替换标记");
  }
});

test("base64 回显的密钥不会进入搜索结果", async () => {
  const key = "sk-regression-echo-9876543210";
  const encoded = Buffer.from(key, "utf8").toString("base64");
  const body = JSON.stringify({
    result: { content: [{ type: "text", text: `Title: 回显\nURL: https://leak.test/page\nHighlights:\n${encoded}` }] },
  });
  const engine = engineMod.createSearchEngine(
    { allowBillable: true, retries: 0 },
    {
      resolveKey: async (provider) => (provider === "exa" ? key : undefined),
      fetch: async (url) =>
        String(url).includes("mcp.exa.ai") ? new Response(body, { headers: { "content-type": "application/json" } }) : new Response("offline", { status: 503 }),
    },
  );
  try {
    const result = await engine.search({ query: "回显", provider: "exa" });
    assert.ok(!JSON.stringify(result).includes(encoded), "base64 编码的密钥泄露到了结果中");
  } finally {
    await engine.dispose();
  }
});

test("默认解析集合覆盖全部计费后端，与路由顺序一致", async () => {
  const registry = await import(new URL("../lib/search/registry.js", import.meta.url));
  assert.deepEqual([...registry.BILLABLE_PROVIDER_ORDER], ["exa", "tavily", "parallel", "firecrawl", "serpapi"]);
  // 内核默认解析集合必须与之相同，否则两个宿主能力不一致。
  const resolved = [];
  const engine = engineMod.createSearchEngine(
    { allowBillable: true, retries: 0 },
    {
      resolveKey: async (provider) => { resolved.push(provider); return undefined; },
      fetch: async () => new Response("offline", { status: 503 }),
    },
  );
  try { await engine.search({ query: "范围" }).catch(() => undefined); }
  finally { await engine.dispose(); }
  assert.deepEqual(resolved.sort(), ["exa", "firecrawl", "parallel", "serpapi", "tavily"]);
});
