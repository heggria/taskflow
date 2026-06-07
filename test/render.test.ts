import assert from "node:assert/strict";
import { test } from "node:test";
import { renderProgress, summarizeRun } from "../extensions/render.ts";
import { emptyUsage } from "../extensions/usage.ts";
import type { Taskflow } from "../extensions/schema.ts";
import type { PhaseState, RunState } from "../extensions/store.ts";

/** Identity theme — strips styling so assertions see plain structure. */
const theme: any = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

function mkState(def: Taskflow, phases: Record<string, PhaseState>, status: RunState["status"] = "running"): RunState {
	return {
		runId: "r",
		flowName: def.name,
		def,
		args: {},
		status,
		phases,
		createdAt: 0,
		updatedAt: 0,
		cwd: ".",
	};
}

function done(id: string): PhaseState {
	return { id, status: "done", usage: emptyUsage(), startedAt: 0, endedAt: 1 };
}

test("renderProgress: surfaces a ⚠ badge when a phase carries warnings", () => {
	const def: Taskflow = { name: "x", phases: [{ id: "p", type: "agent", task: "t", final: true }] };
	const state = mkState(def, {
		p: { id: "p", status: "done", usage: emptyUsage(), startedAt: 0, endedAt: 1, warnings: ["unresolved {steps.ghost}"] },
	});
	const out = renderProgress(state, theme as any);
	assert.match(out, /⚠1/, "warnings badge should appear in rendered output");
});

test("renderProgress: skipped + warnings shows both the reason and the badge", () => {
	const def: Taskflow = { name: "x", phases: [{ id: "p", type: "agent", task: "t", final: true }] };
	const state = mkState(def, {
		p: {
			id: "p",
			status: "skipped",
			error: "Upstream dependency not satisfied",
			endedAt: 1,
			usage: emptyUsage(),
			warnings: ["x"],
		},
	});
	const out = renderProgress(state, theme as any);
	assert.match(out, /skipped/);
	assert.match(out, /⚠1/);
});

// A fan-out → fan-in DAG with a long (layer-skipping) edge:
//   discover ─┬─ writeA ─┐
//             ├─ writeB ─┼─ verify ─┐
//             └─ fix ────────────────┴─ report
const diamond: Taskflow = {
	name: "diamond",
	phases: [
		{ id: "discover", type: "agent", task: "t" },
		{ id: "writeA", type: "agent", task: "t", dependsOn: ["discover"] },
		{ id: "writeB", type: "agent", task: "t", dependsOn: ["discover"] },
		{ id: "fix", type: "agent", task: "t", dependsOn: ["discover"] },
		{ id: "verify", type: "gate", task: "t", dependsOn: ["writeA", "writeB"] },
		{ id: "report", type: "reduce", from: ["verify", "fix"], task: "t", dependsOn: ["verify", "fix"], final: true },
	],
};

test("renderProgress: parallel layer gets a bracket rail (┌ ├ └)", () => {
	const state = mkState(
		diamond,
		Object.fromEntries(["discover", "writeA", "writeB", "fix", "verify", "report"].map((id) => [id, done(id)])),
	);
	const lines = renderProgress(state, theme).split("\n");

	const rowOf = (id: string) => lines.find((l) => l.includes(` ${id} `) || l.endsWith(` ${id}`) || l.includes(`${id}  `))!;
	// The three-phase parallel layer (writeA/writeB/fix) is bracketed.
	assert.ok(rowOf("writeA").includes("┌"), `writeA should open the bracket: ${rowOf("writeA")}`);
	assert.ok(rowOf("writeB").includes("├"), `writeB should be a mid bracket: ${rowOf("writeB")}`);
	assert.ok(rowOf("fix").includes("└"), `fix should close the bracket: ${rowOf("fix")}`);
});

test("renderProgress: single-phase layers have no rail glyph", () => {
	const state = mkState(diamond, { discover: done("discover") });
	const discoverRow = renderProgress(state, theme)
		.split("\n")
		.find((l) => l.includes("discover"))!;
	assert.ok(!/[┌├└]/.test(discoverRow), `root should have no rail: ${discoverRow}`);
});

