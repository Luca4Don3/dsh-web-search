/**
 * 回归：抓取在超限/取消路径上，abort 监听器内同步抛出的 AbortError 不得逃逸。
 *
 * 真实宿主加载的是编译产物 `lib/`（ESM），与 jiti 转译出的 CJS 在异常传播上
 * 并不等价；因此本用例在独立子进程里直接加载 `lib/`，断言进程没有出现
 * uncaughtException / unhandledRejection，同时对外的错误分类保持不变。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const libEntry = new URL("../../lib/fetch/transport/http-client.js", import.meta.url);

const child = String.raw`
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
const { httpFetch } = await import(pathToFileURL(process.env.DSH_COMPAT_HTTP_CLIENT).href);

let uncaught = 0;
process.on("uncaughtException", () => { uncaught += 1; });
process.on("unhandledRejection", () => { uncaught += 1; });

const SIZE = 8 * 1024 * 1024;
const server = createServer((req, res) => {
  res.on("error", () => undefined);
  res.writeHead(200, { "content-type": "text/html" });
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  let sent = 0;
  const pump = () => {
    while (sent < SIZE) {
      sent += chunk.length;
      if (!res.write(chunk)) { res.once("drain", pump); return; }
    }
    res.end();
  };
  pump();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port;

let kind = "none";
try {
  await httpFetch({
    url: new URL(base),
    target: { url: new URL(base), address: "127.0.0.1", family: 4 },
    timeoutMs: 10000,
    maxResponseBytes: 64 * 1024,
  });
} catch (error) {
  kind = error?.kind ?? error?.name ?? "unknown";
}
await new Promise((resolve) => setTimeout(resolve, 400));
server.close();
console.log(JSON.stringify({ kind, uncaught }));
`;

test("编译产物在超限中止后不产生未捕获异常", { skip: existsSync(libEntry) ? false : "需要先构建 lib/" }, () => {
	const run = spawnSync(process.execPath, ["--input-type=module", "-e", child], {
		cwd: root,
		encoding: "utf8",
		timeout: 60_000,
		env: { ...process.env, DSH_COMPAT_HTTP_CLIENT: fileURLToPath(libEntry) },
	});
	assert.equal(run.status, 0, `子进程失败: ${run.stderr}`);
	const line = run.stdout.trim().split("\n").at(-1);
	const result = JSON.parse(line);
	assert.equal(result.kind, "response_too_large", "超限仍应归类为 response_too_large");
	assert.equal(result.uncaught, 0, "取消路径不得产生未捕获异常");
});
