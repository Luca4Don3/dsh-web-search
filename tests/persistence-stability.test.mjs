import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile, unlink, access } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { QuotaManager } from "../lib/core/quota.js";
import { createPrivateStateStore } from "../lib/core/state.js";

async function fixture() { await mkdir(".temp/persistence-stability", { recursive: true }); return mkdtemp(join(process.cwd(), ".temp/persistence-stability/state-")); }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function holdLock(directory) {
  const path = join(directory, ".quota-state.lock");
  await writeFile(path, JSON.stringify({ version: 1, pid: process.pid, nonce: "a".repeat(48) }), { mode: 0o600 });
  return async () => unlink(path);
}
async function seed(directory) {
  const manager = new QuotaManager({ stateDirectory: directory }, {});
  await manager.initialize(); manager.recordFailure("exa", "anonymous", undefined, "rate_limited");
  assert.equal(await manager.flush(), "saved"); manager.dispose();
}

test("状态加载取消不是不安全状态，同一仓库下一次可加载并保存", async () => {
  const directory = await fixture();
  const store = createPrivateStateStore(directory);
  assert.equal((await store.load()).status, "ok");
  const release = await holdLock(directory);
  const controller = new AbortController();
  const pending = store.load(controller.signal);
  setTimeout(() => controller.abort(), 20);
  try { assert.equal((await pending).status, "cancelled"); }
  finally { await release(); }
  const next = await store.load();
  assert.equal(next.status, "ok");
  assert.equal(await store.save(next.state), "saved");
});

test("首次初始化取消后可重试，恢复之前落盘的冷却", async () => {
  const directory = await fixture(); await seed(directory);
  const release = await holdLock(directory);
  const manager = new QuotaManager({ stateDirectory: directory }, {});
  const controller = new AbortController();
  const pending = manager.initialize(controller.signal);
  setTimeout(() => controller.abort(), 20);
  try { await assert.rejects(pending, (error) => error.kind === "aborted"); }
  finally { await release(); }
  await manager.initialize();
  assert.equal(manager.cooldown("exa", "anonymous", undefined), "rate_limited");
  assert.equal(manager.warning, undefined);
  manager.dispose();
});

test("共享初始化一个调用者取消不会污染另一个调用者", async () => {
  const directory = await fixture(); await seed(directory);
  const release = await holdLock(directory);
  const manager = new QuotaManager({ stateDirectory: directory }, {});
  const first = new AbortController();
  const a = manager.initialize(first.signal).then(() => null, (error) => error);
  const b = manager.initialize();
  await delay(20); first.abort();
  assert.equal((await a).kind, "aborted");
  await release(); await b;
  assert.equal(manager.cooldown("exa", "anonymous", undefined), "rate_limited");
  assert.equal(manager.warning, undefined);
  manager.dispose();
});

test("初始化采用磁盘盐值后保留已确认的内存冷却与密钥作用域", async () => {
  const directory = await fixture(); await seed(directory);
  const manager = new QuotaManager({ stateDirectory: directory }, {});
  const key = "synthetic-pending-key";
  manager.recordFailure("tavily", "key", key, "rate_limited");
  await manager.initialize();
  assert.equal(manager.cooldown("exa", "anonymous", undefined), "rate_limited");
  assert.equal(manager.cooldown("tavily", "key", key), "rate_limited");
  assert.equal(await manager.flush(), "saved");
  const restored = new QuotaManager({ stateDirectory: directory }, {}); await restored.initialize();
  assert.equal(restored.cooldown("tavily", "key", key), "rate_limited");
  assert.equal((await readFile(join(directory, "state.json"), "utf8")).includes(key), false);
  manager.dispose(); restored.dispose();
});

