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

test("replayRun: later cache/budget decisions do not erase gate-score history", () => {
	const log: Event[] = [
		ev({ kind: "phase-start", phaseId: "review", dependencies: [] }),
		ev({
			kind: "decision",
			phaseId: "review",
			decision: {
				type: "gate-score",
				target: "quality",
				results: [],
				combined: 0.6,
				threshold: 0.5,
				verdict: "pass",
			},
		}),
		ev({ kind: "decision", phaseId: "review", decision: { type: "cache-hit", scope: "run-only" } }),
		ev({ kind: "decision", phaseId: "review", decision: { type: "budget-hit", value: "budget" } }),
		ev({ kind: "phase-end", phaseId: "review", status: "done" }),
	];
	const report = replayRun(log, { thresholds: { review: 0.9 } });
	assert.equal(report.decisions[0]?.outcome, "would-block");
	assert.equal(report.replayed.phases.review.status, "blocked");
	assert.equal(report.replayed.phases.review.decision?.type, "gate-score");
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

test("replayRun: golden fixture — threshold flip on recorded gate-score", async () => {
	const { readFileSync } = await import("node:fs");
	const { join, dirname } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const { readEvents } = await import("../src/exec/events.ts");
	const here = dirname(fileURLToPath(import.meta.url));
	const text = readFileSync(join(here, "fixtures/golden-gate-trace.jsonl"), "utf8");
	const events = readEvents(text);
	assert.equal(events.length, 7);
	const base = replayRun(events);
	assert.equal(base.needsLiveRerun, false);
	assert.ok(base.decisions.every((d) => d.outcome === "reused" || d.outcome === "failed"));
	const flipped = replayRun(events, { thresholds: { review: 0.9 } });
	const d = flipped.decisions.find((x) => x.phaseId === "review")!;
	assert.equal(d.outcome, "would-block");
	assert.ok(flipped.totalUsage.cost > 0);
});

test("replayRun: threshold block propagates to transitive downstream phases", () => {
	const log: Event[] = [
		ev({ kind: "phase-start", phaseId: "review", dependencies: [] }),
		ev({
			kind: "decision",
			phaseId: "review",
			decision: {
				type: "gate-score",
				target: "quality",
				results: [],
				combined: 0.6,
				threshold: 0.5,
				verdict: "pass",
			},
		}),
		ev({ kind: "phase-end", phaseId: "review", status: "done" }),
		ev({ kind: "phase-start", phaseId: "report", dependencies: ["review"] }),
		ev({ kind: "phase-end", phaseId: "report", status: "done" }),
		ev({ kind: "phase-start", phaseId: "publish", dependencies: ["report"] }),
		ev({ kind: "phase-end", phaseId: "publish", status: "done" }),
	];
	const report = replayRun(log, { thresholds: { review: 0.9 } });
	assert.equal(report.replayed.phases.review.status, "blocked");
	assert.equal(report.replayed.phases.report.status, "skipped");
	assert.equal(report.replayed.phases.publish.status, "skipped");
	assert.equal(report.decisions.find((d) => d.phaseId === "report")?.outcome, "would-skip");
	assert.deepEqual(report.decisions.find((d) => d.phaseId === "publish")?.causedBy, ["review"]);
	assert.notStrictEqual(report.replayed, report.baseline);
});

test("replayRun: recorded gate BLOCK flipped to PASS makes previously skipped descendants live", () => {
	const log: Event[] = [
		ev({ kind: "phase-start", phaseId: "review", dependencies: [] }),
		ev({
			kind: "decision",
			phaseId: "review",
			decision: {
				type: "gate-score",
				target: "quality",
				results: [],
				combined: 0.4,
				threshold: 0.5,
				verdict: "block",
			},
		}),
		ev({ kind: "phase-end", phaseId: "review", status: "blocked" }),
		ev({ kind: "phase-start", phaseId: "draft", dependencies: ["review"] }),
		ev({ kind: "phase-end", phaseId: "draft", status: "skipped", error: "Gate blocked: quality" }),
		ev({ kind: "phase-start", phaseId: "publish", dependencies: ["draft"] }),
		ev({ kind: "phase-end", phaseId: "publish", status: "skipped", error: "Gate blocked: quality" }),
		ev({ kind: "phase-start", phaseId: "independent-late", dependencies: [] }),
		ev({ kind: "phase-end", phaseId: "independent-late", status: "skipped", error: "Gate blocked: quality" }),
	];
	const report = replayRun(log, { thresholds: { review: 0.3 } });
	assert.equal(report.decisions.find((d) => d.phaseId === "review")?.outcome, "verdict-flipped");
	assert.equal(report.replayed.phases.review.status, "done");
	assert.equal(report.decisions.find((d) => d.phaseId === "draft")?.outcome, "needs-live-rerun");
	assert.equal(report.decisions.find((d) => d.phaseId === "publish")?.outcome, "needs-live-rerun");
	assert.equal(report.decisions.find((d) => d.phaseId === "independent-late")?.outcome, "needs-live-rerun");
	assert.deepEqual(report.decisions.find((d) => d.phaseId === "publish")?.causedBy, ["review"]);
	assert.equal(report.replayed.phases.draft.status, "pending");
	assert.equal(report.replayed.phases.publish.status, "pending");
	assert.equal(report.replayed.phases["independent-late"].status, "pending");
	assert.equal(report.needsLiveRerun, true);
});

test("replayRun: PASS to BLOCK follows global gate admission across the recorded layer", () => {
	const score: Event = {
		...ev({
			kind: "decision",
			phaseId: "review",
			decision: {
				type: "gate-score",
				target: "quality",
				results: [],
				combined: 0.6,
				threshold: 0.5,
				verdict: "pass",
			},
		}),
		ts: 3,
	};
	const log: Event[] = [
		{ ...ev({ kind: "phase-start", phaseId: "review", dependencies: [] }), ts: 1 },
		{ ...ev({ kind: "phase-start", phaseId: "already-started", dependencies: [] }), ts: 2 },
		score,
		{ ...ev({ kind: "phase-start", phaseId: "equal-time", dependencies: [] }), ts: 4 },
		{ ...ev({ kind: "phase-end", phaseId: "review", status: "done" }), ts: 4 },
		{ ...ev({ kind: "phase-end", phaseId: "already-started", status: "done" }), ts: 5 },
		{ ...ev({ kind: "phase-start", phaseId: "not-admitted", dependencies: [] }), ts: 6 },
		{ ...ev({ kind: "phase-end", phaseId: "not-admitted", status: "done" }), ts: 7 },
		{ ...ev({ kind: "phase-end", phaseId: "equal-time", status: "done" }), ts: 8 },
		{ ...ev({ kind: "phase-start", phaseId: "next-layer", dependencies: ["already-started"] }), ts: 9 },
		{ ...ev({ kind: "phase-end", phaseId: "next-layer", status: "done" }), ts: 10 },
	];
	const report = replayRun(log, { thresholds: { review: 0.9 } });
	assert.equal(report.decisions.find((d) => d.phaseId === "review")?.outcome, "would-block");
	assert.equal(report.decisions.find((d) => d.phaseId === "already-started")?.outcome, "reused");
	assert.equal(report.replayed.phases["already-started"].status, "done");
	assert.equal(report.decisions.find((d) => d.phaseId === "not-admitted")?.outcome, "needs-live-rerun");
	assert.equal(report.replayed.phases["not-admitted"].status, "pending");
	assert.equal(report.decisions.find((d) => d.phaseId === "next-layer")?.outcome, "would-skip");
	assert.equal(report.decisions.find((d) => d.phaseId === "equal-time")?.outcome, "needs-live-rerun");
	assert.equal(report.replayed.phases["equal-time"].status, "pending");
});

test("replayRun: budget is cumulative in execution order and only later phases skip", () => {
	const usage = (cost: number) => ({
		text: "ok",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost, contextTokens: 0, turns: 1 },
	});
	const log: Event[] = [];
	for (const id of ["a", "b", "c"]) {
		log.push(ev({ kind: "phase-start", phaseId: id, dependencies: id === "a" ? [] : [String.fromCharCode(id.charCodeAt(0) - 1)] }));
		log.push(ev({ kind: "subagent-call", phaseId: id, output: usage(0.04) }));
		log.push(ev({ kind: "phase-end", phaseId: id, status: "done" }));
	}
	const report = replayRun(log, { budgetMaxUSD: 0.05 });
	assert.equal(report.decisions.find((d) => d.phaseId === "a")?.outcome, "reused");
	assert.equal(report.decisions.find((d) => d.phaseId === "b")?.outcome, "would-exceed-budget");
	assert.equal(report.decisions.find((d) => d.phaseId === "c")?.outcome, "would-skip");
	assert.equal(report.replayed.phases.a.status, "done");
	assert.equal(report.replayed.phases.b.status, "done");
	assert.equal(report.replayed.phases.c.status, "skipped");
});

test("replayRun: budget never retroactively skips an already-started same-layer sibling", () => {
	const usage = (cost: number) => ({
		text: "ok",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost, contextTokens: 0, turns: 1 },
	});
	const log: Event[] = [
		{ ...ev({ kind: "phase-start", phaseId: "a", dependencies: [] }), ts: 1 },
		{ ...ev({ kind: "phase-start", phaseId: "b", dependencies: [] }), ts: 2 },
		{ ...ev({ kind: "subagent-call", phaseId: "a", output: usage(0.06) }), ts: 3 },
		{ ...ev({ kind: "phase-end", phaseId: "a", status: "done" }), ts: 4 },
		{ ...ev({ kind: "subagent-call", phaseId: "b", output: usage(0.01) }), ts: 5 },
		{ ...ev({ kind: "phase-end", phaseId: "b", status: "done" }), ts: 6 },
		{ ...ev({ kind: "phase-start", phaseId: "c", dependencies: ["a", "b"] }), ts: 7 },
		{ ...ev({ kind: "subagent-call", phaseId: "c", output: usage(0.01) }), ts: 8 },
		{ ...ev({ kind: "phase-end", phaseId: "c", status: "done" }), ts: 9 },
	];
	const report = replayRun(log, { budgetMaxUSD: 0.05 });
	assert.equal(report.decisions.find((d) => d.phaseId === "a")?.outcome, "would-exceed-budget");
	assert.equal(report.decisions.find((d) => d.phaseId === "b")?.outcome, "reused");
	assert.equal(report.replayed.phases.b.status, "done", "concurrent sibling was already admitted");
	assert.equal(report.decisions.find((d) => d.phaseId === "c")?.outcome, "would-skip");
	assert.equal(report.replayed.phases.c.status, "skipped");
});

