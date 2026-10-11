import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function fail(message) { throw new Error(message); }
async function files(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) fail("源码与编译目录不接受符号链接");
    const name = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await files(join(directory, entry.name), name + "/"));
    else if (entry.isFile()) result.push(name);
    else fail("源码与编译目录存在未知文件类型");
  }
  return result.sort();
}
function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0 || result.error) fail("编译产物未与 Git 暂存或提交内容保持一致");
  return result.stdout;
}
const source = (await files(join(root, "src"))).filter(name => name.endsWith(".ts") && !name.endsWith(".d.ts"));
const expected = source.flatMap(name => [name.slice(0, -3) + ".js", name.slice(0, -3) + ".d.ts"]).sort();
const actual = await files(join(root, "lib"));
if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("编译文件缺失或包含未知产物");
const tracked = git(["ls-files", "-z", "--", "lib"]).split("\0").filter(Boolean).map(name => name.replace(/^lib\//u, "")).sort();
if (JSON.stringify(tracked) !== JSON.stringify(expected)) fail("Git 安装包缺少已跟踪的编译入口");
git(["diff", "--quiet", "--", "lib"]);
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (["prepare", "install", "postinstall"].some(name => Object.hasOwn(manifest.scripts, name))) fail("不得依赖安装生命周期脚本补全运行入口");
const plugin = await import("dsh-web-search");
const core = await import("dsh-web-search/core");
if (typeof plugin.apply !== "function" || typeof core.createSearchEngine !== "function") fail("插件或搜索核心入口不可加载");
console.log(`已验证 ${actual.length} 个已跟踪编译文件，插件和搜索核心入口均可直接加载。`);
