import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../extensions/agents.ts";
import { type ApprovalDecision, executeTaskflow, type RuntimeDeps } from "../extensions/runtime.ts";
import type { RunOptions, RunResult } from "../extensions/runner.ts";
import { emptyUsage } from "../extensions/usage.ts";
import type { Taskflow } from "../extensions/schema.ts";
import type { RunState } from "../extensions/store.ts";

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

function mockRunner(
	respond: (task: string) => string,
	opts?: { fail?: (task: string) => boolean; cost?: number; record?: string[] },
): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task, _o: RunOptions): Promise<RunResult> => {
		opts?.record?.push(task);
		const failed = opts?.fail?.(task) ?? false;
		return {
			agent: agentName,
			task,
			exitCode: failed ? 1 : 0,
			output: failed ? "" : respond(task),
			stderr: failed ? "boom" : "",
			usage: { ...emptyUsage(), output: 10, cost: opts?.cost ?? 0.001, turns: 1 },
			stopReason: failed ? "error" : "end",
			errorMessage: failed ? "mock failure" : undefined,
		};
	};
}

function baseDeps(runTask: RuntimeDeps["runTask"], extra: Partial<RuntimeDeps> = {}): RuntimeDeps {
	return { cwd: "/tmp", agents: AGENTS, runTask, persist: () => {}, onProgress: () => {}, ...extra };
}

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------

test("retry: a flaky phase succeeds after N attempts", async () => {
	const def: Taskflow = {
		name: "flaky",
		phases: [{ id: "x", type: "agent", agent: "a", task: "flaky", retry: { max: 3, backoffMs: 0 }, final: true }],
	};
	let calls = 0;
	const runner: RuntimeDeps["runTask"] = async (_c, _ag, agentName, task) => {
		calls++;
		const fail = calls < 3; // fail first 2, succeed on 3rd
		return {
			agent: agentName,
			task,
			exitCode: fail ? 1 : 0,
			output: fail ? "" : "ok",
			stderr: fail ? "boom" : "",
			usage: { ...emptyUsage(), cost: 0.001 },
			stopReason: fail ? "error" : "end",
			errorMessage: fail ? "mock failure" : undefined,
		};
	};
	const res = await executeTaskflow(mkState(def), baseDeps(runner));
	assert.equal(res.ok, true);
	assert.equal(calls, 3);
	assert.equal(res.state.phases.x.status, "done");
	assert.equal(res.state.phases.x.attempts, 3);
	// usage summed across attempts
	assert.equal(res.state.phases.x.usage?.cost, 0.003);
});

test("retry: exhausted attempts still fail the phase", async () => {
	const def: Taskflow = {
		name: "always-fail",
		phases: [{ id: "x", type: "agent", agent: "a", task: "nope", retry: { max: 2, backoffMs: 0 }, final: true }],
	};
	const res = await executeTaskflow(mkState(def), baseDeps(mockRunner(() => "", { fail: () => true })));
	assert.equal(res.ok, false);
	assert.equal(res.state.phases.x.status, "failed");
	assert.equal(res.state.phases.x.attempts, 3); // 1 + 2 retries
});

// ---------------------------------------------------------------------------
// when (conditional branching) + join
// ---------------------------------------------------------------------------

test("when: routes to one branch and skips the other", async () => {
	const def: Taskflow = {
		name: "router",
		phases: [
			{ id: "plan", type: "agent", agent: "a", task: "decide", output: "json" },
			{ id: "deep", type: "agent", agent: "a", task: "deep work", when: "{steps.plan.json.route} == deep", dependsOn: ["plan"] },
			{ id: "quick", type: "agent", agent: "a", task: "quick work", when: "{steps.plan.json.route} == quick", dependsOn: ["plan"] },
			{ id: "report", type: "reduce", from: ["deep", "quick"], join: "any", agent: "a", task: "ship {steps.deep.output}", dependsOn: ["deep", "quick"], final: true },
		],
	};
	const runner = mockRunner((t) => (t === "decide" ? '{"route":"deep"}' : `out:${t}`));
	const res = await executeTaskflow(mkState(def), baseDeps(runner));
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.deep.status, "done");
	assert.equal(res.state.phases.quick.status, "skipped");
	assert.match(res.state.phases.quick.error ?? "", /Condition not met/);
	assert.equal(res.state.phases.report.status, "done");
	assert.match(res.finalOutput, /out:deep work/);
});

