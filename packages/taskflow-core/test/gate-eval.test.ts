import assert from "node:assert/strict";
import { test } from "node:test";

import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import type { RunState } from "../src/store.ts";
import type { AgentConfig } from "../src/agents.ts";
import type { RunResult } from "../src/runner-core.ts";
import { emptyUsage } from "../src/usage.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dummyAgent: AgentConfig = { name: "default", model: "test/model", description: "dummy", systemPrompt: "", source: "user", filePath: "none" };

function mkState(def: any, runId: string): RunState {
	return {
		runId,
		flowName: (def as any).name,
		def: def as any,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: "/tmp/test-eval",
	};
}

function mockRunResult(output: string): RunResult {
	return {
		agent: "default",
		task: "",
		exitCode: 0,
		output,
		stderr: "",
		usage: emptyUsage(),
	};
}

// ---------------------------------------------------------------------------
// Eval gates
// ---------------------------------------------------------------------------

test("eval gate: all evals pass → skips LLM gate", async () => {
	const def = {
		name: "eval-test",
		phases: [
			{ id: "prod", type: "agent", task: "produce PASS" },
			{
				id: "check",
				type: "gate",
				task: "should-never-run",
				dependsOn: ["prod"],
				eval: ["{steps.prod.output} contains PASS"],
			},
		],
	};
	const state: RunState = mkState(def, "eval-m1");
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: [dummyAgent],
		runTask: async (_cwd, _agents, _an, task) => {
			if (task.includes("should-never-run")) throw new Error("LLM gate called but eval should have passed");
			return mockRunResult(task);
		},
	};
	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, true);
	assert.equal(state.phases["check"]?.gate?.verdict, "pass");
});

test("eval gate: any eval fails → LLM gate runs", async () => {
	const def = {
		name: "eval-fail",
		phases: [
			{ id: "prod", type: "agent", task: "produce FAIL" },
			{
				id: "check",
				type: "gate",
				task: "is this good?",
				dependsOn: ["prod"],
				eval: ["{steps.prod.output} contains PASS"],
			},
		],
	};
	const state: RunState = mkState(def, "eval-fail-m1");
	let gateCalled = false;
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: [dummyAgent],
		runTask: async (_cwd, _agents, _an, task) => {
			if (task.includes("is this good?")) {
				gateCalled = true;
				return mockRunResult("VERDICT: BLOCK needs work");
			}
			return mockRunResult(task);
		},
	};
	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, false);
	assert.equal(gateCalled, true);
	assert.equal(state.phases["check"]?.gate?.verdict, "block");
});

// ---------------------------------------------------------------------------
// onBlock:retry
// ---------------------------------------------------------------------------

test("onBlock:retry — gate blocks, upstream+gate re-execute once", async () => {
	const calls: string[] = [];
	const def = {
		name: "retry-test",
		phases: [
			{ id: "prod", type: "agent", task: "produce-report" },
			{
				id: "check",
				type: "gate",
				task: "gate-task",
				dependsOn: ["prod"],
				onBlock: "retry" as const,
				retry: { max: 1 },
			},
			{ id: "final", type: "agent", task: "ship", dependsOn: ["check"], final: true },
		],
	};
	const state: RunState = mkState(def, "retry-m1");
	let gateAttempt = 0;
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: [dummyAgent],
		runTask: async (_cwd, _agents, _an, task) => {
			calls.push(task);
			if (task.includes("gate-task")) {
				gateAttempt++;
				return mockRunResult(gateAttempt === 1 ? "VERDICT: BLOCK needs more detail" : "VERDICT: PASS");
			}
			if (task.includes("produce-report")) {
				return mockRunResult(gateAttempt === 0 ? "v1" : "v2 (improved)");
			}
			return mockRunResult(task);
		},
	};
	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, true);
	assert.equal(state.phases["check"]?.gate?.verdict, "pass");
	assert.ok(calls.filter((t) => t.includes("gate-task")).length >= 2, "gate ran at least twice");
});

