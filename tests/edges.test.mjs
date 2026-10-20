import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { Agent, fetch } from "undici";
import { mkdir, mkdtemp, writeFile, readFile, lstat, link } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createSearchEngine, readResponseTextLimited, parseMcpResponse } from "../lib/search/engine.js";
import { parseProviderResponse } from "../lib/search/protocol.js";

async function fixture() { await mkdir(".temp/edges", { recursive: true }); return mkdtemp(join(process.cwd(), ".temp/edges/state-")); }
function childFinished(child) { return new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error("离线子进程失败"))); }); }

test("MCP 多文本块被完整解析，非法来源与重复项不造成截断误报", () => {
  assert.equal(parseMcpResponse(JSON.stringify({ result: { content: [{ type: "text", text: "首段" }, { type: "image", text: "不能当正文" }, { type: "text", text: "末段" }] } })), "首段\n末段");
  const url = "https://example.test/";
  const body = JSON.stringify({ results: [{ url: "file:///synthetic" }, { url }, { url }] });
  const result = parseProviderResponse("tavily", body, 1);
  assert.equal(result.sources.length, 1);
  assert.equal(result.truncated, false);
  assert.throws(() => parseProviderResponse("tavily", JSON.stringify({ error: null, results: [{ url }] }), 1));
  const credentials = new URL(url); credentials.username = "synthetic"; credentials.password = "fixture";
  assert.throws(() => parseProviderResponse("tavily", JSON.stringify({ results: [{ url: credentials.href }] }), 1));
});

test("真正 HTTP gzip 的解压后字节超限立即撤销网络，不返回部分结果", async () => {
  const server = createServer((_request, response) => { response.writeHead(200, { "content-encoding": "gzip" }); response.end(gzipSync("x".repeat(1024))); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "localhost", resolve); });
  const dispatcher = new Agent();
  const controller = new AbortController();
  try {
    const response = await fetch(`http://localhost:${server.address().port}`, { dispatcher, signal: controller.signal });
    await assert.rejects(readResponseTextLimited(response, 100, controller.signal, () => controller.abort()), (error) => error.kind === "response_too_large");
    assert.equal(controller.signal.aborted, true);
  } finally { await dispatcher.destroy(); await new Promise((resolve) => server.close(resolve)); }
});

test("取钥期间预取消不开始后续解析，JSON 转义密钥也被清除", async () => {
  const controller = new AbortController(); controller.abort();
  let reads = 0;
  const canceled = createSearchEngine({ allowBillable: true }, { resolveKey: () => { reads++; return "synthetic"; } });
  try { await assert.rejects(canceled.search({ query: "已取消" }, controller.signal), (error) => error.code === "ABORTED"); assert.equal(reads, 0); }
  finally { await canceled.dispose(); }
  const key = 'synthetic"quote-key';
  const inner = JSON.stringify({ results: [{ url: "https://example.test/", title: key }] });
  const engine = createSearchEngine({ allowBillable: true }, { resolveKey: async (provider) => provider === "exa" ? key : undefined, fetch: async () => new Response(JSON.stringify({ result: { content: [{ type: "text", text: inner }] } })) });
  try {
    const value = await engine.search({ query: "转义" });
    assert.equal(value.content?.includes(JSON.stringify(key).slice(1, -1)), false);
    assert.equal(JSON.stringify(value).includes(JSON.stringify(key).slice(1, -1)), false);
  } finally { await engine.dispose(); }
});
