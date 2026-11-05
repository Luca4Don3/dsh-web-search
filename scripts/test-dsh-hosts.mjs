/** 每个官方宿主使用独立进程、该版 Web/Cordis 与插件自己的运行依赖；不改安装版。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const own = createRequire(join(root, "package.json"));
const hosts = process.argv.slice(2);
if (!hosts.length) hosts.push(join(root, "node_modules"));
await mkdir(join(root, ".temp"), { recursive: true });
const run = await mkdtemp(join(root, ".temp", "dsh-hosts-"));
const results = [];
for (const [index, modules] of hosts.entries()) {
  const host = createRequire(join(resolve(modules), "..", "package.json"));
  const manifest = JSON.parse(await readFile(host.resolve("@deepseek-ai/dsh-web/package.json"), "utf8"));
  const stage = join(run, `${index}-${manifest.version}`);
  const scope = join(stage, "node_modules", "@deepseek-ai");
  await mkdir(scope, { recursive: true });
  await cp(join(root, "lib"), join(stage, "lib"), { recursive: true });
  await cp(join(root, "tests", "hosts", "web-contract.test.mjs"), join(stage, "web-contract.test.mjs"));
  await writeFile(join(stage, "package.json"), JSON.stringify({ private: true, type: "module" }));
  for (const name of ["cordis", "dsh-web", "dsh-llm", "dsh-tools", "dsh-system-prompt", "dsh-tool-web"]) {
    try {
      const resolver = name === "dsh-llm" ? createRequire(host.resolve("@deepseek-ai/dsh-web/package.json")) : host;
      const entry = resolver.resolve(`@deepseek-ai/${name}/package.json`);
      await symlink(dirname(entry), join(scope, name), "dir");
    } catch (error) {
      if (["cordis", "dsh-web", "dsh-llm"].includes(name) || error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  await symlink(dirname(own.resolve("@deepseek-ai/schemastery/package.json")), join(scope, "schemastery"), "dir");
  await symlink(dirname(own.resolve("undici/package.json")), join(stage, "node_modules", "undici"), "dir");
  const cordis = JSON.parse(await readFile(host.resolve("@deepseek-ai/cordis/package.json"), "utf8"));
  console.log(`
=== official Web ${manifest.version}; Cordis ${cordis.version} ===`);
  const child = spawnSync(process.execPath, ["--test", "--test-timeout=30000", "web-contract.test.mjs"], {
    cwd: stage, encoding: "utf8", timeout: 35_000,
    env: { PATH: process.env.PATH, HOME: join(stage, "home"), TMPDIR: stage },
  });
  process.stdout.write(child.stdout ?? "");
  process.stderr.write(child.stderr ?? "");
  const result = { web: manifest.version, cordis: cordis.version, status: child.status, signal: child.signal, error: child.error?.message };
  results.push(result);
  await writeFile(join(stage, "test.log"), `${child.stdout ?? ""}${child.stderr ?? ""}`);
}
await writeFile(join(run, "results.json"), JSON.stringify(results, null, 2) + "\n");
console.log(`
Evidence: ${run}`);
assert.ok(results.every((result) => result.status === 0), "官方宿主矩阵存在失败，见各版本 test.log");
