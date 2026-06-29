import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { queueSpawn } from "../src/context-store.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { MAX_DYNAMIC_NESTING, type Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "t", systemPrompt: "", source: "user", filePath: "" },
	{ name: "scout", description: "t", systemPrompt: "", source: "user", filePath: "" },
];

async function tmpCwd(): Promise<string> {
	return fs.promises.mkdtemp(path.join(os.tmpdir(), "spawn-val-cwd-"));
}
function mkState(def: Taskflow, cwd: string): RunState {
	return { runId: "r", flowName: def.name, def, args: {}, status: "running", phases: {}, createdAt: Date.now(), updatedAt: Date.now(), cwd };
}
function ok(agentName: string, task: string, output: string): RunResult {
	return { agent: agentName, task, exitCode: 0, output, stderr: "", usage: { ...emptyUsage(), output: 1, turns: 1 }, stopReason: "end" };
}

test("spawn-subflow-validate: a subflow with a cycle fails open (diagnostic folded, run continues)", async () => {
	const cwd = await tmpCwd();
	try {
		const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task, o: RunOptions) => {
			if (task.includes("PARENT")) {
				queueSpawn(o.ctxDir!, o.nodeId!, [
					{
						subflow: {
							phases: [
								{ id: "x", type: "agent", agent: "scout", task: "x", dependsOn: ["y"] },
								{ id: "y", type: "agent", agent: "scout", task: "y", dependsOn: ["x"] },
							],
						},
					},
				]);
				return ok(agentName, task, "parent base");
			}
			return ok(agentName, task, "should-not-run");
		};
		const def: Taskflow = {
			name: "host",
			phases: [{ id: "lead", type: "agent", agent: "a", task: "PARENT", shareContext: true, final: true }],
		};
		const res = await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		assert.ok(res.ok, "run still ok (fail-open)");
		assert.match(res.finalOutput, /parent base/, "parent output preserved");
		assert.match(res.finalOutput, /failed validation|failed verification/, "diagnostic folded in");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("spawn-subflow-validate: a malformed subflow (not a taskflow) fails open", async () => {
	const cwd = await tmpCwd();
	try {
		const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task, o: RunOptions) => {
			if (task.includes("PARENT")) {
				queueSpawn(o.ctxDir!, o.nodeId!, [{ subflow: { not: "a taskflow" } }]);
				return ok(agentName, task, "base");
			}
			return ok(agentName, task, "x");
		};
		const def: Taskflow = {
			name: "host",
			phases: [{ id: "lead", type: "agent", agent: "a", task: "PARENT", shareContext: true, final: true }],
		};
		const res = await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		assert.ok(res.ok);
		assert.match(res.finalOutput, /not a Taskflow/, "shape diagnostic folded");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("spawn-subflow-validate: empty subflow is a benign no-op", async () => {
	const cwd = await tmpCwd();
	try {
		const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task, o: RunOptions) => {
			if (task.includes("PARENT")) {
				queueSpawn(o.ctxDir!, o.nodeId!, [{ subflow: { phases: [] } }]);
				return ok(agentName, task, "base");
			}
			return ok(agentName, task, "x");
		};
		const def: Taskflow = {
			name: "host",
			phases: [{ id: "lead", type: "agent", agent: "a", task: "PARENT", shareContext: true, final: true }],
		};
		const res = await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		assert.ok(res.ok);
		assert.match(res.finalOutput, /no-op/, "empty subflow treated as no-op");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("spawn-subflow-nesting: deeply nested spawn-subflows are bounded by MAX_DYNAMIC_NESTING", async () => {
	const cwd = await tmpCwd();
	try {
		// Every spawned subflow's inner phase, when run, spawns ANOTHER subflow.
		// Without a unified counter this recurses forever; the _stack `def:spawn-*`
		// frame must trip MAX_DYNAMIC_NESTING and fail open.
		const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task, o: RunOptions) => {
			if (o.ctxDir && o.nodeId) {
				queueSpawn(o.ctxDir, o.nodeId, [
					{ subflow: { phases: [{ id: "deeper", type: "agent", agent: "scout", task: "go deeper", shareContext: true, final: true }] } },
				]);
			}
			return ok(agentName, task, "level out");
		};
		const def: Taskflow = {
			name: "host",
			phases: [{ id: "lead", type: "agent", agent: "a", task: "start deep", shareContext: true, final: true }],
		};
		const res = await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		// Must terminate (not hang / stack overflow) and surface the nesting rejection.
		assert.ok(res.ok, "terminated cleanly");
		assert.match(res.finalOutput, new RegExp(`MAX_DYNAMIC_NESTING \\(${MAX_DYNAMIC_NESTING}\\)`), "nesting cap tripped");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
