import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const core = await import(new URL("../lib/search/engine.js", import.meta.url));

test("MCP 直接 JSON 与多行 SSE 都提取 tools/call 文本并拒绝 JSON-RPC 错误", () => {
  const json = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "标题\nURL: https://example.test" }] } });
  assert.match(core.parseMcpResponse(json), /https:\/\/example\.test/u);
  const sse = `event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":1,"result":{"content":[{"type":"text","text":"SSE 正文"}]}}\n\n`;
  assert.equal(core.parseMcpResponse(sse), "SSE 正文");
  // 合并后 MCP 解析与 Pi 内核一致：只接受 type: "text" 的内容块，
  // 且错误消息带固定分类前缀（quota_exhausted / rate_limited / protocol_error）。
  assert.throws(() => core.parseMcpResponse(JSON.stringify({ error: { code: -32000, message: "额度耗尽" } })), /quota_exhausted/u);
  assert.throws(() => core.parseMcpResponse(JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "额度不足" }] } })), /quota_exhausted/u);
});

test("TinyFish 只发送固定 keyless MCP tools/call 结构", async () => {
  let request;
  const engine = core.createSearchEngine({ retries: 0 }, { fetch: async (url, init) => {
    request = { url: String(url), init };
    return new Response(JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({ results: [{ url: "https://tinyfish.example", title: "结果", snippet: "摘要" }] }) }] } }));
  } });
  const result = await engine.search({ query: "协议测试" });
  assert.equal(request.url, "https://mcp.exa.ai/mcp");
  // Exa 首选成功时不触达 TinyFish；单独让前四家失败后检验固定 TinyFish 接口。
  await engine.dispose();
  const fallback = core.createSearchEngine({ retries: 0 }, { fetch: async (url, init) => {
    if (String(url).includes("agent.tinyfish.ai")) { request = { url: String(url), init }; return new Response(JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({ results: [{ url: "https://tinyfish.example", title: "结果", snippet: "摘要" }] }) }] } })); }
    return new Response("offline", { status: 503 });
  } });
  const tiny = await fallback.search({ query: "协议测试" });
  assert.equal(tiny.backend, "tinyfish");
  assert.equal(request.url, "https://agent.tinyfish.ai/mcp");
  assert.equal(request.init.headers["X-TinyFish-Access-Mode"], "keyless");
  const payload = JSON.parse(request.init.body);
  assert.deepEqual(payload, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query: "协议测试" } } });
  assert.equal(Object.keys(request.init.headers).some((key) => /authorization|x-api-key/iu.test(key)), false);
  await fallback.dispose();
  assert.equal(result.backend, "exa");
});

test("无来源的正常 HTTP/MCP 响应继续回退，不把服务提示当成结果", async () => {
  let calls = 0;
  const engine = core.createSearchEngine({ retries: 0 }, { fetch: async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ jsonrpc: "2.0", result: { content: [{ type: "text", text: "服务暂时没有结果" }] } }));
    return new Response(JSON.stringify({ results: [{ url: "https://valid.example", title: "有效来源" }] }));
  } });
  const result = await engine.search({ query: "正常负向响应" });
  assert.equal(result.backend, "tavily");
  assert.equal(calls, 2);
  await engine.dispose();
});
