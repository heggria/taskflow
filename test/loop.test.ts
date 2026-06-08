import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../extensions/agents.ts";
import type { RunResult, RunOptions } from "../extensions/runner.ts";
import { executeTaskflow, type RuntimeDeps } from "../extensions/runtime.ts";
import { LOOP_HARD_MAX_ITERATIONS, type Taskflow, validateTaskflow } from "../extensions/schema.ts";
import type { RunState } from "../extensions/store.ts";
import { emptyUsage } from "../extensions/usage.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test agent", systemPrompt: "", source: "user", filePath: "" },
];

function mkState(def: Taskflow, args: Record<string, unknown> = {}): RunState {
	return {
		runId: "loop-run",
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

/** Runner whose output is produced by `respond(task)`; records every task. */
function runnerFrom(respond: (task: string) => string, record?: string[]): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task, _o: RunOptions): Promise<RunResult> => {
		record?.push(task);
		return {
			agent: agentName,
			task,
			exitCode: 0,
			output: respond(task),
			stderr: "",
			usage: { ...emptyUsage(), output: 10, cost: 0.001, turns: 1 },
			stopReason: "end",
		};
	};
}

function baseDeps(runTask: RuntimeDeps["runTask"]): RuntimeDeps {
	return { cwd: "/tmp", agents: AGENTS, runTask };
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

test("loop validation: requires task and until", () => {
	assert.equal(validateTaskflow({ name: "x", phases: [{ id: "p", type: "loop" }] }).ok, false);
	assert.equal(validateTaskflow({ name: "x", phases: [{ id: "p", type: "loop", task: "t" }] }).ok, false);
	assert.equal(
		validateTaskflow({ name: "x", phases: [{ id: "p", type: "loop", task: "t", until: "1==1" }] }).ok,
		true,
	);
});

test("loop validation: maxIterations bounds enforced", () => {
	assert.equal(
		validateTaskflow({ name: "x", phases: [{ id: "p", type: "loop", task: "t", until: "1==1", maxIterations: 0 }] }).ok,
		false,
	);
	assert.equal(
		validateTaskflow({
			name: "x",
			phases: [{ id: "p", type: "loop", task: "t", until: "1==1", maxIterations: LOOP_HARD_MAX_ITERATIONS + 1 }],
		}).ok,
		false,
	);
	assert.equal(
		validateTaskflow({ name: "x", phases: [{ id: "p", type: "loop", task: "t", until: "1==1", maxIterations: 5 }] }).ok,
		true,
	);
});

test("loop validation: cross-run cache is blocked (must be fresh each run)", () => {
	const r = validateTaskflow({
		name: "x",
		phases: [{ id: "p", type: "loop", task: "t", until: "1==1", cache: { scope: "cross-run" } }],
	});
	assert.equal(r.ok, false);
	assert.ok(r.errors.some((e) => e.includes("cross-run") && e.includes("loop")), r.errors.join("; "));
});

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

test("loop: stops as soon as `until` becomes truthy", async () => {
	// The body emits JSON whose `n` counts iterations; stop when n>=3.
	const def: Taskflow = {
		name: "until",
		phases: [
			{
				id: "count",
				type: "loop",
				agent: "a",
				task: "iteration {loop.iteration}",
				until: "{steps.count.json.n} >= 3",
				output: "json",
				final: true,
			},
		],
	};
	const record: string[] = [];
	// Output the iteration number as JSON {n}.
	const runTask = runnerFrom((t) => {
		const m = t.match(/iteration (\d+)/);
		return JSON.stringify({ n: Number(m?.[1] ?? 0) });
	}, record);
	const res = await executeTaskflow(mkState(def), baseDeps(runTask));

	assert.equal(res.ok, true);
	assert.equal(record.length, 3, "should run exactly 3 iterations then stop");
	assert.equal(res.state.phases.count.loop?.iterations, 3);
	assert.equal(res.state.phases.count.loop?.stop, "until");
	assert.deepEqual(JSON.parse(res.finalOutput), { n: 3 });
});

test("loop: body sees {loop.iteration} and {loop.lastOutput}", async () => {
	const def: Taskflow = {
		name: "ctx",
		phases: [
			{
				id: "acc",
				type: "loop",
				agent: "a",
				task: "prev=[{loop.lastOutput}] i={loop.iteration}",
				until: "{loop.iteration} >= 2", // condition can read locals too
				maxIterations: 5,
				final: true,
			},
		],
	};
	const record: string[] = [];
	// echo the task back as the output, so lastOutput chains forward
	const runTask = runnerFrom((t) => t, record);
	const res = await executeTaskflow(mkState(def), baseDeps(runTask));

	assert.equal(res.ok, true);
	// First iteration: lastOutput empty, i=1
	assert.equal(record[0], "prev=[] i=1");
	// Second iteration: lastOutput = first output, i=2
	assert.equal(record[1], "prev=[prev=[] i=1] i=2");
	assert.equal(res.state.phases.acc.loop?.iterations, 2);
});

test("loop: maxIterations caps a never-true condition", async () => {
	const def: Taskflow = {
		name: "cap",
		phases: [
			{
				id: "spin",
				type: "loop",
				agent: "a",
				task: "go {loop.iteration}",
				until: "1 == 2", // never true
				maxIterations: 4,
				convergence: false, // distinct outputs so convergence doesn't short-circuit
				final: true,
			},
		],
	};
	const record: string[] = [];
	const runTask = runnerFrom((t) => t, record); // distinct outputs per iteration
	const res = await executeTaskflow(mkState(def), baseDeps(runTask));

	assert.equal(res.ok, true);
	assert.equal(record.length, 4);
	assert.equal(res.state.phases.spin.loop?.stop, "maxIterations");
	assert.equal(res.state.phases.spin.loop?.iterations, 4);
});

test("loop: convergence stops early on a fixed point", async () => {
	const def: Taskflow = {
		name: "conv",
		phases: [
			{
				id: "fix",
				type: "loop",
				agent: "a",
				task: "refine {loop.iteration}",
				until: "1 == 2", // never true; rely on convergence
				maxIterations: 10,
				final: true,
			},
		],
	};
	const record: string[] = [];
	// Always returns the SAME output → 2nd iteration equals 1st → converged.
	const runTask = runnerFrom(() => "STABLE", record);
	const res = await executeTaskflow(mkState(def), baseDeps(runTask));

	assert.equal(res.ok, true);
	assert.equal(record.length, 2, "stops after detecting the fixed point");
	assert.equal(res.state.phases.fix.loop?.stop, "converged");
});

test("loop: a malformed `until` condition stops instead of spinning", async () => {
	const def: Taskflow = {
		name: "bad",
		phases: [
			{
				id: "p",
				type: "loop",
				agent: "a",
				task: "x {loop.iteration}",
				until: "{steps.p.json.done ==", // unbalanced / unparseable
				maxIterations: 10,
				final: true,
			},
		],
	};
	const record: string[] = [];
	const runTask = runnerFrom((t) => t, record);
	const res = await executeTaskflow(mkState(def), baseDeps(runTask));

	assert.equal(res.ok, true);
	assert.equal(record.length, 1, "fail-safe: a broken condition must not loop forever");
});

test("loop: a failing iteration fails the phase with partial output", async () => {
	const def: Taskflow = {
		name: "fail",
		phases: [
			{
				id: "p",
				type: "loop",
				agent: "a",
				task: "step {loop.iteration}",
				until: "{loop.iteration} >= 5",
				maxIterations: 5,
				final: true,
			},
		],
	};
	let calls = 0;
	const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task): Promise<RunResult> => {
		calls++;
		const fail = calls === 2;
		return {
			agent: agentName,
			task,
			exitCode: fail ? 1 : 0,
			output: fail ? "" : `ok ${calls}`,
			stderr: fail ? "boom" : "",
			usage: { ...emptyUsage(), output: 5, cost: 0.001, turns: 1 },
			stopReason: fail ? "error" : "end",
			errorMessage: fail ? "iteration blew up" : undefined,
		};
	};
	const res = await executeTaskflow(mkState(def), baseDeps(runTask));

	assert.equal(res.ok, false);
	assert.equal(res.state.phases.p.status, "failed");
	assert.equal(res.state.phases.p.loop?.stop, "failed");
	assert.equal(res.state.phases.p.loop?.iterations, 2);
});

test("loop: usage is summed across iterations", async () => {
	const def: Taskflow = {
		name: "usage",
		phases: [
			{ id: "p", type: "loop", agent: "a", task: "go {loop.iteration}", until: "{loop.iteration} >= 3", convergence: false, final: true },
		],
	};
	const runTask = runnerFrom((t) => t);
	const res = await executeTaskflow(mkState(def), baseDeps(runTask));
	assert.equal(res.ok, true);
	// 3 iterations × cost 0.001 each
	assert.ok((res.state.phases.p.usage?.cost ?? 0) > 0.0029);
	assert.equal(res.state.phases.p.usage?.turns, 3);
});
