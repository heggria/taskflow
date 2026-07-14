import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import { CacheStore } from "../src/cache.ts";
import { phaseFingerprint } from "../src/flowir/index.ts";
import { agentDefinitionsIdentity, executeTaskflow, cacheKeys, type PhaseCacheCtx, type RuntimeDeps } from "../src/runtime.ts";
import type { RunResult, RunOptions } from "../src/runner-core.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

// ---------------------------------------------------------------------------
// helpers (minimal set, mirroring test/cache.test.ts)
// ---------------------------------------------------------------------------

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test agent", systemPrompt: "", source: "user", filePath: "" },
];

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tf-phasefp-"));
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

// ===========================================================================
// Unit tests for phaseFingerprint (soundness gate + determinism)
// ===========================================================================

test("phaseFingerprint: returns undefined when def.contextSharing is true (soundness gate)", async () => {
	const def: Taskflow = {
		name: "sharing-flow",
		contextSharing: true,
		phases: [{ id: "p", type: "agent", agent: "a", task: "t", cache: { scope: "cross-run" }, final: true }],
	};
	assert.equal(await phaseFingerprint(def, "p"), undefined);
});

test("phaseFingerprint: returns undefined when a closure member has shareContext", async () => {
	const def: Taskflow = {
		name: "sharing-closure",
		phases: [
			{ id: "scout", type: "agent", agent: "a", task: "scan", shareContext: true },
			{ id: "p", type: "agent", agent: "a", task: "use {steps.scout.output}", dependsOn: ["scout"], cache: { scope: "cross-run" }, final: true },
		],
	};
	// p transitively depends on scout (shareContext) → fallback.
	assert.equal(await phaseFingerprint(def, "p"), undefined);
	// scout itself has shareContext → fallback.
	assert.equal(await phaseFingerprint(def, "scout"), undefined);
});

test("phaseFingerprint: returns undefined when a closure member is a flow phase", async () => {
	const def: Taskflow = {
		name: "flow-closure",
		phases: [
			{ id: "sub", type: "flow", use: "some-saved-flow" },
			{ id: "p", type: "agent", agent: "a", task: "use {steps.sub.output}", dependsOn: ["sub"], cache: { scope: "cross-run" }, final: true },
		],
	} as Taskflow;
	// p transitively depends on a flow phase → fallback.
	assert.equal(await phaseFingerprint(def, "p"), undefined);
	// the flow phase itself → fallback.
	assert.equal(await phaseFingerprint(def, "sub"), undefined);
});

test("phaseFingerprint: deterministic + changes when an included field changes", async () => {
	const mk = (task: string): Taskflow => ({
		name: "det",
		phases: [{ id: "p", type: "agent", agent: "a", task, cache: { scope: "cross-run" }, final: true }],
	});
	const a1 = await phaseFingerprint(mk("t1"), "p");
	const a2 = await phaseFingerprint(mk("t1"), "p");
	const b = await phaseFingerprint(mk("t2"), "p");
	assert.equal(a1, a2, "stable across calls");
	assert.notEqual(a1, b, "changes when task text changes");
	assert.match(a1!, /^[0-9a-f]+$/);
});

test("phaseFingerprint: cache policy field does NOT affect the sub-fingerprint", async () => {
	// cache.scope/ttl/fingerprint reach the key via other paths; the sub-fingerprint
	// must be invariant to them (else changing TTL would not invalidate via the
	// dedicated expiry path but perturb the structural hash).
	const mk = (cache: Taskflow["phases"][number]["cache"]): Taskflow => ({
		name: "policy-inv",
		phases: [{ id: "p", type: "agent", agent: "a", task: "t", cache, final: true }],
	});
	const a = await phaseFingerprint(mk({ scope: "cross-run" }), "p");
	const b = await phaseFingerprint(mk({ scope: "cross-run", ttl: "30m" }), "p");
	const c = await phaseFingerprint(mk({ scope: "cross-run", fingerprint: ["file:x"] }), "p");
	assert.equal(a, b);
	assert.equal(a, c);
});

test("phaseFingerprint: adding an independent phase does NOT move a phase's sub-fingerprint", async () => {
	const base: Taskflow = {
		name: "indep",
		phases: [{ id: "p", type: "agent", agent: "a", task: "t", cache: { scope: "cross-run" }, final: true }],
	};
	const withExtra: Taskflow = {
		name: "indep",
		phases: [
			{ id: "p", type: "agent", agent: "a", task: "t", cache: { scope: "cross-run" }, final: true },
			{ id: "q", type: "agent", agent: "a", task: "extra" },
		],
	};
	// q is NOT in p's closure → p's sub-fingerprint is unchanged.
	assert.equal(await phaseFingerprint(base, "p"), await phaseFingerprint(withExtra, "p"));
});

