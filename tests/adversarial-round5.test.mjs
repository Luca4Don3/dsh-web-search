/** 第九轮对抗审查的回归用例：这些断言表达期望行为，用于防止修复回退。 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { renderSources } from "../lib/search/engine.js";
import { extractContent } from "../lib/fetch/extract/index.js";

const ROOT = mkdtempSync(join(tmpdir(), "dsh-r9-"));

test("搜索结果标题不得提前闭合引用链接", () => {
	const output = renderSources([{ url: "https://real.example/a", title: "陷阱](https://evil.example/phish)" }], "");
	// Markdown 里只有**未转义**的 ]( 能闭合链接。标题中的必须被反斜杠转义，
	// 因此整段输出里应当只剩工具自己生成的那一个链接目标。
	const closers = [...output.matchAll(/\]\(/gu)]
		.map((match) => match.index)
		.filter((index) => output[index - 1] !== "\\");
	assert.equal(closers.length, 1, `只应有一个真实链接目标: ${output}`);
	assert.ok(output.endsWith("(https://real.example/a)"), "链接目标必须仍是真实地址");
});

test("标题与摘要里的换行不得生成伪造的列表项", () => {
	const output = renderSources([
		{ url: "https://real.example/c", title: "正常\n2. [伪造](https://evil.example/b)", snippet: "摘要\n3. [伪造](https://evil.example/d)" },
	], "");
	const numbered = output.split("\n").filter((line) => /^\s*\d+\.\s/u.test(line));
	assert.equal(numbered.length, 1, "只应有一个工具生成的列表项");
});

test("URL 里的括号不得截断链接", () => {
	const output = renderSources([{ url: "https://en.wikipedia.org/wiki/Foo_(bar)", title: "wiki" }], "");
	assert.ok(output.includes("Foo_%28bar%29"), `括号应被编码: ${output}`);
});

test("提取流水线在阶段之间响应截止时间", () => {
	const block = '<p>Lorem ipsum dolor sit amet.</p><a href="/x">link</a>';
	const html = "<body>" + block.repeat(2000) + "</body>";
	let calls = 0;
	extractContent(html, "text/html", "auto", 24000, undefined, () => { calls++; });
	assert.ok(calls >= 4, `应有多处检查点，实际 ${calls} 次`);

	// 检查器抛错必须中断提取，而不是被吞掉继续跑完。
	let stopped = false;
	assert.throws(() => {
		extractContent(html, "text/html", "auto", 24000, undefined, () => {
			if (stopped) throw new Error("deadline");
			stopped = true;
		});
	}, /deadline/u);
});

test("凭据命令的退出监听器不随并发累积", async () => {
	const before = process.listenerCount("exit");
	const jobs = Array.from({ length: 12 }, () =>
		import("../lib/auth/credentials.js")
			.then(({ spawnExec }) => spawnExec("sh", ["-c", "true"], undefined, 5000))
			.catch(() => undefined),
	);
	await Promise.all(jobs);
	// 只应安装一个模块级监听器，而不是每个调用一个。
	assert.ok(process.listenerCount("exit") - before <= 1, `监听器泄漏: ${process.listenerCount("exit") - before}`);
});

test.after(() => rmSync(ROOT, { recursive: true, force: true }));
