import assert from "node:assert/strict";
import test from "node:test";
import { createSearchEngine } from "../lib/search/engine.js";
import { QuotaManager, parseUsageBody } from "../lib/compat/quota.js";

const result = (provider = "tavily") => provider === "tavily"
  ? new Response(JSON.stringify({ results: [{ url: "https://example.test/", title: "结果", content: "正文" }] }))
  : new Response(JSON.stringify({ success: true, data: { web: [{ url: "https://example.test/", title: "结果", description: "正文" }] } }));
const usage = (credits) => new Response(JSON.stringify({ key: { usage: 0, limit: null }, account: { plan_usage: 0, plan_limit: credits, paygo_usage: 0, paygo_limit: 0 } }));
const later = () => new Promise((resolve) => setTimeout(resolve, 5));
function authorizedFetch(onPaid, onUsage = async () => usage(1)) {
  return async (url, init) => {
    if (String(url).endsWith("/usage")) return onUsage(init.signal);
    if (init.headers.authorization) return onPaid(url, init);
    return new Response("离线不可用", { status: 503 });
  };
}
const onlyTavily = { resolveKey: async (provider) => provider === "tavily" ? "synthetic_tavily_key" : undefined };

test("授权后每个实际计费请求预留额度，并发不能越过单实例余额", async () => {
  let paid = 0;
  let probes = 0;
  const engine = createSearchEngine({ allowBillable: true, retries: 0 }, {
    ...onlyTavily,
    fetch: authorizedFetch(async () => { paid++; return result(); }, async () => { probes++; await later(); return usage(1); }),
  });
  try {
    const settled = await Promise.allSettled([engine.search({ query: "并发甲" }), engine.search({ query: "并发乙" })]);
    assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(paid, 1);
    assert.equal(probes, 1);
    await assert.rejects(engine.search({ query: "缓存已扣减" }), (error) => error.code === "SEARCH_FAILED");
    assert.equal(paid, 1);
  } finally { await engine.dispose(); }
});

test("已发送的失败也消耗估算额度，不以失败或重试退款", async () => {
  let paid = 0;
  const engine = createSearchEngine({ allowBillable: true, retries: 0 }, {
    ...onlyTavily, fetch: authorizedFetch(async () => { paid++; return new Response("离线失败", { status: 500 }); }),
  });
  try {
    await assert.rejects(engine.search({ query: "失败请求" }));
    await assert.rejects(engine.search({ query: "不可退款" }));
    assert.equal(paid, 1);
  } finally { await engine.dispose(); }
});

test("余额为正但不足以执行昂贵请求，不把较便宜请求标为额度耗尽", async () => {
  let paid = 0;
  const engine = createSearchEngine({ allowBillable: true, retries: 0 }, {
    resolveKey: async (provider) => provider === "firecrawl" ? "synthetic_firecrawl_key" : undefined,
    fetch: async (url, init) => {
      if (String(url).endsWith("credit-usage")) return new Response(JSON.stringify({ success: true, data: { remainingCredits: 3 } }));
      if (init.headers.authorization) { paid++; return result("firecrawl"); }
      return new Response("离线不可用", { status: 503 });
    },
  });
  try {
    await assert.rejects(engine.search({ query: "较昂贵", maxResults: 20 }));
    assert.equal(paid, 0);
    assert.equal((await engine.search({ query: "较便宜", maxResults: 8 })).backend, "firecrawl");
    assert.equal(paid, 1);
  } finally { await engine.dispose(); }
});

test("一个余额查询消费者取消不影响其他消费者，零消费者取消后迟到结果不能回灌", async () => {
  const manager = new QuotaManager({}, {});
  await manager.initialize();
  let finish;
  let lookupSignal;
  let calls = 0;
  const lookup = (_backend, _key, signal) => { calls++; lookupSignal = signal; return new Promise((resolve) => { finish = resolve; }); };
  const first = new AbortController();
  const second = new AbortController();
  const a = manager.balance("tavily", "synthetic-key", first.signal, lookup).then(() => null, (error) => error);
  const b = manager.balance("tavily", "synthetic-key", second.signal, lookup);
  await later();
  first.abort();
  assert.equal((await a).kind, "aborted");
  assert.equal(lookupSignal.aborted, false);
  finish({ known: true, remaining: 3 });
  assert.deepEqual(await b, { known: true, remaining: 3 });
  assert.equal(calls, 1);

  const canceled = new AbortController();
  const c = manager.balance("firecrawl", "other-synthetic-key", canceled.signal, lookup).then(() => null, (error) => error);
  await later();
  canceled.abort();
  assert.equal((await c).kind, "aborted");
  assert.equal(lookupSignal.aborted, true);
  finish({ known: true, remaining: 999 });
  await later();
  assert.equal(manager.reserve("firecrawl", "other-synthetic-key", 8), undefined);
  const balance = await manager.balance("firecrawl", "other-synthetic-key", new AbortController().signal, async () => ({ known: true, remaining: 2 }));
  assert.equal(balance.remaining, 2);
  manager.dispose();
});

