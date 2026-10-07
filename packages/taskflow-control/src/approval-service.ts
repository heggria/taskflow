/** P15 durable approvals. The project journal, not this service, owns all state. */
import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { ControlError } from "./errors.ts";
import { commandRequestHash, type CommandRecord, type ControlEventPayload } from "./schema/commands.ts";
import { ApprovalRequestSchema, type ApprovalRequest, type ApprovalMode, type ApprovalDecision } from "./schema/approval.ts";
import { ArtifactRefSchema, type ArtifactRef } from "./schema/evidence.ts";
import { BoundFragmentSchema, type BoundFragment } from "./schema/plan.ts";
import type { RunSnapshot } from "./schema/run.ts";
import type { ExecutionOwner } from "./schema/te-mirrors.ts";
import type { ConcurrencyReservation } from "./schema/coordinator.ts";
import { UuidSchema } from "./schema/common.ts";

// These structural extensions are shared with the authoritative store adapter;
// no additional persistence file or in-memory authority is maintained here.
export type ApprovalRun = RunSnapshot & {
	runVersion: number; boundPlanHash: string; boundFragmentHash?: string;
	policyHash: string; authorityEpoch: number; reservationId?: string; owner?: ExecutionOwner;
};
export type DurableApprovalRequest = ApprovalRequest;
export interface ApprovalQuiescence {
	proofId: string; projectId: string; projectControlDomainId: string; runId: string;
	projectAdmitCommitSeq: number; providerNoLiveProcessTree: boolean; noAmbiguousJobs: boolean;
	noPendingResourceIntents: boolean; reconcileTimeoutOnly: boolean;
}
export type ApprovalReleaseIntent = {
	kind: "approval.release"; intentId: string; approvalRequestId: string; runId: string;
	reservationId: string; evidence: ApprovalQuiescence; complete: boolean;
};
export type ApprovalReadmissionIntent = {
	kind: "approval.readmission"; intentId: string; approvalRequestId: string; runId: string;
	reservation: ConcurrencyReservation; owner: ExecutionOwner; fragment: BoundFragment;
	policyHash: string; authorizationContextHash: string; projectAdmitCommitSeq: number; complete: boolean;
};
export type ApprovalOutbox = ApprovalReleaseIntent | ApprovalReadmissionIntent;
export type ApprovalJournalEvent = { eventId: string; recordedAt: number; payload: ControlEventPayload };
export interface ApprovalJournalState { run: ApprovalRun; approvals: DurableApprovalRequest[]; outbox: ApprovalOutbox[] }
export interface ApprovalMutation extends ApprovalJournalState { command?: CommandRecord; events: ApprovalJournalEvent[] }
export interface ApprovalCommit extends ApprovalJournalState { commitSeq: number }
export interface ApprovalStorage {
	readRun(runId: string): ApprovalRun | undefined;
	readApproval(approvalRequestId: string): DurableApprovalRequest | undefined;
	listApprovals(): DurableApprovalRequest[];
	readOutbox(runId: string): ApprovalOutbox[];
	/** Synchronous, writer-locked CAS; journal fsync precedes observable state.
	 * The adapter checks runVersion and commits the complete batch atomically. */
	mutateRun(runId: string, expectedRunVersion: number,
		build: (state: ApprovalJournalState, meta: { commitSeq: number }) => ApprovalMutation): ApprovalCommit;
}
export type ApprovalOperation = "request" | "read" | "decide" | "cancel" | "expire" | "park" | "readmit";
export type ApprovalAuthorization = { callerPrincipal: string; authorizationContextHash: string };
export interface ApprovalAuthority<C> {
	/** Context is issued by the host's trusted identity authority; wire identity
	 * labels are never an input to authorization. Must evaluate current policy. */
	authorize(context: C, scope: { operation: ApprovalOperation; run: ApprovalRun; request?: DurableApprovalRequest }): Promise<ApprovalAuthorization>;
	validateRequest(context: C, run: ApprovalRun, nodeInstanceId: string): Promise<void>;
	/** Evaluate actual host offers and this authenticated caller's handshake. */
	negotiateDurability(context: C, run: ApprovalRun, mode: ApprovalMode): Promise<boolean>;
	quiescence(context: C, run: ApprovalRun): Promise<ApprovalQuiescence>;
	validateEdit(context: C, run: ApprovalRun, request: DurableApprovalRequest, edit: { kind: "output" | "plan"; artifact: ArtifactRef }): Promise<void>;
	/** Output edits are contract-checked; plan edits must re-Link. Both obtain
	 * current policy/capabilities and a new attenuated BoundFragment. */
	prepareReadmission(context: C, run: ApprovalRun, request: DurableApprovalRequest): Promise<{
		fragment: BoundFragment; owner: ExecutionOwner; policyHash: string; authorizationContextHash: string;
	}>;
	validateReadmission(context: C, run: ApprovalRun, intent: ApprovalReadmissionIntent): Promise<void>;
	reserve(context: C, run: ApprovalRun, owner: ExecutionOwner): Promise<ConcurrencyReservation>;
	commitReservation(context: C, intent: ApprovalReadmissionIntent): Promise<void>;
	normalRelease(context: C, intent: ApprovalReleaseIntent): Promise<void>;
}
export interface ApprovalRequestInput {
	runId: string; expectedRunVersion: number; nodeInstanceId: string; mode: ApprovalMode;
	allowedDecisions: ApprovalDecision[]; owner: string; audience?: string[]; requiredPrincipals?: string[];
	deadline: number; timeoutPolicy: ApprovalRequest["timeoutPolicy"];
}
export interface ApprovalDecisionInput {
	commandId: string; runId: string; approvalRequestId: string; expectedRunVersion: number;
	decision: ApprovalDecision; editArtifactRef?: ArtifactRef; editKind?: "output" | "plan";
}

