/**
 * Private, durable approval continuation checkpoint.
 *
 * The browser never receives this payload. It contains the settled phase
 * outputs needed for deterministic interpolation after a durable approval
 * pause, and is stored as a non-Receipt-reachable secret artifact.
 */
import { Type } from "typebox";
import { Value } from "typebox/value";
import { stableStringify } from "./hash.ts";
import type { PhaseAttempt } from "./phase-scheduler.ts";
import type { RunProjection } from "./types.ts";
import { isSafeId } from "./validate-ids.ts";

export const MAX_APPROVAL_CONTINUATION_BYTES =
	100 * 1024 * 1024;

const SettledPhaseAttemptSchema = Type.Object(
	{
		phaseId: Type.String({
			minLength: 1,
			maxLength: 256,
			pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
		}),
		nodeInstanceId: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 256,
				pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
			}),
		),
		type: Type.String({ minLength: 1, maxLength: 128 }),
		status: Type.Union([
			Type.Literal("completed"),
			Type.Literal("skipped"),
		]),
		output: Type.Optional(
			Type.String({ maxLength: MAX_APPROVAL_CONTINUATION_BYTES }),
		),
		error: Type.Optional(Type.String({ maxLength: 65_536 })),
		providerName: Type.Optional(
			Type.String({ minLength: 1, maxLength: 512 }),
		),
		handle: Type.Optional(
			Type.String({ minLength: 1, maxLength: 8_192 }),
		),
		leaseEpoch: Type.Optional(
			Type.Integer({
				minimum: Number.MIN_SAFE_INTEGER,
				maximum: Number.MAX_SAFE_INTEGER,
			}),
		),
		attemptId: Type.String({
			minLength: 1,
			maxLength: 256,
			pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
		}),
		startedAt: Type.Optional(
			Type.Integer({ minimum: 0 }),
		),
		endedAt: Type.Optional(
			Type.Integer({ minimum: 0 }),
		),
	},
	{ additionalProperties: false },
);

export const ApprovalContinuationCheckpointSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		runId: Type.String({
			minLength: 1,
			maxLength: 256,
			pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
		}),
		boundPlanHash: Type.String({
			pattern: "^bp:[a-f0-9]{64}$",
		}),
		approvalPhaseId: Type.String({
			minLength: 1,
			maxLength: 256,
			pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
		}),
		attempts: Type.Array(SettledPhaseAttemptSchema, {
			maxItems: 10_000,
		}),
		phaseOutputs: Type.Record(
			Type.String({
				minLength: 1,
				maxLength: 256,
				pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
			}),
			Type.String({
				maxLength: MAX_APPROVAL_CONTINUATION_BYTES,
			}),
		),
		createdAt: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

export interface ApprovalContinuationCheckpoint {
	schemaVersion: 1;
	runId: string;
	boundPlanHash: string;
	approvalPhaseId: string;
	attempts: PhaseAttempt[];
	phaseOutputs: Record<string, string>;
	createdAt: number;
}

function assertCheckpointSemantics(
	checkpoint: ApprovalContinuationCheckpoint,
): void {
	if (
		!isSafeId(checkpoint.runId) ||
		!isSafeId(checkpoint.approvalPhaseId) ||
		!/^bp:[a-f0-9]{64}$/u.test(checkpoint.boundPlanHash)
	) {
		throw new TypeError(
			"approval continuation identity is invalid",
		);
	}
	const nodeInstanceIds = new Set<string>();
	const settledRootPhaseIds = new Set<string>();
	for (const attempt of checkpoint.attempts) {
		const nodeInstanceId =
			attempt.nodeInstanceId ?? attempt.phaseId;
		if (
			!isSafeId(attempt.phaseId) ||
			!isSafeId(nodeInstanceId) ||
			!isSafeId(attempt.attemptId) ||
			(attempt.status !== "completed" &&
				attempt.status !== "skipped") ||
			nodeInstanceIds.has(nodeInstanceId)
		) {
			throw new TypeError(
				"approval continuation Attempts must be unique and settled",
			);
		}
		nodeInstanceIds.add(nodeInstanceId);
		if (nodeInstanceId === attempt.phaseId) {
			settledRootPhaseIds.add(attempt.phaseId);
		}
	}
	for (const phaseId of Object.keys(checkpoint.phaseOutputs)) {
		if (!settledRootPhaseIds.has(phaseId)) {
			throw new TypeError(
				"approval continuation output has no settled Attempt",
			);
		}
	}
}