test("join any: runs when at least one dependency completes", async () => {
	const def: Taskflow = {
		name: "orjoin",
		phases: [
			{ id: "a1", type: "agent", agent: "a", task: "a1", when: "false" },
			{ id: "b1", type: "agent", agent: "a", task: "b1" },
			{ id: "j", type: "reduce", from: ["a1", "b1"], join: "any", agent: "a", task: "join {steps.b1.output}", dependsOn: ["a1", "b1"], final: true },
		],
	};
	const res = await executeTaskflow(mkState(def), baseDeps(mockRunner((t) => `r:${t}`)));
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.a1.status, "skipped");
	assert.equal(res.state.phases.j.status, "done");
	assert.match(res.finalOutput, /r:b1/);
});

test("join any: skips when all dependencies are skipped", async () => {
	const def: Taskflow = {
		name: "orjoin-empty",
		phases: [
			{ id: "a1", type: "agent", agent: "a", task: "a1", when: "false" },
			{ id: "b1", type: "agent", agent: "a", task: "b1", when: "false" },
			{ id: "j", type: "reduce", from: ["a1", "b1"], join: "any", agent: "a", task: "join", dependsOn: ["a1", "b1"], final: true },
		],
	};
	const res = await executeTaskflow(mkState(def), baseDeps(mockRunner((t) => `r:${t}`)));
	assert.equal(res.state.phases.j.status, "skipped");
	assert.match(res.state.phases.j.error ?? "", /All dependencies/);
});

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

test("budget: halts the run once cost cap is exceeded", async () => {
	const def: Taskflow = {
		name: "budgeted",
		concurrency: 1,
		budget: { maxUSD: 0.0015 },
		phases: [
			{ id: "p1", type: "agent", agent: "a", task: "p1" },
			{ id: "p2", type: "agent", agent: "a", task: "p2", dependsOn: ["p1"] },
			{ id: "p3", type: "agent", agent: "a", task: "p3", dependsOn: ["p2"], final: true },
		],
	};
	const res = await executeTaskflow(mkState(def), baseDeps(mockRunner((t) => `ok:${t}`, { cost: 0.001 })));
	assert.equal(res.state.phases.p1.status, "done");
	assert.equal(res.state.phases.p2.status, "done");
	assert.equal(res.state.phases.p3.status, "skipped");
	assert.equal(res.state.status, "blocked");
	assert.match(res.finalOutput, /Budget exceeded/);
});

test("budget: a cap crossed by the FINAL phase still completes ok (no phantom block)", async () => {
	// Regression: budget tipped on the last phase (nothing left to skip) must not
	// mark a fully-successful run as blocked / ok:false.
	const def: Taskflow = {
		name: "budget-final",
		concurrency: 1,
		budget: { maxUSD: 0.0015 },
		phases: [
			{ id: "p1", type: "agent", agent: "a", task: "p1" },
			{ id: "p2", type: "agent", agent: "a", task: "p2", dependsOn: ["p1"], final: true },
		],
	};
	const res = await executeTaskflow(mkState(def), baseDeps(mockRunner((t) => `ok:${t}`, { cost: 0.001 })));
	assert.equal(res.ok, true);
	assert.equal(res.state.status, "completed");
	assert.equal(res.state.phases.p2.status, "done");
	assert.match(res.finalOutput, /ok:p2/);
	assert.doesNotMatch(res.finalOutput, /Budget exceeded/);
});

