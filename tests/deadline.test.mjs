import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const core = await import(new URL("../lib/core/index.js", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mcp = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "标题\nURL: https://ok.example/page" }] } }));
const tavily = () => new Response(JSON.stringify({ results: [{ url: "https://tavily.example/page", title: "结果" }] }));

test("429 不在同通道重试；网络与 5xx 最多重试一次", async () => {
  let exa429 = 0;
  const limited = core.createSearchEngine({ retries: 1 }, { fetch: async (url) => {
    if (String(url).includes("mcp.exa.ai")) { exa429++; return new Response("too many requests", { status: 429 }); }
    return tavily();
  } });
  assert.equal((await limited.search({ query: "限流" })).backend, "tavily");
  assert.equal(exa429, 1);
  await limited.dispose();

  let calls = 0;
  const retried = core.createSearchEngine({ retries: 1 }, { fetch: async () => ++calls === 1 ? new Response("server", { status: 503 }) : mcp() });
  assert.equal((await retried.search({ query: "重试" })).backend, "exa");
  assert.equal(calls, 2);
  await retried.dispose();
});

test("429 与 500 正文超限优先于 HTTP 分类，既不重试也不冷却", async () => {
  for (const status of [429, 500]) {
    let exaCalls = 0;
    let tavilyCalls = 0;
    const engine = core.createSearchEngine({ maxResponseBytes: 128, retries: 1 }, { fetch: async (url) => {
      if (String(url).includes("mcp.exa.ai")) {
        exaCalls++;
        return exaCalls === 1 ? new Response("x".repeat(300), { status }) : mcp();
      }
      if (String(url).includes("api.tavily.com/search")) { tavilyCalls++; return tavily(); }
      return new Response("offline", { status: 503 });
    } });
    assert.equal((await engine.search({ query: "超限优先" })).backend, "tavily");
    assert.equal(exaCalls, 1);
    assert.equal(tavilyCalls, 1);
    assert.equal((await engine.search({ query: "超限后重试" })).backend, "exa");
    assert.equal(exaCalls, 2, "超限不能写入冷却");
    await engine.dispose();
  }
});

test("单调总期限覆盖多个通道，忽略 signal 的 fetch、正文与 key resolver 均及时停止", async () => {
  let calls = 0;
  const started = Date.now();
  const slow = core.createSearchEngine({ timeoutMs: 45, retries: 0 }, { fetch: async () => { calls++; await delay(20); return new Response("offline", { status: 503 }); } });
  await assert.rejects(slow.search({ query: "全链期限" }), (error) => error.code === "TIMEOUT");
  assert.ok(Date.now() - started < 250);
  assert.ok(calls < 5, "共享期限耗尽后不得继续调用候选");
  await slow.dispose();

  let lateReject;
  const noncooperative = core.createSearchEngine({ timeoutMs: 20, retries: 0 }, { fetch: () => new Promise((_resolve, reject) => { lateReject = reject; }) });
  await assert.rejects(noncooperative.search({ query: "迟到请求" }), (error) => error.code === "TIMEOUT");
  lateReject?.(new Error("迟到拒绝"));
  await delay(0);
  await noncooperative.dispose();

  let bodyCalls = 0;
  const streamEngine = core.createSearchEngine({ timeoutMs: 25, retries: 0 }, { fetch: async () => {
    bodyCalls++;
    return new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); } }));
  } });
  await assert.rejects(streamEngine.search({ query: "挂起正文" }), (error) => error.code === "TIMEOUT");
  assert.equal(bodyCalls, 1);
  await streamEngine.dispose();

  let keyCalls = 0;
  const keyEngine = core.createSearchEngine({ allowBillable: true, timeoutMs: 25 }, { resolveKey: () => { keyCalls++; return new Promise(() => {}); }, fetch: async () => { throw new Error("不得发请求"); } });
  await assert.rejects(keyEngine.search({ query: "挂起取钥" }), (error) => error.code === "TIMEOUT");
  assert.equal(keyCalls, 4);
  await keyEngine.dispose();
});

test("dispose 立即取消在途请求、拒绝新搜索并给出固定诊断", async () => {
  let requestSignal;
  const engine = core.createSearchEngine({ retries: 0 }, { fetch: (_url, init) => { requestSignal = init.signal; return new Promise(() => {}); } });
  const pending = engine.search({ query: "关闭中" });
  await new Promise((resolve) => {
    const poll = () => requestSignal ? resolve() : setTimeout(poll, 1);
    poll();
  });
  await engine.dispose();
  assert.equal(requestSignal.aborted, true);
  await assert.rejects(pending, (error) => error.code === "DISPOSED" && error.cause === undefined);
  await assert.rejects(engine.search({ query: "关闭后" }), (error) => error.code === "DISPOSED");
});