test("onBlock:retry — max retries exhausted → halts", async () => {
	const def = {
		name: "retry-exhaust",
		phases: [
			{ id: "prod", type: "agent", task: "produce" },
			{
				id: "check",
				type: "gate",
				task: "gate-task",
				dependsOn: ["prod"],
				onBlock: "retry" as const,
				retry: { max: 0 },
			},
		],
	};
	const state: RunState = mkState(def, "retry-exhaust-m1");
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: [dummyAgent],
		runTask: async (_cwd, _agents, _an, task) => {
			if (task.includes("gate-task")) return mockRunResult("VERDICT: BLOCK");
			return mockRunResult(task);
		},
	};
	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, false);
	assert.equal(state.phases["check"]?.gate?.verdict, "block");
});

test("onBlock:retry — default is 'halt' (backward compatible)", async () => {
	const def = {
		name: "halt-default",
		phases: [
			{ id: "prod", type: "agent", task: "produce" },
			{
				id: "check",
				type: "gate",
				task: "gate-task",
				dependsOn: ["prod"],
				// onBlock omitted → defaults to "halt"
			},
		],
	};
	const state: RunState = mkState(def, "halt-default-m1");
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: [dummyAgent],
		runTask: async (_cwd, _agents, _an, task) => {
			if (task.includes("gate-task")) return mockRunResult("VERDICT: BLOCK");
			return mockRunResult(task);
		},
	};
	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// Combined: eval + onBlock:retry
// ---------------------------------------------------------------------------

test("combined: eval passes → gate skipped, retry never triggers", async () => {
	const def = {
		name: "eval-first",
		phases: [
			{ id: "prod", type: "agent", task: "produce PASS" },
			{
				id: "check",
				type: "gate",
				task: "gate-task",
				dependsOn: ["prod"],
				onBlock: "retry" as const,
				retry: { max: 1 },
				eval: ["{steps.prod.output} contains PASS"],
			},
		],
	};
	const state: RunState = mkState(def, "eval-first-m1");
	let llmGateCalled = false;
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: [dummyAgent],
		runTask: async (_cwd, _agents, _an, task) => {
			if (task.includes("gate-task")) {
				llmGateCalled = true;
				return mockRunResult("VERDICT: BLOCK");
			}
			return mockRunResult(task);
		},
	};
	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, true);
	assert.equal(state.phases["check"]?.gate?.verdict, "pass");
	assert.equal(llmGateCalled, false, "LLM gate never called");
});

// ---------------------------------------------------------------------------
// MAX_RETRY_DEPTH: nested gate onBlock:retry chain
// ---------------------------------------------------------------------------

test("onBlock:retry — MAX_RETRY_DEPTH caps nested re-execution at depth 3", async () => {
	// A 4-gate chain: gate3 → gate2 → gate1 → gate0 → base.
	// Each gate has onBlock:retry with max:1.
	// gate3 always returns BLOCK on first call (triggers retry).
	// gate0/1/2 return PASS on first call (main loop), BLOCK on subsequent (retry depth).
	// At _retryDepth = 3, the check `_retryDepth < MAX_RETRY_DEPTH` (3 < 3 = false)
	// blocks re-execution of base, so base runs exactly once.
	// The mutant `<=` would allow depth 3, causing base to run a second time.
	const callSeq: string[] = [];
	const gateCounters: Record<string, number> = { gate0: 0, gate1: 0, gate2: 0 };

	// gate3 blocks on its first call from the main loop.
	// gate0/1/2: first call → PASS, subsequent → BLOCK.
	let gate3Called = false;

	const def = {
		name: "retry-depth",
		phases: [
			{ id: "base", type: "agent", task: "data" },
			{
				id: "gate0",
				type: "gate",
				task: "gate0-task",
				dependsOn: ["base"],
				onBlock: "retry" as const,
				retry: { max: 1 },
			},
			{
				id: "gate1",
				type: "gate",
				task: "gate1-task",
				dependsOn: ["gate0"],
				onBlock: "retry" as const,
				retry: { max: 1 },
			},
			{
				id: "gate2",
				type: "gate",
				task: "gate2-task",
				dependsOn: ["gate1"],
				onBlock: "retry" as const,
				retry: { max: 1 },
			},
			{
				id: "gate3",
				type: "gate",
				task: "gate3-task",
				dependsOn: ["gate2"],
				onBlock: "retry" as const,
				retry: { max: 1 },
				final: true,
			},
		],
	};
	const state: RunState = mkState(def, "retry-depth-m1");
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: [dummyAgent],
		runTask: async (_cwd, _agents, _an, task) => {
			callSeq.push(task);
			if (task.includes("data")) {
				return mockRunResult("data");
			}
			if (task.includes("gate0-task")) {
				gateCounters.gate0++;
				return mockRunResult(gateCounters.gate0 === 1 ? "VERDICT: PASS" : "VERDICT: BLOCK");
			}
			if (task.includes("gate1-task")) {
				gateCounters.gate1++;
				return mockRunResult(gateCounters.gate1 === 1 ? "VERDICT: PASS" : "VERDICT: BLOCK");
			}
			if (task.includes("gate2-task")) {
				gateCounters.gate2++;
				return mockRunResult(gateCounters.gate2 === 1 ? "VERDICT: PASS" : "VERDICT: BLOCK");
			}
			if (task.includes("gate3-task")) {
				// Always block on first call from main loop to trigger retry chain
				if (!gate3Called) {
					gate3Called = true;
					return mockRunResult("VERDICT: BLOCK");
				}
				return mockRunResult("VERDICT: BLOCK");
			}
			return mockRunResult("ok");
		},
	};
	const result = await executeTaskflow(state, deps);

	// Count how many times "data" was called (base agent execution).
	const baseCalls = callSeq.filter((t) => t.includes("data")).length;
	assert.equal(baseCalls, 1, `base must execute exactly 1 time (depth 3 blocked re-execution), got ${baseCalls}`);

	// gate0 must have been called at least 2 times (1st from main loop, 2nd+ from retry).
	assert.ok(gateCounters.gate0 >= 2, `gate0 must be called at least 2 times, got ${gateCounters.gate0}`);

	// The run is expected to fail (gates keep blocking through retries).
	assert.equal(result.ok, false, "run must fail when gates never pass");
	assert.equal(state.phases["gate3"]?.gate?.verdict, "block");
});

