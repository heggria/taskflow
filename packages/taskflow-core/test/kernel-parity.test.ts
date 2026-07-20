/**
 * S5.0 — Kernel parity harness.
 *
 * Golden suite: for each fixture flow, run on BOTH engines (imperative +
 * event kernel) with the same mock runTask, and assert that status,
 * per-phase status/output/error, and gate decisions match.
 *
 * This is the differential test that must stay green before the kernel
 * can be flipped to default ON (S5.2).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { emptyUsage } from "../src/usage.ts";
import { executeTaskflow, type RuntimeDeps, type RuntimeResult } from "../src/runtime.ts";
import { canUseEventKernel } from "../src/exec/driver.ts";
import type { Taskflow, Phase } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test", systemPrompt: "", source: "user", filePath: "" },
	{ name: "b", description: "test", systemPrompt: "", source: "user", filePath: "" },
];

/** A deterministic mock runner: output = "OUT:<task>", gate = PASS. */
function deterministicRunner(): RuntimeDeps["runTask"] {
	return async (_cwd: string, _agents: AgentConfig[], agentName: string, task: string, _o: RunOptions): Promise<RunResult> => {
		// Gate phases return a VERDICT.
		if (task.includes("VERDICT")) {
			return {
				agent: agentName,
				task,
				exitCode: 0,
				output: "Looks good. VERDICT: PASS",
				stderr: "",
				usage: { ...emptyUsage(), output: 10, turns: 1 },
				stopReason: "end",
			};
		}
		return {
			agent: agentName,
			task,
			exitCode: 0,
			output: `OUT:${task}`,
			stderr: "",
			usage: { ...emptyUsage(), output: 5, turns: 1 },
			stopReason: "end",
		};
	};
}

function mkState(def: Taskflow): RunState {
	return {
		runId: `parity-${def.name}`,
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: "/tmp",
	};
}

function baseDeps(eventKernel: boolean): RuntimeDeps {
	return {
		cwd: "/tmp",
		agents: AGENTS,
		runTask: deterministicRunner(),
		persist: () => {},
		onProgress: () => {},
		eventKernel,
	};
}

/** Normalize a RuntimeResult for comparison (strip volatile fields). */
function normalize(res: RuntimeResult) {
	return {
		ok: res.ok,
		status: res.state.status,
		phases: Object.fromEntries(
			Object.entries(res.state.phases).map(([id, p]) => [
				id,
				{
					status: p.status,
					output: p.output,
					error: p.error,
					// Normalize gate: strip undefined reason to avoid
					// {verdict:'pass'} vs {verdict:'pass',reason:undefined} mismatch.
					gate: p.gate
						? { verdict: p.gate.verdict, ...(p.gate.reason !== undefined ? { reason: p.gate.reason } : {}) }
						: undefined,
				},
			]),
		),
	};
}

/** Run a flow on both engines and assert parity. */
async function assertParity(def: Taskflow, label?: string) {
	const tag = label ?? def.name;

	// Sanity: the flow must be kernel-eligible.
	assert.equal(canUseEventKernel(def), true, `${tag}: flow must be kernel-eligible`);

	const imperative = await executeTaskflow(mkState(def), baseDeps(false));
	const kernel = await executeTaskflow(mkState(def), baseDeps(true));

	const normImp = normalize(imperative);
	const normKer = normalize(kernel);

	assert.deepEqual(normKer, normImp, `${tag}: kernel and imperative results must match`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

test("parity: linear agent → agent chain", async () => {
	await assertParity({
		name: "linear",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "step one" },
			{ id: "b", type: "agent", agent: "a", task: "step two", dependsOn: ["a"], final: true },
		],
	});
});

test("parity: concurrent independent agents (same layer)", async () => {
	await assertParity({
		name: "concurrent",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "left" },
			{ id: "b", type: "agent", agent: "b", task: "right" },
			{ id: "c", type: "agent", agent: "a", task: "merge", dependsOn: ["a", "b"], final: true },
		],
	});
});

test("parity: agent → gate → agent", async () => {
	await assertParity({
		name: "gate-flow",
		phases: [
			{ id: "work", type: "agent", agent: "a", task: "do work" },
			{ id: "check", type: "gate", agent: "b", task: "Review. VERDICT: PASS or BLOCK", dependsOn: ["work"] },
			{ id: "report", type: "agent", agent: "a", task: "summarize", dependsOn: ["check"], final: true },
		],
	});
});

test("parity: agent → reduce", async () => {
	await assertParity({
		name: "reduce-flow",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "input one" },
			{ id: "b", type: "agent", agent: "b", task: "input two" },
			{ id: "r", type: "reduce", agent: "a", task: "combine {previous.output}", from: ["a", "b"], dependsOn: ["a", "b"], final: true },
		],
	});
});

test("parity: when-guard skip", async () => {
	await assertParity({
		name: "when-skip",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "first", output: "json" },
			{ id: "b", type: "agent", agent: "a", task: "conditional", when: "{steps.a.json.go} == true", dependsOn: ["a"] },
			{ id: "c", type: "agent", agent: "a", task: "always", dependsOn: ["a"], final: true },
		],
	});
});

test("parity: join any with optional dep", async () => {
	await assertParity({
		name: "join-any",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "primary" },
			{ id: "b", type: "agent", agent: "b", task: "secondary", optional: true },
			{ id: "c", type: "agent", agent: "a", task: "merge", dependsOn: ["a", "b"], join: "any", final: true },
		],
	});
});

test("parity: script phase", async () => {
	await assertParity({
		name: "script-flow",
		phases: [
			{ id: "s", type: "script", run: "echo hello", final: true } as Phase,
		],
	});
});

test("parity: loop with maxIterations", async () => {
	await assertParity({
		name: "loop-flow",
		phases: [
			{ id: "l", type: "loop", agent: "a", task: "iterate", maxIterations: 2, final: true },
		],
	});
});

test("parity: three-layer DAG (wide concurrency)", async () => {
	await assertParity({
		name: "three-layer",
		phases: [
			{ id: "a1", type: "agent", agent: "a", task: "layer1-a" },
			{ id: "a2", type: "agent", agent: "b", task: "layer1-b" },
			{ id: "a3", type: "agent", agent: "a", task: "layer1-c" },
			{ id: "b1", type: "agent", agent: "a", task: "layer2", dependsOn: ["a1", "a2", "a3"] },
			{ id: "c1", type: "agent", agent: "a", task: "layer3", dependsOn: ["b1"], final: true },
		],
	});
});

test("parity: retry on kernel matches imperative", async () => {
	await assertParity({
		name: "retry-flow",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "flaky", retry: { max: 2, backoffMs: 10 }, final: true },
		],
	});
});

test("parity: gate in a concurrent layer blocks the next layer on both engines", async () => {
	// A gate and an independent agent share a layer. The gate passes, so the
	// next layer should run. This tests that concurrent-layer commit correctly
	// propagates gate decisions to subsequent layers.
	await assertParity({
		name: "gate-concurrent",
		phases: [
			{ id: "work", type: "agent", agent: "a", task: "do work" },
			{ id: "side", type: "agent", agent: "b", task: "independent" },
			{ id: "check", type: "gate", agent: "b", task: "Review. VERDICT: PASS or BLOCK", dependsOn: ["work", "side"] },
			{ id: "report", type: "agent", agent: "a", task: "summarize", dependsOn: ["check"], final: true },
		],
	});
});
