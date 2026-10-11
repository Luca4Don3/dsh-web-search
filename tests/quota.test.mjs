import assert from "node:assert/strict";
import test from "node:test";
import { chmod, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(process.cwd(), ".temp/core");
const { QuotaManager } = await import(new URL("../lib/core/quota.js", import.meta.url));
const { createPrivateStateStore } = await import(new URL("../lib/core/state.js", import.meta.url));
function fixture(name) { return join(root, `${name}-${process.pid}-${Math.random().toString(16).slice(2)}`); }
function closeChild(child) { return new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`子进程退出码 ${code}`))); }); }

test("额度查询共享刷新，缓存五分钟/失败三十秒，预留并发扣减保守", async () => {
  let now = 10_000;
  let lookups = 0;
  const manager = new QuotaManager({}, { clock: () => now });
  await manager.initialize();
  const lookup = async () => { lookups++; await new Promise((resolve) => setTimeout(resolve, 5)); return { known: true, remaining: 3 }; };
  const signal = new AbortController().signal;
  const values = await Promise.all([manager.balance("tavily", "TAVILY_secret_123", signal, lookup), manager.balance("tavily", "TAVILY_secret_123", signal, lookup)]);
  assert.equal(lookups, 1);
  assert.deepEqual(values.map((value) => value.remaining), [3, 3]);
  const reservations = [0, 1, 2].map(() => manager.reserve("tavily", "TAVILY_secret_123", 8));
  assert.ok(reservations.every(Boolean));
  assert.equal(manager.reserve("tavily", "TAVILY_secret_123", 8), undefined);
  for (const reservation of reservations) { assert.equal(reservation.dispatch(), true); reservation.settle(); }
  assert.equal(manager.reserve("tavily", "TAVILY_secret_123", 8), undefined);

  await manager.balance("firecrawl", "FIRE_secret_123", signal, async () => ({ known: true, remaining: 6 }));
  const fire = manager.reserve("firecrawl", "FIRE_secret_123", 11);
  assert.equal(fire.cost, 4);
  fire.release();
  const again = manager.reserve("firecrawl", "FIRE_secret_123", 11);
  assert.equal(again.cost, 4);

  let failures = 0;
  await manager.balance("firecrawl", "FAIL_secret_123", signal, async () => { failures++; return { known: false }; });
  await manager.balance("firecrawl", "FAIL_secret_123", signal, async () => { failures++; return { known: true, remaining: 1 }; });
  assert.equal(failures, 1);
  now += 30_001;
  await manager.balance("firecrawl", "FAIL_secret_123", signal, async () => { failures++; return { known: true, remaining: 1 }; });
  assert.equal(failures, 2);
});

test("私有状态仅持久化 HMAC 冷却，跨进程并发保存合并", async () => {
  const directory = fixture("quota-merge");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const manager = new QuotaManager({ stateDirectory: directory }, {});
  await manager.initialize();
  manager.recordFailure("exa", "key", "EXA_sensitive_KEY_123", "rate_limited");
  const second = new QuotaManager({ stateDirectory: directory }, {});
  await second.initialize();
  second.recordFailure("firecrawl", "anonymous", undefined, "quota_exhausted");
  const childUrl = new URL("../lib/core/quota.js", import.meta.url).href;
  const code = `import { QuotaManager } from ${JSON.stringify(childUrl)}; const manager = new QuotaManager({stateDirectory:process.argv[1]},{}); await manager.initialize(); manager.recordFailure(process.argv[2],"anonymous",undefined,"rate_limited"); const result=await manager.flush(); if(result!=="saved") process.exitCode=3;`;
  const children = ["tavily", "parallel"].map((backend) => spawn(process.execPath, ["--input-type=module", "-e", code, directory, backend], { stdio: "ignore" }));
  await Promise.all(children.map(closeChild));
  assert.equal(await manager.flush(), "saved");
  assert.equal(await second.flush(), "saved");
  const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  assert.equal(state.entries.length, 4);
  const encoded = JSON.stringify(state);
  assert.equal(encoded.includes("EXA_sensitive_KEY_123"), false);
  assert.equal(encoded.includes("query"), false);
  assert.equal((await lstat(directory)).mode & 0o077, 0);
  assert.equal((await lstat(join(directory, "state.json"))).mode & 0o077, 0);
  await rm(directory, { recursive: true, force: true });
});

test("死亡 owner 锁可严格恢复；活锁、损坏锁与符号链接锁拒绝抢占", async () => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = fixture("quota-lock");
  const store = createPrivateStateStore(directory);
  assert.equal((await store.load()).status, "ok");
  const lockPath = join(directory, ".quota-state.lock");
  const live = JSON.stringify({ version: 1, pid: process.pid, nonce: "b".repeat(48) });
  await writeFile(lockPath, live, { mode: 0o600 });
  assert.equal((await createPrivateStateStore(directory).load()).status, "unavailable");
  await rm(lockPath);

  await writeFile(lockPath, "损坏锁", { mode: 0o600 });
  assert.equal((await createPrivateStateStore(directory).load()).status, "unavailable");
  assert.equal((await readFile(lockPath, "utf8")), "损坏锁");
  await rm(lockPath);

  const linkTarget = join(directory, "target");
  await writeFile(linkTarget, live, { mode: 0o600 });
  await symlink(linkTarget, lockPath);
  assert.equal((await createPrivateStateStore(directory).load()).status, "unavailable");
  assert.equal((await lstat(lockPath)).isSymbolicLink(), true);
  await rm(lockPath);
  await rm(linkTarget);

  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  await writeFile(lockPath, JSON.stringify({ version: 1, pid: child.pid, nonce: "c".repeat(48) }), { mode: 0o600 });
  await chmod(lockPath, 0o600);
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("close", resolve));
  assert.equal((await createPrivateStateStore(directory).load()).status, "ok");
  assert.equal((await readdir(directory)).includes(".quota-state.lock"), false);
  await rm(directory, { recursive: true, force: true });
});