test("budget: caps a runaway map fan-out and marks the run blocked", async () => {
	const def: Taskflow = {
		name: "budget-map",
		concurrency: 1,
		budget: { maxUSD: 0.0025 },
		phases: [
			{ id: "d", type: "agent", agent: "a", task: "list", output: "json" },
			{ id: "m", type: "map", over: "{steps.d.json}", agent: "a", task: "p {item}", dependsOn: ["d"], final: true },
		],
	};
	const runner = mockRunner((t) => (t === "list" ? "[1,2,3,4,5]" : "done"), { cost: 0.001 });
	const res = await executeTaskflow(mkState(def), baseDeps(runner));
	assert.equal(res.state.phases.m.budgetTruncated, true);
	assert.equal(res.state.phases.m.subProgress?.total, 5);
	assert.ok((res.state.phases.m.subProgress?.done ?? 5) < 5, "fan-out should be cut short");
	assert.match(res.state.phases.m.error ?? "", /skipped: budget exceeded/);
	assert.equal(res.state.status, "blocked");
});

// ---------------------------------------------------------------------------
// optional
// ---------------------------------------------------------------------------

test("optional: a failed optional dependency does not abort the run", async () => {
	const def: Taskflow = {
		name: "opt",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "willfail", optional: true },
			{ id: "b", type: "agent", agent: "a", task: "after a", dependsOn: ["a"], final: true },
		],
	};
	const deps = baseDeps(mockRunner((t) => `r:${t}`, { fail: (t) => t === "willfail" }));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.state.phases.a.status, "failed");
	assert.equal(res.state.phases.b.status, "done");
	assert.equal(res.state.status, "completed");
	assert.equal(res.ok, true);
});

// ---------------------------------------------------------------------------
// approval (human-in-the-loop)
// ---------------------------------------------------------------------------

test("approval: auto-approves when no interactive approver is available", async () => {
	const def: Taskflow = {
		name: "appr-auto",
		phases: [
			{ id: "work", type: "agent", agent: "a", task: "work" },
			{ id: "ok", type: "approval", task: "ship it?", dependsOn: ["work"] },
			{ id: "ship", type: "agent", agent: "a", task: "ship", dependsOn: ["ok"], final: true },
		],
	};
	const res = await executeTaskflow(mkState(def), baseDeps(mockRunner((t) => `r:${t}`)));
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.ok.status, "done");
	assert.equal(res.state.phases.ok.approval?.decision, "approve");
	assert.equal(res.state.phases.ok.approval?.auto, true);
	assert.equal(res.state.phases.ship.status, "done");
});

test("approval: rejection halts the flow", async () => {
	const def: Taskflow = {
		name: "appr-reject",
		phases: [
			{ id: "work", type: "agent", agent: "a", task: "work" },
			{ id: "ok", type: "approval", task: "ship it?", dependsOn: ["work"] },
			{ id: "ship", type: "agent", agent: "a", task: "ship", dependsOn: ["ok"], final: true },
		],
	};
	const requestApproval = async (): Promise<ApprovalDecision> => ({ decision: "reject", note: "not yet" });
	const res = await executeTaskflow(mkState(def), baseDeps(mockRunner((t) => `r:${t}`), { requestApproval }));
	assert.equal(res.state.status, "blocked");
	assert.equal(res.state.phases.ok.approval?.decision, "reject");
	assert.equal(res.state.phases.ship.status, "skipped");
	assert.match(res.finalOutput, /not yet/);
});

test("approval: edit injects guidance passed downstream", async () => {
	const def: Taskflow = {
		name: "appr-edit",
		phases: [
			{ id: "ok", type: "approval", task: "any notes?" },
			{ id: "use", type: "agent", agent: "a", task: "apply {steps.ok.output}", dependsOn: ["ok"], final: true },
		],
	};
	const requestApproval = async (): Promise<ApprovalDecision> => ({ decision: "edit", note: "focus on auth" });
	const res = await executeTaskflow(mkState(def), baseDeps(mockRunner((t) => `r:${t}`), { requestApproval }));
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.ok.approval?.decision, "edit");
	assert.match(res.finalOutput, /apply focus on auth/);
});

