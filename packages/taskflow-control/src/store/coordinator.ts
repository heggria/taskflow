/**
 * UserCoordinatorStore — singleton lease + concurrency reservations +
 * CoordinatorCommandRecord (D6 / D30 / D36 / D37 / P16).
 *
 * Capacity: count(reserved|committed|orphan-suspect) ≤ maxActiveRuns
 * slots ≡ 1 per admitted Run.
 * committed / orphan-suspect release ONLY via D37 normalRelease / forceRelease.
 *
 * All mutations run under exclusive state.lock with load→mutate→save inside
 * the critical section (cross-process safe; no last-writer-wins loss).
 */
import * as path from "node:path";
import {
	CAPACITY_OCCUPYING_STATES,
	RESERVATION_SLOTS,
	RESERVATION_STATES,
	type ConcurrencyReservation,
	type CoordinatorCommandRecord,
	type CoordinatorLease,
	type ReservationState,
} from "../types.ts";
import { hashRequest, newId } from "../hash.ts";
import {
	SingletonAuthorityError,
	singletonMutationAuthorityEpoch,
	withSingletonMutationAuthority,
	type SingletonMutationAuthority,
} from "../singleton.ts";
import {
	assertNoSymbolicLinkBelow,
	coordinatorDir,
	ControlStoreDurabilityError,
	readJsonFileStrict,
	userHome,
	withExclusiveLockFile,
	writeFileAtomic,
} from "../paths.ts";
import { isSafeId } from "../validate-ids.ts";

const DEFAULT_MAX_ACTIVE_RUNS = 4;
const RESERVED_TTL_MS = 60_000;
/** A caller may shorten an unbound lease, never turn it into a long-lived slot. */
const MAX_RESERVED_TTL_MS = RESERVED_TTL_MS;
const COORDINATOR_STATE_SCHEMA_VERSION = 2;
const COORDINATOR_STATE_ANCHOR_SCHEMA_VERSION = 1;
const REQUEST_HASH = /^[a-f0-9]{64}$/;
const MAX_CALLER_PRINCIPAL_LENGTH = 1_024;
const MAX_FORCE_RELEASE_REASON_LENGTH = 4_096;

/**
 * Store-owned clock. Production always uses wall time.
 * No injectable clock is exported from this module or the package barrel —
 * callers cannot forge TTL via open options or reclaim timestamps.
 * Tests simulate expiry by elapsing reservedExpiresAt on disk and calling the
 * production reclaim/commit path with no caller timestamp.
 */
interface CoordinatorClock {
	now(): number;
}

const WALL_CLOCK: CoordinatorClock = { now: () => Date.now() };

/**
 * Logical admission (projectId + projectControlDomainId + runId) is unique among
 * capacity-occupying committed/orphan-suspect reservations under state.lock.
 */
export class CoordinatorAdmissionConflictError extends Error {
	readonly code = "TF_ADMISSION_BINDING_CONFLICT" as const;
	readonly existingReservationId: string;
	readonly attemptedReservationId: string;

	constructor(opts: {
		existingReservationId: string;
		attemptedReservationId: string;
		projectId: string;
		projectControlDomainId: string;
		runId: string;
	}) {
		super(
			`TF_ADMISSION_BINDING_CONFLICT: logical admission ` +
				`projectId=${opts.projectId} projectControlDomainId=${opts.projectControlDomainId} ` +
				`runId=${opts.runId} is already bound to reservation ${opts.existingReservationId}; ` +
				`cannot commit reservation ${opts.attemptedReservationId}`,
		);
		this.name = "CoordinatorAdmissionConflictError";
		this.existingReservationId = opts.existingReservationId;
		this.attemptedReservationId = opts.attemptedReservationId;
	}
}

export interface ReleaseContext {
	/** Provider/isolation proves no live process tree AND no open ambiguous job. */
	noLiveOrAmbiguousSideEffects: boolean;
	runIsTerminal: boolean;
	runIsParkedAndFutureDispatchRequiresReadmission: boolean;
	/**
	 * Optional coordinator-local ownership binding for D37 normalRelease.
	 * When present it must match the durable project admission binding.
	 * Host-side mandatory ownership binding is owned by another lane; this store
	 * only enforces the match when the field is supplied.
	 */
	ownership?: {
		projectId: string;
		projectControlDomainId: string;
		runId: string;
		projectAdmitCommitSeq: number;
	};
}

interface CoordinatorReservationBinding {
	projectId: string;
	projectControlDomainId: string;
	runId: string;
	projectAdmitCommitSeq: number;
	/** Required when the reservation was created by the P16 admission saga. */
	admissionId?: string;
}

/** D37 normalRelease predicate. */
export function canNormalRelease(ctx: ReleaseContext): boolean {
	if (!ctx.noLiveOrAmbiguousSideEffects) return false;
	return ctx.runIsTerminal || ctx.runIsParkedAndFutureDispatchRequiresReadmission;
}

/** Durable uniqueness key: projectId + projectControlDomainId + runId. */
function admissionBindingKey(
	binding: Pick<ConcurrencyReservation, "projectId" | "projectControlDomainId" | "runId">,
): string | null {
	if (
		binding.projectId === undefined ||
		binding.projectControlDomainId === undefined ||
		binding.runId === undefined
	) {
		return null;
	}
	// Separator cannot appear in safe stored ids (no `/`).
	return `${binding.projectId}/${binding.projectControlDomainId}/${binding.runId}`;
}

function ownershipEquals(
	reservation: ConcurrencyReservation,
	ownership: NonNullable<ReleaseContext["ownership"]>,
): boolean {
	return (
		reservation.projectId === ownership.projectId &&
		reservation.projectControlDomainId === ownership.projectControlDomainId &&
		reservation.runId === ownership.runId &&
		reservation.projectAdmitCommitSeq === ownership.projectAdmitCommitSeq
	);
}

