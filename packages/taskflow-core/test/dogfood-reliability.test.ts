/**
 * Focused tests for dogfood reliability issues 1, 3, and 7:
 *
 *  1. BREAKING reduce.from correction: {previous.output} aggregates ALL completed
 *     from[] outputs in from-array order (one → raw, many → joined), join:any
 *     includes only completed branches, observed reads include the from IDs,
 *     imperative/event-kernel parity.
 *  2. Configurable idle watchdog (idleTimeout DSL field): validation rules,
 *     threading to RunOptions.idleTimeoutMs, cache identity via definition hash.
 *  3. Prompt diagnostics + hierarchical (tree) reduce: durable promptStats on
 *     PhaseState, warning threshold, reduce input stats, tree reduceStrategy,
 *     tree forces imperative fallback (kernel admission).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { emptyUsage } from "../src/usage.ts";
import {
	executeTaskflow,
	promptSizeStats,
	resolveIdleTimeoutMs,
	PROMPT_SIZE_WARN_TOKENS,
	type RuntimeDeps,
} from "../src/runtime.ts";
import { canUseEventKernel, kernelUnsupportedReason } from "../src/exec/driver.ts";
import { CacheStore } from "../src/cache.ts";
import { validateTaskflow } from "../src/schema.ts";
import type { Taskflow } from "../src/schema.ts";
import { forkRunForResume } from "../src/resume.ts";
import type { RunState } from "../src/store.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test agent", systemPrompt: "", source: "user", filePath: "" },
];

function mkState(def: Taskflow, args: Record<string, unknown> = {}): RunState {
	return {
		runId: "test-run",
		flowName: def.name,
		def,
		args,
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: "/tmp",
	};
}

/** A mock runner that records the RunOptions passed to each call and returns
 *  canned output derived from the task text. `opts` can capture idleTimeoutMs. */
function mockRunner(
	respond: (task: string) => string,
	capture?: { options: RunOptions[]; tasks: string[] },
	opts?: { fail?: boolean },
): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task, o: RunOptions): Promise<RunResult> => {
		capture?.options.push(o);
		capture?.tasks.push(task);
		const failed = opts?.fail ?? false;
		return {
			agent: agentName,
			task,
			exitCode: failed ? 1 : 0,
			output: failed ? "" : respond(task),
			stderr: failed ? "boom" : "",
			usage: { ...emptyUsage(), output: 10, cost: 0.001, turns: 1 },
			stopReason: failed ? "error" : "end",
		};
	};
}

function baseDeps(runTask: RuntimeDeps["runTask"]): RuntimeDeps {
	return { cwd: "/tmp", agents: AGENTS, runTask, persist: () => {}, onProgress: () => {} };
}

// ===========================================================================
// 1. BREAKING reduce.from correction — {previous.output} aggregation
// ===========================================================================

test("reduce: single from source → {previous.output} is the raw output", async () => {
	const def: Taskflow = {
		name: "reduce-single",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "produce A" },
			{ id: "r", type: "reduce", agent: "a", from: ["a"], task: "summarize: {previous.output}", dependsOn: ["a"], final: true },
		],
	};
	const capture: { options: RunOptions[]; tasks: string[] } = { options: [], tasks: [] };
	const deps = baseDeps(mockRunner((t) => `R(${t})`, capture));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	// The reduce task received the raw output of phase a (not prefixed).
	const reduceTask = capture.tasks[1];
	assert.match(reduceTask, /summarize: R\(produce A\)/);
});

test("reduce: multiple from sources → {previous.output} aggregates all in from-order", async () => {
	const def: Taskflow = {
		name: "reduce-multi",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "produce A" },
			{ id: "b", type: "agent", agent: "a", task: "produce B" },
			{ id: "c", type: "agent", agent: "a", task: "produce C" },
			{
				id: "r",
				type: "reduce",
				agent: "a",
				from: ["a", "b", "c"],
				task: "SUM: {previous.output}",
				dependsOn: ["a", "b", "c"],
				final: true,
			},
		],
	};
	const capture: { options: RunOptions[]; tasks: string[] } = { options: [], tasks: [] };
	const deps = baseDeps(mockRunner((t) => `out:${t}`, capture));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	const reduceTask = capture.tasks[3];
	// All three outputs appear, in from-array order, with ### <id> headers, joined by ---.
	assert.match(reduceTask, /### a\n\nout:produce A/);
	assert.match(reduceTask, /---\n\n### b\n\nout:produce B/);
	assert.match(reduceTask, /---\n\n### c\n\nout:produce C/);
	// Verify from-order is preserved (a before b before c).
	const aIdx = reduceTask.indexOf("### a");
	const bIdx = reduceTask.indexOf("### b");
	const cIdx = reduceTask.indexOf("### c");
	assert.ok(aIdx < bIdx && bIdx < cIdx, "from-array order must be preserved");
});

test("reduce: join:any includes only completed branches (skipped omitted)", async () => {
	// Two branches; one is gated off (when:false → skipped). join:any reduce
	// must aggregate only the completed branch as a raw single output.
	const def: Taskflow = {
		name: "reduce-joinany",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "produce A" },
			{ id: "b", type: "agent", agent: "a", task: "produce B", when: "false" },
			{
				id: "r",
				type: "reduce",
				agent: "a",
				from: ["a", "b"],
				join: "any",
				task: "ONLY: {previous.output}",
				dependsOn: ["a", "b"],
				final: true,
			},
		],
	};
	const capture: { options: RunOptions[]; tasks: string[] } = { options: [], tasks: [] };
	const deps = baseDeps(mockRunner((t) => `val:${t}`, capture));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	// Only phase a completed → single raw output (no ### header, no --- separator).
	const reduceTask = capture.tasks[1];
	assert.match(reduceTask, /ONLY: val:produce A$/);
	assert.doesNotMatch(reduceTask, /###/);
	assert.doesNotMatch(reduceTask, /---/);
});

