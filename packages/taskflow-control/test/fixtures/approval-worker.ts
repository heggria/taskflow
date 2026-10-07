/** Real project journal + P16 coordinator fixture; no process-local approval store. */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { openControlStore, type ControlStore } from "../../src/store/store.ts";
import { openCoordinatorStore } from "../../src/store/coordinator-store.ts";
import { createAuthorizationAuthority, AUTHORIZATION_CAPABILITIES, type VerifiedContext } from "../../src/authorization.ts";
import { ApprovalService, type ApprovalStorage, type ApprovalRun, type ApprovalAuthority, type ApprovalRequestInput, type ApprovalDecisionInput } from "../../src/approval-service.ts";
import { ControlError, errorToEnvelope } from "../../src/errors.ts";
import { CONTROL_WIRE_SCHEMA_VERSION } from "../../src/schema/common.ts";

type SeedStore = ControlStore & ApprovalStorage & { createRun(run: ApprovalRun, events: readonly never[]): ApprovalRun };
export async function approvalFixture(directory: string) {
	const store = openControlStore(join(directory, "project-store")) as SeedStore;
	const binding = { projectId: store.header.projectId, controlDomainId: store.header.controlDomainId, projectRoot: directory };
	const uid = process.getuid?.() ?? 1000;
	let revoked = false, durable = true, quiescent = true, releaseFailure = false, commitFailure = false, editDelay = 0;
	let invalidEdit = false, reusedOwner = false, policyHash = "a".repeat(64), relinks = 0;
	const auth = createAuthorizationAuthority({ ownerUid: uid, bootstrapSecret: randomBytes(32), hostBaseline: AUTHORIZATION_CAPABILITIES,
		loadLivePolicy: () => ({ host: {}, ...(revoked ? { revokedPrincipals: [`os-user:${uid}`] } : {}) }) });
	const context = auth.issueStandalone(binding), secondContext = auth.issueStandalone(binding);
	const principal = auth.identity(context).principal;
	async function authorize(ctx: VerifiedContext, operation: string) {
		return auth.authorize(ctx, { ...binding, operation: operation === "read" ? "read" : "submit",
			...(operation === "read" ? {} : { commandKind: operation === "decide" ? "approval.decide" as const : "run.submit" as const }) });
	}
	const coordinator = await openCoordinatorStore(join(directory, "coordinator"), { initialMaxActiveRuns: 2, epoch: 1, holderId: "fixture", authority: {
		readLease: () => ({ holderId: "fixture", fencingEpoch: 1, endpoint: "fixture", expiresAt: Date.now() + 60_000 }),
		authorize: async (ctx: VerifiedContext) => ({ principal: (await authorize(ctx, "request")).callerPrincipal, ownerId: `fixture:${binding.projectId}`, operator: false }),
		readAdmission: (reservation) => {
			const run = store.readRun(reservation.runId);
			if (!run || run.reservationId !== reservation.reservationId) return { status: "not-admitted" as const, reservationId: reservation.reservationId, projectId: reservation.projectId, projectControlDomainId: reservation.projectControlDomainId, runId: reservation.runId, runVersion: run?.runVersion ?? 0 };
			if (reservation.state === "reserved" && (run.status !== "running" || !["admitted", "executing"].includes(run.stage))) return null;
			return { reservationId: reservation.reservationId, projectId: run.projectId, projectControlDomainId: run.controlDomainId, runId: run.runId, projectAdmitCommitSeq: run.projectAdmitCommitSeq!, runVersion: run.runVersion };
		},
		readRelease: (reservation) => {
			const run = store.readRun(reservation.runId)!;
			const intent = store.readOutbox(run.runId).find((item) => item.kind === "approval.release" && item.reservationId === reservation.reservationId);
			if (!intent || intent.kind !== "approval.release") throw new ControlError("TF_AUTHORITY_REVOKED", "no durable release evidence");
			return { ...intent.evidence, reservationId: reservation.reservationId, runVersion: run.runVersion, status: run.status, stage: run.stage, requiresReadmission: run.requiresReadmission === true,
				providerNoLiveProcessTree: quiescent && intent.evidence.providerNoLiveProcessTree && intent.evidence.noPendingResourceIntents,
				noAmbiguousJobs: quiescent && intent.evidence.noAmbiguousJobs };
		},
	} });
	let service!: ApprovalService<VerifiedContext>;
	const authority: ApprovalAuthority<VerifiedContext> = {
		authorize: async (ctx, scope) => {
			const decision = await authorize(ctx, scope.operation);
			if (scope.request && scope.operation !== "request") {
				const request = scope.request;
				if (decision.callerPrincipal !== request.owner && !request.audience?.includes(decision.callerPrincipal)) throw new ControlError("TF_POLICY_DENIED", "approval audience denied");
				if (request.requiredPrincipals?.length && !request.requiredPrincipals.includes(decision.callerPrincipal)) throw new ControlError("TF_POLICY_DENIED", "required principal denied");
			}
			return decision;
		},
		validateRequest: async (_ctx, _run, node) => { if (node !== "review" && node !== "review2") throw new ControlError("TF_COMMAND_FAILED", "not a reached approval node"); },
		negotiateDurability: async () => durable,
		quiescence: async (_ctx, run) => ({ proofId: randomUUID(), ...binding, projectControlDomainId: run.controlDomainId,
			runId: run.runId, projectAdmitCommitSeq: run.projectAdmitCommitSeq!, providerNoLiveProcessTree: quiescent,
			noAmbiguousJobs: quiescent, noPendingResourceIntents: quiescent, reconcileTimeoutOnly: false }),
		validateEdit: async (_ctx, _run, _request, edit) => {
			if (editDelay) await new Promise<void>((resolve) => setTimeout(resolve, editDelay));
			const bytes = readFileSync(join(directory, `artifact-${edit.artifact.digest}`));
			if (invalidEdit || bytes.length !== edit.artifact.size || createHash("sha256").update(bytes).digest("hex") !== edit.artifact.digest
				|| typeof JSON.parse(bytes.toString()).guidance !== "string") throw new ControlError("TF_COMMAND_FAILED", "edited output violates contract");
		},
		prepareReadmission: async (ctx, run, request) => {
			if (request.editKind === "plan") relinks++;
			const authorization = await authorize(ctx, "readmit");
			const fresh = randomUUID(), digest = createHash("sha256").update(fresh).digest("hex");
			return { policyHash, authorizationContextHash: authorization.authorizationContextHash,
				owner: reusedOwner ? run.owner! : { runId: run.runId, phaseId: "next", attemptId: randomUUID(), unitId: randomUUID(), ancestry: [run.runId] },
				fragment: { schemaVersion: CONTROL_WIRE_SCHEMA_VERSION, projectId: run.projectId, controlDomainId: run.controlDomainId, fragmentId: fresh,
					parentBoundPlanHash: run.boundPlanHash, ...(run.boundFragmentHash ? { parentBoundFragmentHash: run.boundFragmentHash } : {}),
					sourceEventId: request.decisionEventId!, sourceCommitSeq: request.decisionCommitSeq!, fragmentIRHash: `ir:${digest}`,
					fragmentPolicyHash: `policy:${policyHash}`, capabilitySetHash: `cap:${digest}`, authorityEpoch: run.authorityEpoch + 1,
					boundFragmentHash: `fragment:${digest}`, executionSemanticHash: `semantic:${digest}` } };
		},
		validateReadmission: async (ctx, _run, intent) => {
			const current = await authorize(ctx, "readmit");
			if (current.authorizationContextHash !== intent.authorizationContextHash || policyHash !== intent.policyHash) throw new ControlError("TF_AUTHORITY_REVOKED", "current policy no longer admits fragment");
		},
		reserve: async (ctx, run) => (await coordinator.reserve({ projectId: run.projectId, projectControlDomainId: run.controlDomainId, runId: run.runId, ttlMs: 60_000 }, ctx)).reservation,
		commitReservation: async (ctx, intent) => {
			if (commitFailure) throw new Error("fixture interruption before coordinator commit");
			await coordinator.commit(intent.reservation.reservationId, { projectAdmitCommitSeq: intent.projectAdmitCommitSeq, attemptId: intent.owner.attemptId }, ctx);
		},
		normalRelease: async (ctx, intent) => {
			await coordinator.normalRelease(intent.reservationId, ctx);
			if (releaseFailure) throw new Error("fixture interruption after coordinator release");
		},
	};
	service = new ApprovalService(store, authority);
	const pointer = join(directory, "fixture-run-id");
	let runId: string;
	if (existsSync(pointer)) runId = readFileSync(pointer, "utf8");
	else {
		runId = randomUUID();
		const reservation = (await coordinator.reserve({ ...binding, projectControlDomainId: binding.controlDomainId, runId, ttlMs: 60_000 }, context)).reservation;
		const run: ApprovalRun = { ...binding, runId, runVersion: 0, status: "running", stage: "executing", slot: "reserved", needsOperator: false,
			boundPlanHash: `plan:${"1".repeat(64)}`, policyHash, authorityEpoch: 1, reservationId: reservation.reservationId,
			owner: { runId, phaseId: "review", attemptId: randomUUID(), unitId: randomUUID(), ancestry: [] }, projectAdmitCommitSeq: store.commitSeq + 1 };
		// projectRoot is a context binding, not a RunSnapshot wire field.
		delete (run as Partial<typeof binding>).projectRoot;
		store.createRun(run, []);
		await coordinator.commit(reservation.reservationId, { projectAdmitCommitSeq: run.projectAdmitCommitSeq!, attemptId: run.owner!.attemptId }, context);
		const current = store.readRun(runId)!;
		store.mutateRun(runId, current.runVersion, (state) => ({ ...state, run: { ...state.run, slot: "committed", runVersion: state.run.runVersion + 1 }, events: [] }));
		writeFileSync(pointer, runId);
	}
	const request = (overrides: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput => ({ runId, expectedRunVersion: store.readRun(runId)!.runVersion,
		nodeInstanceId: "review", mode: "durable-required", allowedDecisions: ["approve", "reject", "edit"], owner: principal,
		deadline: Date.now() + 60_000, timeoutPolicy: "durable-expire", ...overrides });
	const artifact = (guidance = "edited guidance") => {
		const bytes = Buffer.from(JSON.stringify({ guidance })), digest = createHash("sha256").update(bytes).digest("hex");
		writeFileSync(join(directory, `artifact-${digest}`), bytes);
		return { digest, size: bytes.length, mediaType: "application/json", storageClass: "project", redactionClass: "internal" };
	};
	return { store, coordinator, service, context, secondContext, auth, runId, request, artifact, relinks: () => relinks,
		set: (patch: Record<string, unknown>) => {
			if (typeof patch.revoked === "boolean") revoked = patch.revoked;
			if (typeof patch.durable === "boolean") durable = patch.durable;
			if (typeof patch.quiescent === "boolean") quiescent = patch.quiescent;
			if (typeof patch.releaseFailure === "boolean") releaseFailure = patch.releaseFailure;
			if (typeof patch.commitFailure === "boolean") commitFailure = patch.commitFailure;
			if (typeof patch.editDelay === "number") editDelay = patch.editDelay;
			if (typeof patch.invalidEdit === "boolean") invalidEdit = patch.invalidEdit;
			if (typeof patch.reusedOwner === "boolean") reusedOwner = patch.reusedOwner;
			if (typeof patch.policyHash === "string") policyHash = patch.policyHash;
		},
		close: () => { coordinator.close(); store.close(); } };
}

if (process.env.TF_APPROVAL_WORKER_DIR) {
	const fixture = await approvalFixture(process.env.TF_APPROVAL_WORKER_DIR);
	console.log(JSON.stringify({ ready: true, runId: fixture.runId }));
	const lines = createInterface({ input: process.stdin });
	for await (const line of lines) {
		let id: unknown;
		try {
			const input = JSON.parse(line);
			id = input.id;
			let result: unknown;
			if (input.action === "set") { fixture.set(input.patch); result = true; }
			else if (input.action === "request") result = await fixture.service.request(fixture.context, fixture.request(input.patch));
			else if (input.action === "decide") result = await fixture.service.decide(input.client === 2 ? fixture.secondContext : fixture.context, input.body as ApprovalDecisionInput);
			else if (input.action === "readmit") result = await fixture.service.readmit(fixture.context, input.body);
			else if (input.action === "drain") { await fixture.service.drainReleases(fixture.context); result = true; }
			else if (input.action === "read") result = await fixture.service.read(fixture.context, input.approvalRequestId);
			else if (input.action === "run") result = fixture.store.readRun(fixture.runId);
			else throw new Error("unknown fixture action");
			console.log(JSON.stringify({ id: input.id, ok: true, result }));
		} catch (error) { console.log(JSON.stringify({ id, ok: false, error: errorToEnvelope(error) })); }
	}
	fixture.close();
}
