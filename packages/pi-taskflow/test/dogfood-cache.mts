/**
 * DOGFOOD: prove cross-run memoization end-to-end through the REAL runtime
 * and the REAL on-disk CacheStore — without spawning live `pi` subagents.
 *
 * A deterministic mock runner counts how many times a subagent is actually
 * invoked. The whole point of cross-run caching is that the SECOND independent
 * run (a different runId, a fresh phases map) reuses the FIRST run's results
 * for $0.00 — so the invocation count must NOT grow.
 *
 * Run:  node --experimental-strip-types test/dogfood-cache.mts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RunResult, RunOptions } from "../src/runner.ts";
import { CacheStore } from "taskflow-core";
import { executeTaskflow, type RuntimeDeps } from "taskflow-core";
import { type Taskflow, validateTaskflow } from "taskflow-core";
import type { RunState } from "taskflow-core";
import { emptyUsage } from "taskflow-core";

const C = {
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
	ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
	bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
	hl: (s: string) => `\x1b[36m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

// A two-phase flow. `analyze` is cross-run (fingerprinted on a source file);
// `report` is cross-run with no fingerprint (pure function of its prompt).
function makeFlow(): Taskflow {
	return {
		name: "dogfood-cache",
		phases: [
			{
				id: "analyze",
				type: "agent",
				agent: "scout",
				task: "Summarize the auth module.",
				cache: { scope: "cross-run", fingerprint: ["file:src.txt"] },
			},
			{
				id: "report",
				type: "agent",
				agent: "scout",
				task: "Write a one-line report from: {steps.analyze.output}",
				dependsOn: ["analyze"],
				cache: { scope: "cross-run" },
				final: true,
			},
		],
	};
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

let CALLS = 0;
// The mock simulates a real subagent: its output reflects the *current* world
// state (the src.txt contents), so a fingerprint-driven recompute of `analyze`
// produces a genuinely different output — which must then invalidate the
// downstream `report` whose prompt interpolates that output.
function worldState(cwd: string): string {
	try {
		return fs.readFileSync(path.join(cwd, "src.txt"), "utf8");
	} catch {
		return "";
	}
}
function makeRunTask(cwd: string): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task, _o: RunOptions): Promise<RunResult> => {
		CALLS++;
		// `analyze` reads the world; `report` is a pure function of its prompt.
		const body = task.startsWith("Summarize") ? `summary[${worldState(cwd)}]` : `result(${task.slice(0, 40)})`;
		return {
			agent: agentName,
			task,
			exitCode: 0,
			output: body,
			stderr: "",
			usage: { ...emptyUsage(), output: 50, cost: 0.01, turns: 1 },
			stopReason: "end",
		};
	};
}

function run(def: Taskflow, cwd: string, store: CacheStore) {
	const deps: RuntimeDeps = { cwd, agents: [], runTask: makeRunTask(cwd), cacheStore: store };
	return executeTaskflow(mkState(def, cwd), deps);
}

function hits(res: Awaited<ReturnType<typeof run>>): string[] {
	return Object.values(res.state.phases)
		.filter((p) => p.cacheHit === "cross-run")
		.map((p) => p.id);
}

async function main() {
	const def = makeFlow();
	const v = validateTaskflow(def);
	if (!v.ok) {
		console.error(C.bad("INVALID FLOW: ") + v.errors.join("; "));
		process.exit(1);
	}
	console.log(C.bold("\n  pi-taskflow · cross-run memoization dogfood\n"));

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-dogfood-"));
	fs.writeFileSync(path.join(cwd, "src.txt"), "auth v1");
	const store = new CacheStore(cwd);

	const checks: Array<[string, boolean]> = [];

	// ---- Run #1: cold cache. Both phases must execute. ----
	const r1 = await run(def, cwd, store);
	const callsAfter1 = CALLS;
	console.log(`  ${C.hl("Run #1")} (cold cache)`);
	console.log(`    subagent calls: ${C.bold(String(callsAfter1))}   cache hits: ${hits(r1).join(", ") || C.dim("none")}`);
	checks.push(["run #1 succeeds", r1.ok]);
	checks.push(["run #1 executes both phases (2 calls)", callsAfter1 === 2]);
	checks.push(["run #1 has no cache hits", hits(r1).length === 0]);

	// ---- Run #2: warm cache, nothing changed. Zero new calls. ----
	const r2 = await run(def, cwd, store);
	const callsAfter2 = CALLS;
	console.log(`  ${C.hl("Run #2")} (warm cache, no changes)`);
	console.log(`    subagent calls: ${C.bold(String(callsAfter2))}   cache hits: ${C.ok(hits(r2).join(", ") || "none")}`);
	console.log(`    ${C.dim(`→ ${callsAfter2 - callsAfter1} new calls; both phases served from cross-run cache for $0.00`)}`);
	checks.push(["run #2 succeeds", r2.ok]);
	checks.push(["run #2 adds ZERO subagent calls", callsAfter2 === callsAfter1]);
	checks.push(["run #2 hits BOTH phases", hits(r2).length === 2]);
	checks.push(["run #2 cached output equals run #1", r2.finalOutput === r1.finalOutput]);
	checks.push(["run #2 cache-hit usage is $0", (r2.state.phases.analyze?.usage?.cost ?? -1) === 0]);

	// ---- Run #3: source file changed. `analyze` must recompute (fingerprint),
	//      and `report` recomputes because its upstream output is new. ----
	fs.writeFileSync(path.join(cwd, "src.txt"), "auth v2 — rewritten");
	const r3 = await run(def, cwd, store);
	const callsAfter3 = CALLS;
	console.log(`  ${C.hl("Run #3")} (src.txt changed → fingerprint miss)`);
	console.log(`    subagent calls: ${C.bold(String(callsAfter3))}   cache hits: ${hits(r3).join(", ") || C.dim("none")}`);
	console.log(`    ${C.dim(`→ ${callsAfter3 - callsAfter2} new calls; analyze recomputes AND its changed output invalidates report`)}`);
	checks.push(["run #3 succeeds", r3.ok]);
	checks.push(["run #3 recomputes analyze (fingerprint invalidation)", !hits(r3).includes("analyze")]);
	checks.push(["run #3 cascades: report also recomputes (upstream changed)", !hits(r3).includes("report")]);
	checks.push(["run #3 adds 2 new calls", callsAfter3 - callsAfter2 === 2]);

	// ---- Run #4: file reverted to v1 → matches run #1's fingerprint+key → hit again. ----
	fs.writeFileSync(path.join(cwd, "src.txt"), "auth v1");
	const callsBefore4 = CALLS;
	const r4 = await run(def, cwd, store);
	console.log(`  ${C.hl("Run #4")} (src.txt reverted to v1 → fingerprint matches run #1)`);
	console.log(`    subagent calls: ${C.bold(String(CALLS))}   cache hits: ${C.ok(hits(r4).join(", ") || "none")}`);
	checks.push(["run #4 re-hits analyze after revert", hits(r4).includes("analyze")]);
	checks.push(["run #4 adds zero new calls", CALLS === callsBefore4]);

	// ---- cache-clear semantics ----
	const cleared = store.clear();
	const callsBefore5 = CALLS;
	const r5 = await run(def, cwd, store);
	console.log(`  ${C.hl("Run #5")} (after cache-clear: ${cleared} entries removed)`);
	console.log(`    subagent calls: ${C.bold(String(CALLS))}   cache hits: ${hits(r5).join(", ") || C.dim("none")}`);
	checks.push(["cache-clear removed entries", cleared > 0]);
	checks.push(["run #5 recomputes after clear (2 new calls)", CALLS - callsBefore5 === 2]);

	fs.rmSync(cwd, { recursive: true, force: true });

	console.log(C.bold("\n  assertions\n"));
	let allPass = true;
	for (const [name, ok] of checks) {
		console.log(`    ${ok ? C.ok("PASS") : C.bad("FAIL")}  ${name}`);
		if (!ok) allPass = false;
	}
	console.log(allPass ? C.ok("\n  ✅ DOGFOOD PASSED\n") : C.bad("\n  ❌ DOGFOOD FAILED\n"));
	process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
