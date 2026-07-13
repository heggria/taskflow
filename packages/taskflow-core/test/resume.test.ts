/**
 * Resume overrides + immutable history — 0.2.0 dogfood issue 5.
 *
 * `forkRunForResume` creates a NEW RunState (new runId + parentRunId); the
 * parent is never mutated. `validateResumeOverrides` checks the target phase
 * exists + at least one override + the patched def passes the Taskflow
 * validator. `applyResumeOverrides` patches the child def only. Completed
 * unaffected phases are reused; the target + transitive downstream re-run.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	forkRunForResume,
	applyResumeOverrides,
	validateResumeOverrides,
	transitiveDownstream,
	type ResumeOverrides,
} from "../src/resume.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import type { AgentConfig } from "../src/agents.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { emptyUsage } from "../src/usage.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { saveRun, loadRun, runsDir } from "../src/store.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const AGENTS: AgentConfig[] = [{ name: "a", description: "t", systemPrompt: "", source: "user", filePath: "" }];

function mkState(def: Taskflow, args: Record<string, unknown> = {}): RunState {
	return {
		runId: "parent-run",
		flowName: def.name,
		def,
		args,
		status: "running",
		phases: {},
		createdAt: 1,
		updatedAt: 1,
		cwd: "/tmp",
		host: "pi",
	};
}

function mockRunner(respond: (task: string) => string, fail?: (task: string) => boolean): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, n, task, _o: RunOptions): Promise<RunResult> => {
		const f = fail?.(task) ?? false;
		return {
			agent: n, task, exitCode: f ? 1 : 0, output: f ? "" : respond(task), stderr: f ? "boom" : "",
			usage: { ...emptyUsage(), output: 5, turns: 1 }, stopReason: f ? "error" : "end",
			errorMessage: f ? "boom" : undefined,
		};
	};
}
function deps(runTask: RuntimeDeps["runTask"]): RuntimeDeps {
	return { cwd: "/tmp", agents: AGENTS, runTask, persist: () => {}, onProgress: () => {} };
}

// A 3-phase chain: a → b → c (final). b fails on the parent run.
const CHAIN: Taskflow = {
	name: "resume-chain",
	phases: [
		{ id: "a", type: "agent", agent: "a", task: "do-a" },
		{ id: "b", type: "agent", agent: "a", task: "do-b", dependsOn: ["a"] },
		{ id: "c", type: "agent", agent: "a", task: "do-c", dependsOn: ["b"], final: true },
	],
};

// ---------------------------------------------------------------------------
// transitiveDownstream
// ---------------------------------------------------------------------------

test("transitiveDownstream: returns all dependents of the target (transitive)", () => {
	const ds = transitiveDownstream(CHAIN.phases, "a");
	assert.deepEqual(ds, ["b", "c"]);
});

test("transitiveDownstream: a leaf has no downstream", () => {
	assert.deepEqual(transitiveDownstream(CHAIN.phases, "c"), []);
});

// ---------------------------------------------------------------------------
// forkRunForResume — immutability + reuse
// ---------------------------------------------------------------------------

function parentDoneABFailedC(): RunState {
	const state = mkState(CHAIN);
	state.phases = {
		a: { id: "a", status: "done", output: "OUT-A", inputHash: "ha" },
		b: { id: "b", status: "failed", error: "boom", inputHash: "hb" },
		// c was never reached (skipped because b failed)
		c: { id: "c", status: "skipped", error: "upstream", inputHash: "hc" },
	};
	state.status = "failed";
	return state;
}

test("forkRunForResume: child has a new runId + parentRunId, parent untouched", () => {
	const prev = parentDoneABFailedC();
	const prevJson = JSON.stringify(prev);
	const child = forkRunForResume(prev);
	assert.notEqual(child.runId, prev.runId);
	assert.equal(child.parentRunId, prev.runId);
	assert.equal(child.status, "running");
	// Parent is NOT mutated.
	assert.equal(JSON.stringify(prev), prevJson);
	assert.equal(prev.runId, "parent-run");
});

test("forkRunForResume: ordinary resume (no overrides) copies done phases, omits failed/skipped", () => {
	const prev = parentDoneABFailedC();
	const child = forkRunForResume(prev);
	assert.deepEqual(Object.keys(child.phases), ["a"]); // only done phase copied
	assert.equal(child.phases.a.status, "done");
	assert.equal(child.phases.a.output, "OUT-A");
});

test("forkRunForResume: with overrides, target + downstream are cleared (omitted)", () => {
	const prev = parentDoneABFailedC();
	const ov: ResumeOverrides = { phaseId: "b", task: "retry-b" };
	const child = forkRunForResume(prev, { overrides: ov });
	// a is done and NOT downstream of b → kept. b + c (downstream) → cleared.
	assert.deepEqual(Object.keys(child.phases), ["a"]);
	assert.equal(child.phases.a.status, "done");
});

test("forkRunForResume: with overrides targeting a, ALL of a/b/c re-run (a is upstream)", () => {
	const prev = parentDoneABFailedC();
	const ov: ResumeOverrides = { phaseId: "a", task: "redo-a" };
	const child = forkRunForResume(prev, { overrides: ov });
	// a is the target, b + c are downstream → all cleared.
	assert.deepEqual(Object.keys(child.phases), []);
});

test("forkRunForResume: child def is a deep clone — mutating child does not affect parent", () => {
	const prev = parentDoneABFailedC();
	const ov: ResumeOverrides = { phaseId: "b", task: "patched-b" };
	const child = forkRunForResume(prev, { overrides: ov });
	const parentBTask = prev.def.phases[1]!.task;
	assert.equal(parentBTask, "do-b"); // parent unchanged
	assert.equal(child.def.phases[1]!.task, "patched-b"); // child patched
});

test("forkRunForResume: carries identity metadata (host) onto the child", () => {
	const prev = parentDoneABFailedC();
	const child = forkRunForResume(prev);
	assert.equal(child.host, "pi");
	assert.equal(child.parentRunId, "parent-run");
});

// ---------------------------------------------------------------------------
// applyResumeOverrides + validateResumeOverrides
// ---------------------------------------------------------------------------

test("applyResumeOverrides: patches task/model/timeout on the child def only", () => {
	const ov: ResumeOverrides = { phaseId: "b", task: "new-b", model: "gpt-5", timeout: 5000 };
	const childDef = applyResumeOverrides(CHAIN, ov);
	assert.equal(childDef.phases[1]!.task, "new-b");
	assert.equal(childDef.phases[1]!.model, "gpt-5");
	assert.equal(childDef.phases[1]!.timeout, 5000);
	// Parent untouched.
	assert.equal(CHAIN.phases[1]!.task, "do-b");
	assert.equal(CHAIN.phases[1]!.model, undefined);
});

test("validateResumeOverrides: requires phaseId", () => {
	const prev = parentDoneABFailedC();
	const v = validateResumeOverrides(prev, { phaseId: "" } as ResumeOverrides);
	assert.equal(v.ok, false);
	assert.match(v.errors.join(";"), /require a 'phaseId'/);
});

test("validateResumeOverrides: phase must exist", () => {
	const prev = parentDoneABFailedC();
	const v = validateResumeOverrides(prev, { phaseId: "nope", task: "x" });
	assert.equal(v.ok, false);
	assert.match(v.errors.join(";"), /not found/);
});

test("validateResumeOverrides: at least one override field required", () => {
	const prev = parentDoneABFailedC();
	const v = validateResumeOverrides(prev, { phaseId: "b" });
	assert.equal(v.ok, false);
	assert.match(v.errors.join(";"), /at least one/);
});

test("validateResumeOverrides: bad timeout rejected", () => {
	const prev = parentDoneABFailedC();
	const v = validateResumeOverrides(prev, { phaseId: "b", timeout: 50 });
	assert.equal(v.ok, false);
	assert.match(v.errors.join(";"), /timeout.*>= 1000/);
});

test("validateResumeOverrides: valid override passes", () => {
	const prev = parentDoneABFailedC();
	const v = validateResumeOverrides(prev, { phaseId: "b", task: "retry-b" });
	assert.equal(v.ok, true, v.errors.join(";"));
});

// ---------------------------------------------------------------------------
// e2e: resume forks a new run; completed phase reused, target+downstream rerun
// ---------------------------------------------------------------------------

test("e2e: resume re-runs the failed phase + downstream, reuses the done phase", async () => {
	// Parent run: a done, b fails, c skipped.
	const parent = mkState(CHAIN);
	const parentRes = await executeTaskflow(parent, deps(mockRunner((t) => `OUT:${t}`, (t) => t === "do-b")));
	assert.equal(parentRes.ok, false);
	assert.equal(parent.phases.a.status, "done");
	assert.equal(parent.phases.b.status, "failed");
	assert.equal(parent.phases.c.status, "skipped");
	const parentJson = JSON.stringify(parent);

	// Resume: override-resume targeting b (patched task so it re-runs), c reruns.
	const ov: ResumeOverrides = { phaseId: "b", task: "retry-b" };
	const v = validateResumeOverrides(parent, ov);
	assert.equal(v.ok, true, v.errors.join(";"));
	const child = forkRunForResume(parent, { overrides: ov });
	// Parent untouched (object + would-be-persisted JSON).
	assert.equal(JSON.stringify(parent), parentJson);
	// Child reuses a (done), re-runs b + c (downstream of b).
	assert.deepEqual(Object.keys(child.phases), ["a"]);
	const childRes = await executeTaskflow(child, deps(mockRunner((t) => `OUT:${t}`)));
	assert.equal(childRes.ok, true);
	assert.equal(child.phases.a.cacheHit, "run-only"); // reused (within-run resume)
	assert.equal(child.phases.b.status, "done");
	assert.equal(child.phases.c.status, "done");
	assert.equal(childRes.finalOutput, "OUT:do-c");
	assert.notEqual(child.runId, parent.runId);
	assert.equal(child.parentRunId, parent.runId);
});

test("e2e: ordinary resume (no overrides) forks a new run and re-runs non-done", async () => {
	const parent = mkState(CHAIN);
	await executeTaskflow(parent, deps(mockRunner((t) => `OUT:${t}`, (t) => t === "do-b")));
	const parentJson = JSON.stringify(parent);
	// Ordinary resume — no overrides.
	const child = forkRunForResume(parent);
	assert.equal(JSON.stringify(parent), parentJson); // parent untouched
	assert.deepEqual(Object.keys(child.phases), ["a"]); // only done reused
	const childRes = await executeTaskflow(child, deps(mockRunner((t) => `OUT:${t}`)));
	assert.equal(childRes.ok, true);
	assert.equal(child.phases.a.cacheHit, "run-only");
	assert.equal(child.phases.b.status, "done");
	assert.equal(child.phases.c.status, "done");
});

// ---------------------------------------------------------------------------
// Persistence immutability: the parent run FILE is never overwritten.
// ---------------------------------------------------------------------------

test("persisted: parent run file is not modified after a resume fork", async () => {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tf-resume-"));
	try {
		// Run a parent flow that fails at b, persist it.
		const parentDef: Taskflow = {
			name: "persist-resume",
			phases: [
				{ id: "a", type: "agent", agent: "a", task: "do-a" },
				{ id: "b", type: "agent", agent: "a", task: "do-b", dependsOn: ["a"], final: true },
			],
		};
		const parent = { ...mkState(parentDef), cwd: dir };
		const parentRes = await executeTaskflow(parent, {
			...deps(mockRunner((t) => `OUT:${t}`, (t) => t === "do-b")),
			cwd: dir,
			persist: (s) => saveRun(s),
		});
		assert.equal(parentRes.ok, false);
		const parentFile = path.join(runsDir(dir), "persist-resume", `${parent.runId}.json`);
		const parentJsonBefore = fs.readFileSync(parentFile, "utf8");

		// Resume: fork + re-run (succeeds now).
		const child = forkRunForResume(parent, { cwd: dir });
		await executeTaskflow(child, {
			...deps(mockRunner((t) => `OUT:${t}`)),
			cwd: dir,
			persist: (s) => saveRun(s),
		});

		// The parent file must be byte-identical after the resume.
		const parentJsonAfter = fs.readFileSync(parentFile, "utf8");
		assert.equal(parentJsonAfter, parentJsonBefore);
		// The child run got its own file.
		const childFile = path.join(runsDir(dir), "persist-resume", `${child.runId}.json`);
		assert.ok(fs.existsSync(childFile), "child run file exists");
		const childState = loadRun(dir, child.runId)!;
		assert.equal(childState.parentRunId, parent.runId);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
