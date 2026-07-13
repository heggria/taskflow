/**
 * Unit tests for the shared `runSubagentProcess` (runner-core.ts).
 *
 * This is the spawn / idle-watchdog / abort / signal-kill / stderr-cap / post-exit
 * classify block shared by the codex/claude/opencode/grok runners. It has no other
 * direct unit tests — the host parsers are tested in their own packages, but the
 * shared process/classify contract (the highest-blast-radius code: a bug here
 * affects all 3 non-pi hosts) is exercised here against REAL short-lived child
 * processes (no mocks), with a trivial foldLine that just echoes stdout.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	isFailed,
	runSubagentProcess,
	unknownAgentResult,
	DEFAULT_IDLE_TIMEOUT_MS,
	MAX_STDOUT_LINE_BYTES,
	type SubagentAccumulator,
} from "../src/runner-core.ts";
import type { LiveUpdate } from "../src/host/runner-types.ts";
import type { AgentConfig } from "../src/agents.ts";

/** A minimal accumulator + foldLine: finalText = the last stdout line, one turn
 *  per line. Just enough to drive runSubagentProcess without a host parser. */
function makeAcc(): SubagentAccumulator {
	return { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, finalText: "", lastActivity: "" };
}
const foldLine = (acc: SubagentAccumulator, line: string): LiveUpdate | null => {
	if (!line.trim()) return null;
	try { JSON.parse(line); } catch { return null; } // only fold JSON lines
	acc.finalText = line.trim();
	acc.usage.turns++;
	acc.lastActivity = acc.finalText;
	return { text: acc.lastActivity, usage: { ...acc.usage }, model: undefined };
};

test("isFailed: an errorMessage cannot be treated as success", () => {
	assert.equal(isFailed({ agent: "a", task: "t", exitCode: 0, output: "partial", stderr: "", usage: makeAcc().usage, errorMessage: "transport failed" }), true);
});

/** Spawn a `node -e <script>` child as the subagent, with our shared foldLine. */
function run(script: string, opts: { idleTimeoutMs?: number; signal?: AbortSignal } = {}) {
	return runSubagentProcess({
		agent: "test", task: "t", model: undefined,
		bin: "node", args: ["-e", script], cwd: process.cwd(),
		idleTimeoutMs: opts.idleTimeoutMs, signal: opts.signal,
		acc: makeAcc(), foldLine,
	});
}

test("runSubagentProcess: a clean JSON-emitting run classifies as end", async () => {
	const r = await run(`process.stdout.write(JSON.stringify({answer:42})+"\\n");`);
	assert.equal(r.exitCode, 0);
	assert.equal(r.stopReason, "end");
	assert.equal(r.errorMessage, undefined);
	assert.match(r.output, /answer/);
});

test("runSubagentProcess: a non-zero exit classifies as error + placeholder", async () => {
	const r = await run(`process.exit(1);`);
	assert.equal(r.exitCode, 1);
	assert.equal(r.stopReason, "error");
	// no stdout → output becomes the transport placeholder
	assert.match(r.output, /upstream error/);
});

test("runSubagentProcess: idle watchdog — a silent child is killed + flagged idleTimeout", async () => {
	// child sleeps forever; idle window 200ms
	const r = await run(`setInterval(()=>{}, 1000);`, { idleTimeoutMs: 200 });
	assert.equal(r.stopReason, "error");
	assert.equal(r.idleTimeout, true, "an idle child must be flagged idleTimeout");
	assert.match(r.errorMessage ?? "", /stalled|idle/i);
});

test("runSubagentProcess: AbortSignal — an aborted run classifies as aborted (NOT idle)", async () => {
	// This is the CONC-002 regression guard: abort must win over idle. The child
	// sleeps; we abort after 80ms (well inside the 60s idle window), so idle must
	// NOT fire. Without clearTimers() in the abort handler the idle timer could
	// race and misreport 'idle' — this test pins the abort-wins classification.
	const ac = new AbortController();
	const p = run(`setInterval(()=>{}, 1000);`, { idleTimeoutMs: 60_000, signal: ac.signal });
	setTimeout(() => ac.abort(), 80);
	const r = await p;
	assert.equal(r.stopReason, "aborted", "abort must classify as 'aborted', not idle/error");
	assert.equal(r.idleTimeout, undefined, "idle must NOT fire on an aborted run");
	assert.match(r.errorMessage ?? "", /abort/i);
});

