import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunResult } from "../src/runner-core.ts";
import { emptyUsage } from "../src/usage.ts";
import { executeTaskflow, recomputeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import type { Phase, Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test agent", systemPrompt: "", source: "user", filePath: "" },
];

function mkState(def: Taskflow): RunState {
	return {
		runId: "test-run",
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

function mockRunner(respond: (task: string) => string, record: string[]): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task): Promise<RunResult> => {
		record.push(task);
		return {
			agent: agentName,
			task,
			exitCode: 0,
			output: respond(task),
			stderr: "",
			usage: { ...emptyUsage(), output: 10, cost: 0.001, turns: 1 },
			stopReason: "end",
		};
	};
}

function baseDeps(runTask: RuntimeDeps["runTask"]): RuntimeDeps {
	return { cwd: "/tmp", agents: AGENTS, runTask, persist: () => {}, onProgress: () => {} };
}

// ---------------------------------------------------------------------------
// Declared-but-unobserved edges (M2 union): a phase whose `when` ref never
// fired leaves no observed read, but the declared plane still records it.
// Recompute must propagate through the declared edge.
// ---------------------------------------------------------------------------

test("recompute (union): declared-but-unobserved edge respected (when never fires)", async () => {
	const record: string[] = [];
	let scoutVersion = "V1";
	// `reader` references scout in its `when` guard. The when is FALSE (scout's
	// output is "V1" != "skip"), so reader's task never interpolates scout and
	// NO observed read is recorded. But the declared plane (collectRefs on
	// `when`) records reader → scout. Seeding scout must still mark reader stale.
	const def: Taskflow = {
		name: "declared-only",
		phases: [
			{ id: "scout", type: "agent", agent: "a", task: "scan" },
			{
				id: "reader",
				type: "agent",
				agent: "a",
				task: "read",
				when: "{steps.scout.output} == skip",
				final: true,
			},
		],
	} as Taskflow;
	const deps = baseDeps(
		mockRunner((t) => (t === "scan" ? `out:${scoutVersion}` : `out:${t}`), record),
	);
	const state = mkState(def);
	await executeTaskflow(state, deps);
	// reader was skipped (when false) → no observed read of scout.
	assert.equal(state.phases.reader.status, "skipped");
	assert.equal(state.phases.reader.reads?.length ?? 0, 0, "no observed read (when never fired)");

	const { report } = await recomputeTaskflow(state, deps, ["scout"], { dryRun: true });
	assert.ok(report.rerun.includes("reader"), "reader is in the frontier via the declared edge");
	assert.ok(report.rerun.includes("scout"), "seed is in the frontier");
});

test("recompute (union): ordering respects declared edges (no false early cutoff)", async () => {
	const record: string[] = [];
	let scoutVersion = "V1";
	// reader declares no dependsOn but references scout in its task. With
	// concurrency=1 the original run executes sequentially so reader observes
	// scout. The union ordering must still place scout before reader.
	const def: Taskflow = {
		name: "implicit-declared",
		concurrency: 1,
		phases: [
			{ id: "scout", type: "agent", agent: "a", task: "scan" },
			{ id: "reader", type: "agent", agent: "a", task: "read {steps.scout.output}", final: true },
		],
	} as Taskflow;
	const deps = baseDeps(
		mockRunner((t) => (t === "scan" ? `out:${scoutVersion}` : `out:${t}`), record),
	);
	const state = mkState(def);
	await executeTaskflow(state, deps);
	const executedBefore = record.length;

	scoutVersion = "V2";
	const { report } = await recomputeTaskflow(state, deps, ["scout"], { dryRun: false });

	assert.ok(report.rerun.includes("scout"));
	assert.ok(report.rerun.includes("reader"), "reader re-ran via declared edge");
	assert.equal(report.cutoff.length, 0, "no false early cutoff");
	assert.equal(record.length, executedBefore + 2, "exactly two re-executions");
});

test("recompute (union): old RunState (no declaredDeps field) still unions", async () => {
	const record: string[] = [];
	let scoutVersion = "V1";
	const def: Taskflow = {
		name: "old-run",
		phases: [
			{ id: "scout", type: "agent", agent: "a", task: "scan" },
			{ id: "reader", type: "agent", agent: "a", task: "read {steps.scout.output}", dependsOn: ["scout"], final: true } as Phase,
		],
	} as Taskflow;
	const deps = baseDeps(
		mockRunner((t) => (t === "scan" ? `out:${scoutVersion}` : `out:${t}`), record),
	);
	const state = mkState(def);
	await executeTaskflow(state, deps);
	// Simulate a pre-H1 run: strip the persisted declaredDeps.
	delete state.declaredDeps;

	scoutVersion = "V2";
	const { report } = await recomputeTaskflow(state, deps, ["scout"], { dryRun: false });
	assert.ok(report.rerun.includes("reader"), "reader re-ran even without persisted declaredDeps (derived from def)");
});
