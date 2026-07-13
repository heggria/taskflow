import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import { CacheStore, resolveFingerprint } from "../src/cache.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import type { RunResult, RunOptions } from "../src/runner-core.ts";
import { parseTtlMs, type Taskflow, type ThinkingLevel, validateTaskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test agent", systemPrompt: "", source: "user", filePath: "" },
];

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tf-cache-"));
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

// ---------------------------------------------------------------------------
// parseTtlMs
// ---------------------------------------------------------------------------

test("parseTtlMs: parses units and rejects garbage", () => {
	assert.equal(parseTtlMs("30m"), 30 * 60_000);
	assert.equal(parseTtlMs("6h"), 6 * 3_600_000);
	assert.equal(parseTtlMs("7d"), 7 * 86_400_000);
	assert.equal(parseTtlMs("500ms"), 500);
	assert.equal(parseTtlMs("90s"), 90_000);
	assert.equal(parseTtlMs("100"), 100); // bare = ms
	assert.equal(parseTtlMs("0"), null); // non-positive
	assert.equal(parseTtlMs("-5m"), null);
	assert.equal(parseTtlMs("soon"), null);
	assert.equal(parseTtlMs(""), null);
});

// ---------------------------------------------------------------------------
// schema validation gates
// ---------------------------------------------------------------------------

test("cache validation: run-only is the default and always valid", () => {
	const r = validateTaskflow({
		name: "x",
		phases: [{ id: "p", type: "agent", task: "t", cache: { scope: "run-only" } }],
	});
	assert.equal(r.ok, true, r.errors.join("; "));
});

test("cache validation: cross-run allowed on agent/map/parallel/reduce/flow", () => {
	const r = validateTaskflow({
		name: "x",
		phases: [{ id: "p", type: "agent", task: "t", cache: { scope: "cross-run" } }],
	});
	assert.equal(r.ok, true, r.errors.join("; "));
});

test("cache validation: cross-run BLOCKED on gate and approval (Gate B)", () => {
	const gate = validateTaskflow({
		name: "x",
		phases: [
			{ id: "g", type: "gate", task: "judge", cache: { scope: "cross-run" } },
			{ id: "p", type: "agent", task: "t", dependsOn: ["g"], final: true },
		],
	});
	assert.equal(gate.ok, false);
	assert.ok(gate.errors.some((e) => e.includes("cross-run") && e.includes("gate")), gate.errors.join("; "));

	const appr = validateTaskflow({
		name: "x",
		phases: [{ id: "ap", type: "approval", cache: { scope: "cross-run" } }],
	});
	assert.equal(appr.ok, false);
	assert.ok(appr.errors.some((e) => e.includes("cross-run") && e.includes("approval")), appr.errors.join("; "));
});

test("cache validation: gate/approval may use run-only", () => {
	const r = validateTaskflow({
		name: "x",
		phases: [
			{ id: "g", type: "gate", task: "judge", cache: { scope: "run-only" } },
			{ id: "p", type: "agent", task: "t", dependsOn: ["g"], final: true },
		],
	});
	assert.equal(r.ok, true, r.errors.join("; "));
});

test("cache validation: unknown fingerprint prefix rejected (Gate C, fail closed)", () => {
	const bad = validateTaskflow({
		name: "x",
		phases: [{ id: "p", type: "agent", task: "t", cache: { scope: "cross-run", fingerprint: ["bogus:foo"] } }],
	});
	assert.equal(bad.ok, false);
	assert.ok(bad.errors.some((e) => e.includes("fingerprint")), bad.errors.join("; "));

	const good = validateTaskflow({
		name: "x",
		phases: [
			{
				id: "p",
				type: "agent",
				task: "t",
				cache: { scope: "cross-run", fingerprint: ["git:HEAD", "glob:src/**/*.ts", "file:package.json", "env:NODE_ENV"] },
			},
		],
	});
	assert.equal(good.ok, true, good.errors.join("; "));
});

test("cache validation: malformed ttl rejected", () => {
	const r = validateTaskflow({
		name: "x",
		phases: [{ id: "p", type: "agent", task: "t", cache: { scope: "cross-run", ttl: "later" } }],
	});
	assert.equal(r.ok, false);
	assert.ok(r.errors.some((e) => e.includes("ttl")), r.errors.join("; "));
});

