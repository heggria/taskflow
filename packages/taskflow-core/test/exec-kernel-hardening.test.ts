/**
 * P0/P1 hardening: budget, deps/when, recursion, dynamic def, feature fall-back.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunResult } from "../src/runner-core.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { canUseEventKernel, kernelUnsupportedReason } from "../src/exec/driver.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";
import type { TraceEvent, TraceSink } from "../src/trace.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "t", systemPrompt: "", source: "user", filePath: "" },
];

function mk(def: Taskflow, id = "h"): RunState {
	return {
		runId: id,
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

function paidRunner(cost = 1): RuntimeDeps["runTask"] {
	return async (_c, _a, agent, task): Promise<RunResult> => ({
		agent,
		task,
		exitCode: 0,
		output: "ok",
		stderr: "",
		usage: { ...emptyUsage(), cost, input: 100, output: 100, turns: 1 },
		stopReason: "end",
	});
}

test("feature fall-back: score gate refuses kernel", () => {
	const def: Taskflow = {
		name: "scored",
		phases: [
			{
				id: "g",
				type: "gate",
				agent: "a",
				task: "x",
				score: {
					target: "{previous.output}",
					scorers: [{ type: "contains", name: "c", pattern: "ok" }],
				},
				final: true,
			},
		],
	};
	assert.equal(canUseEventKernel(def), false);
	assert.match(kernelUnsupportedReason(def) ?? "", /score/);
});

test("feature fall-back: retry refuses kernel", () => {
	const def: Taskflow = {
		name: "r",
		phases: [{ id: "a", type: "agent", agent: "a", task: "t", retry: { max: 2 }, final: true }],
	};
	assert.equal(canUseEventKernel(def), false);
});

test("budget: second phase skipped after cost cap on kernel", async () => {
	const events: TraceEvent[] = [];
	const sink: TraceSink = { emit: (e) => events.push(e), flush: () => {} };
	const def: Taskflow = {
		name: "bud",
		budget: { maxUSD: 0.5 },
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "expensive" },
			{ id: "b", type: "agent", agent: "a", task: "after", dependsOn: ["a"], final: true },
		],
	};
	const res = await executeTaskflow(mk(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: paidRunner(1.0),
		persist: () => {},
		eventKernel: true,
		trace: sink,
	});
	assert.equal(res.state.phases.a.status, "done");
	assert.equal(res.state.phases.b.status, "skipped");
	assert.equal(res.state.status, "blocked");
	assert.ok(events.some((e) => e.kind === "decision" && e.decision?.type === "budget-hit"));
});

test("when-skip upstream: dependent skipped (not run) on kernel", async () => {
	let calls = 0;
	const def: Taskflow = {
		name: "when-dep",
		phases: [
			{ id: "opt", type: "agent", agent: "a", task: "maybe", when: "false" },
			{ id: "next", type: "agent", agent: "a", task: "after", dependsOn: ["opt"], final: true },
		],
	};
	const res = await executeTaskflow(mk(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: async (_c, _a, agent, task) => {
			calls++;
			return {
				agent,
				task,
				exitCode: 0,
				output: "x",
				stderr: "",
				usage: emptyUsage(),
				stopReason: "end",
			};
		},
		persist: () => {},
		eventKernel: true,
	});
	assert.equal(res.state.phases.opt.status, "skipped");
	assert.equal(res.state.phases.next.status, "skipped");
	assert.equal(calls, 0);
});

test("join any: runs when one dep done", async () => {
	const def: Taskflow = {
		name: "join",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "a" },
			{ id: "b", type: "agent", agent: "a", task: "b", when: "false" },
			{
				id: "m",
				type: "agent",
				agent: "a",
				task: "merge",
				dependsOn: ["a", "b"],
				join: "any",
				final: true,
			},
		],
	};
	const res = await executeTaskflow(mk(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: paidRunner(0.01),
		persist: () => {},
		eventKernel: true,
	});
	// a done, b skipped → join any: a is depOk → m runs
	assert.equal(res.state.phases.a.status, "done");
	assert.equal(res.state.phases.b.status, "skipped");
	assert.equal(res.state.phases.m.status, "done");
});

test("steps.json populated for output:json phases", async () => {
	const def: Taskflow = {
		name: "js",
		phases: [
			{
				id: "j",
				type: "agent",
				agent: "a",
				task: "emit",
				output: "json",
			},
			{
				id: "use",
				type: "agent",
				agent: "a",
				task: "got {steps.j.json.v}",
				dependsOn: ["j"],
				final: true,
			},
		],
	};
	const res = await executeTaskflow(mk(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: async (_c, _a, agent, task) => ({
			agent,
			task,
			exitCode: 0,
			output: task.includes("got") ? `OUT:${task}` : '{"v":42}',
			stderr: "",
			usage: emptyUsage(),
			stopReason: "end",
		}),
		persist: () => {},
		eventKernel: true,
	});
	assert.equal(res.state.phases.j.json && (res.state.phases.j.json as { v: number }).v, 42);
	assert.match(res.finalOutput, /got 42/);
});

test("gate eval parse error does not auto-pass (fail-safe)", async () => {
	let llm = 0;
	const def: Taskflow = {
		name: "eval-fail",
		phases: [
			{
				id: "g",
				type: "gate",
				agent: "a",
				task: "judge",
				// deliberately unparseable comparison — tryEvaluate returns error
				eval: ["{{{{not a valid expr"],
				final: true,
			},
		],
	};
	const res = await executeTaskflow(mk(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: async (_c, _a, agent, task) => {
			llm++;
			return {
				agent,
				task,
				exitCode: 0,
				output: "VERDICT: PASS",
				stderr: "",
				usage: emptyUsage(),
				stopReason: "end",
			};
		},
		persist: () => {},
		eventKernel: true,
	});
	// Must call LLM because eval failed open-as-failed-check
	assert.ok(llm >= 1);
	assert.equal(res.state.phases.g.gate?.verdict, "pass");
});

test("flow cycle A→B→A fails on kernel", async () => {
	const flows: Record<string, Taskflow> = {
		A: {
			name: "A",
			phases: [{ id: "f", type: "flow", use: "B", final: true }],
		},
		B: {
			name: "B",
			phases: [{ id: "f", type: "flow", use: "A", final: true }],
		},
	};
	const res = await executeTaskflow(mk(flows.A), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: paidRunner(0.01),
		persist: () => {},
		eventKernel: true,
		loadFlow: (n) => flows[n],
	});
	assert.equal(res.ok, false);
	assert.match(res.state.phases.f.error ?? "", /recursive/i);
});

test("dynamic flow def with script fails open (done empty) not ACE", async () => {
	const def: Taskflow = {
		name: "parent",
		phases: [
			{
				id: "f",
				type: "flow",
				def: {
					name: "evil",
					phases: [{ id: "s", type: "script", run: "echo pwned", final: true }],
				},
				final: true,
			},
		],
	};
	const res = await executeTaskflow(mk(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: paidRunner(0.01),
		persist: () => {},
		eventKernel: true,
	});
	// dynamic validation rejects script in generated def → fail-open empty done
	assert.equal(res.state.phases.f.status, "done");
	assert.equal(res.state.phases.f.output ?? "", "");
});
