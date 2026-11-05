import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createSearchEngine } from "../lib/search/engine.js";
import { createQuotaManager } from "../lib/quota/core.js";

const limited = () => new Response("离线虚构限流", { status: 429, headers: { "retry-after": "3600" } });
const pending = () => new Promise(() => {});
const options = { allowBillable: false, retries: 0, timeoutMs: 2_000, totalTimeoutMs: 3_000 };
const dependencies = (fetch) => ({
  env: {},
  resolveKey() { assert.fail("离线测试禁止读取凭据"); },
  fetch,
});
const hasCode = (code) => (error) => {
  assert.equal(error.code, code);
  if (code === "TIMEOUT") assert.match(error.message, /\[budget_exhausted\]/);
  return true;
};
async function fixture() {
  const parent = fileURLToPath(new URL("../.temp/", import.meta.url));
  await mkdir(parent, { recursive: true });
  return mkdtemp(`${parent}failure-cooldown-`);
}

// 原实例始终保留到新实例验证结束，防止 dispose 掩盖失败路径的缺陷。
test("普通匿名 429 全失败后，未关闭原实例也能继承全部冷却", { timeout: 3_000 }, async () => {
  const stateDirectory = await fixture();
  let originalCalls = 0;
  let replacementCalls = 0;
  const original = createSearchEngine({ ...options, stateDirectory }, dependencies(async () => { originalCalls++; return limited(); }));
  const replacement = createSearchEngine({ ...options, stateDirectory }, dependencies(async () => { replacementCalls++; return limited(); }));
  try {
    await assert.rejects(original.search({ query: "虚构限流" }), hasCode("SEARCH_FAILED"));
    assert.equal(originalCalls, 5);
    await assert.rejects(replacement.search({ query: "继承冷却" }), hasCode("SEARCH_FAILED"));
    assert.equal(replacementCalls, 0);
  } finally {
    await original.dispose();
    await replacement.dispose();
  }
});

test("已记录 429 后总预算耗尽，未关闭原实例也能继承冷却", { timeout: 3_000 }, async () => {
  const stateDirectory = await fixture();
  const originalUrls = [];
  const replacementUrls = [];
  const original = createSearchEngine({ ...options, totalTimeoutMs: 200, stateDirectory }, dependencies(async (url) => {
    originalUrls.push(String(url));
    return originalUrls.length === 1 ? limited() : pending();
  }));
  const replacement = createSearchEngine({ ...options, stateDirectory }, dependencies(async (url) => {
    replacementUrls.push(String(url));
    return limited();
  }));
  try {
    await assert.rejects(original.search({ query: "虚构预算耗尽" }), hasCode("TIMEOUT"));
    assert.equal(originalUrls.length, 2);
    await assert.rejects(replacement.search({ query: "继承预算前冷却" }), hasCode("SEARCH_FAILED"));
    assert.equal(replacementUrls.length, 4);
    assert.ok(!replacementUrls.includes(originalUrls[0]));
  } finally {
    await original.dispose();
    await replacement.dispose();
  }
});

for (const mode of ["同步抛错", "异步拒绝", "永久挂起"]) {
  for (const code of ["SEARCH_FAILED", "TIMEOUT", "ABORTED"]) {
    test(`保存${mode}不覆盖 ${code}，收尾等待有界`, { timeout: 2_000 }, async () => {
      const quota = createQuotaManager();
      let flushCalls = 0;
      quota.flush = () => {
        flushCalls++;
        if (mode === "同步抛错") throw new Error("虚构保存错误");
        if (mode === "异步拒绝") return Promise.reject(new Error("虚构保存拒绝"));
        return pending();
      };
      let calls = 0;
      const controller = new AbortController();
      const engine = createSearchEngine({ ...options, totalTimeoutMs: code === "TIMEOUT" ? 80 : 1_000, quotaManager: quota }, dependencies(async () => {
        calls++;
        if (calls === 1 || code === "SEARCH_FAILED") return limited();
        if (code === "ABORTED") controller.abort();
        return pending();
      }));
      try {
        const started = performance.now();
        await assert.rejects(engine.search({ query: "虚构失败收尾" }, controller.signal), hasCode(code));
        const elapsed = performance.now() - started;
        assert.equal(flushCalls, 1);
        assert.ok(quota.getCooldown("exa", "anonymous"), "保存前应已记录限流冷却");
        assert.ok(elapsed < 900, `失败收尾耗时不应无界：${elapsed}`);
        if (mode === "永久挂起") assert.ok(elapsed >= 200, "应等待有界保存窗口，而非直接跳过保存");
      } finally {
        const started = performance.now();
        await engine.dispose();
        assert.equal(flushCalls, 2);
        assert.ok(performance.now() - started < 600, "关闭也应复用有界保存且吞掉保存错误");
      }
    });
  }
}

test("预取消与未使用实例关闭都不触发初始化或保存", { timeout: 1_000 }, async () => {
  const quota = createQuotaManager();
  quota.initialize = () => assert.fail("预取消不应初始化状态");
  quota.flush = () => assert.fail("未初始化不应保存状态");
  const controller = new AbortController();
  controller.abort();
  const engine = createSearchEngine({ ...options, quotaManager: quota }, dependencies(() => assert.fail("预取消不应请求网络")));
  try {
    await assert.rejects(engine.search({ query: "虚构预取消" }, controller.signal), hasCode("ABORTED"));
  } finally {
    await engine.dispose();
  }
  const unused = createSearchEngine({ ...options, quotaManager: quota }, dependencies(() => assert.fail("未使用不应请求网络")));
  await unused.dispose();
});
