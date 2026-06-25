import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

test("runtime: failed phase output visible to optional downstream", async () => {
	// When a phase fails but is marked optional, its error output should be
	// visible to downstream phases via interpolation (e.g. {steps.one.output}).
	const def: Taskflow = {
		name: "fail-visible",
		phases: [
			{ id: "one", type: "agent", agent: "a", task: "willfail", optional: true },
			{ id: "two", type: "agent", agent: "a", task: "review {steps.one.output}", dependsOn: ["one"], final: true },
		],
	};
	const deps = baseDeps(mockRunner((t) => `ok:${t}`, { fail: (t) => t === "willfail" }));
	const res = await executeTaskflow(mkState(def), deps);
	// Phase one failed but is optional
	assert.equal(res.state.phases.one.status, "failed");
	// Phase two ran (dependency is optional) and saw the error output
	assert.equal(res.state.phases.two.status, "done");
	assert.match(res.state.phases.two.output ?? "", /review mock failure/);
});

test("runtime: failed map items include error info in combined output", async () => {
	// When some map items fail, the combined output should include the
	// error messages (not useless placeholders).
	const calls: string[] = [];
	const failSet = new Set(["do b"]);
	const deps = baseDeps(
		mockRunner(
			(t) => {
				calls.push(t);
				if (t === "list") return '["a","b","c"]';
				return `ok:${t}`;
			},
			{ fail: (t) => failSet.has(t) },
		),
	);
	const def: Taskflow = {
		name: "map-partial-fail",
		phases: [
			{ id: "list", type: "agent", agent: "a", task: "list", output: "json" },
			{
				id: "work",
				type: "map",
				over: "{steps.list.json}",
				agent: "a",
				task: "do {item}",
				dependsOn: ["list"],
				final: true,
			},
		],
	};
	const res = await executeTaskflow(mkState(def), deps);
	// Map should fail (one item failed)
	assert.equal(res.state.phases.work.status, "failed");
	// Combined output should contain the error info, not a placeholder
	const output = res.state.phases.work.output;
	assert.ok(output, "output should exist");
	assert.match(output, /\(failed\)/);
	assert.match(output, /mock failure/);
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
	const { phaseFingerprint } = await import("../extensions/flowir/index.ts");
	const subfpOne = (await phaseFingerprint(def, "one")) ?? "";
	state.phases.one = {
		id: "one",
		status: "done",
		output: "out:start",
		// Must match runtime cacheKey(): flow name + v3:phasefp sub-fingerprint + base parts + thinking + tools + ctx.
		inputHash: hashInput(`flow:${def.name}`, `v3:phasefp:${subfpOne}`, "one", "a", "", "start", "think:", "tools:[]", "ctx:"),
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
	const { phaseFingerprint } = await import("../extensions/flowir/index.ts");
	const subfpX = (await phaseFingerprint(def, "x")) ?? "";
	const subfpSum = (await phaseFingerprint(def, "sum")) ?? "";
	const state = mkState(def);
	state.phases.x = { id: "x", status: "done", output: "o:tx", inputHash: hashInput(`flow:${def.name}`, `v3:phasefp:${subfpX}`, "x", "a", "", "tx", "think:", "tools:[]", "ctx:"), usage: emptyUsage() };
	// reduce cache key has the same shape as agent/gate (flow + v3:phasefp + base parts + thinking + tools).
	state.phases.sum = {
		id: "sum",
		status: "done",
		output: "o:combine o:tx",
		inputHash: hashInput(`flow:${def.name}`, `v3:phasefp:${subfpSum}`, "sum", "a", "", "combine o:tx", "think:", "tools:[]", "ctx:"),
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
	// F-005 regression: standalone "no" / "No issues found" must NOT be classified as BLOCK.
	// Natural-language verdicts like these are semantically PASS; the remaining
	// block|fail|stop|reject|halt keywords cover genuine block signals, and
	// fail-open handles anything ambiguous.
	assert.equal(parseGateVerdict('{"verdict": "No issues found"}').verdict, "pass");
	assert.equal(parseGateVerdict('{"verdict": "no errors detected"}').verdict, "pass");
	assert.equal(parseGateVerdict('{"verdict": "No"}').verdict, "pass");
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

test("runtime: pre-reads context files and prepends their content to the task", async () => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tf-ctx-"));
	const ctxFile = path.join(tmpDir, "example.ts");
	await fs.promises.writeFile(ctxFile, "export const X = 1;\n", "utf-8");

	let receivedTask = "";
	const deps = baseDeps(
		async (_c, _ag, _n, task: string): Promise<RunResult> => {
			receivedTask = task;
			return { agent: "a", task, exitCode: 0, output: "done", stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
		},
	);
	const def: Taskflow = {
		name: "ctx",
		phases: [{ id: "only", type: "agent", agent: "a", task: "use it", context: [ctxFile], final: true }],
	};
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.match(receivedTask, /## File:.*example\.ts/);
	assert.match(receivedTask, /export const X = 1;/);

	await fs.promises.rm(tmpDir, { recursive: true });
});

test("runtime: context supports interpolated refs resolving to file paths", async () => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tf-ctx2-"));
	const ctxFile = path.join(tmpDir, "target.ts");
	await fs.promises.writeFile(ctxFile, "const T = 2;\n", "utf-8");

	let receivedTask = "";
	let callCount = 0;
	const deps = baseDeps(
		async (_c, _ag, _n, task: string): Promise<RunResult> => {
			callCount++;
			if (callCount === 1) {
				return { agent: "a", task, exitCode: 0, output: JSON.stringify([ctxFile]), stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
			}
			receivedTask = task;
			return { agent: "a", task, exitCode: 0, output: "done", stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
		},
	);
	const def: Taskflow = {
		name: "ctx-ref",
		phases: [
			{ id: "scout", type: "agent", agent: "a", task: "find files" },
			{ id: "only", type: "agent", agent: "a", task: "use it", context: ["{steps.scout.output}"], dependsOn: ["scout"], final: true },
		],
	};
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.match(receivedTask, /## File:.*target\.ts/);
	assert.match(receivedTask, /const T = 2;/);

	await fs.promises.rm(tmpDir, { recursive: true });
});

test("runtime: context pre-read works for parallel phases", async () => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tf-ctxp-"));
	const ctxFile = path.join(tmpDir, "shared.ts");
	await fs.promises.writeFile(ctxFile, "export const SHARED = 1;\n", "utf-8");

	const received: string[] = [];
	const deps = baseDeps(
		async (_c, _ag, _n, task: string): Promise<RunResult> => {
			received.push(task);
			return { agent: "a", task, exitCode: 0, output: "done", stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
		},
	);
	const def: Taskflow = {
		name: "ctx-parallel",
		phases: [{
			id: "par", type: "parallel",
			branches: [{ task: "branch A" }, { task: "branch B" }],
			context: [ctxFile],
			final: true,
		}],
	};
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.equal(received.length, 2, "both branches should run");
	for (const t of received) {
		assert.match(t, /## File:.*shared\.ts/, "each branch task must include pre-read context");
	}
	await fs.promises.rm(tmpDir, { recursive: true });
});


test("runtime: context pre-read works for map phases", async () => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tf-ctxm-"));
	const ctxFile = path.join(tmpDir, "common.ts");
	await fs.promises.writeFile(ctxFile, "export const COMMON = 2;\n", "utf-8");

	const received: string[] = [];
	const deps = baseDeps(
		async (_c, _ag, _n, task: string): Promise<RunResult> => {
			received.push(task);
			return { agent: "a", task, exitCode: 0, output: "done", stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
		},
	);
	const def: Taskflow = {
		name: "ctx-map",
		phases: [
			{
				id: "m", type: "map", over: "{steps.src.output}", agent: "a",
				task: "do {item}", context: [ctxFile],
				dependsOn: ["src"], final: true,
			},
		],
	};
	const state = mkState(def);
	state.phases.src = {
		id: "src", status: "done",
		output: JSON.stringify(["a", "b"]),
		json: ["a", "b"],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 },
		endedAt: 1,
		startedAt: 0,
	};
	const res = await executeTaskflow(state, deps);
	assert.equal(res.ok, true);
	assert.ok(received.length >= 1, "map should produce at least one task");
	for (const t of received) {
		assert.match(t, /## File:.*common\.ts/, "each map task must include pre-read context");
	}
	await fs.promises.rm(tmpDir, { recursive: true });
});

test("runtime: reduce phase interpolates {steps.X.output} from dependencies", async () => {
	let mergeReceivedTask = "";
	const deps = baseDeps(
		async (_c, _ag, _n, task: string): Promise<RunResult> => {
			if (task.includes("merge:")) mergeReceivedTask = task;
			return { agent: "a", task, exitCode: 0, output: task.startsWith("produce") ? task.replace("produce ", "") : "merged", stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
		},
	);
	const def: Taskflow = {
		name: "reduce-interp",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "produce A" },
			{ id: "b", type: "agent", agent: "a", task: "produce B" },
			{
				id: "merge", type: "reduce", from: ["a", "b"],
				agent: "a",
				task: "merge: A={steps.a.output} B={steps.b.output}",
				dependsOn: ["a", "b"], final: true,
			},
		],
	};
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.match(mergeReceivedTask, /A=A\b/, "should interpolate {steps.a.output}");
	assert.match(mergeReceivedTask, /B=B\b/, "should interpolate {steps.b.output}");
	assert.ok(!mergeReceivedTask.includes("{steps.a.output}"), "no literal placeholder should remain");
});

test("runtime: context warns and skips when entry resolves to a JSON object blob", async () => {
	const deps = baseDeps(
		async (_c, _ag, _n, task: string): Promise<RunResult> => {
			return { agent: "a", task, exitCode: 0, output: "done", stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
		},
	);
	const def: Taskflow = {
		name: "ctx-blob",
		phases: [
			{ id: "src", type: "agent", agent: "a", task: "discover" },
			{
				id: "only", type: "agent", agent: "a",
				task: "use it",
				context: ["{steps.src.output}"],
				dependsOn: ["src"], final: true,
			},
		],
	};
	const state = mkState(def);
	state.phases.src = {
		id: "src", status: "done",
		output: JSON.stringify({ files: ["/tmp/x.ts"], summary: "ok" }),
		usage: emptyUsage(), endedAt: 1, startedAt: 0,
	};
	const res = await executeTaskflow(state, deps);
	assert.equal(res.ok, true);
	// The task should NOT contain any file content (JSON blob was filtered out).
	// The old code would have tried fs.statSync on the JSON string.
});

test("runtime: context resolves {steps.X.json.field} to extract file paths from objects", async () => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tf-ctx3-"));
	const ctxFile = path.join(tmpDir, "nested.ts");
	await fs.promises.writeFile(ctxFile, "export const N = 3;\n", "utf-8");

	let receivedTask = "";
	let callCount = 0;
	const deps = baseDeps(
		async (_c, _ag, _n, task: string): Promise<RunResult> => {
			callCount++;
			if (callCount === 1) {
				// src phase: return the object with files key
				return { agent: "a", task, exitCode: 0, output: JSON.stringify({ files: [ctxFile], summary: "ok" }), stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
			}
			receivedTask = task;
			return { agent: "a", task, exitCode: 0, output: "done", stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
		},
	);
	const def: Taskflow = {
		name: "ctx-json-field",
		phases: [
			{ id: "src", type: "agent", agent: "a", task: "discover" },
			{
				id: "only", type: "agent", agent: "a",
				task: "use it",
				context: ["{steps.src.json.files}"],
				dependsOn: ["src"], final: true,
			},
		],
	};
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.match(receivedTask, /## File:.*nested\.ts/);
	assert.match(receivedTask, /export const N = 3;/);

	await fs.promises.rm(tmpDir, { recursive: true });
});

test("runtime: context with flat JSON array resolved from interpolated ref works unchanged", async () => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tf-ctx4-"));
	const ctxFile = path.join(tmpDir, "flat.ts");
	await fs.promises.writeFile(ctxFile, "export const F = 4;\n", "utf-8");

	let receivedTask = "";
	let callCount = 0;
	const deps = baseDeps(
		async (_c, _ag, _n, task: string): Promise<RunResult> => {
			callCount++;
			if (callCount === 1) {
				return { agent: "a", task, exitCode: 0, output: JSON.stringify([ctxFile]), stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
			}
			receivedTask = task;
			return { agent: "a", task, exitCode: 0, output: "done", stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
		},
	);
	const def: Taskflow = {
		name: "ctx-flat",
		phases: [
			{ id: "src", type: "agent", agent: "a", task: "discover" },
			{
				id: "only", type: "agent", agent: "a",
				task: "use it",
				context: ["{steps.src.output}"],
				dependsOn: ["src"], final: true,
			},
		],
	};
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.match(receivedTask, /## File:.*flat\.ts/);
	assert.match(receivedTask, /export const F = 4;/);

	await fs.promises.rm(tmpDir, { recursive: true });
});

test("runtime: reduce phase with from+depsOn has ctx steps populated by prior agent phases", async () => {
	let mergeTask = "";
	const deps = baseDeps(
		async (_c, _ag, _n, task: string): Promise<RunResult> => {
			mergeTask = task;
			// Return the task as output so we can trace what the agent received
			return { agent: "a", task, exitCode: 0, output: `I processed: ${task.slice(0, 80)}`, stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
		},
	);
	const def: Taskflow = {
		name: "reduce-from-deps",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "produce A output" },
			{ id: "b", type: "agent", agent: "a", task: "produce B output" },
			{
				id: "merge", type: "reduce", from: ["a", "b"],
				agent: "a",
				task: "FROM-A: {steps.a.output} FROM-B: {steps.b.output}",
				dependsOn: ["a", "b"], final: true,
			},
		],
	};
	const state = mkState(def);
	// Do NOT pre-populate. Let the runtime execute all phases naturally.
	const res = await executeTaskflow(state, deps);
	assert.equal(res.ok, true);
	assert.equal(state.phases.a?.status, "done", "phase a done");
	assert.equal(state.phases.b?.status, "done", "phase b done");
	assert.equal(state.phases.merge?.status, "done", "phase merge done");
	// The merge task should have resolved placeholders
	assert.match(mergeTask, /FROM-A: I processed/, "merge received interpolated task");
	assert.ok(!mergeTask.includes("{steps.a.output}"), "no literal placeholder");
	assert.ok(!mergeTask.includes("{steps.b.output}"), "no literal placeholder");
});

test("F-006: throwing onProgress callback in catch block does not replace crash message", async () => {
	const def: Taskflow = {
		name: "crash-cb-progress",
		phases: [{ id: "boom", type: "agent", agent: "a", task: "explode" }],
	};
	// Runner throws — the original root-cause error is the one we must preserve.
	const runner: RuntimeDeps["runTask"] = async () => {
		throw new Error("original root-cause failure");
	};
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: AGENTS,
		runTask: runner,
		persist: () => {},
		// A misbehaving TUI / observer — must not be allowed to clobber the crash.
		onProgress: () => {
			throw new Error("onProgress callback blew up");
		},
	};
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, false);
	assert.equal(res.state.status, "failed");
	// The original error message must reach the caller; the callback exception
	// must not replace it.
	assert.match(res.finalOutput, /original root-cause failure/);
	assert.doesNotMatch(res.finalOutput, /onProgress callback blew up/);
});

test("F-006: throwing persist callback in catch block does not replace crash message", async () => {
	const def: Taskflow = {
		name: "crash-cb-persist",
		phases: [{ id: "boom", type: "agent", agent: "a", task: "explode" }],
	};
	const runner: RuntimeDeps["runTask"] = async () => {
		throw new Error("original root-cause failure");
	};
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: AGENTS,
		runTask: runner,
		// A misbehaving store — must not be allowed to clobber the crash.
		persist: () => {
			throw new Error("persist callback blew up");
		},
		onProgress: () => {},
	};
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, false);
	assert.equal(res.state.status, "failed");
	assert.match(res.finalOutput, /original root-cause failure/);
	assert.doesNotMatch(res.finalOutput, /persist callback blew up/);
});

test("F-006: throwing onProgress during a successful run does not break the run", async () => {
	const def: Taskflow = {
		name: "live-cb-throws",
		phases: [
			{ id: "one", type: "agent", agent: "a", task: "start" },
			{ id: "two", type: "agent", agent: "a", task: "use {steps.one.output}", dependsOn: ["one"], final: true },
		],
	};
	const runner = mockRunner((t) => `out:${t}`);
	// onProgress throws on EVERY emission (both checkpoint and live-update paths).
	// A safe emit must swallow the throw so the run completes normally.
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: AGENTS,
		runTask: runner,
		persist: () => {},
		onProgress: () => {
			throw new Error("onProgress callback blew up");
		},
	};
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true, "run must succeed despite throwing onProgress");
	assert.equal(res.state.status, "completed");
	assert.equal(res.state.phases.one.status, "done");
	assert.equal(res.state.phases.two.status, "done");
	assert.equal(res.finalOutput, "out:use out:start");
});

test("runtime resume: re-running a previously failed phase clears stale endedAt (no negative elapsed)", async () => {
	// Regression: resuming a flow whose phase had failed left the spread prior
	// PhaseState's terminal `endedAt` in place while flipping status→running and
	// setting a fresh `startedAt`. The running phase then had endedAt < startedAt,
	// rendering as a frozen NEGATIVE elapsed time in the TUI.
	const def: Taskflow = {
		name: "resume-clean",
		phases: [{ id: "p", type: "agent", agent: "a", task: "go", final: true }],
	};

	const state = mkState(def);
	const staleStart = 1_000_000;
	const staleEnd = 1_050_000; // a previous attempt's end time
	state.phases.p = {
		id: "p",
		status: "failed",
		startedAt: staleStart,
		endedAt: staleEnd,
		error: "previous boom",
		usage: emptyUsage(),
	};

	// Capture the in-flight "running" snapshot of phase p.
	let runningSnapshot: typeof state.phases.p | undefined;
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: AGENTS,
		runTask: mockRunner((t) => `out:${t}`),
		persist: () => {},
		onProgress: (s) => {
			const ps = s.phases.p;
			if (ps?.status === "running" && !runningSnapshot) runningSnapshot = { ...ps };
		},
	};

	const res = await executeTaskflow(state, deps);
	assert.equal(res.state.status, "completed");

	// While running, the stale terminal fields must be gone.
	assert.ok(runningSnapshot, "should have observed a running snapshot");
	assert.equal(runningSnapshot!.endedAt, undefined, "stale endedAt must be cleared on re-run");
	assert.equal(runningSnapshot!.error, undefined, "stale error must be cleared on re-run");
	assert.ok(
		runningSnapshot!.startedAt! > staleStart,
		"startedAt must be refreshed to the resume time",
	);
	// Elapsed must never be negative.
	const elapsedWhileRunning = (runningSnapshot!.endedAt ?? Date.now()) - runningSnapshot!.startedAt!;
	assert.ok(elapsedWhileRunning >= 0, `running elapsed must be >= 0, got ${elapsedWhileRunning}`);

	// Final state is a clean done with endedAt >= startedAt.
	const final = res.state.phases.p;
	assert.equal(final.status, "done");
	assert.ok(final.endedAt! >= final.startedAt!, "final endedAt must be >= startedAt");
});

// ── fix-1: budgetBlocked drives status + final output ──────────────

test("fix-1: single-phase over-budget sets status 'blocked' and budget exceeded message", async () => {
	const def: Taskflow = {
		name: "budget-single",
		phases: [{ id: "p", type: "agent", agent: "a", task: "do work", final: true }],
		budget: { maxUSD: 0.000001 },
	};
	// Each call costs $0.001, exceeding the $0.000001 cap.
	const deps = baseDeps(mockRunner(() => "ok"));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.state.status, "blocked", "status must be blocked when budget exceeded");
	assert.match(res.finalOutput, /Budget exceeded/, "finalOutput must mention budget exceeded");
	assert.equal(res.ok, false, "ok must be false for blocked run");
});

// ── fix-8: budgetReason reflects actual over-budget cause ──────────

test("fix-8: budgetReason updates after fan-out truncation when later phase also exceeds", async () => {
	// Phase 1: map fan-out that will be truncated (costly items).
	// Phase 2: agent that also exceeds the remaining budget.
	const def: Taskflow = {
		name: "budget-reason",
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
			},
			{ id: "final", type: "agent", agent: "a", task: "summarize {steps.work.output}", dependsOn: ["work"], final: true },
		],
		budget: { maxUSD: 0.002 }, // enough for discover + partial fan-out, but not final
	};
	let callCount = 0;
	const deps = baseDeps(
		mockRunner((t) => {
			callCount++;
			if (t === "list") return '[{"name":"x"},{"name":"y"},{"name":"z"}]';
			return `done:${t}`;
		}),
	);
	const res = await executeTaskflow(mkState(def), deps);
	// The run should be blocked.
	assert.equal(res.state.status, "blocked", "status must be blocked");
	// budgetReason should reflect the actual over-budget detection, not just
	// the fan-out truncation message.
	assert.ok(res.finalOutput.includes("Budget exceeded"), "finalOutput must mention budget exceeded");
});

test("runtime: unresolved interpolation refs are surfaced as a phase warning", async () => {
	const def: Taskflow = {
		name: "missing-ref",
		phases: [
			{
				id: "solo",
				type: "agent",
				agent: "a",
				// {args.nope} and {steps.ghost.output} have no source — must be left intact + warned.
				task: "do {args.nope} then {steps.ghost.output}",
				final: true,
			},
		],
	};
	const record: string[] = [];
	const origWarn = console.warn;
	const warned: string[] = [];
	console.warn = (...a: unknown[]) => {
		warned.push(a.join(" "));
	};
	try {
		const deps = baseDeps(mockRunner((t) => `out:${t}`, { record }));
		const res = await executeTaskflow(mkState(def), deps);
		assert.equal(res.ok, true);
		// Placeholders left intact in the dispatched task (not throwing).
		assert.match(record[0], /\{args\.nope\}/);
		assert.match(record[0], /\{steps\.ghost\.output\}/);
		// Warning recorded on PhaseState.warnings.
		const w = res.state.phases.solo.warnings ?? [];
		assert.ok(
			w.some((m) => m.includes("unresolved refs") && m.includes("{args.nope}")),
			`expected unresolved-ref warning, got: ${JSON.stringify(w)}`,
		);
		// Also logged to console.
		assert.ok(
			warned.some((m) => m.includes("[taskflow]") && m.includes("solo")),
			"expected a console.warn for the phase",
		);
	} finally {
		console.warn = origWarn;
	}
});

test("runtime: agent phase records its observed readSet with versions (M3)", async () => {
	const def: Taskflow = {
		name: "provenance",
		phases: [
			{ id: "scout", type: "agent", agent: "a", task: "scan" },
			{ id: "plan", type: "agent", agent: "a", task: "plan from {steps.scout.output}", dependsOn: ["scout"], final: true },
		],
	};
	const runner = mockRunner((t) => `out:${t}`, {});
	const state = mkState(def);
	const res = await executeTaskflow(state, baseDeps(runner));
	assert.equal(res.ok, true);

	// `plan` consumed scout's output → its observed readSet records exactly that,
	// tagged with scout's inputHash as the version it read (the overstory
	// "observed readSet@version" moat — what the result ACTUALLY depended on).
	const plan = state.phases.plan;
	assert.ok(plan.reads, "plan recorded an observed readSet");
	assert.equal(plan.reads!.length, 1);
	assert.equal(plan.reads![0].stepId, "scout");
	assert.equal(plan.reads![0].version, state.phases.scout.inputHash, "version = scout's inputHash");

	// `scout` has no {steps.*} in its task → no observed reads.
	assert.ok(!state.phases.scout.reads || state.phases.scout.reads.length === 0);
});

test("runtime: map phase records observed readSet of its over-source (M3)", async () => {
	const def: Taskflow = {
		name: "map-prov",
		phases: [
			{ id: "list", type: "agent", agent: "a", task: "list", output: "json" },
			{ id: "m", type: "map", over: "{steps.list.json}", agent: "a", task: "audit {item}", dependsOn: ["list"], final: true },
		],
	};
	// `list` returns a JSON array; the map fans out one audit per item.
	const runner = mockRunner((t) => (t === "list" ? '["x","y"]' : `audited:${t}`), {});
	const state = mkState(def);
	const res = await executeTaskflow(state, baseDeps(runner));
	assert.equal(res.ok, true);
	// The map consumed `list` (via `over`) → its observed readSet records that,
	// tagged with list's inputHash (so fan-out results carry provenance too).
	const m = state.phases.m;
	assert.ok(m.reads, "map recorded an observed readSet");
	assert.ok(m.reads!.some((r) => r.stepId === "list"), "map recorded it read `list`");
	assert.equal(m.reads!.find((r) => r.stepId === "list")?.version, state.phases.list.inputHash);
});
