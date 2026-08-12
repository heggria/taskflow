/**
 * Run lifecycle wire types (🟥 NEW).
 *
 * Decisions: P5 — RunStatus and RunStage are independent closed enums; only
 * `completed | failed | blocked | cancelled` are terminal; `unknown` is
 * non-terminal (D33); RunSnapshot carries status + stage + slot + operator flag.
 */

import { Type } from "typebox";
import { StringEnum } from "taskflow-core/typebox-helpers";
import { UuidSchema } from "./common.ts";

export const RunStatusSchema = StringEnum([
	"running",
	"completed",
	"failed",
	"paused",
	"blocked",
	"cancelled",
	"unknown",
]);
export type RunStatus = "running" | "completed" | "failed" | "paused" | "blocked" | "cancelled" | "unknown";

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "failed", "blocked", "cancelled"];

export function isTerminalRunStatus(status: RunStatus): boolean {
	return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export const RunStageSchema = StringEnum([
	"received",
	"compiled",
	"linked",
	"queued",
	"admitted",
	"executing",
	"parked",
	"reconciling",
	"terminal",
]);
export type RunStage =
	| "received"
	| "compiled"
	| "linked"
	| "queued"
	| "admitted"
	| "executing"
	| "parked"
	| "reconciling"
	| "terminal";

/** Slot state per P16 — how the reservation contributes to maxActiveRuns. */
export const RunSlotStateSchema = StringEnum(["none", "reserved", "committed", "orphan-suspect", "released"]);
export type RunSlotState = "none" | "reserved" | "committed" | "orphan-suspect" | "released";

export const RunSnapshotSchema = Type.Object(
	{
		runId: UuidSchema,
		projectId: UuidSchema,
		controlDomainId: UuidSchema,
		status: RunStatusSchema,
		stage: RunStageSchema,
		slot: RunSlotStateSchema,
		needsOperator: Type.Boolean(),
		projectAdmitCommitSeq: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);
export type RunSnapshot = {
	runId: string;
	projectId: string;
	controlDomainId: string;
	status: RunStatus;
	stage: RunStage;
	slot: RunSlotState;
	needsOperator: boolean;
	projectAdmitCommitSeq?: number;
};
