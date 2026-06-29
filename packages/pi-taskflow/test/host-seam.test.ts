/**
 * Phase 1 seam test: the host-neutral SubagentRunner contract.
 *
 * Pins the invariant that lets pi-taskflow run on any host (pi, Codex, …):
 *   1. The pi implementation (`piSubagentRunner`) satisfies the `SubagentRunner`
 *      contract structurally.
 *   2. The engine consumes any `runTask` with that shape — a mock runner (the
 *      same shape a Codex runner will have) drives a flow to completion without
 *      spawning a real subagent.
 *
 * If a future change to `runAgentTask`'s signature or the contract types drifts,
 * this test (or typecheck) fails — the seam stays honest.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { piSubagentRunner, type RunResult, type SubagentRunner } from "../src/runner.ts";
import { executeTaskflow, type RuntimeDeps } from "taskflow-core";
import { emptyUsage } from "taskflow-core";
import type { AgentConfig } from "taskflow-core";
import type { Taskflow } from "taskflow-core";
import type { RunState } from "taskflow-core";

const AGENTS: AgentConfig[] = [
	{ name: "executor", description: "test executor", systemPrompt: "", source: "user", filePath: "" },
];

function mkState(def: Taskflow, args: Record<string, unknown> = {}): RunState {
	return {
		runId: "seam-test-run",
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

test("seam: piSubagentRunner satisfies the SubagentRunner contract", () => {
	// Structural: assignable to the contract type (compile-time + runtime shape).
	const runner: SubagentRunner<AgentConfig> = piSubagentRunner;
	assert.equal(typeof runner.runTask, "function");
	// runTask arity matches the contract (defaultCwd, agents, agentName, task,
	// opts, globalThinking?) — at least the 5 required positional params.
	assert.ok(runner.runTask.length >= 5);
});

test("seam: the engine runs against an injected runTask (host-neutral)", async () => {
	// A mock runner identical in shape to what a Codex runner will provide:
	// it never spawns a process, just returns a RunResult.
	const calls: string[] = [];
	const mockRunTask: SubagentRunner<AgentConfig>["runTask"] = async (
		_cwd,
		_agents,
		agentName,
		task,
	): Promise<RunResult> => {
		calls.push(`${agentName}:${task}`);
		return {
			agent: agentName,
			task,
			exitCode: 0,
			output: `did: ${task}`,
			stderr: "",
			usage: { ...emptyUsage(), output: 5, cost: 0.001, turns: 1 },
			model: "test-model",
			stopReason: "end",
		};
	};

	const def: Taskflow = {
		name: "seam-smoke",
		phases: [{ id: "only", type: "agent", agent: "executor", task: "do the thing", final: true }],
	};

	const deps: RuntimeDeps = {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: mockRunTask,
	};

	const res = await executeTaskflow(mkState(def), deps);

	assert.equal(calls.length, 1);
	assert.equal(calls[0], "executor:do the thing");
	assert.match(res.finalOutput, /did: do the thing/);
});
