import assert from "node:assert/strict";
import { test } from "node:test";
import { foldEvents, type FoldedRun } from "../src/exec/fold.ts";
import type { Event } from "../src/exec/events.ts";
import { EVENT_SCHEMA_VERSION } from "../src/exec/events.ts";

function ev(partial: Partial<Event> & Pick<Event, "kind" | "phaseId">): Event {
	const { kind, phaseId, ...rest } = partial;
	return {
		v: EVENT_SCHEMA_VERSION,
		ts: 1,
		runId: "run-1",
		phaseId,
		kind,
		...rest,
	};
}

test("foldEvents: phase-start → running, phase-end done → done", () => {
	const events: Event[] = [
		ev({ kind: "phase-start", phaseId: "a", ts: 10 }),
		ev({ kind: "phase-end", phaseId: "a", status: "done", ts: 20, output: { text: "hello" } }),
	];
	const run = foldEvents(events);
	assert.equal(run.runId, "run-1");
	assert.equal(run.phases.a.status, "done");
	assert.equal(run.phases.a.output, "hello");
	assert.equal(run.phases.a.startedAt, 10);
	assert.equal(run.phases.a.endedAt, 20);
});

test("foldEvents: subagent-call accumulates usage + text", () => {
	const events: Event[] = [
		ev({ kind: "phase-start", phaseId: "a" }),
		ev({
			kind: "subagent-call",
			phaseId: "a",
			output: { text: "partial", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 1 } },
		}),
		ev({
			kind: "subagent-call",
			phaseId: "a",
			output: { text: "final", usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.02, contextTokens: 0, turns: 1 } },
		}),
		ev({ kind: "phase-end", phaseId: "a", status: "done" }),
	];
	const run = foldEvents(events);
	assert.equal(run.phases.a.subagentCalls, 2);
	assert.equal(run.phases.a.output, "final");
	assert.equal(run.phases.a.usage.input, 13);
	assert.equal(run.phases.a.usage.output, 7);
	assert.ok(Math.abs(run.phases.a.usage.cost - 0.03) < 1e-12);
});

test("foldEvents: gate-score block decision marks blocked", () => {
	const events: Event[] = [
		ev({ kind: "phase-start", phaseId: "gate" }),
		ev({
			kind: "decision",
			phaseId: "gate",
			decision: {
				type: "gate-score",
				target: "t",
				results: [],
				combined: 0.2,
				threshold: 0.7,
				verdict: "block",
			},
		}),
		ev({ kind: "phase-end", phaseId: "gate", status: "blocked" }),
	];
	const run = foldEvents(events);
	assert.equal(run.phases.gate.status, "blocked");
	assert.equal(run.phases.gate.decision?.type, "gate-score");
});

test("foldEvents: when-guard false → skipped", () => {
	const events: Event[] = [
		ev({
			kind: "decision",
			phaseId: "opt",
			decision: { type: "when-guard", expression: "false", result: false },
		}),
	];
	const run: FoldedRun = foldEvents(events);
	assert.equal(run.phases.opt.status, "skipped");
});

test("foldEvents: empty / orphan events are tolerated", () => {
	const run = foldEvents([]);
	assert.equal(run.eventCount, 0);
	assert.deepEqual(run.phases, {});
});
