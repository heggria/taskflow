import assert from "node:assert/strict";
import { test } from "node:test";
import { replayRun } from "../src/replay.ts";
import type { Event } from "../src/exec/events.ts";
import { EVENT_SCHEMA_VERSION } from "../src/exec/events.ts";

function ev(partial: Partial<Event> & Pick<Event, "kind" | "phaseId">): Event {
	const { kind, phaseId, ...rest } = partial;
	return {
		v: EVENT_SCHEMA_VERSION,
		ts: 1,
		runId: "r1",
		phaseId,
		kind,
		...rest,
	};
}

const gateLog: Event[] = [
	ev({ kind: "phase-start", phaseId: "review" }),
	ev({
		kind: "subagent-call",
		phaseId: "review",
		output: {
			text: "looks ok",
			usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.05, contextTokens: 0, turns: 1 },
		},
	}),
	ev({
		kind: "decision",
		phaseId: "review",
		decision: {
			type: "gate-score",
			target: "quality",
			results: [{ name: "x", type: "contains", passed: true, score: 0.6 }],
			combined: 0.6,
			threshold: 0.5,
			verdict: "pass",
		},
	}),
	ev({ kind: "phase-end", phaseId: "review", status: "done" }),
];

test("replayRun: no overrides → all reused (consistency oracle)", () => {
	const report = replayRun(gateLog);
	assert.equal(report.needsLiveRerun, false);
	assert.ok(report.decisions.every((d) => d.outcome === "reused"));
	assert.equal(report.baseline.phases.review.status, "done");
});

test("replayRun: stricter threshold flips pass → would-block", () => {
	const report = replayRun(gateLog, { thresholds: { review: 0.9 } });
	const d = report.decisions.find((x) => x.phaseId === "review")!;
	assert.equal(d.outcome, "would-block");
	assert.equal(d.priorOutcome, "pass");
	assert.equal(d.replayedOutcome, "block");
});

test("replayRun: looser threshold with same verdict → threshold-changed or reused path", () => {
	// combined 0.6, old threshold 0.5, new 0.55 → still pass
	const report = replayRun(gateLog, { thresholds: { review: 0.55 } });
	const d = report.decisions.find((x) => x.phaseId === "review")!;
	assert.ok(d.outcome === "threshold-changed" || d.outcome === "reused");
	assert.equal(d.replayedOutcome, "pass");
});

test("replayRun: budget cap under recorded cost → would-exceed-budget", () => {
	const report = replayRun(gateLog, { budgetMaxUSD: 0.001 });
	const d = report.decisions.find((x) => x.phaseId === "review")!;
	assert.equal(d.outcome, "would-exceed-budget");
});

test("replayRun: model override → needs-live-rerun", () => {
	const report = replayRun(gateLog, { models: { review: "other-model" } });
	assert.equal(report.needsLiveRerun, true);
	assert.equal(report.decisions[0].outcome, "needs-live-rerun");
});

test("replayRun: never throws on empty log", () => {
	const report = replayRun([]);
	assert.deepEqual(report.decisions, []);
	assert.equal(report.needsLiveRerun, false);
});