test("搜索级取消也不破坏同实例另一个搜索的共享额度预检", async () => {
  let finish;
  let lookupSignal;
  let paid = 0;
  const engine = createSearchEngine({ allowBillable: true, retries: 0 }, {
    ...onlyTavily,
    fetch: authorizedFetch(async () => { paid++; return result(); }, (signal) => { lookupSignal = signal; return new Promise((resolve) => { finish = resolve; }); }),
  });
  const first = new AbortController();
  const a = engine.search({ query: "取消甲" }, first.signal).then(() => null, (error) => error);
  const b = engine.search({ query: "保留乙" });
  try {
    while (!finish) await later();
    await later();
    first.abort();
    assert.equal((await a).code, "ABORTED");
    assert.equal(lookupSignal.aborted, false);
    finish(usage(1));
    assert.equal((await b).accessTier, "billable");
    assert.equal(paid, 1);
  } finally { await engine.dispose(); }
});

test("字符预算不足不伪造空来源成功，截断不拆开代理对", async () => {
  const tiny = createSearchEngine({ maxChars: 1, retries: 0 }, { fetch: async () => result() });
  try { await assert.rejects(tiny.search({ query: "最小预算" }), (error) => error.code === "OUTPUT_TOO_SMALL"); }
  finally { await tiny.dispose(); }
  const url = "https://example.test/";
  const engine = createSearchEngine({ maxChars: url.length + 1, retries: 0 }, { fetch: async () => new Response(JSON.stringify({ results: [{ url, title: "😀尾部" }] })) });
  try {
    const value = await engine.search({ query: "代理对" });
    assert.equal(value.sources[0].title ?? "", "");
    assert.equal(value.truncated, true);
  } finally { await engine.dispose(); }
});

test("密钥严格验证但不截断，允许安全可打印 ASCII 与最长 4096 字符", async () => {
  const key = "synthetic/Key+[]@=" + "x".repeat(600);
  const encoded = encodeURIComponent(key).replace(/%[0-9A-F]{2}/gu, (part) => part.toLowerCase());
  const engine = createSearchEngine({ allowBillable: true, retries: 0 }, {
    resolveKey: async (provider) => provider === "exa" ? key : undefined,
    fetch: async () => new Response(JSON.stringify({ result: { content: [{ type: "text", text: `Title: 标题\nURL: https://example.test/\nHighlights:\n${encoded}` }] } })),
  });
  try { assert.equal(JSON.stringify(await engine.search({ query: "特殊字符" })).includes(encoded), false); }
  finally { await engine.dispose(); }
  let requests = 0;
  for (const invalid of ["x".repeat(4097), "含中文", "whitespace key", "line\nkey"]) {
    const invalidEngine = createSearchEngine({ allowBillable: true }, { resolveKey: async () => invalid, fetch: async () => { requests++; return result(); } });
    try { await assert.rejects(invalidEngine.search({ query: "非法密钥" }), (error) => error.code === "INVALID_KEY"); }
    finally { await invalidEngine.dispose(); }
  }
  assert.equal(requests, 0);
});

test("usage 解析不把 null 视为免费或无限额度，不接受异常数字", () => {
  assert.deepEqual(parseUsageBody("tavily", JSON.stringify({ key: { usage: 0, limit: null }, account: { plan_usage: 0, plan_limit: 2, paygo_usage: 0, paygo_limit: 1 } })), { known: true, remaining: 3 });
  assert.deepEqual(parseUsageBody("firecrawl", JSON.stringify({ success: true, data: { remainingCredits: -1 } })), { known: false });
});
