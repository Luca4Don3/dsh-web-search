/**
 * Pi 入口的组合层回归：旧会话恢复后必须重新激活本扩展的两个工具。
 *
 * 背景：Pi 恢复会话时会用 transcript 里的 `toolsAdded` 覆盖激活列表。
 * 若会话创建时还没有 `web_fetch`，恢复后即使扩展注册了它也不会出现在模型工具里。
 * 入口层在 `session_start` / `session_tree` 上补齐，且只补自己的工具。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const entry = await jiti.import(fileURLToPath(new URL("../../pi.ts", import.meta.url)));

const credentialStore = {
	kind: "none",
	async read() { return { status: "missing" }; },
	async write() { return { status: "unavailable", reason: "测试替身" }; },
	async clear() { return { status: "missing" }; },
};
const quotaManager = {
	snapshot() { return { persistence: "not_initialized", cooldowns: [] }; },
};

function setup(initialActive) {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	let active = [...initialActive];
	const pi = {
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand(name, options) { commands.set(name, options); },
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => undefined;
		},
		getActiveTools() { return [...active]; },
		setActiveTools(names) { active = [...names]; },
	};
	entry.default(pi, { credentialStore, quotaManager });
	const fire = (event) => {
		for (const handler of handlers.get(event) ?? []) handler({ type: event });
	};
	return { tools, commands, active: () => [...active], fire };
}

test("入口注册两个工具与认证命令", () => {
	const { tools, commands } = setup([]);
	assert.deepEqual([...tools.keys()].sort(), ["web_fetch", "web_search"]);
	assert.ok(commands.has("web-search-auth"));
});

test("旧会话恢复缺少 web_fetch 时由 session_start 补齐", () => {
	const { active, fire } = setup(["read", "bash", "edit", "write", "codemode", "subagent", "web_search"]);
	fire("session_start");
	assert.ok(active().includes("web_fetch"));
	assert.ok(active().includes("web_search"));
	assert.equal(active().filter((name) => name === "web_fetch").length, 1, "不得重复添加");
});

test("补齐是幂等的，不改变已有顺序", () => {
	const initial = ["read", "web_search", "bash"];
	const { active, fire } = setup(initial);
	fire("session_start");
	fire("session_start");
	assert.deepEqual(active(), ["read", "web_search", "bash", "web_fetch"]);
});

test("fork 或切换会话后的 session_tree 同样补齐", () => {
	const { active, fire } = setup(["read", "bash"]);
	fire("session_tree");
	assert.deepEqual(active(), ["read", "bash", "web_search", "web_fetch"]);
});

test("runtime 尚未绑定时抛错被吞掉，后续事件仍能补齐", () => {
	let available = false;
	const handlers = new Map();
	let active = ["read"];
	const pi = {
		registerTool() {},
		registerCommand() {},
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		getActiveTools() {
			if (!available) throw new Error("Extension runtime not initialized");
			return [...active];
		},
		setActiveTools(names) { active = [...names]; },
	};
	entry.default(pi, { credentialStore, quotaManager });
	const fire = () => { for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start" }); };
	assert.doesNotThrow(fire);
	available = true;
	fire();
	assert.ok(active.includes("web_fetch"));
});