test("replayRun: budget and threshold overrides compose without stale downstream decisions", () => {
	const usage = (cost: number) => ({
		text: "ok",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost, contextTokens: 0, turns: 1 },
	});
	const log: Event[] = [
		ev({ kind: "phase-start", phaseId: "spend", dependencies: [] }),
		ev({ kind: "subagent-call", phaseId: "spend", output: usage(0.06) }),
		ev({ kind: "phase-end", phaseId: "spend", status: "done" }),
		ev({ kind: "phase-start", phaseId: "review", dependencies: ["spend"] }),
		ev({
			kind: "decision",
			phaseId: "review",
			decision: {
				type: "gate-score",
				target: "quality",
				results: [],
				combined: 0.6,
				threshold: 0.5,
				verdict: "pass",
			},
		}),
		ev({ kind: "phase-end", phaseId: "review", status: "done" }),
		ev({ kind: "phase-start", phaseId: "report", dependencies: ["review"] }),
		ev({ kind: "phase-end", phaseId: "report", status: "done" }),
	];
	const report = replayRun(log, { budgetMaxUSD: 0.05, thresholds: { review: 0.9 } });
	assert.equal(report.decisions.find((d) => d.phaseId === "spend")?.outcome, "would-exceed-budget");
	assert.equal(report.decisions.find((d) => d.phaseId === "review")?.outcome, "would-skip");
	assert.equal(report.decisions.find((d) => d.phaseId === "report")?.outcome, "would-skip");
	assert.deepEqual(report.decisions.find((d) => d.phaseId === "report")?.causedBy, ["spend"]);
	assert.equal(report.replayed.phases.review.status, "skipped");
	assert.equal(report.replayed.phases.report.status, "skipped");
});

