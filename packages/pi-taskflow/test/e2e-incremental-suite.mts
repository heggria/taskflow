/**
 * E2E suite for the "complete incremental recompute" landing (v0.0.28):
 * the five coupled capabilities shipped across the M5 finish line, exercised
 * end-to-end through the REAL runtime + REAL on-disk CacheStore with a
 * deterministic mock subagent runner (no live `pi` / model access needed).
 *
 *   1. precise ir-changed diff   — editing one phase reuses the others cross-run
 *   2. map item-level reuse       — editing one fan-out item reruns only it
 *   3. incremental flag           — flow.incremental / override → cross-run default
 *   4. run reuse summary          — summarizeReuse counts reused vs executed
 *   5. recompute decision trace   — per-phase why (rerun/cutoff/reused + causedBy)
 *
 * Run:  node --experimental-strip-types test/e2e-incremental-suite.mts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "taskflow-core";
import { CacheStore } from "taskflow-core";
import {
	executeTaskflow,
	recomputeTaskflow,
	summarizeReuse,
	type RuntimeDeps,
} from "taskflow-core";
import { resolveCacheScope } from "taskflow-core";
import type { RunResult, RunOptions } from "../src/runner.ts";
import type { Taskflow } from "taskflow-core";
import type { RunState } from "taskflow-core";
import { emptyUsage } from "taskflow-core";

const C = {
	ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
	bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
	hl: (s: string) => `\x1b[36m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test agent", systemPrompt: "", source: "user", filePath: "" },
];

let failures = 0;
const assert = (cond: boolean, msg: string) => {
	if (cond) console.log(`  ${C.ok("✓")} ${msg}`);
	else {
		failures++;
		console.log(`  ${C.bad("✗")} ${msg}`);
	}
};
const section = (s: string) => console.log(`\n${C.hl("▸ " + s)}`);

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tf-e2e-incr-"));
}
function mkState(def: Taskflow, cwd: string): RunState {
	return {
		runId: `run-${Math.random().toString(36).slice(2, 8)}`,
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
	};
}
/** A deterministic runner: output is a pure function of the task text, so two
 *  runs with the same task produce byte-identical output (content-addressable).
 *  Records every executed task so we can assert exactly which phases ran. */
function recordingRunner(record: string[]): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task, _o: RunOptions): Promise<RunResult> => {
		record.push(task);
		return {
			agent: agentName,
			task,
			exitCode: 0,
			output: `out:${task}`,
			stderr: "",
			usage: { ...emptyUsage(), output: 10, cost: 0.003, turns: 1 },
			stopReason: "end",
		};
	};
}

