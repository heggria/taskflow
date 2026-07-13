/**
 * First-run trace regression — 0.2.0 dogfood issue 8.
 *
 * Integration test: a FileTraceSink is constructed BEFORE the run directory
 * exists (mirrors the first-run MCP/Pi path where the sink is built from a
 * traceFilePath under runs/<flow>/ that saveRun() hasn't created yet). After a
 * first run completes, the trace must be readable and non-empty — the sink
 * must not have silently dropped events because the parent dir was missing at
 * construction time.
 *
 * This is a regression guard; it does not change working code.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../src/agents.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { emptyUsage } from "../src/usage.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { runsDir } from "../src/store.ts";
import { FileTraceSink, readTrace } from "../src/trace.ts";
import { traceFilePath } from "../src/store.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test", systemPrompt: "", source: "user", filePath: "" },
];

function mockRunner(respond: (task: string) => string): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, n, task, _o: RunOptions): Promise<RunResult> => ({
		agent: n,
		task,
		exitCode: 0,
		output: respond(task),
		stderr: "",
		usage: { ...emptyUsage(), output: 5, turns: 1 },
		stopReason: "end",
	});
}

test("first-run trace: sink built before runs dir exists records a non-empty trace after the run", async () => {
	const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tf-firstrun-trace-"));
	try {
		const def: Taskflow = {
			name: "firstrun-trace",
			phases: [{ id: "a", type: "agent", agent: "a", task: "do the thing", final: true }],
		};
		const state: RunState = {
			runId: "firstrun-001",
			flowName: def.name,
			def,
			args: {},
			status: "running",
			phases: {},
			createdAt: Date.now(),
			updatedAt: Date.now(),
			cwd,
		};
		// The trace path lives under runs/<flow>/<runId>.trace.jsonl — the runs
		// dir does NOT exist yet (this is a first run; saveRun has not run).
		const tracePath = traceFilePath(runsDir(cwd), state.flowName, state.runId);
		assert.equal(fs.existsSync(tracePath), false, "trace file must not exist before the run");
		assert.equal(fs.existsSync(path.dirname(tracePath)), false, "runs/<flow>/ dir must not exist before the run");

		const sink = new FileTraceSink(tracePath);
		const deps: RuntimeDeps = {
			cwd,
			agents: AGENTS,
			runTask: mockRunner((t) => `OUT:${t}`),
			persist: () => {},
			onProgress: () => {},
			trace: sink,
		};
		const res = await executeTaskflow(state, deps);
		assert.equal(res.ok, true);

		// Immediately read the trace — it must be non-empty (the sink created the
		// parent dir on first flush and recorded phase-start + phase-end events).
		const events = readTrace(tracePath);
		assert.ok(events.length > 0, `trace must be non-empty, got ${events.length} events`);
		assert.ok(events.some((e) => e.kind === "phase-start"), "trace has a phase-start event");
		assert.ok(events.some((e) => e.kind === "phase-end"), "trace has a phase-end event");
		// The phase-end status reflects completion.
		const end = events.find((e) => e.kind === "phase-end");
		assert.equal(end?.status, "done");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("first-run trace: a multi-phase run records events for every phase", async () => {
	const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tf-firstrun-trace-multi-"));
	try {
		const def: Taskflow = {
			name: "firstrun-multi",
			phases: [
				{ id: "a", type: "agent", agent: "a", task: "first" },
				{ id: "b", type: "agent", agent: "a", task: "second", dependsOn: ["a"], final: true },
			],
		};
		const state: RunState = {
			runId: "firstrun-multi-001",
			flowName: def.name,
			def,
			args: {},
			status: "running",
			phases: {},
			createdAt: Date.now(),
			updatedAt: Date.now(),
			cwd,
		};
		const tracePath = traceFilePath(runsDir(cwd), state.flowName, state.runId);
		const sink = new FileTraceSink(tracePath);
		const deps: RuntimeDeps = {
			cwd,
			agents: AGENTS,
			runTask: mockRunner((t) => `OUT:${t}`),
			persist: () => {},
			onProgress: () => {},
			trace: sink,
		};
		const res = await executeTaskflow(state, deps);
		assert.equal(res.ok, true);
		const events = readTrace(tracePath);
		assert.ok(events.length >= 4, `multi-phase run records >= 4 events, got ${events.length}`);
		// Both phases have a start + end.
		const aStart = events.some((e) => e.phaseId === "a" && e.kind === "phase-start");
		const aEnd = events.some((e) => e.phaseId === "a" && e.kind === "phase-end");
		const bStart = events.some((e) => e.phaseId === "b" && e.kind === "phase-start");
		const bEnd = events.some((e) => e.phaseId === "b" && e.kind === "phase-end");
		assert.ok(aStart && aEnd && bStart && bEnd, "all phases have start+end trace events");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
