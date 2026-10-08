/**
 * Run lifecycle wire types (🟥 NEW).
 *
 * Decisions: P5 — RunStatus and RunStage are independent closed enums; only
 * `completed | failed | blocked | cancelled` are terminal; `unknown` is
 * non-terminal (D33); RunSnapshot carries status + stage + slot + operator flag.
 */

import { Type } from "typebox";
import { StringEnum } from "taskflow-core/typebox-helpers";
import { UuidSchema, Sha256HexSchema } from "./common.ts";
import { ExecutionOwnerSchema, type ExecutionOwner } from "./te-mirrors.ts";

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
		runVersion: Type.Integer({ minimum: 0 }),
		boundPlanHash: Type.Optional(Type.String({ minLength: 1 })),
		boundFragmentHash: Type.Optional(Type.String({ minLength: 1 })),
		reservationId: Type.Optional(UuidSchema),
		owner: Type.Optional(ExecutionOwnerSchema),
		policyHash: Type.Optional(Sha256HexSchema),
		authorityEpoch: Type.Optional(Type.Integer({ minimum: 0 })),
		requiresReadmission: Type.Optional(Type.Boolean()),
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
	runVersion: number;
	boundPlanHash?: string;
	boundFragmentHash?: string;
	reservationId?: string;
	owner?: ExecutionOwner;
	policyHash?: string;
	authorityEpoch?: number;
	requiresReadmission?: boolean;
	projectAdmitCommitSeq?: number;
};
