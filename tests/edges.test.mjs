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
import { createPrivateStateStore } from "../lib/compat/state.js";

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

test("多进程同时恢复已退出主锁，互不删除新锁且合并全部冷却", async () => {
  const directory = await fixture();
  assert.equal((await createPrivateStateStore(directory).load()).status, "ok");
  const dead = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => { dead.once("spawn", resolve); dead.once("error", reject); });
  await writeFile(join(directory, ".quota-state.lock"), JSON.stringify({ version: 1, pid: dead.pid, nonce: "d".repeat(48) }), { mode: 0o600 });
  const stopped = new Promise((resolve) => dead.once("close", resolve));
  dead.kill("SIGKILL"); await stopped;
  const module = new URL("../lib/compat/quota.js", import.meta.url).href;
  const script = `import {QuotaManager} from ${JSON.stringify(module)}; const q=new QuotaManager({stateDirectory:process.argv[1]},{}); await q.initialize(); q.recordFailure(process.argv[2],"anonymous",undefined,"rate_limited"); if(await q.flush()!=="saved") process.exitCode=2;`;
  const children = ["exa", "tavily", "parallel", "firecrawl", "tinyfish"].map((backend) => spawn(process.execPath, ["--input-type=module", "-e", script, directory, backend], { stdio: "ignore" }));
  await Promise.all(children.map(childFinished));
  const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  assert.equal(state.entries.length, 5);
  assert.equal((await lstat(join(directory, "state.json"))).mode & 0o077, 0);
});

test("未知状态、损坏恢复门闩和硬链接保持原样并明确降级", async () => {
  const directory = await fixture();
  const path = join(directory, "state.json");
  await writeFile(path, "用户已有未知内容", { mode: 0o600 });
  assert.equal((await createPrivateStateStore(directory).load()).status, "unavailable");
  assert.equal(await readFile(path, "utf8"), "用户已有未知内容");
  // 用独立目录验证“状态不可用只降级为警告”：旧 createPrivateStateStore 会改写
  // 同一目录，直接复用会让本例测到前一步的副作用而不是降级行为。
  const warningDirectory = await fixture();
  await writeFile(join(warningDirectory, "state.json"), "用户已有未知内容", { mode: 0o600 });
  const engine = createSearchEngine({ stateDirectory: warningDirectory, retries: 0 }, { env: {}, fetch: async () => new Response(JSON.stringify({ result: { content: [{ type: "text", text: "Title: 结果\nURL: https://example.test/" }] } })) });
  try { assert.match((await engine.search({ query: "状态警告" })).content, /未能安全保存/u); }
  finally { await engine.dispose(); }

  const other = await fixture();
  assert.equal((await createPrivateStateStore(other).load()).status, "ok");
  const statePath = join(other, "state.json");
  await link(statePath, `${other}-outside-link`);
  assert.equal((await createPrivateStateStore(other).load()).status, "unavailable");
  assert.equal((await lstat(statePath)).nlink, 2);

  const gateDirectory = await fixture();
  assert.equal((await createPrivateStateStore(gateDirectory).load()).status, "ok");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  await writeFile(join(gateDirectory, ".quota-state.lock"), JSON.stringify({ version: 1, pid: child.pid, nonce: "e".repeat(48) }), { mode: 0o600 });
  const stopped = new Promise((resolve) => child.once("close", resolve)); child.kill("SIGKILL"); await stopped;
  const gatePath = join(gateDirectory, ".quota-state.lock.recovery");
  await writeFile(gatePath, "未知门闩内容", { mode: 0o600 });
  assert.equal((await createPrivateStateStore(gateDirectory).load()).status, "unavailable");
  assert.equal(await readFile(gatePath, "utf8"), "未知门闩内容");
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