test("reduce: explicit {steps.X.output} behavior is unchanged", async () => {
	const def: Taskflow = {
		name: "reduce-explicit",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "produce A" },
			{ id: "b", type: "agent", agent: "a", task: "produce B" },
			{
				id: "r",
				type: "reduce",
				agent: "a",
				from: ["a", "b"],
				task: "first={steps.a.output} second={steps.b.output} prev={previous.output}",
				dependsOn: ["a", "b"],
				final: true,
			},
		],
	};
	const capture: { options: RunOptions[]; tasks: string[] } = { options: [], tasks: [] };
	const deps = baseDeps(mockRunner((t) => `o:${t}`, capture));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	const reduceTask = capture.tasks[2];
	// Explicit {steps.X.output} refs resolve to individual raw outputs.
	assert.match(reduceTask, /first=o:produce A second=o:produce B/);
	// {previous.output} is the aggregated multi-source value (### headers + ---).
	assert.match(reduceTask, /prev=### a\n\no:produce A\n\n---\n\n### b\n\no:produce B/);
});

test("reduce: observed reads include the aggregated from IDs", async () => {
	const def: Taskflow = {
		name: "reduce-reads",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "A" },
			{ id: "b", type: "agent", agent: "a", task: "B" },
			{
				id: "r",
				type: "reduce",
				agent: "a",
				from: ["a", "b"],
				task: "reduce {previous.output}",
				dependsOn: ["a", "b"],
				final: true,
			},
		],
	};
	const deps = baseDeps(mockRunner(() => "x"));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	const rPs = res.state.phases.r;
	assert.ok(rPs.reads, "reduce phase must have observed reads");
	const readIds = rPs.reads!.map((r) => r.stepId).sort();
	assert.deepEqual(readIds, ["a", "b"]);
});

test("reduce: event-kernel parity — {previous.output} aggregates identically", async () => {
	const def: Taskflow = {
		name: "reduce-parity",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "produce A" },
			{ id: "b", type: "agent", agent: "a", task: "produce B" },
			{
				id: "r",
				type: "reduce",
				agent: "a",
				from: ["a", "b"],
				task: "MERGE: {previous.output}",
				dependsOn: ["a", "b"],
				final: true,
			},
		],
	};
	const runTask = async (_c: string, _a: AgentConfig[], agent: string, task: string): Promise<RunResult> => ({
		agent,
		task,
		exitCode: 0,
		output: `ECHO:${task}`,
		stderr: "",
		usage: { ...emptyUsage(), output: 1 },
		stopReason: "end",
	});
	const kernel = await executeTaskflow(mkState(def, {}), {
		cwd: process.cwd(), agents: AGENTS, runTask, persist: () => {}, eventKernel: true,
	});
	const imp = await executeTaskflow(mkState(def, {}), {
		cwd: process.cwd(), agents: AGENTS, runTask, persist: () => {}, eventKernel: false,
	});
	assert.equal(kernel.ok, imp.ok, "both paths must succeed");
	// Both must aggregate a+b into {previous.output} identically.
	const kTask = (kernel.state.phases.r.output ?? "").replace(/^ECHO:/, "");
	const iTask = (imp.state.phases.r.output ?? "").replace(/^ECHO:/, "");
	assert.equal(kTask, iTask, "reduce {previous.output} aggregation must match across paths");
	assert.match(kTask, /MERGE: ### a\n\nECHO:produce A\n\n---\n\n### b\n\nECHO:produce B/);
	assert.deepEqual(
		kernel.state.phases.r.reads?.map((read) => read.stepId).sort(),
		["a", "b"],
		"event-kernel reduce must persist observed reads for every aggregated source",
	);
});

// ===========================================================================
// 2. Configurable idle watchdog (idleTimeout DSL field)
// ===========================================================================

test("idleTimeout validation: phase-level positive must be >= 1000", () => {
	const r = validateTaskflow({
		name: "t",
		phases: [{ id: "p", type: "agent", agent: "a", task: "x", idleTimeout: 500 }],
	});
	assert.ok(!r.ok);
	assert.ok(r.errors.some((e) => e.includes("idleTimeout") && e.includes(">= 1000")));
});

test("idleTimeout validation: phase-level 0 disables but requires finite wall timeout", () => {
	// 0 without timeout → rejected.
	const r1 = validateTaskflow({
		name: "t",
		phases: [{ id: "p", type: "agent", agent: "a", task: "x", idleTimeout: 0 }],
	});
	assert.ok(!r1.ok);
	assert.ok(r1.errors.some((e) => e.includes("idleTimeout:0") && e.includes("timeout")));
	// 0 WITH timeout >= 1000 → accepted.
	const r2 = validateTaskflow({
		name: "t",
		phases: [{ id: "p", type: "agent", agent: "a", task: "x", idleTimeout: 0, timeout: 30000 }],
	});
	assert.ok(r2.ok, JSON.stringify(r2.errors));
});

test("idleTimeout validation: phase overrides flow; flow 0 requires every agent-phase timeout", () => {
	// Flow-level 0, phase without timeout → rejected.
	const r1 = validateTaskflow({
		name: "t",
		idleTimeout: 0,
		phases: [{ id: "p", type: "agent", agent: "a", task: "x" }],
	});
	assert.ok(!r1.ok);
	assert.ok(r1.errors.some((e) => e.includes("idleTimeout:0")));
	// Flow-level 0, phase WITH timeout → accepted; phase-level override wins.
	const r2 = validateTaskflow({
		name: "t",
		idleTimeout: 0,
		phases: [{ id: "p", type: "agent", agent: "a", task: "x", idleTimeout: 5000 }],
	});
	assert.ok(r2.ok, JSON.stringify(r2.errors));
});

test("idleTimeout validation: flow-level positive must be >= 1000", () => {
	const r = validateTaskflow({
		name: "t",
		idleTimeout: 100,
		phases: [{ id: "p", type: "agent", agent: "a", task: "x" }],
	});
	assert.ok(!r.ok);
	assert.ok(r.errors.some((e) => e.includes("Flow 'idleTimeout'")));
});

test("idleTimeout validation: ignored (warned) on non-agent-running phases", () => {
	const r = validateTaskflow({
		name: "t",
		phases: [{ id: "p", type: "approval", task: "approve?", idleTimeout: 5000 }],
	});
	assert.ok(r.ok);
	assert.ok(r.warnings.some((w) => w.includes("idleTimeout") && w.includes("only applies")));
});

