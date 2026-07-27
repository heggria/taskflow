/**
 * 0.3 control-plane wire types (TypeBox + TypeScript).
 *
 * Frozen after P1–P16 ADRs. See docs/internal/rfc-0.3.0-control-plane.md §8–§18
 * and docs/internal/p-adrs/.
 */
import { Type, type Static } from "typebox";

// ---------------------------------------------------------------------------
// RunStatus / RunStage (D31)
// ---------------------------------------------------------------------------

export const RUN_STATUSES = [
	"running",
	"completed",
	"failed",
	"paused",
	"blocked",
	"cancelled",
	"unknown",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_STAGES = [
	"received",
	"compiled",
	"linked",
	"queued",
	"admitted",
	"executing",
	"parked",
	"reconciling",
	"terminal",
] as const;
export type RunStage = (typeof RUN_STAGES)[number];

export const TERMINAL_RUN_STATUSES = ["completed", "failed", "blocked", "cancelled"] as const;
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export function isTerminalRunStatus(s: RunStatus): s is TerminalRunStatus {
	return (TERMINAL_RUN_STATUSES as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// controlMode (D5)
// ---------------------------------------------------------------------------

export const CONTROL_MODES = ["auto", "coordinated", "standalone"] as const;
export type ControlMode = (typeof CONTROL_MODES)[number];
/** Default is auto — silent auto→standalone is forbidden. */
export const DEFAULT_CONTROL_MODE: ControlMode = "auto";

// ---------------------------------------------------------------------------
// Approval durability modes (D34)
// ---------------------------------------------------------------------------

export const APPROVAL_MODES = [
	"compat-auto-reject",
	"durable-optional",
	"durable-required",
] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "compat-auto-reject";

// ---------------------------------------------------------------------------
// Concurrency reservation (D30/D36/D37)
// ---------------------------------------------------------------------------

export const RESERVATION_STATES = [
	"reserved",
	"committed",
	"released",
	"expired",
	"orphan-suspect",
] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];

/** Capacity-occupying states (D30). */
export const CAPACITY_OCCUPYING_STATES: readonly ReservationState[] = [
	"reserved",
	"committed",
	"orphan-suspect",
];

/** slots ≡ 1 fixed in 0.3. */
export const RESERVATION_SLOTS = 1 as const;

// ---------------------------------------------------------------------------
// Error codes (P4)
// ---------------------------------------------------------------------------

export const TF_ERROR_CODES = [
	"TF_PROTOCOL_INCOMPATIBLE",
	"TF_SCHEMA_UNSUPPORTED",
	"TF_FEATURE_REQUIRED",
	"TF_POLICY_DENIED",
	"TF_AUTHORITY_REVOKED",
	"TF_STALE_VERSION",
	"TF_IDEMPOTENCY_CONFLICT",
	"TF_CROSS_PRINCIPAL_COMMAND",
	"TF_LEGACY_CONFLICT",
	"TF_PROVIDER_AMBIGUOUS",
	"TF_JOURNAL_UNAVAILABLE",
	"TF_DURABILITY_FAILED",
	"TF_CURSOR_EXPIRED",
	"TF_COMMAND_FAILED",
	"TF_BOOTSTRAP_FAILED",
	"TF_RECONCILE_REQUIRED",
	"TF_CAPACITY_EXCEEDED",
	"TF_NOT_FOUND",
	"TF_INVALID_ARGUMENT",
	/** Control domain identity mismatch (clone/worktree/copy of store). */
	"TF_IDENTITY_MISMATCH",
] as const;
export type TfErrorCode = (typeof TF_ERROR_CODES)[number];

export const RECOVERY_ACTIONS = [
	"retry-same-command",
	"retry-new-command",
	"refresh",
	"reconcile",
	"operator",
	"none",
] as const;
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

export const SIDE_EFFECT_LEVELS = ["none", "possible", "unknown"] as const;
export type SideEffectLevel = (typeof SIDE_EFFECT_LEVELS)[number];

export interface ControlError {
	code: TfErrorCode;
	message: string;
	recoveryAction: RecoveryAction;
	sideEffects: SideEffectLevel;
	commandId?: string;
	commitSeq?: number;
	controlDomainId?: string;
	projectId?: string;
}

/** TF_RECONCILE_REQUIRED is a normal snapshot flag, not a transport RPC failure (P4). */
export function reconcileRequiredError(
	message: string,
	ids?: { commandId?: string; projectId?: string; controlDomainId?: string },
): ControlError {
	return {
		code: "TF_RECONCILE_REQUIRED",
		message,
		recoveryAction: "operator",
		sideEffects: "unknown",
		...ids,
	};
}

// ---------------------------------------------------------------------------
// Identity & store header
// ---------------------------------------------------------------------------

export interface ControlStoreHeader {
	schemaVersion: number;
	projectId: string;
	controlDomainId: string;
	directoryBinding: DirectoryBinding;
	createdAt: number;
	updatedAt: number;
}

export interface DirectoryBinding {
	/** Absolute resolved project root path at registration. */
	path: string;
	/** Optional inode/device evidence for move detection (best-effort). */
	inode?: string;
	dev?: string;
}

export const CONTROL_STORE_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// CommandRecord / ControlEvent (D24)
// ---------------------------------------------------------------------------

export type CommandStatus = "queued" | "accepted" | "completed" | "failed" | "rejected";

/**
 * Durable project-side admission saga state. `queued` is intentionally a
 * command state rather than a synthetic Run: capacity rejection must retain a
 * retry identity without publishing a half-admitted execution.
 */
export const ADMISSION_INTENT_STATES = [
	"queued",
	"project-prepared",
	"slot-committed",
] as const;
export type AdmissionIntentState = (typeof ADMISSION_INTENT_STATES)[number];

/**
 * Stable identifiers shared by the project journal and coordinator. A retry
 * must reuse this record; it may not mint a second Run or reservation.
 */
export interface AdmissionIntent {
	schemaVersion: 1;
	admissionId: string;
	runId: string;
	continuationId: string;
	boundPlanHash: string;
	state: AdmissionIntentState;
	/** Present once the coordinator slot is durably reserved. */
	reservationId?: string;
	/**
	 * Monotonic project-journal version of the reservation binding. Zero is the
	 * initial prepare; every expiry recovery must append an explicit rebound
	 * record before it may bind a replacement coordinator reservation.
	 *
	 * Optional only for pre-recovery v1 journals. New writes always persist it.
	 */
	reservationGeneration?: number;
	createdAt: number;
	updatedAt: number;
}

export interface CommandRecord {
	commandId: string;
	requestHash: string;
	callerPrincipal: string;
	authorizationContextHash: string;
	projectId: string;
	controlDomainId: string;
	kind: string;
	status: CommandStatus;
	firstCommitSeq: number;
	lastCommitSeq: number;
	/** Run created by this command (idempotent disclosure key). */
	runId?: string;
	/** Present only for the P16 admission saga. */
	admission?: AdmissionIntent;
	responseArtifactRef?: string;
	recordedAt: number;
}

export interface ControlEvent {
	eventId: string;
	schemaVersion: number;
	controlDomainId: string;
	streamId: string;
	streamSeq: number;
	commitSeq: number;
	commandId?: string;
	commandEventIndex?: number;
	causationId?: string;
	correlationId?: string;
	projectId: string;
	recordedAt: number;
	payload: ControlEventPayload;
}

/**
 * Journal-derived cursor horizon. The checkpoint is part of the authoritative
 * event history; no separately writable cursor file may lower this floor.
 * Physical journal retention is a separate protocol and is deliberately not
 * implied by this state alone.
 */
export interface ControlCompactionState {
	/** Lowest cursor commit sequence accepted without a checkpoint resync. */
	minAvailableCommitSeq: number;
	/** Last authoritative journal commit sequence, including a checkpoint event. */
	maxCommitSeq: number;
	/** Commit sequence of the latest durable cursor checkpoint, when one exists. */
	lastCheckpointCommitSeq?: number;
	/** Recorded-at time of the latest checkpoint (or deterministic initial zero). */
	updatedAt: number;
}

export type ControlEventPayload =
	| { type: "AdmissionIntentRecorded"; commandId: string; admission: AdmissionIntent }
	| {
			type: "SlotReserved";
			runId: string;
			admissionId: string;
			reservationId: string;
			coordinatorEpoch: number;
			reservedExpiresAt: number;
	  }
	| {
			type: "AdmissionReservationRebound";
			runId: string;
			admissionId: string;
			fromReservationId: string;
			reservationId: string;
			reservationGeneration: number;
			coordinatorEpoch: number;
			reservedExpiresAt: number;
	  }
	| { type: "ProjectRunPrepared"; runId: string; admissionId: string; reservationId: string }
	| {
			type: "SlotCommitted";
			runId: string;
			admissionId: string;
			reservationId: string;
			projectAdmitCommitSeq: number;
	  }
	| { type: "RunReceived"; runId: string; boundPlanHash: string }
	| { type: "RunAdmitted"; runId: string; reservationId: string }
	| { type: "RunStatusChanged"; runId: string; status: RunStatus; stage: RunStage; reason?: string }
	| { type: "ReconcileStarted"; runId: string; attempt: number }
	| { type: "ReconcileSettled"; runId: string; outcome: "terminal" | "still-running" | "exhausted" }
	| { type: "NeedsOperator"; runId: string; code: "TF_RECONCILE_REQUIRED" }
	| { type: "ReceiptIssued"; runId: string; receiptId: string }
	| { type: "ApprovalParked"; runId: string; approvalRequestId: string }
	| { type: "ApprovalDecided"; runId: string; approvalRequestId: string; decision: string }
	/** Immutable plan snapshot used to reconstruct a parked run after restart. */
	| { type: "BoundPlanStored"; runId: string; boundPlan: BoundPlan }
	/** Latest durable scheduler cursor for a run. */
	| { type: "ContinuationStored"; continuation: RunContinuation }
	| {
			type: "AttemptPrepared";
			runId: string;
			continuationId: string;
			attempt: DurableDispatchAttempt;
	  }
	| {
			type: "DispatchIntentRecorded";
			runId: string;
			continuationId: string;
			attempt: DurableDispatchAttempt;
	  }
	| {
			type: "DispatchAcknowledged";
			runId: string;
			continuationId: string;
			attempt: DurableDispatchAttempt;
	  }
	| { type: "ApprovalRequestStored"; approval: ApprovalRequest }
	/**
	 * Durable logical cursor floor. `throughCommitSeq` is an already committed
	 * prefix; this checkpoint itself remains retained until a future physical
	 * compaction protocol proves a safe hash-chain handoff.
	 */
	| { type: "CompactionCheckpoint"; throughCommitSeq: number }
	| { type: "Generic"; kind: string; data?: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Run projection
// ---------------------------------------------------------------------------

export interface RunProjection {
	runId: string;
	projectId: string;
	controlDomainId: string;
	status: RunStatus;
	stage: RunStage;
	boundPlanHash: string;
	boundFragmentHash?: string;
	/** True when auto-reconcile exhausted; wait returns TF_RECONCILE_REQUIRED. */
	needsOperator: boolean;
	/** Stable P16 admission-saga identity, if this run was admitted through it. */
	admissionId?: string;
	reservationId?: string;
	createdAt: number;
	updatedAt: number;
	finalOutput?: string;
	receiptId?: string;
	/** Version for CAS (approval/cancel races). */
	runVersion: number;
	error?: string;
	approvalRequestId?: string;
	/** Durable provider job handle (persisted for restart reconcile). */
	providerHandle?: string;
	/** Provider lease/epoch at submit time. */
	providerLeaseEpoch?: number;
	providerName?: string;
	/**
	 * Durable cancel ownership. A non-terminal cancellation is never inferred
	 * from an in-memory signal: the command and its external-call boundary are
	 * journaled before a provider may be touched.
	 */
	cancelRequest?: DurableCancelRequest;
	/** Journaled scheduler cursor for a native durable continuation (P15). */
	continuationId?: string;
}

// ---------------------------------------------------------------------------
// Durable scheduler continuation / approval records (P15)
// ---------------------------------------------------------------------------

export const DURABLE_PHASE_ATTEMPT_STATUSES = [
	"completed",
	"failed",
	"skipped",
	"still-running",
] as const;
export type DurablePhaseAttemptStatus = (typeof DURABLE_PHASE_ATTEMPT_STATUSES)[number];

/** A settled phase cursor. Its output is replayed, never re-executed, on resume. */
export interface DurablePhaseAttempt {
	phaseId: string;
	type: string;
	status: DurablePhaseAttemptStatus;
	attemptId: string;
	output?: string;
	error?: string;
	providerName?: string;
	handle?: string;
}

export const DURABLE_DISPATCH_STATES = [
	"prepared",
	"intent-recorded",
	"acknowledged",
	"ambiguous",
] as const;
export type DurableDispatchState = (typeof DURABLE_DISPATCH_STATES)[number];

/**
 * Stable identity for an externally dispatched phase. Reusing the same
 * idempotencyKey after a crash is the only permitted retry of this attempt.
 */
export interface DurableDispatchAttempt {
	attemptId: string;
	phaseId: string;
	type: string;
	idempotencyKey: string;
	providerName: string;
	state: DurableDispatchState;
	providerHandle?: string;
	createdAt: number;
	updatedAt: number;
}

// There is deliberately no terminal `cancelled` state in 0.3.0. Current
// providers cannot supply a durable, command-bound containment proof, so a
// cancellation request remains reconciling until an explicit future protocol
// can establish that proof.
export const DURABLE_CANCEL_STATES = ["requested", "signalling", "ambiguous"] as const;
export type DurableCancelState = (typeof DURABLE_CANCEL_STATES)[number];

/**
 * One cancel command's durable ownership and provider boundary. `signalling`
 * means the provider call may already have happened, so retries must reconcile
 * rather than emit another signal. `ambiguous` retains capacity and requires a
 * provider observation or operator action.
 */
export interface DurableCancelRequest {
	commandId: string;
	requestHash: string;
	principal: string;
	state: DurableCancelState;
	providerHandle?: string;
	providerName?: string;
	/**
	 * Immutable route identity captured with CancelRequested. A later host must
	 * never reinterpret an opaque handle through whichever provider is currently
	 * convenient: all six fields must still match the live continuation before a
	 * provider cancellation side effect is allowed.
	 *
	 * Older journals legitimately lack these fields. They remain readable but
	 * fail closed to reconciliation rather than being re-signalled.
	 */
	continuationId?: string;
	continuationVersion?: number;
	attemptId?: string;
	phaseId?: string;
	fencingEpoch?: number;
	requestedAt: number;
	updatedAt: number;
}

export const CONTINUATION_STATUSES = ["active", "parked", "approved", "terminal"] as const;
export type ContinuationStatus = (typeof CONTINUATION_STATUSES)[number];

/**
 * Immutable-plan scheduler checkpoint. It is journaled with every cursor
 * advance, so a restarted host can resume downstream work without replaying
 * completed side effects.
 */
export interface RunContinuation {
	schemaVersion: 1;
	continuationId: string;
	runId: string;
	projectId: string;
	controlDomainId: string;
	boundPlanHash: string;
	status: ContinuationStatus;
	/** First phase not durably settled; omitted only after terminal settlement. */
	nextPhaseId?: string;
	phaseAttempts: DurablePhaseAttempt[];
	phaseOutputs: Record<string, string>;
	/** Current provider dispatch, if any, retained across crash windows. */
	activeAttempt?: DurableDispatchAttempt;
	/** Native approval phase currently holding this continuation parked. */
	approvalPhaseId?: string;
	approvalRequestId?: string;
	createdAt: number;
	updatedAt: number;
	version: number;
}

export type ApprovalDecision = "approve" | "reject" | "edit";
export type ApprovalRequestStatus =
	| "pending"
	| "approved"
	| "rejected"
	| "edited"
	| "expired"
	| "cancelled";

/**
 * Project-ledger authority record. Legacy side files may mirror older parked
 * flows, but a native continuation uses this journaled representation.
 */
export interface ApprovalRequest {
	approvalRequestId: string;
	runId: string;
	projectId: string;
	controlDomainId: string;
	status: ApprovalRequestStatus;
	allowedDecisions: ApprovalDecision[];
	createdAt: number;
	deadline?: number;
	decidedAt?: number;
	decision?: ApprovalDecision;
	decisionCommandId?: string;
	deciderPrincipal?: string;
	/** RunVersion at park time for CAS. */
	expectedRunVersion: number;
	note?: string;
	continuationId?: string;
	phaseId?: string;
	message?: string;
}

// ---------------------------------------------------------------------------
// Receipt (immutable once issued)
// ---------------------------------------------------------------------------

export interface Receipt {
	receiptId: string;
	controlDomainId: string;
	projectId: string;
	runId: string;
	boundPlanHash: string;
	boundFragmentHash?: string;
	eventManifest: string[];
	startCommitSeq: number;
	endCommitSeq: number;
	artifactRefs: string[];
	assurance: {
		journalContinuity: "ok" | "unknown";
		providerOutcome: "ok" | "failed" | "cancelled" | "unknown";
		artifactIntegrity: "ok" | "unknown";
		provenance: "ok" | "unknown";
	};
	buildInfo: { packageVersion: string; controlSchemaVersion: number };
	issuedAt: number;
}

// ---------------------------------------------------------------------------
// BoundPlan (immutable template after Link)
// ---------------------------------------------------------------------------

export interface BoundPlan {
	boundPlanHash: string;
	executionSemanticHash: string;
	programName: string;
	/** In-memory E-1 route identity; schema-1 persistence deliberately omits it. */
	providerClass?: string;
	/** Desugared Taskflow JSON (immutable snapshot). */
	program: unknown;
	/** FlowIR hash when available (ir:<64-hex>). */
	irHash?: string;
	createdAt: number;
	approvalMode: ApprovalMode;
	grantRefs: string[];
}

/**
 * Dynamic IR after expand/graft (P7). Dual hashes — never restore promotedPhases
 * without re-Link / authority + executionSemanticHash equality.
 */
export interface BoundFragment {
	boundFragmentHash: string;
	executionSemanticHash: string;
	/** Nested/grafted program fragment (immutable snapshot). */
	fragment: unknown;
	parentBoundPlanHash?: string;
	createdAt: number;
}

// ---------------------------------------------------------------------------
// Concurrency reservation record
// ---------------------------------------------------------------------------

export interface ConcurrencyReservation {
	reservationId: string;
	state: ReservationState;
	/** Fixed 1 in 0.3. */
	slots: typeof RESERVATION_SLOTS;
	/** Stable project admission identity while this slot participates in a saga. */
	admissionId?: string;
	projectId?: string;
	projectControlDomainId?: string;
	runId?: string;
	projectAdmitCommitSeq?: number;
	attemptId?: string;
	providerJobHandle?: string;
	coordinatorEpoch: number;
	reservedExpiresAt?: number;
	renewedAt?: number;
	createdAt: number;
	updatedAt: number;
	/** Set when force-released via CoordinatorCommandRecord. */
	operatorOverridden?: boolean;
}

export type CoordinatorCommandKind = "setMaxActiveRuns" | "forceRelease";

export interface CoordinatorCommandRecord {
	commandId: string;
	requestHash: string;
	callerPrincipal: string;
	kind: CoordinatorCommandKind;
	firstCommitSeq: number;
	lastCommitSeq: number;
	status: CommandStatus;
	/** Payload for the command (maxActiveRuns value or reservationId). */
	payload: Record<string, unknown>;
	recordedAt: number;
}

export interface CoordinatorLease {
	holderId: string;
	fencingEpoch: number;
	endpoint: string;
	expiresAt: number;
}

// ---------------------------------------------------------------------------
// TypeBox schemas (wire freeze surface)
// ---------------------------------------------------------------------------

export const RunStatusSchema = Type.Union(RUN_STATUSES.map((s) => Type.Literal(s)));
export const RunStageSchema = Type.Union(RUN_STAGES.map((s) => Type.Literal(s)));
export const ControlModeSchema = Type.Union(CONTROL_MODES.map((s) => Type.Literal(s)));
export const ApprovalModeSchema = Type.Union(APPROVAL_MODES.map((s) => Type.Literal(s)));

export const ControlErrorSchema = Type.Object({
	code: Type.Union(TF_ERROR_CODES.map((c) => Type.Literal(c))),
	message: Type.String(),
	recoveryAction: Type.Union(RECOVERY_ACTIONS.map((a) => Type.Literal(a))),
	sideEffects: Type.Union(SIDE_EFFECT_LEVELS.map((s) => Type.Literal(s))),
	commandId: Type.Optional(Type.String()),
	commitSeq: Type.Optional(Type.Number()),
	controlDomainId: Type.Optional(Type.String()),
	projectId: Type.Optional(Type.String()),
});
export type ControlErrorStatic = Static<typeof ControlErrorSchema>;