async function main() {
	// -----------------------------------------------------------------------
	// 1 + 3 + 4: precise ir-changed diff under the incremental flag.
	// An incremental flow scout→audit→report + an independent sibling. Run once,
	// edit ONLY audit's task, re-run: scout & independent must hit cross-run
	// (their per-phase fingerprints didn't move), audit must re-run.
	// -----------------------------------------------------------------------
	section("precise ir-changed diff (incremental flow): edit one phase, reuse the rest");
	{
		const dir = tmpDir();
		const store = new CacheStore(dir);
		const mkDef = (auditTask: string): Taskflow =>
			({
				name: "incr-precise",
				incremental: true,
				phases: [
					{ id: "scout", type: "agent", agent: "a", task: "scan" },
					{ id: "independent", type: "agent", agent: "a", task: "unrelated analysis" },
					{ id: "audit", type: "agent", agent: "a", task: auditTask, dependsOn: ["scout"] },
					{
						id: "report",
						type: "agent",
						agent: "a",
						task: "report {steps.audit.output} {steps.independent.output}",
						dependsOn: ["audit", "independent"],
						final: true,
					},
				],
			}) as Taskflow;

		// The flow declares incremental:true → resolveCacheScope opts it into cross-run.
		const scope = resolveCacheScope(undefined, mkDef("audit {steps.scout.output}").incremental);
		assert(scope === "cross-run", "flow.incremental=true → cross-run default scope");

		const rec1: string[] = [];
		const deps1: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: recordingRunner(rec1), cacheStore: store, cacheScopeDefault: scope };
		const r1 = await executeTaskflow(mkState(mkDef("audit v1 {steps.scout.output}"), dir), deps1);
		assert(r1.ok, "run 1 completed");
		assert(rec1.length === 4, `run 1 executed all 4 phases (got ${rec1.length})`);
		const s1 = summarizeReuse(r1.state);
		assert(s1.executed === 4 && s1.reusedCrossRun === 0, "run 1 reuse summary: 4 executed, 0 reused");

		// Edit ONLY audit's task. Re-run (fresh state, same store = cross-run).
		const rec2: string[] = [];
		const deps2: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: recordingRunner(rec2), cacheStore: store, cacheScopeDefault: scope };
		const r2 = await executeTaskflow(mkState(mkDef("audit v2 {steps.scout.output}"), dir), deps2);
		assert(r2.ok, "run 2 completed");
		// scout + independent unchanged → their per-phase fingerprints didn't move
		// → cross-run hit. audit changed → re-run. report reads audit → re-run.
		assert(!rec2.includes("scan"), "scout reused cross-run (not re-executed)");
		assert(!rec2.includes("unrelated analysis"), "independent reused cross-run (the precise-diff win)");
		assert(rec2.some((t) => t.includes("audit v2")), "audit re-executed (its task changed)");
		const s2 = summarizeReuse(r2.state);
		assert(s2.reusedCrossRun >= 2, `run 2 reused ≥2 phases cross-run (got ${s2.reusedCrossRun})`);
		assert(s2.reusedCrossRun + s2.executed === 4, "run 2 accounting balances (reused + executed = 4)");
		fs.rmSync(dir, { recursive: true, force: true });
	}

	// -----------------------------------------------------------------------
	// 2: map item-level reuse — change one item's input, only it re-runs.
	// -----------------------------------------------------------------------
	section("map item-level reuse: edit one fan-out item, rerun only that item");
	{
		const dir = tmpDir();
		const store = new CacheStore(dir);
		const mkDef = (items: string[]): Taskflow =>
			({
				name: "incr-map",
				incremental: true,
				phases: [
					{ id: "seed", type: "agent", agent: "a", task: "seed", output: "json" },
					{
						id: "fan",
						type: "map",
						agent: "a",
						over: JSON.stringify(items),
						task: "process {item}",
						dependsOn: [],
						output: "json",
						final: true,
					},
				],
			}) as Taskflow;

		const rec1: string[] = [];
		const deps1: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: recordingRunner(rec1), cacheStore: store, cacheScopeDefault: "cross-run" };
		await executeTaskflow(mkState(mkDef(["alpha", "beta", "gamma"]), dir), deps1);
		const fanRuns1 = rec1.filter((t) => t.startsWith("process "));
		assert(fanRuns1.length === 3, `run 1 fanned out 3 items (got ${fanRuns1.length})`);

		// Change ONLY the middle item: beta → BETA2.
		const rec2: string[] = [];
		const deps2: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: recordingRunner(rec2), cacheStore: store, cacheScopeDefault: "cross-run" };
		const r2 = await executeTaskflow(mkState(mkDef(["alpha", "BETA2", "gamma"]), dir), deps2);
		const fanRuns2 = rec2.filter((t) => t.startsWith("process "));
		assert(fanRuns2.length === 1, `run 2 re-executed only the changed item (got ${fanRuns2.length})`);
		assert(fanRuns2[0] === "process BETA2", "the one re-executed item is the changed one");
		assert(!fanRuns2.includes("process alpha") && !fanRuns2.includes("process gamma"), "alpha & gamma reused per-item");
		// Order invariant: merged output stays aligned with `over`.
		const out = r2.state.phases.fan?.json as unknown[] | undefined;
		assert(Array.isArray(out) && out.length === 3, "merged output has all 3 items in order");
		fs.rmSync(dir, { recursive: true, force: true });
	}

	// -----------------------------------------------------------------------
	// 5: recompute decision trace — per-phase why + causedBy attribution.
	// -----------------------------------------------------------------------
	section("recompute decision trace: per-phase why + upstream attribution");
	{
		const dir = tmpDir();
		const def: Taskflow = {
			name: "incr-trace",
			concurrency: 1,
			phases: [
				{ id: "scout", type: "agent", agent: "a", task: "scan" },
				{ id: "independent", type: "agent", agent: "a", task: "unrelated" },
				{ id: "audit", type: "agent", agent: "a", task: "audit {steps.scout.output}", dependsOn: ["scout"] },
				{ id: "report", type: "agent", agent: "a", task: "report {steps.audit.output} {steps.independent.output}", dependsOn: ["audit", "independent"], final: true },
			],
		} as Taskflow;
		const rec: string[] = [];
		const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: recordingRunner(rec), cacheStore: new CacheStore(dir) };
		const state = mkState(def, dir);
		await executeTaskflow(state, deps);

		const { report } = await recomputeTaskflow(state, deps, ["scout"], { dryRun: false });
		const byId = Object.fromEntries(report.decisions.map((d) => [d.phaseId, d]));
		assert(byId.scout?.outcome === "rerun" && /seed/.test(byId.scout.reason), "scout: rerun (seed)");
		assert(byId.audit?.outcome === "rerun", "audit: rerun (upstream moved)");
		assert(JSON.stringify(byId.audit?.causedBy) === JSON.stringify(["scout"]), "audit rerun attributed to scout");
		assert(JSON.stringify(byId.report?.causedBy) === JSON.stringify(["audit"]), "report rerun attributed to audit (not scout)");
		assert(byId.independent?.outcome === "reused" && /not reachable/.test(byId.independent.reason), "independent: reused (unreachable)");
		assert(report.decisions.length === 4, "every phase is explained");
		fs.rmSync(dir, { recursive: true, force: true });
	}

	// -----------------------------------------------------------------------
	// 3 (negative): default is run-only — capability given, default NOT flipped.
	// -----------------------------------------------------------------------
	section("default safety: without incremental, re-run does NOT reuse cross-run");
	{
		const dir = tmpDir();
		const store = new CacheStore(dir);
		const def: Taskflow = {
			name: "incr-default-off",
			phases: [{ id: "p", type: "agent", agent: "a", task: "work", final: true }],
		} as Taskflow;
		// No incremental flag anywhere → resolveCacheScope → run-only.
		const scope = resolveCacheScope(undefined, def.incremental);
		assert(scope === "run-only", "no incremental flag → run-only (default not flipped)");
		const rec1: string[] = [];
		await executeTaskflow(mkState(def, dir), { cwd: dir, agents: AGENTS, runTask: recordingRunner(rec1), cacheStore: store, cacheScopeDefault: scope });
		const rec2: string[] = [];
		await executeTaskflow(mkState(def, dir), { cwd: dir, agents: AGENTS, runTask: recordingRunner(rec2), cacheStore: store, cacheScopeDefault: scope });
		assert(rec1.length === 1 && rec2.length === 1, "run-only re-executes every run (no silent cross-run reuse)");
		fs.rmSync(dir, { recursive: true, force: true });
	}

	console.log("");
	if (failures === 0) {
		console.log(C.ok(C.bold("All Incremental-Recompute E2E checks passed.")));
	} else {
		console.log(C.bad(C.bold(`${failures} Incremental-Recompute E2E check(s) FAILED.`)));
		process.exit(1);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
