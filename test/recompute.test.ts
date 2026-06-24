import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../extensions/agents.ts";
import type { RunResult } from "../extensions/runner.ts";
import { emptyUsage } from "../extensions/usage.ts";
import { executeTaskflow, recomputeTaskflow, type RuntimeDeps } from "../extensions/runtime.ts";
import type { Taskflow } from "../extensions/schema.ts";
import type { RunState } from "../extensions/store.ts";

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

/** A mock runner whose response can be flipped at runtime (to simulate a phase
 *  producing the same or a different output on re-run). Records every call. */
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

// scout → audit (reads scout) → report (reads audit)
const DEF: Taskflow = {
	name: "cascade",
	phases: [
		{ id: "scout", type: "agent", agent: "a", task: "scan" },
		{ id: "audit", type: "agent", agent: "a", task: "audit {steps.scout.output}", dependsOn: ["scout"] },
		{ id: "report", type: "agent", agent: "a", task: "report {steps.audit.output}", dependsOn: ["audit"], final: true },
	],
} as Taskflow;

test("recompute: dry-run reports the worst-case frontier without executing", async () => {
	const record: string[] = [];
	const deps = baseDeps(mockRunner((t) => `out:${t}`, record));
	const state = mkState(DEF);
	await executeTaskflow(state, deps);
	const executedBefore = record.length;

	const { report } = await recomputeTaskflow(state, deps, ["scout"], { dryRun: true });

	assert.equal(report.dryRun, true);
	// Worst case: everything transitively reading scout is in the frontier.
	assert.deepEqual([...report.rerun].sort(), ["audit", "report", "scout"]);
	assert.equal(report.cutoff.length, 0, "dry-run cannot know cutoff");
	// Nothing was executed.
	assert.equal(record.length, executedBefore);
});

test("recompute: early cutoff — seed output unchanged → downstream cached", async () => {
	const record: string[] = [];
	const deps = baseDeps(mockRunner((t) => `out:${t}`, record));
	const state = mkState(DEF);
	await executeTaskflow(state, deps);
	const executedBefore = record.length;

	// Re-run scout with the SAME mock output. scout is forced; audit/report
	// re-evaluate their cache key — scout's output didn't move, so their
	// inputHash is unchanged → they hit their prior (early cutoff).
	const { report } = await recomputeTaskflow(state, deps, ["scout"]);

	assert.deepEqual(report.rerun, ["scout"], "only the forced seed re-ran");
	assert.deepEqual([...report.cutoff].sort(), ["audit", "report"], "downstream cached via early cutoff");
	// Exactly one re-execution (scout).
	assert.equal(record.length, executedBefore + 1);
});

test("recompute: cascade — seed output changed → downstream re-runs", async () => {
	const record: string[] = [];
	let scoutVersion = "V1";
	const deps = baseDeps(
		mockRunner((t) => (t === "scan" ? `out:${scoutVersion}` : `out:${t}`), record),
	);
	const state = mkState(DEF);
	await executeTaskflow(state, deps);
	const executedBefore = record.length;

	// Flip scout's output, then recompute. scout changes → audit's inputHash
	// moves (its task interpolates scout) → audit re-runs → its output changes
	// → report's inputHash moves → report re-runs. Full cascade.
	scoutVersion = "V2";
	const { report } = await recomputeTaskflow(state, deps, ["scout"]);

	assert.deepEqual([...report.rerun].sort(), ["audit", "report", "scout"], "full cascade re-ran");
	assert.equal(report.cutoff.length, 0, "nothing cached — every output moved");
	assert.equal(record.length, executedBefore + 3, "all three phases re-executed");
});

test("recompute: a phase outside the frontier is reused untouched", async () => {
	const record: string[] = [];
	const deps = baseDeps(mockRunner((t) => `out:${t}`, record));
	const state = mkState(DEF);
	await executeTaskflow(state, deps);

	// Seeding `audit` (mid-chain): scout is outside the frontier (nothing about
	// scout changes; audit doesn't get force-rerun by being a reader of scout).
	// report reads audit → in frontier. scout is reused.
	const { report } = await recomputeTaskflow(state, deps, ["audit"]);

	assert.ok(!report.rerun.includes("scout") && !report.cutoff.includes("scout"));
	assert.ok(report.reused.includes("scout"), "scout is outside the frontier → reused");
});

