/**
 * 第二轮对抗性审查发现的七项缺陷的回归测试。
 *
 * 对应问题：
 * 1. 错误分类正则的平方级回溯（ReDoS）
 * 2. 标准表单编码形态的密钥未被遮蔽
 * 3. 凭据阶段与搜索阶段各拿一份完整总预算
 * 4. 错误诊断没有独立长度上限
 * 5. 只注入内存额度管理器仍创建宿主目录
 * 6. 预算耗尽后仍启动落盘
 * 7. 预留到派发之间余额变小，旧预留仍派发成功
 */
import assert from "node:assert/strict";
import test from "node:test";

const core = await import(new URL("../lib/search/core.js", import.meta.url));
const redact = await import(new URL("../lib/shared/redact.js", import.meta.url));
const engineMod = await import(new URL("../lib/search/engine.js", import.meta.url));
const quota = await import(new URL("../lib/quota/core.js", import.meta.url));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("错误分类对恶意长输入保持线性", () => {
  // "monthly" 反复出现却没有 "limit"，旧实现的 /monthly.*limit/ 会平方级回溯。
  const evil = "monthly ".repeat(35_000);
  assert.ok(evil.length >= 280_000);
  const started = performance.now();
  const kind = core.messageKind(evil);
  const elapsed = performance.now() - started;
  assert.equal(kind, undefined);
  assert.ok(elapsed < 200, `分类耗时 ${Math.round(elapsed)}ms，应保持线性`);
});

test("错误分类仍能识别真实额度提示", () => {
  assert.equal(core.messageKind("You have hit your monthly search limit"), "quota_exhausted");
  assert.equal(core.messageKind("额度已用尽"), "quota_exhausted");
  assert.equal(core.messageKind("internal server error"), undefined);
});

test("标准表单编码形态的密钥也被遮蔽", () => {
  // 表单编码与网址组件编码不等价：空格是 + 而非 %20，波浪号转义为 %7E。
  for (const key of ["sk+form/Key ~=", "has space inside", "a~b~c"]) {
    const uriEncoded = encodeURIComponent(key);
    const formEncoded = new URLSearchParams({ v: key }).toString().slice(2);
    for (const shape of [key, uriEncoded, formEncoded]) {
      const output = redact.redactSecrets(`前 ${shape} 后`, [key]);
      assert.ok(!output.includes(shape), `${JSON.stringify(shape)} 未被遮蔽`);
    }
  }
});

test("脱敏仍保持密钥字母大小写敏感", () => {
  const output = redact.redactSecrets("含 keywithcase 与 KeyWithCase", ["KeyWithCase"]);
  assert.ok(output.includes("keywithcase"), "仅大小写不同的文本不应被误伤");
  assert.ok(!output.includes("KeyWithCase"));
});

test("凭据与搜索共用同一总预算，不会各拿一份", async () => {
  const budgetMs = 400;
  const stageMs = 250;
  const engine = engineMod.createSearchEngine(
    { allowBillable: true, totalTimeoutMs: budgetMs, timeoutMs: 300, retries: 0 },
    {
      env: {},
      resolveKey: async () => {
        await delay(stageMs);
        return "synthetic-key";
      },
      fetch: async () => {
        await delay(stageMs);
        return new Response(JSON.stringify({ results: [{ url: "https://example.test/" }] }), { headers: { "content-type": "application/json" } });
      },
    },
  );
  const started = Date.now();
  let failed = false;
  try {
    await engine.search({ query: "预算" });
  } catch {
    failed = true;
  } finally {
    await engine.dispose();
  }
  const elapsed = Date.now() - started;
  // 两段各 250ms 合计 500ms 已超出 400ms 预算：必须超时，而不是两段各给 400ms。
  assert.equal(failed, true, "总预算耗尽应当失败");
  assert.ok(elapsed < budgetMs + 350, `总耗时 ${elapsed}ms 超出预算范围`);
});

test("错误诊断有独立长度上限", async () => {
  const huge = "E".repeat(1_000_000);
  const engine = engineMod.createSearchEngine(
    { retries: 0, timeoutMs: 2_000 },
    { env: {}, fetch: async () => new Response(JSON.stringify({ error: huge }), { status: 500 }) },
  );
  try {
    const error = await engine.search({ query: "大错误" }).then(() => assert.fail("应当失败"), (reason) => reason);
    assert.ok(error.message.length <= 2_000, `错误文本 ${error.message.length} 字符，应有上限`);
  } finally {
    await engine.dispose();
  }
});

test("余额刷新变小后，旧预留的第二笔派发必须被拒", async () => {
  let now = 0;
  let remaining = 2;
  const manager = quota.createQuotaManager({
    clock: () => now,
    lookup: async () => ({ state: "known", remaining, eligibility: "not_verified" }),
  });
  const scope = { backend: "tavily", channel: "key", credential: "synthetic-credential", allowBillable: true };
  await manager.lookupBalance(scope);
  const first = manager.reserve({ ...scope, operation: "search", maxResults: 1 });
  const second = manager.reserve({ ...scope, operation: "search", maxResults: 1 });
  assert.equal(first.status, "reserved");
  assert.equal(second.status, "reserved");
  // 缓存过期后余额降到 1：两份旧预留不能都派发成功。
  now += 10 * 60_000;
  remaining = 1;
  await manager.lookupBalance(scope);
  assert.equal(first.reservation.dispatch(), true);
  assert.equal(second.reservation.dispatch(), false, "余额已不足以支撑第二笔派发");
});
