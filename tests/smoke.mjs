import { createSearchEngine } from "../lib/search/engine.js";

const env = new Proxy({}, { get() { throw new Error("匿名冒烟禁止读取任何密钥"); } });
const engine = createSearchEngine({ allowBillable: false, timeoutMs: 25_000, retries: 0 }, { env });
const started = performance.now();
try {
  const result = await engine.search({ query: "DeepSeek Harness web provider documentation", maxResults: 3 });
  if (result.accessTier !== "anonymous" || result.sources.length === 0 || result.sources.length > 3) throw new Error("匿名结果验收失败");
  console.log(JSON.stringify({ status: "成功", provider: result.backend, sources: result.sources.length, elapsedMs: Math.round(performance.now() - started) }));
} catch (error) {
  console.error(JSON.stringify({ status: "失败", code: typeof error?.code === "string" ? error.code : "SEARCH_FAILED", elapsedMs: Math.round(performance.now() - started) }));
  process.exitCode = 1;
} finally { await engine.dispose(); }
