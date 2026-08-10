/**
 * 0.3 control-plane wire types (TypeBox + TypeScript).
 *
 * Frozen after P1–P17 ADRs. See docs/internal/rfc-0.3.0-control-plane.md §8–§18
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

export const FORCE_RELEASE_ACKNOWLEDGEMENT =
	"I understand this may allow overlapping live side effects" as const;

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

export type CommandStatus = "accepted" | "completed" | "failed" | "rejected";

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

export type ControlEventPayload =
	| { type: "RunReceived"; runId: string; boundPlanHash: string }
	| { type: "RunAdmitted"; runId: string; reservationId: string }
	| { type: "RunStatusChanged"; runId: string; status: RunStatus; stage: RunStage; reason?: string }
	| { type: "ReconcileStarted"; runId: string; attempt: number }
	| { type: "ReconcileSettled"; runId: string; outcome: "terminal" | "still-running" | "exhausted" }
	| { type: "NeedsOperator"; runId: string; code: "TF_RECONCILE_REQUIRED" }
	| { type: "ReceiptIssued"; runId: string; receiptId: string }
	| { type: "ApprovalParked"; runId: string; approvalRequestId: string }
	| { type: "ApprovalDecided"; runId: string; approvalRequestId: string; decision: string }
	| { type: "CancelRequested"; runId: string }
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
	reservationId?: string;
	createdAt: number;
	updatedAt: number;
	finalOutput?: string;
	receiptId?: string;
	/** Version for CAS (approval/cancel races). */
	runVersion: number;
	error?: string;
	approvalRequestId?: string;
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
	/** Desugared Taskflow JSON (immutable snapshot). */
	program: unknown;
	/** FlowIR hash when available (ir:<64-hex>). */
	irHash?: string;
	createdAt: number;
	approvalMode: ApprovalMode;
	grantRefs: string[];
}

// ---------------------------------------------------------------------------
// Concurrency reservation record
// ---------------------------------------------------------------------------

export interface ConcurrencyReservation {
	reservationId: string;
	/** Monotonic CAS revision; migrated legacy records start at 1. */
	revision: number;
	state: ReservationState;
	/** Fixed 1 in 0.3. */
	slots: typeof RESERVATION_SLOTS;
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

export interface ForceReleaseRequest {
	reservationId: string;
	expectedState: "committed" | "orphan-suspect";
	expectedRevision: number;
	expectedCoordinatorEpoch: number;
	expectedProjectId: string;
	expectedRunId: string;
	acknowledgement: typeof FORCE_RELEASE_ACKNOWLEDGEMENT;
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
