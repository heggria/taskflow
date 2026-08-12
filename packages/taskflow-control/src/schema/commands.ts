/**
 * Command + event wire types (🟥 NEW) — the authoritative narrative.
 *
 * Decisions: P12 (immutable CommandRecord committed atomically with its
 * ControlEvents; `(controlDomainId, commandId)` unique), P11 (commitSeq never
 * renumbered; CompactionCheckpointEvent as the only authoritative cursor
 * floor; cursor leases).
 */

import { createHash } from "node:crypto";
import { Type } from "typebox";
import { StringEnum } from "taskflow-core/typebox-helpers";
import {
	CONTROL_WIRE_SCHEMA_VERSION,
	Sha256HexSchema,
	UuidSchema,
} from "./common.ts";
import type { ArtifactRef } from "./evidence.ts";

// ---------------------------------------------------------------------------
// Command kinds (closed union; P15/P16 kinds, plus the base run command)
// ---------------------------------------------------------------------------

export const CommandKindSchema = StringEnum([
	"run.submit",
	"approval.decide",
	"coordinator.setMaxActiveRuns",
	"coordinator.forceRelease",
]);
export type CommandKind = "run.submit" | "approval.decide" | "coordinator.setMaxActiveRuns" | "coordinator.forceRelease";

export const CommandStatusSchema = StringEnum(["accepted", "completed", "failed"]);
export type CommandStatus = "accepted" | "completed" | "failed";

// ---------------------------------------------------------------------------
// CommandRecord (P12 / RFC §9.2) — immutable authority record
// ---------------------------------------------------------------------------

