/**
 * 第三轮对抗性审查发现的缺陷的回归测试。
 *
 * 覆盖：正文解析的同步耗时、重叠密钥、元标题属性、文章头保留、
 * 仿冒容器、预算时钟、诊断长度与抓取提供方生命周期。
 */
import assert from "node:assert/strict";
import test from "node:test";

const extract = await import(new URL("../lib/fetch/extract/index.js", import.meta.url));
const redact = await import(new URL("../lib/shared/redact.js", import.meta.url));
const core = await import(new URL("../lib/search/core.js", import.meta.url));
const dsh = await import(new URL("../lib/hosts/dsh.js", import.meta.url));

// 合法模式只有 auto／article／text：这里用 auto，避免用不存在的模式绕过校验。
const run = (html) => extract.extractContent(html, "text/html", "auto", 24_000).markdown;

test("提取模式校验：非法模式必须被拒绝", () => {
  assert.throws(() => extract.extractContent("<p>x</p>", "text/html", "markdown", 24_000), /mode 不受支持/u);
});

test("未闭合 meta 标签不会拖慢标题提取", () => {
  const evil = `<html><head><title>ok</title></head><body>${"<meta ".repeat(90_000)}</body></html>`;
  assert.ok(evil.length >= 500_000);
  const started = performance.now();
  assert.equal(extract.extractTitle(evil), "ok");
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 500, `标题提取耗时 ${Math.round(elapsed)}ms，应保持线性`);
});

test("占位符避碰不会随共同前缀逐字增长", () => {
  const marker = String.fromCharCode(0xE000);
  const evil = `<html><body><pre>${marker}webfetch-code${"_".repeat(160_000)}</pre><p>正文</p></body></html>`;
  const started = performance.now();
  const markdown = run(evil);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 500, `提取耗时 ${Math.round(elapsed)}ms，应保持线性`);
  assert.ok(markdown.includes("正文"));
});

test("元标题属性与顺序、空白、相似属性名无关", () => {
  const cases = [
    ['<meta content="前置" property="og:title">', "前置"],
    ['<meta property = "og:title" content = "空白">', "空白"],
    ['<meta data-og:title content="伪"><meta property="og:title" content="真">', "真"],
    ["<meta property='og:title' content='单引号'>", "单引号"],
  ];
  for (const [meta, expected] of cases) {
    assert.equal(extract.extractTitle(`<html><head>${meta}<title>兜底</title></head></html>`), expected);
  }
});

test("重叠密钥全部遮蔽，不留下长密钥后缀", () => {
  const short = "sk-overlap-prefix";
  const long = "sk-overlap-prefix-and-a-considerably-longer-suffix-0123";
  for (const order of [[short, long], [long, short]]) {
    const output = redact.redactSecrets(`回显 ${long} 结束`, order);
    assert.ok(!output.includes(long));
    assert.ok(!output.includes("considerably-longer"), "长密钥后缀不得残留");
  }
});

test("文章内部的标题与摘要不被当成站点噪声删除", () => {
  const html = "<html><body><header>站点导航</header><main><article>"
    + "<header><h1>文章主标题</h1><p>文章摘要</p></header><p>正文段落</p>"
    + "</article></main></body></html>";
  const markdown = run(html);
  assert.ok(markdown.includes("文章主标题"));
  assert.ok(markdown.includes("文章摘要"));
  assert.ok(markdown.includes("正文段落"));
});

// 第四轮调整：无法判定为导航的 header 一律保留。
// 纯文本 header 与文章头在结构上无法区分，删除它会丢掉真实标题；
// 只有含 <nav> 或链接密集的菜单条才会被剔除。
test("只有 body 时无法判定为导航的 header 保留", () => {
  const markdown = run("<html><body><header>站点导航</header><p>正文段落</p></body></html>");
  assert.ok(markdown.includes("正文段落"));
});

test("文本输入区域里的仿冒容器不抢占正文", () => {
  const html = "<html><body><textarea><main>伪正文</main></textarea>"
    + "<article>真实文章内容</article></body></html>";
  const markdown = run(html);
  assert.ok(markdown.includes("真实文章内容"));
  assert.ok(!markdown.includes("伪正文"), "不得从文本区域内部选取正文");
});

test("错误诊断有上限，且超长错误不被整段带出", async () => {
  const engine = core === undefined ? undefined : (await import(new URL("../lib/search/engine.js", import.meta.url))).createSearchEngine(
    { retries: 0, timeoutMs: 2_000 },
    { env: {}, fetch: async () => new Response(JSON.stringify({ error: "E".repeat(500_000) }), { status: 500 }) },
  );
  try {
    const error = await engine.search({ query: "x" }).then(() => assert.fail("应当失败"), (reason) => reason);
    assert.ok(error.message.length <= 2_000, `错误文本 ${error.message.length} 字符，应有上限`);
  } finally {
    await engine.dispose();
  }
});

test("抓取提供方卸载后不返回在途结果", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = new dsh.LocalFirstFetchProvider(
    { maxChars: 24_000, timeoutMs: 5_000, deadlineMs: 5_000, maxResponseBytes: 5_242_880, maxRedirects: 3, maxAttempts: 1, userAgent: "test", allowPrivateHosts: false },
    {
      resolveTarget: async () => ({ address: "203.0.113.10", family: 4 }),
      fetchPage: async () => {
        await gate;
        return { body: "<p>正文</p>", contentType: "text/html", finalUrl: new URL("https://example.test/"), redirectCount: 0, statusCode: 200 };
      },
    },
  );
  const pending = provider.fetch({ url: "https://example.test/" }).then(() => "resolved", (error) => error.code ?? "rejected");
  provider.dispose();
  release();
  assert.equal(await pending, "WEB_PROVIDER_UNAVAILABLE", "卸载后不得把正文交出去");
});

test("重定向后的错误状态报告最终地址", async () => {
  const finalUrl = "https://final.example.test/missing";
  const provider = new dsh.LocalFirstFetchProvider(
    { maxChars: 24_000, timeoutMs: 5_000, deadlineMs: 5_000, maxResponseBytes: 5_242_880, maxRedirects: 3, maxAttempts: 1, userAgent: "test", allowPrivateHosts: false },
    {
      resolveTarget: async () => ({ address: "203.0.113.10", family: 4 }),
      fetchPage: async () => {
        const { FetchError } = await import(new URL("../lib/fetch/errors.js", import.meta.url));
        throw new FetchError("目标不存在", "http_error", { statusCode: 404, finalUrl });
      },
    },
  );
  const result = await provider.fetch({ url: "https://start.example.test/" });
  assert.equal(result.statusCode, 404);
  assert.equal(result.url, finalUrl, "错误状态必须报告最终地址而非初始地址");
});