test("recompute: an aborted recompute stops early, reports aborted, re-runs nothing", async () => {
	const record: string[] = [];
	const runDeps = baseDeps(mockRunner((t) => `out:${t}`, record));
	const state = mkState(DEF);
	await executeTaskflow(state, runDeps);
	const executedBefore = record.length;

	// Pre-abort the signal. The recompute loop must break before force-running
	// the seed, report aborted=true, and leave the original run intact (the
	// caller checks `report.aborted` and skips saveRun).
	const ac = new AbortController();
	ac.abort();
	const abortedDeps: RuntimeDeps = { ...runDeps, signal: ac.signal };
	const { report } = await recomputeTaskflow(state, abortedDeps, ["scout"]);

	assert.equal(report.aborted, true, "aborted recompute is flagged");
	assert.equal(report.rerun.length, 0, "nothing re-ran");
	assert.equal(record.length, executedBefore, "no execution happened");
});

test("recompute: a non-existent seed is fail-open (empty frontier, no crash)", async () => {
	const record: string[] = [];
	const deps = baseDeps(mockRunner((t) => `out:${t}`, record));
	const state = mkState(DEF);
	await executeTaskflow(state, deps);

	const { report } = await recomputeTaskflow(state, deps, ["does-not-exist"]);
	// The seed isn't a phase; the frontier is just the seed itself (nothing
	// reads it), and the loop skips it (no matching phase). No crash, no rerun.
	assert.equal(report.rerun.length, 0);
});

test("recompute: loop inputHash folds upstream so changed seed re-runs loop", async () => {
	const record: string[] = [];
	let scoutVersion = "V1";
	const def: Taskflow = {
		name: "loop-cascade",
		phases: [
			{ id: "scout", type: "agent", agent: "a", task: "scan" },
			{
				id: "refine",
				type: "loop",
				agent: "a",
				maxIterations: 2,
				until: "{steps.refine.output} == done",
				task: "refine {steps.scout.output}",
				dependsOn: ["scout"],
			},
		],
	} as Taskflow;
	const deps = baseDeps(
		mockRunner((t) => (t.includes("scan") ? `out:${scoutVersion}` : "done"), record),
	);
	const state = mkState(def);
	await executeTaskflow(state, deps);
	const executedBefore = record.length;

	scoutVersion = "V2";
	const { report } = await recomputeTaskflow(state, deps, ["scout"]);

	assert.ok(report.rerun.includes("scout"), "seed re-ran");
	assert.ok(report.rerun.includes("refine"), "loop re-ran because its upstream changed");
	assert.equal(record.length, executedBefore + 2, "scout + loop re-executed");
});

test("recompute: tournament inputHash folds upstream so changed seed re-runs tournament", async () => {
	const record: string[] = [];
	let scoutVersion = "V1";
	const def: Taskflow = {
		name: "tourney-cascade",
		phases: [
			{ id: "scout", type: "agent", agent: "a", task: "scan" },
			{
				id: "pick",
				type: "tournament",
				agent: "a",
				variants: 2,
				mode: "best",
				judge: "Pick the variant that mentions {steps.scout.output}",
				task: "answer about {steps.scout.output}",
				dependsOn: ["scout"],
			},
		],
	} as Taskflow;
	const deps = baseDeps(
		mockRunner((t) => (t.includes("scan") ? `out:${scoutVersion}` : `out:${t}`), record),
	);
	const state = mkState(def);
	await executeTaskflow(state, deps);
	const executedBefore = record.length;

	scoutVersion = "V2";
	const { report } = await recomputeTaskflow(state, deps, ["scout"]);

	assert.ok(report.rerun.includes("scout"), "seed re-ran");
	assert.ok(report.rerun.includes("pick"), "tournament re-ran because its upstream changed");
	assert.equal(report.cutoff.length, 0, "tournament is not wrongly cut off");
	assert.ok(record.length > executedBefore + 1, "tournament spawned competitors again");
});
