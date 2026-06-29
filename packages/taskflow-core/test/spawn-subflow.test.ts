import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { queueSpawn } from "../src/context-store.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "t", systemPrompt: "", source: "user", filePath: "" },
	{ name: "scout", description: "t", systemPrompt: "", source: "user", filePath: "" },
	{ name: "analyst", description: "t", systemPrompt: "", source: "user", filePath: "" },
];

async function tmpCwd(): Promise<string> {
	return fs.promises.mkdtemp(path.join(os.tmpdir(), "spawn-sub-cwd-"));
}

function mkState(def: Taskflow, cwd: string): RunState {
	return {
		runId: "spawn-sub-run",
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
	};
}

function ok(agentName: string, task: string, output: string, cost = 0.001): RunResult {
	return {
		agent: agentName,
		task,
		exitCode: 0,
		output,
		stderr: "",
		usage: { ...emptyUsage(), output: 5, cost, turns: 1 },
		stopReason: "end",
	};
}

test("spawn-subflow: a spawned subflow runs its phases (dependsOn order) and folds in", async () => {
	const cwd = await tmpCwd();
	try {
		const ran: string[] = [];
		const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task, o: RunOptions) => {
			if (task.includes("PARENT")) {
				queueSpawn(o.ctxDir!, o.nodeId!, [
					{
						subflow: {
							phases: [
								{ id: "scan", type: "agent", agent: "scout", task: "scan the repo" },
								{ id: "audit", type: "agent", agent: "analyst", task: "audit using {steps.scan.output}", dependsOn: ["scan"], final: true },
							],
						},
					},
				]);
				return ok(agentName, task, "parent base");
			}
			ran.push(task.replace(/^.*?\n*/s, "").slice(0, 20));
			if (task.includes("scan the repo")) return ok(agentName, task, "SCAN-RESULT");
			return ok(agentName, task, `audit done (saw: ${task.includes("SCAN-RESULT") ? "scan" : "nothing"})`);
		};
		const def: Taskflow = {
			name: "host",
			phases: [{ id: "lead", type: "agent", agent: "a", task: "PARENT orchestrate", shareContext: true, final: true }],
		};
		const res = await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		assert.ok(res.ok, "run ok");
		assert.match(res.finalOutput, /parent base/, "parent output preserved");
		assert.match(res.finalOutput, /ctx_spawn: 1 child report/, "spawn fold marker present");
		// The subflow's final phase output (audit) must be the spawned child's reported output.
		assert.match(res.finalOutput, /audit done/, "subflow final phase ran and folded in");
		// dependsOn worked: audit saw the scan output (interpolation across inner phases).
		assert.match(res.finalOutput, /saw: scan/, "inner dependsOn + interpolation worked");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("spawn-subflow: spawned subflow usage is folded into the parent phase usage (budget honesty)", async () => {
	const cwd = await tmpCwd();
	try {
		const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task, o: RunOptions) => {
			if (task.includes("PARENT")) {
				queueSpawn(o.ctxDir!, o.nodeId!, [
					{ subflow: { phases: [{ id: "x", type: "agent", agent: "scout", task: "expensive work", final: true }] } },
				]);
				return ok(agentName, task, "parent base", 0.002);
			}
			return ok(agentName, task, "child out", 0.05); // pricey child
		};
		const def: Taskflow = {
			name: "host",
			phases: [{ id: "lead", type: "agent", agent: "a", task: "PARENT", shareContext: true, final: true }],
		};
		const res = await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		const leadUsage = res.state.phases.lead.usage;
		// Parent (0.002) + spawned subflow child (0.05) must both be counted.
		assert.ok(leadUsage && leadUsage.cost >= 0.05, `spawned spend folded into parent usage (got ${leadUsage?.cost})`);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("spawn-subflow: defaultAgent fills inner phases with no agent", async () => {
	const cwd = await tmpCwd();
	try {
		const agentsSeen: string[] = [];
		const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task, o: RunOptions) => {
			if (task.includes("PARENT")) {
				queueSpawn(o.ctxDir!, o.nodeId!, [
					{ subflow: { phases: [{ id: "x", type: "agent", task: "no-agent phase", final: true }] }, defaultAgent: "analyst" },
				]);
				return ok(agentName, task, "base");
			}
			agentsSeen.push(agentName);
			return ok(agentName, task, "child out");
		};
		const def: Taskflow = {
			name: "host",
			phases: [{ id: "lead", type: "agent", agent: "a", task: "PARENT", shareContext: true, final: true }],
		};
		await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		assert.ok(agentsSeen.includes("analyst"), `defaultAgent applied to agentless inner phase (saw ${agentsSeen})`);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("spawn-subflow: a MAP item that ctx_spawns is drained (regression: map-item spawns were orphaned)", async () => {
	const cwd = await tmpCwd();
	try {
		const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task, o: RunOptions) => {
			// Each map item spawns one flat child.
			if (task.includes("ITEM") && o.ctxDir && o.nodeId) {
				queueSpawn(o.ctxDir, o.nodeId, [{ task: `deep-dive for ${task.slice(-3)}`, agent: "scout" }]);
				return ok(agentName, task, "item base");
			}
			return ok(agentName, task, "child deep-dive done");
		};
		const def: Taskflow = {
			name: "host",
			contextSharing: true,
			phases: [
				{ id: "fan", type: "map", over: '["a","b"]', as: "item", agent: "analyst", task: "ITEM {item}", final: true },
			],
		};
		const res = await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		assert.ok(res.ok);
		// Both map items' spawned children must have run and folded in.
		const folds = (res.finalOutput.match(/ctx_spawn: \d+ child report/g) ?? []).length;
		assert.ok(folds >= 2, `each map item's spawn drained & folded (got ${folds} fold markers)`);
		assert.match(res.finalOutput, /child deep-dive done/, "spawned child output present");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
