/**
 * Side-effect classification (`idempotent: false`) — behavioral matrix tests.
 *
 * The flag gates three EXISTING mechanisms (no new execution path):
 *   (a) transient-error auto-retry — suppressed (explicit retry{} stays honored)
 *   (b) all caching — within-run resume, cross-run serve AND store, map per-item
 *   (c) phase state — records `sideEffect: true` for audit
 * Default (absent / true) is byte-for-byte the historical behavior.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { validateTaskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import type { AgentConfig } from "../src/agents.ts";
import type { RunResult } from "../src/runner-core.ts";
import { emptyUsage } from "../src/usage.ts";
import { CacheStore } from "../src/cache.ts";

const dummyAgent: AgentConfig = { name: "default", model: "test/model", description: "dummy", systemPrompt: "", source: "user", filePath: "none" };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-idem-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function mkState(def: unknown, runId: string): RunState {
	return {
		runId,
		flowName: (def as { name: string }).name,
		def: def as RunState["def"],
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: tmpRoot,
	};
}

function ok(output: string): RunResult {
	return { agent: "default", task: "", exitCode: 0, output, stderr: "", usage: emptyUsage() };
}

function transientFail(): RunResult {
	return {
		agent: "default", task: "", exitCode: 1, output: "", stderr: "429 rate limit exceeded",
		usage: emptyUsage(), stopReason: "error", errorMessage: "429 rate limit exceeded, please retry",
	};
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("idempotent: non-boolean rejected; boolean accepted on all types", () => {
	const bad = validateTaskflow({ name: "x", phases: [{ id: "a", task: "t", idempotent: "no" }] });
	assert.equal(bad.ok, false);
	assert.ok(bad.errors.some((e) => e.includes("'idempotent' must be a boolean")));

	const good = validateTaskflow({
		name: "x",
		phases: [
			{ id: "a", task: "t", idempotent: false },
			{ id: "s", type: "script", run: "echo hi", idempotent: false, dependsOn: ["a"] },
		],
	});
	assert.equal(good.ok, true, good.errors.join("; "));
});

test("idempotent:false + cache.scope cross-run → warning (runtime overrides to off)", () => {
	const r = validateTaskflow({
		name: "x",
		phases: [{ id: "a", task: "t", idempotent: false, cache: { scope: "cross-run" } }],
	});
	assert.equal(r.ok, true);
	assert.ok(r.warnings.some((w) => w.includes("overrides cache.scope 'cross-run'")));
});

test("idempotent:false under incremental flow → informative warning", () => {
	const r = validateTaskflow({
		name: "x",
		incremental: true,
		phases: [{ id: "a", task: "t", idempotent: false }],
	});
	assert.equal(r.ok, true);
	assert.ok(r.warnings.some((w) => w.includes("excluded from caching")));
});

// ---------------------------------------------------------------------------
// (a) Transient retry suppressed; explicit retry honored
// ---------------------------------------------------------------------------

test("idempotent:false suppresses transient auto-retry (exactly 1 attempt)", async () => {
	let calls = 0;
	const def = { name: "no-transient", phases: [{ id: "a", task: "post webhook", idempotent: false }] };
	const state = mkState(def, "idem-t1");
	const deps: RuntimeDeps = {
		cwd: tmpRoot, agents: [dummyAgent],
		runTask: async () => { calls++; return transientFail(); },
	};
	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, false);
	assert.equal(calls, 1, "a transient error on a non-idempotent phase must NOT be auto-retried");
});

test("default (idempotent absent) keeps transient auto-retry (multiple attempts)", async () => {
	let calls = 0;
	const def = { name: "yes-transient", phases: [{ id: "a", task: "query api" }] };
	const state = mkState(def, "idem-t2");
	const deps: RuntimeDeps = {
		cwd: tmpRoot, agents: [dummyAgent],
		runTask: async () => { calls++; return transientFail(); },
	};
	await executeTaskflow(state, deps);
	assert.ok(calls > 1, `transient retry must stay on by default (got ${calls} attempts)`);
});

test("idempotent:false honors explicit retry{} (author-declared repeats)", async () => {
	let calls = 0;
	const def = {
		name: "explicit-retry",
		phases: [{ id: "a", task: "retryable side effect", idempotent: false, retry: { max: 2, backoffMs: 0 } }],
	};
	const state = mkState(def, "idem-t3");
	const deps: RuntimeDeps = {
		cwd: tmpRoot, agents: [dummyAgent],
		runTask: async () => { calls++; return transientFail(); },
	};
	await executeTaskflow(state, deps);
	assert.equal(calls, 3, "explicit retry{max:2} = 3 attempts, even for idempotent:false");
});

// ---------------------------------------------------------------------------
// (b) Caching fully disabled
// ---------------------------------------------------------------------------

test("idempotent:false never serves within-run resume (re-runs on resume)", async () => {
	let calls = 0;
	const def = { name: "no-resume", phases: [{ id: "a", task: "side effect", idempotent: false }] };
	const state = mkState(def, "idem-c1");
	const deps: RuntimeDeps = {
		cwd: tmpRoot, agents: [dummyAgent],
		runTask: async () => { calls++; return ok("done-" + calls); },
	};
	await executeTaskflow(state, deps);
	assert.equal(calls, 1);
	// Resume the same state: an idempotent phase would cache-hit; this must re-run.
	state.status = "running";
	await executeTaskflow(state, deps);
	assert.equal(calls, 2, "resume must RE-RUN a non-idempotent phase (no within-run cache)");
	assert.equal(state.phases["a"]?.cacheHit, undefined, "no cacheHit marker on a side-effecting phase");
});

test("default keeps within-run resume (control for the test above)", async () => {
	let calls = 0;
	const def = { name: "yes-resume", phases: [{ id: "a", task: "pure computation" }] };
	const state = mkState(def, "idem-c2");
	const deps: RuntimeDeps = {
		cwd: tmpRoot, agents: [dummyAgent],
		runTask: async () => { calls++; return ok("done"); },
	};
	await executeTaskflow(state, deps);
	state.status = "running";
	await executeTaskflow(state, deps);
	assert.equal(calls, 1, "an idempotent phase must cache-hit on resume");
});

test("idempotent:false never stores to nor serves from the cross-run cache", async () => {
	const cacheDir = fs.mkdtempSync(path.join(tmpRoot, "cc-"));
	const store = new CacheStore(cacheDir);
	let calls = 0;
	const def = {
		name: "no-cross",
		phases: [{ id: "a", task: "deploy", idempotent: false, cache: { scope: "cross-run" } }],
	};
	const deps: RuntimeDeps = {
		cwd: tmpRoot, agents: [dummyAgent], cacheStore: store,
		runTask: async () => { calls++; return ok("deployed"); },
	};
	await executeTaskflow(mkState(def, "idem-c3a"), deps);
	assert.equal(calls, 1);
	// Fresh run, same flow: a cross-run cacheable phase would hit; this must re-run.
	const state2 = mkState(def, "idem-c3b");
	await executeTaskflow(state2, deps);
	assert.equal(calls, 2, "second run must RE-RUN (nothing was stored, nothing served)");
	assert.equal(state2.phases["a"]?.cacheHit, undefined);
});

test("incremental flow: idempotent:false phase re-runs while sibling is cached", async () => {
	const cacheDir = fs.mkdtempSync(path.join(tmpRoot, "ci-"));
	const store = new CacheStore(cacheDir);
	const calls: Record<string, number> = { pure: 0, effect: 0 };
	const def = {
		name: "inc-mix",
		incremental: true,
		phases: [
			{ id: "pure", task: "analyze" },
			{ id: "effect", task: "notify", idempotent: false, dependsOn: ["pure"] },
		],
	};
	const deps: RuntimeDeps = {
		cwd: tmpRoot, agents: [dummyAgent], cacheStore: store, cacheScopeDefault: "cross-run",
		runTask: async (_c, _a, _n, task) => {
			calls[task.includes("analyze") ? "pure" : "effect"]++;
			return ok("out");
		},
	};
	await executeTaskflow(mkState(def, "idem-c4a"), deps);
	await executeTaskflow(mkState(def, "idem-c4b"), deps);
	assert.equal(calls.pure, 1, "the pure phase must be served cross-run on the 2nd run");
	assert.equal(calls.effect, 2, "the side-effecting phase must RE-RUN on the 2nd run");
});

// ---------------------------------------------------------------------------
// (c) Phase state marker
// ---------------------------------------------------------------------------

test("sideEffect marker: set on done AND failed, not on skipped, absent by default", async () => {
	const def = {
		name: "markers",
		phases: [
			{ id: "eff-done", task: "works", idempotent: false },
			{ id: "eff-fail", task: "breaks", idempotent: false, optional: true },
			{ id: "eff-skip", task: "never", idempotent: false, when: "{args.nope} == yes" },
			{ id: "plain", task: "normal" },
		],
	};
	const state = mkState(def, "idem-m1");
	const deps: RuntimeDeps = {
		cwd: tmpRoot, agents: [dummyAgent],
		runTask: async (_c, _a, _n, task) => {
			if (task.includes("breaks"))
				return { ...ok(""), exitCode: 1, stopReason: "error" as const, errorMessage: "hard failure" };
			return ok("fine");
		},
	};
	await executeTaskflow(state, deps);
	assert.equal(state.phases["eff-done"]?.sideEffect, true, "done side-effect phase carries the marker");
	assert.equal(state.phases["eff-fail"]?.sideEffect, true, "failed side-effect phase carries the marker");
	assert.equal(state.phases["eff-skip"]?.sideEffect, undefined, "a skipped phase ran nothing — no marker");
	assert.equal(state.phases["plain"]?.sideEffect, undefined, "default phases carry no marker");
});
