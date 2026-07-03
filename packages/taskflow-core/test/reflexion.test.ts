/**
 * Reflexion memory in loops (`reflexion: true`) — failure-continuation
 * semantics, {reflexion} injection, auto-append, sentinel, size cap, and the
 * backward-compat invariant (reflexion off = historical behavior).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { validateTaskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import type { AgentConfig } from "../src/agents.ts";
import type { RunResult } from "../src/runner-core.ts";
import { emptyUsage } from "../src/usage.ts";
import {
	buildReflexionSummary,
	extractContractDiagnostics,
	isContractViolation,
	REFLEXION_MAX_CHARS,
	REFLEXION_SENTINEL,
} from "../src/reflexion.ts";

const dummyAgent: AgentConfig = { name: "default", model: "test/model", description: "dummy", systemPrompt: "", source: "user", filePath: "none" };

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
		cwd: "/tmp/test-reflexion",
	};
}

function ok(output: string): RunResult {
	return { agent: "default", task: "", exitCode: 0, output, stderr: "", usage: emptyUsage() };
}

function hardFail(msg: string): RunResult {
	return { agent: "default", task: "", exitCode: 1, output: "", stderr: msg, usage: emptyUsage(), stopReason: "error", errorMessage: msg };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("buildReflexionSummary: contract violation carries per-path diagnostics", () => {
	const s = buildReflexionSummary({
		iteration: 2,
		outcome: "contract-violation",
		output: '{"wrong": 1}',
		errorMessage: "Output contract violated:\n- $.score: required key is missing\n- $.done: required key is missing",
	});
	assert.ok(s.includes("Reflexion: iteration 2"));
	assert.ok(s.includes("output contract violated"));
	assert.ok(s.includes("$.score: required key is missing"));
	assert.ok(s.includes("$.done: required key is missing"));
	assert.ok(s.includes('{"wrong": 1}'));
});

test("buildReflexionSummary: until-not-met shows the stop condition", () => {
	const s = buildReflexionSummary({
		iteration: 1,
		outcome: "until-not-met",
		output: "partial work",
		until: "{steps.refine.json.done} == true",
	});
	assert.ok(s.includes("stop condition was not met"));
	assert.ok(s.includes("{steps.refine.json.done} == true"));
	assert.ok(s.includes("partial work"));
});

test("buildReflexionSummary: respects the size cap (huge output truncated)", () => {
	const s = buildReflexionSummary({
		iteration: 3,
		outcome: "subagent-error",
		output: "x".repeat(50_000),
		errorMessage: "boom",
	});
	assert.ok(s.length <= REFLEXION_MAX_CHARS, `summary is ${s.length} chars, cap is ${REFLEXION_MAX_CHARS}`);
	assert.ok(s.includes("truncated"));
});

test("extractContractDiagnostics / isContractViolation: classification", () => {
	const msg = "Output contract violated:\n- $.a: expected number, got string";
	assert.equal(isContractViolation(msg), true);
	assert.deepEqual(extractContractDiagnostics(msg), ["$.a: expected number, got string"]);
	assert.equal(isContractViolation("some other error"), false);
	assert.deepEqual(extractContractDiagnostics("some other error"), []);
	assert.deepEqual(extractContractDiagnostics(undefined), []);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("validateTaskflow: reflexion only on loops; must be boolean", () => {
	const notLoop = validateTaskflow({ name: "x", phases: [{ id: "a", task: "t", reflexion: true }] });
	assert.equal(notLoop.ok, false);
	assert.ok(notLoop.errors.some((e) => e.includes("only valid for loop")));

	const notBool = validateTaskflow({ name: "x", phases: [{ id: "a", type: "loop", task: "t", until: "{steps.a.output} == done", reflexion: "yes" }] });
	assert.equal(notBool.ok, false);
	assert.ok(notBool.errors.some((e) => e.includes("must be a boolean")));

	const good = validateTaskflow({ name: "x", phases: [{ id: "a", type: "loop", task: "t {reflexion}", until: "{steps.a.output} == done", reflexion: true }] });
	assert.equal(good.ok, true, good.errors.join("; "));

	// reflexion: false is tolerated anywhere (a no-op, not worth failing a flow over)
	const offElsewhere = validateTaskflow({ name: "x", phases: [{ id: "a", task: "t", reflexion: false }] });
	assert.equal(offElsewhere.ok, true);
});

// ---------------------------------------------------------------------------
// Runtime: backward compat
// ---------------------------------------------------------------------------

test("reflexion off: body failure still terminates the loop (historical behavior)", async () => {
	let calls = 0;
	const def = {
		name: "no-reflexion",
		phases: [{ id: "l", type: "loop", task: "work", until: "{steps.l.output} == done", maxIterations: 5 }],
	};
	const state = mkState(def, "rfx-1");
	const deps: RuntimeDeps = {
		cwd: "/tmp", agents: [dummyAgent],
		runTask: async () => { calls++; return hardFail("iteration blew up"); },
	};
	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, false);
	assert.equal(calls, 1, "without reflexion the first failure terminates the loop");
	assert.equal(state.phases["l"]?.loop?.stop, "failed");
});

test("reflexion off: {reflexion} placeholder stays literal (missing-ref warning path)", async () => {
	let seenTask = "";
	const def = {
		name: "literal-placeholder",
		phases: [{ id: "l", type: "loop", task: "work {reflexion}", until: "{steps.l.output} == done", maxIterations: 2 }],
	};
	const state = mkState(def, "rfx-2");
	const deps: RuntimeDeps = {
		cwd: "/tmp", agents: [dummyAgent],
		runTask: async (_c, _a, _n, task) => { seenTask = task; return ok("done"); },
	};
	await executeTaskflow(state, deps);
	assert.ok(seenTask.includes("{reflexion}"), "without reflexion:true the placeholder must stay intact");
});

// ---------------------------------------------------------------------------
// Runtime: reflexion on
// ---------------------------------------------------------------------------

test("reflexion on: iteration 1 sees the sentinel via {reflexion}", async () => {
	const tasks: string[] = [];
	const def = {
		name: "sentinel",
		phases: [{ id: "l", type: "loop", task: "work\n{reflexion}", until: "{steps.l.output} == done", maxIterations: 3, reflexion: true }],
	};
	const state = mkState(def, "rfx-3");
	const deps: RuntimeDeps = {
		cwd: "/tmp", agents: [dummyAgent],
		runTask: async (_c, _a, _n, task) => { tasks.push(task); return ok("done"); },
	};
	await executeTaskflow(state, deps);
	assert.equal(tasks.length, 1);
	assert.ok(tasks[0].includes(REFLEXION_SENTINEL), "iteration 1 must see the sentinel, not a literal placeholder");
});

test("reflexion on: body failure becomes feedback — loop continues and converges", async () => {
	const tasks: string[] = [];
	let calls = 0;
	const def = {
		name: "continue-past-failure",
		phases: [{
			id: "l", type: "loop", task: "produce json\n{reflexion}",
			until: "{steps.l.output} == done", maxIterations: 4, reflexion: true,
		}],
	};
	const state = mkState(def, "rfx-4");
	const deps: RuntimeDeps = {
		cwd: "/tmp", agents: [dummyAgent],
		runTask: async (_c, _a, _n, task) => {
			tasks.push(task);
			calls++;
			// iteration 1 fails hard; iteration 2 succeeds
			if (calls === 1) return hardFail("first attempt crashed: missing tool");
			return ok("done");
		},
	};
	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, true, "the loop must survive the iteration-1 failure");
	assert.equal(calls, 2);
	assert.equal(state.phases["l"]?.loop?.stop, "until");
	// Iteration 2's prompt must carry the failure signal.
	assert.ok(tasks[1].includes("Reflexion: iteration 1"), "iteration 2 must reflect on iteration 1");
	assert.ok(tasks[1].includes("first attempt crashed"), "the actual error must be in the reflexion block");
});

test("reflexion on: contract violation feeds precise diagnostics to the next iteration", async () => {
	const tasks: string[] = [];
	let calls = 0;
	const def = {
		name: "contract-feed",
		phases: [{
			id: "l", type: "loop", task: "emit json\n{reflexion}", output: "json",
			expect: { type: "object", required: ["score", "done"] },
			until: "{steps.l.json.done} == true", maxIterations: 4, reflexion: true,
		}],
	};
	const state = mkState(def, "rfx-5");
	const deps: RuntimeDeps = {
		cwd: "/tmp", agents: [dummyAgent],
		runTask: async (_c, _a, _n, task) => {
			tasks.push(task);
			calls++;
			if (calls === 1) return ok('{"score": 1}'); // violates: done missing
			return ok('{"score": 1, "done": true}');
		},
	};
	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, true);
	assert.equal(calls, 2);
	assert.ok(tasks[1].includes("$.done: required key is missing"), `iteration 2 must see the contract diagnostic; got:\n${tasks[1]}`);
});

test("reflexion on: until-not-met success also reflects (not only failures)", async () => {
	const tasks: string[] = [];
	let calls = 0;
	const def = {
		name: "until-reflect",
		phases: [{
			id: "l", type: "loop", task: "refine\n{reflexion}",
			until: "{steps.l.json.status} == final", maxIterations: 3, reflexion: true,
		}],
	};
	const state = mkState(def, "rfx-6");
	const deps: RuntimeDeps = {
		cwd: "/tmp", agents: [dummyAgent],
		runTask: async (_c, _a, _n, task) => {
			tasks.push(task);
			calls++;
			return ok(calls === 1 ? '{"status": "draft", "note": "draft v1"}' : '{"status": "final"}');
		},
	};
	await executeTaskflow(state, deps);
	assert.equal(calls, 2);
	assert.ok(tasks[1].includes("stop condition was not met"), "a successful-but-not-done iteration must also reflect");
	assert.ok(tasks[1].includes("draft v1"), "prior output must be visible");
});

test("reflexion on: auto-append when the task lacks {reflexion} + one-time warning", async () => {
	const tasks: string[] = [];
	let calls = 0;
	const def = {
		name: "auto-append",
		phases: [{
			id: "l", type: "loop", task: "plain body without placeholder",
			until: "{steps.l.output} == done", maxIterations: 3, reflexion: true,
		}],
	};
	const state = mkState(def, "rfx-7");
	const deps: RuntimeDeps = {
		cwd: "/tmp", agents: [dummyAgent],
		runTask: async (_c, _a, _n, task) => {
			tasks.push(task);
			calls++;
			if (calls === 1) return hardFail("crash one");
			return ok("done");
		},
	};
	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, true);
	assert.ok(!tasks[0].includes("Reflexion:"), "iteration 1 gets no appended block (sentinel only resolves the placeholder)");
	assert.ok(tasks[1].includes("Reflexion: iteration 1"), "the summary must be auto-appended");
	assert.ok(state.phases["l"]?.warnings?.some((w) => w.includes("auto-appended")), "author gets a one-time warning");
});

test("reflexion on: exhausted with last iteration failed → phase fails (reflexion defers, not erases)", async () => {
	let calls = 0;
	const def = {
		name: "exhaust-fail",
		phases: [{
			id: "l", type: "loop", task: "try\n{reflexion}",
			until: "{steps.l.output} == done", maxIterations: 3, reflexion: true,
		}],
	};
	const state = mkState(def, "rfx-8");
	const deps: RuntimeDeps = {
		cwd: "/tmp", agents: [dummyAgent],
		runTask: async () => { calls++; return hardFail(`attempt ${calls} failed`); },
	};
	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, false, "an exhausted always-failing reflexion loop is a failure");
	assert.equal(calls, 3, "all iterations were spent (feedback given each time)");
	assert.equal(state.phases["l"]?.loop?.stop, "failed");
	assert.ok(state.phases["l"]?.error?.includes("attempt 3 failed"), "the LAST failure is reported");
});

test("reflexion on: exhausted but last iteration succeeded → done (not failed)", async () => {
	let calls = 0;
	const def = {
		name: "exhaust-ok",
		phases: [{
			id: "l", type: "loop", task: "try\n{reflexion}",
			until: "{steps.l.json.done} == true", maxIterations: 2, reflexion: true, convergence: false,
		}],
	};
	const state = mkState(def, "rfx-9");
	const deps: RuntimeDeps = {
		cwd: "/tmp", agents: [dummyAgent],
		runTask: async () => { calls++; return ok(`{"done": false, "n": ${calls}}`); },
	};
	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, true, "maxIterations with a successful last iteration is done, not failed");
	assert.equal(state.phases["l"]?.loop?.stop, "maxIterations");
	assert.equal(state.phases["l"]?.output, '{"done": false, "n": 2}');
});

test("reflexion on: phase timeout still hard-stops the loop", async () => {
	let calls = 0;
	const def = {
		name: "timeout-stops",
		phases: [{
			id: "l", type: "loop", task: "slow\n{reflexion}", timeout: 1000,
			until: "{steps.l.output} == done", maxIterations: 5, reflexion: true,
		}],
	};
	const state = mkState(def, "rfx-10");
	const deps: RuntimeDeps = {
		cwd: "/tmp", agents: [dummyAgent],
		runTask: async (_c, _a, _n, _t, opts) => {
			calls++;
			// Simulate a subagent that only returns when aborted (timeout fires).
			await new Promise<void>((resolve) => {
				opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
				setTimeout(resolve, 5_000).unref?.();
			});
			return hardFail("aborted");
		},
	};
	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, false);
	assert.equal(calls, 1, "a timed-out iteration must NOT continue as feedback (hard stop)");
	assert.equal(state.phases["l"]?.timedOut, true);
});

test("reflexion on: audit trail — the last summary is persisted on ps.loop.reflexion", async () => {
	let calls = 0;
	const def = {
		name: "audit",
		phases: [{
			id: "l", type: "loop", task: "try\n{reflexion}",
			until: "{steps.l.output} == done", maxIterations: 3, reflexion: true,
		}],
	};
	const state = mkState(def, "rfx-11");
	const deps: RuntimeDeps = {
		cwd: "/tmp", agents: [dummyAgent],
		runTask: async () => {
			calls++;
			if (calls === 1) return hardFail("first crash");
			return ok("done");
		},
	};
	await executeTaskflow(state, deps);
	assert.ok(state.phases["l"]?.loop?.reflexion?.includes("first crash"), "the injected summary must be inspectable post-run");
});

test("reflexion on: convergence check still uses successful outputs only", async () => {	let calls = 0;
	const def = {
		name: "converge",
		phases: [{
			id: "l", type: "loop", task: "stabilize\n{reflexion}",
			until: "{steps.l.json.done} == true", maxIterations: 6, reflexion: true,
		}],
	};
	const state = mkState(def, "rfx-12");
	const deps: RuntimeDeps = {
		cwd: "/tmp", agents: [dummyAgent],
		runTask: async () => {
			calls++;
			if (calls === 2) return hardFail("blip"); // a failure between two identical outputs
			return ok('{"done": false, "v": "stable"}');
		},
	};
	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, true);
	assert.equal(state.phases["l"]?.loop?.stop, "converged", "identical consecutive SUCCESSFUL outputs converge (the failure in between does not reset)");
	assert.equal(calls, 3);
});

test("reflexion on: over-budget hard-stops the loop (no feedback continuation past the ceiling)", async () => {
	let calls = 0;
	const def = {
		name: "budget-stops",
		budget: { maxUSD: 0.05 },
		phases: [{
			id: "l", type: "loop", task: "try\n{reflexion}",
			until: "{steps.l.output} == done", maxIterations: 10, reflexion: true,
		}],
	};
	const state = mkState(def, "rfx-13");
	const deps: RuntimeDeps = {
		cwd: "/tmp", agents: [dummyAgent],
		runTask: async () => {
			calls++;
			// Each failing attempt costs $0.04 — the second failure exceeds maxUSD.
			return { ...hardFail(`attempt ${calls}`), usage: { ...emptyUsage(), cost: 0.04 } };
		},
	};
	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, false);
	assert.ok(calls < 10, `budget must stop the reflexion loop early (got ${calls} of 10 iterations)`);
});

test("reflexion on: provider error noise is sanitized before prompt injection", async () => {
	const tasks: string[] = [];
	let calls = 0;
	const def = {
		name: "sanitize",
		phases: [{
			id: "l", type: "loop", task: "try\n{reflexion}",
			until: "{steps.l.output} == done", maxIterations: 3, reflexion: true,
		}],
	};
	const state = mkState(def, "rfx-14");
	const html = "<html><head><title>Access denied by upstream proxy</title></head><body>blocked</body></html>";
	const deps: RuntimeDeps = {
		cwd: "/tmp", agents: [dummyAgent],
		runTask: async (_c, _a, _n, task) => {
			tasks.push(task);
			calls++;
			if (calls === 1) return hardFail(html); // non-transient (no 5xx/429 marker) → no auto-retry
			return ok("done");
		},
	};
	await executeTaskflow(state, deps);
	assert.equal(calls, 2);
	assert.ok(tasks[1].includes("Reflexion: iteration 1"), "the failure signal must arrive in iteration 2");
	assert.ok(!tasks[1].includes("<html>"), "raw HTML transport noise must not be injected into the next prompt");
	assert.ok(tasks[1].includes("non-JSON response") || tasks[1].includes("Access denied"), "the sanitized hint should still convey what happened");
});