test("429 后搜索取消仍独立落盘，进程被终止后重启可恢复", async () => {
  const directory = await fixture();
  const module = new URL("../lib/core/index.js", import.meta.url).href;
  const script = `import {createSearchEngine} from ${JSON.stringify(module)};
    const controller=new AbortController();
    const engine=createSearchEngine({stateDirectory:process.argv[1],retries:0},{env:{},fetch:async(url)=>{
      if(String(url).includes("mcp.exa.ai")) return new Response("too many requests",{status:429});
      controller.abort(); return new Promise(()=>{});
    }});
    try {await engine.search({query:"offline fixture"},controller.signal);} catch(error) {process.send?.(error.code==="ABORTED"?"已取消":"异常");}
    setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, directory], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    const message = await new Promise((resolve, reject) => { const timer=setTimeout(()=>reject(new Error("子进程超时")),3000); child.once("message",value=>{clearTimeout(timer);resolve(value);}); child.once("error",reject); });
    assert.equal(message, "已取消");
    let saved = false;
    for (let index = 0; index < 100; index++) {
      try { const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8")); saved = state.entries.some((entry) => entry.backend === "exa" && entry.reason === "rate_limited" && !entry.cleared); } catch { /* 等待独立写入，不打印私有状态。 */ }
      if (saved) break;
      await delay(10);
    }
    assert.equal(saved, true, "不能依赖正常卸载才落盘");
  } finally { const closed=new Promise(resolve=>child.once("close",resolve)); child.kill("SIGKILL"); await closed; }
  const manager = new QuotaManager({ stateDirectory: directory }, {}); await manager.initialize();
  assert.equal(manager.cooldown("exa", "anonymous", undefined), "rate_limited"); manager.dispose();
});

test("不合作磁盘写入只保留单个工作项，等待有界且消费者取消不撤销写入", async () => {
  let saves = 0;
  let writeSignal;
  const state = { version: 1, salt: Buffer.alloc(32, 1).toString("base64"), entries: [] };
  const store = { load: async () => ({ status: "ok", state }), save: async (_state, signal) => { saves++; writeSignal=signal; return new Promise(()=>{}); } };
  const manager = new QuotaManager({}, {}, store);
  await manager.initialize(); manager.recordFailure("exa", "anonymous", undefined, "rate_limited");
  const canceled = new AbortController();
  const pending = manager.flush(canceled.signal);
  await delay(10); canceled.abort();
  await assert.rejects(pending, (error) => error.kind === "aborted");
  assert.equal(writeSignal.aborted, false);
  const started = performance.now();
  assert.equal(await manager.flush(), "degraded");
  assert.ok(performance.now()-started < 1600);
  for (let i=0;i<100;i++) manager.recordFailure("exa", "anonymous", undefined, "rate_limited");
  assert.equal(await manager.flush(), "degraded");
  assert.equal(saves, 1);
  assert.match(manager.warning, /未能安全保存/u); manager.dispose();
});

test("不支持的 Windows 私有权限返回明确原因且不创建目录", async () => {
  const parent = await fixture(); const path = join(parent, "unsupported");
  const store = createPrivateStateStore(path, { platform: "win32" });
  const loaded = await store.load();
  assert.equal(loaded.status, "unavailable");
  assert.equal(loaded.reason, "unsupported_platform");
  await assert.rejects(access(path));
});

test("初始化前确认成功的清除事件也能落盘，不恢复已经清除的冷却", async () => {
  const directory = await fixture(); await seed(directory);
  const manager = new QuotaManager({ stateDirectory: directory }, {});
  manager.recordSuccess("exa", "anonymous", undefined);
  await manager.initialize();
  assert.equal(manager.cooldown("exa", "anonymous", undefined), undefined);
  assert.equal(await manager.flush(), "saved");
  const restarted = new QuotaManager({ stateDirectory: directory }, {}); await restarted.initialize();
  assert.equal(restarted.cooldown("exa", "anonymous", undefined), undefined);
  manager.dispose(); restarted.dispose();
});

test("已取消初始化的迟到结果不能换盐或覆盖新一轮内存状态", async () => {
  let finish;
  let loads = 0;
  const state = { version: 1, salt: Buffer.alloc(32, 2).toString("base64"), entries: [] };
  let lastSaved;
  const store = { load: async () => ++loads === 1 ? new Promise(resolve=>{finish=resolve;}) : {status:"ok",state}, save: async(value)=>{lastSaved=value;return "saved";} };
  const manager = new QuotaManager({}, {}, store);
  const controller = new AbortController();
  const first = manager.initialize(controller.signal).then(()=>null,error=>error);
  while (!finish) await delay(1);
  controller.abort(); assert.equal((await first).kind,"aborted");
  await manager.initialize(); manager.recordFailure("exa","anonymous",undefined,"rate_limited");
  assert.equal(await manager.flush(),"saved");
  finish({status:"ok",state:{...state,salt:Buffer.alloc(32,3).toString("base64")}});
  await delay(10);
  assert.equal(manager.cooldown("exa","anonymous",undefined),"rate_limited");
  assert.equal(lastSaved.salt===state.salt,true); manager.dispose();
});

test("写入期间的事件合并到下一份快照，不产生每事件写入队列", async () => {
  const state = { version: 1, salt: Buffer.alloc(32, 4).toString("base64"), entries: [] };
  const snapshots = []; const finishes = [];
  const store = {load:async()=>({status:"ok",state}),save:async(snapshot)=>{snapshots.push(snapshot);return new Promise(resolve=>finishes.push(resolve));}};
  const manager = new QuotaManager({}, {}, store); await manager.initialize();
  manager.recordFailure("exa","anonymous",undefined,"rate_limited");
  const flushed=manager.flush();
  while (finishes.length<1) await delay(1);
  for (let index=0;index<100;index++) manager.recordFailure("tavily","anonymous",undefined,"rate_limited");
  assert.equal(snapshots.length,1);
  finishes[0]("saved"); while(finishes.length<2) await delay(1);
  assert.equal(snapshots[1].entries.length,2);
  finishes[1]("saved"); assert.equal(await flushed,"saved");
  assert.equal(await manager.flush(),"saved");
  assert.equal(snapshots.length,2); manager.dispose();
});