test("replayRun: unknown model or args spend propagates needs-live across budget layers", () => {
	const usage = (cost: number) => ({
		text: "ok",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost, contextTokens: 0, turns: 1 },
	});
	const log: Event[] = [];
	for (const [id, parent] of [["a", undefined], ["b", "a"], ["c", "b"]] as const) {
		log.push(ev({ kind: "phase-start", phaseId: id, dependencies: parent ? [parent] : [] }));
		log.push(ev({ kind: "subagent-call", phaseId: id, output: usage(0.04) }));
		log.push(ev({ kind: "phase-end", phaseId: id, status: "done" }));
	}
	const model = replayRun(log, { budgetMaxUSD: 0.05, models: { b: "other-model" } });
	assert.equal(model.decisions.find((d) => d.phaseId === "a")?.outcome, "reused");
	assert.equal(model.decisions.find((d) => d.phaseId === "b")?.outcome, "needs-live-rerun");
	assert.equal(model.decisions.find((d) => d.phaseId === "c")?.outcome, "needs-live-rerun");
	assert.equal(model.replayed.phases.b.status, "pending");
	assert.equal(model.replayed.phases.c.status, "pending");

	const args = replayRun(log, { budgetMaxUSD: 0.05, args: { topic: "changed" } });
	assert.ok(args.decisions.every((d) => d.outcome === "needs-live-rerun"));
	assert.ok(Object.values(args.replayed.phases).every((p) => p.status === "pending"));
});

