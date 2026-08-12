/** Adversarial cache/resume coverage for resource-bearing composed flows. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import { CacheStore } from "../src/cache.ts";
import { queueSpawn } from "../src/context-store.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

const AGENTS: AgentConfig[] = [
	{ name: "executor", description: "test", systemPrompt: "", source: "user", filePath: "" },
	{ name: "planner", description: "test", systemPrompt: "", source: "user", filePath: "" },
];

function state(def: Taskflow, cwd: string, runId: string): RunState {
	return {
		runId,
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

function writeEffect(relativePath: string) {
	return {
		id: "report",
		kind: "fs.write" as const,
		target: {
			kind: "path" as const,
			path: {
				workspace: "project",
				subpath: { literalPath: relativePath },
				intent: "create-file" as const,
			},
		},
	};
}

function runner(counter: { calls: number }, plannerOutput?: Taskflow): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task): Promise<RunResult> => {
		counter.calls++;
		const output = agentName === "planner" && plannerOutput
			? JSON.stringify(plannerOutput)
			: `CONTENT:${task}`;
		return {
			agent: agentName,
			task,
			exitCode: 0,
			output,
			stderr: "",
			usage: { ...emptyUsage(), output: 1, turns: 1 },
			stopReason: "end",
		};
	};
}

test("flow.def: a resource-bearing inline child cannot be skipped by a cross-run parent cache hit", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-flow-cache-"));
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-control-"));
	try {
		const child: Taskflow = {
			name: "writer-child",
			phases: [{
				id: "write",
				type: "agent",
				agent: "executor",
				task: "inline",
				effects: [writeEffect("out/report.txt")],
				final: true,
			}],
		};
		const def: Taskflow = {
			name: "inline-parent",
			phases: [{
				id: "child",
				type: "flow",
				def: child,
				cache: { scope: "cross-run" },
				final: true,
			}],
		};
		const counter = { calls: 0 };
		const cacheStore = new CacheStore(control);
		const deps: RuntimeDeps = {
			cwd: root,
			workspaceControlDirectory: control,
			cacheStore,
			agents: AGENTS,
			runTask: runner(counter),
		};

		const first = await executeTaskflow(state(def, root, "inline-first"), deps);
		assert.equal(first.ok, true, first.finalOutput);
		assert.equal(counter.calls, 1);
		fs.rmSync(path.join(root, "out/report.txt"));

		const second = await executeTaskflow(state(def, root, "inline-second"), deps);
		assert.equal(second.ok, true, second.finalOutput);
		assert.equal(counter.calls, 2, "the resource-bearing child must execute again");
		assert.equal(second.state.phases.child?.cacheHit, undefined);
		assert.equal(fs.readFileSync(path.join(root, "out/report.txt"), "utf8"), "CONTENT:inline");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("expand.def: a resource-bearing child cannot be skipped by within-run resume reuse", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-expand-resume-"));
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-control-"));
	try {
		const def: Taskflow = {
			name: "expand-parent",
			phases: [{
				id: "grow",
				type: "expand",
				expandMode: "nested",
				def: {
					name: "expand-child",
					phases: [{
						id: "write",
						type: "agent",
						agent: "executor",
						task: "expand",
						effects: [writeEffect("expanded.txt")],
						final: true,
					}],
				},
				final: true,
			}],
		};
		const counter = { calls: 0 };
		const deps: RuntimeDeps = {
			cwd: root,
			workspaceControlDirectory: control,
			agents: AGENTS,
			runTask: runner(counter),
		};

		const first = await executeTaskflow(state(def, root, "expand-resume"), deps);
		assert.equal(first.ok, true, first.finalOutput);
		assert.equal(counter.calls, 1);
		fs.rmSync(path.join(root, "expanded.txt"));

		const resumed = await executeTaskflow(first.state, deps);
		assert.equal(resumed.ok, true, resumed.finalOutput);
		assert.equal(counter.calls, 2, "resume must re-enter the resource-bearing expand child");
		assert.equal(resumed.state.phases.grow?.cacheHit, undefined);
		assert.equal(fs.readFileSync(path.join(root, "expanded.txt"), "utf8"), "CONTENT:expand");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("dynamic flow.def: an unknown child capability permanently binds the parent invocation root", async () => {
	const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-dynamic-root-a-"));
	const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-dynamic-root-b-"));
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-control-"));
	try {
		const child: Taskflow = {
			name: "planned-writer",
			phases: [{
				id: "write",
				type: "agent",
				agent: "executor",
				task: "dynamic",
				effects: [writeEffect("dynamic.txt")],
				final: true,
			}],
		};
		const def: Taskflow = {
			name: "dynamic-parent",
			phases: [
				{ id: "plan", type: "agent", agent: "planner", task: "plan", output: "json" },
				{ id: "run", type: "flow", def: "{steps.plan.json}", dependsOn: ["plan"], final: true },
			],
		};
		const counter = { calls: 0 };
		const first = await executeTaskflow(state(def, rootA, "dynamic-root"), {
			cwd: rootA,
			workspaceControlDirectory: control,
			agents: AGENTS,
			runTask: runner(counter, child),
		});
		assert.equal(first.ok, true, first.finalOutput);
		assert.ok(first.state.cwdRootBinding, "the parent must persist the capability root");
		assert.equal(fs.readFileSync(path.join(rootA, "dynamic.txt"), "utf8"), "CONTENT:dynamic");

		const rebound = await executeTaskflow(first.state, {
			cwd: rootB,
			workspaceControlDirectory: control,
			agents: AGENTS,
			runTask: runner(counter, child),
		});
		assert.equal(rebound.ok, false);
		assert.match(rebound.finalOutput, /invocation root does not match|start a new run/i);
		assert.equal(fs.existsSync(path.join(rootB, "dynamic.txt")), false);
	} finally {
		fs.rmSync(rootA, { recursive: true, force: true });
		fs.rmSync(rootB, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("ctx_spawn: shareContext cannot cache away a resource-bearing dynamic child", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-spawn-cache-"));
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-control-"));
	try {
		const child: Taskflow = {
			name: "spawned-writer",
			phases: [{
				id: "write",
				type: "agent",
				agent: "executor",
				task: "spawned-write",
				effects: [writeEffect("spawned.txt")],
				final: true,
			}],
		};
		const def: Taskflow = {
			name: "spawn-parent",
			phases: [{
				id: "parent",
				type: "agent",
				agent: "executor",
				task: "queue-child",
				shareContext: true,
				cache: { scope: "cross-run" },
				final: true,
			}],
		};
		const counter = { calls: 0 };
		const runTask: RuntimeDeps["runTask"] = async (_cwd, _agents, agentName, task, options: RunOptions) => {
			counter.calls++;
			if (task.includes("queue-child")) {
				queueSpawn(options.ctxDir!, options.nodeId!, [{ subflow: child }]);
			}
			return {
				agent: agentName,
				task,
				exitCode: 0,
				output: task.includes("spawned-write") ? "SPAWNED" : "PARENT",
				stderr: "",
				usage: { ...emptyUsage(), output: 1, turns: 1 },
				stopReason: "end",
			};
		};
		const deps: RuntimeDeps = {
			cwd: root,
			workspaceControlDirectory: control,
			cacheStore: new CacheStore(control),
			agents: AGENTS,
			runTask,
		};

		const first = await executeTaskflow(state(def, root, "spawn-first"), deps);
		assert.equal(first.ok, true, first.finalOutput);
		assert.equal(counter.calls, 2);
		assert.equal(fs.readFileSync(path.join(root, "spawned.txt"), "utf8"), "SPAWNED");
		fs.rmSync(path.join(root, "spawned.txt"));

		const second = await executeTaskflow(state(def, root, "spawn-second"), deps);
		assert.equal(second.ok, true, second.finalOutput);
		assert.equal(counter.calls, 4, "the parent and resource-bearing spawned child must execute again");
		assert.equal(second.state.phases.parent?.cacheHit, undefined);
		assert.equal(fs.readFileSync(path.join(root, "spawned.txt"), "utf8"), "SPAWNED");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});
