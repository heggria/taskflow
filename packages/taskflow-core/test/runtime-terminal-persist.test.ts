import assert from "node:assert/strict";
import { test } from "node:test";
import { executeTaskflow, type RunState, type RuntimeDeps, type Taskflow } from "../src/index.ts";

async function assertAtomicTerminalPersist(eventKernel: boolean): Promise<void> {
	const def: Taskflow = {
		name: "terminal-atomic",
		phases: [{ id: "work", type: "agent", agent: "executor", task: "work", final: true }],
	};
	const now = Date.now();
	const state: RunState = {
		runId: "terminal-atomic-run",
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: now,
		updatedAt: now,
		cwd: process.cwd(),
	};
	const terminalSnapshots: RunState[] = [];
	const deps: RuntimeDeps = {
		cwd: process.cwd(),
		eventKernel,
		agents: [{
			name: "executor",
			description: "test",
			systemPrompt: "test",
			source: "built-in",
			filePath: "test",
		}],
		runTask: async () => ({
			agent: "executor",
			task: "work",
			exitCode: 0,
			output: "durable result",
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
			stopReason: "end",
		}),
		persist: (snapshot) => {
			if (snapshot.status !== "running") terminalSnapshots.push(structuredClone(snapshot));
		},
	};

	const result = await executeTaskflow(state, deps);
	assert.equal(result.finalOutput, "durable result");
	assert.equal(terminalSnapshots.length, 1);
	assert.equal(terminalSnapshots[0]!.status, "completed");
	assert.equal(terminalSnapshots[0]!.finalOutput, "durable result");
	assert.equal(terminalSnapshots[0]!.outputSourcePhaseId, "work");
}

for (const eventKernel of [false, true]) {
	test(
		`runtime: first terminal persist already includes final output (${eventKernel ? "event kernel" : "imperative"})`,
		() => assertAtomicTerminalPersist(eventKernel),
	);
}

test("runtime: pre-execution failure persists its terminal diagnostic atomically", async () => {
	const def: Taskflow = {
		name: "terminal-invalid",
		args: { target: { type: "string", required: true } },
		phases: [{ id: "work", type: "script", run: "true", final: true }],
	};
	const now = Date.now();
	const state: RunState = {
		runId: "terminal-invalid-run",
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: now,
		updatedAt: now,
		cwd: process.cwd(),
	};
	let terminal: RunState | undefined;
	const result = await executeTaskflow(state, {
		cwd: process.cwd(),
		agents: [],
		persist: (snapshot) => { terminal = structuredClone(snapshot); },
	});
	assert.equal(result.ok, false);
	assert.match(result.finalOutput, /invocation is invalid/);
	assert.equal(terminal?.status, "failed");
	assert.equal(terminal?.finalOutput, result.finalOutput);
});