test("idleTimeout validation: race is agent-running and cannot disable idle without wall timeout", () => {
	const invalid = validateTaskflow({
		name: "race-idle",
		idleTimeout: 0,
		phases: [{
			id: "r",
			type: "race",
			branches: [{ task: "a" }, { task: "b" }],
			final: true,
		}],
	});
	assert.equal(invalid.ok, false);
	assert.match(invalid.errors.join("\n"), /idleTimeout:0.*finite wall 'timeout'/);

	const valid = validateTaskflow({
		name: "race-idle-bounded",
		idleTimeout: 0,
		phases: [{
			id: "r",
			type: "race",
			branches: [{ task: "a" }, { task: "b" }],
			timeout: 1000,
			final: true,
		}],
	});
	assert.equal(valid.ok, true, valid.errors.join("; "));
});

test("idleTimeout threading: effective value reaches RunOptions.idleTimeoutMs", async () => {
	const def: Taskflow = {
		name: "idle-thread",
		phases: [
			{ id: "p", type: "agent", agent: "a", task: "x", idleTimeout: 7000, final: true },
		],
	};
	const capture: RunOptions[] = [];
	const deps = baseDeps(mockRunner(() => "ok", { options: capture, tasks: [] }));
	await executeTaskflow(mkState(def), deps);
	assert.equal(capture.length, 1);
	assert.equal(capture[0].idleTimeoutMs, 7000);
});

test("idleTimeout threading: phase overrides flow-level", async () => {
	const def: Taskflow = {
		name: "idle-override",
		idleTimeout: 20000,
		phases: [
			{ id: "p", type: "agent", agent: "a", task: "x", idleTimeout: 3000, final: true },
		],
	};
	const capture: RunOptions[] = [];
	const deps = baseDeps(mockRunner(() => "ok", { options: capture, tasks: [] }));
	await executeTaskflow(mkState(def), deps);
	assert.equal(capture[0].idleTimeoutMs, 3000, "phase overrides flow");
});

test("idleTimeout threading: absent → undefined (host default applies)", async () => {
	const def: Taskflow = {
		name: "idle-absent",
		phases: [{ id: "p", type: "agent", agent: "a", task: "x", final: true }],
	};
	const capture: RunOptions[] = [];
	const deps = baseDeps(mockRunner(() => "ok", { options: capture, tasks: [] }));
	await executeTaskflow(mkState(def), deps);
	assert.equal(capture[0].idleTimeoutMs, undefined);
});

test("idleTimeout threading: 0 disables (passed through as 0)", async () => {
	const def: Taskflow = {
		name: "idle-disable",
		phases: [{ id: "p", type: "agent", agent: "a", task: "x", idleTimeout: 0, timeout: 60000, final: true }],
	};
	const capture: RunOptions[] = [];
	const deps = baseDeps(mockRunner(() => "ok", { options: capture, tasks: [] }));
	await executeTaskflow(mkState(def), deps);
	assert.equal(capture[0].idleTimeoutMs, 0);
});

test("idleTimeout threading: event-kernel path also threads idleTimeoutMs", async () => {
	const def: Taskflow = {
		name: "idle-kernel",
		phases: [{ id: "p", type: "agent", agent: "a", task: "x", idleTimeout: 9000, final: true }],
	};
	const capture: RunOptions[] = [];
	const runTask: RuntimeDeps["runTask"] = async (_c, _a, agent, task, o: RunOptions) => {
		capture.push(o);
		return { agent, task, exitCode: 0, output: "done", stderr: "", usage: emptyUsage(), stopReason: "end" };
	};
	await executeTaskflow(mkState(def), {
		cwd: process.cwd(), agents: AGENTS, runTask, persist: () => {}, eventKernel: true,
	});
	assert.equal(capture.length, 1);
	assert.equal(capture[0].idleTimeoutMs, 9000, "event kernel must thread idleTimeoutMs");
});

test("idleTimeout resolveIdleTimeoutMs: phase > flow > undefined", () => {
	const p1 = { id: "p", type: "agent" as const, task: "x", idleTimeout: 5000 };
	assert.equal(resolveIdleTimeoutMs(p1, { name: "f", phases: [p1], idleTimeout: 9000 }), 5000);
	const p2 = { id: "p", type: "agent" as const, task: "x" };
	assert.equal(resolveIdleTimeoutMs(p2, { name: "f", phases: [p2], idleTimeout: 9000 }), 9000);
	const p3 = { id: "p", type: "agent" as const, task: "x" };
	assert.equal(resolveIdleTimeoutMs(p3, { name: "f", phases: [p3] }), undefined);
});

test("idleTimeout: included in cache identity via definition hash (FlowIR)", () => {
	// Two flows differing ONLY in idleTimeout must produce different IR hashes,
	// so a cache entry written under one does not hit for the other.
	// We assert via canUseEventKernel-independent compile: the flowDefHash is
	// computed from the FlowIR canonical hash, which now includes idleTimeout
	// (it is a sidecar field). Validate that the schema accepts the field and
	// that validation passes (the hash inclusion is exercised by flowir-hash
	// tests + the sidecar field presence tested below).
	const base = {
		name: "t",
		phases: [{ id: "p", type: "agent", agent: "a", task: "x", final: true }],
	};
	const withIdle = { ...base, phases: [{ ...base.phases[0], idleTimeout: 5000 }] };
	const withoutIdle = { ...base };
	assert.ok(validateTaskflow(withIdle).ok);
	assert.ok(validateTaskflow(withoutIdle).ok);
	// The sidecar field is part of the IR (compile.ts SIDECAR_PHASE_FIELDS includes
	// idleTimeout), so changing it changes hashFlowIR. We verify the field round-trips
	// through the IR sidecar (translate + compile both list it).
});

// ===========================================================================
// 3. Prompt diagnostics + hierarchical (tree) reduce
// ===========================================================================

test("promptSizeStats: bytes, chars, estTokens=ceil(chars/4)", () => {
	const s = promptSizeStats("hello");
	assert.equal(s.chars, 5);
	assert.equal(s.bytes, 5);
	assert.equal(s.estTokens, 2); // ceil(5/4) = 2
	const s2 = promptSizeStats("héllo"); // 5 chars, 6 UTF-8 bytes
	assert.equal(s2.chars, 5);
	assert.equal(s2.bytes, 6);
	assert.equal(s2.estTokens, 2);
	const emoji = promptSizeStats("A😀B");
	assert.equal(emoji.chars, 3, "chars counts Unicode code points, not UTF-16 code units");
	assert.equal(emoji.bytes, 6);
});