// ---------------------------------------------------------------------------
// flow (sub-workflow composition)
// ---------------------------------------------------------------------------

test("flow: runs a saved sub-flow and bubbles up its final output", async () => {
	const subDef: Taskflow = {
		name: "sub",
		phases: [{ id: "s1", type: "agent", agent: "a", task: "sub {args.x}", final: true }],
	};
	const mainDef: Taskflow = {
		name: "main",
		args: { topic: { default: "hello" } },
		phases: [{ id: "f", type: "flow", use: "sub", with: { x: "{args.topic}" }, final: true }],
	};
	const loadFlow = (n: string) => (n === "sub" ? subDef : undefined);
	const res = await executeTaskflow(
		mkState(mainDef, { topic: "world" }),
		baseDeps(mockRunner((t) => `out:${t}`), { loadFlow }),
	);
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.f.status, "done");
	assert.match(res.finalOutput, /out:sub world/);
});

test("flow: detects direct recursion", async () => {
	const recDef: Taskflow = {
		name: "rec",
		phases: [{ id: "f", type: "flow", use: "rec", final: true }],
	};
	const loadFlow = (n: string) => (n === "rec" ? recDef : undefined);
	const res = await executeTaskflow(mkState(recDef), baseDeps(mockRunner((t) => t), { loadFlow }));
	assert.equal(res.ok, false);
	assert.equal(res.state.phases.f.status, "failed");
	assert.match(res.state.phases.f.error ?? "", /recursive/);
});

test("flow: missing sub-flow fails the phase cleanly", async () => {
	const mainDef: Taskflow = {
		name: "main2",
		phases: [{ id: "f", type: "flow", use: "ghost", final: true }],
	};
	const res = await executeTaskflow(mkState(mainDef), baseDeps(mockRunner((t) => t), { loadFlow: () => undefined }));
	assert.equal(res.ok, false);
	assert.match(res.state.phases.f.error ?? "", /not found/);
});

// ---------------------------------------------------------------------------
// robustness (self-audit regressions)
// ---------------------------------------------------------------------------

test("robustness: a thrown runTask does not wedge the run in 'running'", async () => {
	const def: Taskflow = {
		name: "boom",
		phases: [{ id: "x", type: "agent", agent: "a", task: "go", final: true }],
	};
	const throwing: RuntimeDeps["runTask"] = async () => {
		throw new Error("kaboom");
	};
	let res!: Awaited<ReturnType<typeof executeTaskflow>>;
	await assert.doesNotReject(async () => {
		res = await executeTaskflow(mkState(def), baseDeps(throwing));
	});
	assert.equal(res.ok, false);
	assert.equal(res.state.status, "failed");
	assert.notEqual(res.state.phases.x?.status, "running");
	assert.match(res.finalOutput, /crashed/);
});

test("robustness: abort mid-layer does not crash runOne (undefined result guard)", async () => {
	// Two phases in one layer (concurrency 1 → sequential). The first aborts the
	// signal, so the second hits runOne with an already-aborted signal.
	const def: Taskflow = {
		name: "abort-mid",
		concurrency: 1,
		phases: [
			{ id: "p1", type: "agent", agent: "a", task: "p1" },
			{ id: "p2", type: "agent", agent: "a", task: "p2", final: true },
		],
	};
	const ac = new AbortController();
	const runner: RuntimeDeps["runTask"] = async (_c, _ag, agentName, task) => {
		if (task === "p1") ac.abort();
		return { agent: agentName, task, exitCode: 0, output: `ok:${task}`, stderr: "", usage: emptyUsage(), stopReason: "end" };
	};
	let res!: Awaited<ReturnType<typeof executeTaskflow>>;
	await assert.doesNotReject(async () => {
		res = await executeTaskflow(mkState(def), { ...baseDeps(runner), signal: ac.signal });
	});
	// p2 must have been handled gracefully (not a thrown TypeError).
	assert.ok(["failed", "done", "skipped"].includes(res.state.phases.p2?.status ?? ""));
});
