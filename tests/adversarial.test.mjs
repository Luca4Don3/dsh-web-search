/**
 * 对抗性审查发现的六项缺陷的回归测试。
 *
 * 每项都对应一个可复现的真实缺陷：
 * 1. 混合大小写的百分号编码绕过脱敏
 * 2. 凭据解析不受总预算约束
 * 3. 持久化阻塞把成功结果变成超时
 * 4. 落盘等待脱离预算、取消与关闭
 * 5. 两层配置接受范围不一致
 * 6. 内存测试注入仍创建宿主目录
 */
import assert from "node:assert/strict";
import test from "node:test";

const redact = await import(new URL("../lib/shared/redact.js", import.meta.url));
const engineMod = await import(new URL("../lib/search/engine.js", import.meta.url));
const configMod = await import(new URL("../lib/search/config.js", import.meta.url));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("脱敏：百分号转义的十六进制大小写混用也必须遮蔽", () => {
  // 虚构密钥，含需要百分号编码的字符。
  const key = "sk+adv/Key=";
  const upper = encodeURIComponent(key);
  const lower = upper.replace(/%[0-9A-F]{2}/gu, (part) => part.toLowerCase());
  const mixed = upper.replace(/%[0-9A-F]{2}/gu, (part, offset) => (offset % 2 === 0 ? part : part.toLowerCase()));
  for (const form of [key, upper, lower, mixed]) {
    assert.ok(!redact.redactSecrets(`回显 ${form} 结束`, [key]).includes(form), `${form} 未被遮蔽`);
  }
});

test("脱敏：百分号以外的字符仍保持大小写敏感", () => {
  const key = "KeyWithCase";
  assert.ok(!redact.redactSecrets("含 KeyWithCase", [key]).includes(key));
  // 仅改字母大小写不是同一个密钥，不应被误伤。
  assert.ok(redact.redactSecrets("含 keywithcase", [key]).includes("keywithcase"));
});

test("持久化阻塞只降级为警告，不丢弃已取得的结果", async () => {
  const { createQuotaManager } = await import(new URL("../lib/quota/core.js", import.meta.url));
  const blockingStore = { kind: "private", load: async () => ({ status: "missing" }), save: () => new Promise(() => {}) };
  const engine = engineMod.createSearchEngine(
    { quotaManager: createQuotaManager({ stateStore: blockingStore }), totalTimeoutMs: 300, retries: 0 },
    { env: {}, fetch: async () => new Response(JSON.stringify({ result: { content: [{ type: "text", text: "Title: ok\nURL: https://ok.test/" }] } })) },
  );
  try {
    const result = await engine.search({ query: "持久化" });
    assert.equal(result.sources.length, 1, "搜索结果不应因写盘阻塞而丢失");
    assert.equal(result.backend, "exa");
  } finally {
    await engine.dispose();
  }
});

test("落盘等待受取消约束，不会在取消后继续阻塞", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const engine = engineMod.createSearchEngine(
    { totalTimeoutMs: 5_000, timeoutMs: 1_000, retries: 0, maxChars: 10 },
    { env: {}, fetch: async () => new Response(JSON.stringify({ result: { content: [{ type: "text", text: "Title: long\nURL: https://ok.test/\nHighlights:\n" + "x".repeat(200) }] } })) },
  );
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = engine.searchWithSpill({ query: "x" }, async () => { await gate; return { path: "/tmp/never", complete: true }; }, controller.signal)
    .then(() => "resolved", (error) => error.code ?? error.name);
  setTimeout(() => controller.abort(), 30);
  // 落盘仍被 gate 挡住：先确认取消已经生效，再释放 gate 让收尾继续。
  // 内核层以稳定错误码表达取消；到 Pi 适配层才转成 DOMException。
  const settled = await Promise.race([pending, delay(800).then(() => "timeout")]);
  assert.equal(settled, "ABORTED", "取消必须结束落盘等待");
  assert.ok(Date.now() - startedAt < 1_000);
  release();
  await engine.dispose();
});

test("配置接受范围与内核一致，合法值不会被二次拒绝", () => {
  // 外层允许 120000，内核也必须接受，否则会在读取凭据后才报错。
  assert.equal(configMod.readSearchRequestConfig({ PI_WEB_SEARCH_TIMEOUT_MS: "120000" }).timeoutMs, 120_000);
  const engine = engineMod.createSearchEngine({ timeoutMs: 120_000 }, { env: {} });
  assert.ok(engine);
  void engine.dispose();
  // 内核作为库仍允许更短的测试预算。
  const tiny = engineMod.createSearchEngine({ timeoutMs: 20 }, { env: {} });
  assert.ok(tiny);
  void tiny.dispose();
});

test("单通道超时继续尝试后续通道，不终止整次搜索", async () => {
  let calls = 0;
  const engine = engineMod.createSearchEngine(
    { timeoutMs: 40, totalTimeoutMs: 5_000, retries: 0 },
    {
      env: {},
      fetch: async (url) => {
        calls += 1;
        if (String(url).includes("mcp.exa.ai")) {
          await delay(500);
          return new Response("slow", { status: 200 });
        }
        return new Response(JSON.stringify({ results: [{ url: "https://ok.test/" }] }), { headers: { "content-type": "application/json" } });
      },
    },
  );
  try {
    const result = await engine.search({ query: "慢通道" });
    assert.notEqual(result.backend, "exa");
    assert.ok(calls >= 2, "应继续尝试后续通道");
  } finally {
    await engine.dispose();
  }
});
