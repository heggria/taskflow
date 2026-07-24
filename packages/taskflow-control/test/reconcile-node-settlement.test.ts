import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyReconcileToRun,
	settleTerminalNodes,
	type RunNodeProjection,
	type RunProjection,
} from "../src/index.ts";

const nodes: RunNodeProjection[] = [
	{
		nodeInstanceId: "active",
		phaseId: "active",
		phaseType: "script",
		origin: "bound-plan",
		status: "running",
		attemptCount: 1,
		ordinal: 0,
		displayLabel: "active",
	},
	{
		nodeInstanceId: "approval",
		phaseId: "approval",
		phaseType: "approval",
		origin: "bound-plan",
		status: "waiting",
		attemptCount: 0,
		ordinal: 1,
		displayLabel: "approval",
	},
	{
		nodeInstanceId: "downstream",
		phaseId: "downstream",
		phaseType: "script",
		origin: "bound-plan",
		status: "pending",
		attemptCount: 0,
		ordinal: 2,
		displayLabel: "downstream",
	},
	{
		nodeInstanceId: "settled",
		phaseId: "settled",
		phaseType: "script",
		origin: "bound-plan",
		status: "completed",
		attemptCount: 1,
		ordinal: 3,
		displayLabel: "settled",
	},
];

const run: RunProjection = {
	runId: "run_terminal_nodes",
	projectId: "proj_terminal_nodes",
	controlDomainId: "dom_terminal_nodes",
	status: "unknown",
	stage: "reconciling",
	boundPlanHash: `sha256:${"a".repeat(64)}`,
	needsOperator: false,
	createdAt: 1,
	updatedAt: 2,
	runVersion: 3,
	nodes,
};

test("terminal node settlement: only active work adopts the proven outcome", () => {
	for (const terminal of [
		"completed",
		"failed",
		"cancelled",
	] as const) {
		assert.deepEqual(
			settleTerminalNodes(nodes, terminal).map(
				(node) => node.status,
			),
			[
				terminal,
				terminal,
				"pending",
				"completed",
			],
		);
	}
});

test("reconcile terminal outcome: run and active nodes settle together", () => {
	const cancelled = applyReconcileToRun(run, {
		status: "cancelled",
		stage: "terminal",
		needsOperator: false,
		terminal: "cancelled",
		attempts: 1,
		exhausted: false,
	});
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.stage, "terminal");
	assert.deepEqual(
		cancelled.nodes?.map((node) => node.status),
		[
			"cancelled",
			"cancelled",
			"pending",
			"completed",
		],
	);

	const stillRunning = applyReconcileToRun(run, {
		status: "running",
		stage: "executing",
		needsOperator: false,
		attempts: 1,
		exhausted: false,
	});
	assert.deepEqual(stillRunning.nodes, nodes);
});