// ===========================================================================
// Integration tests through the runtime (the Test Matrix)
// ===========================================================================

test("phasefp: editing phase B does NOT invalidate independent phase A", async () => {
	const dir = tmpDir();
	const store = new CacheStore(dir);
	const mk = (bTask: string): Taskflow => ({
		name: "indep-edit",
		phases: [
			{ id: "scout", type: "agent", agent: "a", task: "scan", cache: { scope: "cross-run" } },
			{ id: "A", type: "agent", agent: "a", task: "A uses {steps.scout.output}", dependsOn: ["scout"], cache: { scope: "cross-run" } },
			{ id: "B", type: "agent", agent: "a", task: bTask, dependsOn: ["scout"], cache: { scope: "cross-run" }, final: true },
		],
	});
	const counter = { n: 0 };
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	await executeTaskflow(mkState(mk("B original"), dir), deps);
	assert.equal(counter.n, 3, "scout + A + B run once");
	// Edit ONLY B's task text. scout + A are unaffected (their closures don't include B).
	const r2 = await executeTaskflow(mkState(mk("B edited"), dir), deps);
	assert.equal(counter.n, 4, "only B re-runs; scout + A hit");
	assert.equal(r2.state.phases.scout.cacheHit, "cross-run");
	assert.equal(r2.state.phases.A.cacheHit, "cross-run");
	assert.equal(r2.state.phases.B.cacheHit, undefined, "B missed (its task changed)");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("phasefp: editing phase B invalidates B and its transitive dependents", async () => {
	const dir = tmpDir();
	const store = new CacheStore(dir);
	const mk = (bTask: string): Taskflow => ({
		name: "transitive",
		phases: [
			{ id: "scout", type: "agent", agent: "a", task: "scan", cache: { scope: "cross-run" } },
			{ id: "B", type: "agent", agent: "a", task: bTask, dependsOn: ["scout"], cache: { scope: "cross-run" } },
			{ id: "C", type: "agent", agent: "a", task: "C uses {steps.B.output}", dependsOn: ["B"], cache: { scope: "cross-run" } },
			{ id: "A", type: "agent", agent: "a", task: "A uses {steps.scout.output}", dependsOn: ["scout"], cache: { scope: "cross-run" }, final: true },
		],
	});
	const counter = { n: 0 };
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	await executeTaskflow(mkState(mk("B original"), dir), deps);
	assert.equal(counter.n, 4, "scout + B + C + A run once");
	// Edit B's task. B's closure changes → B misses. C depends on B → C's closure
	// (which includes B) changes → C misses. scout + A are unaffected.
	const r2 = await executeTaskflow(mkState(mk("B edited"), dir), deps);
	assert.equal(counter.n, 6, "B + C re-run; scout + A hit");
	assert.equal(r2.state.phases.scout.cacheHit, "cross-run");
	assert.equal(r2.state.phases.A.cacheHit, "cross-run", "A independent of B → hit");
	assert.equal(r2.state.phases.B.cacheHit, undefined, "B missed");
	assert.equal(r2.state.phases.C.cacheHit, undefined, "C (transitive dependent) missed");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("phasefp: pre-v3 (v2) entry still hits — no miss-storm", async () => {
	const dir = tmpDir();
	const store = new CacheStore(dir);
	const def: Taskflow = {
		name: "v2-fallback",
		phases: [{ id: "p", type: "agent", agent: "a", task: "fixed", cache: { scope: "cross-run" }, final: true }],
	};
	// Compute the v2 key the runtime will look up, and pre-seed it.
	const { compileTaskflowToIR } = await import("../src/flowir/index.ts");
	const ir = await compileTaskflowToIR(def);
	const cc: PhaseCacheCtx = {
		scope: "cross-run", fingerprint: "", store, prior: undefined,
		phaseId: "p", flowName: def.name, runId: "old",
		flowDefHash: ir.hash, phaseFp: (await phaseFingerprint(def, "p")) ?? ir.hash,
		agentDefinitions: agentDefinitionsIdentity(AGENTS),
		thinking: undefined, tools: undefined, preRead: "",
		executionCwd: fs.realpathSync(dir),
	};
	const ck = cacheKeys(cc, ["p", "a", "", "fixed"]);
	store.put({ key: ck.v2Key, createdAt: Date.now(), output: "V2-OUTPUT", model: "v2-model", state: undefined, flowName: def.name, phaseId: "p", runId: "old" });

	const counter = { n: 0 };
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };
	const r = await executeTaskflow(mkState(def, dir), deps);
	assert.equal(counter.n, 0, "v2 entry must hit via fallback — no execution");
	assert.equal(r.state.phases.p.cacheHit, "cross-run");
	assert.equal(r.state.phases.p.output, "V2-OUTPUT");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("phasefp: two structurally-different flows do not collide", async () => {
	const dir = tmpDir();
	const store = new CacheStore(dir);
	const mk = (extra: boolean): Taskflow => ({
		name: "collide",
		phases: extra
			? [
					{ id: "p", type: "agent", agent: "a", task: "same", cache: { scope: "cross-run" }, dependsOn: ["q"], final: true },
					{ id: "q", type: "agent", agent: "a", task: "extra" },
				]
			: [{ id: "p", type: "agent", agent: "a", task: "same", cache: { scope: "cross-run" }, final: true }],
	});
	const counter = { n: 0 };
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	await executeTaskflow(mkState(mk(false), dir), deps);
	assert.equal(counter.n, 1);
	// Same name + phaseId + task, but p's closure differs (q added as a dep) →
	// different sub-fingerprint → no cross-flow collision.
	await executeTaskflow(mkState(mk(true), dir), deps);
	assert.equal(counter.n, 3, "p misses (closure changed) and q runs");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("phasefp: shareContext falls back to whole-flow invalidation", async () => {
	const dir = tmpDir();
	const store = new CacheStore(dir);
	const mk = (bTask: string): Taskflow => ({
		name: "sharing-fallback",
		contextSharing: true,
		phases: [
			{ id: "A", type: "agent", agent: "a", task: "A", cache: { scope: "cross-run" } },
			{ id: "B", type: "agent", agent: "a", task: bTask, cache: { scope: "cross-run" }, final: true },
		],
	});
	const counter = { n: 0 };
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	await executeTaskflow(mkState(mk("B original"), dir), deps);
	assert.equal(counter.n, 2, "A + B run once");
	// With contextSharing, per-phase soundness cannot be guaranteed → both
	// phases fall back to the whole-flow flowDefHash. Editing B moves the
	// whole-flow hash → A ALSO misses (whole-flow invalidation, not per-phase).
	const r2 = await executeTaskflow(mkState(mk("B edited"), dir), deps);
	assert.equal(counter.n, 4, "both A and B re-run — whole-flow hash moved");
	assert.equal(r2.state.phases.A.cacheHit, undefined, "A NOT reused — fallback to whole-flow");
	assert.equal(r2.state.phases.B.cacheHit, undefined, "B missed (its task changed)");
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Hardening (risk review M-1 / L-1 / L-2): join:"any" soundness fallback, and
// operational/result-selection fields stripped to avoid false invalidation.
// ---------------------------------------------------------------------------

test("phaseFingerprint: a join:any phase falls back to whole-flow (soundness)", async () => {
	// C declares dependsOn [B] with join:any but interpolates {steps.A.output}.
	// Its real reads escape the static closure, so per-phase diffing is unsound →
	// fingerprint must be undefined (caller uses whole-flow flowDefHash).
	const def: Taskflow = {
		name: "join-any",
		phases: [
			{ id: "A", type: "agent", agent: "a", task: "produce" },
			{ id: "B", type: "agent", agent: "a", task: "fast" },
			{ id: "C", type: "agent", agent: "a", task: "use {steps.A.output}", dependsOn: ["B"], join: "any", final: true },
		],
	} as Taskflow;
	assert.equal(await phaseFingerprint(def, "C"), undefined, "join:any → fallback");
	// A and B are ordinary phases → still get a precise fingerprint.
	assert.ok(await phaseFingerprint(def, "A"));
	assert.ok(await phaseFingerprint(def, "B"));
});

test("phaseFingerprint: retry / concurrency / final do NOT move the sub-fingerprint", async () => {
	const mk = (extra: Record<string, unknown>): Taskflow => ({
		name: "ops-inv",
		phases: [
			{ id: "p", type: "agent", agent: "a", task: "t", cache: { scope: "cross-run" }, ...extra },
			{ id: "q", type: "agent", agent: "a", task: "u {steps.p.output}", dependsOn: ["p"], final: true },
		],
	}) as Taskflow;
	const base = await phaseFingerprint(mk({ final: true }), "p");
	// Adding retry/concurrency, or moving `final`, must not perturb p's output hash.
	assert.equal(await phaseFingerprint(mk({ final: true, retry: { max: 3 } }), "p"), base, "retry stripped");
	assert.equal(await phaseFingerprint(mk({ final: true, concurrency: 4 }), "p"), base, "concurrency stripped");
	assert.equal(await phaseFingerprint(mk({}), "p"), base, "final marker stripped");
});
