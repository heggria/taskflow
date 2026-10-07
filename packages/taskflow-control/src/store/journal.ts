/** Versioned project journal. V1 bytes remain immutable; V2 chains every batch. */
import { createHash } from "node:crypto";
import { canonicalJson } from "taskflow-core/flowir/hash";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ApprovalRequestSchema, CommandRecordSchema, ControlEventSchema, RunSnapshotSchema, ReceiptSchema, UuidSchema, Sha256HexSchema, ConcurrencyReservationSchema, BoundFragmentSchema, ExecutionOwnerSchema } from "../schema/index.ts";
import type { CommandRecord, ControlEvent, Receipt } from "../schema/index.ts";
import type { ApprovalJournalState } from "../approval-service.ts";

const options = { additionalProperties: false };
const QuiescenceSchema = Type.Object({
	proofId: Type.String({ minLength: 1 }), projectId: UuidSchema, projectControlDomainId: UuidSchema, runId: UuidSchema,
	projectAdmitCommitSeq: Type.Integer({ minimum: 1 }), providerNoLiveProcessTree: Type.Boolean(),
	noAmbiguousJobs: Type.Boolean(), noPendingResourceIntents: Type.Boolean(), reconcileTimeoutOnly: Type.Boolean(),
}, options);
export const ApprovalOutboxSchema = Type.Union([
	Type.Object({ kind: Type.Literal("approval.release"), intentId: UuidSchema, approvalRequestId: UuidSchema, runId: UuidSchema,
		reservationId: UuidSchema, evidence: QuiescenceSchema, complete: Type.Boolean() }, options),
	Type.Object({ kind: Type.Literal("approval.readmission"), intentId: UuidSchema, approvalRequestId: UuidSchema, runId: UuidSchema,
		reservation: ConcurrencyReservationSchema, owner: ExecutionOwnerSchema, fragment: BoundFragmentSchema,
		policyHash: Sha256HexSchema, authorizationContextHash: Sha256HexSchema, projectAdmitCommitSeq: Type.Integer({ minimum: 1 }), complete: Type.Boolean() }, options),
]);
export const ProjectStateSchema = Type.Object({
	run: Type.Object({ ...RunSnapshotSchema.properties, boundPlanHash: Type.String({ minLength: 1 }), policyHash: Sha256HexSchema, authorityEpoch: Type.Integer({ minimum: 0 }) }, options),
	approvals: Type.Array(ApprovalRequestSchema), outbox: Type.Array(ApprovalOutboxSchema),
}, options);
const LegacyBatchSchema = Type.Object({
	recordKind: Type.Literal("commit-batch"), commitSeq: Type.Integer({ minimum: 1 }), command: CommandRecordSchema,
	events: Type.Array(ControlEventSchema, { minItems: 1 }),
}, options);
const BatchSchema = Type.Object({
	recordKind: Type.Literal("lifecycle-batch"), schemaVersion: Type.Literal(2), commitSeq: Type.Integer({ minimum: 1 }),
	previousHash: Sha256HexSchema, contentHash: Sha256HexSchema, command: Type.Optional(CommandRecordSchema),
	events: Type.Array(ControlEventSchema, { minItems: 1 }), projection: Type.Optional(ProjectStateSchema), receipt: Type.Optional(ReceiptSchema),
}, options);
export type LegacyJournalBatch = { recordKind: "commit-batch"; commitSeq: number; command: CommandRecord; events: ControlEvent[] };
export type LifecycleBatch = {
	recordKind: "lifecycle-batch"; schemaVersion: 2; commitSeq: number; previousHash: string; contentHash: string;
	command?: CommandRecord; events: ControlEvent[]; projection?: ApprovalJournalState; receipt?: Receipt;
};
export type JournalBatch = LegacyJournalBatch | LifecycleBatch;
export const JOURNAL_GENESIS = "0".repeat(64);
export function journalHash(record: Omit<LifecycleBatch, "contentHash"> | LegacyJournalBatch): string {
	return createHash("sha256").update(canonicalJson(record)).digest("hex");
}
export function validJournalBatch(value: unknown): value is JournalBatch {
	if (Value.Check(LegacyBatchSchema, value)) return value.events.every((event) => event.schemaVersion === 1);
	if (!Value.Check(BatchSchema, value) || value.events.some((event) => event.schemaVersion !== 2)) return false;
	const { contentHash, ...body } = value;
	return contentHash === journalHash(body as Omit<LifecycleBatch, "contentHash">);
}
