/**
 * UserCoordinatorStore wire types (🟥 NEW) — singleton lease + global
 * concurrency reservations + narrow coordinator commands.
 *
 * Decisions: P16 — slots ≡ 1 per admitted run; capacity formula
 * count(reserved|committed|orphan-suspect) ≤ maxActiveRuns; committed never
 * TTL-released (D37 normalRelease/forceRelease only); D2 admission uniqueness;
 * D3 legacy residue fail-closed; D4 idempotent release.
 */

import { Type } from "typebox";
import { StringEnum } from "taskflow-core/typebox-helpers";
import { Sha256HexSchema, UuidSchema } from "./common.ts";

// ---------------------------------------------------------------------------
// CoordinatorLease (P16 / D32)
// ---------------------------------------------------------------------------

export const CoordinatorLeaseSchema = Type.Object(
	{
		holderId: Type.String({ minLength: 1 }),
		fencingEpoch: Type.Integer({ minimum: 0 }),
		endpoint: Type.String({ minLength: 1 }),
		expiresAt: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export type CoordinatorLease = {
	holderId: string;
	fencingEpoch: number;
	endpoint: string;
	expiresAt: number;
};

// ---------------------------------------------------------------------------
// ConcurrencyReservation (P16)
// ---------------------------------------------------------------------------

export const ReservationStateSchema = StringEnum(["reserved", "committed", "released", "expired", "orphan-suspect"]);
export type ReservationState = "reserved" | "committed" | "released" | "expired" | "orphan-suspect";

export const ConcurrencyReservationSchema = Type.Object(
	{
		reservationId: UuidSchema,
		state: ReservationStateSchema,
		slots: Type.Literal(1),
		projectId: UuidSchema,
		projectControlDomainId: UuidSchema,
		runId: UuidSchema,
		// Required once admitted (state ∈ {committed, orphan-suspect}); absent
		// during the pre-admit reserved window (P16 crash matrix).
		projectAdmitCommitSeq: Type.Optional(Type.Integer({ minimum: 1 })),
		attemptId: Type.Optional(UuidSchema),
		providerJobHandle: Type.Optional(Type.String({ minLength: 1 })),
		coordinatorEpoch: Type.Integer({ minimum: 0 }),
		reservedExpiresAt: Type.Optional(Type.Integer({ minimum: 0 })),
		renewedAt: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	{ additionalProperties: false },
);
export type ConcurrencyReservation = {
	reservationId: string;
	state: ReservationState;
	slots: 1;
	projectId: string;
	projectControlDomainId: string;
	runId: string;
	projectAdmitCommitSeq?: number;
	attemptId?: string;
	providerJobHandle?: string;
	coordinatorEpoch: number;
	reservedExpiresAt?: number;
	renewedAt?: number;
};

/**
 * P16 D2/D3 invariants, enforced at the store boundary (fail closed):
 * - committed/orphan-suspect rows MUST carry projectAdmitCommitSeq (D3 residue
 *   that keeps a TTL field on a committed row is a separate check).
 * - a reservation with a stale state/identity mismatch is rejected.
 * TypeBox alone cannot express the state-conditional requirement, so the
 * store layer asserts it here.
 */
export function assertReservationInvariants(reservation: ConcurrencyReservation): void {
	if (reservation.state === "committed" || reservation.state === "orphan-suspect") {
		if (reservation.projectAdmitCommitSeq === undefined) {
			throw new Error("TF_ADMISSION_BINDING_CONFLICT: committed/orphan-suspect reservation requires projectAdmitCommitSeq");
		}
		if (reservation.reservedExpiresAt !== undefined) {
			throw new Error("TF_ADMISSION_BINDING_CONFLICT: committed/orphan-suspect reservation must not retain reservedExpiresAt (P16 D3)");
		}
	}
	if (reservation.slots !== 1) {
		throw new Error("TF_ADMISSION_BINDING_CONFLICT: 0.3 slots are fixed at 1 (P16)");
	}
}

// ---------------------------------------------------------------------------
// CoordinatorCommandRecord (P16 / D6) — narrow command authority
// ---------------------------------------------------------------------------

export const CoordinatorCommandKindSchema = StringEnum(["setMaxActiveRuns", "forceRelease"]);
export type CoordinatorCommandKind = "setMaxActiveRuns" | "forceRelease";

export const CoordinatorCommandStatusSchema = StringEnum(["accepted", "completed", "failed"]);
export type CoordinatorCommandStatus = "accepted" | "completed" | "failed";

export const CoordinatorCommandRecordSchema = Type.Object(
	{
		commandId: UuidSchema,
		kind: CoordinatorCommandKindSchema,
		requestHash: Sha256HexSchema,
		callerPrincipal: Type.String({ minLength: 1 }),
		firstCommitSeq: Type.Integer({ minimum: 1 }),
		lastCommitSeq: Type.Integer({ minimum: 1 }),
		status: CoordinatorCommandStatusSchema,
	},
	{ additionalProperties: false },
);
export type CoordinatorCommandRecord = {
	commandId: string;
	kind: CoordinatorCommandKind;
	requestHash: string;
	callerPrincipal: string;
	firstCommitSeq: number;
	lastCommitSeq: number;
	status: CoordinatorCommandStatus;
};

// ---------------------------------------------------------------------------
// CapacitySnapshot (P16) — metering/statistics
// ---------------------------------------------------------------------------

export const CapacitySnapshotSchema = Type.Object(
	{
		maxActiveRuns: Type.Integer({ minimum: 1 }),
		active: Type.Integer({ minimum: 0 }),
		reserved: Type.Integer({ minimum: 0 }),
		committed: Type.Integer({ minimum: 0 }),
		orphanSuspect: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export type CapacitySnapshot = {
	maxActiveRuns: number;
	active: number;
	reserved: number;
	committed: number;
	orphanSuspect: number;
};