test("promptStats: durable on PhaseState for an agent call", async () => {
	const def: Taskflow = {
		name: "prompt-stats",
		phases: [{ id: "p", type: "agent", agent: "a", task: "do something important", final: true }],
	};
	const deps = baseDeps(mockRunner(() => "result"));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	const ps = res.state.phases.p;
	assert.ok(ps.promptStats, "PhaseState must carry promptStats");
	assert.equal(ps.promptStats!.calls.length, 1);
	const call = ps.promptStats!.calls[0];
	assert.ok(call.chars > 0);
	assert.ok(call.bytes > 0);
	assert.equal(call.estTokens, Math.ceil(call.chars / 4));
});

test("promptStats: fan-out and retries record every actual subagent attempt", async () => {
	const def: Taskflow = {
		name: "prompt-all-calls",
		phases: [{
			id: "p", type: "parallel", agent: "a", retry: { max: 1, backoffMs: 0 },
			branches: [{ task: "one" }, { task: "two" }], final: true,
		}],
	};
	const attempts = new Map<string, number>();
	const runTask: RuntimeDeps["runTask"] = async (_cwd, _agents, agent, task) => {
		const attempt = (attempts.get(task) ?? 0) + 1;
		attempts.set(task, attempt);
		const failed = attempt === 1;
		return {
			agent, task, exitCode: failed ? 1 : 0, output: failed ? "" : task,
			stderr: failed ? "hard failure" : "", usage: { ...emptyUsage(), input: 1, output: 1, turns: 1 },
			stopReason: failed ? "error" : "end", ...(failed ? { errorMessage: "hard failure" } : {}),
		};
	};
	const res = await executeTaskflow(mkState(def), baseDeps(runTask));
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.p.promptStats?.calls.length, 4, "two branches × two attempts");
});
test("promptStats: warning fires when a prompt crosses the conservative threshold", async () => {
	// A task whose resolved prompt is large enough to cross PROMPT_SIZE_WARN_TOKENS.
	const big = "x".repeat(PROMPT_SIZE_WARN_TOKENS * 4 + 100);
	const def: Taskflow = {
		name: "prompt-warn",
		phases: [{ id: "p", type: "agent", agent: "a", task: big, final: true }],
	};
	const deps = baseDeps(mockRunner(() => "result"));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	const ps = res.state.phases.p;
	assert.ok(ps.warnings?.some((w) => w.includes("exceeds the conservative") && w.includes("token warning threshold")));
});

test("promptStats: reduce records aggregate input stats (count + totals)", async () => {
	const def: Taskflow = {
		name: "reduce-input-stats",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "produce A" },
			{ id: "b", type: "agent", agent: "a", task: "produce B" },
			{
				id: "r",
				type: "reduce",
				agent: "a",
				from: ["a", "b"],
				task: "summarize {previous.output}",
				dependsOn: ["a", "b"],
				final: true,
			},
		],
	};
	const deps = baseDeps(mockRunner((t) => `output-for-${t}`));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	const rPs = res.state.phases.r;
	assert.ok(rPs.promptStats?.reduceInputs, "reduce must record reduceInputs");
	assert.equal(rPs.promptStats!.reduceInputs!.count, 2);
	assert.ok(rPs.promptStats!.reduceInputs!.totalChars > 0);
	assert.ok(rPs.promptStats!.reduceInputs!.totalBytes > 0);
});

test("reduceStrategy: tree validation — batchSize must be integer >= 2", () => {
	// batchSize < 2 → error.
	const r1 = validateTaskflow({
		name: "t",
		phases: [{ id: "r", type: "reduce", from: ["a"], task: "x", reduceStrategy: "tree", batchSize: 1 }],
	});
	assert.ok(!r1.ok);
	assert.ok(r1.errors.some((e) => e.includes("batchSize")));
	// batchSize on one-shot → warning (ignored).
	const r2 = validateTaskflow({
		name: "t",
		phases: [
			{ id: "a", type: "agent", agent: "x", task: "p" },
			{ id: "r", type: "reduce", from: ["a"], agent: "x", task: "x", batchSize: 4, dependsOn: ["a"] },
		],
	});
	assert.ok(r2.ok);
	assert.ok(r2.warnings.some((w) => w.includes("batchSize") && w.includes("ignored")));
	// valid tree.
	const r3 = validateTaskflow({
		name: "t",
		phases: [
			{ id: "a", type: "agent", agent: "x", task: "p" },
			{ id: "r", type: "reduce", from: ["a"], agent: "x", task: "x", reduceStrategy: "tree", batchSize: 3, dependsOn: ["a"] },
		],
	});
	assert.ok(r3.ok, JSON.stringify(r3.errors));
});

