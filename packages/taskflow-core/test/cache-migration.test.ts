import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import { CacheStore } from "../src/cache.ts";
import { agentDefinitionsIdentity, executeTaskflow, cacheKeys, type PhaseCacheCtx, type RuntimeDeps } from "../src/runtime.ts";
import type { RunResult, RunOptions } from "../src/runner-core.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test agent", systemPrompt: "", source: "user", filePath: "" },
];

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tf-cache-mig-"));
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

function countingRunner(counter: { n: number }): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task, _o: RunOptions): Promise<RunResult> => {
		counter.n++;
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

/** Build a minimal PhaseCacheCtx matching what executeTaskflow constructs for
 *  a cross-run agent phase, so we can compute the exact legacy/bare/v2 keys to
 *  pre-seed. Derives flowDefHash + per-phase sub-fingerprint by running
 *  compileTaskflowToIR + phaseFingerprint once (mirrors the runtime). */
async function ccFor(def: Taskflow, cwd: string, store: CacheStore, phaseId: string): Promise<PhaseCacheCtx> {
	const { compileTaskflowToIR, phaseFingerprint } = await import("../src/flowir/index.ts");
	const ir = await compileTaskflowToIR(def);
	const fdh = ir.hash;
	const subfp = (await phaseFingerprint(def, phaseId)) ?? fdh ?? "";
	return {
		scope: "cross-run",
		fingerprint: "",
		store,
		prior: undefined,
		phaseId,
		flowName: def.name,
		runId: "seed",
		flowDefHash: fdh,
		phaseFp: subfp,
		agentDefinitions: agentDefinitionsIdentity(AGENTS),
	};
}

// ---------------------------------------------------------------------------
// Key shape: new key uses v2:flowdef prefix; legacy/bare differ.
// ---------------------------------------------------------------------------

test("cacheKeys: key, v2Key, bareKey, legacyKey are all distinct (M6 4-tier)", async () => {
	const dir = tmpDir();
	const store = new CacheStore(dir);
	const def: Taskflow = {
		name: "shapes",
		phases: [{ id: "p", type: "agent", agent: "a", task: "fixed", cache: { scope: "cross-run" }, final: true }],
	};
	const cc = await ccFor(def, dir, store, "p");
	// baseParts must match what the agent branch uses: [phase.id, agentName, model, fullTask]
	const ck = cacheKeys(cc, ["p", "a", "", "fixed"]);
	assert.ok(ck.key !== ck.v2Key, "v3 key differs from v2 (per-phase subfp vs whole-flow)");
	assert.ok(ck.key !== ck.bareKey, "v3 key differs from bare (unversioned flowdef)");
	assert.ok(ck.key !== ck.legacyKey, "v3 key differs from legacy (no-flowdef)");
	assert.ok(ck.v2Key !== ck.bareKey, "v2 differs from bare");
	assert.ok(ck.v2Key !== ck.legacyKey, "v2 differs from legacy");
	assert.ok(ck.bareKey !== ck.legacyKey, "bare differs from legacy");
	assert.match(ck.key, /^[0-9a-f]+$/); // all four are hashInput hex digests
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Legacy safety: a pre-flowDefHash-era entry has no structural identity and
// must never be trusted after an upgrade.
// ---------------------------------------------------------------------------

test("cache migration: legacy (no-flowdef) entry is ignored to prevent stale reuse", async () => {
	const dir = tmpDir();
	const def: Taskflow = {
		name: "legacy",
		phases: [{ id: "p", type: "agent", agent: "a", task: "fixed", cache: { scope: "cross-run" }, final: true }],
	};
	const store = new CacheStore(dir);

	// Pre-seed a LEGACY entry (pre-flowDefHash shape: no flowdef line) with a
	// known output. We compute the exact legacy key the runtime will look up.
	const cc = await ccFor(def, dir, store, "p");
	const ck = cacheKeys(cc, ["p", "a", "", "fixed"]);
	store.put({
		key: ck.legacyKey,
		createdAt: Date.now(),
		output: "LEGACY-OUTPUT",
		model: "legacy-model",
		state: undefined, // legacy trimmed surface (no full PhaseState)
		flowName: def.name,
		phaseId: "p",
		runId: "old",
	});

	// Run — must execute and write the current structurally-versioned key.
	const counter = { n: 0 };
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };
	const r = await executeTaskflow(mkState(def, dir), deps);
	assert.equal(counter.n, 1, "unsafe legacy entry must not be served");
	assert.equal(r.state.phases.p.cacheHit, undefined);
	assert.equal(r.state.phases.p.output, "out:fixed#1");
	assert.ok(store.get(ck.key), "fresh output is stored under the current key");
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Bare-key fallback: a pre-H1 entry (bare `flowdef:` unversioned) still hits.
// (Arbiter correction #1: 3rd-tier fallback.)
// ---------------------------------------------------------------------------

test("cache migration: bare (unversioned flowdef) entry still hits via 3rd-tier fallback", async () => {
	const dir = tmpDir();
	const def: Taskflow = {
		name: "bare",
		phases: [{ id: "p", type: "agent", agent: "a", task: "fixed", cache: { scope: "cross-run" }, final: true }],
	};
	const store = new CacheStore(dir);
	const cc = await ccFor(def, dir, store, "p");
	const ck = cacheKeys(cc, ["p", "a", "", "fixed"]);
	// Pre-seed the BARE key (pre-H1 shape: bare `flowdef:` prefix, no `v2:`).
	store.put({
		key: ck.bareKey,
		createdAt: Date.now(),
		output: "BARE-OUTPUT",
		model: "bare-model",
		state: undefined,
		flowName: def.name,
		phaseId: "p",
		runId: "old",
	});

	const counter = { n: 0 };
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };
	const r = await executeTaskflow(mkState(def, dir), deps);
	assert.equal(counter.n, 0, "bare entry must hit via 3rd-tier fallback — no execution");
	assert.equal(r.state.phases.p.cacheHit, "cross-run");
	assert.equal(r.state.phases.p.output, "BARE-OUTPUT");
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Unsafe legacy data is left untouched while a fresh current-key entry is written.
// ---------------------------------------------------------------------------

test("cache migration: unsafe legacy entry is not read and fresh result uses current key", async () => {
	const dir = tmpDir();
	const def: Taskflow = {
		name: "no-write-through",
		phases: [{ id: "p", type: "agent", agent: "a", task: "fixed", cache: { scope: "cross-run" }, final: true }],
	};
	const store = new CacheStore(dir);
	const cc = await ccFor(def, dir, store, "p");
	const ck = cacheKeys(cc, ["p", "a", "", "fixed"]);
	store.put({
		key: ck.legacyKey,
		createdAt: Date.now(),
		output: "LEGACY",
		state: undefined,
	});

	const counter = { n: 0 };
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };
	await executeTaskflow(mkState(def, dir), deps);

	// The current key contains a newly executed result, not the legacy value.
	const v2Entry = store.get(ck.key);
	assert.ok(v2Entry, "fresh current-key entry was written");
	assert.equal(v2Entry?.output, "out:fixed#1");
	assert.equal(counter.n, 1);
	// The legacy entry is still there.
	assert.ok(store.get(ck.legacyKey), "legacy entry untouched");
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// No miss-storm: an identical re-run is free (the v2 write from run 1 hits in run 2).
// ---------------------------------------------------------------------------

test("cache migration: identical re-run is free (v2 write round-trips)", async () => {
	const dir = tmpDir();
	const def: Taskflow = {
		name: "free-rerun",
		phases: [{ id: "p", type: "agent", agent: "a", task: "fixed", cache: { scope: "cross-run" }, final: true }],
	};
	const counter = { n: 0 };
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	await executeTaskflow(mkState(def, dir), deps);
	assert.equal(counter.n, 1);
	const r2 = await executeTaskflow(mkState(def, dir), deps);
	assert.equal(counter.n, 1, "second run hits the v2 entry written by run 1 — free");
	assert.equal(r2.state.phases.p.cacheHit, "cross-run");
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Structural change invalidates: adding a phase changes flowDefHash → v2 key
// differs → miss (and legacy/bare also miss since the flow def changed).
// ---------------------------------------------------------------------------

test("cache migration: structural change invalidates (flowdef hash differs)", async () => {
	const dir = tmpDir();
	const store = new CacheStore(dir);
	// M6: only a structural change WITHIN a phase's transitive closure
	// invalidates it. Adding an unrelated independent phase must NOT. So `q`
	// is made a dependency of `p` — adding it moves p's sub-fingerprint.
	const mk = (extra: boolean): Taskflow => ({
		name: "struct-change",
		phases: extra
			? [
					{ id: "p", type: "agent", agent: "a", task: "fixed", cache: { scope: "cross-run" }, dependsOn: ["q"], final: true },
					{ id: "q", type: "agent", agent: "a", task: "extra" },
				]
			: [{ id: "p", type: "agent", agent: "a", task: "fixed", cache: { scope: "cross-run" }, final: true }],
	});
	const counter = { n: 0 };
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	await executeTaskflow(mkState(mk(false), dir), deps);
	assert.equal(counter.n, 1);
	// Adding `q` (now in p's closure) → p's sub-fingerprint changes → v3 key
	// differs → miss. (q also runs, so counter increments by 2.)
	await executeTaskflow(mkState(mk(true), dir), deps);
	assert.equal(counter.n, 3, "structural change in p's closure → miss on p (and q runs)");
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Cross-flow isolation preserved under v2: two flows sharing phase id + task
// but differing in name/structure do NOT collide.
// ---------------------------------------------------------------------------

test("cache migration: cross-flow isolation preserved (no leak across flows)", async () => {
	const dir = tmpDir();
	const store = new CacheStore(dir);
	const defA: Taskflow = {
		name: "flow-A",
		phases: [{ id: "p", type: "agent", agent: "a", task: "same", cache: { scope: "cross-run" }, final: true }],
	};
	const defB: Taskflow = {
		name: "flow-B",
		phases: [{ id: "p", type: "agent", agent: "a", task: "same", cache: { scope: "cross-run" }, final: true }],
	};
	const counter = { n: 0 };
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	await executeTaskflow(mkState(defA, dir), deps);
	await executeTaskflow(mkState(defB, dir), deps);
	assert.equal(counter.n, 2, "flow-B must NOT reuse flow-A (flow name + flowdef hash differ)");
	fs.rmSync(dir, { recursive: true, force: true });
});