export function createApprovalContinuationCheckpoint(input: {
	runId: string;
	boundPlanHash: string;
	approvalPhaseId: string;
	attempts: readonly PhaseAttempt[];
	phaseOutputs: Readonly<Record<string, string>>;
	createdAt?: number;
}): ApprovalContinuationCheckpoint {
	const checkpoint: ApprovalContinuationCheckpoint = {
		schemaVersion: 1,
		runId: input.runId,
		boundPlanHash: input.boundPlanHash,
		approvalPhaseId: input.approvalPhaseId,
		attempts: input.attempts.map((attempt) => ({
			...attempt,
		})),
		phaseOutputs: { ...input.phaseOutputs },
		createdAt: input.createdAt ?? Date.now(),
	};
	assertCheckpointSemantics(checkpoint);
	if (!Value.Check(ApprovalContinuationCheckpointSchema, checkpoint)) {
		throw new TypeError(
			"approval continuation does not match its executable schema",
		);
	}
	const bytes = Buffer.byteLength(
		stableStringify(checkpoint),
		"utf8",
	);
	if (bytes > MAX_APPROVAL_CONTINUATION_BYTES) {
		throw new RangeError(
			`approval continuation exceeds ${MAX_APPROVAL_CONTINUATION_BYTES} bytes`,
		);
	}
	return checkpoint;
}

export function encodeApprovalContinuationCheckpoint(
	checkpoint: ApprovalContinuationCheckpoint,
): Uint8Array {
	assertCheckpointSemantics(checkpoint);
	if (!Value.Check(ApprovalContinuationCheckpointSchema, checkpoint)) {
		throw new TypeError(
			"approval continuation does not match its executable schema",
		);
	}
	const bytes = Buffer.from(
		stableStringify(checkpoint),
		"utf8",
	);
	if (bytes.byteLength > MAX_APPROVAL_CONTINUATION_BYTES) {
		throw new RangeError(
			`approval continuation exceeds ${MAX_APPROVAL_CONTINUATION_BYTES} bytes`,
		);
	}
	return bytes;
}

export function decodeApprovalContinuationCheckpoint(
	bytes: Uint8Array,
): ApprovalContinuationCheckpoint {
	if (bytes.byteLength > MAX_APPROVAL_CONTINUATION_BYTES) {
		throw new RangeError(
			`approval continuation exceeds ${MAX_APPROVAL_CONTINUATION_BYTES} bytes`,
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(bytes).toString("utf8"));
	} catch {
		throw new TypeError(
			"approval continuation is not valid JSON",
		);
	}
	if (!Value.Check(ApprovalContinuationCheckpointSchema, value)) {
		throw new TypeError(
			"approval continuation does not match its executable schema",
		);
	}
	const checkpoint =
		value as ApprovalContinuationCheckpoint;
	assertCheckpointSemantics(checkpoint);
	return checkpoint;
}

/**
 * Proves that checkpointed phase Attempts are the same durable Attempts
 * projected on the Run. `exact` is required for the currently parked
 * approval; historical approved checkpoints may be a strict prefix after
 * downstream work has completed.
 */
export function approvalContinuationMatchesRun(
	checkpoint: ApprovalContinuationCheckpoint,
	run: RunProjection,
	options: { exact: boolean },
): boolean {
	if (
		checkpoint.runId !== run.runId ||
		checkpoint.boundPlanHash !== run.boundPlanHash
	) {
		return false;
	}
	const projected = run.attempts ?? [];
	if (
		options.exact &&
		projected.length !== checkpoint.attempts.length
	) {
		return false;
	}
	const byAttemptId = new Map(
		projected.map((attempt) => [
			attempt.attemptId,
			attempt,
		]),
	);
	return checkpoint.attempts.every((attempt) => {
		const durable = byAttemptId.get(attempt.attemptId);
		return (
			durable !== undefined &&
			durable.nodeInstanceId ===
				(attempt.nodeInstanceId ??
					attempt.phaseId) &&
			durable.status === attempt.status &&
			durable.provider === attempt.providerName &&
			durable.providerJobHandlePresent ===
				(attempt.handle !== undefined) &&
			durable.startedAt === attempt.startedAt &&
			durable.endedAt === attempt.endedAt
		);
	});
}
