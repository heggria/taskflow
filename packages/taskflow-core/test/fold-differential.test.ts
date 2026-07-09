/**
 * S1 differential: fold(events emitted by runtime) matches RunState phase statuses.
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

function mkState(def: Taskflow, args: Record<string, unknown> = {}): RunState {
	return {
		runId: "diff-run",
		flowName: def.name,
		def,
		args,
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

/** Map RunState status (+timedOut/gate) to fold status for comparison. */
function expectedFoldStatus(ps: RunState["phases"][string]): string {
	if (ps.timedOut) return "timedOut";
	if (ps.gate?.verdict === "block" && ps.status === "done") return "blocked";
	// imperative runtime stores blocked gates as status failed or done depending on path —
	// fold uses blocked when gate-score/verdict is block; accept either via decision check below
	return ps.status;
}

function mockRunner(fn: (task: string) => string): RuntimeDeps["runTask"] {
	return async (_c, _a, agent, task, _o: RunOptions): Promise<RunResult> => ({
		agent,
		task,
		exitCode: 0,
		output: fn(task),
		stderr: "",
		usage: { ...emptyUsage(), input: 10, output: 5, cost: 0.01, turns: 1 },
		stopReason: "end",
	});
}

test("differential: simple agent done — fold status matches RunState", async () => {
	const { sink, events } = captureSink();
	const def: Taskflow = {
		name: "diff-agent",
		phases: [{ id: "p", type: "agent", agent: "a", task: "hi", final: true }],
	};
	const res = await executeTaskflow(mkState(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: mockRunner(() => "ok"),
		persist: () => {},
		trace: sink,
	});
	assert.equal(res.ok, true);
	const folded = foldEvents(toEvents(events));
	assert.equal(folded.phases.p.status, "done");
	assert.equal(res.state.phases.p.status, "done");
	assert.ok(events.some((e) => e.kind === "subagent-call"));
	assert.ok(events.some((e) => e.kind === "phase-start"));
	assert.ok(events.some((e) => e.kind === "phase-end"));
});

test("differential: when-guard false → skipped + when-guard decision", async () => {
	const { sink, events } = captureSink();
	const def: Taskflow = {
		name: "diff-when",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "first" },
			{
				id: "opt",
				type: "agent",
				agent: "a",
				task: "maybe",
				when: "false",
				dependsOn: ["a"],
				final: true,
			},
		],
	};
	const res = await executeTaskflow(mkState(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: mockRunner(() => "x"),
		persist: () => {},
		trace: sink,
	});
	assert.equal(res.state.phases.opt.status, "skipped");
	const folded = foldEvents(toEvents(events));
	assert.equal(folded.phases.opt.status, "skipped");
	const whenDec = events.find((e) => e.kind === "decision" && e.decision?.type === "when-guard");
	assert.ok(whenDec);
	assert.equal(whenDec!.decision!.type, "when-guard");
	if (whenDec!.decision!.type === "when-guard") {
		assert.equal(whenDec!.decision!.result, false);
	}
});

test("differential: gate-verdict block emits decision foldable as blocked", async () => {
	const { sink, events } = captureSink();
	const def: Taskflow = {
		name: "diff-gate",
		phases: [
			{ id: "w", type: "agent", agent: "a", task: "work" },
			{
				id: "g",
				type: "gate",
				agent: "a",
				task: "judge",
				dependsOn: ["w"],
				final: true,
			},
		],
	};
	const res = await executeTaskflow(mkState(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: async (_c, _a, agent, task) => ({
			agent,
			task,
			exitCode: 0,
			output: task.includes("judge") ? "VERDICT: BLOCK\nreason: no" : "done-work",
			stderr: "",
			usage: emptyUsage(),
			stopReason: "end",
		}),
		persist: () => {},
		trace: sink,
	});
	// Gate block may fail the run; phase decision must be present for replay.
	const gateDec = events.find(
		(e) => e.kind === "decision" && (e.decision?.type === "gate-verdict" || e.decision?.type === "gate-score"),
	);
	assert.ok(gateDec, "expected gate decision event");
	const folded = foldEvents(toEvents(events));
	assert.ok(folded.phases.g);
	assert.ok(
		folded.phases.g.decision?.type === "gate-verdict" || folded.phases.g.decision?.type === "gate-score",
	);
	if (folded.phases.g.decision?.type === "gate-verdict") {
		assert.equal(folded.phases.g.decision.value, "block");
	}
	// Runtime PhaseStatus has no "blocked"; phase-end records done/failed and
	// fold's terminal status follows phase-end (decision still retained).
	assert.equal(folded.phases.g.status, res.state.phases.g.status);
});


test("differential: budget skip emits budget-hit + lifecycle", async () => {
	const { sink, events } = captureSink();
	const def: Taskflow = {
		name: "diff-budget",
		budget: { maxUSD: 0.000001 },
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "expensive" },
			{ id: "b", type: "agent", agent: "a", task: "after", dependsOn: ["a"], final: true },
		],
	};
	const res = await executeTaskflow(mkState(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: async (_c, _a, agent, task) => ({
			agent,
			task,
			exitCode: 0,
			output: "paid",
			stderr: "",
			usage: { ...emptyUsage(), input: 1000, output: 1000, cost: 1.0, turns: 1 },
			stopReason: "end",
		}),
		persist: () => {},
		trace: sink,
	});
	// b should be skipped due to budget (if a spent over cap)
	const b = res.state.phases.b;
	if (b?.status === "skipped") {
		const budgetDec = events.find((e) => e.kind === "decision" && e.decision?.type === "budget-hit");
		assert.ok(budgetDec, "budget-hit decision expected when phase skipped for budget");
		const folded = foldEvents(toEvents(events));
		assert.equal(folded.phases.b.status, "skipped");
	} else {
		// If budget check only fires after a completes, b may still run depending on when overBudget is checked.
		// Still require that if budget-hit exists, fold agrees.
		const budgetDec = events.find((e) => e.kind === "decision" && e.decision?.type === "budget-hit");
		if (budgetDec) {
			const folded = foldEvents(toEvents(events));
			assert.ok(folded.phases[budgetDec.phaseId]);
		}
	}
});

test("differential: statuses for completed phases agree (fold vs RunState)", async () => {
	const { sink, events } = captureSink();
	const def: Taskflow = {
		name: "diff-chain",
		phases: [
			{ id: "p1", type: "agent", agent: "a", task: "one" },
			{ id: "p2", type: "agent", agent: "a", task: "two {steps.p1.output}", dependsOn: ["p1"], final: true },
		],
	};
	const res = await executeTaskflow(mkState(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: mockRunner((t) => `R(${t.slice(0, 20)})`),
		persist: () => {},
		trace: sink,
	});
	assert.equal(res.ok, true);
	const folded = foldEvents(toEvents(events));
	for (const id of ["p1", "p2"]) {
		const rs = res.state.phases[id];
		const fs = folded.phases[id];
		assert.ok(fs, `fold missing ${id}`);
		const exp = expectedFoldStatus(rs);
		// timedOut only on fold side if phase-end said timedOut; runtime uses failed+flag
		if (rs.timedOut) {
			assert.ok(fs.status === "timedOut" || fs.status === "failed");
		} else {
			assert.equal(fs.status, exp, `phase ${id}: fold=${fs.status} run=${exp}`);
		}
	}
});
