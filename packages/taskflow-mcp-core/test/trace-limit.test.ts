import assert from "node:assert/strict";
import test from "node:test";
import type { TraceEvent } from "taskflow-core";
import { formatTraceJsonMcp } from "../src/mcp/server.ts";

test("trace JSON response bounds event count and oversized strings", () => {
	const events: TraceEvent[] = Array.from({ length: 250 }, (_, index) => ({
		v: 1,
		ts: index,
		runId: "run",
		flowName: "flow",
		phaseId: `phase-${index}`,
		kind: "subagent-call",
		input: { agent: "reviewer", task: "x".repeat(20_000), nodePath: `phase-${index}`, attempt: 1 },
		output: { text: "y".repeat(20_000), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, contextTokens: 0 } },
	}));
	const text = formatTraceJsonMcp(events, 50);
	const result = JSON.parse(text);
	assert.equal(result.total, 250);
	assert.equal(result.truncated, true);
	assert.ok(result.returned <= 50);
	assert.ok(text.length <= 120_000);
	assert.match(result.events.at(-1).input.task, /chars\)$/);
});
