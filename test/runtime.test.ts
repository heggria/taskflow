import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../extensions/agents.ts";
import type { RunResult, RunOptions } from "../extensions/runner.ts";
import { emptyUsage } from "../extensions/usage.ts";
import { executeTaskflow, type RuntimeDeps } from "../extensions/runtime.ts";
import type { Taskflow } from "../extensions/schema.ts";
import type { RunState } from "../extensions/store.ts";
import { parseGateVerdict } from "../extensions/runtime.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test agent", systemPrompt: "", source: "user", filePath: "" },
];

function mkState(def: Taskflow, args: Record<string, unknown> = {}): RunState {
	return {
		runId: "test-run",
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

/** A mock runner that records calls and returns canned output. */
function mockRunner(
	respond: (task: string) => string,
	opts?: { fail?: (task: string) => boolean; record?: string[] },
): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task, _o: RunOptions): Promise<RunResult> => {
		opts?.record?.push(task);
		const failed = opts?.fail?.(task) ?? false;
		return {
			agent: agentName,
			task,
			exitCode: failed ? 1 : 0,
			output: failed ? "" : respond(task),
			stderr: failed ? "boom" : "",
			usage: { ...emptyUsage(), output: 10, cost: 0.001, turns: 1 },
			stopReason: failed ? "error" : "end",
			errorMessage: failed ? "mock failure" : undefined,
		};
	};
}

function baseDeps(runTask: RuntimeDeps["runTask"]): RuntimeDeps {
	return { cwd: "/tmp", agents: AGENTS, runTask, persist: () => {}, onProgress: () => {} };
}

test("runtime: linear agent chain passes outputs forward", async () => {
	const def: Taskflow = {
		name: "chain",
		phases: [
			{ id: "one", type: "agent", agent: "a", task: "start" },
			{ id: "two", type: "agent", agent: "a", task: "use {steps.one.output}", dependsOn: ["one"], final: true },
		],
	};
	const record: string[] = [];
	const deps = baseDeps(mockRunner((t) => `out:${t}`, { record }));
	const res = await executeTaskflow(mkState(def), deps);

	assert.equal(res.ok, true);
	assert.equal(record[0], "start");
	assert.equal(record[1], "use out:start");
	assert.equal(res.finalOutput, "out:use out:start");
	assert.equal(res.state.status, "completed");
});

test("runtime: map fan-out spawns one task per array item", async () => {
	const def: Taskflow = {
		name: "fanout",
		concurrency: 4,
		phases: [
			{ id: "discover", type: "agent", agent: "a", task: "list", output: "json" },
			{
				id: "work",
				type: "map",
				over: "{steps.discover.json}",
				as: "item",
				agent: "a",
				task: "process {item.name}",
				dependsOn: ["discover"],
				final: true,
			},
		],
	};
	const record: string[] = [];
	const deps = baseDeps(
		mockRunner((t) => (t === "list" ? '[{"name":"x"},{"name":"y"},{"name":"z"}]' : `done:${t}`), { record }),
	);
	const res = await executeTaskflow(mkState(def), deps);

	assert.equal(res.ok, true);
	// discover + 3 map tasks
	assert.equal(record.length, 4);
	assert.ok(record.includes("process x"));
	assert.ok(record.includes("process y"));
	assert.ok(record.includes("process z"));
	assert.match(res.finalOutput, /done:process x/);
	// completed fan-out must carry final sub-task counts (regression: showed 0✓)
	assert.deepEqual(res.state.phases.work.subProgress, { done: 3, total: 3, running: 0, failed: 0 });
});

test("runtime: parallel branches run and merge", async () => {
	const def: Taskflow = {
		name: "par",
		phases: [
			{
				id: "p",
				type: "parallel",
				agent: "a",
				branches: [{ task: "branch1" }, { task: "branch2", agent: "a" }],
				final: true,
			},
		],
	};
	const record: string[] = [];
	const deps = baseDeps(mockRunner((t) => `r:${t}`, { record }));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.equal(record.length, 2);
	assert.match(res.finalOutput, /r:branch1/);
	assert.match(res.finalOutput, /r:branch2/);
});

