/**
 * S2 complete: event kernel handles all 10 phase kinds (parity smoke + enablement).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { canUseEventKernel, EVENT_KERNEL_PHASE_TYPES } from "../src/exec/driver.ts";
import { PHASE_TYPES } from "../src/schema.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test", systemPrompt: "", source: "user", filePath: "" },
];

function mkState(def: Taskflow, runId = "s2"): RunState {
	return {
		runId,
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: process.cwd(),
	};
}

function runner(fn: (task: string) => string): RuntimeDeps["runTask"] {
	return async (_c, _a, agent, task, _o: RunOptions): Promise<RunResult> => ({
		agent,
		task,
		exitCode: 0,
		output: fn(task),
		stderr: "",
		usage: { ...emptyUsage(), input: 1, output: 1, cost: 0.001, turns: 1 },
		stopReason: "end",
	});
}

async function withKernel(def: Taskflow, runTask: RuntimeDeps["runTask"], extra: Partial<RuntimeDeps> = {}) {
	return executeTaskflow(mkState(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask,
		persist: () => {},
		eventKernel: true,
		...extra,
	});
}

test("EVENT_KERNEL_PHASE_TYPES covers all PHASE_TYPES", () => {
	assert.deepEqual([...EVENT_KERNEL_PHASE_TYPES].sort(), [...PHASE_TYPES].sort());
});

test("canUseEventKernel: all 10 kinds accepted", () => {
	assert.equal(
		canUseEventKernel({
			name: "all",
			phases: PHASE_TYPES.map((type, i) => {
				const base: Record<string, unknown> = { id: `p${i}`, type, final: i === PHASE_TYPES.length - 1 };
				if (type === "script") base.run = ["node", "-e", "1"];
				if (type === "map") {
					base.over = '["x"]';
					base.task = "{item}";
					base.agent = "a";
				}
				if (type === "parallel") base.branches = [{ task: "t", agent: "a" }];
				if (type === "gate" || type === "agent" || type === "reduce" || type === "loop" || type === "tournament") {
					base.task = "t";
					base.agent = "a";
				}
				if (type === "loop") base.maxIterations = 1;
				if (type === "tournament") base.variants = 2;
				if (type === "approval") base.task = "ok?";
				if (type === "flow") base.use = "child";
				return base;
			}) as Taskflow["phases"],
		}),
		true,
	);
});

test("kernel: reduce aggregates via agent", async () => {
	const def: Taskflow = {
		name: "k-reduce",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "part-a" },
			{ id: "b", type: "agent", agent: "a", task: "part-b" },
			{
				id: "r",
				type: "reduce",
				agent: "a",
				task: "merge {steps.a.output} and {steps.b.output}",
				dependsOn: ["a", "b"],
				from: ["a", "b"],
				final: true,
			},
		],
	};
	const res = await withKernel(def, runner((t) => `OUT:${t.slice(0, 40)}`));
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.r.status, "done");
	assert.match(res.finalOutput, /part-a/);
	assert.match(res.finalOutput, /part-b/);
});

test("kernel: gate BLOCK marks run blocked", async () => {
	const def: Taskflow = {
		name: "k-gate",
		phases: [
			{ id: "w", type: "agent", agent: "a", task: "work" },
			{
				id: "g",
				type: "gate",
				agent: "a",
				task: "judge",
				dependsOn: ["w"],
				final: true,
			},
		],
	};
	const res = await withKernel(def, runner((t) => (t.includes("judge") ? "VERDICT: BLOCK\nbad" : "ok")));
	assert.equal(res.state.phases.g.gate?.verdict, "block");
	assert.equal(res.state.status, "blocked");
	assert.equal(res.ok, false);
});

test("kernel: gate PASS completes", async () => {
	const def: Taskflow = {
		name: "k-gate-pass",
		phases: [
			{
				id: "g",
				type: "gate",
				agent: "a",
				task: "judge",
				final: true,
			},
		],
	};
	const res = await withKernel(def, runner(() => "looks good\nVERDICT: PASS"));
	assert.equal(res.state.phases.g.gate?.verdict, "pass");
	assert.equal(res.ok, true);
});

test("kernel: approval auto-reject without requestApproval", async () => {
	const def: Taskflow = {
		name: "k-appr",
		phases: [{ id: "ap", type: "approval", task: "Ship it?", final: true }],
	};
	const res = await withKernel(def, runner(() => "unused"));
	assert.equal(res.state.phases.ap.approval?.decision, "reject");
	assert.equal(res.state.phases.ap.approval?.auto, true);
	assert.equal(res.state.status, "blocked");
});

test("kernel: approval approve via requestApproval", async () => {
	const def: Taskflow = {
		name: "k-appr2",
		phases: [{ id: "ap", type: "approval", task: "Ship?", final: true }],
	};
	const res = await withKernel(def, runner(() => "unused"), {
		requestApproval: async () => ({ decision: "approve", note: "lgtm" }),
	});
	assert.equal(res.state.phases.ap.approval?.decision, "approve");
	assert.equal(res.finalOutput, "lgtm");
	assert.equal(res.ok, true);
});

test("kernel: loop until maxIterations", async () => {
	let n = 0;
	const def: Taskflow = {
		name: "k-loop",
		phases: [
			{
				id: "lp",
				type: "loop",
				agent: "a",
				task: "iter",
				maxIterations: 3,
				convergence: false,
				final: true,
			},
		],
	};
	const res = await withKernel(def, async (_c, _a, agent, task) => {
		n++;
		return {
			agent,
			task,
			exitCode: 0,
			output: `round-${n}`,
			stderr: "",
			usage: emptyUsage(),
			stopReason: "end",
		};
	});
	assert.equal(n, 3);
	assert.equal(res.state.phases.lp.output, "round-3");
	assert.equal(res.ok, true);
});

test("kernel: tournament picks winner", async () => {
	const def: Taskflow = {
		name: "k-tour",
		phases: [
			{
				id: "t",
				type: "tournament",
				agent: "a",
				task: "draft",
				variants: 2,
				judge: "pick best",
				mode: "best",
				final: true,
			},
		],
	};
	let call = 0;
	const res = await withKernel(def, async (_c, _a, agent, task) => {
		call++;
		const isJudge = task.includes("Variant");
		return {
			agent,
			task,
			exitCode: 0,
			output: isJudge ? "I prefer the second.\nWINNER: 2" : `variant-body-${call}`,
			stderr: "",
			usage: emptyUsage(),
			stopReason: "end",
		};
	});
	assert.equal(res.ok, true);
	assert.match(res.finalOutput ?? "", /variant-body/);
});

test("kernel: flow use loads nested subflow", async () => {
	const child: Taskflow = {
		name: "child",
		phases: [{ id: "c", type: "agent", agent: "a", task: "child-work", final: true }],
	};
	const def: Taskflow = {
		name: "parent",
		phases: [{ id: "f", type: "flow", use: "child", final: true }],
	};
	const res = await withKernel(def, runner((t) => `N:${t}`), {
		loadFlow: (name) => (name === "child" ? child : undefined),
	});
	assert.equal(res.ok, true);
	assert.match(res.finalOutput, /child-work/);
});

test("kernel: mixed map+gate+reduce DAG", async () => {
	const def: Taskflow = {
		name: "mixed",
		phases: [
			{ id: "m", type: "map", agent: "a", over: '["x","y"]', task: "do {item}" },
			{
				id: "g",
				type: "gate",
				agent: "a",
				task: "check {steps.m.output}",
				dependsOn: ["m"],
			},
			{
				id: "r",
				type: "reduce",
				agent: "a",
				task: "sum {steps.m.output}",
				dependsOn: ["g", "m"],
				final: true,
			},
		],
	};
	const res = await withKernel(def, runner((t) => {
		if (t.includes("check")) return "VERDICT: PASS";
		return `ok:${t.slice(0, 20)}`;
	}));
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.g.gate?.verdict, "pass");
	assert.equal(res.state.phases.r.status, "done");
});