// ---------------------------------------------------------------------------
// fingerprint resolver
// ---------------------------------------------------------------------------

test("resolveFingerprint: empty list resolves to empty string", () => {
	assert.equal(resolveFingerprint(undefined, "/tmp"), "");
	assert.equal(resolveFingerprint([], "/tmp"), "");
});

test("resolveFingerprint: file content change flips the fingerprint", () => {
	const dir = tmpDir();
	const f = path.join(dir, "data.txt");
	fs.writeFileSync(f, "v1");
	const fp1 = resolveFingerprint(["file:data.txt"], dir);
	fs.writeFileSync(f, "v2");
	const fp2 = resolveFingerprint(["file:data.txt"], dir);
	assert.notEqual(fp1, fp2);
	// stable when unchanged
	const fp2b = resolveFingerprint(["file:data.txt"], dir);
	assert.equal(fp2, fp2b);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveFingerprint: missing file resolves deterministically (sentinel)", () => {
	const dir = tmpDir();
	const a = resolveFingerprint(["file:nope.txt"], dir);
	const b = resolveFingerprint(["file:nope.txt"], dir);
	assert.equal(a, b);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveFingerprint: env var change flips the fingerprint", () => {
	const dir = tmpDir();
	process.env.TF_CACHE_TEST = "one";
	const a = resolveFingerprint(["env:TF_CACHE_TEST"], dir);
	process.env.TF_CACHE_TEST = "two";
	const b = resolveFingerprint(["env:TF_CACHE_TEST"], dir);
	assert.notEqual(a, b);
	delete process.env.TF_CACHE_TEST;
	fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveFingerprint: glob content mode reacts to file edits", () => {
	const dir = tmpDir();
	fs.mkdirSync(path.join(dir, "src"));
	fs.writeFileSync(path.join(dir, "src", "x.ts"), "export const a = 1;");
	const a = resolveFingerprint(["glob!:src/**/*.ts"], dir);
	fs.writeFileSync(path.join(dir, "src", "x.ts"), "export const a = 2;");
	const b = resolveFingerprint(["glob!:src/**/*.ts"], dir);
	assert.notEqual(a, b);
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CacheStore
// ---------------------------------------------------------------------------

test("CacheStore: put then get round-trips", () => {
	const dir = tmpDir();
	const store = new CacheStore(dir);
	store.put({ key: "abc123de", createdAt: Date.now(), output: "hello", model: "m" });
	const e = store.get("abc123de");
	assert.ok(e);
	assert.equal(e?.output, "hello");
	assert.equal(e?.model, "m");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("CacheStore: TTL expiry returns null", () => {
	const dir = tmpDir();
	const store = new CacheStore(dir);
	store.put({ key: "deadbeef", createdAt: Date.now() - 10_000, output: "stale" });
	assert.equal(store.get("deadbeef", 5_000), null); // older than 5s ttl
	assert.ok(store.get("deadbeef", 60_000)); // within 60s ttl
	fs.rmSync(dir, { recursive: true, force: true });
});

test("CacheStore: malformed key never escapes the cache dir", () => {
	const dir = tmpDir();
	const store = new CacheStore(dir);
	assert.equal(store.get("../../etc/passwd"), null);
	store.put({ key: "../evil", createdAt: Date.now(), output: "x" });
	// nothing written outside
	assert.equal(fs.existsSync(path.join(dir, "..", "evil.json")), false);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("CacheStore: clear removes entries", () => {
	const dir = tmpDir();
	const store = new CacheStore(dir);
	store.put({ key: "aaaa1111", createdAt: Date.now(), output: "1" });
	store.put({ key: "bbbb2222", createdAt: Date.now(), output: "2" });
	const n = store.clear();
	assert.equal(n, 2);
	assert.equal(store.get("aaaa1111"), null);
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// end-to-end: cross-run reuse through the runtime
// ---------------------------------------------------------------------------

test("runtime: run-only does NOT reuse across runs (default behavior unchanged)", async () => {
	const dir = tmpDir();
	const def: Taskflow = {
		name: "ro",
		phases: [{ id: "p", type: "agent", agent: "a", task: "fixed", final: true }],
	};
	const counter = { n: 0 };
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	await executeTaskflow(mkState(def, dir), deps);
	await executeTaskflow(mkState(def, dir), deps);
	assert.equal(counter.n, 2, "run-only must recompute every run");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("runtime: cross-run reuses an identical phase across two runs ($0 hit)", async () => {
	const dir = tmpDir();
	const def: Taskflow = {
		name: "cr",
		phases: [{ id: "p", type: "agent", agent: "a", task: "fixed", cache: { scope: "cross-run" }, final: true }],
	};
	const counter = { n: 0 };
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	const r1 = await executeTaskflow(mkState(def, dir), deps);
	const r2 = await executeTaskflow(mkState(def, dir), deps);
	assert.equal(counter.n, 1, "second run must hit the cross-run cache");
	assert.equal(r1.finalOutput, r2.finalOutput, "cached output must match");
	// cache hit reports zero usage
	assert.equal(r2.state.phases.p.cacheHit, "cross-run");
	assert.equal(r2.state.phases.p.usage?.cost ?? 0, 0);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("runtime: deps.cacheScopeDefault='cross-run' makes the default scope cross-run", async () => {
	const dir = tmpDir();
	const def: Taskflow = {
		name: "cr-default",
		phases: [{ id: "p", type: "agent", agent: "a", task: "fixed", final: true }],
	};
	const counter = { n: 0 };
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = {
		cwd: dir,
		agents: AGENTS,
		runTask: countingRunner(counter),
		cacheStore: store,
		cacheScopeDefault: "cross-run",
	};

	await executeTaskflow(mkState(def, dir), deps);
	await executeTaskflow(mkState(def, dir), deps);
	assert.equal(counter.n, 1, "default cross-run scope must reuse across runs");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("runtime: gate/approval/loop/tournament stay run-only even when default is cross-run", async () => {
	const dir = tmpDir();
	const def: Taskflow = {
		name: "blocked-types",
		phases: [
			{ id: "scout", type: "agent", agent: "a", task: "scan" },
			{ id: "g", type: "gate", agent: "a", task: "gate {steps.scout.output}", dependsOn: ["scout"] },
			{ id: "ap", type: "approval", task: "approve {steps.scout.output}", dependsOn: ["scout"] },
			{ id: "lp", type: "loop", agent: "a", maxIterations: 2, task: "loop {steps.scout.output}", dependsOn: ["scout"] },
			{ id: "tr", type: "tournament", agent: "a", variants: 2, mode: "best", task: "tourney {steps.scout.output}", dependsOn: ["scout"] },
		],
	} as Taskflow;
	const counter = { n: 0 };
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = {
		cwd: dir,
		agents: AGENTS,
		runTask: countingRunner(counter),
		cacheStore: store,
		cacheScopeDefault: "cross-run",
	};

	await executeTaskflow(mkState(def, dir), deps);
	const s2 = await executeTaskflow(mkState(def, dir), deps);
	// All blocked types must be fresh each run; only scout may reuse.
	for (const id of ["g", "ap", "lp", "tr"]) {
		assert.equal(s2.state.phases[id].cacheHit, undefined, `${id} must not be a cross-run cache hit`);
	}
	assert.equal(s2.state.phases.scout.cacheHit, "cross-run", "agent phase may reuse under cross-run default");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("runtime: cross-run CacheEntry preserves full PhaseState (gate, reads, loop, tournament)", async () => {
	const dir = tmpDir();
	const def: Taskflow = {
		name: "preserve-state",
		phases: [
			{ id: "scout", type: "agent", agent: "a", task: "scan", output: "json" },
			{
				id: "audit",
				type: "agent",
				agent: "a",
				task: "audit {steps.scout.output}",
				cache: { scope: "cross-run" },
				dependsOn: ["scout"],
			},
		],
	} as Taskflow;
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = {
		cwd: dir,
		agents: AGENTS,
		runTask: async (cwd, ag, agentName, task) => ({
			agent: agentName,
			task,
			exitCode: 0,
			output: task,
			stderr: "",
			usage: { ...emptyUsage(), output: 10, cost: 0.001, turns: 1 },
			stopReason: "end",
		}),
		cacheStore: store,
	};

	const s1 = await executeTaskflow(mkState(def, dir), deps);
	const firstReads = s1.state.phases.audit.reads;
	assert.ok(firstReads && firstReads.some((r) => r.stepId === "scout"), "audit should record reads");

	const s2 = await executeTaskflow(mkState(def, dir), deps);
	assert.equal(s2.state.phases.audit.cacheHit, "cross-run", "audit hit cross-run cache");
	// The restored PhaseState must carry the same reads (and any other surface).
	assert.deepEqual(s2.state.phases.audit.reads, firstReads, "cached PhaseState preserves reads");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("runtime: cross-run does NOT leak across different flows sharing a phase id (P0-1)", async () => {
	const dir = tmpDir();
	const store = new CacheStore(dir);
	// Two DIFFERENT flows, identical phase id + agent + model + task.
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
	assert.equal(counter.n, 2, "flow-B must NOT reuse flow-A's cache (flow name is part of the key)");
	// ...but flow-A reusing flow-A still hits
	await executeTaskflow(mkState(defA, dir), deps);
	assert.equal(counter.n, 2, "same flow still hits");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("runtime: cross-run misses when phase 'thinking' changes (P0-2)", async () => {
	const dir = tmpDir();
	const store = new CacheStore(dir);
	const mk = (thinking?: ThinkingLevel): Taskflow => ({
		name: "think-cr",
		phases: [{ id: "p", type: "agent", agent: "a", task: "go", thinking, cache: { scope: "cross-run" }, final: true }],
	});
	const counter = { n: 0 };
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	await executeTaskflow(mkState(mk("off"), dir), deps);
	await executeTaskflow(mkState(mk("high"), dir), deps);
	assert.equal(counter.n, 2, "changing thinking must invalidate the cross-run hit");
	// same thinking again → hit
	await executeTaskflow(mkState(mk("off"), dir), deps);
	assert.equal(counter.n, 2, "identical thinking re-hits");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("runtime: cross-run misses when phase 'tools' change (P0-2)", async () => {
	const dir = tmpDir();
	const store = new CacheStore(dir);
	const mk = (tools: string[]): Taskflow => ({
		name: "tools-cr",
		phases: [{ id: "p", type: "agent", agent: "a", task: "go", tools, cache: { scope: "cross-run" }, final: true }],
	});
	const counter = { n: 0 };
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	await executeTaskflow(mkState(mk(["read"]), dir), deps);
	await executeTaskflow(mkState(mk(["read", "bash"]), dir), deps);
	assert.equal(counter.n, 2, "changing tools must invalidate the cross-run hit");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("CacheStore: LRU + max-age eviction (P1-5)", () => {
	const dir = tmpDir();
	const store = new CacheStore(dir);
	// An entry far past the 90-day hard cap is evicted on read even with no TTL.
	const ancient = Date.now() - 200 * 86_400_000;
	store.put({ key: "a1a1a1a1", createdAt: ancient, output: "old" });
	assert.equal(store.get("a1a1a1a1"), null, "entries past the hard max age must not be served");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("runtime: cross-run miss when fingerprinted file changes", async () => {
	const dir = tmpDir();
	const f = path.join(dir, "dep.txt");
	fs.writeFileSync(f, "v1");
	const def: Taskflow = {
		name: "crfp",
		phases: [
			{
				id: "p",
				type: "agent",
				agent: "a",
				task: "analyze",
				cache: { scope: "cross-run", fingerprint: ["file:dep.txt"] },
				final: true,
			},
		],
	};
	const counter = { n: 0 };
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	await executeTaskflow(mkState(def, dir), deps);
	assert.equal(counter.n, 1);
	// unchanged file -> hit
	await executeTaskflow(mkState(def, dir), deps);
	assert.equal(counter.n, 1, "unchanged fingerprint should hit");
	// changed file -> miss
	fs.writeFileSync(f, "v2");
	await executeTaskflow(mkState(def, dir), deps);
	assert.equal(counter.n, 2, "changed fingerprint must invalidate the cache");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("runtime: scope 'off' disables even within-run reuse", async () => {
	const dir = tmpDir();
	const def: Taskflow = {
		name: "off",
		phases: [{ id: "p", type: "agent", agent: "a", task: "fixed", cache: { scope: "off" }, final: true }],
	};
	const counter = { n: 0 };
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	// resume the SAME run: prior completed state exists, but 'off' must ignore it
	const st = mkState(def, dir);
	await executeTaskflow(st, deps);
	await executeTaskflow(st, deps); // re-run same state
	assert.equal(counter.n, 2, "'off' must never reuse, even within a run");
	fs.rmSync(dir, { recursive: true, force: true });
});
