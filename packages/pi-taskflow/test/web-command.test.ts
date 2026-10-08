import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerTaskflow from "../src/index.ts";
import { createWebCommand, openDefaultBrowser, type WebCommandOptions } from "../src/web-command.ts";

const SECRET = `test-${randomUUID()}`;
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function fixture(mode = "ready") {
	// Short Unix socket paths also work on macOS.
	const temporary = realpathSync(mkdtempSync("/tmp/tfw-"));
	const root = join(temporary, "project with spaces;$literal");
	mkdirSync(root);
	const pidFile = join(temporary, "pid");
	const argvFile = join(temporary, "argv.json");
	const handoff = join(temporary, "console-handoff-aaaa.json");
	const cli = join(temporary, "child.mjs");
	writeFileSync(cli, `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()}));
const mode = ${JSON.stringify(mode)};
if (mode === 'exit') { process.stderr.write('private ${SECRET} TF_BOOTSTRAP_FAILED EPERM'); process.exit(7); }
process.on('SIGTERM', () => { if (mode !== 'hang') process.exit(0); });
setInterval(() => {}, 1000);
if (mode === 'hang') { /* no readiness, ignores graceful termination */ }
else if (mode === 'flood') process.stderr.write('x'.repeat(70 * 1024) + '${SECRET}');
else {
 fs.writeFileSync(${JSON.stringify(handoff)}, JSON.stringify({url:'http://127.0.0.1:12345',token:'${SECRET}'}), {mode: mode === 'permissions' ? 0o644 : 0o600});
 const url = mode === 'unsafe' ? 'http://127.0.0.1:12345/?token=${SECRET}' : 'http://127.0.0.1:12345';
 const line = JSON.stringify({consoleUrl:url,browserHandoffFile:${JSON.stringify(handoff)},token:'${SECRET}'}) + '\\n';
 process.stdout.write(line.slice(0,12)); setTimeout(() => process.stdout.write(line.slice(12)), 10);
}
`);
	const messages: { text: string; kind?: string }[] = [];
	const context = { cwd: root, ui: { notify(text: string, kind?: string) { messages.push({ text, kind }); } } };
	const options: WebCommandOptions = { resolveCli: () => cli, openBrowser: async () => {}, startupTimeoutMs: 1_000, stopTimeoutMs: 100 };
	return { temporary, root, cli, handoff, pidFile, argvFile, messages, context, options,
		clean() { rmSync(temporary, { recursive: true, force: true }); } };
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

function assertPrivate(messages: { text: string }[]) {
	assert.ok(messages.length);
	assert.doesNotMatch(messages.map((message) => message.text).join("\n"), new RegExp(SECRET));
}

test("web lifecycle: concurrent invocation and symlink cwd reuse one owned child, then shutdown", async () => {
	const f = fixture();
	let opens = 0;
	const web = createWebCommand({ ...f.options, openBrowser: async (url) => { assert.equal(url, "http://127.0.0.1:12345"); opens++; } });
	const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
	try {
		await Promise.all([web.run(f.context), web.run(f.context)]);
		const pid = Number(readFileSync(f.pidFile, "utf8"));
		const alias = join(f.temporary, "alias"); symlinkSync(f.root, alias);
		await web.run({ ...f.context, cwd: alias });
		assert.equal(Number(readFileSync(f.pidFile, "utf8")), pid);
		assert.equal(opens, 3);
		assert.deepEqual(JSON.parse(readFileSync(f.argvFile, "utf8")), {
			argv: ["serve", "--root", f.root, "--console"], cwd: f.root,
		});
		assertPrivate(f.messages);
		assert.match(f.messages[0]!.text, /Control Plane runs and evidence/);
		assert.match(f.messages[0]!.text, /Private login handoff:/);
		await web.close();
		assert.equal(alive(pid), false);
		assert.equal(alive(unrelated.pid!), true, "never signal an unrelated process");
		await web.close();
		await web.run(f.context);
		assert.match(f.messages.at(-1)!.text, /already shut down/);
	} finally { await web.close(); unrelated.kill("SIGKILL"); f.clean(); }
});

test("web lifecycle: changed canonical cwd stops old child before replacement; dead child restarts", async () => {
	const f = fixture(); const web = createWebCommand(f.options);
	try {
		await web.run(f.context);
		const first = Number(readFileSync(f.pidFile, "utf8"));
		const other = join(f.temporary, "other"); mkdirSync(other);
		await web.run({ ...f.context, cwd: other });
		const second = Number(readFileSync(f.pidFile, "utf8"));
		assert.notEqual(first, second); assert.equal(alive(first), false);
		process.kill(second, "SIGTERM");
		for (let i = 0; i < 100 && alive(second); i++) await pause(10);
		assert.equal(alive(second), false);
		await web.run({ ...f.context, cwd: other });
		assert.notEqual(Number(readFileSync(f.pidFile, "utf8")), second);
		assertPrivate(f.messages);
	} finally { await web.close(); f.clean(); }
});

for (const [mode, expected] of [
	["exit", /before readiness \(7\).*TF_BOOTSTRAP_FAILED.*EPERM/u],
	["hang", /startup timed out/u],
	["flood", /exceeded 64 KiB/u],
	["unsafe", /unsafe browser URL/u],
	["permissions", /private same-user file/u],
] as const) {
	test(`web startup failure: ${mode} is bounded, private and reaps its real child`, async () => {
		const f = fixture(mode); const web = createWebCommand(f.options);
		try {
			await web.run(f.context);
			assert.equal(f.messages.at(-1)!.kind, "error");
			assert.match(f.messages.at(-1)!.text, expected);
			assert.equal(alive(Number(readFileSync(f.pidFile, "utf8"))), false);
			assertPrivate(f.messages);
		} finally { await web.close(); f.clean(); }
	});
}

test("web lifecycle: shutdown aborts an in-flight startup instead of waiting for readiness timeout", async () => {
	const f = fixture("hang"); const web = createWebCommand({ ...f.options, startupTimeoutMs: 60_000 });
	try {
		const starting = web.run(f.context);
		for (let i = 0; i < 100 && !existsSync(f.pidFile); i++) await pause(10);
		assert.ok(existsSync(f.pidFile));
		await web.close(); await starting;
		assert.equal(alive(Number(readFileSync(f.pidFile, "utf8"))), false);
		assert.match(f.messages.at(-1)!.text, /cancelled by session shutdown/u);
	} finally { await web.close(); f.clean(); }
});

test("web lifecycle: a failed startup can be repaired and retried in the same session", async () => {
	const failed = fixture("exit"), ready = fixture();
	let cli = failed.cli;
	const web = createWebCommand({ ...failed.options, resolveCli: () => cli });
	try {
		await web.run(failed.context);
		assert.equal(failed.messages.at(-1)!.kind, "error");
		assert.equal(alive(Number(readFileSync(failed.pidFile, "utf8"))), false);
		cli = ready.cli;
		await web.run(failed.context);
		assert.equal(failed.messages.at(-1)!.kind, "info");
		const pid = Number(readFileSync(ready.pidFile, "utf8"));
		assert.equal(alive(pid), true);
		await web.close(); assert.equal(alive(pid), false);
		assertPrivate(failed.messages);
	} finally { await web.close(); failed.clean(); ready.clean(); }
});

test("web startup failure: missing carrier and unsupported platform fail without spawning", async () => {
	const f = fixture();
	try {
		for (const options of [
			{ ...f.options, resolveCli: () => join(f.temporary, "missing.js") },
			{ ...f.options, platform: "win32" as const, resolveCli: () => assert.fail("must not resolve on unsupported platform") },
		]) {
			const web = createWebCommand(options);
			try { await web.run(f.context); } finally { await web.close(); }
			assert.equal(f.messages.at(-1)!.kind, "error");
		}
		assert.match(f.messages[0]!.text, /before readiness/u);
		assert.match(f.messages[1]!.text, /Windows is unsupported/u);
		assert.equal(existsSync(f.pidFile), false);
	} finally { f.clean(); }
});

test("web browser fallback: opener errors never disclose exception text or stop the console", async () => {
	const f = fixture(); const web = createWebCommand({ ...f.options, openBrowser: async () => { throw new Error(SECRET); } });
	try {
		await web.run(f.context);
		assert.equal(f.messages.at(-1)!.kind, "warning");
		assert.match(f.messages.at(-1)!.text, /Open http:\/\/127\.0\.0\.1:12345 manually/u);
		assert.equal(alive(Number(readFileSync(f.pidFile, "utf8"))), true);
		assertPrivate(f.messages);
	} finally { await web.close(); f.clean(); }
});

test("web browser opener: harmless PATH executable receives only URL and launch timeout reaps it", async () => {
	const f = fixture(); const previousPath = process.env.PATH;
	try {
		const bin = join(f.temporary, "bin"); mkdirSync(bin);
		const opener = join(bin, process.platform === "darwin" ? "open" : "xdg-open");
		writeFileSync(opener, `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(f.argvFile)},JSON.stringify(process.argv.slice(2)));\n`);
		chmodSync(opener, 0o755); process.env.PATH = `${bin}:${previousPath ?? ""}`;
		await openDefaultBrowser("http://127.0.0.1:12345");
		assert.deepEqual(JSON.parse(readFileSync(f.argvFile, "utf8")), ["http://127.0.0.1:12345"]);
		writeFileSync(opener, `#!${process.execPath}\nprocess.exit(1);\n`);
		const web = createWebCommand({ ...f.options, openBrowser: undefined });
		try {
			await web.run(f.context);
			assert.equal(f.messages.at(-1)!.kind, "warning");
			assert.match(f.messages.at(-1)!.text, /Open http:\/\/127\.0\.0\.1:12345 manually/u);
		} finally { await web.close(); }
		writeFileSync(opener, `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(f.pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`);
		await assert.rejects(openDefaultBrowser("http://127.0.0.1:12345", process.platform, 500), /timed out/u);
		assert.equal(alive(Number(readFileSync(f.pidFile, "utf8"))), false);
	} finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; f.clean(); }
});

// Actual installed startup/login/reuse/shutdown is covered by the packed consumer
// smoke. Source tests run before dist exists in a clean CI checkout.
test("registered /tf web is completed, validates arguments, and stays outside model tools", async () => {
 const messages: string[] = [];
 let command: RegisteredCommand | undefined;
 let shutdown: (() => Promise<void>) | undefined;
 let tool: ToolDefinition | undefined;
 registerTaskflow({
  registerCommand(name: string, definition: RegisteredCommand) { if (name === "tf") command = definition; },
  registerTool(definition: ToolDefinition) { tool = definition; },
  on(event: string, handler: () => Promise<void>) { if (event === "session_shutdown") shutdown = handler; },
 } as unknown as ExtensionAPI);
 assert.ok(command); assert.ok(shutdown); assert.ok(tool);
 assert.ok((await command.getArgumentCompletions?.("we"))?.some(item => item.value === "web"));
 assert.doesNotMatch(JSON.stringify(tool.parameters), /"web"/u);
 await command.handler("web extra", { cwd: process.cwd(), ui: { notify(text: string) { messages.push(text); } } } as unknown as ExtensionCommandContext);
 assert.deepEqual(messages, ["Usage: /tf web"]);
 await shutdown();
});