export interface UserCoordinatorStore {
	readonly maxActiveRuns: number;
	getLease(): CoordinatorLease | null;
	setLease(lease: CoordinatorLease): void;
	/** Count of capacity-occupying reservations. */
	occupyingCount(): number;
	listReservations(): ConcurrencyReservation[];
	getReservation(id: string): ConcurrencyReservation | null;
	/**
	 * Reserve one slot (slots≡1). Returns null if capacity exceeded.
	 * reserved is TTL-reclaimable.
	 */
	reserve(opts?: { ttlMs?: number; admissionId?: string }): ConcurrencyReservation | null;
	/**
	 * Release a reservation that was never bound to any Run. This is the only
	 * safe loser path before project admission; it is not a D37 release of an
	 * admitted/ambiguous run.
	 */
	releaseUnboundReservation(reservationId: string): ConcurrencyReservation;
	/** After Run Admitted + projectAdmitCommitSeq → committed (no TTL release). */
	commitReservation(
		reservationId: string,
		binding: CoordinatorReservationBinding,
	): ConcurrencyReservation;
	/** Mark orphan-suspect (reconcile exhaustion) — still occupies capacity. */
	markOrphanSuspect(reservationId: string): ConcurrencyReservation;
	/**
	 * D37 normalRelease — only when predicates hold.
	 * Throws if predicates fail (does not silently release).
	 */
	normalRelease(reservationId: string, ctx: ReleaseContext): ConcurrencyReservation;
	/**
	 * D37 forceRelease — only via CoordinatorCommandRecord.
	 * Marks operator-overridden.
	 */
	/**
	 * D37 forceRelease — requires authorized principal + explicit riskAcknowledged:true.
	 * Idempotent: same commandId returns prior command without re-mutating if already applied.
	 */
	forceRelease(
		reservationId: string,
		cmd: {
			commandId: string;
			callerPrincipal: string;
			requestBody: { reservationId: string; riskAcknowledged: boolean; reason?: string };
		},
	): { reservation: ConcurrencyReservation; command: CoordinatorCommandRecord };
	setMaxActiveRuns(
		value: number,
		cmd: { commandId: string; callerPrincipal: string; requestBody: unknown },
	): CoordinatorCommandRecord;
	/**
	 * Reclaim expired reserved (not committed) slots using store clock authority.
	 * Callers cannot pass a forgeable timestamp; the optional `now` argument is
	 * retained only for signature compatibility and is always refused.
	 */
	reclaimExpiredReserved(now?: number): number;
	getCommand(commandId: string): CoordinatorCommandRecord | null;
}

interface CoordinatorFile {
	/**
	 * v1 is a pre-anchor state accepted only for an explicit on-write migration.
	 * v2 must be paired with the durable anchor below; losing either file is an
	 * integrity failure, never a reason to reset capacity.
	 */
	schemaVersion: 1 | typeof COORDINATOR_STATE_SCHEMA_VERSION;
	coordinatorId?: string;
	maxActiveRuns: number;
	lease: CoordinatorLease | null;
	reservations: ConcurrencyReservation[];
	commands: CoordinatorCommandRecord[];
	nextCommandSeq: number;
}