test("runtime: reduce aggregates upstream outputs", async () => {
	const def: Taskflow = {
		name: "red",
		phases: [
			{ id: "x", type: "agent", agent: "a", task: "tx" },
			{ id: "y", type: "agent", agent: "a", task: "ty" },
			{
				id: "sum",
				type: "reduce",
				from: ["x", "y"],
				agent: "a",
				task: "combine {steps.x.output} and {steps.y.output}",
				dependsOn: ["x", "y"],
				final: true,
			},
		],
	};
	const record: string[] = [];
	const deps = baseDeps(mockRunner((t) => `o(${t})`, { record }));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.match(res.finalOutput, /combine o\(tx\) and o\(ty\)/);
});

test("runtime: failed phase aborts downstream (marked skipped)", async () => {
	const def: Taskflow = {
		name: "failchain",
		phases: [
			{ id: "one", type: "agent", agent: "a", task: "willfail" },
			{ id: "two", type: "agent", agent: "a", task: "after {steps.one.output}", dependsOn: ["one"], final: true },
		],
	};
	const deps = baseDeps(mockRunner((t) => `ok:${t}`, { fail: (t) => t === "willfail" }));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, false);
	assert.equal(res.state.phases.one.status, "failed");
	assert.equal(res.state.phases.two.status, "skipped");
	assert.equal(res.state.status, "failed");
});

test("runtime: map over non-array fails gracefully", async () => {
	const def: Taskflow = {
		name: "badmap",
		phases: [
			{ id: "discover", type: "agent", agent: "a", task: "list" },
			{ id: "work", type: "map", over: "{steps.discover.json}", agent: "a", task: "p {item}", dependsOn: ["discover"], final: true },
		],
	};
	const deps = baseDeps(mockRunner(() => "not an array"));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, false);
	assert.equal(res.state.phases.work.status, "failed");
	assert.match(res.state.phases.work.error ?? "", /did not resolve to an array/);
});

test("runtime: resume skips cached completed phases", async () => {
	const def: Taskflow = {
		name: "resume",
		phases: [
			{ id: "one", type: "agent", agent: "a", task: "start" },
			{ id: "two", type: "agent", agent: "a", task: "use {steps.one.output}", dependsOn: ["one"], final: true },
		],
	};
	// First run: complete phase one only, then simulate a pause.
	const record: string[] = [];
	const runner = mockRunner((t) => `out:${t}`, { record });

	const state = mkState(def);
	// Pre-seed phase one as already done with the matching input hash.
	const { hashInput } = await import("../extensions/store.ts");
	state.phases.one = {
		id: "one",
		status: "done",
		output: "out:start",
		inputHash: hashInput("one", "a", "start"),
		usage: emptyUsage(),
	};

	const res = await executeTaskflow(state, baseDeps(runner));
	assert.equal(res.ok, true);
	// Only phase two should have run (one was cached).
	assert.deepEqual(record, ["use out:start"]);
});

test("runtime: resume caches a completed reduce phase (unified inputHash)", async () => {
	const def: Taskflow = {
		name: "reduce-resume",
		phases: [
			{ id: "x", type: "agent", agent: "a", task: "tx" },
			{ id: "sum", type: "reduce", from: ["x"], agent: "a", task: "combine {steps.x.output}", dependsOn: ["x"], final: true },
		],
	};
	const record: string[] = [];
	const runner = mockRunner((t) => `o:${t}`, { record });
	const { hashInput } = await import("../extensions/store.ts");
	const state = mkState(def);
	state.phases.x = { id: "x", status: "done", output: "o:tx", inputHash: hashInput("x", "a", "tx"), usage: emptyUsage() };
	// reduce cache key is hashInput(id, agent, interpolatedText) — same shape as agent/gate.
	state.phases.sum = {
		id: "sum",
		status: "done",
		output: "o:combine o:tx",
		inputHash: hashInput("sum", "a", "combine o:tx"),
		usage: emptyUsage(),
	};
	const res = await executeTaskflow(state, baseDeps(runner));
	assert.equal(res.ok, true);
	// Both phases were cached → nothing re-ran.
	assert.deepEqual(record, []);
});

