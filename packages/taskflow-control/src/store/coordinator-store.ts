/** P16 user-private, files-only capacity authority. Project Runs/Receipts stay
 * in project ledgers. Every operation re-reads one atomically published state
 * under the shared persistent mutex; no process-local capacity cache exists. */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { PersistentFileMutex } from "taskflow-core/persistent-mutex";
import { ControlError, type ControlErrorCode } from "../errors.ts";
import { commandRequestHash } from "../schema/commands.ts";
import { UuidSchema, Sha256HexSchema } from "../schema/common.ts";
import { CoordinatorLeaseSchema, CoordinatorCommandRecordSchema, ConcurrencyReservationSchema, assertReservationInvariants,
	type CoordinatorLease, type CoordinatorCommandRecord, type ConcurrencyReservation, type CapacitySnapshot } from "../schema/coordinator.ts";
import { writeJsonAtomicHardened } from "./store.ts";

export interface CoordinatorIdentity { principal: string; ownerId: string; operator: boolean }
export interface CoordinatorAdmissionProof {
	reservationId: string; projectId: string; projectControlDomainId: string; runId: string; projectAdmitCommitSeq: number; runVersion: number;
}
/** Explicit absence must come from the trusted project admission gate. A null
 * observation or failed read never authorizes TTL capacity reclamation. */
export interface CoordinatorAdmissionAbsence {
	status: "not-admitted"; reservationId: string; projectId: string; projectControlDomainId: string; runId: string; runVersion: number;
}
export type CoordinatorAdmissionObservation = CoordinatorAdmissionProof | CoordinatorAdmissionAbsence | null;
export interface CoordinatorReleaseProof extends CoordinatorAdmissionProof {
	proofId: string; status: string; stage: string; requiresReadmission: boolean;
	providerNoLiveProcessTree: boolean; noAmbiguousJobs: boolean; reconcileTimeoutOnly: boolean;
}
export type CoordinatorOperation = "reserve" | "commit" | "renew" | "markOrphanSuspect" | "normalRelease" | "forceRelease" | "setMaxActiveRuns" | "readReservation" | "readCommand" | "snapshot";
/** Configured only by the trusted host service. Context is opaque service
 * authority, never a wire-body principal or caller-supplied quiescence bool. */
export interface CoordinatorAuthority<Context> {
	readLease(): CoordinatorLease | null | Promise<CoordinatorLease | null>;
	authorize(context: Context, operation: CoordinatorOperation, reservation?: ConcurrencyReservation): CoordinatorIdentity | Promise<CoordinatorIdentity>;
	readAdmission(reservation: ConcurrencyReservation): CoordinatorAdmissionObservation | Promise<CoordinatorAdmissionObservation>;
	readRelease(reservation: ConcurrencyReservation): CoordinatorReleaseProof | Promise<CoordinatorReleaseProof>;
}
export interface CoordinatorStoreOptions<Context> {
	initialMaxActiveRuns: number;
	epoch: number;
	holderId: string;
	authority: CoordinatorAuthority<Context>;
}
export interface StoredReservation {
	reservation: ConcurrencyReservation;
	ownerId: string;
	principal: string;
	updatedAt: number;
	admitRunVersion?: number;
	releaseKind?: "normal" | "force";
	releaseProofId?: string;
	concurrencyGuarantee: "enforced" | "operator-overridden";
}
export interface StoredCoordinatorCommand {
	record: CoordinatorCommandRecord;
	result: StoredReservation | number;
}
interface AuditRecord {
	commitSeq: number; epoch: number; recordedAt: number; action: string; principal: string;
	previousHash: string; stateDigest: string; hash: string;
}
interface CoordinatorState {
	version: 1; fencingEpoch: number; commitSeq: number; lastWallTime: number; maxActiveRuns: number;
	directoryIdentity: { canonicalPath: string; dev: number; ino: number };
	instanceId: string;
	reservations: Record<string, StoredReservation>;
	commands: Record<string, StoredCoordinatorCommand>;
	audit: AuditRecord[];
	stateHash: string;
}
export interface CoordinatorSnapshot {
	commitSeq: number; fencingEpoch: number; capacity: CapacitySnapshot;
	concurrencyGuarantee: "enforced" | "operator-overridden";
	reservations: StoredReservation[]; commands: StoredCoordinatorCommand[];
}
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const text = Type.String({ minLength: 1 });
const rowSchema = Type.Object({ reservation: ConcurrencyReservationSchema, ownerId: text, principal: text, updatedAt: integer,
	admitRunVersion: Type.Optional(integer), releaseKind: Type.Optional(Type.Union([Type.Literal("normal"), Type.Literal("force")])),
	releaseProofId: Type.Optional(text), concurrencyGuarantee: Type.Union([Type.Literal("enforced"), Type.Literal("operator-overridden")]) }, { additionalProperties: false });
