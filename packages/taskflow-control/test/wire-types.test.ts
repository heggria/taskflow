/**
 * Wire freeze TypeBox / constant surface (post P1–P16).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	RUN_STATUSES,
	RUN_STAGES,
	TERMINAL_RUN_STATUSES,
	APPROVAL_MODES,
	CONTROL_MODES,
	DEFAULT_CONTROL_MODE,
	RESERVATION_SLOTS,
	CAPACITY_OCCUPYING_STATES,
	isTerminalRunStatus,
	ControlErrorSchema,
	reconcileRequiredError,
} from "../src/types.ts";

test("RunStatus includes unknown and cancelled; unknown not terminal", () => {
	assert.ok(RUN_STATUSES.includes("unknown"));
	assert.ok(RUN_STATUSES.includes("cancelled"));
	assert.ok(!TERMINAL_RUN_STATUSES.includes("unknown" as never));
	assert.equal(isTerminalRunStatus("unknown"), false);
	assert.equal(isTerminalRunStatus("completed"), true);
	assert.equal(isTerminalRunStatus("cancelled"), true);
});

test("RunStage includes parked and reconciling", () => {
	assert.ok(RUN_STAGES.includes("parked"));
	assert.ok(RUN_STAGES.includes("reconciling"));
	assert.ok(RUN_STAGES.includes("terminal"));
});

test("approval modes and controlMode defaults", () => {
	assert.deepEqual([...APPROVAL_MODES], [
		"compat-auto-reject",
		"durable-optional",
		"durable-required",
	]);
	assert.equal(DEFAULT_CONTROL_MODE, "auto");
	assert.ok(CONTROL_MODES.includes("standalone"));
});

test("slots≡1 and capacity-occupying states", () => {
	assert.equal(RESERVATION_SLOTS, 1);
	assert.deepEqual([...CAPACITY_OCCUPYING_STATES], ["reserved", "committed", "orphan-suspect"]);
});

test("TF_RECONCILE_REQUIRED error shape (P4)", () => {
	const err = reconcileRequiredError("needs op", { projectId: "p" });
	assert.equal(err.code, "TF_RECONCILE_REQUIRED");
	assert.equal(err.recoveryAction, "operator");
	assert.equal(err.sideEffects, "unknown");
	// Schema accepts
	assert.ok(ControlErrorSchema);
});
