/**
 * 把编译产物需要的非 TypeScript 资源复制到 `lib/`。
 *
 * 目前只有 macOS Keychain 的 Swift 适配器：它在运行时用相对路径解析，
 * 因此必须与编译后的 `lib/auth/credentials.js` 处于同一目录层级。
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assets = [["src/auth/macos-keychain.swift", "lib/auth/macos-keychain.swift"]];

for (const [from, to] of assets) {
  const target = join(root, to);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(root, from), target);
}
console.log(`已复制 ${assets.length} 个运行时资源到 lib/。`);
