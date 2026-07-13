/**
 * S1 hard gate (RFC §11): after a completed run, fold(event log) must rebuild
 * per-phase terminal status matching RunState — the "kill-9 then resume from
 * log" consistency oracle (without actually SIGKILL'ing; we capture the same
 * append-only log the FileTraceSink would have written).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { foldEvents } from "../src/exec/fold.ts";
import { upgradeTraceEvent, type Event } from "../src/exec/events.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import type { TraceEvent, TraceSink } from "../src/trace.ts";
import { emptyUsage } from "../src/usage.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test", systemPrompt: "", source: "user", filePath: "" },
];

function mkState(def: Taskflow): RunState {
	return {
		runId: "kill9-run",
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: process.cwd(),
	};
}

function captureSink(): { sink: TraceSink; events: TraceEvent[] } {
	const events: TraceEvent[] = [];
	return {
		events,
		sink: { emit: (e) => events.push(e), flush: () => {} },
	};
}

function toEvents(raw: TraceEvent[]): Event[] {
	return raw.map((e) => upgradeTraceEvent(e as unknown as Record<string, unknown>));
}

function mockRunner(fn: (task: string) => string): RuntimeDeps["runTask"] {
	return async (_c, _a, agent, task, _o: RunOptions): Promise<RunResult> => ({
		agent,
		task,
		exitCode: 0,
		output: fn(task),
		stderr: "",
		usage: { ...emptyUsage(), input: 5, output: 5, cost: 0.01, turns: 1 },
		stopReason: "end",
	});
}

/** Map RunState status to fold-comparable terminal status. */
function runStatus(ps: RunState["phases"][string]): string {
	if (ps.timedOut) return "timedOut";
	return ps.status;
}

test("kill-9 rebuild: multi-phase agent flow — fold status matches RunState", async () => {
	const { sink, events } = captureSink();
	const def: Taskflow = {
		name: "k9-chain",
		phases: [
			{ id: "p1", type: "agent", agent: "a", task: "first" },
			{ id: "p2", type: "agent", agent: "a", task: "second {steps.p1.output}", dependsOn: ["p1"] },
			{ id: "p3", type: "agent", agent: "a", task: "final", dependsOn: ["p2"], final: true },
		],
	};
	const res = await executeTaskflow(mkState(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: mockRunner((t) => `R:${t.slice(0, 12)}`),
		persist: () => {},
		trace: sink,
	});
	assert.equal(res.ok, true);
	assert.ok(events.length >= 6, `expected rich log, got ${events.length}`);

	// Simulate crash: only the event log survives; rebuild via fold.
	const folded = foldEvents(toEvents(events));
	assert.equal(folded.runId, "kill9-run");
	for (const id of ["p1", "p2", "p3"]) {
		const rs = res.state.phases[id];
		const fs = folded.phases[id];
		assert.ok(fs, `fold missing phase ${id}`);
		assert.equal(fs.status, runStatus(rs), `phase ${id}: fold=${fs.status} run=${runStatus(rs)}`);
		// Last subagent text should be present for done phases
		if (rs.status === "done") {
			assert.ok(fs.output && fs.output.length > 0, `phase ${id} should have folded output`);
		}
	}
});

test("kill-9 rebuild: when-skip + done — both terminal statuses reconstruct", async () => {
	const { sink, events } = captureSink();
	const def: Taskflow = {
		name: "k9-when",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "always" },
			{
				id: "skipme",
				type: "agent",
				agent: "a",
				task: "nope",
				when: "false",
				dependsOn: ["a"],
				final: true,
			},
		],
	};
	const res = await executeTaskflow(mkState(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: mockRunner(() => "ok"),
		persist: () => {},
		trace: sink,
	});
	const folded = foldEvents(toEvents(events));
	assert.equal(folded.phases.a.status, "done");
	assert.equal(folded.phases.skipme.status, "skipped");
	assert.equal(res.state.phases.skipme.status, "skipped");
	assert.equal(folded.phases.skipme.decision?.type, "when-guard");
});

test("kill-9 rebuild: empty log → empty phases (fail-open resume start)", () => {
	const folded = foldEvents([]);
	assert.equal(folded.eventCount, 0);
	assert.deepEqual(folded.phases, {});
});
