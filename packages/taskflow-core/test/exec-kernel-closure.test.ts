/** Focused parity guards for the 0.2.0 event-kernel release boundary. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import { canUseEventKernel } from "../src/exec/driver.ts";
import type { RunResult } from "../src/host/runner-types.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { MAX_DYNAMIC_MAP_ITEMS, type Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test", systemPrompt: "", source: "user", filePath: "" },
];

function state(def: Taskflow, cwd = process.cwd()): RunState {
	return {
		runId: `kernel-closure-${Date.now()}`,
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

function successRunner(onCall?: () => void): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agent, task): Promise<RunResult> => {
		onCall?.();
		return {
			agent,
			task,
			exitCode: 0,
			output: "ok",
			stderr: "",
			usage: emptyUsage(),
			stopReason: "end",
		};
	};
}

test("kernel admission: parent budget is inherited by nested fan-out", () => {
	const def: Taskflow = {
		name: "budget-parent",
		budget: { maxTokens: 1000 },
		phases: [
			{
				id: "child",
				type: "flow",
				def: {
					name: "map-child",
					phases: [
						{ id: "map", type: "map", agent: "a", task: "{item}", over: "[1,2]", final: true },
					],
				},
				final: true,
			},
		],
	};
	assert.equal(canUseEventKernel(def), false);
});

test("event kernel: dynamic map fan-out is capped at MAX_DYNAMIC_MAP_ITEMS", async () => {
	const items = Array.from({ length: MAX_DYNAMIC_MAP_ITEMS + 17 }, (_, i) => i);
	const def: Taskflow = {
		name: "dynamic-map-cap",
		phases: [
			{ id: "map", type: "map", agent: "a", task: "{item}", over: JSON.stringify(items), final: true },
		],
	};
	let calls = 0;
	const result = await executeTaskflow(state(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: successRunner(() => calls++),
		persist: () => {},
		eventKernel: true,
		_stack: ["def:generated"],
	});
	assert.equal(result.ok, true);
	assert.equal(calls, MAX_DYNAMIC_MAP_ITEMS);
	assert.match(result.state.phases.map.warnings?.[0] ?? "", /MAX_DYNAMIC_MAP_ITEMS \(200\)/);
});

test("event kernel: stdout truncation does not cancel later script side effects", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "taskflow-kernel-script-"));
	try {
		const marker = path.join(cwd, "after-cap.txt");
		const program = [
			`process.stdout.write("x".repeat(1048577))`,
			`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "finished")`,
		].join(";");
		const def: Taskflow = {
			name: "script-cap-side-effect",
			phases: [{ id: "script", type: "script", run: [process.execPath, "-e", program], final: true }],
		};
		const result = await executeTaskflow(state(def, cwd), {
			cwd,
			agents: AGENTS,
			runTask: successRunner(),
			persist: () => {},
			eventKernel: true,
		});
		assert.equal(result.ok, true);
		assert.equal(await readFile(marker, "utf8"), "finished");
		assert.match(result.finalOutput, /\[stdout truncated at 1 MB\]$/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("event kernel: string scripts use the platform shell", async () => {
	const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('shell-ok')"`;
	const def: Taskflow = {
		name: "platform-shell",
		phases: [{ id: "script", type: "script", run: command, idempotent: false, final: true }],
	};
	const result = await executeTaskflow(state(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: successRunner(),
		persist: () => {},
		eventKernel: true,
	});
	assert.equal(result.ok, true);
	assert.equal(result.finalOutput, "shell-ok");
	assert.equal(result.state.phases.script.sideEffect, true);
});

test("event kernel: a phase timeout bounds a runner that ignores AbortSignal", async () => {
	const def: Taskflow = {
		name: "noncooperative-kernel-timeout",
		phases: [{ id: "work", type: "agent", agent: "a", task: "hang", timeout: 1000, final: true }],
	};
	const started = Date.now();
	const result = await executeTaskflow(state(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: async () => new Promise(() => {}),
		persist: () => {},
		eventKernel: true,
	});
	assert.equal(result.ok, false);
	assert.equal(result.state.phases.work.status, "failed");
	assert.equal(result.state.phases.work.timedOut, true);
	assert.ok(Date.now() - started < 8_000, "kernel must return after timeout plus bounded abort grace");
});