test("renderProgress: renders in topological order (deps before dependents)", () => {
	const state = mkState(
		diamond,
		Object.fromEntries(["discover", "writeA", "writeB", "fix", "verify", "report"].map((id) => [id, done(id)])),
	);
	const text = renderProgress(state, theme);
	const pos = (id: string) => text.indexOf(`${id} `) >= 0 ? text.indexOf(id) : -1;
	assert.ok(pos("discover") < pos("writeA"), "discover before writeA");
	assert.ok(pos("writeA") < pos("verify"), "writeA before verify");
	assert.ok(pos("verify") < pos("report"), "verify before report");
});

test("renderProgress: annotates only long (layer-skipping) edges with ↳", () => {
	const state = mkState(
		diamond,
		Object.fromEntries(["discover", "writeA", "writeB", "fix", "verify", "report"].map((id) => [id, done(id)])),
	);
	const lines = renderProgress(state, theme).split("\n");
	const verifyRow = lines.find((l) => l.includes("verify"))!;
	const reportRow = lines.find((l) => l.includes("report"))!;

	// verify depends only on the adjacent layer (writeA/writeB) → no annotation.
	assert.ok(!verifyRow.includes("↳"), `verify deps are adjacent, should not annotate: ${verifyRow}`);
	// report depends on verify (adjacent) + fix (skips a layer) → annotate only the long edge.
	assert.ok(reportRow.includes("↳ fix"), `report should annotate its long edge: ${reportRow}`);
	assert.ok(!reportRow.includes("verify,") && !reportRow.includes("↳ verify"), `report should not annotate the adjacent edge: ${reportRow}`);
});

test("renderProgress: linear chains stay flat (no rails, no annotations)", () => {
	const chain: Taskflow = {
		name: "chain",
		phases: [
			{ id: "a", type: "agent", task: "t" },
			{ id: "b", type: "agent", task: "t", dependsOn: ["a"] },
			{ id: "c", type: "agent", task: "t", dependsOn: ["b"], final: true },
		],
	};
	const state = mkState(chain, { a: done("a"), b: done("b"), c: done("c") });
	const body = renderProgress(state, theme).split("\n").slice(1).join("\n"); // drop header
	assert.ok(!/[┌├└]/.test(body), `linear chain should have no rails: ${body}`);
	assert.ok(!body.includes("↳"), `linear chain should have no edge annotations: ${body}`);
});

test("renderProgress: handles a malformed DAG without dropping phases", () => {
	// `ghost` depends on a non-existent phase; topoLayers may exclude it.
	// The safety net must still render every declared phase.
	const broken: Taskflow = {
		name: "broken",
		phases: [
			{ id: "root", type: "agent", task: "t" },
			{ id: "ghost", type: "agent", task: "t", dependsOn: ["missing"] },
		],
	};
	const state = mkState(broken, { root: done("root"), ghost: done("ghost") });
	const text = renderProgress(state, theme);
	assert.ok(text.includes("root"), "root rendered");
	assert.ok(text.includes("ghost"), "ghost rendered despite broken dep");
});

test("summarizeRun: reports done / running / failed counts", () => {
	const state = mkState(
		diamond,
		{
			discover: done("discover"),
			writeA: { id: "writeA", status: "running", usage: emptyUsage() },
			writeB: { id: "writeB", status: "failed", usage: emptyUsage(), error: "boom" },
		},
	);
	const s = summarizeRun(state);
	assert.match(s, /1\/6 done/);
	assert.match(s, /1 running/);
	assert.match(s, /1 failed/);
});

test("renderProgress: never shows negative elapsed for a running phase with stale endedAt", () => {
	// Regression: a resumed running phase that still carried a previous attempt's
	// endedAt (endedAt < startedAt) rendered as a frozen negative time, e.g. "-44s".
	const def: Taskflow = { name: "x", phases: [{ id: "p", type: "agent", task: "t", final: true }] };
	const ps: PhaseState = {
		id: "p",
		status: "running",
		startedAt: 1_000_000, // started "now"
		endedAt: 950_000,     // stale: from a previous attempt, BEFORE startedAt
		usage: emptyUsage(),
	};
	const out = renderProgress(mkState(def, { p: ps }), theme);
	assert.ok(!/-\d+s/.test(out), `output must not contain a negative elapsed time:\n${out}`);
});