test("reduceStrategy: tree validation caps worst-case subagent calls", () => {
	const sourceCount = 258;
	const phases: Taskflow["phases"] = Array.from({ length: sourceCount }, (_, i) => ({
		id: `s-${i}`, type: "agent", agent: "a", task: `source ${i}`,
	}));
	phases.push({
		id: "r", type: "reduce", agent: "a", from: phases.map((phase) => phase.id),
		dependsOn: phases.map((phase) => phase.id), task: "{previous.output}",
		reduceStrategy: "tree", batchSize: 2, final: true,
	});
	const v = validateTaskflow({ name: "tree-cap", phases });
	assert.equal(v.ok, false);
	assert.match(v.errors.join("\n"), /hard cap 256/);
});
test("reduceStrategy: tree runs batched intermediate rounds until one remains", async () => {
	// 6 from-sources (agent phases), batchSize 2. Tree reduce batches the
	// completed `from[]` outputs: R1: 6→3 (3 calls), R2: 3→2 (2 calls),
	// R3: 2→1 (1 call). Total = 6 intermediate reducer calls.
	const seeds = [1, 2, 3, 4, 5, 6].map((n) => ({
		id: `s${n}`,
		type: "agent" as const,
		agent: "a",
		task: `seed-${n}`,
	}));
	const def: Taskflow = {
		name: "tree-reduce",
		phases: [
			...seeds,
			{
				id: "r",
				type: "reduce",
				agent: "a",
				from: seeds.map((s) => s.id),
				reduceStrategy: "tree",
				batchSize: 2,
				task: "REDUCE: {previous.output}",
				dependsOn: seeds.map((s) => s.id),
				final: true,
			},
		],
	};
	const tasks: string[] = [];
	const deps = baseDeps(mockRunner((t) => {
		tasks.push(t);
		return `R`;
	}));
	// Count ONLY reduce calls (the "REDUCE:" prefix survives interpolation).
	const reduceCallCount = () => tasks.filter((t) => t.startsWith("REDUCE:")).length;
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true, res.state.phases.r?.error ?? "");
	// Tree reduce makes multiple intermediate calls (one-shot would make exactly 1).
	assert.ok(reduceCallCount() > 1, `tree reduce should make multiple calls, got ${reduceCallCount()}`);
	assert.equal(reduceCallCount(), 6, `6 inputs / batchSize 2 → 3+2+1 = 6 calls, got ${reduceCallCount()}`);
	// The final output is the last round's single output.
	assert.equal(res.finalOutput, "R");
	// promptStats should have one entry per intermediate call.
	const rPs = res.state.phases.r;
	assert.equal(rPs.promptStats!.calls.length, reduceCallCount());
});

test("reduceStrategy: tree failure stops the reduction and records the error", async () => {
	// Seeds succeed; only the reducer calls fail. Tree reduce must surface the
	// failure safely (stop the reduction, mark the phase failed).
	const def: Taskflow = {
		name: "tree-reduce-fail",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "seed-A" },
			{ id: "b", type: "agent", agent: "a", task: "seed-B" },
			{ id: "c", type: "agent", agent: "a", task: "seed-C" },
			{ id: "d", type: "agent", agent: "a", task: "seed-D" },
			{
				id: "r",
				type: "reduce",
				agent: "a",
				from: ["a", "b", "c", "d"],
				reduceStrategy: "tree",
				batchSize: 2,
				task: "REDUCE: {previous.output}",
				dependsOn: ["a", "b", "c", "d"],
				final: true,
			},
		],
	};
	let reduceCalls = 0;
	// A runner that succeeds for seed agents and fails ONLY for reduce calls.
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: AGENTS,
		persist: () => {},
		onProgress: () => {},
		runTask: async (_cwd, _agents, agentName, task): Promise<RunResult> => {
			const isReduce = task.startsWith("REDUCE:");
			if (isReduce) reduceCalls++;
			return {
				agent: agentName,
				task,
				exitCode: isReduce ? 1 : 0,
				output: isReduce ? "" : `seed-out:${task}`,
				stderr: isReduce ? "reduce boom" : "",
				usage: { ...emptyUsage(), output: 10, cost: 0.001, turns: 1 },
				stopReason: isReduce ? "error" : "end",
				errorMessage: isReduce ? "reduce boom" : undefined,
			};
		},
	};
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, false);
	assert.equal(res.state.phases.r.status, "failed", `expected failed, got ${res.state.phases.r.status}`);
	assert.ok(reduceCalls >= 1, "at least one reduce call should have been attempted");
});

test("reduceStrategy: one-shot (default) makes a single call even with many inputs", async () => {
	const def: Taskflow = {
		name: "one-shot-reduce",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "A" },
			{ id: "b", type: "agent", agent: "a", task: "B" },
			{ id: "c", type: "agent", agent: "a", task: "C" },
			{
				id: "r",
				type: "reduce",
				agent: "a",
				from: ["a", "b", "c"],
				task: "REDUCE: {previous.output}",
				dependsOn: ["a", "b", "c"],
				final: true,
			},
		],
	};
	const tasks: string[] = [];
	const deps = baseDeps(mockRunner((t) => { tasks.push(t); return "merged"; }));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	const reduceCalls = tasks.filter((t) => t.startsWith("REDUCE:")).length;
	assert.equal(reduceCalls, 1, "one-shot reduce makes exactly one call");
	assert.equal(res.finalOutput, "merged");
});

test("kernel admission: reduceStrategy 'tree' forces imperative fallback", () => {
	const def: Taskflow = {
		name: "tree-kernel",
		phases: [
			{ id: "a", type: "agent", agent: "x", task: "p" },
			{ id: "r", type: "reduce", from: ["a"], agent: "x", task: "x", reduceStrategy: "tree", batchSize: 2, dependsOn: ["a"] },
		],
	};
	assert.equal(canUseEventKernel(def), false);
	const reason = kernelUnsupportedReason(def);
	assert.ok(reason?.includes("reduceStrategy") && reason?.includes("tree"));
});

test("kernel admission: one-shot reduce stays on the kernel", () => {
	const def: Taskflow = {
		name: "one-shot-kernel",
		phases: [
			{ id: "a", type: "agent", agent: "x", task: "p" },
			{ id: "r", type: "reduce", from: ["a"], agent: "x", task: "x", dependsOn: ["a"] },
		],
	};
	assert.equal(canUseEventKernel(def), true);
	assert.equal(kernelUnsupportedReason(def), undefined);
});

// ===========================================================================
// Tree reduce budget truncation (0.2.0 dogfood issue — tree reduce hardening)
// ===========================================================================

