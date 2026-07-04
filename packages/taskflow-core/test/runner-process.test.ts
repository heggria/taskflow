/**
 * Unit tests for the shared `runSubagentProcess` (runner-core.ts).
 *
 * This is the spawn / idle-watchdog / abort / signal-kill / stderr-cap / post-exit
 * classify block shared by the codex/claude/opencode runners. It has no other
 * direct unit tests — the host parsers are tested in their own packages, but the
 * shared process/classify contract (the highest-blast-radius code: a bug here
 * affects all 3 non-pi hosts) is exercised here against REAL short-lived child
 * processes (no mocks), with a trivial foldLine that just echoes stdout.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	runSubagentProcess,
	unknownAgentResult,
	DEFAULT_IDLE_TIMEOUT_MS,
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

test("runSubagentProcess: a throwing foldLine is swallowed (fail-open), run still completes", async () => {
	// The MI-04 backstop: a foldLine that throws must not crash the host process.
	const throwingFold = (): LiveUpdate | null => { throw new Error("parser boom"); };
	const r = await runSubagentProcess({
		agent: "test", task: "t", model: undefined,
		bin: "node", args: ["-e", `process.stdout.write("hello\\n");`], cwd: process.cwd(),
		acc: makeAcc(), foldLine: throwingFold,
	});
	// The throwing line is skipped; the process still exits 0 → 'end', not a crash.
	assert.equal(r.exitCode, 0);
	assert.equal(r.stopReason, "end");
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
		bin: "node", args: ["-e", `process.stdout.write("ok\\n");`], cwd: process.cwd(),
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
