import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { emptyUsage } from "../src/usage.ts";
import { executeTaskflow, PHASE_TIMEOUT_ABORT_GRACE_MS, type RuntimeDeps } from "../src/runtime.ts";
import { validateTaskflow, type Taskflow } from "../src/schema.ts";
import { verifyTaskflow } from "../src/verify.ts";
import type { RunState } from "../src/store.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test agent", systemPrompt: "", source: "user", filePath: "" },
];

function mkState(def: Taskflow, args: Record<string, unknown> = {}): RunState {
	return {
		runId: "test-run",
		flowName: def.name,
		def,
		args,
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: "/tmp",
	};
}

function ok(agent: string, task: string, output: string): RunResult {
	return {
		agent,
		task,
		exitCode: 0,
		output,
		stderr: "",
		usage: { ...emptyUsage(), output: 10, cost: 0.001, turns: 1 },
		stopReason: "end",
	};
}

function baseDeps(runTask: RuntimeDeps["runTask"]): RuntimeDeps {
	return { cwd: "/tmp", agents: AGENTS, runTask, persist: () => {}, onProgress: () => {} };
}

// ---------------------------------------------------------------------------
// expect — schema validation
// ---------------------------------------------------------------------------

test("expect: schema validation requires output json and a supported phase type", () => {
	const bad1 = validateTaskflow({
		name: "f",
		phases: [{ id: "p", type: "agent", task: "t", expect: { type: "object" } }],
	} as Taskflow);
	assert.ok(bad1.errors.some((e) => e.includes("'expect' requires 'output'")));

	const bad2 = validateTaskflow({
		name: "f",
		phases: [
			{ id: "s", type: "agent", task: "emit", output: "json" },
			{ id: "p", type: "map", over: "{steps.s.json}", task: "t", output: "json", expect: { type: "object" }, dependsOn: ["s"] },
		],
	} as Taskflow);
	assert.ok(bad2.errors.some((e) => e.includes("only valid for agent/gate/reduce/loop")));

	const bad3 = validateTaskflow({
		name: "f",
		phases: [{ id: "p", type: "agent", task: "t", output: "json", expect: { type: "objekt" } }],
	} as Taskflow);
	assert.ok(bad3.errors.some((e) => e.includes("expect.type")));

	const good = validateTaskflow({
		name: "f",
		phases: [{ id: "p", type: "agent", task: "t", output: "json", expect: { type: "object", required: ["x"] }, final: true }],
	} as Taskflow);
	assert.deepEqual(good.errors, []);
});

// ---------------------------------------------------------------------------
// expect — runtime enforcement
// ---------------------------------------------------------------------------

test("expect: conforming output passes untouched", async () => {
	const def: Taskflow = {
		name: "f",
		phases: [
			{
				id: "p", type: "agent", agent: "a", task: "emit", output: "json",
				expect: { type: "object", required: ["score"], properties: { score: { type: "number" } } },
				final: true,
			},
		],
	};
	const deps = baseDeps(async (_c, _a, agent, task) => ok(agent, task, '{"score": 0.9}'));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.deepEqual(res.state.phases.p.json, { score: 0.9 });
});

test("expect: violating output fails the phase with a precise diagnostic", async () => {
	const def: Taskflow = {
		name: "f",
		phases: [
			{
				id: "p", type: "agent", agent: "a", task: "emit", output: "json",
				expect: { type: "object", required: ["score"] },
				final: true,
			},
		],
	};
	const deps = baseDeps(async (_c, _a, agent, task) => ok(agent, task, '{"other": 1}'));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, false);
	assert.equal(res.state.phases.p.status, "failed");
	assert.match(res.state.phases.p.error ?? "", /Output contract violated/);
	assert.match(res.state.phases.p.error ?? "", /\$\.score: required key is missing/);
});

test("expect: non-JSON output fails the contract", async () => {
	const def: Taskflow = {
		name: "f",
		phases: [
			{ id: "p", type: "agent", agent: "a", task: "emit", output: "json", expect: { type: "object" }, final: true },
		],
	};
	const deps = baseDeps(async (_c, _a, agent, task) => ok(agent, task, "sorry, here is prose"));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, false);
	assert.match(res.state.phases.p.error ?? "", /not valid JSON/);
});