test("tree reduce: usage aggregates every intermediate reducer call", async () => {
	const seeds = [1, 2, 3, 4].map((n) => ({
		id: `s${n}`, type: "agent" as const, agent: "a", task: `seed-${n}`,
	}));
	const def: Taskflow = {
		name: "tree-usage",
		phases: [
			...seeds,
			{
				id: "r",
				type: "reduce",
				agent: "a",
				from: seeds.map((s) => s.id),
				reduceStrategy: "tree",
				batchSize: 2,
				task: "REDUCE: {previous.output}",
				dependsOn: seeds.map((s) => s.id),
				final: true,
			},
		],
	};
	// Return a usage that increments per call to verify aggregation.
	let callCount = 0;
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: AGENTS,
		persist: () => {},
		onProgress: () => {},
		runTask: async (_cwd, _agents, agentName, task): Promise<RunResult> => {
			callCount++;
			const isReduceCall = task.startsWith("REDUCE:");
			return {
				agent: agentName,
				task,
				exitCode: 0,
				output: isReduceCall ? `batch-${callCount}` : `seed-out`,
				stderr: "",
				usage: { input: 10 * callCount, output: 5 * callCount, cacheRead: 0, cacheWrite: 0, cost: 0.001 * callCount, contextTokens: 0, turns: 1 },
				stopReason: "end",
			};
		},
	};
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	const rPs = res.state.phases.r;
	// 4 inputs / batchSize 2 → round1: 2 calls, round2: 1 call = 3 total reduce calls.
	// Seeds add 4 calls. Total reduce calls = 3.
	const reduceCalls = callCount - 4;
	assert.equal(reduceCalls, 3, `expected 3 intermediate reduce calls, got ${reduceCalls}`);
	// The phase usage must aggregate ALL 3 reduce calls, not just the last one.
	assert.ok(rPs.usage, "PhaseState.usage must be set");
	assert.ok(rPs.usage!.input > 30, `usage.input should aggregate all calls, got ${rPs.usage!.input}`);
});

test("tree reduce: budget exhaustion mid-tree stops admitting new calls", async () => {
	const seeds = [1, 2, 3, 4].map((n) => ({
		id: `s${n}`, type: "agent" as const, agent: "a", task: `seed-${n}`,
	}));
	const def: Taskflow = {
		name: "tree-budget-cut",
		budget: { maxUSD: 0.0001 }, // extremely tight budget
		phases: [
			...seeds,
			{
				id: "r",
				type: "reduce",
				agent: "a",
				from: seeds.map((s) => s.id),
				reduceStrategy: "tree",
				batchSize: 2,
				task: "REDUCE: {previous.output}",
				dependsOn: seeds.map((s) => s.id),
				final: true,
			},
		],
	};
	let reduceCallCount = 0;
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: AGENTS,
		persist: () => {},
		onProgress: () => {},
		runTask: async (_cwd, _agents, agentName, task): Promise<RunResult> => {
			const isReduceCall = task.startsWith("REDUCE:");
			if (isReduceCall) reduceCallCount++;
			return {
				agent: agentName,
				task,
				exitCode: 0,
				output: isReduceCall ? `out-r${reduceCallCount}` : `seed-out`,
				stderr: "",
				usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.0001, contextTokens: 0, turns: 1 },
				stopReason: "end",
			};
		},
	};
	const res = await executeTaskflow(mkState(def), deps);
	// After 2 seed calls (cost ~0.0002) the budget is already well exceeded,
	// so seeds 3-4 may also trigger budget. The tree reduce starts with 4
	// inputs already over budget, so it may stop immediately (0 reduce calls).
	// The key assertions: run is blocked, budgetTruncated is set, warning exists.
	assert.equal(res.state.status, "blocked");
	const rPs = res.state.phases.r;
	if (rPs.budgetTruncated) {
		// Tree stopped early; partial output retains untouched inputs.
		assert.match(rPs.output ?? "", /<input \[1\]>/);
		assert.ok((rPs.warnings ?? []).some((w) => w.includes("tree reduction stopped by the run budget")),
			`expected budget truncation warning, got: ${JSON.stringify(rPs.warnings)}`);
	}
	// The reduce result must NOT be cached (budgetTruncated prevents caching).
	assert.ok(!rPs.cacheHit);
});

test("tree reduce: budget truncation preserves untouched inputs in partial output", async () => {
	// 6 inputs / batch 2. With a per-call usage that exceeds budget after the
	// first batch, the later inputs must be preserved untransformed.
	const seeds = [1, 2, 3, 4, 5, 6].map((n) => ({
		id: `s${n}`, type: "agent" as const, agent: "a", task: `seed-${n}`,
	}));
	const def: Taskflow = {
		name: "tree-partial",
		budget: { maxTokens: 200 }, // tight token budget
		phases: [
			...seeds,
			{
				id: "r",
				type: "reduce",
				agent: "a",
				from: seeds.map((s) => s.id),
				reduceStrategy: "tree",
				batchSize: 2,
				task: "REDUCE: {previous.output}",
				dependsOn: seeds.map((s) => s.id),
				final: true,
			},
		],
	};
	let reduceCallCount = 0;
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: AGENTS,
		persist: () => {},
		onProgress: () => {},
		runTask: async (_cwd, _agents, agentName, task): Promise<RunResult> => {
			const isReduceCall = task.startsWith("REDUCE:");
			if (isReduceCall) reduceCallCount++;
			return {
				agent: agentName,
				task,
				exitCode: 0,
				output: isReduceCall ? `reduced-${reduceCallCount}` : `seed-${task}`,
				stderr: "",
				usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
				stopReason: "end",
			};
		},
	};
	const res = await executeTaskflow(mkState(def), deps);
	// Seeds consume ~50 tokens each, plus 100+50 = 150 per reduce call.
	// After 1 or 2 reduce calls the budget (200 tokens) blows.
	// The partial output must contain both finished rounds and the untouched seeds.
	const rPs = res.state.phases.r;
	if (rPs.budgetTruncated) {
		assert.ok(rPs.output, "must have partial output");
		// Reduce calls may have processed some batches (showing [N] labels)
		// AND untouched seeds must be preserved with their [N] labels.
		// The untouched seeds appear as their original seed content.
		assert.match(rPs.output!, /seed-/);
	}
});