test("replayRun: loosening budget revives recorded budget skips as live work", () => {
	const usage = {
		text: "ok",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.06, contextTokens: 0, turns: 1 },
	};
	const log: Event[] = [
		ev({ kind: "phase-start", phaseId: "spend", dependencies: [] }),
		ev({ kind: "subagent-call", phaseId: "spend", output: usage }),
		ev({ kind: "phase-end", phaseId: "spend", status: "done" }),
		ev({ kind: "phase-start", phaseId: "revived", dependencies: ["spend"] }),
		ev({
			kind: "decision",
			phaseId: "revived",
			decision: { type: "budget-hit", value: "budget", reason: "Budget exceeded: old cap" },
		}),
		ev({ kind: "phase-end", phaseId: "revived", status: "skipped", error: "Budget exceeded: old cap" }),
		ev({ kind: "phase-start", phaseId: "consumer", dependencies: ["revived"] }),
		ev({ kind: "phase-end", phaseId: "consumer", status: "skipped", error: "Upstream dependency not satisfied" }),
	];
	const report = replayRun(log, { budgetMaxUSD: 0.1, models: { revived: "new-model" } });
	assert.equal(report.decisions.find((d) => d.phaseId === "spend")?.outcome, "reused");
	assert.equal(report.decisions.find((d) => d.phaseId === "revived")?.outcome, "needs-live-rerun");
	assert.equal(report.decisions.find((d) => d.phaseId === "consumer")?.outcome, "needs-live-rerun");
	assert.equal(report.replayed.phases.revived.status, "pending");
	assert.equal(report.replayed.phases.consumer.status, "pending");
	assert.equal(report.needsLiveRerun, true);

	const stillTight = replayRun(log, { budgetMaxUSD: 0.05, models: { revived: "new-model" } });
	assert.equal(stillTight.decisions.find((d) => d.phaseId === "revived")?.outcome, "would-skip");
	assert.equal(stillTight.decisions.find((d) => d.phaseId === "consumer")?.outcome, "would-skip");
	assert.equal(stillTight.replayed.phases.revived.status, "skipped");
	assert.equal(stillTight.needsLiveRerun, false, "deterministic new budget stop dominates an unreachable model override");
});

