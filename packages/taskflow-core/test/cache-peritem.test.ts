/**
 * Per-item map caching — the Test Matrix from the approved plan.
 *
 * These tests pin the behavior of the per-item cross-run cache path added to
 * the `map` branch: changing one of N items re-executes only that item,
 * merged output stays positionally aligned with `over`, duplicate items share
 * an entry, and the soundness fallbacks (shareContext, dynamic sub-flow,
 * failed/budget-skipped items) hold.
 *
 * The realistic shape for per-item reuse is `over: "{args.items}"` with the
 * array supplied via run args: the phase DEFINITION (and therefore
 * flowDefHash / phaseFp) stays stable across runs, while the RESOLVED array
 * changes — so per-item keys for unchanged items remain stable. Changing the
 * `over` LITERAL would move the phase's structural fingerprint and invalidate
 * every per-item key at once (no partial reuse), which is correct but not the
 * scenario per-item caching targets.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import { CacheStore } from "../src/cache.ts";
import { agentDefinitionsIdentity, cacheKeys, executeTaskflow, summarizeReuse, type PhaseCacheCtx, type RuntimeDeps } from "../src/runtime.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test agent", systemPrompt: "", source: "user", filePath: "" },
	{ name: "b", description: "test agent b", systemPrompt: "", source: "user", filePath: "" },
];

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tf-peritem-"));
}

function mkState(def: Taskflow, cwd: string, args: Record<string, unknown> = {}): RunState {
	return {
		runId: `run-${Math.random().toString(36).slice(2, 8)}`,
		flowName: def.name,
		def,
		args,
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
	};
}

/** Counting runner: each successful call increments `counter.n` and emits a
 *  deterministic output embedding the task + call index, so cache hits (which
 *  skip the call) are observable as a missing index. `failWhen` lets a test
 *  force a specific item to fail. */
function countingRunner(
	counter: { n: number },
	failWhen?: (task: string) => string | null,
): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task, _o: RunOptions): Promise<RunResult> => {
		counter.n++;
		const fail = failWhen ? failWhen(task) : null;
		if (fail) {
			return {
				agent: agentName,
				task,
				exitCode: 1,
				output: "",
				stderr: fail,
				usage: { ...emptyUsage(), output: 5, cost: 0.001, turns: 1 },
				stopReason: "error",
				errorMessage: fail,
			};
		}
		return {
			agent: agentName,
			task,
			exitCode: 0,
			output: `out:${task}#${counter.n}`,
			stderr: "",
			usage: { ...emptyUsage(), output: 10, cost: 0.001, turns: 1 },
			stopReason: "end",
		};
	};
}

// ---------------------------------------------------------------------------
// (a) change 1 of N items re-executes only that item
// ---------------------------------------------------------------------------