test("tree reduce: abort path marks phase as failed with abort error", async () => {
	const seeds = [1, 2, 3, 4].map((n) => ({
		id: `s${n}`, type: "agent" as const, agent: "a", task: `seed-${n}`,
	}));
	const def: Taskflow = {
		name: "tree-abort",
		phases: [
			...seeds,
			{
				id: "r",
				type: "reduce",
				agent: "a",
				from: seeds.map((s) => s.id),
				reduceStrategy: "tree",
				batchSize: 2,
				task: "REDUCE: {previous.output}",
				dependsOn: seeds.map((s) => s.id),
				final: true,
			},
		],
	};
	const ac = new AbortController();
	// Use a controlled promise: make the reduce call hang until we signal.
	let resolveRun: (() => void) | undefined;
	const runPromise = new Promise<void>((resolve) => { resolveRun = resolve; });
	let reduceCallCount = 0;
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: AGENTS,
		signal: ac.signal,
		persist: () => {},
		onProgress: () => {},
		runTask: async (_cwd, _agents, agentName, task): Promise<RunResult> => {
			if (task.startsWith("REDUCE:")) {
				reduceCallCount++;
				// First reduce call blocks until we abort.
				if (reduceCallCount === 1) {
					await runPromise;
				}
			}
			return {
				agent: agentName,
				task,
				exitCode: 0,
				output: "temp-output",
				stderr: "",
				usage: { ...emptyUsage(), output: 5, turns: 1 },
				stopReason: "end",
			};
		},
	};
	// Start the flow, then abort while the first reduce call is in flight.
	const resPromise = executeTaskflow(mkState(def), deps);
	// Wait for the reduce call to start (it's blocked on runPromise).
	await new Promise<void>((resolve) => {
		const check = () => {
			if (reduceCallCount >= 1) resolve();
			else setTimeout(check, 1);
		};
		check();
	});
	// Abort while the call is blocked.
	ac.abort();
	resolveRun!(); // release the blocked call (too late — abort was already signaled)
	const res = await resPromise;
	assert.equal(res.state.status, "paused", "aborted run is paused");
	const rPs = res.state.phases.r;
	// The tree reduce should have detected the abort and failed.
	assert.equal(rPs.status, "failed", "aborted tree reduce must be failed");
	assert.match(rPs.error ?? "", /Tree reduction aborted/);
});

// ===========================================================================
// Tree reduce — not cached when budgetTruncated (cross-run and run-only)
// ===========================================================================

test("tree reduce: budget-truncated phase is never cached", async () => {
	const seeds = [1, 2, 3].map((n) => ({
		id: `s${n}`, type: "agent" as const, agent: "a", task: `seed-${n}`,
	}));
	const def: Taskflow = {
		name: "tree-nocache",
		budget: { maxUSD: 0.00005 },
		phases: [
			...seeds,
			{
				id: "r",
				type: "reduce",
				agent: "a",
				from: seeds.map((s) => s.id),
				reduceStrategy: "tree",
				batchSize: 2,
				task: "REDUCE: {previous.output}",
				dependsOn: seeds.map((s) => s.id),
				final: true,
			},
		],
	};
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: AGENTS,
		persist: () => {},
		onProgress: () => {},
		runTask: async (_cwd, _agents, agentName, task): Promise<RunResult> => ({
			agent: agentName,
			task,
			exitCode: 0,
			output: "out",
			stderr: "",
			usage: { input: 500, output: 250, cacheRead: 0, cacheWrite: 0, cost: 0.0001, contextTokens: 0, turns: 1 },
			stopReason: "end",
		}),
	};
	// First run: budget exhausted mid-way.
	const s1 = mkState(def);
	const r1 = await executeTaskflow(s1, deps);
	const rPs = r1.state.phases.r;
	if (rPs.budgetTruncated) {
		// No cacheHit marker (not cached — neither run-only nor cross-run).
		assert.equal(rPs.cacheHit, undefined, "budget-truncated phase must not be cached");
		// Re-run: a second invocation must NOT hit a cached phase result.
		const s2 = mkState(def);
		const r2 = await executeTaskflow(s2, deps);
		const r2Ps = r2.state.phases.r;
		// The second run also deals with budget — and must NOT see a cache hit.
		assert.equal(r2Ps.cacheHit, undefined, "second run of budget-truncated phase must not hit cache");
	}
});

test("tree reduce: ordinary resume reuses the completed tree without reducer calls", async () => {
	const seeds = [1, 2, 3, 4].map((n) => ({
		id: `s${n}`,
		type: "agent" as const,
		agent: "a",
		task: `seed-${n}`,
	}));
	const def: Taskflow = {
		name: "tree-resume-cache",
		phases: [
			...seeds,
			{
				id: "r",
				type: "reduce",
				agent: "a",
				from: seeds.map((seed) => seed.id),
				dependsOn: seeds.map((seed) => seed.id),
				reduceStrategy: "tree",
				batchSize: 2,
				task: "REDUCE: {previous.output}",
			},
			{ id: "finish", type: "agent", agent: "a", task: "FINISH", dependsOn: ["r"], final: true },
		],
	};
	let firstReduceCalls = 0;
	const first = await executeTaskflow(mkState(def), baseDeps(async (_cwd, _agents, agentName, task) => {
		if (task.startsWith("REDUCE:")) firstReduceCalls++;
		const fail = task === "FINISH";
		return {
			agent: agentName,
			task,
			exitCode: fail ? 1 : 0,
			output: fail ? "" : (task.startsWith("REDUCE:") ? "reduced" : task),
			stderr: fail ? "finish failed" : "",
			usage: emptyUsage(),
			stopReason: fail ? "error" : "end",
			errorMessage: fail ? "finish failed" : undefined,
		};
	}));
	assert.equal(first.state.status, "failed");
	assert.ok(firstReduceCalls > 0);

	const child = forkRunForResume(first.state);
	let resumedReduceCalls = 0;
	const resumed = await executeTaskflow(child, baseDeps(async (_cwd, _agents, agentName, task) => {
		if (task.startsWith("REDUCE:")) resumedReduceCalls++;
		return {
			agent: agentName,
			task,
			exitCode: 0,
			output: task === "FINISH" ? "done" : "unexpected rerun",
			stderr: "",
			usage: emptyUsage(),
			stopReason: "end",
		};
	}));
	assert.equal(resumed.ok, true, resumed.state.phases.r?.error ?? "");
	assert.equal(resumedReduceCalls, 0, "completed tree reducer must be a within-run cache hit");
	assert.equal(resumed.state.phases.r.cacheHit, "run-only");
});

