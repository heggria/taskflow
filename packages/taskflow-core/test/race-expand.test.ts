/**
 * Horizon B: race + expand (nested/graft) imperative runtime.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { validateTaskflow, type Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { emptyUsage } from "../src/usage.ts";
import type { AgentConfig } from "../src/agents.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "t", systemPrompt: "", source: "user", filePath: "" },
];

function mkState(def: Taskflow): RunState {
	return {
		runId: "race-expand-test",
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

function runner(fn: (task: string) => string | Promise<string>): RuntimeDeps["runTask"] {
	return async (_c, _a, agent, task, _o: RunOptions): Promise<RunResult> => ({
		agent,
		task,
		exitCode: 0,
		output: await fn(task),
		stderr: "",
		usage: { ...emptyUsage(), input: 1, output: 1, cost: 0.001, turns: 1 },
		stopReason: "end",
	});
}

test("validate: race + expand shapes", () => {
	assert.equal(
		validateTaskflow({
			name: "r",
			phases: [
				{
					id: "r",
					type: "race",
					branches: [
						{ task: "a", agent: "a" },
						{ task: "b", agent: "a" },
					],
					final: true,
				},
			],
		}).ok,
		true,
	);
	assert.equal(
		validateTaskflow({
			name: "e",
			phases: [
				{
					id: "e",
					type: "expand",
					def: { name: "child", phases: [{ id: "c", type: "script", run: "echo hi", final: true }] },
					expandMode: "nested",
					final: true,
				},
			],
		}).ok,
		true,
	);
});

test("race: first completed branch wins", async () => {
	const def: Taskflow = {
		name: "race-flow",
		phases: [
			{
				id: "r",
				type: "race",
				branches: [
					{ task: "slow", agent: "a" },
					{ task: "fast", agent: "a" },
				],
				final: true,
			},
		],
	};
	const st = mkState(def);
	await executeTaskflow(st, {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: runner(async (task) => {
			if (task.includes("slow")) {
				await new Promise((r) => setTimeout(r, 40));
				return "SLOW";
			}
			return "FAST";
		}),
	});
	assert.equal(st.status, "completed");
	assert.equal(st.phases.r?.status, "done");
	assert.equal(st.phases.r?.output?.trim(), "FAST");
	assert.ok(st.phases.r?.warnings?.some((w) => /branch 2/.test(w)));
});

test("expand nested: runs fragment as sub-flow", async () => {
	const def: Taskflow = {
		name: "exp-nested",
		phases: [
			{
				id: "e",
				type: "expand",
				expandMode: "nested",
				def: {
					name: "frag",
					phases: [{ id: "inner", type: "agent", agent: "a", task: "say nested-hi", final: true }],
				},
				final: true,
			},
		],
	};
	const st = mkState(def);
	await executeTaskflow(st, {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: runner((t) => (t.includes("nested") ? "nested-hi" : "x")),
	});
	assert.equal(st.status, "completed");
	assert.equal(st.phases.e?.status, "done");
	assert.equal(st.phases.e?.defError, undefined, st.phases.e?.defError);
	assert.match(st.phases.e?.output ?? "", /nested-hi/);
	// nested: child id not on parent
	assert.equal(st.phases.inner, undefined);
});

test("expand graft: promotes child phases onto parent", async () => {
	const def: Taskflow = {
		name: "exp-graft",
		phases: [
			{
				id: "grow",
				type: "expand",
				expandMode: "graft",
				def: {
					name: "frag",
					phases: [{ id: "leaf", type: "agent", agent: "a", task: "say grafted", final: true }],
				},
				final: true,
			},
		],
	};
	const st = mkState(def);
	await executeTaskflow(st, {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: runner((t) => (t.includes("grafted") ? "grafted-ok" : "x")),
	});
	assert.equal(st.status, "completed");
	assert.equal(st.phases.grow?.status, "done");
	assert.equal(st.phases.grow?.defError, undefined, st.phases.grow?.defError);
	// grafted id is grow-leaf
	assert.equal(st.phases["grow-leaf"]?.status, "done");
	assert.match(st.phases["grow-leaf"]?.output ?? "", /grafted-ok/);
});
