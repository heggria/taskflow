import assert from "node:assert/strict";
import { test } from "node:test";
import { desugar, isShorthand, validateTaskflow } from "../extensions/schema.ts";
import type { AgentConfig } from "../extensions/agents.ts";
import type { RunOptions, RunResult } from "../extensions/runner.ts";
import { emptyUsage } from "../extensions/usage.ts";
import { executeTaskflow, type RuntimeDeps } from "../extensions/runtime.ts";
import type { RunState } from "../extensions/store.ts";

// ---------------------------------------------------------------------------
// isShorthand
// ---------------------------------------------------------------------------

test("isShorthand: detects task / tasks / chain, rejects phases and non-objects", () => {
	assert.equal(isShorthand({ task: "do it" }), true);
	assert.equal(isShorthand({ tasks: [{ task: "a" }] }), true);
	assert.equal(isShorthand({ chain: [{ task: "a" }] }), true);
	// A real DSL (has phases) is NOT shorthand even if it also has a stray task.
	assert.equal(isShorthand({ phases: [{ id: "x" }], task: "ignored" }), false);
	assert.equal(isShorthand({ name: "x" }), false);
	assert.equal(isShorthand(null), false);
	assert.equal(isShorthand("string"), false);
});

// ---------------------------------------------------------------------------
// desugar — structure
// ---------------------------------------------------------------------------

test("desugar single: { task } → one agent phase marked final", () => {
	const def = desugar({ task: "summarize the repo" });
	assert.equal(def.name, "task");
	assert.equal(def.phases.length, 1);
	assert.equal(def.phases[0].id, "main");
	assert.equal(def.phases[0].type, "agent");
	assert.equal(def.phases[0].task, "summarize the repo");
	assert.equal(def.phases[0].final, true);
	assert.equal(def.phases[0].agent, undefined);
	assert.equal(validateTaskflow(def).ok, true);
});

test("desugar single: { agent, task } sets the agent", () => {
	const def = desugar({ agent: "explorer", task: "look around" });
	assert.equal(def.phases[0].agent, "explorer");
});

test("desugar parallel: { tasks } → one parallel phase with branches", () => {
	const def = desugar({ tasks: [{ task: "a" }, { task: "b", agent: "writer" }] });
	assert.equal(def.name, "parallel");
	assert.equal(def.phases.length, 1);
	assert.equal(def.phases[0].type, "parallel");
	assert.deepEqual(def.phases[0].branches, [{ task: "a" }, { task: "b", agent: "writer" }]);
	assert.equal(def.phases[0].final, true);
	assert.equal(validateTaskflow(def).ok, true);
});

test("desugar chain: { chain } → sequential agent phases, deps wired, last is final", () => {
	const def = desugar({ chain: [{ task: "first" }, { task: "use {previous.output}" }, { task: "finish", agent: "writer" }] });
	assert.equal(def.name, "chain");
	assert.equal(def.phases.length, 3);
	assert.deepEqual(def.phases.map((p) => p.id), ["step1", "step2", "step3"]);
	assert.equal(def.phases[0].dependsOn, undefined);
	assert.deepEqual(def.phases[1].dependsOn, ["step1"]);
	assert.deepEqual(def.phases[2].dependsOn, ["step2"]);
	assert.equal(def.phases[2].agent, "writer");
	assert.equal(def.phases[2].final, true);
	// only the last is final
	assert.equal(def.phases.filter((p) => p.final).length, 1);
	assert.equal(validateTaskflow(def).ok, true);
});

test("desugar: carries through name, description, concurrency, agentScope, args", () => {
	const def = desugar({
		name: "my-flow",
		description: "desc",
		concurrency: 4,
		agentScope: "both",
		args: { dir: { default: "src" } },
		tasks: [{ task: "a" }],
	});
	assert.equal(def.name, "my-flow");
	assert.equal(def.description, "desc");
	assert.equal(def.concurrency, 4);
	assert.equal(def.agentScope, "both");
	assert.deepEqual(def.args, { dir: { default: "src" } });
});

test("desugar: string steps are accepted (task-only shorthand inside arrays)", () => {
	const def = desugar({ chain: ["one", "two"] });
	assert.equal(def.phases.length, 2);
	assert.equal(def.phases[0].task, "one");
	assert.equal(def.phases[1].task, "two");
});

test("desugar: throws when no recognizable shorthand field is present", () => {
	assert.throws(() => desugar({ name: "x" }), /needs one of/);
	assert.throws(() => desugar(null), /must be an object/);
});

test("desugar: precedence chain > tasks > task", () => {
	const def = desugar({ chain: [{ task: "c" }], tasks: [{ task: "t" }], task: "s" });
	assert.equal(def.name, "chain");
	assert.equal(def.phases.length, 1);
	assert.equal(def.phases[0].task, "c");
});

// ---------------------------------------------------------------------------
// desugar — end-to-end execution through the runtime (mock runner)
// ---------------------------------------------------------------------------

const AGENTS: AgentConfig[] = [{ name: "a", description: "test", systemPrompt: "", source: "user", filePath: "" }];

function mkState(def: ReturnType<typeof desugar>): RunState {
	return {
		runId: "t",
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: "/tmp",
	};
}

function mockRunner(respond: (task: string) => string, record?: string[]): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task, _o: RunOptions): Promise<RunResult> => {
		record?.push(task);
		return {
			agent: agentName,
			task,
			exitCode: 0,
			output: respond(task),
			stderr: "",
			usage: { ...emptyUsage(), output: 5, turns: 1 },
			stopReason: "end",
		};
	};
}

function deps(runTask: RuntimeDeps["runTask"]): RuntimeDeps {
	return { cwd: "/tmp", agents: AGENTS, runTask, persist: () => {}, onProgress: () => {} };
}

test("e2e: desugared single task runs and returns its output", async () => {
	const def = desugar({ agent: "a", task: "hello" });
	const res = await executeTaskflow(mkState(def), deps(mockRunner((t) => `out:${t}`)));
	assert.equal(res.ok, true);
	assert.equal(res.finalOutput, "out:hello");
});

test("e2e: desugared parallel runs all branches and merges outputs", async () => {
	const def = desugar({ tasks: [{ task: "x", agent: "a" }, { task: "y", agent: "a" }, { task: "z", agent: "a" }] });
	const record: string[] = [];
	const res = await executeTaskflow(mkState(def), deps(mockRunner((t) => `r:${t}`, record)));
	assert.equal(res.ok, true);
	assert.equal(record.length, 3);
	assert.match(res.finalOutput, /r:x/);
	assert.match(res.finalOutput, /r:y/);
	assert.match(res.finalOutput, /r:z/);
});

test("e2e: desugared chain feeds {previous.output} forward", async () => {
	const def = desugar({
		chain: [
			{ task: "start", agent: "a" },
			{ task: "use {previous.output}", agent: "a" },
		],
	});
	const record: string[] = [];
	const res = await executeTaskflow(mkState(def), deps(mockRunner((t) => `out:${t}`, record)));
	assert.equal(res.ok, true);
	assert.deepEqual(record, ["start", "use out:start"]);
	assert.equal(res.finalOutput, "out:use out:start");
});
