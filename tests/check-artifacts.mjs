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
// 编译产物 = 每个 .ts 对应的 .js/.d.ts + scripts/copy-assets.mjs 声明的运行时资源。
const ASSETS = ["auth/macos-keychain.swift"];
const expected = [...source.flatMap(name => [name.slice(0, -3) + ".js", name.slice(0, -3) + ".d.ts"]), ...ASSETS].sort();
const actual = await files(join(root, "lib"));
// 宿主无关内核 + 两个宿主适配层都应有编译产物。
if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("编译文件缺失或包含未知产物");
const tracked = git(["ls-files", "-z", "--", "lib"]).split("\0").filter(Boolean).map(name => name.replace(/^lib\//u, "")).sort();
if (JSON.stringify(tracked) !== JSON.stringify(expected)) fail("Git 安装包缺少已跟踪的编译入口");
git(["diff", "--quiet", "--", "lib"]);
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (["prepare", "install", "postinstall"].some(name => Object.hasOwn(manifest.scripts, name))) fail("不得依赖安装生命周期脚本补全运行入口");
// 双宿主入口必须都存在且可加载。
const plugin = await import("dsh-web-search");
const core = await import("dsh-web-search/core");
const fetchEntry = await import("dsh-web-search/fetch");
if (typeof plugin.apply !== "function") fail("DSH 插件入口不可加载");
if (typeof core.createSearchEngine !== "function") fail("搜索核心入口不可加载");
if (typeof fetchEntry.fetchPage !== "function") fail("抓取内核入口不可加载");
// Pi 入口只做静态校验：真实 import 会拉起 Pi 的完整运行时，
// 其内部模块版本差异不应让 DSH 的打包检查失败。
const piEntry = await readFile(join(root, "pi.ts"), "utf8");
if (!/export default function/u.test(piEntry)) fail("Pi 入口缺少默认导出");
if (!/piWebSearch|piWebFetch/u.test(piEntry)) fail("Pi 入口未组合搜索与抓取适配层");
await readFile(join(root, "lib/hosts/pi.js"), "utf8");
await readFile(join(root, "lib/hosts/pi-fetch.js"), "utf8");
// Pi 的根入口必须与 package.json 声明一致，避免安装后静默不加载。
if (JSON.stringify(manifest.pi?.extensions) !== JSON.stringify(["./pi.ts"])) fail("Pi 扩展入口声明与 pi.ts 不一致");
console.log(`已验证 ${actual.length} 个已跟踪编译文件；DSH 插件、搜索内核与抓取内核入口可直接加载，Pi 入口产物与声明一致。`);