test("replayRun: legacy multi-phase trace without dependency metadata never invents local propagation", () => {
	const log: Event[] = [
		ev({ kind: "phase-start", phaseId: "review" }),
		ev({
			kind: "decision",
			phaseId: "review",
			decision: {
				type: "gate-score",
				target: "quality",
				results: [],
				combined: 0.6,
				threshold: 0.5,
				verdict: "pass",
			},
		}),
		ev({ kind: "phase-end", phaseId: "review", status: "done" }),
		ev({ kind: "phase-start", phaseId: "consumer" }),
		ev({ kind: "phase-end", phaseId: "consumer", status: "done" }),
	];

	const threshold = replayRun(log, { thresholds: { review: 0.9 } });
	assert.equal(threshold.decisions.find((d) => d.phaseId === "review")?.outcome, "would-block");
	assert.equal(threshold.decisions.find((d) => d.phaseId === "consumer")?.outcome, "needs-live-rerun");
	assert.equal(threshold.replayed.phases.consumer.status, "pending");
	assert.equal(threshold.needsLiveRerun, true);

	const model = replayRun(log, { models: { review: "other-model" } });
	assert.ok(model.decisions.every((d) => d.outcome === "needs-live-rerun"));
	assert.ok(Object.values(model.replayed.phases).every((p) => p.status === "pending"));

	const args = replayRun(log, { args: { topic: "changed" } });
	assert.ok(args.decisions.every((d) => d.outcome === "needs-live-rerun"));
	assert.ok(Object.values(args.replayed.phases).every((p) => p.status === "pending"));

	const combined = replayRun(log, {
		thresholds: { review: 0.9 },
		models: { review: "other-model" },
		args: { topic: "changed" },
		budgetMaxUSD: 0.001,
	});
	assert.ok(combined.decisions.every((d) => d.outcome === "needs-live-rerun"));
	assert.equal(combined.needsLiveRerun, true);

	const twoGateLog: Event[] = [
		...log.slice(0, 3).map((event) => ({ ...event, phaseId: "review-a" })),
		...log.slice(0, 3).map((event) => ({ ...event, phaseId: "review-b" })),
		ev({ kind: "phase-start", phaseId: "unknown-related" }),
		ev({ kind: "phase-end", phaseId: "unknown-related", status: "done" }),
	];
	const multipleThresholds = replayRun(twoGateLog, {
		thresholds: { "review-a": 0.9, "review-b": 0.9 },
	});
	assert.ok(multipleThresholds.decisions.every((d) => d.outcome === "needs-live-rerun"));
	assert.ok(Object.values(multipleThresholds.replayed.phases).every((p) => p.status === "pending"));
});

test("replayRun: unreplayable marker requires live rerun and propagates downstream", () => {
	const log: Event[] = [
		ev({ kind: "phase-start", phaseId: "inner", dependencies: [] }),
		ev({
			kind: "decision",
			phaseId: "inner",
			decision: { type: "unreplayable", reason: "inner-flow" },
		}),
		ev({ kind: "phase-end", phaseId: "inner", status: "done" }),
		ev({ kind: "phase-start", phaseId: "consumer", dependencies: ["inner"] }),
		ev({ kind: "phase-end", phaseId: "consumer", status: "done" }),
	];
	const report = replayRun(log);
	assert.equal(report.needsLiveRerun, true);
	assert.equal(report.decisions.find((d) => d.phaseId === "inner")?.outcome, "needs-live-rerun");
	assert.equal(report.decisions.find((d) => d.phaseId === "consumer")?.outcome, "needs-live-rerun");
	assert.deepEqual(report.decisions.find((d) => d.phaseId === "consumer")?.causedBy, ["inner"]);
});

test("replayRun: mixed historical nested runIds are isolated to the outer run", () => {
	const outer: Event = { ...ev({ kind: "phase-start", phaseId: "flow", dependencies: [] }), ts: 1 };
	const child: Event = { ...ev({ kind: "phase-start", phaseId: "child" }), runId: "nested-run", ts: 2 };
	const outerEnd: Event = { ...ev({ kind: "phase-end", phaseId: "flow", status: "done" }), ts: 3 };
	const report = replayRun([outer, child, outerEnd]);
	assert.equal(report.baseline.runId, "r1");
	assert.deepEqual(Object.keys(report.baseline.phases), ["flow"]);
});

