/**
 * S2 hard gate: event-kernel path vs imperative path for supported kinds.
 * When both paths run the same flow with the same mock runner, phase status
 * and final output shape must agree (strangler flip readiness).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { canUseEventKernel } from "../src/exec/driver.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test", systemPrompt: "", source: "user", filePath: "" },
];

function mkState(def: Taskflow, runId: string): RunState {
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

function deterministicRunner(): RuntimeDeps["runTask"] {
	return async (_c, _a, agent, task, _o: RunOptions): Promise<RunResult> => ({
		agent,
		task,
		exitCode: 0,
		output: `OUT:${task}`,
		stderr: "",
		usage: { ...emptyUsage(), input: 1, output: task.length, cost: 0.001, turns: 1 },
		stopReason: "end",
	});
}

async function runBoth(def: Taskflow) {
	const runTask = deterministicRunner();
	const kernel = await executeTaskflow(mkState(def, "k"), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask,
		persist: () => {},
		eventKernel: true,
	});
	const imp = await executeTaskflow(mkState(def, "i"), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask,
		persist: () => {},
		eventKernel: false,
	});
	return { kernel, imp };
}

test("canUseEventKernel: map+parallel accepted; gate rejected", () => {
	assert.equal(
		canUseEventKernel({
			name: "ok",
			phases: [
				{ id: "m", type: "map", agent: "a", over: '["x"]', task: "{item}" },
				{ id: "p", type: "parallel", branches: [{ task: "t1" }, { task: "t2" }], final: true },
			],
		}),
		true,
	);
	assert.equal(
		canUseEventKernel({
			name: "no",
			phases: [{ id: "g", type: "gate", agent: "a", task: "judge", final: true }],
		}),
		false,
	);
});

test("parity: agent chain — status + finalOutput agree", async () => {
	const def: Taskflow = {
		name: "parity-agent",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "one" },
			{ id: "b", type: "agent", agent: "a", task: "two", dependsOn: ["a"], final: true },
		],
	};
	const { kernel, imp } = await runBoth(def);
	assert.equal(kernel.ok, imp.ok);
	assert.equal(kernel.state.phases.a.status, imp.state.phases.a.status);
	assert.equal(kernel.state.phases.b.status, imp.state.phases.b.status);
	assert.equal(kernel.finalOutput, imp.finalOutput);
});

test("parity: map over static array — status + item count markers agree", async () => {
	const def: Taskflow = {
		name: "parity-map",
		phases: [
			{
				id: "m",
				type: "map",
				agent: "a",
				over: '["alpha","beta"]',
				task: "do {item}",
				final: true,
			},
		],
	};
	const { kernel, imp } = await runBoth(def);
	assert.equal(kernel.ok, true);
	assert.equal(imp.ok, true);
	assert.equal(kernel.state.phases.m.status, "done");
	assert.equal(imp.state.phases.m.status, "done");
	// Both label items 1/2 and 2/2
	assert.match(kernel.finalOutput, /\[1\/2\]/);
	assert.match(kernel.finalOutput, /\[2\/2\]/);
	assert.match(imp.finalOutput, /\[1\/2\]/);
	assert.match(imp.finalOutput, /\[2\/2\]/);
	assert.match(kernel.finalOutput, /OUT:do alpha/);
	assert.match(imp.finalOutput, /OUT:do alpha/);
});

test("parity: parallel branches — status + both branch outputs", async () => {
	const def: Taskflow = {
		name: "parity-par",
		phases: [
			{
				id: "p",
				type: "parallel",
				branches: [{ task: "left", agent: "a" }, { task: "right", agent: "a" }],
				final: true,
			},
		],
	};
	const { kernel, imp } = await runBoth(def);
	assert.equal(kernel.ok, imp.ok);
	assert.equal(kernel.state.phases.p.status, imp.state.phases.p.status);
	assert.match(kernel.finalOutput, /OUT:left/);
	assert.match(kernel.finalOutput, /OUT:right/);
	assert.match(imp.finalOutput, /OUT:left/);
	assert.match(imp.finalOutput, /OUT:right/);
});

test("parity: script phase stdout agrees", async () => {
	const def: Taskflow = {
		name: "parity-script",
		phases: [
			{
				id: "s",
				type: "script",
				run: ["node", "-e", "process.stdout.write('parity-ok')"],
				final: true,
			},
		],
	};
	const { kernel, imp } = await runBoth(def);
	assert.equal(kernel.finalOutput, "parity-ok");
	assert.equal(imp.finalOutput, "parity-ok");
	assert.equal(kernel.state.phases.s.status, "done");
	assert.equal(imp.state.phases.s.status, "done");
});