test("runSubagentProcess: abort terminates the child process tree", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-process-tree-"));
	const marker = path.join(dir, "grandchild-survived.txt");
	const priorMarker = process.env.TASKFLOW_TEST_ABORT_MARKER;
	try {
		process.env.TASKFLOW_TEST_ABORT_MARKER = marker;
		const fixture = fileURLToPath(new URL("./fixtures/process-tree-abort-parent.mjs", import.meta.url));
		const ac = new AbortController();
		const pending = runSubagentProcess({
			agent: "test", task: "tree", model: undefined,
			bin: "node", args: [fixture], cwd: process.cwd(),
			idleTimeoutMs: 60_000, signal: ac.signal,
			acc: makeAcc(), foldLine,
			onLive: () => ac.abort(),
		});
		const result = await pending;
		assert.equal(result.stopReason, "aborted");
		await new Promise((resolve) => setTimeout(resolve, 750));
		assert.equal(fs.existsSync(marker), false, "grandchild must not survive cancellation to write its marker");
	} finally {
		if (priorMarker === undefined) delete process.env.TASKFLOW_TEST_ABORT_MARKER;
		else process.env.TASKFLOW_TEST_ABORT_MARKER = priorMarker;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runSubagentProcess: normal completion reaps background descendants", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-process-tree-normal-"));
	const marker = path.join(dir, "normal-grandchild.txt");
	const priorMarker = process.env.TASKFLOW_TEST_NORMAL_MARKER;
	try {
		process.env.TASKFLOW_TEST_NORMAL_MARKER = marker;
		const fixture = new URL("./fixtures/process-tree-parent.mjs", import.meta.url);
		const started = Date.now();
		const result = await runSubagentProcess({
			agent: "test", task: "tree-normal", model: undefined,
			bin: "node", args: [fileURLToPath(fixture)], cwd: process.cwd(),
			idleTimeoutMs: 60_000,
			acc: makeAcc(), foldLine,
		});
		assert.equal(result.stopReason, "end");
		assert.ok(Date.now() - started < 500, "inherited descendant stdio must not delay normal phase completion");
		await new Promise((resolve) => setTimeout(resolve, 750));
		assert.equal(fs.existsSync(marker), false, "a completed phase must not leave a descendant running");
	} finally {
		if (priorMarker === undefined) delete process.env.TASKFLOW_TEST_NORMAL_MARKER;
		else process.env.TASKFLOW_TEST_NORMAL_MARKER = priorMarker;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runSubagentProcess: removes the abort listener after a child exits", async () => {
	const ac = new AbortController();
	const signal = ac.signal;
	const originalAdd = signal.addEventListener.bind(signal);
	const originalRemove = signal.removeEventListener.bind(signal);
	let added = 0;
	let removed = 0;
	(signal as unknown as { addEventListener: typeof signal.addEventListener }).addEventListener = ((...args: Parameters<typeof signal.addEventListener>) => {
		added++;
		return originalAdd(...args);
	}) as typeof signal.addEventListener;
	(signal as unknown as { removeEventListener: typeof signal.removeEventListener }).removeEventListener = ((...args: Parameters<typeof signal.removeEventListener>) => {
		removed++;
		return originalRemove(...args);
	}) as typeof signal.removeEventListener;
	const result = await run(`process.stdout.write(JSON.stringify({done:true})+"\\n");`, { signal });
	assert.equal(result.exitCode, 0);
	assert.equal(added, 1);
	assert.equal(removed, 1, "completed child must not retain a listener on a long-lived run signal");
});

