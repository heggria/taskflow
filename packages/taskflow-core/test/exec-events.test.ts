import assert from "node:assert/strict";
import { test } from "node:test";
import {
	EVENT_SCHEMA_VERSION,
	type Event,
	type EventDecision,
	type EventKind,
	upgradeTraceEvent,
	readEvents,
} from "../src/exec/events.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

test("EVENT_SCHEMA_VERSION is 1", () => {
	assert.equal(EVENT_SCHEMA_VERSION, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// upgradeTraceEvent
// ─────────────────────────────────────────────────────────────────────────────

test("upgradeTraceEvent: stamps v on a legacy event", () => {
	const legacy = {
		ts: 1_700_000_000_000,
		runId: "run-abc",
		phaseId: "phase-1",
		kind: "phase-start",
	};
	const upgraded = upgradeTraceEvent(legacy);
	assert.equal(upgraded.v, EVENT_SCHEMA_VERSION);
	assert.equal(upgraded.ts, 1_700_000_000_000);
	assert.equal(upgraded.runId, "run-abc");
	assert.equal(upgraded.phaseId, "phase-1");
	assert.equal(upgraded.kind, "phase-start");
});

test("upgradeTraceEvent: preserves input/output/decision fields", () => {
	const legacy = {
		ts: 1_700_000_000_001,
		runId: "run-def",
		phaseId: "phase-2",
		kind: "subagent-call" as const,
		input: {
			agent: "test-agent",
			task: "do something",
			nodePath: "phase-2",
		},
		output: {
			text: "done",
			model: "gpt-4",
		},
		decision: {
			type: "cache-hit" as const,
			scope: "run-only" as const,
		},
		status: "done" as const,
	};
	const upgraded = upgradeTraceEvent(legacy);
	assert.equal(upgraded.v, EVENT_SCHEMA_VERSION);
	assert.deepEqual(upgraded.input, legacy.input);
	assert.deepEqual(upgraded.output, legacy.output);
	assert.deepEqual(upgraded.decision, legacy.decision);
	assert.equal(upgraded.status, "done");
});

test("upgradeTraceEvent: fills defaults for missing fields", () => {
	const upgraded = upgradeTraceEvent({});
	// v is always stamped
	assert.equal(upgraded.v, EVENT_SCHEMA_VERSION);
	// ts falls back to a number (Date.now() approximate)
	assert.equal(typeof upgraded.ts, "number");
	// runId/phaseId fall back to ""
	assert.equal(upgraded.runId, "");
	assert.equal(upgraded.phaseId, "");
	// unknown kind falls back to "phase-start"
	assert.equal(upgraded.kind, "phase-start");
	// optional fields remain undefined
	assert.equal(upgraded.input, undefined);
	assert.equal(upgraded.output, undefined);
	assert.equal(upgraded.decision, undefined);
	assert.equal(upgraded.status, undefined);
	assert.equal(upgraded.error, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// readEvents — round-trip
// ─────────────────────────────────────────────────────────────────────────────

test("readEvents: round-trip a versioned event", () => {
	const event: Event = {
		v: 1,
		ts: 1_700_000_000_002,
		runId: "run-ghi",
		phaseId: "phase-3",
		kind: "phase-end",
		input: {
			agent: "a",
			task: "t",
			nodePath: "phase-3",
		},
		output: {
			text: "result",
		},
		status: "done",
	};

	const text = JSON.stringify(event) + "\n";
	const events = readEvents(text);
	assert.equal(events.length, 1);

	const e = events[0];
	assert.equal(e.v, 1);
	assert.equal(e.ts, 1_700_000_000_002);
	assert.equal(e.runId, "run-ghi");
	assert.equal(e.phaseId, "phase-3");
	assert.equal(e.kind, "phase-end");
	assert.deepEqual(e.input, event.input);
	assert.deepEqual(e.output, event.output);
	assert.equal(e.status, "done");
});

test("readEvents: round-trip multiple versioned events", () => {
	const events: Event[] = [
		{
			v: 1,
			ts: 1_000,
			runId: "r1",
			phaseId: "p1",
			kind: "phase-start",
		},
		{
			v: 1,
			ts: 1_001,
			runId: "r1",
			phaseId: "p1",
			kind: "phase-end",
			status: "done",
		},
		{
			v: 1,
			ts: 1_002,
			runId: "r1",
			phaseId: "p2",
			kind: "subagent-call",
			input: { agent: "a", task: "t", nodePath: "p2" },
			output: { text: "o" },
		},
	];

	const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
	const parsed = readEvents(text);
	assert.equal(parsed.length, 3);
	assert.equal(parsed[0].phaseId, "p1");
	assert.equal(parsed[1].kind, "phase-end");
	assert.equal(parsed[2].kind, "subagent-call");
});

test("readEvents: round-trip an event with a decision", () => {
	const decision: EventDecision = {
		type: "gate-score",
		target: "score the output for quality",
		results: [{ name: "coherence", score: 0.9, weight: 1 }],
		combined: 0.9,
		threshold: 0.7,
		verdict: "pass",
		judgeOutput: "Looks good",
	};

	const event: Event = {
		v: 1,
		ts: 1_700_000_000_003,
		runId: "run-jkl",
		phaseId: "phase-4",
		kind: "decision",
		decision,
	};

	const text = JSON.stringify(event) + "\n";
	const parsed = readEvents(text);
	assert.equal(parsed.length, 1);
	assert.deepEqual(parsed[0].decision, decision);
	assert.equal(parsed[0].decision!.type, "gate-score");
	if (parsed[0].decision!.type === "gate-score") {
		assert.equal(parsed[0].decision!.combined, 0.9);
		assert.equal(parsed[0].decision!.verdict, "pass");
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// readEvents — partial-line tolerance
// ─────────────────────────────────────────────────────────────────────────────

test("readEvents: tolerates a truncated final line", () => {
	const text = '{"v":1,"ts":1,"runId":"r","phaseId":"p","kind":"phase-start"}\n' +
		'{"v":1,"ts":2,"runId":"r","phaseId":"p","kind":"phase-end"}\n' +
		'{"v":1,"ts":3,"runId":"r","phaseId":"p","kind":"decision","truncated';

	const events = readEvents(text);
	assert.equal(events.length, 2);
	assert.equal(events[0].ts, 1);
	assert.equal(events[1].ts, 2);
});

test("readEvents: tolerates blank lines and empty input", () => {
	assert.equal(readEvents("").length, 0);
	assert.equal(readEvents("\n\n").length, 0);
	assert.equal(readEvents("\n  \n\t\n").length, 0);
});

test("readEvents: tolerates complete garbage lines mixed with valid ones", () => {
	const text = '{"v":1,"ts":1,"runId":"r","phaseId":"p","kind":"phase-start"}\n' +
		"this is not json\n" +
		'{"v":1,"ts":2,"runId":"r","phaseId":"p","kind":"phase-end"}\n';

	const events = readEvents(text);
	assert.equal(events.length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// readEvents — versionless line upgrade
// ─────────────────────────────────────────────────────────────────────────────

test("readEvents: upgrades versionless lines via upgradeTraceEvent", () => {
	// A legacy trace event (no v field)
	const legacy = {
		ts: 1_700_000_000_010,
		runId: "legacy-run",
		phaseId: "legacy-phase",
		kind: "phase-start",
	};

	const text = JSON.stringify(legacy) + "\n";
	const events = readEvents(text);
	assert.equal(events.length, 1);

	const e = events[0];
	// Schema version stamped
	assert.equal(e.v, EVENT_SCHEMA_VERSION);
	// Original fields preserved
	assert.equal(e.ts, 1_700_000_000_010);
	assert.equal(e.runId, "legacy-run");
	assert.equal(e.phaseId, "legacy-phase");
	assert.equal(e.kind, "phase-start");
});

test("readEvents: mixed versioned and versionless lines", () => {
	const versioned: Event = {
		v: 1,
		ts: 100,
		runId: "r1",
		phaseId: "p1",
		kind: "phase-start",
	};
	const legacy = {
		ts: 200,
		runId: "r1",
		phaseId: "p1",
		kind: "phase-end",
		status: "done",
	};

	const text = JSON.stringify(versioned) + "\n" + JSON.stringify(legacy) + "\n";
	const events = readEvents(text);
	assert.equal(events.length, 2);

	// First event: versioned, v preserved
	assert.equal(events[0].v, 1);
	assert.equal(events[0].ts, 100);

	// Second event: upgraded, v stamped
	assert.equal(events[1].v, EVENT_SCHEMA_VERSION);
	assert.equal(events[1].ts, 200);
	assert.equal(events[1].status, "done");
});

test("readEvents: upgrades legacy event with decision", () => {
	const legacy = {
		ts: 300,
		runId: "r2",
		phaseId: "gate-phase",
		kind: "decision",
		decision: {
			type: "when-guard",
			expression: "steps.a.output != null",
			result: true,
		},
	};

	const text = JSON.stringify(legacy) + "\n";
	const events = readEvents(text);
	assert.equal(events.length, 1);
	assert.equal(events[0].v, EVENT_SCHEMA_VERSION);
	assert.deepEqual(events[0].decision, {
		type: "when-guard",
		expression: "steps.a.output != null",
		result: true,
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Type-level assertions (compile-time checks)
// ─────────────────────────────────────────────────────────────────────────────

test("EventKind type: covers all 4 variants (compile-time check)", () => {
	// This is a runtime sanity check that the literal union is correct
	const kinds: EventKind[] = ["phase-start", "phase-end", "subagent-call", "decision"];
	assert.equal(kinds.length, 4);
});

test("EventDecision type: covers all 7 variants (compile-time check)", () => {
	// Verify each variant can be constructed and matches the shape
	const decisions: EventDecision[] = [
		{ type: "gate-verdict", value: "pass" },
		{ type: "gate-score", target: "t", results: [], combined: 0.5, verdict: "pass" },
		{ type: "tournament-winner", value: 1 },
		{ type: "budget-hit", value: "budget" },
		{ type: "cache-hit", scope: "cross-run" },
		{ type: "when-guard", expression: "true", result: true },
		{ type: "unreplayable", reason: "inner-flow" },
	];
	assert.equal(decisions.length, 7);
	assert.equal(decisions[0].type, "gate-verdict");
	assert.equal(decisions[6].type, "unreplayable");
});
