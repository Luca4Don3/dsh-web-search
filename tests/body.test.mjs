import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const core = await import(new URL("../lib/search/engine.js", import.meta.url));

test("有界读取按解码前的 UTF-8 字节计数且不返回部分正文", async () => {
  assert.equal(await core.readResponseTextLimited(new Response("你好"), 6, new AbortController().signal), "你好");
  // 合并后统一使用内核分类 response_too_large；DSH 历史名 too_large 不再单独存在。
  await assert.rejects(core.readResponseTextLimited(new Response("你好"), 5, new AbortController().signal), (error) => error.kind === "response_too_large");
  await assert.rejects(core.readResponseTextLimited(new Response("abcdef"), 3, new AbortController().signal), (error) => error.kind === "response_too_large");
});

test("读取流忽略取消时仍及时停止等待并消费迟到拒绝", async () => {
  let rejectRead;
  const stream = new ReadableStream({ pull() { return new Promise((_resolve, reject) => { rejectRead = reject; }); }, cancel() { return new Promise(() => {}); } });
  const response = new Response(stream);
  const controller = new AbortController();
  const pending = core.readResponseTextLimited(response, 100, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error) => error.name === "AbortError" || error.kind === "aborted");
  rejectRead?.(new Error("迟到拒绝"));
  await new Promise((resolve) => setTimeout(resolve, 0));
});