test("runSubagentProcess: a throwing foldLine fails closed without crashing the host", async () => {
	const throwingFold = (): LiveUpdate | null => { throw new Error("parser boom"); };
	const r = await runSubagentProcess({
		agent: "test", task: "t", model: undefined,
		bin: "node", args: ["-e", `process.stdout.write(JSON.stringify({hello:true})+"\\n");`], cwd: process.cwd(),
		acc: makeAcc(), foldLine: throwingFold,
	});
	assert.equal(r.exitCode, 1);
	assert.equal(r.stopReason, "error");
	assert.match(r.errorMessage ?? "", /parser failed.*parser boom/i);
});

test("runSubagentProcess: malformed or truncated stdout fails closed", async () => {
	const r = await run(`process.stdout.write('{"type":"result"');`);
	assert.equal(r.exitCode, 1);
	assert.equal(r.stopReason, "error");
	assert.match(r.errorMessage ?? "", /malformed|truncated/i);
});

test("runSubagentProcess: zero exit without a final answer is a transport failure", async () => {
	const r = await runSubagentProcess({
		agent: "test", task: "t", model: undefined,
		bin: "node", args: ["-e", `process.stdout.write(JSON.stringify({type:"heartbeat"})+"\\n");`], cwd: process.cwd(),
		acc: makeAcc(), foldLine: () => null,
	});
	assert.equal(r.exitCode, 1);
	assert.equal(r.stopReason, "error");
	assert.match(r.errorMessage ?? "", /without a final output/i);
});

test("runSubagentProcess: partial answer without a required terminal event fails closed", async () => {
	const r = await runSubagentProcess({
		agent: "test", task: "t", model: undefined,
		bin: "node", args: ["-e", `process.stdout.write(JSON.stringify({answer:"partial"})+"\\n");`], cwd: process.cwd(),
		acc: makeAcc(), foldLine,
		requireTerminalEvent: true,
		terminalEventLabel: "test done",
	});
	assert.equal(r.exitCode, 1);
	assert.equal(r.stopReason, "error");
	assert.match(r.errorMessage ?? "", /before test done/i);
});

test("runSubagentProcess: unterminated stdout retention is bounded", async () => {
	const r = await run(`process.stdout.write("x".repeat(${MAX_STDOUT_LINE_BYTES + 4096})); setInterval(()=>{},1000);`, {
		idleTimeoutMs: 60_000,
	});
	assert.equal(r.exitCode, 1);
	assert.match(r.errorMessage ?? "", /unterminated stdout record/i);
});

test("runSubagentProcess: stderr activity resets the idle watchdog", async () => {
	const r = await run(`
		let n=0;
		const t=setInterval(()=>{ process.stderr.write("working\\n"); if(++n===4){ clearInterval(t); process.stdout.write(JSON.stringify({done:true})+"\\n"); } }, 60);
	`, { idleTimeoutMs: 100 });
	assert.equal(r.exitCode, 0);
	assert.equal(r.idleTimeout, undefined);
});

test("runSubagentProcess: a throwing onLive callback is swallowed (fail-open)", async () => {
	const r = await runSubagentProcess({
		agent: "test", task: "t", model: undefined,
		bin: "node", args: ["-e", `process.stdout.write(JSON.stringify({x:1})+"\\n");`], cwd: process.cwd(),
		acc: makeAcc(), foldLine,
		onLive: () => { throw new Error("tui boom"); },
	});
	assert.equal(r.exitCode, 0, "a throwing onLive must not fail the run");
	assert.equal(r.stopReason, "end");
});

test("runSubagentProcess: stderr is capped at ~64KB", async () => {
	// child writes 100KB to stderr then exits 1
	const r = await run(`process.stderr.write("x".repeat(100*1024)); process.exit(1);`);
	assert.equal(r.exitCode, 1);
	assert.ok(r.stderr.length <= 64 * 1024 + 64, `stderr not capped: ${r.stderr.length}`);
	assert.match(r.stderr, /\[...stderr truncated at 64KB\]/);
});