test("expect: a violation is retryable under the phase's explicit retry policy", async () => {
	let calls = 0;
	const def: Taskflow = {
		name: "f",
		phases: [
			{
				id: "p", type: "agent", agent: "a", task: "emit", output: "json",
				expect: { type: "object", required: ["score"] },
				retry: { max: 2, backoffMs: 0 },
				final: true,
			},
		],
	};
	const deps = baseDeps(async (_c, _a, agent, task) => {
		calls++;
		return ok(agent, task, calls < 2 ? '{"bad": true}' : '{"score": 1}');
	});
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.equal(calls, 2);
	assert.deepEqual(res.state.phases.p.json, { score: 1 });
});

test("expect: a violation without explicit retry is NOT transient-retried", async () => {
	let calls = 0;
	const def: Taskflow = {
		name: "f",
		phases: [
			{ id: "p", type: "agent", agent: "a", task: "emit", output: "json", expect: { type: "array" }, final: true },
		],
	};
	const deps = baseDeps(async (_c, _a, agent, task) => {
		calls++;
		return ok(agent, task, '{"an": "object"}');
	});
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, false);
	assert.equal(calls, 1);
});

test("expect: loop iterations are contract-checked", async () => {
	const def: Taskflow = {
		name: "f",
		phases: [
			{
				id: "l", type: "loop", agent: "a", task: "iterate", output: "json",
				until: "{steps.l.json.done} == true", maxIterations: 3,
				expect: { type: "object", required: ["done"] },
				final: true,
			},
		],
	};
	const deps = baseDeps(async (_c, _a, agent, task) => ok(agent, task, '{"nope": 1}'));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, false);
	assert.equal(res.state.phases.l.status, "failed");
	assert.match(res.state.phases.l.error ?? "", /Output contract violated/);
});

// ---------------------------------------------------------------------------
// verify — contract-aware ref checking
// ---------------------------------------------------------------------------

test("verify: {steps.X.json.field} against a contract lacking the field warns", () => {
	const flow = {
		name: "f",
		phases: [
			{
				id: "scan", type: "agent", task: "emit", output: "json",
				expect: { type: "object", properties: { files: { type: "array" } } },
			},
			{ id: "use", type: "agent", task: "read {steps.scan.json.paths}", dependsOn: ["scan"], final: true },
		],
	} as Taskflow;
	const res = verifyTaskflow(flow);
	const hit = res.issues.find((i) => i.category === "contract");
	assert.ok(hit, "expected a contract issue");
	assert.match(hit!.message, /paths/);
	assert.equal(hit!.severity, "warning");
});

test("verify: matching contract refs and contracts without properties stay silent", () => {
	const flow = {
		name: "f",
		phases: [
			{
				id: "scan", type: "agent", task: "emit", output: "json",
				expect: { type: "object", properties: { files: { type: "array" } } },
			},
			// declared field — fine
			{ id: "use", type: "agent", task: "read {steps.scan.json.files}", dependsOn: ["scan"] },
			// no-properties contract claims nothing about keys — fine
			{ id: "loose", type: "agent", task: "x", output: "json", expect: { type: "object" } },
			{ id: "use2", type: "agent", task: "read {steps.loose.json.anything}", dependsOn: ["use", "loose"], final: true },
		],
	} as Taskflow;
	const res = verifyTaskflow(flow);
	assert.deepEqual(res.issues.filter((i) => i.category === "contract"), []);
});

// ---------------------------------------------------------------------------
// per-phase timeout
// ---------------------------------------------------------------------------

test("timeout: schema accepts timeout on agent phases, rejects approval/flow and sub-1s values", () => {
	const good = validateTaskflow({
		name: "f",
		phases: [{ id: "p", type: "agent", task: "t", timeout: 5000, final: true }],
	} as Taskflow);
	assert.deepEqual(good.errors, []);

	const badType = validateTaskflow({
		name: "f",
		phases: [{ id: "p", type: "approval", task: "t", timeout: 5000, final: true }],
	} as Taskflow);
	assert.ok(badType.errors.some((e) => e.includes("not supported for approval")));

	const badVal = validateTaskflow({
		name: "f",
		phases: [{ id: "p", type: "agent", task: "t", timeout: 10, final: true }],
	} as Taskflow);
	assert.ok(badVal.errors.some((e) => e.includes(">= 1000")));
});