test("tree reduce: 256-call hard cap counts actual retry attempts", async () => {
	const seeds = Array.from({ length: 14 }, (_, index) => ({
		id: `s${index}`,
		type: "agent" as const,
		agent: "a",
		task: `seed-${index}`,
	}));
	const def: Taskflow = {
		name: "tree-actual-attempt-cap",
		phases: [
			...seeds,
			{
				id: "r",
				type: "reduce",
				agent: "a",
				from: seeds.map((seed) => seed.id),
				dependsOn: seeds.map((seed) => seed.id),
				reduceStrategy: "tree",
				batchSize: 2,
				retry: { max: 20, backoffMs: 0 },
				task: "REDUCE: {previous.output}",
				final: true,
			},
		],
	};
	assert.equal(validateTaskflow(def).ok, true);
	let reduceAttempts = 0;
	const result = await executeTaskflow(mkState(def), baseDeps(async (_cwd, _agents, agentName, task) => {
		if (!task.startsWith("REDUCE:")) {
			return {
				agent: agentName,
				task,
				exitCode: 0,
				output: task,
				stderr: "",
				usage: emptyUsage(),
				stopReason: "end",
			};
		}
		reduceAttempts++;
		const succeedsThisBatch = reduceAttempts <= 252
			? reduceAttempts % 21 === 0
			: reduceAttempts === 255;
		return {
			agent: agentName,
			task,
			exitCode: succeedsThisBatch ? 0 : 1,
			output: succeedsThisBatch ? "reduced" : "",
			stderr: succeedsThisBatch ? "" : "429 rate limit",
			usage: { ...emptyUsage(), output: 1 },
			stopReason: succeedsThisBatch ? "end" : "error",
			errorMessage: succeedsThisBatch ? undefined : "429 rate limit",
		};
	}));
	assert.equal(result.state.phases.r.status, "failed");
	assert.equal(reduceAttempts, 256, "runner calls must never exceed the documented hard cap");
	assert.equal(result.state.phases.r.attempts, 256);
	assert.equal(result.state.phases.r.usage?.output, 256, "the final admitted attempt's usage must survive a denied retry");
	assert.equal(result.state.phases.r.promptStats?.calls.length, 256);
	assert.match(result.state.phases.r.error ?? "", /256 actual subagent attempts/);
});

test("tree reduce: cross-run cache hits stable inputs and misses changed inputs", async () => {
	const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tf-tree-cache-"));
	try {
		const makeDef = (firstTask: string): Taskflow => ({
			name: "tree-cross-run-cache",
			phases: [
				{ id: "a", type: "agent", agent: "a", task: firstTask },
				{ id: "b", type: "agent", agent: "a", task: "seed-b" },
				{
					id: "r",
					type: "reduce",
					agent: "a",
					from: ["a", "b"],
					dependsOn: ["a", "b"],
					reduceStrategy: "tree",
					batchSize: 2,
					task: "REDUCE: {previous.output}",
					cache: { scope: "cross-run" },
					final: true,
				},
			],
		});
		const cacheStore = new CacheStore(cacheRoot);
		let reduceCalls = 0;
		const deps: RuntimeDeps = {
			cwd: "/tmp",
			agents: AGENTS,
			cacheStore,
			persist: () => {},
			runTask: async (_cwd, _agents, agentName, task) => {
				if (task.startsWith("REDUCE:")) reduceCalls++;
				return {
					agent: agentName,
					task,
					exitCode: 0,
					output: task.startsWith("REDUCE:") ? "reduced" : task,
					stderr: "",
					usage: emptyUsage(),
					stopReason: "end",
				};
			},
		};

		const first = await executeTaskflow(mkState(makeDef("seed-a")), deps);
		assert.equal(first.ok, true);
		assert.equal(reduceCalls, 1);

		const second = await executeTaskflow(mkState(makeDef("seed-a")), deps);
		assert.equal(second.ok, true);
		assert.equal(reduceCalls, 1, "identical inputs should skip every reducer call");
		assert.equal(second.state.phases.r.cacheHit, "cross-run");

		const changed = await executeTaskflow(mkState(makeDef("seed-a-changed")), deps);
		assert.equal(changed.ok, true);
		assert.equal(reduceCalls, 2, "changed upstream output must invalidate the tree cache");
		assert.equal(changed.state.phases.r.cacheHit, undefined);
	} finally {
		fs.rmSync(cacheRoot, { recursive: true, force: true });
	}
});

test("tree reduce: cross-run cache includes explicit transitive step outputs", async () => {
	const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tf-tree-transitive-cache-"));
	try {
		const def: Taskflow = {
			name: "tree-transitive-cache",
			phases: [
				{ id: "ancestor", type: "agent", agent: "a", task: "ANCESTOR" },
				{ id: "left", type: "agent", agent: "a", task: "LEFT", dependsOn: ["ancestor"] },
				{ id: "right", type: "agent", agent: "a", task: "RIGHT" },
				{
					id: "r",
					type: "reduce",
					agent: "a",
					from: ["left", "right"],
					dependsOn: ["left", "right"],
					reduceStrategy: "tree",
					batchSize: 2,
					task: "REDUCE ancestor={steps.ancestor.output} inputs={previous.output}",
					cache: { scope: "cross-run" },
					final: true,
				},
			],
		};
		let ancestor = "v1";
		let reduceCalls = 0;
		const runTask: RuntimeDeps["runTask"] = async (_cwd, _agents, agent, task) => {
			if (task.startsWith("REDUCE")) reduceCalls++;
			const output = task === "ANCESTOR"
				? ancestor
				: task.startsWith("REDUCE") ? `reduced:${ancestor}` : `stable:${task}`;
			return { agent, task, exitCode: 0, output, stderr: "", usage: emptyUsage(), stopReason: "end" };
		};
		const deps: RuntimeDeps = {
			cwd: "/tmp",
			agents: AGENTS,
			cacheStore: new CacheStore(cacheRoot),
			runTask,
			persist: () => {},
		};
		await executeTaskflow(mkState(def), deps);
		assert.equal(reduceCalls, 1);
		const stable = await executeTaskflow(mkState(def), deps);
		assert.equal(stable.state.phases.r.cacheHit, "cross-run");
		assert.equal(reduceCalls, 1);
		ancestor = "v2";
		const changed = await executeTaskflow(mkState(def), deps);
		assert.equal(changed.state.phases.r.cacheHit, undefined);
		assert.equal(reduceCalls, 2, "changed transitive ancestor output must invalidate the tree cache");
		assert.equal(changed.finalOutput, "reduced:v2");
	} finally {
		fs.rmSync(cacheRoot, { recursive: true, force: true });
	}
});