test("runSubagentProcess: fatalError in the accumulator wins as error", async () => {
	// A foldLine that sets fatalError: the classify chain must mark it error.
	const acc = makeAcc();
	const r = await runSubagentProcess({
		agent: "test", task: "t", model: undefined,
		bin: "node", args: ["-e", `process.stdout.write(JSON.stringify({ok:true})+"\\n");`], cwd: process.cwd(),
		acc,
		foldLine: (a) => { a.fatalError = "synthetic fatal"; return null; },
	});
	assert.equal(r.stopReason, "error");
	assert.equal(r.errorMessage, "synthetic fatal");
});

test("unknownAgentResult: lists available agents + classifies as error", () => {
	const agents: AgentConfig[] = [
		{ name: "executor", description: "", systemPrompt: "", source: "user", filePath: "" },
		{ name: "scout", description: "", systemPrompt: "", source: "user", filePath: "" },
	];
	const r = unknownAgentResult("ghost", "do thing", agents);
	assert.equal(r.exitCode, 1);
	assert.equal(r.stopReason, "error");
	assert.match(r.stderr, /Unknown agent: "ghost"/);
	assert.match(r.stderr, /"executor", "scout"/);
});

test("DEFAULT_IDLE_TIMEOUT_MS is 5 minutes", () => {
	assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 5 * 60_000);
});

test("runSubagentProcess: PI_TASKFLOW_RUN_LOG emits a structured header to STDERR only (never stdout)", async () => {
	// The header is an operator diagnostic. MCP stdio reserves stdout for
	// JSON-RPC, so the header MUST go to stderr only. Default is off; the env
	// flag turns it on. We capture both streams to pin this.
	const prev = process.env.PI_TASKFLOW_RUN_LOG;
	const stderrChunks: string[] = [];
	const origStderrWrite = process.stderr.write.bind(process.stderr);
	const origStdoutWrite = process.stdout.write.bind(process.stdout);
	const stdoutChunks: string[] = [];
	try {
		process.env.PI_TASKFLOW_RUN_LOG = "1";
		process.stderr.write = ((chunk: any) => { stderrChunks.push(String(chunk)); return true; }) as any;
		process.stdout.write = ((chunk: any) => { stdoutChunks.push(String(chunk)); return true; }) as any;
		await runSubagentProcess({
			agent: "executor", task: "t", model: "gpt-5.5",
			bin: "node", args: ["-e", `process.stdout.write(JSON.stringify({ok:true})+"\\n");`], cwd: process.cwd(),
			acc: makeAcc(), foldLine,
		});
	} finally {
		process.stderr.write = origStderrWrite;
		process.stdout.write = origStdoutWrite;
		if (prev === undefined) delete process.env.PI_TASKFLOW_RUN_LOG;
		else process.env.PI_TASKFLOW_RUN_LOG = prev;
	}
	const hostStderr = stderrChunks.join("");
	assert.match(hostStderr, /^\[taskflow:run\] agent=executor bin=node/, "structured header on stderr");
	assert.match(hostStderr, /model=gpt-5\.5/, "header includes the model");
	assert.equal(stdoutChunks.some((c) => c.includes("[taskflow:run]")), false, "header must NEVER touch stdout (MCP JSON-RPC channel)");
});

test("runSubagentProcess: no PI_TASKFLOW_RUN_LOG → no header written (default-off)", async () => {
	const prev = process.env.PI_TASKFLOW_RUN_LOG;
	const stderrChunks: string[] = [];
	const origStderrWrite = process.stderr.write.bind(process.stderr);
	try {
		delete process.env.PI_TASKFLOW_RUN_LOG;
		process.stderr.write = ((chunk: any) => { stderrChunks.push(String(chunk)); return true; }) as any;
		await runSubagentProcess({
			agent: "executor", task: "t", model: undefined,
			bin: "node", args: ["-e", `process.stdout.write(JSON.stringify({ok:true})+"\\n");`], cwd: process.cwd(),
			acc: makeAcc(), foldLine,
		});
	} finally {
		process.stderr.write = origStderrWrite;
		if (prev === undefined) delete process.env.PI_TASKFLOW_RUN_LOG;
		else process.env.PI_TASKFLOW_RUN_LOG = prev;
	}
	assert.equal(stderrChunks.some((c) => c.includes("[taskflow:run]")), false, "default-off: no header");
});