test("per-item: change 1 of N items re-executes only that item", async () => {
	const dir = tmpDir();
	const def: Taskflow = {
		name: "peritem-change-one",
		phases: [
			{ id: "m", type: "map", agent: "a", over: "{args.items}", task: "process {item}", cache: { scope: "cross-run" }, final: true },
		],
	} as Taskflow;
	const counter = { n: 0 };
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	const r1 = await executeTaskflow(mkState(def, dir, { items: ["a", "b", "c"] }), deps);
	assert.equal(counter.n, 3, "run1 executes all 3 items");
	// Change ONLY item[1] (b -> b2). The phase def is unchanged (over is the
	// literal "{args.items}"), so per-item keys for item[0]/item[2] are stable.
	const r2 = await executeTaskflow(mkState(def, dir, { items: ["a", "b2", "c"] }), deps);
	assert.equal(counter.n, 4, "run2 re-executes only item[1] (3 + 1)");
	assert.equal(r2.state.phases.m.cacheHit, undefined, "phase executed (not a whole-map hit)");

	// item[0] and item[2] were served from per-item cache: their outputs match
	// run1 verbatim (same call index), proving no re-execution.
	assert.match(r2.finalOutput, /out:process a#1\b/, "item[0] reused from per-item cache (call #1)");
	assert.match(r2.finalOutput, /out:process c#3\b/, "item[2] reused from per-item cache (call #3)");
	// item[1] re-executed → fresh call index #4.
	assert.match(r2.finalOutput, /out:process b2#4\b/, "item[1] re-executed (call #4)");
	// Sanity: run1's item[1] output is NOT present in run2.
	assert.doesNotMatch(r2.finalOutput, /out:process b#2\b/);
	// r1 sanity: all three call indices appear.
	assert.match(r1.finalOutput, /out:process a#1\b/);
	assert.match(r1.finalOutput, /out:process b#2\b/);
	assert.match(r1.finalOutput, /out:process c#3\b/);
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (b) merged output stays positionally aligned with `over`
// ---------------------------------------------------------------------------

test("per-item: merged output stays positionally aligned with over (failed item keeps its slot)", async () => {
	const dir = tmpDir();
	const def: Taskflow = {
		name: "peritem-positional",
		phases: [
			{ id: "m", type: "map", agent: "a", over: '["x","FAIL","y"]', task: "do {item}", cache: { scope: "cross-run" }, final: true },
		],
	} as Taskflow;
	const counter = { n: 0 };
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter, (t) => (t.includes("FAIL") ? "boom" : null)), cacheStore: store };

	const r = await executeTaskflow(mkState(def, dir), deps);
	const out = r.finalOutput;
	// Labels are positionally aligned to the original `over`: [1/3], [2/3] (failed), [3/3].
	assert.match(out, /### \[1\/3\] a\n\nout:do x#\d/, "item[0] keeps slot 1/3");
	assert.match(out, /### \[2\/3\] a \(failed\)\n\nboom/, "item[1] keeps slot 2/3 and is marked failed");
	assert.match(out, /### \[3\/3\] a\n\nout:do y#\d/, "item[2] keeps slot 3/3");
	// No [1/2] / [2/2] labels (the old non-positional behavior counted only ran items).
	assert.doesNotMatch(out, /### \[1\/2\]/);
	assert.doesNotMatch(out, /### \[2\/2\]/);
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (c) duplicate items share a single cache entry
// ---------------------------------------------------------------------------

test("per-item: duplicate items share a single cache entry (content-addressable)", async () => {
	const dir = tmpDir();
	const def: Taskflow = {
		name: "peritem-dups",
		phases: [
			// concurrency:1 so item[0] records before item[1] looks up (deterministic).
			{ id: "m", type: "map", agent: "a", over: "{args.items}", task: "do {item}", concurrency: 1, cache: { scope: "cross-run" }, final: true },
		],
	} as Taskflow;
	const counter = { n: 0 };
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	// ["x","x","y"]: two identical tasks ("do x") share one per-item entry.
	await executeTaskflow(mkState(def, dir, { items: ["x", "x", "y"] }), deps);
	assert.equal(counter.n, 2, "run1: two DISTINCT tasks execute (do x once, do y once); the second do x hits the just-written entry");
	// run2: all three hit (do x + do y already cached).
	const r2 = await executeTaskflow(mkState(def, dir, { items: ["x", "x", "y"] }), deps);
	assert.equal(counter.n, 2, "run2: all items served from cache (0 new calls)");
	assert.equal(r2.state.phases.m.cacheHit, "cross-run", "whole-map fast path hits on identical re-run");
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (d) shareContext map falls back to whole-map caching
// ---------------------------------------------------------------------------

test("per-item: shareContext map falls back to whole-map (no partial reuse)", async () => {
	const dir = tmpDir();
	const def: Taskflow = {
		name: "peritem-sharectx",
		phases: [
			{ id: "m", type: "map", agent: "a", over: "{args.items}", task: "process {item}", shareContext: true, cache: { scope: "cross-run" }, final: true },
		],
	} as Taskflow;
	const counter = { n: 0 };
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	await executeTaskflow(mkState(def, dir, { items: ["a", "b", "c"] }), deps);
	assert.equal(counter.n, 3, "run1 executes all 3");
	// Change only item[1]. With shareContext, per-item is unsound → disabled.
	// Whole-map misses (items changed) → ALL items re-execute (no partial hits).
	const r2 = await executeTaskflow(mkState(def, dir, { items: ["a", "b2", "c"] }), deps);
	assert.equal(counter.n, 6, "run2 re-executes ALL 3 items (whole-map fallback, no per-item reuse)");
	assert.equal(r2.state.phases.m.cacheHit, undefined, "phase executed (whole-map missed)");
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (e) pre-existing whole-map entry still hits (fast path)
// ---------------------------------------------------------------------------

test("per-item: whole-map fast path still hits on identical re-run (precedence over per-item)", async () => {
	const dir = tmpDir();
	const def: Taskflow = {
		name: "peritem-fastpath",
		phases: [
			{ id: "m", type: "map", agent: "a", over: "{args.items}", task: "process {item}", cache: { scope: "cross-run" }, final: true },
		],
	} as Taskflow;
	const counter = { n: 0 };
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	await executeTaskflow(mkState(def, dir, { items: ["a", "b", "c"] }), deps);
	assert.equal(counter.n, 3, "run1 seeds whole-map + per-item entries");
	// Identical re-run: whole-map key matches → 1 hit, runFanout never engages.
	const r2 = await executeTaskflow(mkState(def, dir, { items: ["a", "b", "c"] }), deps);
	assert.equal(counter.n, 3, "run2 hits the whole-map fast path (0 new calls)");
	assert.equal(r2.state.phases.m.cacheHit, "cross-run", "whole-map hit sets the phase-level cacheHit");
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (f) cross-run resume reuses completed items after re-seed (revert path)
// ---------------------------------------------------------------------------

test("per-item: revert to original re-runs hits the whole-map fast path (run1 entry preserved)", async () => {
	const dir = tmpDir();
	const def: Taskflow = {
		name: "peritem-revert",
		phases: [
			{ id: "m", type: "map", agent: "a", over: "{args.items}", task: "process {item}", cache: { scope: "cross-run" }, final: true },
		],
	} as Taskflow;
	const counter = { n: 0 };
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	const r1 = await executeTaskflow(mkState(def, dir, { items: ["a", "b", "c"] }), deps);
	assert.equal(counter.n, 3);
	// Change item[1] → 1 re-exec, writes a NEW whole-map entry + new per-item.
	await executeTaskflow(mkState(def, dir, { items: ["a", "b2", "c"] }), deps);
	assert.equal(counter.n, 4, "run2: only item[1] re-executes");
	// Revert to original. The whole-map key now matches run1's entry → fast-path hit.
	const r3 = await executeTaskflow(mkState(def, dir, { items: ["a", "b", "c"] }), deps);
	assert.equal(counter.n, 4, "run3: whole-map fast path hits run1's entry (0 new calls)");
	assert.equal(r3.state.phases.m.cacheHit, "cross-run");
	assert.equal(r3.finalOutput, r1.finalOutput, "run3 output matches run1 exactly");
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (g) usage + subProgress correct on partial hit
// ---------------------------------------------------------------------------

test("per-item: partial hit charges only the re-executed item; subProgress reflects all done", async () => {
	const dir = tmpDir();
	const def: Taskflow = {
		name: "peritem-usage",
		phases: [
			{ id: "m", type: "map", agent: "a", over: "{args.items}", task: "process {item}", cache: { scope: "cross-run" }, final: true },
		],
	} as Taskflow;
	const counter = { n: 0 };
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	await executeTaskflow(mkState(def, dir, { items: ["a", "b", "c"] }), deps);
	assert.equal(counter.n, 3);
	// Change item[1] only → 1 re-exec (cost 0.001); items 0+2 are 0-token cache hits.
	const r2 = await executeTaskflow(mkState(def, dir, { items: ["a", "b2", "c"] }), deps);
	assert.equal(counter.n, 4);
	const m = r2.state.phases.m;
	assert.equal(m.cacheHit, undefined, "phase executed (partial hit, not whole-map)");
	// Cached items contribute emptyUsage → merged cost is exactly one item's cost.
	assert.equal(m.usage?.cost ?? 0, 0.001, "only the re-executed item is charged");
	// subProgress: all 3 items reached done (2 cached + 1 executed), none failed.
	assert.equal(m.subProgress?.done, 3, "all 3 items done");
	assert.equal(m.subProgress?.failed, 0, "no failures");
	assert.equal(m.subProgress?.total, 3);
	// summarizeReuse: the phase executed (partial hit) → counted as executed, not reused.
	const reuse = summarizeReuse(r2.state);
	assert.equal(reuse.executed, 1, "the map phase is counted as executed (it ran 1 item)");
	assert.equal(reuse.reusedCrossRun, 0, "no whole-phase cross-run hit on a partial run");
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (h) failed item is never cached
// ---------------------------------------------------------------------------

test("per-item: a failed item is never cached (re-executes on the next run)", async () => {
	const dir = tmpDir();
	const def: Taskflow = {
		name: "peritem-nofail",
		phases: [
			{ id: "m", type: "map", agent: "a", over: "{args.items}", task: "process {item}", cache: { scope: "cross-run" }, final: true },
		],
	} as Taskflow;
	const store = new CacheStore(dir);

	// run1: item[1] ("process b") fails. Items 0+2 succeed and are cached per-item.
	let counter = { n: 0 };
	let failOn = "b";
	const deps1: RuntimeDeps = {
		cwd: dir, agents: AGENTS, cacheStore: store,
		runTask: countingRunner(counter, (t) => (t.includes(`process ${failOn}`) ? "boom" : null)),
	};
	await executeTaskflow(mkState(def, dir, { items: ["a", "b", "c"] }), deps1);
	assert.equal(counter.n, 3, "run1 attempts all 3 (item[1] fails)");

	// run2: same items, no failures. item[0]/[2] hit per-item; item[1] must
	// RE-EXECUTE (its failure was not cached) and now succeeds.
	counter = { n: 0 };
	failOn = "";
	const deps2: RuntimeDeps = { cwd: dir, agents: AGENTS, cacheStore: store, runTask: countingRunner(counter) };
	const r2 = await executeTaskflow(mkState(def, dir, { items: ["a", "b", "c"] }), deps2);
	assert.equal(counter.n, 1, "run2: only the previously-failed item[1] re-executes; 0+2 hit per-item");
	assert.equal(r2.state.phases.m.status, "done", "all items succeed on run2");
	assert.match(r2.finalOutput, /out:process b#\d/, "item[1] now has a fresh successful output");
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (i) budget-skipped item is never cached
// ---------------------------------------------------------------------------

test("per-item: a budget-skipped item is never recorded as a per-item cache entry", async () => {
	const dir = tmpDir();
	// concurrency:1 so the budget guard sees accumulated spend item-by-item.
	// maxUSD 0.0015: run1 executes item[0] (0.001) + item[1] (0.001, total 0.002
	// > cap) → item[2] is budget-skipped. We then inspect the cache store DIRECTLY:
	// the skipped item must have NO per-item entry (else a later run could serve a
	// stale "skipped" result), while the executed items DO have entries.
	const def: Taskflow = {
		name: "peritem-nobudgetskip",
		budget: { maxUSD: 0.0015 },
		phases: [
			{ id: "m", type: "map", agent: "a", over: "{args.items}", task: "process {item}", concurrency: 1, cache: { scope: "cross-run" }, final: true },
		],
	} as Taskflow;
	const store = new CacheStore(dir);

	let counter = { n: 0 };
	const deps1: RuntimeDeps = { cwd: dir, agents: AGENTS, cacheStore: store, runTask: countingRunner(counter) };
	const r1 = await executeTaskflow(mkState(def, dir, { items: ["a", "b", "c"] }), deps1);
	assert.equal(counter.n, 2, "run1: item[0]+item[1] execute, item[2] budget-skipped");
	assert.equal(r1.state.phases.m.budgetTruncated, true, "map was cut short by the budget cap");

	// Reconstruct the runtime's per-item CacheKeys to inspect the store.
	// Per-item keys are built from ccPerItem — the whole-phase cc with BOTH
	// phaseFp and flowDefHash set to undefined (so a changing `over` cannot move
	// unchanged items' keys). So the reconstructed cc must ALSO omit both
	// fingerprints to match what the runtime writes under.
	const ccPerItem: PhaseCacheCtx = {
		scope: "cross-run",
		fingerprint: "",
		store,
		prior: undefined,
		phaseId: "m",
		flowName: def.name,
		runId: r1.state.runId,
		flowDefHash: undefined,
		agentDefinitions: agentDefinitionsIdentity(AGENTS),
		phaseFp: undefined,
		thinking: undefined,
		tools: undefined,
		preRead: "",
	};
	// Per-item key folds [phase.id, it.agent, model, it.task] (Arbiter fix).
	// (phaseFp/flowDefHash are intentionally absent — see ccPerItem above.)
	const keyFor = (task: string) => cacheKeys(ccPerItem, ["m", "a", "", task]).key;
	const keyA = keyFor("process a"); // item[0]: executed → cached
	const keyB = keyFor("process b"); // item[1]: executed → cached
	const keyC = keyFor("process c"); // item[2]: budget-skipped → NOT cached

	assert.notEqual(store.get(keyA), null, "executed item[0] has a per-item cache entry");
	assert.notEqual(store.get(keyB), null, "executed item[1] has a per-item cache entry");
	assert.equal(store.get(keyC), null, "budget-skipped item[2] has NO per-item cache entry");
	// The skipped item's entry (had it been written) would carry no real output;
	// confirm the executed entries carry the real subagent output.
	assert.match(store.get(keyA)?.output ?? "", /out:process a#/);
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (j) map inside a dynamic sub-flow (def: frame) uses whole-map only
// ---------------------------------------------------------------------------

test("per-item: map inside a dynamic sub-flow (def: frame) uses whole-map only (no partial reuse)", async () => {
	const dir = tmpDir();
	// Top-level flow phase with an inline `def` containing a cross-run map.
	// The def-frame in the stack disables per-item caching for the inner map.
	// `with.items` interpolates from top-level args so the resolved array can
	// change WITHOUT changing the def literal (keeping the sub-flow identity
	// stable would otherwise mask the behavior under the flow phase's own cache).
	const mk = (): Taskflow => ({
		name: "peritem-defframe",
		phases: [
			{
				id: "sub",
				type: "flow",
				agent: "a",
				with: { items: "{args.topItems}" },
				cache: { scope: "cross-run" },
				final: true,
				def: {
					name: "inner",
					phases: [
						{ id: "m", type: "map", agent: "a", over: "{args.items}", task: "process {item}", cache: { scope: "cross-run" }, final: true },
					],
				},
			},
		],
	}) as Taskflow;
	const def = mk();
	const store = new CacheStore(dir);

	let counter = { n: 0 };
	const deps1: RuntimeDeps = { cwd: dir, agents: AGENTS, cacheStore: store, runTask: countingRunner(counter) };
	await executeTaskflow(mkState(def, dir, { topItems: '["a","b","c"]' }), deps1);
	assert.equal(counter.n, 3, "run1: inner map executes all 3 items");

	// Identical re-run: the flow phase's whole-map cache hits → inner map is
	// not even re-entered → 0 calls. Confirms the flow phase still caches.
	counter = { n: 0 };
	const deps2: RuntimeDeps = { cwd: dir, agents: AGENTS, cacheStore: store, runTask: countingRunner(counter) };
	const r2 = await executeTaskflow(mkState(def, dir, { topItems: '["a","b","c"]' }), deps2);
	assert.equal(counter.n, 0, "run2: flow phase whole-map hit (0 calls)");
	assert.equal(r2.state.phases.sub.cacheHit, "cross-run");

	// Change ONLY item[1]. The flow phase whole-map misses (subArgs changed) →
	// inner map re-enters. Its whole-map also misses (items changed). Because the
	// map is inside a def-frame, per-item is DISABLED → ALL 3 items re-execute
	// (if per-item were enabled, only item[1] would run → counter.n would be 1).
	counter = { n: 0 };
	const deps3: RuntimeDeps = { cwd: dir, agents: AGENTS, cacheStore: store, runTask: countingRunner(counter) };
	const r3 = await executeTaskflow(mkState(def, dir, { topItems: '["a","b2","c"]' }), deps3);
	assert.equal(counter.n, 3, "run3: ALL items re-execute (per-item disabled inside def-frame; whole-map fallback)");
	assert.equal(r3.state.phases.sub.cacheHit, undefined, "flow phase missed (items changed)");
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (k) Arbiter fix: changing phase.agent invalidates all per-item keys
// ---------------------------------------------------------------------------

test("per-item: changing phase.agent invalidates every per-item key (no stale cross-agent hit)", async () => {
	const dir = tmpDir();
	const mk = (agent: string): Taskflow => ({
		name: "peritem-agent",
		phases: [
			{ id: "m", type: "map", agent, over: "{args.items}", task: "process {item}", cache: { scope: "cross-run" }, final: true },
		],
	}) as Taskflow;
	const counter = { n: 0 };
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	// run1 with agent "a": all items identical (same task text). Seeds per-item
	// entries keyed on agent "a".
	await executeTaskflow(mkState(mk("a"), dir, { items: ["a", "b", "c"] }), deps);
	assert.equal(counter.n, 3);
	// run2: SAME items + SAME task, but agent changed to "b". The per-item key
	// folds `it.agent`, so every per-item key differs → no stale cross-agent hit.
	// All 3 items re-execute under agent "b".
	const r2 = await executeTaskflow(mkState(mk("b"), dir, { items: ["a", "b", "c"] }), deps);
	assert.equal(counter.n, 6, "changing phase.agent must invalidate all per-item keys (3 + 3)");
	assert.equal(r2.state.phases.m.cacheHit, undefined, "whole-map also missed (agent is in JSON.stringify(tasks))");
	// Re-run with agent "b" again → whole-map fast path hits.
	const r3 = await executeTaskflow(mkState(mk("b"), dir, { items: ["a", "b", "c"] }), deps);
	assert.equal(counter.n, 6, "agent b now cached → 0 new calls");
	assert.equal(r3.state.phases.m.cacheHit, "cross-run");
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (L0) BUG REPRODUCTION: literal `over` — change 1 of N items re-executes only that item.
//
// Unlike the {args.items} tests above (whose phase DEFINITION is stable across
// runs), a literal `over: '["a","b","c"]'` bakes the array into the def. Changing
// one item CHANGES the def → flowDefHash AND phaseFp both move (neither strips
// `over`). Before the fix, ALL per-item keys moved at once → every item
// re-executed (counter 3 → 6). After the fix, per-item keys omit BOTH
// phaseFp and flowDefHash (via ccPerItem), so an unchanged item's key is stable
// (it depends only on it.task + agent + model + thinking/tools/preRead +
// world-state fingerprint) → only the changed item re-runs (3 → 4).
// ---------------------------------------------------------------------------

test("per-item: LITERAL over — change 1 of N items re-executes only that item (bug repro)", async () => {
	const dir = tmpDir();
	const mk = (items: string[]): Taskflow => ({
		name: "peritem-literal-repro",
		phases: [
			{ id: "m", type: "map", agent: "a", over: JSON.stringify(items), task: "process {item}", cache: { scope: "cross-run" }, final: true },
		],
	}) as Taskflow;
	const counter = { n: 0 };
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	const r1 = await executeTaskflow(mkState(mk(["a", "b", "c"]), dir), deps);
	assert.equal(counter.n, 3, "run1 executes all 3 items");
	assert.match(r1.finalOutput, /out:process a#1\b/);
	assert.match(r1.finalOutput, /out:process b#2\b/);
	assert.match(r1.finalOutput, /out:process c#3\b/);

	// Change ONLY item[1] (b -> b2). The literal `over` changes, so flowDefHash/
	// phaseFp move — but per-item keys must be invariant to `over` changes.
	const r2 = await executeTaskflow(mkState(mk(["a", "b2", "c"]), dir), deps);
	assert.equal(counter.n, 4, "run2 re-executes only item[1] (3 + 1)");
	assert.equal(r2.state.phases.m.cacheHit, undefined, "phase executed (partial hit, not whole-map)");
	// item[0] and item[2] reused verbatim from per-item cache (same call index).
	assert.match(r2.finalOutput, /out:process a#1\b/, "item[0] reused from per-item cache (call #1)");
	assert.match(r2.finalOutput, /out:process c#3\b/, "item[2] reused from per-item cache (call #3)");
	// item[1] re-executed → fresh call index #4.
	assert.match(r2.finalOutput, /out:process b2#4\b/, "item[1] re-executed (call #4)");
	// Sanity: run1's item[1] output is NOT present in run2.
	assert.doesNotMatch(r2.finalOutput, /out:process b#2\b/);
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (L1) Soundness: task template change invalidates ALL items (literal over).
// `it.task` is the per-item identity — changing the template changes every
// item's task, so every per-item key must move (full re-exec).
// ---------------------------------------------------------------------------

test("per-item: LITERAL over — task template change re-executes all items", async () => {
	const dir = tmpDir();
	const mk = (task: string, items: string[]): Taskflow => ({
		name: "peritem-literal-task",
		phases: [
			{ id: "m", type: "map", agent: "a", over: JSON.stringify(items), task, cache: { scope: "cross-run" }, final: true },
		],
	}) as Taskflow;
	const counter = { n: 0 };
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	await executeTaskflow(mkState(mk("process {item}", ["a", "b", "c"]), dir), deps);
	assert.equal(counter.n, 3, "run1 executes all 3");
	// Same items, but task template changed → every it.task differs → all re-exec.
	const r2 = await executeTaskflow(mkState(mk("analyze {item}", ["a", "b", "c"]), dir), deps);
	assert.equal(counter.n, 6, "run2 re-executes ALL items (task template changed → every key moved)");
	assert.equal(r2.state.phases.m.cacheHit, undefined, "whole-map also missed (tasks JSON differs)");
	assert.match(r2.finalOutput, /out:analyze a#4\b/);
	assert.match(r2.finalOutput, /out:analyze b#5\b/);
	assert.match(r2.finalOutput, /out:analyze c#6\b/);
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (L2) Soundness: agent change invalidates ALL items (literal over).
// The per-item key folds `it.agent`, so changing phase.agent moves every key.
// ---------------------------------------------------------------------------

test("per-item: LITERAL over — agent change re-executes all items", async () => {
	const dir = tmpDir();
	const mk = (agent: string): Taskflow => ({
		name: "peritem-literal-agent",
		phases: [
			{ id: "m", type: "map", agent, over: JSON.stringify(["a", "b", "c"]), task: "process {item}", cache: { scope: "cross-run" }, final: true },
		],
	}) as Taskflow;
	const counter = { n: 0 };
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	await executeTaskflow(mkState(mk("a"), dir), deps);
	assert.equal(counter.n, 3);
	// Same items + same task, but agent changed → every per-item key moves.
	const r2 = await executeTaskflow(mkState(mk("b"), dir), deps);
	assert.equal(counter.n, 6, "agent change invalidates all per-item keys (3 + 3)");
	assert.equal(r2.state.phases.m.cacheHit, undefined);
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (L3) Soundness: `as` field interaction is implicitly covered.
// `as` only renames the loop variable; the resolved `it.task` text is what
// flows into the per-item key. If the author keeps the template consistent
// with `as`, the interpolated text is unchanged → no spurious invalidation
// (correct). If they desync them, `it.task` differs → invalidation (correct,
// covered by L1's task-template principle). No separate test needed.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// (L4) Soundness: upstream output referenced in task re-executes all items.
// A map task that interpolates {steps.discover.output} folds the upstream
// output into it.task — when the upstream output changes, every per-item key
// moves (correct: the map's input genuinely changed).
// ---------------------------------------------------------------------------

test("per-item: upstream output referenced in task invalidates all items when it changes", async () => {
	const dir = tmpDir();
	const mk = (discoverOut: string): Taskflow => ({
		name: "peritem-upstream",
		phases: [
			{ id: "discover", type: "agent", agent: "a", task: "discover" },
			{ id: "m", type: "map", agent: "a", over: JSON.stringify(["x", "y"]), task: `do {item} with {steps.discover.output}`, dependsOn: ["discover"], cache: { scope: "cross-run" }, final: true },
		],
	}) as Taskflow;
	let counter = { n: 0 };
	const store = new CacheStore(dir);
	// Runner that emits a configurable discover output + counting map calls.
	const mkDeps = (discoverOut: string): RuntimeDeps => ({
		cwd: dir, agents: AGENTS, cacheStore: store,
		runTask: async (_cwd, _agents, agentName, task): Promise<RunResult> => {
			counter.n++;
			const out = task === "discover" ? discoverOut : `out:${task}#${counter.n}`;
			return { agent: agentName, task, exitCode: 0, output: out, stderr: "", usage: { ...emptyUsage(), output: 10, cost: 0.001, turns: 1 }, stopReason: "end" };
		},
	});

	await executeTaskflow(mkState(mk("CTX1"), dir), mkDeps("CTX1"));
	const mapCalls1 = counter.n;
	assert.ok(mapCalls1 >= 3, "run1: discover + 2 map items execute");
	// discover output changes → it.task for EVERY map item changes → all re-exec.
	counter = { n: 0 };
	const r2 = await executeTaskflow(mkState(mk("CTX2"), dir), mkDeps("CTX2"));
	// discover re-runs (its task changed too — same literal, but flowDefHash/phaseFp
	// move because the map phase's over-or-task is the SAME literal here... actually
	// discover's task literal is unchanged so it hits cross-run). Either way, both
	// map items must re-execute because {steps.discover.output} differs.
	assert.match(r2.finalOutput, /do x with CTX2/, "map item x re-executed with new upstream output");
	assert.match(r2.finalOutput, /do y with CTX2/, "map item y re-executed with new upstream output");
	assert.doesNotMatch(r2.finalOutput, /do x with CTX1/, "stale upstream-coupled output not served");
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (L5) Whole-map fast path still hits on identical re-run (literal over).
// The whole-map key keeps the FULL cc (phaseFp + flowDefHash), so an identical
// re-run hits the whole-map fast path — per-item path never engages.
// ---------------------------------------------------------------------------

test("per-item: LITERAL over — whole-map fast path hits on identical re-run", async () => {
	const dir = tmpDir();
	const def: Taskflow = {
		name: "peritem-literal-fastpath",
		phases: [
			{ id: "m", type: "map", agent: "a", over: JSON.stringify(["a", "b", "c"]), task: "process {item}", cache: { scope: "cross-run" }, final: true },
		],
	} as Taskflow;
	const counter = { n: 0 };
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	await executeTaskflow(mkState(def, dir), deps);
	assert.equal(counter.n, 3, "run1 executes all 3");
	// Identical re-run: whole-map key matches → 1 hit, runFanout never engages.
	const r2 = await executeTaskflow(mkState(def, dir), deps);
	assert.equal(counter.n, 3, "run2 hits whole-map fast path (0 new calls)");
	assert.equal(r2.state.phases.m.cacheHit, "cross-run", "whole-map hit sets phase-level cacheHit");
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (L6) De-mask: partial hit charges only the re-executed item (literal over).
// Literal-`over` variant of test (g). Before the fix this was impossible
// (all items re-executed); now only item[1] re-runs → cost is exactly one item.
// ---------------------------------------------------------------------------

test("per-item: LITERAL over — partial hit charges only the re-executed item", async () => {
	const dir = tmpDir();
	const mk = (items: string[]): Taskflow => ({
		name: "peritem-literal-usage",
		phases: [
			{ id: "m", type: "map", agent: "a", over: JSON.stringify(items), task: "process {item}", cache: { scope: "cross-run" }, final: true },
		],
	}) as Taskflow;
	const counter = { n: 0 };
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	await executeTaskflow(mkState(mk(["a", "b", "c"]), dir), deps);
	assert.equal(counter.n, 3);
	// Change item[1] only → 1 re-exec (cost 0.001); items 0+2 are 0-token cache hits.
	const r2 = await executeTaskflow(mkState(mk(["a", "b2", "c"]), dir), deps);
	assert.equal(counter.n, 4);
	const m = r2.state.phases.m;
	assert.equal(m.cacheHit, undefined, "phase executed (partial hit, not whole-map)");
	assert.equal(m.usage?.cost ?? 0, 0.001, "only the re-executed item is charged");
	assert.equal(m.subProgress?.done, 3, "all 3 items done");
	assert.equal(m.subProgress?.failed, 0);
	assert.equal(m.subProgress?.total, 3);
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (L7) De-mask: a failed item is never cached (literal over).
// Literal-`over` variant of test (h). A failing item must not be recorded,
// so a later run with the SAME literal `over` (same def!) re-executes only it.
// Note: because the def is identical across runs here, flowDefHash/phaseFp are
// stable — so this test would have PASSED even before the fix. It's included
// to lock the behavior for the literal-`over` shape (de-masking the suite).
// ---------------------------------------------------------------------------

test("per-item: LITERAL over — a failed item is never cached (re-executes next run)", async () => {
	const dir = tmpDir();
	const def: Taskflow = {
		name: "peritem-literal-nofail",
		phases: [
			{ id: "m", type: "map", agent: "a", over: JSON.stringify(["a", "b", "c"]), task: "process {item}", cache: { scope: "cross-run" }, final: true },
		],
	} as Taskflow;
	const store = new CacheStore(dir);

	// run1: item[1] ("process b") fails. Items 0+2 succeed and are cached per-item.
	let counter = { n: 0 };
	const deps1: RuntimeDeps = {
		cwd: dir, agents: AGENTS, cacheStore: store,
		runTask: countingRunner(counter, (t) => (t.includes("process b") ? "boom" : null)),
	};
	await executeTaskflow(mkState(def, dir), deps1);
	assert.equal(counter.n, 3, "run1 attempts all 3 (item[1] fails)");

	// run2: SAME def (same literal over), no failures. item[0]/[2] hit per-item;
	// item[1] must RE-EXECUTE (its failure was not cached) and now succeeds.
	counter = { n: 0 };
	const deps2: RuntimeDeps = { cwd: dir, agents: AGENTS, cacheStore: store, runTask: countingRunner(counter) };
	const r2 = await executeTaskflow(mkState(def, dir), deps2);
	assert.equal(counter.n, 1, "run2: only the previously-failed item[1] re-executes; 0+2 hit per-item");
	assert.equal(r2.state.phases.m.status, "done", "all items succeed on run2");
	assert.match(r2.finalOutput, /out:process b#\d/, "item[1] now has a fresh successful output");
	fs.rmSync(dir, { recursive: true, force: true });
});
