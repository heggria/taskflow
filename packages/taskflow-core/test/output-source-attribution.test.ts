/**
 * Output source attribution — 0.2.0 dogfood issue 6.
 *
 * `RuntimeResult.outputSourcePhaseId` / `EventKernelResult.outputSourcePhaseId`
 * identify the PhaseState whose output supplied `finalOutput`. The source is
 * the ACTUAL fallback phase that produced the output — never the designated
 * skipped/failed final phase. Parity between the imperative runtime and the
 * event kernel is asserted via the shared `resolveFinalOutput` helper.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { emptyUsage } from "../src/usage.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { resolveFinalOutput } from "../src/final-output.ts";
import { canUseEventKernel } from "../src/exec/driver.ts";
import { runEventKernel } from "../src/exec/driver.ts";
import { finalPhase, type Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test agent", systemPrompt: "", source: "user", filePath: "" },
];

function mkState(def: Taskflow, args: Record<string, unknown> = {}): RunState {
	return {
		runId: "src-test",
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

function mockRunner(respond: (task: string) => string, opts?: { fail?: (task: string) => boolean }): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task, _o: RunOptions): Promise<RunResult> => {
		const failed = opts?.fail?.(task) ?? false;
		return {
			agent: agentName,
			task,
			exitCode: failed ? 1 : 0,
			output: failed ? "" : respond(task),
			stderr: failed ? "boom" : "",
			usage: { ...emptyUsage(), output: 5, turns: 1 },
			stopReason: failed ? "error" : "end",
			errorMessage: failed ? "boom" : undefined,
		};
	};
}

function deps(runTask: RuntimeDeps["runTask"]): RuntimeDeps {
	return { cwd: "/tmp", agents: AGENTS, runTask, persist: () => {}, onProgress: () => {} };
}

// ---------------------------------------------------------------------------
// resolveFinalOutput (pure helper)
// ---------------------------------------------------------------------------

test("resolveFinalOutput: normal case attributes to the final phase", () => {
	const def: Taskflow = {
		name: "n",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "do" },
			{ id: "b", type: "agent", agent: "a", task: "end", final: true },
		],
	};
	const state: RunState = { ...mkState(def), phases: {
		a: { id: "a", status: "done", output: "OUT-A" },
		b: { id: "b", status: "done", output: "OUT-B" },
	} };
	const r = resolveFinalOutput(def.phases, state, { gate: false, gateReason: "", gateOutput: "", gatePhaseId: undefined, budget: false, budgetReason: "" });
	assert.equal(r.finalOutput, "OUT-B");
	assert.equal(r.outputSourcePhaseId, "b");
});

test("resolveFinalOutput: skipped final falls back to last done phase", () => {
	const def: Taskflow = {
		name: "n",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "first" },
			{ id: "b", type: "agent", agent: "a", task: "second", final: true, dependsOn: ["a"] },
		],
	};
	// Final phase `b` was skipped; `a` completed.
	const state: RunState = { ...mkState(def), phases: {
		a: { id: "a", status: "done", output: "OUT-A" },
		b: { id: "b", status: "skipped", error: "upstream" },
	} };
	const r = resolveFinalOutput(def.phases, state, { gate: false, gateReason: "", gateOutput: "", gatePhaseId: undefined, budget: false, budgetReason: "" });
	assert.equal(r.finalOutput, "OUT-A");
	assert.equal(r.outputSourcePhaseId, "a");
});

test("resolveFinalOutput: no completed phase → (no output) + undefined source", () => {
	const def: Taskflow = { name: "n", phases: [{ id: "a", type: "agent", agent: "a", task: "x", final: true }] };
	const state: RunState = { ...mkState(def), phases: {
		a: { id: "a", status: "failed", error: "boom" },
	} };
	const r = resolveFinalOutput(def.phases, state, { gate: false, gateReason: "", gateOutput: "", gatePhaseId: undefined, budget: false, budgetReason: "" });
	assert.equal(r.finalOutput, "(no output)");
	assert.equal(r.outputSourcePhaseId, undefined);
});

test("resolveFinalOutput: budget blocked attributes to the fallback phase whose output is included", () => {
	const def: Taskflow = {
		name: "n",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "first" },
			{ id: "b", type: "agent", agent: "a", task: "second", final: true, dependsOn: ["a"] },
		],
	};
	const state: RunState = { ...mkState(def), phases: {
		a: { id: "a", status: "done", output: "PARTIAL-A" },
		b: { id: "b", status: "skipped", error: "Budget exceeded" },
	} };
	const r = resolveFinalOutput(def.phases, state, { gate: false, gateReason: "", gateOutput: "", gatePhaseId: undefined, budget: true, budgetReason: "cap hit" });
	assert.match(r.finalOutput, /Budget exceeded — run halted./);
	assert.match(r.finalOutput, /PARTIAL-A/);
	assert.equal(r.outputSourcePhaseId, "a");
});

test("resolveFinalOutput: budget blocked with no partial output → undefined source", () => {
	const def: Taskflow = { name: "n", phases: [{ id: "a", type: "agent", agent: "a", task: "x", final: true }] };
	const state: RunState = { ...mkState(def), phases: {
		a: { id: "a", status: "skipped", error: "Budget exceeded" },
	} };
	const r = resolveFinalOutput(def.phases, state, { gate: false, gateReason: "", gateOutput: "", gatePhaseId: undefined, budget: true, budgetReason: "cap hit" });
	assert.match(r.finalOutput, /Budget exceeded — run halted./);
	assert.equal(r.outputSourcePhaseId, undefined);
});

test("resolveFinalOutput: gate blocked attributes to the blocking gate phase", () => {
	const def: Taskflow = {
		name: "n",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "first" },
			{ id: "g", type: "gate", agent: "a", task: "decide", final: true, dependsOn: ["a"] },
		],
	};
	const state: RunState = { ...mkState(def), phases: {
		a: { id: "a", status: "done", output: "OUT-A" },
		g: { id: "g", status: "done", output: "GATE-BLOCKED-REASON", gate: { verdict: "block", reason: "nope" } },
	} };
	const r = resolveFinalOutput(def.phases, state, { gate: true, gateReason: "nope", gateOutput: "GATE-BLOCKED-REASON", gatePhaseId: "g", budget: false, budgetReason: "" });
	assert.match(r.finalOutput, /Gate blocked the workflow./);
	assert.match(r.finalOutput, /GATE-BLOCKED-REASON/);
	assert.equal(r.outputSourcePhaseId, "g");
});

test("resolveFinalOutput: gate blocked with no gate output → undefined source", () => {
	const def: Taskflow = {
		name: "n",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "first" },
			{ id: "g", type: "gate", agent: "a", task: "decide", final: true, dependsOn: ["a"] },
		],
	};
	const state: RunState = { ...mkState(def), phases: {
		a: { id: "a", status: "done", output: "OUT-A" },
		g: { id: "g", status: "done", output: "", gate: { verdict: "block", reason: "nope" } },
	} };
	const r = resolveFinalOutput(def.phases, state, { gate: true, gateReason: "nope", gateOutput: "", gatePhaseId: "g", budget: false, budgetReason: "" });
	assert.match(r.finalOutput, /Gate blocked the workflow./);
	assert.equal(r.outputSourcePhaseId, undefined);
});

// ---------------------------------------------------------------------------
// executeTaskflow (imperative) — outputSourcePhaseId end-to-end
// ---------------------------------------------------------------------------

test("e2e: successful run attributes source to the final phase", async () => {
	const def: Taskflow = {
		name: "ok",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "first" },
			{ id: "b", type: "agent", agent: "a", task: "final", final: true, dependsOn: ["a"] },
		],
	};
	const res = await executeTaskflow(mkState(def), deps(mockRunner((t) => `OUT:${t}`)));
	assert.equal(res.ok, true);
	assert.equal(res.finalOutput, "OUT:final");
	assert.equal(res.outputSourcePhaseId, "b");
});

test("e2e: failed final phase attributes to the fallback done phase", async () => {
	const def: Taskflow = {
		name: "fail",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "first" },
			{ id: "b", type: "agent", agent: "a", task: "final", final: true, dependsOn: ["a"] },
		],
	};
	// `b` fails; `a` completed. The run fails (non-optional). Source = `a`.
	const res = await executeTaskflow(mkState(def), deps(mockRunner((t) => `OUT:${t}`, { fail: (t) => t === "final" })));
	assert.equal(res.ok, false);
	assert.equal(res.outputSourcePhaseId, "a");
	assert.match(res.finalOutput, /OUT:first/);
});

test("e2e: skipped final phase attributes to the last completed phase", async () => {
	// `b` is final and depends on `a`. `a` fails (non-optional) → `b` is skipped
	// (upstream not satisfied). No phase completed → no output, undefined source.
	const def: Taskflow = {
		name: "skip",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "first" },
			{ id: "b", type: "agent", agent: "a", task: "final", final: true, dependsOn: ["a"] },
		],
	};
	const res = await executeTaskflow(mkState(def), deps(mockRunner(() => "x", { fail: () => true })));
	assert.equal(res.ok, false);
	assert.equal(res.outputSourcePhaseId, undefined);
	assert.equal(res.finalOutput, "(no output)");
});

// ---------------------------------------------------------------------------
// Event-kernel parity: the kernel path must report the same source id as the
// imperative path. canUseEventKernel admits simple agent chains.
// ---------------------------------------------------------------------------

async function runKernel(def: Taskflow): Promise<{ finalOutput: string; outputSourcePhaseId: string | undefined; ok: boolean }> {
	const state = mkState(def);
	if (!canUseEventKernel(def)) throw new Error("def not kernel-eligible");
	const res = await runEventKernel(state, {
		cwd: "/tmp",
		agents: AGENTS,
		runTask: mockRunner((t) => `OUT:${t}`)!,
	});
	return { finalOutput: res.finalOutput, outputSourcePhaseId: res.outputSourcePhaseId, ok: res.ok };
}

test("event-kernel: successful chain attributes source to the final phase", async () => {
	const def: Taskflow = {
		name: "k-ok",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "one" },
			{ id: "b", type: "agent", agent: "a", task: "two", final: true, dependsOn: ["a"] },
		],
	};
	const res = await runKernel(def);
	assert.equal(res.ok, true);
	assert.equal(res.finalOutput, "OUT:two");
	assert.equal(res.outputSourcePhaseId, "b");
});

test("event-kernel: failed run has undefined outputSourcePhaseId", async () => {
	// A single agent phase whose runner FAILS. The phase ends failed (no done
	// phase), so attribution is undefined — never the designated failed final
	// phase. (The no-output DEFAULT is covered by the pure-helper tests above; here
	// we pin the attribution contract on the kernel path.)
	const def: Taskflow = { name: "k-fail", phases: [{ id: "a", type: "agent", agent: "a", task: "x", final: true }] };
	const state = mkState(def);
	const res = await runEventKernel(state, {
		cwd: "/tmp",
		agents: AGENTS,
		runTask: async (_c, _a, n, t) => ({ agent: n, task: t, exitCode: 1, output: "", stderr: "boom", usage: emptyUsage(), stopReason: "error", errorMessage: "boom" }),
	});
	assert.equal(res.ok, false);
	assert.equal(res.outputSourcePhaseId, undefined);
});

test("parity: imperative + event kernel agree on outputSourcePhaseId for a chain", async () => {
	const def: Taskflow = {
		name: "parity-src",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "one" },
			{ id: "b", type: "agent", agent: "a", task: "two", final: true, dependsOn: ["a"] },
		],
	};
	const imp = await executeTaskflow(mkState(def), deps(mockRunner((t) => `OUT:${t}`)));
	const ker = await runKernel(def);
	assert.equal(imp.outputSourcePhaseId, ker.outputSourcePhaseId);
	assert.equal(imp.finalOutput, ker.finalOutput);
});

test("finalPhase() still resolves the designated final phase for the header fallback", () => {
	// When attribution IS available, the source id is used; finalPhase() is the
	// fallback only when outputSourcePhaseId is undefined. Verify finalPhase()
	// itself still returns the marked-final phase.
	const def: Taskflow = { name: "x", phases: [{ id: "a", type: "agent", task: "x" }, { id: "b", type: "agent", task: "y", final: true }] };
	assert.equal(finalPhase(def.phases).id, "b");
});