function stale(message: string): never { throw new ControlError("TF_STALE_VERSION", message); }
function invalid(message: string): never { throw new ControlError("TF_COMMAND_FAILED", message); }
function revoked(message: string): never { throw new ControlError("TF_AUTHORITY_REVOKED", message); }
function event(payload: ControlEventPayload): ApprovalJournalEvent { return { eventId: randomUUID(), recordedAt: Date.now(), payload }; }
function advance(state: ApprovalJournalState, changes: Partial<ApprovalJournalState>, events: ApprovalJournalEvent[], command?: CommandRecord): ApprovalMutation {
	const run = { ...state.run, ...changes.run, runVersion: state.run.runVersion + 1 };
	const approvals = (changes.approvals ?? state.approvals).map((request) => request.status === "pending" ? { ...request, expectedRunVersion: run.runVersion } : request);
	const outbox = changes.outbox ?? state.outbox;
	const lifecycle: ApprovalJournalEvent[] = [];
	for (const intent of outbox) {
		const previous = state.outbox.find((item) => item.intentId === intent.intentId);
		if (!previous || !previous.complete && intent.complete) lifecycle.push(event({
			kind: intent.kind === "approval.release" ? intent.complete ? "approval.release.completed" : "approval.release.queued" : intent.complete ? "approval.readmission.completed" : "approval.readmission.queued",
			approvalRequestId: intent.approvalRequestId, intentId: intent.intentId,
			reservationId: intent.kind === "approval.release" ? intent.reservationId : intent.reservation.reservationId,
		}));
	}
	return { run, approvals, outbox, events: [...events, ...lifecycle, event({ kind: "run.snapshot", run })], ...(command ? { command } : {}) };
}

