/**
 * Tests for approval phases, gate eval (zero-token checks), gate onBlock:retry,
 * budget enforcement, when guards, join:"any", optional deps, and flow sub-workflows.
 *
 * These are the critical runtime logic branches that had zero test coverage.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../extensions/agents.ts";
import type { RunResult } from "../extensions/runner.ts";
import { executeTaskflow, type RuntimeDeps } from "../extensions/runtime.ts";
import type { Taskflow } from "../extensions/schema.ts";
import type { RunState } from "../extensions/store.ts";
import { emptyUsage } from "../extensions/usage.ts";

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
	opts?: { fail?: (task: string) => boolean },
): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task): Promise<RunResult> => {
		const failed = opts?.fail?.(task) ?? false;
		return {
			agent: agentName,
			task,
			exitCode: failed ? 1 : 0,
			output: failed ? "" : respond(task),
			stderr: failed ? "boom" : "",
			usage: { ...emptyUsage(), output: 10, cost: 0.001, turns: 1 },
			stopReason: failed ? "error" : "end",
			errorMessage: failed ? "mock failure" : undefined,
		};
	};
}

function baseDeps(runTask: RuntimeDeps["runTask"], extra?: Partial<RuntimeDeps>): RuntimeDeps {
	return { cwd: "/tmp", agents: AGENTS, runTask, persist: () => {}, onProgress: () => {}, ...extra };
}

// ════════════════════════════════════════════════════════════════════
// APPROVAL PHASES
// ════════════════════════════════════════════════════════════════════

test("approval: auto-approves when no requestApproval callback is provided", async () => {
	const def: Taskflow = {
		name: "auto-approve",
		phases: [
			{ id: "gate", type: "approval", task: "Approve to continue?" },
			{ id: "work", type: "agent", agent: "a", task: "do {steps.gate.output}", dependsOn: ["gate"], final: true },
		],
	};
	const deps = baseDeps(mockRunner((t) => `done:${t}`));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.gate.approval?.decision, "approve");
	assert.equal(res.state.phases.gate.approval?.auto, true);
	assert.match(res.state.phases.gate.output ?? "", /auto-approved/);
});

test("approval: interactive approve continues the flow", async () => {
	const def: Taskflow = {
		name: "interactive-approve",
		phases: [
			{ id: "plan", type: "agent", agent: "a", task: "make a plan" },
			{ id: "checkpoint", type: "approval", task: "Review plan: {steps.plan.output}", dependsOn: ["plan"] },
			{ id: "execute", type: "agent", agent: "a", task: "execute {steps.checkpoint.output}", dependsOn: ["checkpoint"], final: true },
		],
	};
	let receivedReq: any;
	const deps = baseDeps(mockRunner((t) => `out:${t}`), {
		requestApproval: async (req) => {
			receivedReq = req;
			return { decision: "approve" as const };
		},
	});
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.checkpoint.approval?.decision, "approve");
	assert.ok(receivedReq, "approval request must be raised");
	assert.equal(receivedReq.phaseId, "checkpoint");
	assert.match(receivedReq.message, /out:make a plan/);
});

test("approval: interactive reject halts the flow (same as gate BLOCK)", async () => {
	const def: Taskflow = {
		name: "reject",
		phases: [
			{ id: "plan", type: "agent", agent: "a", task: "plan" },
			{ id: "checkpoint", type: "approval", task: "Approve?", dependsOn: ["plan"] },
			{ id: "execute", type: "agent", agent: "a", task: "go", dependsOn: ["checkpoint"], final: true },
		],
	};
	const deps = baseDeps(mockRunner((t) => `out:${t}`), {
		requestApproval: async () => ({ decision: "reject" as const, note: "Not ready" }),
	});
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, false);
	assert.equal(res.state.status, "blocked");
	assert.equal(res.state.phases.checkpoint.gate?.verdict, "block");
	assert.equal(res.state.phases.checkpoint.gate?.reason, "Not ready");
	assert.equal(res.state.phases.execute.status, "skipped");
});

test("approval: edit decision injects guidance as phase output", async () => {
	const def: Taskflow = {
		name: "edit",
		phases: [
			{ id: "checkpoint", type: "approval", task: "Review" },
			{ id: "work", type: "agent", agent: "a", task: "follow: {steps.checkpoint.output}", dependsOn: ["checkpoint"], final: true },
		],
	};
	let receivedTask = "";
	const deps = baseDeps(
		async (_c, _ag, _n, task): Promise<RunResult> => {
			receivedTask = task;
			return { agent: "a", task, exitCode: 0, output: "done", stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
		},
		{
			requestApproval: async () => ({ decision: "edit" as const, note: "Focus on auth first" }),
		},
	);
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.checkpoint.output, "Focus on auth first");
	assert.match(receivedTask, /follow: Focus on auth first/);
});

// ════════════════════════════════════════════════════════════════════
// GATE EVAL (zero-token machine checks)
// ════════════════════════════════════════════════════════════════════

test("gate eval: all evals pass → skip LLM gate (zero tokens)", async () => {
	const def: Taskflow = {
		name: "eval-pass",
		phases: [
			{ id: "scan", type: "agent", agent: "a", task: "scan", output: "json" },
			{
				id: "check",
				type: "gate",
				agent: "a",
				task: "review",
				eval: ["{steps.scan.json.score} >= 0.9"],
				dependsOn: ["scan"],
				final: true,
			},
		],
	};
	let gateCalled = false;
	const deps = baseDeps(
		async (_c, _ag, _n, task): Promise<RunResult> => {
			if (task === "scan") return { agent: "a", task, exitCode: 0, output: '{"score": 0.95}', stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
			gateCalled = true;
			return { agent: "a", task, exitCode: 0, output: "VERDICT: PASS", stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
		},
	);
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.equal(gateCalled, false, "LLM gate should be skipped when all evals pass");
	assert.equal(res.state.phases.check.gate?.verdict, "pass");
	assert.match(res.state.phases.check.output ?? "", /eval checks passed/);
});

test("gate eval: any eval fails → LLM gate runs as normal", async () => {
	const def: Taskflow = {
		name: "eval-fail",
		phases: [
			{ id: "scan", type: "agent", agent: "a", task: "scan", output: "json" },
			{
				id: "check",
				type: "gate",
				agent: "a",
				task: "review {steps.scan.output}",
				eval: ["{steps.scan.json.score} >= 0.9"],
				dependsOn: ["scan"],
				final: true,
			},
		],
	};
	let gateTask = "";
	const deps = baseDeps(
		async (_c, _ag, _n, task): Promise<RunResult> => {
			if (task === "scan") return { agent: "a", task, exitCode: 0, output: '{"score": 0.5}', stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
			gateTask = task;
			return { agent: "a", task, exitCode: 0, output: "VERDICT: BLOCK\nreason: score too low", stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
		},
	);
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, false);
	assert.ok(gateTask.length > 0, "LLM gate should have run");
	assert.equal(res.state.phases.check.gate?.verdict, "block");
});

test("gate eval: contains expression for substring check", async () => {
	const def: Taskflow = {
		name: "eval-contains",
		phases: [
			{ id: "scan", type: "agent", agent: "a", task: "scan" },
			{
				id: "check",
				type: "gate",
				agent: "a",
				task: "review",
				eval: ['{steps.scan.output} contains ALL_CLEAR'],
				dependsOn: ["scan"],
				final: true,
			},
		],
	};
	const deps = baseDeps(
		async (_c, _ag, _n, task): Promise<RunResult> => {
			if (task === "scan") return { agent: "a", task, exitCode: 0, output: "Status: ALL_CLEAR", stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
			return { agent: "a", task, exitCode: 0, output: "VERDICT: PASS", stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
		},
	);
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.check.gate?.verdict, "pass");
	assert.match(res.state.phases.check.output ?? "", /eval checks passed/);
});

// ════════════════════════════════════════════════════════════════════
// GATE onBlock:retry
// ════════════════════════════════════════════════════════════════════

test("gate onBlock:retry: re-runs upstream and re-evaluates until pass", async () => {
	let workCalls = 0;
	let gateCalls = 0;
	const def: Taskflow = {
		name: "onblock-retry",
		phases: [
			{ id: "work", type: "agent", agent: "a", task: "improve attempt" },
			{
				id: "check",
				type: "gate",
				agent: "a",
				task: "review {steps.work.output}",
				dependsOn: ["work"],
				onBlock: "retry",
				retry: { max: 2 },
				final: true,
			},
		],
	};
	const deps = baseDeps(
		async (_c, _ag, _n, task): Promise<RunResult> => {
			if (task.startsWith("improve")) {
				workCalls++;
				return { agent: "a", task, exitCode: 0, output: `attempt-${workCalls}`, stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
			}
			gateCalls++;
			// Block first 2 times, pass on 3rd
			if (gateCalls < 3) return { agent: "a", task, exitCode: 0, output: "VERDICT: BLOCK", stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
			return { agent: "a", task, exitCode: 0, output: "VERDICT: PASS", stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
		},
	);
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.ok(workCalls >= 2, `upstream should have re-run at least twice, got ${workCalls}`);
	assert.ok(gateCalls >= 3, `gate should have evaluated at least 3 times, got ${gateCalls}`);
	assert.equal(res.state.phases.check.gate?.verdict, "pass");
});

// ════════════════════════════════════════════════════════════════════
// BUDGET ENFORCEMENT
// ════════════════════════════════════════════════════════════════════

test("budget: maxUSD halts the run when exceeded", async () => {
	const def: Taskflow = {
		name: "budget-usd",
		budget: { maxUSD: 0.0015 },
		phases: [
			{ id: "one", type: "agent", agent: "a", task: "step1" },
			{ id: "two", type: "agent", agent: "a", task: "step2", dependsOn: ["one"] },
			{ id: "three", type: "agent", agent: "a", task: "step3", dependsOn: ["two"], final: true },
		],
	};
	let executed: string[] = [];
	const deps = baseDeps(
		async (_c, _ag, _n, task): Promise<RunResult> => {
			executed.push(task);
			return {
				agent: "a", task, exitCode: 0, output: `ok:${task}`, stderr: "",
				// Each call costs $0.001 → after step2 (total $0.002 > $0.0015), step3 is skipped
				usage: { ...emptyUsage(), output: 10, cost: 0.001, turns: 1 },
				stopReason: "end",
			};
		},
	);
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, false);
	assert.equal(res.state.status, "blocked");
	// step3 should have been skipped (budget exceeded after step1+step2)
	assert.ok(!executed.includes("step3"), `step3 should be skipped, but executed: ${executed}`);
});

test("budget: maxTokens halts the run when exceeded", async () => {
	const def: Taskflow = {
		name: "budget-tokens",
		budget: { maxTokens: 50 },
		phases: [
			{ id: "one", type: "agent", agent: "a", task: "step1" },
			{ id: "two", type: "agent", agent: "a", task: "step2", dependsOn: ["one"] },
			{ id: "three", type: "agent", agent: "a", task: "step3", dependsOn: ["two"], final: true },
		],
	};
	let executed: string[] = [];
	const deps = baseDeps(
		async (_c, _ag, _n, task): Promise<RunResult> => {
			executed.push(task);
			return {
				agent: "a", task, exitCode: 0, output: `ok:${task}`, stderr: "",
				// Each call: 20 in + 20 out = 40 tokens. After step1 (40 < 50 ok),
				// after step2 (80 > 50 → blocked), step3 is skipped.
				usage: { ...emptyUsage(), input: 20, output: 20, cost: 0.001, turns: 1 },
				stopReason: "end",
			};
		},
	);
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, false);
	assert.equal(res.state.status, "blocked");
	assert.ok(!executed.includes("step3"), `step3 should be skipped, but executed: ${executed}`);
});

// ════════════════════════════════════════════════════════════════════
// WHEN CONDITIONAL GUARDS
// ════════════════════════════════════════════════════════════════════

test("when: skips phase when condition is false", async () => {
	const def: Taskflow = {
		name: "when-skip",
		phases: [
			{ id: "decide", type: "agent", agent: "a", task: "decide", output: "json" },
			{
				id: "fast",
				type: "agent",
				agent: "a",
				task: "fast path",
				when: "{steps.decide.json.route} == slow",
				dependsOn: ["decide"],
			},
			{
				id: "slow",
				type: "agent",
				agent: "a",
				task: "slow path",
				when: "{steps.decide.json.route} == slow",
				dependsOn: ["decide"],
				final: true,
			},
		],
	};
	let executed: string[] = [];
	const deps = baseDeps(
		async (_c, _ag, _n, task): Promise<RunResult> => {
			executed.push(task);
			if (task === "decide") return { agent: "a", task, exitCode: 0, output: '{"route":"fast"}', stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
			return { agent: "a", task, exitCode: 0, output: `done:${task}`, stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
		},
	);
	const res = await executeTaskflow(mkState(def), deps);
	assert.ok(!executed.includes("fast path"), "fast should be skipped (condition false)");
	assert.ok(!executed.includes("slow path"), "slow should be skipped (condition false)");
	assert.equal(res.state.phases.fast.status, "skipped");
	assert.equal(res.state.phases.slow.status, "skipped");
});

test("when: runs phase when condition is true", async () => {
	const def: Taskflow = {
		name: "when-run",
		phases: [
			{ id: "decide", type: "agent", agent: "a", task: "decide", output: "json" },
			{
				id: "work",
				type: "agent",
				agent: "a",
				task: "do work",
				when: "{steps.decide.json.go} == true",
				dependsOn: ["decide"],
				final: true,
			},
		],
	};
	const deps = baseDeps(
		async (_c, _ag, _n, task): Promise<RunResult> => {
			if (task === "decide") return { agent: "a", task, exitCode: 0, output: '{"go":true}', stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
			return { agent: "a", task, exitCode: 0, output: "worked", stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
		},
	);
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.work.status, "done");
});

// ════════════════════════════════════════════════════════════════════
// JOIN:"ANY"
// ════════════════════════════════════════════════════════════════════

test("join:any: runs when at least one dependency completes", async () => {
	const def: Taskflow = {
		name: "join-any",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "branch-a" },
			{ id: "b", type: "agent", agent: "a", task: "branch-b" },
			{
				id: "merge",
				type: "agent",
				agent: "a",
				task: "merge",
				from: ["a", "b"],
				join: "any",
				dependsOn: ["a", "b"],
				final: true,
			},
		],
	};
	const deps = baseDeps(mockRunner((t) => `out:${t}`));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.merge.status, "done");
});

// ════════════════════════════════════════════════════════════════════
// OPTIONAL DEPENDENCIES
// ════════════════════════════════════════════════════════════════════

test("optional: failed optional dep does not block downstream", async () => {
	const def: Taskflow = {
		name: "optional-dep",
		phases: [
			{ id: "fragile", type: "agent", agent: "a", task: "will-fail", optional: true },
			{
				id: "main",
				type: "agent",
				agent: "a",
				task: "main work",
				dependsOn: ["fragile"],
				final: true,
			},
		],
	};
	const deps = baseDeps(
		mockRunner((t) => `ok:${t}`, { fail: (t) => t === "will-fail" }),
	);
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true, "optional dep failure should not block the flow");
	assert.equal(res.state.phases.fragile.status, "failed");
	assert.equal(res.state.phases.main.status, "done");
});

// ════════════════════════════════════════════════════════════════════
// FLOW SUB-WORKFLOW
// ════════════════════════════════════════════════════════════════════

test("flow: runs a saved sub-flow and bubbles up output", async () => {
	const subFlow: Taskflow = {
		name: "sub",
		phases: [
			{ id: "inner", type: "agent", agent: "a", task: "inner work {args.msg}", final: true },
		],
		args: { msg: { default: "default-msg" } },
	};
	const def: Taskflow = {
		name: "parent",
		phases: [
			{ id: "delegate", type: "flow", use: "sub", with: { msg: "hello from parent" }, final: true },
		],
	};
	const record: string[] = [];
	const deps = baseDeps(
		mockRunner((t) => { record.push(t); return `out:${t}`; }),
		{ loadFlow: (name) => (name === "sub" ? subFlow : undefined) },
	);
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.ok(record.some((t) => t.includes("hello from parent")), "sub-flow should receive the arg");
	assert.match(res.finalOutput, /out:inner work hello from parent/);
});

test("flow: recursive sub-flow detection prevents infinite loop", async () => {
	const selfRefFlow: Taskflow = {
		name: "self-ref",
		phases: [
			{ id: "recurse", type: "flow", use: "self-ref", final: true },
		],
	};
	const def: Taskflow = {
		name: "parent",
		phases: [
			{ id: "go", type: "flow", use: "self-ref", final: true },
		],
	};
	const deps = baseDeps(mockRunner((t) => `out:${t}`), {
		loadFlow: (name) => (name === "self-ref" ? selfRefFlow : undefined),
	});
	const res = await executeTaskflow(mkState(def), deps);
	// The flow should fail gracefully, not stack overflow.
	assert.equal(res.ok, false);
	assert.equal(res.state.phases.go.status, "failed");
	// The error is wrapped by the parent flow phase; the inner recursion
	// message is in the sub-flow's own phase state.
	assert.ok(
		(res.state.phases.go.error ?? "").includes("failed") ||
		(res.state.phases.go.error ?? "").includes("recursive"),
		`expected failure or recursion error, got: ${res.state.phases.go.error}`,
	);
});

test("flow: missing sub-flow fails gracefully", async () => {
	const def: Taskflow = {
		name: "missing",
		phases: [
			{ id: "go", type: "flow", use: "nonexistent", final: true },
		],
	};
	const deps = baseDeps(mockRunner((t) => `out:${t}`), {
		loadFlow: () => undefined,
	});
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, false);
	assert.equal(res.state.phases.go.status, "failed");
	assert.match(res.state.phases.go.error ?? "", /not found/i);
});

test("flow: missing 'use' fails gracefully", async () => {
	const def: Taskflow = {
		name: "no-use",
		phases: [
			{ id: "go", type: "flow" as any, final: true },
		],
	};
	const deps = baseDeps(mockRunner((t) => `out:${t}`));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, false);
	assert.match(res.state.phases.go.error ?? "", /requires 'use'/i);
});

// ════════════════════════════════════════════════════════════════════
// PARSE GATE VERDICT — additional edge cases
// ════════════════════════════════════════════════════════════════════

import { parseGateVerdict, parseTournamentWinner } from "../extensions/runtime.ts";

test("parseGateVerdict: JSON with verdict=halt blocks", () => {
	assert.equal(parseGateVerdict('{"verdict": "halt"}').verdict, "block");
});

test("parseGateVerdict: JSON with verdict=stop blocks", () => {
	assert.equal(parseGateVerdict('{"verdict": "stop"}').verdict, "block");
});

test("parseGateVerdict: multiple VERDICT markers — last wins", () => {
	assert.equal(parseGateVerdict("VERDICT: BLOCK\nsome text\nVERDICT: PASS").verdict, "pass");
	assert.equal(parseGateVerdict("VERDICT: PASS\nsome text\nVERDICT: BLOCK").verdict, "block");
});

test("parseGateVerdict: case insensitive markers", () => {
	assert.equal(parseGateVerdict("verdict: pass").verdict, "pass");
	assert.equal(parseGateVerdict("Verdict: Block").verdict, "block");
});

test("parseGateVerdict: reason from JSON", () => {
	const r = parseGateVerdict('{"continue": false, "reason": "missing auth"}');
	assert.equal(r.verdict, "block");
	assert.equal(r.reason, "missing auth");
});

test("parseGateVerdict: empty/whitespace reason is omitted", () => {
	const r = parseGateVerdict('{"continue": false, "reason": "  "}');
	assert.equal(r.reason, undefined);
});

test("parseTournamentWinner: reason field from JSON", () => {
	const r = parseTournamentWinner('{"winner": 2, "reason": "clearest explanation"}', 3);
	assert.equal(r.winner, 2);
	assert.equal(r.reason, "clearest explanation");
});

test("parseTournamentWinner: fail-open includes reason", () => {
	const r = parseTournamentWinner("I cannot decide", 3);
	assert.equal(r.winner, 1);
	assert.match(r.reason ?? "", /no parseable winner/);
});