export const CommandRecordSchema = Type.Object(
	{
		commandId: UuidSchema,
		kind: CommandKindSchema,
		requestHash: Sha256HexSchema,
		callerPrincipal: Type.String({ minLength: 1 }),
		authorizationContextHash: Sha256HexSchema,
		projectId: UuidSchema,
		controlDomainId: UuidSchema,
		status: CommandStatusSchema,
		firstCommitSeq: Type.Integer({ minimum: 1 }),
		lastCommitSeq: Type.Integer({ minimum: 1 }),
		responseArtifactRef: Type.Optional(
			Type.Object(
				{
					digest: Type.String({ minLength: 1 }),
					size: Type.Integer({ minimum: 0 }),
					mediaType: Type.String({ minLength: 1 }),
					storageClass: Type.String({ minLength: 1 }),
					redactionClass: Type.String({ minLength: 1 }),
				},
				{ additionalProperties: false },
			),
		),
		recordedAt: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export type CommandRecord = {
	commandId: string;
	kind: CommandKind;
	requestHash: string;
	callerPrincipal: string;
	authorizationContextHash: string;
	projectId: string;
	controlDomainId: string;
	status: CommandStatus;
	firstCommitSeq: number;
	lastCommitSeq: number;
	responseArtifactRef?: ArtifactRef;
	recordedAt: number;
};

// ---------------------------------------------------------------------------
// ControlEvent payload — closed union of S2-known narrative kinds
// (P11 compaction.checkpoint; RFC §8.4 reconcile.*; §16 dispatch.*;
//  §17 approval.*; run terminal). Additive extension bumps schemaVersion.
// ---------------------------------------------------------------------------

export const ControlEventPayloadSchema = Type.Union([
	Type.Object(
		{ kind: Type.Literal("command.recorded"), commandId: UuidSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("reconcile.started"),
			attempt: Type.Integer({ minimum: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("reconcile.settled"),
			outcome: StringEnum(["running", "terminal", "exhausted"]),
			terminalStatus: Type.Optional(StringEnum(["completed", "failed", "blocked", "cancelled"])),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("dispatch.acknowledged"),
			providerJobHandle: Type.Optional(Type.String({ minLength: 1 })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ kind: Type.Literal("dispatch.rejected"), reason: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ kind: Type.Literal("dispatch.ambiguous") },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("run.terminal"),
			status: StringEnum(["completed", "failed", "blocked", "cancelled"]),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("approval.pending"),
			approvalRequestId: UuidSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("approval.settled"),
			decision: StringEnum(["approved", "rejected", "expired", "cancelled"]),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("compaction.checkpoint"),
			throughCommitSeq: Type.Integer({ minimum: 1 }),
		},
		{ additionalProperties: false },
	),
]);
export type ControlEventPayload = {
	kind: "command.recorded";
	commandId: string;
} | {
	kind: "reconcile.started";
	attempt: number;
} | {
	kind: "reconcile.settled";
	outcome: "running" | "terminal" | "exhausted";
	terminalStatus?: "completed" | "failed" | "blocked" | "cancelled";
} | {
	kind: "dispatch.acknowledged";
	providerJobHandle?: string;
} | {
	kind: "dispatch.rejected";
	reason: string;
} | {
	kind: "dispatch.ambiguous";
} | {
	kind: "run.terminal";
	status: "completed" | "failed" | "blocked" | "cancelled";
} | {
	kind: "approval.pending";
	approvalRequestId: string;
} | {
	kind: "approval.settled";
	decision: "approved" | "rejected" | "expired" | "cancelled";
} | {
	kind: "compaction.checkpoint";
	throughCommitSeq: number;
};

// ---------------------------------------------------------------------------
// ControlEvent (P12 / RFC §10) — ledger envelope
// ---------------------------------------------------------------------------

export const ControlEventSchema = Type.Object(
	{
		eventId: UuidSchema,
		schemaVersion: Type.Literal(CONTROL_WIRE_SCHEMA_VERSION),
		controlDomainId: UuidSchema,
		streamId: Type.String({ minLength: 1 }),
		streamSeq: Type.Integer({ minimum: 1 }),
		commitSeq: Type.Integer({ minimum: 1 }),
		commandId: Type.Optional(UuidSchema),
		commandEventIndex: Type.Optional(Type.Integer({ minimum: 0 })),
		causationId: UuidSchema,
		correlationId: UuidSchema,
		projectId: UuidSchema,
		recordedAt: Type.Integer({ minimum: 0 }),
		payload: ControlEventPayloadSchema,
	},
	{ additionalProperties: false },
);
export type ControlEvent = {
	eventId: string;
	schemaVersion: typeof CONTROL_WIRE_SCHEMA_VERSION;
	controlDomainId: string;
	streamId: string;
	streamSeq: number;
	commitSeq: number;
	commandId?: string;
	commandEventIndex?: number;
	causationId: string;
	correlationId: string;
	projectId: string;
	recordedAt: number;
	payload: ControlEventPayload;
};

// ---------------------------------------------------------------------------
// CompactionCheckpointEvent (P11) — journal-internal cursor floor
// ---------------------------------------------------------------------------

export const CompactionCheckpointEventSchema = Type.Object(
	{
		kind: Type.Literal("compaction.checkpoint"),
		throughCommitSeq: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);
export type CompactionCheckpointEvent = { kind: "compaction.checkpoint"; throughCommitSeq: number };

// ---------------------------------------------------------------------------
// CursorState (P11) — cursor/subscription lease
// ---------------------------------------------------------------------------

export const CursorStateSchema = Type.Object(
	{
		minAvailableCommitSeq: Type.Integer({ minimum: 1 }),
		cursorId: UuidSchema,
		leaseExpiresAt: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export type CursorState = {
	minAvailableCommitSeq: number;
	cursorId: string;
	leaseExpiresAt: number;
};

// ---------------------------------------------------------------------------
// Convenience: P12 idempotency / cross-principal markers used by the hello
// and command layers. Not a separate wire doc — checked against CommandRecord.
// ---------------------------------------------------------------------------

/** Canonical request hash over the command body (P12 §9.4). */
export function commandRequestHash(body: unknown): string {
	return createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
	}
	return "null";
}