interface CoordinatorStateAnchor {
	schemaVersion: typeof COORDINATOR_STATE_ANCHOR_SCHEMA_VERSION;
	coordinatorId: string;
	createdAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNonBlankString(value: unknown): value is string {
	return isNonEmptyString(value) && value.trim().length > 0;
}

function isSafeIdentifier(value: unknown): value is string {
	return typeof value === "string" && isSafeId(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return isNonNegativeSafeInteger(value) && value >= 1;
}

function failCoordinatorDurability(message: string, filePath: string): never {
	throw new ControlStoreDurabilityError(`Coordinator state: ${message}`, filePath);
}

function failInvalidArgument(message: string): never {
	throw new Error(`TF_INVALID_ARGUMENT: ${message}`);
}

function assertSafeIdentifier(value: unknown, label: string): asserts value is string {
	if (!isSafeIdentifier(value)) failInvalidArgument(`unsafe ${label}`);
}

function assertNonBlankText(
	value: unknown,
	label: string,
	maxLength = MAX_CALLER_PRINCIPAL_LENGTH,
): asserts value is string {
	if (!isNonBlankString(value) || value.length > maxLength) {
		failInvalidArgument(`invalid ${label}`);
	}
}

function assertNoUnexpectedKeys(
	value: unknown,
	allowed: readonly string[],
	label: string,
): asserts value is Record<string, unknown> {
	if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
		failInvalidArgument(`invalid ${label}`);
	}
}

function normalizeReservationBinding(value: unknown): CoordinatorReservationBinding {
	assertNoUnexpectedKeys(
		value,
		["projectId", "projectControlDomainId", "runId", "projectAdmitCommitSeq", "admissionId"],
		"reservation binding",
	);
	assertSafeIdentifier(value.projectId, "projectId");
	assertSafeIdentifier(value.projectControlDomainId, "projectControlDomainId");
	assertSafeIdentifier(value.runId, "runId");
	if (!isPositiveSafeInteger(value.projectAdmitCommitSeq)) {
		failInvalidArgument("invalid projectAdmitCommitSeq");
	}
	if (value.admissionId !== undefined) assertSafeIdentifier(value.admissionId, "admissionId");
	return {
		projectId: value.projectId,
		projectControlDomainId: value.projectControlDomainId,
		runId: value.runId,
		projectAdmitCommitSeq: value.projectAdmitCommitSeq,
		...(value.admissionId === undefined ? {} : { admissionId: value.admissionId }),
	};
}

function normalizeCoordinatorLease(value: unknown): CoordinatorLease {
	assertNoUnexpectedKeys(value, ["holderId", "fencingEpoch", "endpoint", "expiresAt"], "lease");
	assertNonBlankText(value.holderId, "lease holderId");
	assertNonBlankText(value.endpoint, "lease endpoint", MAX_FORCE_RELEASE_REASON_LENGTH);
	if (!isNonNegativeSafeInteger(value.fencingEpoch) || !isNonNegativeSafeInteger(value.expiresAt)) {
		failInvalidArgument("invalid lease epoch or expiry");
	}
	return {
		holderId: value.holderId,
		fencingEpoch: value.fencingEpoch,
		endpoint: value.endpoint,
		expiresAt: value.expiresAt,
	};
}

function normalizeReserveOptions(value: unknown): { ttlMs: number; admissionId?: string } {
	const options = value ?? {};
	assertNoUnexpectedKeys(options, ["ttlMs", "admissionId"], "reserve options");
	const ttlMs = options.ttlMs === undefined ? RESERVED_TTL_MS : options.ttlMs;
	if (!isPositiveSafeInteger(ttlMs)) failInvalidArgument("invalid reservation ttlMs");
	if (ttlMs > MAX_RESERVED_TTL_MS) failInvalidArgument("reservation ttlMs exceeds maximum");
	if (options.admissionId !== undefined) assertSafeIdentifier(options.admissionId, "admissionId");
	return {
		ttlMs,
		...(options.admissionId === undefined ? {} : { admissionId: options.admissionId }),
	};
}

function assertReleaseContext(value: unknown): asserts value is ReleaseContext {
	assertNoUnexpectedKeys(
		value,
		[
			"noLiveOrAmbiguousSideEffects",
			"runIsTerminal",
			"runIsParkedAndFutureDispatchRequiresReadmission",
			"ownership",
		],
		"release context",
	);
	if (
		typeof value.noLiveOrAmbiguousSideEffects !== "boolean" ||
		typeof value.runIsTerminal !== "boolean" ||
		typeof value.runIsParkedAndFutureDispatchRequiresReadmission !== "boolean"
	) {
		failInvalidArgument("invalid release context");
	}
	if (value.ownership !== undefined) {
		assertNoUnexpectedKeys(
			value.ownership,
			["projectId", "projectControlDomainId", "runId", "projectAdmitCommitSeq"],
			"release ownership",
		);
		assertSafeIdentifier(value.ownership.projectId, "ownership.projectId");
		assertSafeIdentifier(value.ownership.projectControlDomainId, "ownership.projectControlDomainId");
		assertSafeIdentifier(value.ownership.runId, "ownership.runId");
		if (!isPositiveSafeInteger(value.ownership.projectAdmitCommitSeq)) {
			failInvalidArgument("invalid ownership.projectAdmitCommitSeq");
		}
	}
}

interface NormalizedCoordinatorCommand {
	commandId: string;
	callerPrincipal: string;
	requestHash: string;
}

interface NormalizedForceReleaseCommand extends NormalizedCoordinatorCommand {
	requestBody: { reservationId: string; riskAcknowledged: true; reason?: string };
}

function normalizeSetMaxCommand(
	value: unknown,
	cmd: unknown,
): NormalizedCoordinatorCommand {
	if (!isPositiveSafeInteger(value)) failInvalidArgument("invalid maxActiveRuns");
	assertNoUnexpectedKeys(cmd, ["commandId", "callerPrincipal", "requestBody"], "set capacity command");
	assertSafeIdentifier(cmd.commandId, "commandId");
	assertNonBlankText(cmd.callerPrincipal, "callerPrincipal");
	assertNoUnexpectedKeys(cmd.requestBody, ["maxActiveRuns"], "set capacity requestBody");
	if (cmd.requestBody.maxActiveRuns !== value) {
		failInvalidArgument("set capacity requestBody.maxActiveRuns must match value");
	}
	return {
		commandId: cmd.commandId,
		callerPrincipal: cmd.callerPrincipal,
		requestHash: hashRequest({ maxActiveRuns: value }),
	};
}

function normalizeForceReleaseCommand(
	reservationId: unknown,
	cmd: unknown,
): NormalizedForceReleaseCommand {
	assertSafeIdentifier(reservationId, "reservationId");
	assertNoUnexpectedKeys(cmd, ["commandId", "callerPrincipal", "requestBody"], "force release command");
	assertSafeIdentifier(cmd.commandId, "commandId");
	assertNonBlankText(cmd.callerPrincipal, "callerPrincipal");
	assertNoUnexpectedKeys(cmd.requestBody, ["reservationId", "riskAcknowledged", "reason"], "force release requestBody");
	if (cmd.requestBody.reservationId !== reservationId) {
		failInvalidArgument("forceRelease requestBody.reservationId must match argument");
	}
	if (cmd.requestBody.riskAcknowledged !== true) {
		failInvalidArgument("forceRelease requires requestBody.riskAcknowledged === true");
	}
	if (
		cmd.requestBody.reason !== undefined &&
		(typeof cmd.requestBody.reason !== "string" ||
			cmd.requestBody.reason.length > MAX_FORCE_RELEASE_REASON_LENGTH)
	) {
		failInvalidArgument("invalid forceRelease reason");
	}
	const requestBody =
		cmd.requestBody.reason === undefined
			? { reservationId, riskAcknowledged: true as const }
			: {
					reservationId,
					riskAcknowledged: true as const,
					reason: cmd.requestBody.reason,
				};
	return {
		commandId: cmd.commandId,
		callerPrincipal: cmd.callerPrincipal,
		requestHash: hashRequest(requestBody),
		requestBody,
	};
}

function assertMatchingPriorCommand(
	prior: CoordinatorCommandRecord,
	expected: NormalizedCoordinatorCommand,
	kind: CoordinatorCommandRecord["kind"],
): void {
	if (prior.kind !== kind) {
		throw new Error(`TF_IDEMPOTENCY_CONFLICT: commandId ${expected.commandId} already used for ${prior.kind}`);
	}
	if (prior.callerPrincipal !== expected.callerPrincipal) {
		throw new Error(`TF_CROSS_PRINCIPAL_COMMAND: commandId ${expected.commandId}`);
	}
	if (prior.requestHash !== expected.requestHash) {
		throw new Error(`TF_IDEMPOTENCY_CONFLICT: commandId ${expected.commandId}`);
	}
}

function validateReservation(value: unknown, filePath: string): void {
	if (
		!isRecord(value) ||
		!isSafeIdentifier(value.reservationId) ||
		!(RESERVATION_STATES as readonly string[]).includes(String(value.state)) ||
		value.slots !== RESERVATION_SLOTS ||
		(value.admissionId !== undefined && !isSafeIdentifier(value.admissionId)) ||
		!isNonNegativeSafeInteger(value.coordinatorEpoch) ||
		!isNonNegativeSafeInteger(value.createdAt) ||
		!isNonNegativeSafeInteger(value.updatedAt) ||
		value.updatedAt < value.createdAt ||
		(value.renewedAt !== undefined &&
			(!isNonNegativeSafeInteger(value.renewedAt) ||
				value.renewedAt < value.createdAt ||
				value.renewedAt > value.updatedAt)) ||
		(value.reservedExpiresAt !== undefined && !isNonNegativeSafeInteger(value.reservedExpiresAt)) ||
		(value.projectId !== undefined && !isSafeIdentifier(value.projectId)) ||
		(value.projectControlDomainId !== undefined && !isSafeIdentifier(value.projectControlDomainId)) ||
		(value.runId !== undefined && !isSafeIdentifier(value.runId)) ||
		(value.projectAdmitCommitSeq !== undefined && !isPositiveSafeInteger(value.projectAdmitCommitSeq)) ||
		(value.attemptId !== undefined && !isSafeIdentifier(value.attemptId)) ||
		(value.providerJobHandle !== undefined && !isNonEmptyString(value.providerJobHandle)) ||
		(value.operatorOverridden !== undefined && value.operatorOverridden !== true)
	) {
		failCoordinatorDurability("state.json has an invalid reservation", filePath);
	}

	const hasCompleteProjectBinding =
		value.projectId !== undefined &&
		value.projectControlDomainId !== undefined &&
		value.runId !== undefined &&
		value.projectAdmitCommitSeq !== undefined;
	const hasNoProjectBinding =
		value.projectId === undefined &&
		value.projectControlDomainId === undefined &&
		value.runId === undefined &&
		value.projectAdmitCommitSeq === undefined;
	const hasExecutionBinding =
		value.attemptId !== undefined || value.providerJobHandle !== undefined;
	if ((!hasCompleteProjectBinding && !hasNoProjectBinding) || (hasExecutionBinding && !hasCompleteProjectBinding)) {
		failCoordinatorDurability("state.json has a partial reservation binding", filePath);
	}

	switch (value.state) {
		case "reserved":
			if (!hasNoProjectBinding || hasExecutionBinding || value.reservedExpiresAt === undefined) {
				failCoordinatorDurability("reserved capacity is not an unbound TTL lease", filePath);
			}
			break;
		case "committed":
		case "orphan-suspect":
			if (!hasCompleteProjectBinding || value.reservedExpiresAt !== undefined) {
				failCoordinatorDurability("committed capacity lacks an immutable project admission binding", filePath);
			}
			break;
		case "expired":
			if (
				!hasNoProjectBinding ||
				hasExecutionBinding ||
				value.reservedExpiresAt === undefined ||
				value.reservedExpiresAt > value.updatedAt
			) {
				failCoordinatorDurability("expired capacity is not an expired unbound TTL lease", filePath);
			}
			break;
		case "released":
			// Older coordinator files left the harmless historical TTL field after
			// releasing an unbound reservation. It carries no occupancy authority,
			// so preserve read compatibility while new transitions clear it.
			break;
	}
	if (value.operatorOverridden === true && value.state !== "released") {
		failCoordinatorDurability("operator override is not a released reservation", filePath);
	}
}

function validateCoordinatorCommand(
	value: unknown,
	filePath: string,
	expectedSeq: number,
	reservationById: ReadonlyMap<string, unknown>,
): void {
	if (
		!isRecord(value) ||
		!isSafeIdentifier(value.commandId) ||
		!isNonBlankString(value.callerPrincipal) ||
		value.callerPrincipal.length > MAX_CALLER_PRINCIPAL_LENGTH ||
		!isNonEmptyString(value.requestHash) ||
		!REQUEST_HASH.test(value.requestHash) ||
		(value.kind !== "setMaxActiveRuns" && value.kind !== "forceRelease") ||
		value.status !== "completed" ||
		value.firstCommitSeq !== expectedSeq ||
		value.lastCommitSeq !== expectedSeq ||
		!isNonNegativeSafeInteger(value.recordedAt) ||
		!isRecord(value.payload)
	) {
		failCoordinatorDurability("state.json has an invalid command record", filePath);
	}
	if (value.kind === "setMaxActiveRuns") {
		if (
			Object.keys(value.payload).length !== 1 ||
			!isPositiveSafeInteger(value.payload.maxActiveRuns)
		) {
			failCoordinatorDurability("state.json has an invalid set-capacity command payload", filePath);
		}
		if (value.requestHash !== hashRequest({ maxActiveRuns: value.payload.maxActiveRuns })) {
			failCoordinatorDurability("state.json set-capacity command hash does not match its payload", filePath);
		}
		return;
	}

	if (
		Object.keys(value.payload).length !== 3 ||
		!isSafeIdentifier(value.payload.reservationId) ||
		value.payload.riskAcknowledged !== true ||
		(value.payload.reason !== null &&
			(typeof value.payload.reason !== "string" ||
				value.payload.reason.length > MAX_FORCE_RELEASE_REASON_LENGTH))
	) {
		failCoordinatorDurability("state.json has an invalid force-release command payload", filePath);
	}
	const forceReleaseRequest =
		value.payload.reason === null
			? { reservationId: value.payload.reservationId, riskAcknowledged: true }
			: {
					reservationId: value.payload.reservationId,
					riskAcknowledged: true,
					reason: value.payload.reason,
				};
	if (value.requestHash !== hashRequest(forceReleaseRequest)) {
		failCoordinatorDurability("state.json force-release command hash does not match its payload", filePath);
	}
	const reservation = reservationById.get(value.payload.reservationId);
	if (
		!isRecord(reservation) ||
		reservation.state !== "released" ||
		reservation.operatorOverridden !== true
	) {
		failCoordinatorDurability(
			"force-release command does not link to an overridden released reservation",
			filePath,
		);
	}
}

function validateCoordinatorFile(value: unknown, filePath: string): CoordinatorFile {
	if (!isRecord(value)) failCoordinatorDurability("state.json must be a JSON object", filePath);
	if (
		(value.schemaVersion !== 1 && value.schemaVersion !== COORDINATOR_STATE_SCHEMA_VERSION) ||
		(value.schemaVersion === COORDINATOR_STATE_SCHEMA_VERSION &&
			!isSafeIdentifier(value.coordinatorId)) ||
		!isNonNegativeSafeInteger(value.maxActiveRuns) ||
		value.maxActiveRuns < 1 ||
		!Array.isArray(value.reservations) ||
		!Array.isArray(value.commands) ||
		!isNonNegativeSafeInteger(value.nextCommandSeq) ||
		value.nextCommandSeq < 1
	) {
		failCoordinatorDurability("state.json has an invalid capacity or collection shape", filePath);
	}
	if (
		value.lease !== null &&
		(!isRecord(value.lease) ||
			!isNonBlankString(value.lease.holderId) ||
			value.lease.holderId.length > MAX_CALLER_PRINCIPAL_LENGTH ||
			!isNonNegativeSafeInteger(value.lease.fencingEpoch) ||
			!isNonBlankString(value.lease.endpoint) ||
			value.lease.endpoint.length > MAX_FORCE_RELEASE_REASON_LENGTH ||
			!isNonNegativeSafeInteger(value.lease.expiresAt))
	) {
		failCoordinatorDurability("state.json has an invalid coordinator lease", filePath);
	}
	const reservationIds = new Set<string>();
	const reservationById = new Map<string, unknown>();
	const liveAdmissionIds = new Set<string>();
	const liveLogicalAdmissions = new Map<string, string>();
	for (const reservation of value.reservations) {
		validateReservation(reservation, filePath);
		const reservationId = reservation.reservationId as string;
		if (reservationIds.has(reservationId)) {
			failCoordinatorDurability("state.json contains duplicate reservation ids", filePath);
		}
		reservationIds.add(reservationId);
		reservationById.set(reservationId, reservation);
		const admissionId = reservation.admissionId;
		if (
			typeof admissionId === "string" &&
			(CAPACITY_OCCUPYING_STATES as readonly string[]).includes(String(reservation.state))
		) {
			if (liveAdmissionIds.has(admissionId)) {
				failCoordinatorDurability("state.json has duplicate live admission identities", filePath);
			}
			liveAdmissionIds.add(admissionId);
		}
		if (reservation.state === "committed" || reservation.state === "orphan-suspect") {
			const key = admissionBindingKey(reservation as ConcurrencyReservation);
			if (!key) {
				failCoordinatorDurability(
					"state.json reservation lacks a complete admission binding in a project-bound state",
					filePath,
				);
			}
			const prior = liveLogicalAdmissions.get(key);
			if (prior !== undefined) {
				failCoordinatorDurability(
					`state.json has duplicate logical admission binding for ${key} (reservations ${prior} and ${reservationId})`,
					filePath,
				);
			}
			liveLogicalAdmissions.set(key, reservationId);
		}
	}
	const occupyingReservations = value.reservations.filter((reservation) =>
		(CAPACITY_OCCUPYING_STATES as readonly string[]).includes(String(reservation.state)),
	).length;
	if (occupyingReservations > value.maxActiveRuns) {
		failCoordinatorDurability("state.json exceeds its own maxActiveRuns capacity", filePath);
	}
	const commandIds = new Set<string>();
	let expectedCommandSeq = 1;
	let lastRecordedMaxActiveRuns: number | undefined;
	for (const command of value.commands) {
		validateCoordinatorCommand(command, filePath, expectedCommandSeq, reservationById);
		const commandId = command.commandId as string;
		if (commandIds.has(commandId)) {
			failCoordinatorDurability("state.json contains duplicate command ids", filePath);
		}
		commandIds.add(commandId);
		if (
			command.kind === "setMaxActiveRuns" &&
			isRecord(command.payload) &&
			isPositiveSafeInteger(command.payload.maxActiveRuns)
		) {
			lastRecordedMaxActiveRuns = command.payload.maxActiveRuns;
		}
		expectedCommandSeq += 1;
	}
	if (value.nextCommandSeq !== expectedCommandSeq) {
		failCoordinatorDurability("state.json has a non-contiguous command sequence", filePath);
	}
	if (
		lastRecordedMaxActiveRuns !== undefined &&
		value.maxActiveRuns !== lastRecordedMaxActiveRuns
	) {
		failCoordinatorDurability("state.json capacity does not match its latest set-capacity command", filePath);
	}
	if (
		lastRecordedMaxActiveRuns === undefined &&
		value.schemaVersion === COORDINATOR_STATE_SCHEMA_VERSION &&
		value.maxActiveRuns !== DEFAULT_MAX_ACTIVE_RUNS
	) {
		failCoordinatorDurability(
			"state.json capacity without a set-capacity command does not match the default genesis capacity",
			filePath,
		);
	}
	return value as unknown as CoordinatorFile;
}

function validateCoordinatorStateAnchor(
	value: unknown,
	filePath: string,
): CoordinatorStateAnchor {
	if (
		!isRecord(value) ||
		value.schemaVersion !== COORDINATOR_STATE_ANCHOR_SCHEMA_VERSION ||
		!isSafeIdentifier(value.coordinatorId) ||
		!isNonNegativeSafeInteger(value.createdAt)
	) {
		failCoordinatorDurability("state.anchor.json has an invalid initialization record", filePath);
	}
	return value as unknown as CoordinatorStateAnchor;
}

function emptyCoordinator(): CoordinatorFile {
	return {
		schemaVersion: COORDINATOR_STATE_SCHEMA_VERSION,
		coordinatorId: newId("coord"),
		maxActiveRuns: DEFAULT_MAX_ACTIVE_RUNS,
		lease: null,
		reservations: [],
		commands: [],
		nextCommandSeq: 1,
	};
}

interface OpenCoordinatorStoreOptions {
	/** Override on-disk directory (project-local standalone). */
	baseDir?: string;
	/**
	 * Trusted ancestor for symlink rejection when baseDir is project-local.
	 * Defaults to userHome for the user coordinator and baseDir's parent for
	 * custom stores, so existing callers remain compatible.
	 */
	durabilityRoot?: string;
	/** Optional host singleton fence around each durable coordinator mutation. */
	mutationFence?: <T>(fn: () => T) => T;
	/** Process-local capability held only by the singleton writer. */
	mutationAuthority?: SingletonMutationAuthority;
	/** Explicit non-GA escape hatch for test/embedded skipSingleton plumbing. */
	allowUnfencedMutationForExplicitNonGaMode?: boolean;
}

/**
 * Public (and only) coordinator open. Clock authority is wall time only —
 * a `clock` option is refused so callers cannot forge TTL expiry through this
 * entry point. There is no injectable-clock construction on the package barrel.
 */
export function openUserCoordinatorStore(
	env: NodeJS.ProcessEnv = process.env,
	opts?: OpenCoordinatorStoreOptions,
): UserCoordinatorStore {
	if (opts !== undefined && Object.prototype.hasOwnProperty.call(opts, "clock")) {
		failInvalidArgument(
			"clock is not accepted by openUserCoordinatorStore; TTL uses store wall time only",
		);
	}
	return openCoordinatorStoreInternal(env, opts ?? {}, WALL_CLOCK);
}

function openCoordinatorStoreInternal(
	env: NodeJS.ProcessEnv,
	opts: OpenCoordinatorStoreOptions,
	clock: CoordinatorClock,
): UserCoordinatorStore {
	const globalCoordinatorDir = coordinatorDir(env);
	if (
		opts.baseDir !== undefined &&
		path.resolve(opts.baseDir) === globalCoordinatorDir
	) {
		throw new SingletonAuthorityError(
			"project-local coordinator baseDir must not alias the user-global coordinator",
		);
	}
	const dir = opts.baseDir ?? globalCoordinatorDir;
	const durabilityRoot =
		opts.durabilityRoot ?? (opts.baseDir === undefined ? userHome(env) : path.dirname(dir));
	const file = path.join(dir, "state.json");
	// Keep the initialization anchor beside (not inside) the mutable coordinator
	// directory. Deleting `coordinator/` or `coordinator-local/` must not make a
	// previously initialized capacity ledger look like a first-use store.
	const anchorPath = path.join(path.dirname(dir), `${path.basename(dir)}.anchor.json`);
	const lockPath = path.join(dir, "state.lock");

	function assertCoordinatorPathsHaveNoSymlinks(): void {
		for (const durablePath of [dir, file, anchorPath, lockPath]) {
			assertNoSymbolicLinkBelow(durabilityRoot, durablePath);
		}
	}

	assertCoordinatorPathsHaveNoSymlinks();

	function readStateAnchor(): CoordinatorStateAnchor | null {
		const raw = readJsonFileStrict<unknown>(anchorPath);
		return raw === null ? null : validateCoordinatorStateAnchor(raw, anchorPath);
	}

	function load(): CoordinatorFile {
		assertCoordinatorPathsHaveNoSymlinks();
		const raw = readJsonFileStrict<unknown>(file);
		const anchor = readStateAnchor();
		if (raw === null) {
			if (anchor !== null) {
				failCoordinatorDurability(
					"state.json is missing after coordinator initialization",
					file,
				);
			}
			return emptyCoordinator();
		}
		const state = validateCoordinatorFile(raw, file);
		if (state.schemaVersion === 1) {
			// v1 predates anchors. It may be read so an explicit subsequent mutation
			// can migrate it, but it must never coexist with a v2 anchor.
			if (anchor !== null) {
				failCoordinatorDurability(
					"legacy state.json conflicts with an existing initialization anchor",
					file,
				);
			}
			return state;
		}
		if (anchor === null) {
			failCoordinatorDurability("state.anchor.json is missing for initialized coordinator", anchorPath);
		}
		if (anchor.coordinatorId !== state.coordinatorId) {
			failCoordinatorDurability(
				"state.json and state.anchor.json identify different coordinators",
				anchorPath,
			);
		}
		return state;
	}

	function save(data: CoordinatorFile): void {
		assertCoordinatorPathsHaveNoSymlinks();
		const hasRecordedCapacity = data.commands.some((command) => command.kind === "setMaxActiveRuns");
		const migrationCommand: CoordinatorCommandRecord | undefined =
			data.schemaVersion === 1 && !hasRecordedCapacity
				? {
						commandId: newId("cmd-migrate-capacity"),
						requestHash: hashRequest({ maxActiveRuns: data.maxActiveRuns }),
						callerPrincipal: "system-v1-migration",
						kind: "setMaxActiveRuns",
						firstCommitSeq: data.nextCommandSeq,
						lastCommitSeq: data.nextCommandSeq,
						status: "completed",
						payload: { maxActiveRuns: data.maxActiveRuns },
						recordedAt: clock.now(),
					}
				: undefined;
		const state: CoordinatorFile =
			data.schemaVersion === 1
				? {
							...data,
							schemaVersion: COORDINATOR_STATE_SCHEMA_VERSION,
							coordinatorId: newId("coord"),
							commands: migrationCommand ? [...data.commands, migrationCommand] : data.commands,
							nextCommandSeq: data.nextCommandSeq + (migrationCommand ? 1 : 0),
						}
					: data;
		// Public TypeScript types do not protect this durable boundary from JS/MCP
		// callers. Validate the exact candidate before publishing either anchor or
		// state, so a rejected mutation cannot poison a previously reopenable ledger.
		validateCoordinatorFile(state, file);
		const coordinatorId = state.coordinatorId;
		if (!coordinatorId) {
			failCoordinatorDurability("v2 state.json is missing coordinatorId", file);
		}
		const anchor = readStateAnchor();
		if (anchor === null) {
			// Anchor first: a crash between these writes may deny a fresh coordinator,
			// but it can never recreate capacity after a previously durable identity.
			writeFileAtomic(
				anchorPath,
				JSON.stringify(
					{
						schemaVersion: COORDINATOR_STATE_ANCHOR_SCHEMA_VERSION,
						coordinatorId,
						createdAt: clock.now(),
					} satisfies CoordinatorStateAnchor,
					null,
					2,
				),
			);
		} else if (anchor.coordinatorId !== coordinatorId) {
			failCoordinatorDurability(
				"state.anchor.json does not match the coordinator being saved",
				anchorPath,
			);
		}
		writeFileAtomic(file, JSON.stringify(state, null, 2));
	}

	/** load → mutate → save under singleton authority + cross-process state lock. */
	function mutate<T>(fn: (data: CoordinatorFile, coordinatorEpoch: number) => T): T {
		assertCoordinatorPathsHaveNoSymlinks();
		const mutateLocked = (coordinatorEpoch: number) =>
			withExclusiveLockFile(lockPath, () => {
				const data = load();
				const result = fn(data, coordinatorEpoch);
				save(data);
				return result;
			});
		const fencedMutation = (coordinatorEpoch: number) =>
			opts.mutationFence
				? opts.mutationFence(() => mutateLocked(coordinatorEpoch))
				: mutateLocked(coordinatorEpoch);
		if (opts.baseDir !== undefined) return fencedMutation(0);
		if (opts.mutationAuthority) {
			return withSingletonMutationAuthority(
				opts.mutationAuthority,
				() => fencedMutation(singletonMutationAuthorityEpoch(opts.mutationAuthority!)),
				env,
			);
		}
		if (opts.allowUnfencedMutationForExplicitNonGaMode) return fencedMutation(0);
		throw new SingletonAuthorityError(
			"user-global coordinator mutation requires a live singleton capability or explicit non-GA mode",
		);
	}

	function occupying(data: CoordinatorFile): number {
		return data.reservations.filter((r) =>
			(CAPACITY_OCCUPYING_STATES as readonly string[]).includes(r.state),
		).length;
	}

	function updateRes(
		data: CoordinatorFile,
		id: string,
		patch: Partial<ConcurrencyReservation>,
		at: number = clock.now(),
	): ConcurrencyReservation {
		const i = data.reservations.findIndex((r) => r.reservationId === id);
		if (i < 0) throw new Error(`reservation not found: ${id}`);
		const next = { ...data.reservations[i]!, ...patch, updatedAt: at };
		data.reservations[i] = next;
		return next;
	}

	return {
		get maxActiveRuns() {
			return load().maxActiveRuns;
		},

		getLease() {
			return load().lease;
		},

		setLease(lease: CoordinatorLease) {
			const normalizedLease = normalizeCoordinatorLease(lease);
			mutate((data, coordinatorEpoch) => {
				if (normalizedLease.fencingEpoch !== coordinatorEpoch) {
					failInvalidArgument("lease fencingEpoch does not match the current mutation authority");
				}
				data.lease = normalizedLease;
			});
		},

		occupyingCount() {
			return occupying(load());
		},

		listReservations() {
			return load().reservations.slice();
		},

		getReservation(id: string) {
			return load().reservations.find((r) => r.reservationId === id) ?? null;
		},

		reserve(opts = {}) {
			const normalizedOpts = normalizeReserveOptions(opts);
			return mutate((data, coordinatorEpoch) => {
				const now = clock.now();
				if (normalizedOpts.ttlMs > Number.MAX_SAFE_INTEGER - now) {
					failInvalidArgument("reservation ttlMs exceeds safe timestamp range");
				}
				for (const r of data.reservations) {
					if (
						r.state === "reserved" &&
						r.reservedExpiresAt !== undefined &&
						r.reservedExpiresAt <= now
					) {
						r.state = "expired";
						r.updatedAt = now;
					}
				}
				if (normalizedOpts.admissionId !== undefined) {
					const existing = data.reservations.find(
						(reservation) =>
							reservation.admissionId === normalizedOpts.admissionId &&
							(CAPACITY_OCCUPYING_STATES as readonly string[]).includes(reservation.state),
					);
					if (existing) return existing;
				}
				if (occupying(data) >= data.maxActiveRuns) {
					return null;
				}
				const res: ConcurrencyReservation = {
					reservationId: newId("rsv"),
					state: "reserved",
					slots: RESERVATION_SLOTS,
					...(normalizedOpts.admissionId === undefined
						? {}
						: { admissionId: normalizedOpts.admissionId }),
					coordinatorEpoch,
					reservedExpiresAt: now + normalizedOpts.ttlMs,
					createdAt: now,
					updatedAt: now,
				};
				data.reservations.push(res);
				return res;
			});
		},

		releaseUnboundReservation(reservationId) {
			assertSafeIdentifier(reservationId, "reservationId");
			return mutate((data) => {
				const r = data.reservations.find((x) => x.reservationId === reservationId);
				if (!r) throw new Error(`reservation not found: ${reservationId}`);
				if (
					r.state !== "reserved" ||
					r.admissionId !== undefined ||
					r.projectId !== undefined ||
					r.projectControlDomainId !== undefined ||
					r.runId !== undefined ||
					r.projectAdmitCommitSeq !== undefined ||
					r.attemptId !== undefined ||
					r.providerJobHandle !== undefined
				) {
					throw new Error(
						"releaseUnboundReservation requires a reserved record with no admission/project/run/provider binding",
					);
				}
				return updateRes(data, reservationId, { state: "released", reservedExpiresAt: undefined });
			});
		},

		commitReservation(reservationId, binding) {
			assertSafeIdentifier(reservationId, "reservationId");
			const normalizedBinding = normalizeReservationBinding(binding);
			const admissionKey = admissionBindingKey(normalizedBinding);
			if (!admissionKey) {
				failInvalidArgument("commitReservation binding is incomplete");
			}
			return mutate((data) => {
				const r = data.reservations.find((x) => x.reservationId === reservationId);
				if (!r) throw new Error(`reservation not found: ${reservationId}`);
				if (r.admissionId !== normalizedBinding.admissionId) {
					throw new Error(`reservation ${reservationId} admission identity does not match its project binding`);
				}
				if (r.state === "committed") {
					if (
						r.projectId === normalizedBinding.projectId &&
						r.projectControlDomainId === normalizedBinding.projectControlDomainId &&
						r.runId === normalizedBinding.runId &&
						r.projectAdmitCommitSeq === normalizedBinding.projectAdmitCommitSeq
					) {
						return r;
					}
					throw new Error(`reservation ${reservationId} already committed with a different project binding`);
				}
				if (r.state !== "reserved") {
					throw new Error(`cannot commit reservation in state ${r.state}`);
				}
				const now = clock.now();
				if (r.reservedExpiresAt === undefined || r.reservedExpiresAt <= now) {
					// The lock linearizes commit against TTL expiry. Persist the expiry
					// before returning the rejection so a restart cannot reinterpret this
					// elapsed unbound lease as admission authority.
					// Clock is store/injected only — never a caller opts.now.
					updateRes(data, reservationId, { state: "expired" }, now);
					save(data);
					throw new Error(`cannot commit expired reservation ${reservationId}`);
				}
				// Unique logical admission among capacity-occupying project-bound states.
				const conflicting = data.reservations.find(
					(other) =>
						other.reservationId !== reservationId &&
						(other.state === "committed" || other.state === "orphan-suspect") &&
						admissionBindingKey(other) === admissionKey,
				);
				if (conflicting) {
					throw new CoordinatorAdmissionConflictError({
						existingReservationId: conflicting.reservationId,
						attemptedReservationId: reservationId,
						projectId: normalizedBinding.projectId,
						projectControlDomainId: normalizedBinding.projectControlDomainId,
						runId: normalizedBinding.runId,
					});
				}
				return updateRes(
					data,
					reservationId,
					{
						state: "committed",
						...normalizedBinding,
						reservedExpiresAt: undefined,
					},
					now,
				);
			});
		},

		markOrphanSuspect(reservationId) {
			assertSafeIdentifier(reservationId, "reservationId");
			return mutate((data) => {
				const r = data.reservations.find((x) => x.reservationId === reservationId);
				if (!r) throw new Error(`reservation not found: ${reservationId}`);
				if (r.state !== "committed" && r.state !== "orphan-suspect") {
					throw new Error(`cannot mark orphan-suspect from state ${r.state}`);
				}
				return updateRes(data, reservationId, { state: "orphan-suspect" });
			});
		},

		normalRelease(reservationId, ctx) {
			assertSafeIdentifier(reservationId, "reservationId");
			assertReleaseContext(ctx);
			if (!canNormalRelease(ctx)) {
				throw new Error(
					"D37 normalRelease denied: noLiveOrAmbiguousSideEffects and (terminal|parked-readmit) required",
				);
			}
			const ownership = ctx.ownership;
			return mutate((data) => {
				const r = data.reservations.find((x) => x.reservationId === reservationId);
				if (!r) throw new Error(`reservation not found: ${reservationId}`);
				// Exact matching retry after a successful release: return prior
				// released state without a second mutation. Ownership mismatch
				// still fails (even when already released).
				if (r.state === "released") {
					if (ownership !== undefined && !ownershipEquals(r, ownership)) {
						throw new Error(
							"D37 normalRelease denied: ownership binding required and must match durable reservation",
						);
					}
					return r;
				}
				if (r.state !== "committed" && r.state !== "orphan-suspect") {
					throw new Error(`cannot normalRelease from state ${r.state}`);
				}
				if (ownership !== undefined && !ownershipEquals(r, ownership)) {
					throw new Error(
						"D37 normalRelease denied: ownership binding required and must match durable reservation",
					);
				}
				return updateRes(data, reservationId, { state: "released", reservedExpiresAt: undefined });
			});
		},

		forceRelease(reservationId, cmd) {
			const normalizedCommand = normalizeForceReleaseCommand(reservationId, cmd);
			return mutate((data) => {
				// Idempotent: same commandId already completed
				const prior = data.commands.find((c) => c.commandId === normalizedCommand.commandId);
				if (prior) {
					assertMatchingPriorCommand(prior, normalizedCommand, "forceRelease");
					const res = data.reservations.find((x) => x.reservationId === reservationId);
					if (!res) {
						failCoordinatorDurability(
							"force-release command references a missing reservation",
							file,
						);
					}
					return { reservation: res, command: prior };
				}

				const r = data.reservations.find((x) => x.reservationId === reservationId);
				if (!r) throw new Error(`reservation not found: ${reservationId}`);
				// Safe to force-release already-released (idempotent outcome)
				const seq = data.nextCommandSeq++;
				const command: CoordinatorCommandRecord = {
					commandId: normalizedCommand.commandId,
					requestHash: normalizedCommand.requestHash,
					callerPrincipal: normalizedCommand.callerPrincipal,
					kind: "forceRelease",
					firstCommitSeq: seq,
					lastCommitSeq: seq,
					status: "completed",
					payload: {
						reservationId,
						riskAcknowledged: true,
						reason: normalizedCommand.requestBody.reason ?? null,
					},
					recordedAt: clock.now(),
				};
				data.commands.push(command);
				const at = clock.now();
				const next =
					r.state === "released"
						? { ...r, operatorOverridden: true, updatedAt: at }
						: updateRes(data, reservationId, {
								state: "released",
								reservedExpiresAt: undefined,
								operatorOverridden: true,
							}, at);
				if (r.state === "released") {
					const i = data.reservations.findIndex((x) => x.reservationId === reservationId);
					if (i >= 0) data.reservations[i] = next;
				}
				return { reservation: next, command };
			});
		},

		setMaxActiveRuns(value, cmd) {
			const normalizedCommand = normalizeSetMaxCommand(value, cmd);
			return mutate((data) => {
				const prior = data.commands.find((c) => c.commandId === normalizedCommand.commandId);
				if (prior) {
					assertMatchingPriorCommand(prior, normalizedCommand, "setMaxActiveRuns");
					return prior;
				}
				const active = occupying(data);
				if (value < active) {
					throw new Error(
						`cannot set maxActiveRuns to ${value} below ${active} occupied reservations`,
					);
				}
				const seq = data.nextCommandSeq++;
				const command: CoordinatorCommandRecord = {
					commandId: normalizedCommand.commandId,
					requestHash: normalizedCommand.requestHash,
					callerPrincipal: normalizedCommand.callerPrincipal,
					kind: "setMaxActiveRuns",
					firstCommitSeq: seq,
					lastCommitSeq: seq,
					status: "completed",
					payload: { maxActiveRuns: value },
					recordedAt: clock.now(),
				};
				data.commands.push(command);
				data.maxActiveRuns = value;
				return command;
			});
		},

		reclaimExpiredReserved(now?: number) {
			// Signature retains optional `now` for wire compatibility with older
			// callers, but a caller timestamp is never TTL authority (D1).
			// Invalid values still fail closed; a forged future/past clock cannot
			// free or resurrect slots because the store clock decides.
			if (now !== undefined && !isNonNegativeSafeInteger(now)) {
				failInvalidArgument("invalid reclaim timestamp");
			}
			return mutate((data) => {
				const reclaimAt = clock.now();
				let n = 0;
				for (const r of data.reservations) {
					if (
						r.state === "reserved" &&
						r.reservedExpiresAt !== undefined &&
						r.reservedExpiresAt <= reclaimAt
					) {
						r.state = "expired";
						r.updatedAt = reclaimAt;
						n += 1;
					}
				}
				return n;
			});
		},

		getCommand(commandId: string) {
			const data = load();
			return data.commands.find((c) => c.commandId === commandId) ?? null;
		},
	};
}

/** Test helper: assert capacity formula. */
export function capacityOk(reservations: ConcurrencyReservation[], maxActiveRuns: number): boolean {
	const n = reservations.filter((r) =>
		(CAPACITY_OCCUPYING_STATES as readonly string[]).includes(r.state as ReservationState),
	).length;
	return n <= maxActiveRuns;
}