const commandSchema = Type.Object({ record: CoordinatorCommandRecordSchema, result: Type.Union([rowSchema, Type.Integer({ minimum: 1 })]) }, { additionalProperties: false });
const auditSchema = Type.Object({ commitSeq: integer, epoch: integer, recordedAt: integer, action: text, principal: text,
	previousHash: Sha256HexSchema, stateDigest: Sha256HexSchema, hash: Sha256HexSchema }, { additionalProperties: false });
const stateSchema = Type.Object({ version: Type.Literal(1), fencingEpoch: integer, commitSeq: integer, lastWallTime: integer,
	directoryIdentity: Type.Object({ canonicalPath: text, dev: integer, ino: integer }, { additionalProperties: false }),
	instanceId: UuidSchema,
	maxActiveRuns: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), reservations: Type.Record(Type.String(), rowSchema),
	commands: Type.Record(Type.String(), commandSchema), audit: Type.Array(auditSchema), stateHash: Sha256HexSchema }, { additionalProperties: false });
const ZERO_HASH = "0".repeat(64);
export const COORDINATOR_CRASH_ENV = "TASKFLOW_COORDINATOR_CRASH_AT";
export type CoordinatorCrashPoint = "before-state-write" | "after-state-write";
const active = (row: StoredReservation) => ["reserved", "committed", "orphan-suspect"].includes(row.reservation.state);
const fail = (code: ControlErrorCode, message: string): never => { throw new ControlError(code, message, { recoveryAction: "operator", sideEffects: "none" }); };
const validId = (id: string) => { if (!Value.Check(UuidSchema, id)) fail("TF_COMMAND_FAILED", "coordinator identifier must be a UUID"); };
const positive = (value: number, name: string) => { if (!Number.isSafeInteger(value) || value < 1) fail("TF_COMMAND_FAILED", `${name} must be a positive safe integer`); };
function capacity(state: CoordinatorState): CapacitySnapshot {
	const rows = Object.values(state.reservations);
	const reserved = rows.filter((r) => r.reservation.state === "reserved").length;
	const committed = rows.filter((r) => r.reservation.state === "committed").length;
	const orphanSuspect = rows.filter((r) => r.reservation.state === "orphan-suspect").length;
	return { maxActiveRuns: state.maxActiveRuns, active: reserved + committed + orphanSuspect, reserved, committed, orphanSuspect };
}
function businessDigest(state: CoordinatorState): string {
	return commandRequestHash({ fencingEpoch: state.fencingEpoch, maxActiveRuns: state.maxActiveRuns, reservations: state.reservations, commands: state.commands });
}
function hashState(state: CoordinatorState): string { const { stateHash: _, ...body } = state; return commandRequestHash(body); }
function assertNoSymlink(file: string): void {
	try { if (fs.lstatSync(file).isSymbolicLink()) fail("TF_DURABILITY_FAILED", `coordinator refuses symlink: ${file}`); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function prepareDirectory(directory: string): string {
	const missing: string[] = [];
	let ancestor = path.resolve(directory);
	while (!fs.existsSync(ancestor)) { missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
	assertNoSymlink(ancestor);
	let canonical = fs.realpathSync(ancestor);
	for (const segment of missing) {
		canonical = path.join(canonical, segment);
		try { fs.mkdirSync(canonical, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		assertNoSymlink(canonical);
		if (!fs.lstatSync(canonical).isDirectory()) fail("TF_DURABILITY_FAILED", "coordinator path component is not a directory");
	}
	const stat = fs.lstatSync(canonical);
	if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) fail("TF_DURABILITY_FAILED", "coordinator directory must be owned by the host user");
	if (process.platform !== "win32") fs.chmodSync(canonical, 0o700);
	return canonical;
}
function validateState(raw: unknown): CoordinatorState {
	if (!Value.Check(stateSchema, raw)) fail("TF_DURABILITY_FAILED", "coordinator state has an invalid closed shape");
	const state = raw as CoordinatorState;
	if (hashState(state) !== state.stateHash || state.audit.length !== state.commitSeq) fail("TF_DURABILITY_FAILED", "coordinator state/audit integrity mismatch");
	let previous = ZERO_HASH;
	let priorTime = 0;
	for (const [index, entry] of state.audit.entries()) {
		const { hash, ...body } = entry;
		if (entry.commitSeq !== index + 1 || entry.previousHash !== previous || entry.recordedAt < priorTime || entry.epoch > state.fencingEpoch || commandRequestHash(body) !== hash) fail("TF_DURABILITY_FAILED", "coordinator audit chain is inconsistent");
		previous = hash; priorTime = entry.recordedAt;
	}
	if (priorTime > state.lastWallTime || (state.audit.length && state.audit.at(-1)!.stateDigest !== businessDigest(state))) fail("TF_DURABILITY_FAILED", "coordinator projection is not bound to its latest audit");
	const bindings = new Set<string>();
	for (const [id, row] of Object.entries(state.reservations)) {
		validId(id);
		if (id !== row.reservation.reservationId || row.updatedAt > state.lastWallTime || row.reservation.coordinatorEpoch > state.fencingEpoch) fail("TF_DURABILITY_FAILED", "coordinator reservation identity/time mismatch");
		for (const number of [row.reservation.coordinatorEpoch, row.reservation.projectAdmitCommitSeq, row.reservation.reservedExpiresAt, row.reservation.renewedAt]) {
			if (number !== undefined && (!Number.isSafeInteger(number) || number < 0)) fail("TF_DURABILITY_FAILED", "coordinator reservation contains an unsafe numeric authority");
		}
		try { assertReservationInvariants(row.reservation); } catch { fail("TF_ADMISSION_BINDING_CONFLICT", "committed/orphan reservation must have admission evidence and no TTL"); }
		if (row.reservation.state === "reserved" && (row.reservation.reservedExpiresAt === undefined || row.reservation.projectAdmitCommitSeq !== undefined)) fail("TF_ADMISSION_BINDING_CONFLICT", "pre-admit reservation requires TTL and no admitted sequence");
		if (["committed", "orphan-suspect"].includes(row.reservation.state)) {
			const binding = bindingKey(row.reservation);
			if (bindings.has(binding)) fail("TF_ADMISSION_BINDING_CONFLICT", "duplicate admitted project/domain/run binding");
			bindings.add(binding);
		}
	}
	for (const [id, command] of Object.entries(state.commands)) {
		validId(id);
		if (id !== command.record.commandId || command.record.status !== "completed" || command.record.firstCommitSeq !== command.record.lastCommitSeq || command.record.lastCommitSeq > state.commitSeq) fail("TF_DURABILITY_FAILED", "coordinator command authority mismatch");
	}
	if (capacity(state).active > state.maxActiveRuns) fail("TF_CAPACITY_EXCEEDED", "durable coordinator exceeds its capacity ceiling");
	return state;
}
function bindingKey(row: Pick<ConcurrencyReservation, "projectId" | "projectControlDomainId" | "runId">): string { return `${row.projectId}/${row.projectControlDomainId}/${row.runId}`; }
function matchesProof(row: StoredReservation, proof: CoordinatorAdmissionProof): boolean {
	return !!proof && proof.reservationId === row.reservation.reservationId && bindingKey(row.reservation) === bindingKey(proof) && proof.projectAdmitCommitSeq === row.reservation.projectAdmitCommitSeq
		&& Number.isSafeInteger(proof.runVersion) && proof.runVersion >= (row.admitRunVersion ?? 0);
}
function isAdmissionProof(proof: CoordinatorAdmissionObservation): proof is CoordinatorAdmissionProof {
	return !!proof && !("status" in proof) && Number.isSafeInteger(proof.projectAdmitCommitSeq) && proof.projectAdmitCommitSeq > 0 && Number.isSafeInteger(proof.runVersion) && proof.runVersion >= 0;
}

export class UserCoordinatorStore<Context> {
	readonly storePath: string;
	readonly #options: CoordinatorStoreOptions<Context>;
	readonly #mutex: PersistentFileMutex;
	readonly #directoryIdentity: { dev: number; ino: number };
	#closed = false;
	#clockHighWater = 0;
	constructor(directory: string, options: CoordinatorStoreOptions<Context>) {
		positive(options.initialMaxActiveRuns, "initialMaxActiveRuns");
		if (!Number.isSafeInteger(options.epoch) || options.epoch < 1 || !options.holderId?.trim()) fail("TF_AUTHORITY_REVOKED", "coordinator requires a verified holder and positive epoch");
		if (!options.authority || ["readLease", "authorize", "readAdmission", "readRelease"].some((key) => typeof (options.authority as unknown as Record<string, unknown>)[key] !== "function")) fail("TF_AUTHORITY_REVOKED", "coordinator requires trusted live authority callbacks");
		this.#options = { ...options };
		this.storePath = prepareDirectory(directory);
		const { dev, ino } = fs.statSync(this.storePath); this.#directoryIdentity = { dev, ino };
		this.#mutex = new PersistentFileMutex(path.join(this.storePath, "writer.lock"));
	}
	close(): void { this.#closed = true; }
	async initialize(): Promise<void> { await this.#transaction("initialize", undefined, undefined, async () => undefined); }
	async snapshot(context: Context): Promise<CoordinatorSnapshot> {
		return this.#transaction("snapshot", context, undefined, async (state) => ({ commitSeq: state.commitSeq, fencingEpoch: state.fencingEpoch, capacity: capacity(state),
			concurrencyGuarantee: Object.values(state.reservations).some((r) => r.concurrencyGuarantee === "operator-overridden") ? "operator-overridden" : "enforced",
			reservations: Object.values(state.reservations), commands: Object.values(state.commands) }));
	}
	async readReservation(id: string, context: Context): Promise<StoredReservation | undefined> {
		validId(id);
		return this.#transaction("readReservation", context, id, async (state, identity) => {
			const row = state.reservations[id]; if (row) this.#owner(row, identity!); return row;
		});
	}
	async readCommand(id: string, context: Context): Promise<StoredCoordinatorCommand | undefined> {
		validId(id);
		return this.#transaction("readCommand", context, undefined, async (state, identity) => {
			const command = state.commands[id];
			if (command && command.record.callerPrincipal !== identity!.principal) fail("TF_CROSS_PRINCIPAL_COMMAND", "coordinator result belongs to another verified principal");
			return command;
		});
	}
	async reserve(input: { reservationId?: string; projectId: string; projectControlDomainId: string; runId: string; ttlMs: number }, context: Context): Promise<StoredReservation> {
		input = structuredClone(input);
		const id = input.reservationId ?? randomUUID();
		for (const value of [id, input.projectId, input.projectControlDomainId, input.runId]) validId(value);
		this.#ttl(input.ttlMs);
		return this.#transaction("reserve", context, id, async (state, identity, now) => {
			const existing = state.reservations[id];
			if (existing) {
				this.#owner(existing, identity!);
				if (bindingKey(existing.reservation) !== bindingKey(input) || existing.reservation.state !== "reserved") fail("TF_ADMISSION_BINDING_CONFLICT", "reservation ID cannot be rebound or reused after admission/expiry/release");
				return existing;
			}
			if (capacity(state).active >= state.maxActiveRuns) fail("TF_CAPACITY_EXCEEDED", "global admitted-run capacity exhausted");
			return state.reservations[id] = { reservation: { reservationId: id, projectId: input.projectId, projectControlDomainId: input.projectControlDomainId, runId: input.runId,
				state: "reserved", slots: 1, coordinatorEpoch: this.#options.epoch, reservedExpiresAt: now + input.ttlMs },
				ownerId: identity!.ownerId, principal: identity!.principal, updatedAt: now, concurrencyGuarantee: "enforced" };
		}, { reservationId: id, projectId: input.projectId, projectControlDomainId: input.projectControlDomainId, runId: input.runId, state: "reserved", slots: 1, coordinatorEpoch: this.#options.epoch });
	}
	async commit(id: string, input: { projectAdmitCommitSeq: number; attemptId?: string; providerJobHandle?: string }, context: Context): Promise<StoredReservation> {
		input = structuredClone(input);
		positive(input.projectAdmitCommitSeq, "projectAdmitCommitSeq"); if (input.attemptId) validId(input.attemptId);
		return this.#transaction("commit", context, id, async (state, identity, now) => {
			const row = this.#row(state, id); this.#owner(row, identity!);
			if (row.reservation.state === "committed") {
				if (row.reservation.projectAdmitCommitSeq !== input.projectAdmitCommitSeq || row.reservation.attemptId !== input.attemptId || row.reservation.providerJobHandle !== input.providerJobHandle) fail("TF_ADMISSION_BINDING_CONFLICT", "admission retry changed durable binding");
				return row;
			}
			if (row.reservation.state !== "reserved") fail("TF_ADMISSION_BINDING_CONFLICT", "only a live pre-admit reservation can commit");
			if (Object.values(state.reservations).some((other) => other !== row && ["committed", "orphan-suspect"].includes(other.reservation.state) && bindingKey(other.reservation) === bindingKey(row.reservation))) fail("TF_ADMISSION_BINDING_CONFLICT", "project/domain/run already has a committed reservation");
			const proposed = { ...row.reservation, ...input };
			const proof = await this.#options.authority.readAdmission(structuredClone(proposed));
			this.#now(now);
			if (row.reservation.reservedExpiresAt! <= Date.now()) fail("TF_ADMISSION_BINDING_CONFLICT", "reservation expired before durable admission commit");
			if (!isAdmissionProof(proof) || !matchesProof({ ...row, reservation: proposed }, proof)) fail("TF_ADMISSION_BINDING_CONFLICT", "project ledger does not prove this admission");
			row.reservation = { ...proposed, state: "committed", coordinatorEpoch: this.#options.epoch };
			delete row.reservation.reservedExpiresAt;
			row.admitRunVersion = proof.runVersion; row.updatedAt = now; return row;
		});
	}
	async renew(id: string, input: { ttlMs?: number }, context: Context): Promise<StoredReservation> {
		input = structuredClone(input);
		if (input.ttlMs !== undefined) this.#ttl(input.ttlMs);
		return this.#transaction("renew", context, id, async (state, identity, now) => {
			const row = this.#row(state, id); this.#owner(row, identity!);
			if (!active(row)) fail("TF_ADMISSION_BINDING_CONFLICT", "inactive reservation cannot renew");
			if (row.reservation.state === "reserved") {
				if (input.ttlMs === undefined) fail("TF_COMMAND_FAILED", "reserved renewal requires a TTL");
				row.reservation.reservedExpiresAt = now + input.ttlMs!;
			} else if (input.ttlMs !== undefined) fail("TF_ADMISSION_BINDING_CONFLICT", "committed/orphan reservations must never receive a TTL");
			row.reservation.renewedAt = now; row.reservation.coordinatorEpoch = this.#options.epoch; row.updatedAt = now; return row;
		});
	}
	async markOrphanSuspect(id: string, context: Context): Promise<StoredReservation> {
		return this.#transaction("markOrphanSuspect", context, id, async (state, identity, now) => {
			const row = this.#row(state, id); this.#owner(row, identity!);
			if (!["committed", "orphan-suspect"].includes(row.reservation.state)) fail("TF_ADMISSION_BINDING_CONFLICT", "only admitted reservations can become orphan-suspect");
			if (row.reservation.state === "committed") { row.reservation.state = "orphan-suspect"; row.updatedAt = now; row.reservation.coordinatorEpoch = this.#options.epoch; }
			return row;
		});
	}
	async normalRelease(id: string, context: Context): Promise<StoredReservation> {
		return this.#transaction("normalRelease", context, id, async (state, identity, now) => {
			const row = this.#row(state, id); this.#owner(row, identity!);
			if (row.reservation.state === "released" && row.releaseKind === "normal") return row;
			if (!["committed", "orphan-suspect"].includes(row.reservation.state)) fail("TF_ADMISSION_BINDING_CONFLICT", "normalRelease requires an admitted reservation");
			const proof = await this.#options.authority.readRelease(structuredClone(row.reservation));
			this.#now(now);
			const terminal = ["completed", "failed", "blocked", "cancelled"].includes(proof?.status);
			const parked = proof?.status === "paused" && proof.stage === "parked" && proof.requiresReadmission === true;
			if (!matchesProof(row, proof) || !proof.proofId?.trim() || proof.providerNoLiveProcessTree !== true || proof.noAmbiguousJobs !== true || proof.reconcileTimeoutOnly !== false || (!terminal && !parked)) fail("TF_RECONCILE_REQUIRED", "D37 requires current ledger-bound terminal/parked and provider quiescence evidence");
			row.reservation.state = "released"; row.reservation.coordinatorEpoch = this.#options.epoch;
			delete row.reservation.reservedExpiresAt; row.releaseKind = "normal"; row.releaseProofId = proof.proofId; row.updatedAt = now; return row;
		});
	}
	async forceRelease(id: string, input: { commandId: string; riskAcknowledgement: true; reason: string }, context: Context): Promise<StoredReservation> {
		input = structuredClone(input);
		validId(input.commandId);
		if (input.riskAcknowledgement !== true || !input.reason?.trim()) fail("TF_POLICY_DENIED", "forceRelease requires explicit risk acknowledgement and reason");
		return this.#transaction("forceRelease", context, id, async (state, identity, now) => {
			this.#operator(identity!);
			return this.#command(state, identity!, input.commandId, { kind: "forceRelease", reservationId: id, riskAcknowledgement: true, reason: input.reason }, () => {
				const row = this.#row(state, id);
				if (row.reservation.state === "expired") fail("TF_ADMISSION_BINDING_CONFLICT", "expired reservation cannot be force released");
				row.reservation.state = "released"; row.reservation.coordinatorEpoch = this.#options.epoch;
				delete row.reservation.reservedExpiresAt; row.releaseKind = "force"; row.concurrencyGuarantee = "operator-overridden"; row.updatedAt = now; return row;
			}) as StoredReservation;
		});
	}
	async setMaxActiveRuns(input: { commandId: string; maxActiveRuns: number }, context: Context): Promise<number> {
		input = structuredClone(input);
		validId(input.commandId); positive(input.maxActiveRuns, "maxActiveRuns");
		return this.#transaction("setMaxActiveRuns", context, undefined, async (state, identity) => {
			this.#operator(identity!);
			return this.#command(state, identity!, input.commandId, { kind: "setMaxActiveRuns", maxActiveRuns: input.maxActiveRuns }, () => {
				if (input.maxActiveRuns < capacity(state).active) fail("TF_CAPACITY_EXCEEDED", "cannot lower capacity below reserved/committed/orphan usage");
				return state.maxActiveRuns = input.maxActiveRuns;
			}) as number;
		});
	}
	#command(state: CoordinatorState, identity: CoordinatorIdentity, id: string, body: { kind: "forceRelease" | "setMaxActiveRuns"; [key: string]: unknown }, execute: () => StoredReservation | number): StoredReservation | number {
		const hash = commandRequestHash(body); const prior = state.commands[id];
		if (prior) {
			if (prior.record.callerPrincipal !== identity.principal) fail("TF_CROSS_PRINCIPAL_COMMAND", "coordinator result belongs to another verified principal");
			if (prior.record.requestHash !== hash) fail("TF_IDEMPOTENCY_CONFLICT", "coordinator command ID was reused with a different request");
			return prior.result;
		}
		const result = execute();
		state.commands[id] = { record: { commandId: id, kind: body.kind, requestHash: hash, callerPrincipal: identity.principal, firstCommitSeq: state.commitSeq + 1, lastCommitSeq: state.commitSeq + 1, status: "completed" }, result: structuredClone(result) };
		return result;
	}
	#ttl(ttlMs: number): void { positive(ttlMs, "ttlMs"); if (ttlMs > 86_400_000) fail("TF_COMMAND_FAILED", "reservation TTL must not exceed one day"); }
	#row(state: CoordinatorState, id: string): StoredReservation { validId(id); const row = state.reservations[id]; if (!row) fail("TF_ADMISSION_BINDING_CONFLICT", "reservation not found"); return row; }
	#owner(row: StoredReservation, identity: CoordinatorIdentity): void { if (row.ownerId !== identity.ownerId || row.principal !== identity.principal) fail("TF_AUTHORITY_REVOKED", "reservation owner/project authority does not match"); }
	#operator(identity: CoordinatorIdentity): void { if (identity.operator !== true) fail("TF_POLICY_DENIED", "an authorized coordinator operator is required"); }
	#binding(): void {
		assertNoSymlink(this.storePath); const st = fs.statSync(this.storePath);
		if (st.dev !== this.#directoryIdentity.dev || st.ino !== this.#directoryIdentity.ino) fail("TF_DURABILITY_FAILED", "coordinator directory identity changed");
		assertNoSymlink(path.join(this.storePath, "writer.lock.queue")); assertNoSymlink(path.join(this.storePath, "coordinator.json")); assertNoSymlink(path.join(this.storePath, "coordinator.identity.json"));
	}
	#now(floor = 0): number {
		const now = Date.now();
		if (!Number.isSafeInteger(now) || now < Math.max(floor, this.#clockHighWater)) fail("TF_AUTHORITY_REVOKED", "wall clock moved backwards; no TTL reclaim or mutation is safe");
		this.#clockHighWater = now; return now;
	}
	async #fence(now: number): Promise<number> {
		const lease = await this.#options.authority.readLease();
		const observedNow = this.#now(now);
		if (!Value.Check(CoordinatorLeaseSchema, lease) || !Number.isSafeInteger(lease!.expiresAt) || !Number.isSafeInteger(lease!.fencingEpoch) || lease!.fencingEpoch !== this.#options.epoch || lease!.holderId !== this.#options.holderId || lease!.expiresAt <= observedNow) fail("TF_AUTHORITY_REVOKED", "coordinator holder/epoch/lease is no longer authoritative");
		return lease!.expiresAt;
	}
	async #expireReservations(state: CoordinatorState, now: number): Promise<void> {
		for (const row of Object.values(state.reservations)) {
			if (row.reservation.state !== "reserved" || row.reservation.reservedExpiresAt! > now) continue;
			let proof: CoordinatorAdmissionObservation;
			try { proof = await this.#options.authority.readAdmission(structuredClone(row.reservation)); }
			catch { this.#now(now); continue; } // An unavailable project ledger retains its slot.
			const observedNow = this.#now(now); await this.#fence(observedNow);
			if (!proof || proof.reservationId !== row.reservation.reservationId || bindingKey(proof) !== bindingKey(row.reservation)) continue;
			if (isAdmissionProof(proof)) {
				// Run Admitted may have reached its project ledger before the host
				// crashed between that fsync and coordinator commit. Never TTL-free it.
				row.reservation.state = "committed"; row.reservation.projectAdmitCommitSeq = proof.projectAdmitCommitSeq;
				row.reservation.coordinatorEpoch = this.#options.epoch; row.admitRunVersion = proof.runVersion;
				delete row.reservation.reservedExpiresAt; row.updatedAt = observedNow;
			} else if ("status" in proof && proof.status === "not-admitted" && Number.isSafeInteger(proof.runVersion) && proof.runVersion >= 0) {
				row.reservation.state = "expired"; delete row.reservation.reservedExpiresAt; row.updatedAt = observedNow;
			}
		}
	}
	async #transaction<T>(action: string, context: Context | undefined, id: string | undefined, apply: (state: CoordinatorState, identity: CoordinatorIdentity | undefined, now: number) => Promise<T>, authorizationReservation?: ConcurrencyReservation): Promise<T> {
		if (this.#closed) fail("TF_DURABILITY_FAILED", "coordinator store is closed");
		this.#binding();
		const release = await this.#mutex.acquire({ timeoutMs: 30_000, signal: AbortSignal.timeout(30_000) });
		try {
			if (this.#closed) fail("TF_DURABILITY_FAILED", "coordinator store closed during lock admission");
			this.#binding(); const file = path.join(this.storePath, "coordinator.json"), identityFile = path.join(this.storePath, "coordinator.identity.json");
			let storeIdentity: { version: 1; canonicalPath: string; dev: number; ino: number; instanceId: string };
			if (fs.existsSync(identityFile)) {
				storeIdentity = JSON.parse(fs.readFileSync(identityFile, "utf8"));
				if (!Value.Check(Type.Object({ version: Type.Literal(1), canonicalPath: text, dev: integer, ino: integer, instanceId: UuidSchema }, { additionalProperties: false }), storeIdentity) || storeIdentity.canonicalPath !== this.storePath || storeIdentity.dev !== this.#directoryIdentity.dev || storeIdentity.ino !== this.#directoryIdentity.ino) fail("TF_DURABILITY_FAILED", "coordinator genesis directory identity is invalid or changed");
				if (!fs.existsSync(file)) fail("TF_DURABILITY_FAILED", "coordinator authoritative ledger is missing; bootstrap would erase admitted capacity");
			} else {
				if (fs.existsSync(file) || action !== "initialize") fail("TF_DURABILITY_FAILED", "coordinator genesis authority is missing");
				storeIdentity = { version: 1, canonicalPath: this.storePath, ...this.#directoryIdentity, instanceId: randomUUID() };
				await this.#fence(this.#now()); this.#binding(); writeJsonAtomicHardened(identityFile, storeIdentity);
			}
			let state: CoordinatorState;
			if (fs.existsSync(file)) { state = validateState(JSON.parse(fs.readFileSync(file, "utf8"))); }
			else { state = { version: 1, fencingEpoch: this.#options.epoch, commitSeq: 0, lastWallTime: 0, maxActiveRuns: this.#options.initialMaxActiveRuns,
				directoryIdentity: { canonicalPath: this.storePath, ...this.#directoryIdentity }, instanceId: storeIdentity.instanceId, reservations: {}, commands: {}, audit: [], stateHash: "" }; }
			if (state.instanceId !== storeIdentity.instanceId || state.directoryIdentity.canonicalPath !== this.storePath || state.directoryIdentity.dev !== this.#directoryIdentity.dev || state.directoryIdentity.ino !== this.#directoryIdentity.ino) fail("TF_DURABILITY_FAILED", "coordinator directory identity changed; explicit authority rebind is required");
			const before = commandRequestHash(state);
			const now = this.#now(state.lastWallTime); await this.#fence(now);
			if (state.fencingEpoch > this.#options.epoch) fail("TF_AUTHORITY_REVOKED", "persisted coordinator epoch fences this host");
			state.fencingEpoch = this.#options.epoch;
			let identity: CoordinatorIdentity | undefined;
			if (action !== "initialize") {
				identity = structuredClone(await this.#options.authority.authorize(context as Context, action as CoordinatorOperation, structuredClone(id && state.reservations[id] ? state.reservations[id]!.reservation : authorizationReservation)));
				this.#now(now);
				if (!identity?.principal?.trim() || !identity.ownerId?.trim() || typeof identity.operator !== "boolean") fail("TF_AUTHORITY_REVOKED", "trusted authority did not verify a principal and owner");
			}
			await this.#expireReservations(state, this.#now(now));
			const value = await apply(state, identity, now);
			this.#now(now);
			if (action !== "initialize") {
				const currentIdentity = await this.#options.authority.authorize(context as Context, action as CoordinatorOperation, structuredClone(id && state.reservations[id] ? state.reservations[id]!.reservation : authorizationReservation));
				this.#now(now);
				if (!currentIdentity || currentIdentity.principal !== identity!.principal || currentIdentity.ownerId !== identity!.ownerId || currentIdentity.operator !== identity!.operator) fail("TF_AUTHORITY_REVOKED", "live authority changed during coordinator transaction");
			}
			if (this.#closed) fail("TF_DURABILITY_FAILED", "coordinator store closed during transaction");
			this.#binding(); const leaseExpiresAt = await this.#fence(this.#now(now));
			const currentTime = this.#now(now);
			if (commandRequestHash(state) !== before || !fs.existsSync(file)) {
				state.lastWallTime = currentTime;
				state.commitSeq++;
				const body = { commitSeq: state.commitSeq, epoch: state.fencingEpoch, recordedAt: currentTime, action, principal: identity?.principal ?? "coordinator-bootstrap", previousHash: state.audit.at(-1)?.hash ?? ZERO_HASH, stateDigest: businessDigest(state) };
				state.audit.push({ ...body, hash: commandRequestHash(body) }); state.stateHash = hashState(state); validateState(state);
				if (this.#now(currentTime) >= leaseExpiresAt) fail("TF_AUTHORITY_REVOKED", "coordinator lease expired before atomic publication");
				if (process.env[COORDINATOR_CRASH_ENV] === "before-state-write") process.kill(process.pid, "SIGKILL");
				writeJsonAtomicHardened(file, state);
				if (process.env[COORDINATOR_CRASH_ENV] === "after-state-write") process.kill(process.pid, "SIGKILL");
			}
			if (action === "snapshot") Object.assign(value as object, { commitSeq: state.commitSeq, fencingEpoch: state.fencingEpoch });
			return structuredClone(value);
		} catch (error) {
			if (error instanceof ControlError) throw error;
			throw new ControlError("TF_DURABILITY_FAILED", `coordinator transaction failed: ${error instanceof Error ? error.message : String(error)}`, { recoveryAction: "operator", sideEffects: "unknown" });
		} finally { release(); }
	}
}
export async function openCoordinatorStore<Context>(directory: string, options: CoordinatorStoreOptions<Context>): Promise<UserCoordinatorStore<Context>> {
	const store = new UserCoordinatorStore(directory, options);
	try { await store.initialize(); return store; } catch (error) { store.close(); throw error; }
}
