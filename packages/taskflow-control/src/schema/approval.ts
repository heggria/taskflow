/**
 * Approval wire types (🟥 NEW) — 0.2.4 protocol upgrade per P15.
 *
 * Decisions: P15 — decision is a CommandRecord (kind approval.decide) with
 * expectedRunVersion CAS (first commit wins); timeout → request `expired` and
 * Run → `blocked` (never permanent paused); three durability modes; edit
 * output → OutputContract check; edit plan → re-Link.
 */

import { Type } from "typebox";
import { StringEnum } from "taskflow-core/typebox-helpers";
import { Sha256HexSchema, UuidSchema } from "./common.ts";
import { ArtifactRefSchema, type ArtifactRef } from "./evidence.ts";

export const ApprovalModeSchema = StringEnum(["compat-auto-reject", "durable-optional", "durable-required"]);
export type ApprovalMode = "compat-auto-reject" | "durable-optional" | "durable-required";

export const ApprovalDecisionSchema = StringEnum(["approve", "reject", "edit"]);
export type ApprovalDecision = "approve" | "reject" | "edit";

export const ApprovalRequestStatusSchema = StringEnum([
	"pending",
	"approved",
	"rejected",
	"edited",
	"expired",
	"cancelled",
]);
export type ApprovalRequestStatus = "pending" | "approved" | "rejected" | "edited" | "expired" | "cancelled";

export const ApprovalRequestSchema = Type.Object(
	{
		approvalRequestId: UuidSchema,
		runId: UuidSchema,
		nodeInstanceId: Type.String({ minLength: 1 }),
		boundPlanHash: Type.Optional(Type.String({ minLength: 1 })),
		boundFragmentHash: Type.Optional(Type.String({ minLength: 1 })),
		expectedRunVersion: Type.Integer({ minimum: 0 }),
		allowedDecisions: Type.Array(ApprovalDecisionSchema, { minItems: 1 }),
		owner: Type.String({ minLength: 1 }),
		audience: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		requiredPrincipals: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		deadline: Type.Integer({ minimum: 0 }),
		timeoutPolicy: StringEnum(["auto-reject", "block", "durable-expire"]),
		status: ApprovalRequestStatusSchema,
		createdAt: Type.Integer({ minimum: 0 }),
		decidedAt: Type.Optional(Type.Integer({ minimum: 0 })),
		decisionCommandId: Type.Optional(UuidSchema),
		editArtifactRef: Type.Optional(ArtifactRefSchema),
	},
	{ additionalProperties: false },
);
export type ApprovalRequest = {
	approvalRequestId: string;
	runId: string;
	nodeInstanceId: string;
	boundPlanHash?: string;
	boundFragmentHash?: string;
	expectedRunVersion: number;
	allowedDecisions: ApprovalDecision[];
	owner: string;
	audience?: string[];
	requiredPrincipals?: string[];
	deadline: number;
	timeoutPolicy: "auto-reject" | "block" | "durable-expire";
	status: ApprovalRequestStatus;
	createdAt: number;
	decidedAt?: number;
	decisionCommandId?: string;
	editArtifactRef?: ArtifactRef;
};

/**
 * ApprovalDecisionCommand (P15) = CommandRecord.kind "approval.decide" plus
 * decision + expectedRunVersion CAS. A decision is a command; disclosure is
 * re-authorized live (P12). First commit wins on expectedRunVersion.
 */
export const ApprovalDecisionCommandSchema = Type.Object(
	{
		commandId: UuidSchema,
		kind: Type.Literal("approval.decide"),
		requestHash: Sha256HexSchema,
		callerPrincipal: Type.String({ minLength: 1 }),
		projectId: UuidSchema,
		controlDomainId: UuidSchema,
		approvalRequestId: UuidSchema,
		runId: UuidSchema,
		expectedRunVersion: Type.Integer({ minimum: 0 }),
		decision: ApprovalDecisionSchema,
		recordedAt: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export type ApprovalDecisionCommand = {
	commandId: string;
	kind: "approval.decide";
	requestHash: string;
	callerPrincipal: string;
	projectId: string;
	controlDomainId: string;
	approvalRequestId: string;
	runId: string;
	expectedRunVersion: number;
	decision: ApprovalDecision;
	recordedAt: number;
};