test("runtime: concurrency cap is respected in map", async () => {
	const def: Taskflow = {
		name: "cap",
		concurrency: 2,
		phases: [
			{ id: "d", type: "agent", agent: "a", task: "list", output: "json" },
			{ id: "m", type: "map", over: "{steps.d.json}", agent: "a", task: "p {item}", dependsOn: ["d"], concurrency: 2, final: true },
		],
	};
	let active = 0;
	let peak = 0;
	const runner: RuntimeDeps["runTask"] = async (_c, _ag, agentName, task) => {
		if (task !== "list") {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 10));
			active--;
		}
		return {
			agent: agentName,
			task,
			exitCode: 0,
			output: task === "list" ? "[1,2,3,4,5,6]" : `done`,
			stderr: "",
			usage: emptyUsage(),
			stopReason: "end",
		};
	};
	const res = await executeTaskflow(mkState(def), baseDeps(runner));
	assert.equal(res.ok, true);
	assert.ok(peak <= 2, `peak concurrency ${peak} exceeded cap 2`);
});

test("parseGateVerdict: text markers, JSON, and fail-open default", () => {
	assert.equal(parseGateVerdict("looks good\nVERDICT: PASS").verdict, "pass");
	assert.equal(parseGateVerdict("issues found\nVERDICT: BLOCK").verdict, "block");
	assert.equal(parseGateVerdict("VERDICT: OK").verdict, "pass");
	assert.equal(parseGateVerdict('{"continue": false, "reason": "missing auth"}').verdict, "block");
	assert.equal(parseGateVerdict('{"continue": false, "reason": "missing auth"}').reason, "missing auth");
	assert.equal(parseGateVerdict('{"pass": true}').verdict, "pass");
	assert.equal(parseGateVerdict('{"verdict": "reject"}').verdict, "block");
	// ambiguous output → fail-open (pass), never accidentally halt
	assert.equal(parseGateVerdict("just some prose with no verdict").verdict, "pass");
});

test("runtime: gate BLOCK halts the flow and skips downstream", async () => {
	const def: Taskflow = {
		name: "gated",
		phases: [
			{ id: "work", type: "agent", agent: "a", task: "do work" },
			{ id: "check", type: "gate", agent: "a", task: "review {steps.work.output}", dependsOn: ["work"] },
			{ id: "ship", type: "agent", agent: "a", task: "ship {steps.check.output}", dependsOn: ["check"], final: true },
		],
	};
	const deps = baseDeps(
		mockRunner((t) => (t.startsWith("review") ? "found problems\nVERDICT: BLOCK" : `ok:${t}`)),
	);
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, false);
	assert.equal(res.state.status, "blocked");
	assert.equal(res.state.phases.check.gate?.verdict, "block");
	assert.equal(res.state.phases.ship.status, "skipped");
	assert.match(res.finalOutput, /Gate blocked/);
});

test("runtime: gate PASS lets the flow continue", async () => {
	const def: Taskflow = {
		name: "gated-pass",
		phases: [
			{ id: "work", type: "agent", agent: "a", task: "do work" },
			{ id: "check", type: "gate", agent: "a", task: "review {steps.work.output}", dependsOn: ["work"] },
			{ id: "ship", type: "agent", agent: "a", task: "ship it", dependsOn: ["check"], final: true },
		],
	};
	const deps = baseDeps(mockRunner((t) => (t.startsWith("review") ? "all good\nVERDICT: PASS" : `ok:${t}`)));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.equal(res.state.status, "completed");
	assert.equal(res.state.phases.check.gate?.verdict, "pass");
	assert.equal(res.state.phases.ship.status, "done");
});

test("runtime: completed phases retain startedAt (run elapsed regression)", async () => {
	const def: Taskflow = {
		name: "timed",
		phases: [
			{ id: "one", type: "agent", agent: "a", task: "start" },
			{ id: "two", type: "agent", agent: "a", task: "use {steps.one.output}", dependsOn: ["one"], final: true },
		],
	};
	const deps = baseDeps(mockRunner((t) => `ok:${t}`));
	const res = await executeTaskflow(mkState(def), deps);
	// Both phases finished; each must keep both timestamps so wall-clock elapsed
	// (max endedAt - min startedAt) covers the whole run, not just the last phase.
	for (const id of ["one", "two"]) {
		const p = res.state.phases[id];
		assert.equal(p.status, "done");
		assert.ok(typeof p.startedAt === "number", `${id} should keep startedAt`);
		assert.ok(typeof p.endedAt === "number", `${id} should keep endedAt`);
		assert.ok((p.endedAt as number) >= (p.startedAt as number));
	}
});