test("timeout: a hanging subagent is aborted; the phase fails with a timedOut marker and no retry", async () => {
	let calls = 0;
	const hangingRunner: RuntimeDeps["runTask"] = (_c, _a, agent, task, opts: RunOptions) => {
		calls++;
		return new Promise<RunResult>((resolve) => {
			const finish = (why: string) =>
				resolve({
					agent, task, exitCode: 1, output: "", stderr: why,
					usage: emptyUsage(), stopReason: "aborted", errorMessage: why,
				});
			if (opts.signal?.aborted) return finish("aborted");
			opts.signal?.addEventListener("abort", () => finish("aborted"), { once: true });
			// never resolves on its own — only the abort signal ends it
		});
	};
	const def: Taskflow = {
		name: "f",
		phases: [{ id: "p", type: "agent", agent: "a", task: "hang", timeout: 1000, final: true }],
	};
	const t0 = Date.now();
	const res = await executeTaskflow(mkState(def), baseDeps(hangingRunner));
	assert.equal(res.ok, false);
	assert.equal(res.state.phases.p.status, "failed");
	assert.equal(res.state.phases.p.timedOut, true);
	assert.match(res.state.phases.p.error ?? "", /timed out after 1000ms/);
	assert.equal(calls, 1, "a timed-out call must not be retried");
	assert.ok(Date.now() - t0 < 5000, "should return promptly after the cap");
});

test("timeout: a runner that ignores AbortSignal is still bounded", async () => {
	const nonCooperative: RuntimeDeps["runTask"] = () => new Promise<RunResult>(() => {});
	const def: Taskflow = {
		name: "bounded-noncooperative-timeout",
		phases: [{ id: "p", type: "agent", agent: "a", task: "hang", timeout: 1000, final: true }],
	};
	const started = Date.now();
	const res = await executeTaskflow(mkState(def), baseDeps(nonCooperative));
	const elapsed = Date.now() - started;
	assert.equal(res.state.phases.p.timedOut, true);
	assert.equal(res.state.phases.p.status, "failed");
	assert.ok(
		elapsed < 1000 + PHASE_TIMEOUT_ABORT_GRACE_MS + 2000,
		`non-cooperative runner exceeded timeout bound: ${elapsed}ms`,
	);
});

test("timeout: a fast subagent under the cap is unaffected", async () => {
	const def: Taskflow = {
		name: "f",
		phases: [{ id: "p", type: "agent", agent: "a", task: "quick", timeout: 30000, final: true }],
	};
	const deps = baseDeps(async (_c, _a, agent, task) => ok(agent, task, "done"));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.p.timedOut, undefined);
	assert.equal(res.finalOutput, "done");
});

test("timeout: terminal commit linearizes before the phase timer in imperative and event-kernel paths", async () => {
	for (const eventKernel of [false, true]) {
		let aborts = 0;
		const runner: RuntimeDeps["runTask"] = (_c, _a, agent, task, opts) =>
			new Promise<RunResult>((resolve) => {
				opts.signal?.addEventListener("abort", () => { aborts++; }, { once: true });
				setTimeout(() => {
					opts.onTerminalCommit?.();
					setTimeout(() => resolve(ok(agent, task, "committed")), 1100);
				}, 100);
			});
		const def: Taskflow = {
			name: `terminal-before-timeout-${eventKernel}`,
			phases: [{ id: "p", type: "agent", agent: "a", task: "finish", timeout: 1000, final: true }],
		};
		const res = await executeTaskflow(mkState(def), {
			...baseDeps(runner),
			eventKernel,
		});
		assert.equal(res.ok, true, `eventKernel=${eventKernel}`);
		assert.equal(res.state.phases.p.timedOut, undefined, `eventKernel=${eventKernel}`);
		assert.equal(res.finalOutput, "committed");
		assert.equal(aborts, 0, `eventKernel=${eventKernel}: timeout must not abort after commit`);
	}
});

test("timeout: downstream `when` can route on the timed-out phase", async () => {
	const hangingRunner: RuntimeDeps["runTask"] = (_c, _a, agent, task, opts: RunOptions) => {
		if (task.includes("hang")) {
			return new Promise<RunResult>((resolve) => {
				opts.signal?.addEventListener(
					"abort",
					() => resolve({ agent, task, exitCode: 1, output: "", stderr: "aborted", usage: emptyUsage(), stopReason: "aborted", errorMessage: "aborted" }),
					{ once: true },
				);
			});
		}
		return Promise.resolve(ok(agent, task, "fallback-ran"));
	};
	const def: Taskflow = {
		name: "f",
		phases: [
			{ id: "slow", type: "agent", agent: "a", task: "hang", timeout: 1000, optional: true },
			{ id: "fallback", type: "agent", agent: "a", task: "recover from {steps.slow.output}", dependsOn: ["slow"], final: true },
		],
	};
	const res = await executeTaskflow(mkState(def), baseDeps(hangingRunner));
	assert.equal(res.state.phases.slow.timedOut, true);
	assert.equal(res.state.phases.fallback.status, "done");
	assert.equal(res.finalOutput, "fallback-ran");
});