test("onBlock:retry — depth 2 allowed (MAX_RETRY_DEPTH boundary positive case)", async () => {
	// A 3-gate chain: gate2 → gate1 → gate0 → base.
	// At depth 2, `_retryDepth < MAX_RETRY_DEPTH` (2 < 3 = true), so
	// re-execution IS allowed — base should run a second time.
	// This confirms the depth limit is not too restrictive.
	const callSeq: string[] = [];
	const gateCounters: Record<string, number> = { gate0: 0, gate1: 0 };
	let gate2Called = false;

	const def = {
		name: "retry-depth-2",
		phases: [
			{ id: "base", type: "agent", task: "data" },
			{
				id: "gate0",
				type: "gate",
				task: "gate0-task",
				dependsOn: ["base"],
				onBlock: "retry" as const,
				retry: { max: 1 },
			},
			{
				id: "gate1",
				type: "gate",
				task: "gate1-task",
				dependsOn: ["gate0"],
				onBlock: "retry" as const,
				retry: { max: 1 },
			},
			{
				id: "gate2",
				type: "gate",
				task: "gate2-task",
				dependsOn: ["gate1"],
				onBlock: "retry" as const,
				retry: { max: 1 },
				final: true,
			},
		],
	};
	const state: RunState = mkState(def, "retry-depth-2-m1");
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: [dummyAgent],
		runTask: async (_cwd, _agents, _an, task) => {
			callSeq.push(task);
			if (task.includes("data")) {
				return mockRunResult("data");
			}
			if (task.includes("gate0-task")) {
				gateCounters.gate0++;
				return mockRunResult(gateCounters.gate0 === 1 ? "VERDICT: PASS" : "VERDICT: BLOCK");
			}
			if (task.includes("gate1-task")) {
				gateCounters.gate1++;
				return mockRunResult(gateCounters.gate1 === 1 ? "VERDICT: PASS" : "VERDICT: BLOCK");
			}
			if (task.includes("gate2-task")) {
				if (!gate2Called) {
					gate2Called = true;
					return mockRunResult("VERDICT: BLOCK");
				}
				return mockRunResult("VERDICT: BLOCK");
			}
			return mockRunResult("ok");
		},
	};
	const result = await executeTaskflow(state, deps);

	const baseCalls = callSeq.filter((t) => t.includes("data")).length;
	// At depth 2, re-execution IS allowed, so base runs a second time.
	assert.ok(baseCalls >= 2, `base must execute at least 2 times (depth 2 allowed), got ${baseCalls}`);
	assert.equal(result.ok, false, "run must fail when gates never pass");
});