test("replayRun: child-first legacy flush order still selects temporal outer envelope", () => {
	const outerStart: Event = { ...ev({ kind: "phase-start", phaseId: "flow" }), runId: "outer", ts: 1 };
	const outerMarker: Event = {
		...ev({ kind: "decision", phaseId: "flow", decision: { type: "unreplayable", reason: "inner-flow" } }),
		runId: "outer",
		ts: 1,
	};
	const childStart: Event = { ...ev({ kind: "phase-start", phaseId: "child" }), runId: "child", ts: 2 };
	const childEnd: Event = { ...ev({ kind: "phase-end", phaseId: "child", status: "done" }), runId: "child", ts: 3 };
	const outerEnd: Event = { ...ev({ kind: "phase-end", phaseId: "flow", status: "done" }), runId: "outer", ts: 4 };
	const report = replayRun([childStart, childEnd, outerStart, outerMarker, outerEnd]);
	assert.equal(report.baseline.runId, "outer");
	assert.deepEqual(Object.keys(report.baseline.phases), ["flow"]);
	assert.equal(report.needsLiveRerun, true, "outer flow marker remains fail-safe");
});

test("replayRun: genuinely ambiguous mixed run identity fails safe", () => {
	const log: Event[] = [
		{ ...ev({ kind: "phase-start", phaseId: "a" }), runId: "run-a", ts: 1 },
		{ ...ev({ kind: "phase-end", phaseId: "a", status: "done" }), runId: "run-a", ts: 1 },
		{ ...ev({ kind: "phase-start", phaseId: "b" }), runId: "run-b", ts: 1 },
		{ ...ev({ kind: "phase-end", phaseId: "b", status: "done" }), runId: "run-b", ts: 1 },
	];
	const report = replayRun(log);
	assert.equal(report.needsLiveRerun, true);
	assert.ok(report.decisions.every((d) => d.outcome === "needs-live-rerun"));
	assert.match(report.decisions[0]?.reason ?? "", /ambiguous/);
});

test("replayRun: complete child is not evidence over a truncated outer run", () => {
	const childStart: Event = { ...ev({ kind: "phase-start", phaseId: "child" }), runId: "child", ts: 2 };
	const childEnd: Event = { ...ev({ kind: "phase-end", phaseId: "child", status: "done" }), runId: "child", ts: 3 };
	const outerStart: Event = { ...ev({ kind: "phase-start", phaseId: "flow" }), runId: "outer", ts: 1 };
	const report = replayRun([childStart, childEnd, outerStart]);
	assert.equal(report.baseline.runId, "outer");
	assert.equal(report.baseline.phases.flow.status, "running");
	assert.equal(report.needsLiveRerun, true);
	assert.equal(report.decisions[0]?.outcome, "needs-live-rerun");
	assert.notEqual(report.decisions[0]?.outcome, "reused");
});

test("replayRun: any selected run with start but no end fails safe", () => {
	const report = replayRun([ev({ kind: "phase-start", phaseId: "only" })]);
	assert.equal(report.needsLiveRerun, true);
	assert.equal(report.decisions[0]?.outcome, "needs-live-rerun");
});

test("replayRun: truncated repeated gate attempt is never reused", () => {
	const log: Event[] = [
		{ ...ev({ kind: "phase-start", phaseId: "review" }), ts: 1 },
		{
			...ev({
				kind: "decision",
				phaseId: "review",
				decision: { type: "gate-verdict", value: "pass" },
			}),
			ts: 2,
		},
		{ ...ev({ kind: "phase-end", phaseId: "review", status: "done" }), ts: 3 },
		// Gate retry/recompute began a new attempt but the trace truncated before
		// its matching phase-end.
		{ ...ev({ kind: "phase-start", phaseId: "review" }), ts: 4 },
	];
	const report = replayRun(log);
	assert.equal(report.baseline.phases.review.status, "running");
	assert.ok((report.baseline.phases.review.endedAt ?? 0) < (report.baseline.phases.review.startedAt ?? 0));
	assert.equal(report.needsLiveRerun, true);
	assert.equal(report.decisions[0]?.outcome, "needs-live-rerun");
	assert.notEqual(report.decisions[0]?.outcome, "reused");
});

test("replayRun: reversed lifecycle timestamps fail safe", () => {
	const report = replayRun([
		{ ...ev({ kind: "phase-start", phaseId: "p" }), ts: 5 },
		{ ...ev({ kind: "phase-end", phaseId: "p", status: "done" }), ts: 4 },
	]);
	assert.equal(report.needsLiveRerun, true);
	assert.equal(report.decisions[0]?.outcome, "needs-live-rerun");
});
