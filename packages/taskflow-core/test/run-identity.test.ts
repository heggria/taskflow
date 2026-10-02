import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import { canUseEventKernel } from "../src/exec/driver.ts";
import type { RunOptions } from "../src/host/runner-types.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import type { Phase, Taskflow } from "../src/schema.ts";
import { loadRun, saveRun, type RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

const AGENTS: AgentConfig[] = [{ name: "a", description: "test", systemPrompt: "", source: "user", filePath: "" }];

function persistedState(cwd: string, def: Taskflow, runId: string): RunState {
	saveRun({ runId, flowName: def.name, def, args: { runId: "argument-controlled" }, status: "running", phases: {}, createdAt: Date.now(), updatedAt: Date.now(), cwd });
	const state = loadRun(cwd, runId);
	assert.ok(state);
	return state;
}

const cases: Array<{ name: string; phase: Phase; calls: number }> = [
	{ name: "agent", phase: { id: "work", type: "agent", agent: "a", task: "agent" }, calls: 1 },
	{ name: "map", phase: { id: "work", type: "map", agent: "a", task: "map {item}", over: '["x","y"]' }, calls: 2 },
	{ name: "parallel", phase: { id: "work", type: "parallel", branches: [{ agent: "a", task: "left" }, { agent: "a", task: "right" }] }, calls: 2 },
	{ name: "reduce", phase: { id: "work", type: "reduce", agent: "a", task: "reduce" }, calls: 1 },
	{ name: "gate", phase: { id: "work", type: "gate", agent: "a", task: "gate" }, calls: 1 },
	{ name: "loop", phase: { id: "work", type: "loop", agent: "a", task: "loop", until: "{loop.iteration}>=2", maxIterations: 2, convergence: false }, calls: 2 },
	{ name: "tournament", phase: { id: "work", type: "tournament", agent: "a", task: "variant", variants: 2, judge: "judge", mode: "best" }, calls: 3 },
];

for (const eventKernel of [false, true]) {
	const engine = eventKernel ? "kernel" : "imperative";
	for (const { name, phase, calls: expectedCalls } of cases) {
		test(`run identity: ${engine} ${name} calls receive persisted state identity`, async (t) => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-run-id-"));
			t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
			const def: Taskflow = Object.assign({ name: `identity-${name}`, phases: [Object.assign({ ...phase, final: true }, { runId: "phase-controlled" })] }, { runId: "flow-controlled" });
			const runId = `persisted-${engine}-${name}`;
			const state = persistedState(cwd, def, runId);
			assert.equal(canUseEventKernel(def), true, "Kernel fixture must not silently fall back");
			const calls: Array<{ opts: RunOptions; stack: string }> = [];
			const runTask: RuntimeDeps["runTask"] = async (_cwd, _agents, agent, task, opts) => {
				calls.push({ opts, stack: new Error().stack ?? "" });
				const output = name === "gate" ? "VERDICT: PASS" : name === "tournament" ? "WINNER: 1" : `ok-${calls.length}`;
				return { agent, task, exitCode: 0, output, stderr: "", usage: emptyUsage(), stopReason: "end" };
			};
			const result = await executeTaskflow(state, { cwd, agents: AGENTS, eventKernel, persist: saveRun, runTask });
			assert.equal(result.ok, true, result.finalOutput);
			assert.equal(calls.length, expectedCalls);
			for (const call of calls) {
				assert.equal(call.opts.runId, runId, "Neither flow, phase nor argument data may override the owning state");
				if (eventKernel) {
					const source = ["agent", "map", "parallel"].includes(name) ? "exec/step.ts" : "exec/step-kinds.ts";
					assert.ok(call.stack.replaceAll("\\", "/").includes(source), `Expected real kernel path ${source}`);
				}
			}
			assert.equal(loadRun(cwd, runId)?.runId, runId);
		});
	}

	test(`run identity: ${engine} nested flow uses its immediate owning state`, async (t) => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-nested-run-id-"));
		t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
		const child: Taskflow = { name: "child", phases: [
			{ id: "one", type: "agent", agent: "a", task: "child-one" },
			{ id: "two", type: "reduce", agent: "a", task: "child-two", from: ["one"], dependsOn: ["one"], final: true },
		] };
		const def: Taskflow = { name: "parent", phases: [
			{ id: "root", type: "agent", agent: "a", task: "parent" },
			{ id: "nested", type: "flow", use: "child", dependsOn: ["root"], final: true },
		] };
		const runId = `persisted-${engine}-parent`;
		const state = persistedState(cwd, def, runId);
		const calls: Array<{ task: string; runId?: string }> = [];
		const runTask: RuntimeDeps["runTask"] = async (_cwd, _agents, agent, task, opts) => {
			calls.push({ task, runId: opts.runId });
			return { agent, task, exitCode: 0, output: "ok", stderr: "", usage: emptyUsage(), stopReason: "end" };
		};
		const result = await executeTaskflow(state, { cwd, agents: AGENTS, eventKernel, persist: saveRun, runTask, loadFlow: (name) => name === "child" ? child : undefined });
		assert.equal(result.ok, true, JSON.stringify(result.state));
		assert.equal(calls.length, 3);
		assert.equal(calls[0].runId, runId);
		assert.ok(calls[1].runId);
		assert.notEqual(calls[1].runId, runId, "Nested execution creates a distinct owning state");
		assert.equal(calls[1].runId, calls[2].runId, "Both child handlers share that state identity");
		if (eventKernel) assert.equal(calls[1].runId, `${runId}-n-child`);
		else assert.match(calls[1].runId, /^child-/);
	});
}