export class ApprovalService<C = unknown> {
	readonly storage: ApprovalStorage;
	readonly authority: ApprovalAuthority<C>;
	constructor(storage: ApprovalStorage, authority: ApprovalAuthority<C>) {
		this.storage = storage; this.authority = authority;
		for (const name of ["authorize", "validateRequest", "negotiateDurability", "quiescence", "validateEdit", "prepareReadmission", "validateReadmission", "reserve", "commitReservation", "normalRelease"] as const) {
			if (typeof authority[name] !== "function") revoked(`approval authority requires ${name}`);
		}
	}
	#run(id: string): ApprovalRun { return this.storage.readRun(id) ?? invalid("approval requires an existing durable run"); }
	#request(id: string): DurableApprovalRequest { return this.storage.readApproval(id) ?? invalid("approval request does not exist"); }
	#checkQuiescence(run: ApprovalRun, proof: ApprovalQuiescence): boolean {
		return Boolean(proof.proofId && proof.runId === run.runId && proof.projectId === run.projectId
			&& proof.projectControlDomainId === run.controlDomainId && proof.projectAdmitCommitSeq === run.projectAdmitCommitSeq
			&& proof.providerNoLiveProcessTree === true && proof.noAmbiguousJobs === true
			&& proof.noPendingResourceIntents === true && proof.reconcileTimeoutOnly === false);
	}
	#release(state: ApprovalJournalState, requestId: string, proof?: ApprovalQuiescence): ApprovalOutbox[] {
		if (!proof || !state.run.reservationId || !this.#checkQuiescence(state.run, proof)
			|| state.outbox.some((item) => item.kind === "approval.release" && item.reservationId === state.run.reservationId && !item.complete)) return state.outbox;
		return [...state.outbox, { kind: "approval.release", intentId: randomUUID(), approvalRequestId: requestId, runId: state.run.runId, reservationId: state.run.reservationId, evidence: proof, complete: false }];
	}
	async read(context: C, approvalRequestId: string): Promise<DurableApprovalRequest> {
		const request = this.#request(approvalRequestId);
		await this.authority.authorize(context, { operation: "read", run: this.#run(request.runId), request });
		return structuredClone(request);
	}
	async request(context: C, input: ApprovalRequestInput): Promise<DurableApprovalRequest> {
		const run = this.#run(input.runId);
		if (!["compat-auto-reject", "durable-optional", "durable-required"].includes(input.mode)) invalid("unknown approval mode");
		await this.authority.authorize(context, { operation: "request", run });
		await this.authority.validateRequest(context, run, input.nodeInstanceId);
		const durable = input.mode !== "compat-auto-reject" && await this.authority.negotiateDurability(context, run, input.mode);
		if (input.mode === "durable-required" && !durable) throw new ControlError("TF_FEATURE_REQUIRED", "durable approval must be negotiated at Link/Admit");
		const request: DurableApprovalRequest = {
			approvalRequestId: randomUUID(), runId: run.runId, nodeInstanceId: input.nodeInstanceId,
			boundPlanHash: run.boundPlanHash, ...(run.boundFragmentHash ? { boundFragmentHash: run.boundFragmentHash } : {}),
			expectedRunVersion: input.expectedRunVersion + 1, allowedDecisions: input.allowedDecisions,
			owner: input.owner, ...(input.audience ? { audience: input.audience } : {}),
			...(input.requiredPrincipals ? { requiredPrincipals: input.requiredPrincipals } : {}),
			deadline: input.deadline, timeoutPolicy: input.timeoutPolicy, status: durable ? "pending" : "rejected", createdAt: Date.now(),
		};
		if (!Value.Check(ApprovalRequestSchema, request) || new Set(request.allowedDecisions).size !== request.allowedDecisions.length) invalid("invalid approval request");
		const proof = await this.authority.quiescence(context, run);
		await this.authority.authorize(context, { operation: "request", run, request });
		this.storage.mutateRun(run.runId, input.expectedRunVersion, (state) => {
			if (["completed", "failed", "blocked", "cancelled", "unknown"].includes(state.run.status)
				|| !["admitted", "executing", "parked", "reconciling"].includes(state.run.stage)
				|| !Number.isSafeInteger(state.run.projectAdmitCommitSeq) || state.run.projectAdmitCommitSeq! < 1) stale("run cannot request approval before durable admission or after terminal state");
			if (state.approvals.some((item) => item.nodeInstanceId === request.nodeInstanceId && item.status === "pending")) stale("node already has pending approval");
			const expired = durable && request.deadline <= Date.now();
			const settled = !durable || expired;
			const parked = !settled && proof && this.#checkQuiescence(state.run, proof);
			const stored = { ...request, ...(expired ? { status: "expired" as const, decidedAt: Date.now() } : !durable ? { decidedAt: Date.now() } : {}) };
			const nextRun = { ...state.run, requiresReadmission: !settled, status: settled ? "blocked" as const : "paused" as const, stage: settled ? "terminal" as const : parked ? "parked" as const : "reconciling" as const };
			return advance(state, { run: nextRun, approvals: [...state.approvals, stored], outbox: this.#release(state, request.approvalRequestId, proof) }, [event(settled
				? { kind: "approval.settled", approvalRequestId: stored.approvalRequestId, decision: expired ? "expired" : "rejected" }
				: { kind: "approval.pending", approvalRequestId: stored.approvalRequestId, request: stored })]);
		});
		await this.drainReleases(context, run.runId);
		return this.read(context, request.approvalRequestId);
	}
	async decide(context: C, input: ApprovalDecisionInput): Promise<DurableApprovalRequest> {
		input = structuredClone(input);
		if (!Value.Check(UuidSchema, input.commandId) || !Number.isSafeInteger(input.expectedRunVersion) || input.expectedRunVersion < 0) invalid("invalid decision command identity/version");
		const request = this.#request(input.approvalRequestId), run = this.#run(input.runId);
		if (request.runId !== run.runId) invalid("approval does not belong to this run");
		if (!["approve", "reject", "edit"].includes(input.decision) || !request.allowedDecisions.includes(input.decision)) invalid("decision not allowed");
		await this.authority.authorize(context, { operation: "decide", run, request });
		if (input.decision === "edit") {
			if (!input.editArtifactRef || !Value.Check(ArtifactRefSchema, input.editArtifactRef) || !["output", "plan"].includes(input.editKind ?? "")) invalid("edit requires typed guidance artifact");
			await this.authority.validateEdit(context, run, request, { kind: input.editKind!, artifact: input.editArtifactRef! });
		} else if (input.editKind !== undefined || input.editArtifactRef !== undefined) invalid("edit payload requires edit decision");
		const proof = await this.authority.quiescence(context, run);
		const auth = await this.authority.authorize(context, { operation: "decide", run: this.#run(run.runId), request: this.#request(request.approvalRequestId) });
		let expired = false;
		this.storage.mutateRun(run.runId, input.expectedRunVersion, (state, meta) => {
			const current = state.approvals.find((item) => item.approvalRequestId === request.approvalRequestId) ?? invalid("missing approval");
			if (current.status !== "pending" || state.run.status !== "paused" || current.expectedRunVersion !== input.expectedRunVersion) stale("approval is already settled or run changed");
			if (current.deadline <= Date.now()) {
				expired = true;
				return this.#expireMutation(state, current, proof);
			}
			const decisionEvent = event({ kind: "approval.settled", approvalRequestId: current.approvalRequestId, decision: input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "edited" });
			const decided: DurableApprovalRequest = { ...current, status: input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "edited", decidedAt: Date.now(), decisionCommandId: input.commandId, decisionEventId: decisionEvent.eventId, decisionCommitSeq: meta.commitSeq,
				...(input.decision === "edit" ? { editKind: input.editKind, editArtifactRef: input.editArtifactRef } : {}) };
			const approvals = state.approvals.map((item) => item.approvalRequestId === current.approvalRequestId ? decided : input.decision === "reject" && item.status === "pending" ? { ...item, status: "cancelled" as const, decidedAt: Date.now() } : item);
			const stillPending = approvals.some((item) => item.status === "pending");
			const nextRun = { ...state.run, requiresReadmission: input.decision !== "reject", status: input.decision === "reject" ? "blocked" as const : stillPending ? "paused" as const : "running" as const, stage: input.decision === "reject" ? "terminal" as const : stillPending ? state.run.stage : "queued" as const };
			const command: CommandRecord = { commandId: input.commandId, kind: "approval.decide", requestHash: commandRequestHash(input), callerPrincipal: auth.callerPrincipal, authorizationContextHash: auth.authorizationContextHash,
				projectId: run.projectId, controlDomainId: run.controlDomainId, status: "completed", firstCommitSeq: meta.commitSeq, lastCommitSeq: meta.commitSeq, recordedAt: Date.now() };
			return advance(state, { run: nextRun, approvals, ...(input.decision === "reject" ? { outbox: this.#release(state, current.approvalRequestId, proof) } : {}) }, [decisionEvent], command);
		});
		if (expired) stale("approval expired; late decisions cannot be committed");
		return this.read(context, request.approvalRequestId);
	}
	#expireMutation(state: ApprovalJournalState, request: DurableApprovalRequest, proof?: ApprovalQuiescence): ApprovalMutation {
		return advance(state, { run: { ...state.run, status: "blocked", stage: "terminal", requiresReadmission: false }, outbox: this.#release(state, request.approvalRequestId, proof), approvals: state.approvals.map((item) => item.status !== "pending" ? item : { ...item, status: item.approvalRequestId === request.approvalRequestId ? "expired" : "cancelled", decidedAt: Date.now() }) }, state.approvals.filter((item) => item.status === "pending").map((item) => event({ kind: "approval.settled", approvalRequestId: item.approvalRequestId, decision: item.approvalRequestId === request.approvalRequestId ? "expired" : "cancelled" })));
	}
	async expireDue(context: C): Promise<number> {
		let count = 0;
		for (const request of this.storage.listApprovals()) {
			if (request.status !== "pending" || request.deadline > Date.now()) continue;
			const run = this.#run(request.runId);
			await this.authority.authorize(context, { operation: "expire", run, request });
			const proof = await this.authority.quiescence(context, run);
			await this.authority.authorize(context, { operation: "expire", run: this.#run(run.runId), request: this.#request(request.approvalRequestId) });
			try { this.storage.mutateRun(run.runId, run.runVersion, (state) => {
				const current = state.approvals.find((item) => item.approvalRequestId === request.approvalRequestId);
				if (!current || current.status !== "pending" || current.deadline > Date.now()) stale("expiry lost CAS");
				return this.#expireMutation(state, current, proof);
			}); count++; } catch (error) { if (!(error instanceof ControlError) || error.code !== "TF_STALE_VERSION") throw error; }
		}
		return count;
	}
	async cancel(context: C, input: { commandId: string; runId: string; expectedRunVersion: number }): Promise<ApprovalRun> {
		if (!Value.Check(UuidSchema, input.commandId)) invalid("cancel requires a command ID");
		const run = this.#run(input.runId);
		await this.authority.authorize(context, { operation: "cancel", run });
		const proof = await this.authority.quiescence(context, run);
		const authorization = await this.authority.authorize(context, { operation: "cancel", run: this.#run(run.runId) });
		return this.storage.mutateRun(run.runId, input.expectedRunVersion, (state, meta) => {
			if (["completed", "failed", "blocked", "cancelled"].includes(state.run.status)) stale("terminal run history cannot be cancelled again");
			const command: CommandRecord = { commandId: input.commandId, kind: "run.cancel", requestHash: commandRequestHash(input), callerPrincipal: authorization.callerPrincipal,
				authorizationContextHash: authorization.authorizationContextHash, projectId: run.projectId, controlDomainId: run.controlDomainId, status: "completed", firstCommitSeq: meta.commitSeq, lastCommitSeq: meta.commitSeq, recordedAt: Date.now() };
			return advance(state, {
			run: { ...state.run, requiresReadmission: false, status: this.#checkQuiescence(state.run, proof) ? "cancelled" : "unknown", stage: this.#checkQuiescence(state.run, proof) ? "terminal" : "reconciling", needsOperator: !this.#checkQuiescence(state.run, proof) },
			approvals: state.approvals.map((item) => item.status === "pending" ? { ...item, status: "cancelled" as const, decidedAt: Date.now() } : item),
			outbox: this.#release(state, state.approvals.at(-1)?.approvalRequestId ?? invalid("run has no approval"), proof),
		}, state.approvals.filter((item) => item.status === "pending").map((item) => event({ kind: "approval.settled", approvalRequestId: item.approvalRequestId, decision: "cancelled" })), command);
		}).run;
	}
	/** Re-prove quiescence after a non-quiescent pause; never infer it from status. */
	async park(context: C, input: { runId: string; expectedRunVersion: number }): Promise<ApprovalRun> {
		const run = this.#run(input.runId);
		await this.authority.authorize(context, { operation: "park", run });
		const proof = await this.authority.quiescence(context, run);
		await this.authority.authorize(context, { operation: "park", run: this.#run(run.runId) });
		this.storage.mutateRun(run.runId, input.expectedRunVersion, (state) => {
			if (!(state.run.status === "paused" || state.run.status === "running" && state.run.stage === "queued") || state.run.requiresReadmission !== true) stale("terminal or executing runs cannot be revived by park");
			if (!this.#checkQuiescence(state.run, proof)) throw new ControlError("TF_RECONCILE_REQUIRED", "park requires fresh TE quiescence", { recoveryAction: "operator", sideEffects: "unknown" });
			const approval = state.approvals.find((item) => item.status === "pending" || item.status === "approved" || item.status === "edited") ?? invalid("run has no durable approval");
			const intent: ApprovalReleaseIntent[] = state.run.reservationId ? [{ kind: "approval.release", intentId: randomUUID(), approvalRequestId: approval.approvalRequestId, runId: run.runId, reservationId: state.run.reservationId, evidence: proof, complete: false }] : [];
			return advance(state, { run: { ...state.run, status: "paused", stage: "parked", requiresReadmission: true }, outbox: [...state.outbox.filter((item) => item.kind !== "approval.release" || item.complete), ...intent] }, []);
		});
		await this.drainReleases(context, run.runId);
		return this.#run(run.runId);
	}
	/** Terminal status may precede process/TE settlement. Once settlement is
	 * proven, discharge capacity without reopening or changing terminal history. */
	async releaseTerminal(context: C, input: { runId: string; expectedRunVersion: number }): Promise<ApprovalRun> {
		const run = this.#run(input.runId);
		await this.authority.authorize(context, { operation: "park", run });
		const proof = await this.authority.quiescence(context, run);
		await this.authority.authorize(context, { operation: "park", run: this.#run(run.runId) });
		this.storage.mutateRun(run.runId, input.expectedRunVersion, (state) => {
			if (!["completed", "failed", "blocked", "cancelled"].includes(state.run.status)) stale("terminal release requires terminal run");
			if (!this.#checkQuiescence(state.run, proof)) throw new ControlError("TF_RECONCILE_REQUIRED", "terminal release requires fresh TE quiescence", { recoveryAction: "operator", sideEffects: "unknown" });
			const approval = state.approvals.at(-1) ?? invalid("run has no approval history");
			return advance(state, { run: { ...state.run, requiresReadmission: false }, outbox: this.#release(state, approval.approvalRequestId, proof) }, []);
		});
		await this.drainReleases(context, run.runId);
		return this.#run(run.runId);
	}
	async drainReleases(context: C, runId?: string): Promise<void> {
		const ids = runId ? [runId] : [...new Set(this.storage.listApprovals().map((request) => request.runId))];
		for (const id of ids) for (const item of this.storage.readOutbox(id)) {
			if (item.kind !== "approval.release" || item.complete) continue;
			const run = this.#run(id);
			await this.authority.authorize(context, { operation: "park", run });
			await this.authority.normalRelease(context, item);
			const current = this.#run(id);
			await this.authority.authorize(context, { operation: "park", run: current });
			this.storage.mutateRun(id, current.runVersion, (state) => {
				const found = state.outbox.find((intent) => intent.intentId === item.intentId);
				if (!found || found.complete || state.run.reservationId !== item.reservationId) stale("release intent changed");
				const queued = !state.approvals.some((request) => request.status === "pending") && state.approvals.some((request) => request.status === "approved" || request.status === "edited");
				return advance(state, { run: { ...state.run, slot: "released", ...(queued && state.run.status === "paused" ? { status: "running" as const, stage: "queued" as const } : {}) }, outbox: state.outbox.map((intent) => intent.intentId === item.intentId ? { ...intent, complete: true } : intent) }, []);
			});
		}
	}
	async readmit(context: C, input: { approvalRequestId: string; expectedRunVersion: number }): Promise<ApprovalRun> {
		const request = this.#request(input.approvalRequestId), run = this.#run(request.runId);
		if (run.runVersion !== input.expectedRunVersion) stale("readmission run version changed");
		await this.authority.authorize(context, { operation: "readmit", run, request });
		const pending = this.storage.readOutbox(run.runId).find((item): item is ApprovalReadmissionIntent => item.kind === "approval.readmission" && !item.complete);
		if (pending) return this.#finishReadmission(context, pending);
		if (!["approved", "edited"].includes(request.status) || run.stage !== "queued" || !["released", "none"].includes(run.slot)) stale("approved run must queue and release its old reservation before readmission");
		const prepared = await this.authority.prepareReadmission(context, run, request);
		const auth = await this.authority.authorize(context, { operation: "readmit", run: this.#run(run.runId), request: this.#request(request.approvalRequestId) });
		const { fragment, owner } = prepared;
		if (!Value.Check(BoundFragmentSchema, fragment) || fragment.projectId !== run.projectId || fragment.controlDomainId !== run.controlDomainId
			|| fragment.parentBoundPlanHash !== run.boundPlanHash || fragment.parentBoundFragmentHash !== run.boundFragmentHash
			|| fragment.sourceEventId !== request.decisionEventId || fragment.sourceCommitSeq !== request.decisionCommitSeq
			|| fragment.boundFragmentHash === run.boundFragmentHash || fragment.authorityEpoch < run.authorityEpoch
			|| !fragment.fragmentPolicyHash.endsWith(`:${prepared.policyHash}`) || prepared.authorizationContextHash !== auth.authorizationContextHash
			|| owner.runId !== run.runId || !owner.attemptId || !owner.unitId || owner.attemptId === run.owner?.attemptId || owner.unitId === run.owner?.unitId) revoked("readmission must bind fresh policy, fragment and execution owner");
		const reservation = await this.authority.reserve(context, run, owner);
		if (reservation.reservationId === run.reservationId || reservation.runId !== run.runId || reservation.projectId !== run.projectId
			|| reservation.projectControlDomainId !== run.controlDomainId || reservation.state !== "reserved") revoked("readmission requires a new bound reservation");
		await this.authority.authorize(context, { operation: "readmit", run: this.#run(run.runId), request: this.#request(request.approvalRequestId) });
		const committed = this.storage.mutateRun(run.runId, input.expectedRunVersion, (state, meta) => {
			if (state.run.stage !== "queued" || state.approvals.some((item) => item.status === "pending")) stale("readmission state changed");
			const intent: ApprovalReadmissionIntent = { kind: "approval.readmission", intentId: randomUUID(), approvalRequestId: request.approvalRequestId, runId: run.runId, reservation, owner, fragment,
				policyHash: prepared.policyHash, authorizationContextHash: auth.authorizationContextHash, projectAdmitCommitSeq: meta.commitSeq, complete: false };
			return advance(state, { run: { ...state.run, status: "running", stage: "admitted", slot: "reserved", reservationId: reservation.reservationId, owner, policyHash: prepared.policyHash, authorityEpoch: fragment.authorityEpoch, boundFragmentHash: fragment.boundFragmentHash, projectAdmitCommitSeq: meta.commitSeq }, outbox: [...state.outbox, intent] }, []);
		});
		const intent = committed.outbox.find((item): item is ApprovalReadmissionIntent => item.kind === "approval.readmission" && !item.complete)!;
		return this.#finishReadmission(context, intent);
	}
	async #finishReadmission(context: C, intent: ApprovalReadmissionIntent): Promise<ApprovalRun> {
		const run = this.#run(intent.runId), request = this.#request(intent.approvalRequestId);
		const assertAdmitted = (current: ApprovalRun) => {
			if (current.status !== "running" || current.stage !== "admitted" || current.requiresReadmission !== true
				|| current.reservationId !== intent.reservation.reservationId || current.owner?.attemptId !== intent.owner.attemptId
				|| !["approved", "edited"].includes(this.#request(intent.approvalRequestId).status)) stale("readmission was cancelled or changed");
		};
		assertAdmitted(run);
		await this.authority.authorize(context, { operation: "readmit", run, request });
		await this.authority.validateReadmission(context, run, intent);
		await this.authority.authorize(context, { operation: "readmit", run: this.#run(run.runId), request: this.#request(request.approvalRequestId) });
		assertAdmitted(this.#run(run.runId));
		await this.authority.commitReservation(context, intent);
		const current = this.#run(run.runId);
		await this.authority.validateReadmission(context, current, intent);
		await this.authority.authorize(context, { operation: "readmit", run: this.#run(run.runId), request: this.#request(request.approvalRequestId) });
		return this.storage.mutateRun(run.runId, current.runVersion, (state) => {
			const pending = state.outbox.find((item) => item.intentId === intent.intentId);
			if (!pending || pending.complete || state.run.stage !== "admitted" || state.run.reservationId !== intent.reservation.reservationId || state.run.owner?.attemptId !== intent.owner.attemptId) stale("readmission intent changed");
			return advance(state, { run: { ...state.run, slot: "committed", requiresReadmission: false }, outbox: state.outbox.map((item) => item.intentId === intent.intentId ? { ...item, complete: true } : item) }, []);
		}).run;
	}
}
