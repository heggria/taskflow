import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { emptyUsage } from "../src/usage.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { queueSpawn, writeFinding, readVisibleFindings } from "../src/context-store.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test", systemPrompt: "", source: "user", filePath: "" },
	{ name: "scout", description: "test", systemPrompt: "", source: "user", filePath: "" },
];

async function tmpCwd(): Promise<string> {
	return fs.promises.mkdtemp(path.join(os.tmpdir(), "ctxtree-cwd-"));
}

function mkState(def: Taskflow, cwd: string, runId = "ctx-run-1"): RunState {
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

function ok(agentName: string, task: string, output: string): RunResult {
	return {
		agent: agentName,
		task,
		exitCode: 0,
		output,
		stderr: "",
		usage: { ...emptyUsage(), output: 5, cost: 0.001, turns: 1 },
		stopReason: "end",
	};
}

test("context-tree: ctxDir+nodeId are injected ONLY when shareContext is on", async () => {
	const cwd = await tmpCwd();
	try {
		const seen: Array<{ phase: string; ctxDir?: string; nodeId?: string }> = [];
		const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task, o: RunOptions) => {
			seen.push({ phase: task.includes("SHARED") ? "shared" : "plain", ctxDir: o.ctxDir, nodeId: o.nodeId });
			return ok(agentName, task, "done");
		};
		const def: Taskflow = {
			name: "mix",
			phases: [
				{ id: "plain", type: "agent", agent: "a", task: "plain work" },
				{ id: "shared", type: "agent", agent: "a", task: "SHARED work", shareContext: true, final: true },
			],
		};
		const res = await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		assert.ok(res.ok);
		const plain = seen.find((s) => s.phase === "plain")!;
		const shared = seen.find((s) => s.phase === "shared")!;
		assert.equal(plain.ctxDir, undefined, "plain phase gets no ctxDir");
		assert.equal(plain.nodeId, undefined);
		assert.ok(shared.ctxDir, "shared phase gets a ctxDir");
		assert.equal(shared.nodeId, "shared", "nodeId derived from phase id");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("context-tree: flow-level contextSharing turns it on for every phase", async () => {
	const cwd = await tmpCwd();
	try {
		const ctxDirs: Array<string | undefined> = [];
		const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task, o: RunOptions) => {
			ctxDirs.push(o.ctxDir);
			return ok(agentName, task, "ok");
		};
		const def: Taskflow = {
			name: "all-shared",
			contextSharing: true,
			phases: [
				{ id: "p1", type: "agent", agent: "a", task: "one" },
				{ id: "p2", type: "agent", agent: "a", task: "two", dependsOn: ["p1"], final: true },
			],
		};
		const res = await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		assert.ok(res.ok);
		assert.equal(ctxDirs.filter(Boolean).length, 2, "both phases got a ctxDir");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("context-tree: a sibling reads a completed sibling's finding via the blackboard", async () => {
	const cwd = await tmpCwd();
	try {
		// Phase p1 writes a finding (simulating ctx_write inside the subagent).
		// Phase p2 (depends on p1) reads it back — proving cross-phase sharing.
		let p2Saw: unknown;
		const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task, o: RunOptions) => {
			if (task.includes("WRITE")) {
				writeFinding(o.ctxDir!, o.nodeId!, "discovered", { files: 12 });
				return ok(agentName, task, "wrote finding");
			}
			// p2: read what p1 stored
			p2Saw = readVisibleFindings(o.ctxDir!, o.nodeId!, "discovered");
			return ok(agentName, task, "read finding");
		};
		const def: Taskflow = {
			name: "share",
			contextSharing: true,
			phases: [
				{ id: "p1", type: "agent", agent: "a", task: "WRITE the finding" },
				{ id: "p2", type: "agent", agent: "a", task: "READ the finding", dependsOn: ["p1"], final: true },
			],
		};
		const res = await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		assert.ok(res.ok);
		assert.deepEqual(p2Saw, { files: 12 }, "p2 read p1's finding from the blackboard");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("context-tree: ctx_spawn intents are picked up and child reports folded into parent output", async () => {
	const cwd = await tmpCwd();
	try {
		const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task, o: RunOptions) => {
			if (task.includes("PARENT")) {
				// Simulate the parent agent calling ctx_spawn for two children.
				queueSpawn(o.ctxDir!, o.nodeId!, [
					{ task: "child task alpha", agent: "scout" },
					{ task: "child task beta" },
				]);
				return ok(agentName, task, "parent base output");
			}
			// Children echo their task so we can assert they ran.
			return ok(agentName, task, `child-result for: ${task}`);
		};
		const def: Taskflow = {
			name: "supervise",
			phases: [
				{ id: "root", type: "agent", agent: "a", task: "PARENT do the orchestration", shareContext: true, final: true },
			],
		};
		const res = await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		assert.ok(res.ok);
		assert.match(res.finalOutput, /parent base output/, "parent's own output preserved");
		assert.match(res.finalOutput, /ctx_spawn: 2 child report/, "spawn block present");
		assert.match(res.finalOutput, /child task alpha/, "child alpha ran");
		assert.match(res.finalOutput, /child task beta/, "child beta ran");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("context-tree: recursive spawn (child spawns grandchild) is folded in", async () => {
	const cwd = await tmpCwd();
	try {
		const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task, o: RunOptions) => {
			if (task.includes("PARENT")) {
				queueSpawn(o.ctxDir!, o.nodeId!, [{ task: "CHILD does subwork" }]);
				return ok(agentName, task, "parent out");
			}
			if (task.includes("CHILD")) {
				queueSpawn(o.ctxDir!, o.nodeId!, [{ task: "grandchild leaf" }]);
				return ok(agentName, task, "child out");
			}
			return ok(agentName, task, "grandchild out");
		};
		const def: Taskflow = {
			name: "recursive",
			phases: [{ id: "root", type: "agent", agent: "a", task: "PARENT", shareContext: true, final: true }],
		};
		const res = await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		assert.ok(res.ok);
		assert.match(res.finalOutput, /child out/);
		assert.match(res.finalOutput, /grandchild out/, "grandchild ran via recursion");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("context-tree: spawn bookkeeping never sinks the phase (fail-open)", async () => {
	const cwd = await tmpCwd();
	try {
		// A child that fails should not fail the parent phase.
		const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task, o: RunOptions) => {
			if (task.includes("PARENT")) {
				queueSpawn(o.ctxDir!, o.nodeId!, [{ task: "doomed child" }]);
				return ok(agentName, task, "parent ok");
			}
			throw new Error("child blew up");
		};
		const def: Taskflow = {
			name: "failopen",
			phases: [{ id: "root", type: "agent", agent: "a", task: "PARENT", shareContext: true, final: true }],
		};
		const res = await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		assert.ok(res.ok, "parent phase still succeeds despite child failure");
		assert.match(res.finalOutput, /parent ok/);
		assert.match(res.finalOutput, /spawned child failed/, "child failure recorded, not thrown");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("context-tree: map items each get a distinct nodeId and register in the tree", async () => {
	const cwd = await tmpCwd();
	try {
		const nodeIds: string[] = [];
		const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task, o: RunOptions) => {
			if (o.nodeId) nodeIds.push(o.nodeId);
			return ok(agentName, task, "item done");
		};
		const def: Taskflow = {
			name: "mapshare",
			phases: [
				{ id: "list", type: "agent", agent: "a", task: "emit", output: "json" },
				{
					id: "fan",
					type: "map",
					over: '["x","y","z"]',
					as: "item",
					agent: "a",
					task: "process {item}",
					shareContext: true,
					dependsOn: ["list"],
					final: true,
				},
			],
		};
		const res = await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		assert.ok(res.ok);
		const fanIds = nodeIds.filter((n) => n.startsWith("fan-"));
		assert.equal(new Set(fanIds).size, 3, "three distinct map-item nodeIds");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("context-tree: a flow with no sharing never touches the ctx dir", async () => {
	const cwd = await tmpCwd();
	try {
		const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task, o: RunOptions) => {
			assert.equal(o.ctxDir, undefined);
			assert.equal(o.nodeId, undefined);
			return ok(agentName, task, "ok");
		};
		const def: Taskflow = {
			name: "no-share",
			phases: [{ id: "p", type: "agent", agent: "a", task: "work", final: true }],
		};
		const res = await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		assert.ok(res.ok);
		assert.ok(!fs.existsSync(path.join(cwd, ".pi", "taskflows", "runs", "ctx")), "no ctx dir created");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
