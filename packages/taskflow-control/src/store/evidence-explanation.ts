/** Authorized diagnostics from the real project journal and TE checkpoint. */
import { formatWhyStale, readMapOf, declaredReadMapOfDef } from "taskflow-core/stale";
import { whyEffectFromDurableJournal } from "taskflow-core/effects/why";
import type { RunState } from "taskflow-core";
import { ControlError } from "../errors.ts";
import type { ControlStore } from "./store.ts";
import type { EvidenceStoreOptions } from "./evidence-store.ts";

export interface EvidenceDiagnostic {
	runId: string;
	projectId: string;
	controlDomainId: string;
	state: RunState;
	controlDirectory: string;
	projectRoot: string;
}
export interface EvidenceExplanationQuery { effectId?: string; phaseId?: string; seeds?: string[] }
export interface EvidenceExplanationOptions {
	authorize: EvidenceStoreOptions["authorize"];
	/** Trusted provider reader; callers cannot select a checkpoint or journal path. */
	readDiagnostic(runId: string): EvidenceDiagnostic | undefined | Promise<EvidenceDiagnostic | undefined>;
}

export async function explainControlEvidence(store: ControlStore, actor: unknown, runId: string,
	options: EvidenceExplanationOptions, query: EvidenceExplanationQuery = {}) {
	if (query.effectId !== undefined && (typeof query.effectId !== "string" || !query.effectId.trim())
		|| query.phaseId !== undefined && (typeof query.phaseId !== "string" || !query.phaseId.trim())
		|| query.seeds !== undefined && (!Array.isArray(query.seeds) || query.seeds.some(seed => typeof seed !== "string" || !seed.trim()))) {
		throw new ControlError("TF_COMMAND_FAILED", "invalid evidence diagnostic selector");
	}
	return store.withWriter(async () => {
		const header = store.header;
		const authorize = async () => {
			const auth = await options.authorize(actor, { projectId: header.projectId, controlDomainId: header.controlDomainId,
				target: { kind: "run", id: runId } });
			if (!auth?.principal || !/^[a-f0-9]{64}$/.test(auth.authorizationContextHash)) throw new ControlError("TF_POLICY_DENIED", "diagnostic authority unavailable");
		};
		await authorize();
		const batches = store.readJournal();
		const run = store.readRun(runId);
		if (!run) throw new ControlError("TF_POLICY_DENIED", "run is absent from this project");
		const diagnostic = await options.readDiagnostic(runId);
		if (diagnostic && (diagnostic.runId !== runId || diagnostic.state.runId !== runId
			|| diagnostic.projectId !== header.projectId || diagnostic.controlDomainId !== header.controlDomainId)) {
			throw new ControlError("TF_DURABILITY_FAILED", "runtime checkpoint identity differs from the project journal");
		}
		const stale = diagnostic ? formatWhyStale(runId, diagnostic.state.flowName, readMapOf(diagnostic.state.phases),
			query.seeds ?? [], declaredReadMapOfDef(diagnostic.state.def)) : undefined;
		const effect = query.effectId && diagnostic ? await whyEffectFromDurableJournal({ flow: diagnostic.state.def,
			runId, effectId: query.effectId, phaseId: query.phaseId, workspaceRoot: diagnostic.projectRoot,
			controlDirectory: diagnostic.controlDirectory }) : undefined;
		await authorize();
		// Validate authoritative bytes again after the asynchronous TE journal read.
		store.readJournal();
		const events = batches.flatMap(batch => batch.events).filter(event => event.correlationId === runId);
		return {
			runId, projectId: header.projectId, controlDomainId: header.controlDomainId,
			status: run.status, stage: run.stage, slot: run.slot, needsOperator: run.needsOperator,
			journalCommitSeq: store.commitSeq,
			lifecycle: events.map(event => ({ eventId: event.eventId, commitSeq: event.commitSeq, recordedAt: event.recordedAt, payload: event.payload })),
			pendingApprovals: store.listApprovals().filter(approval => approval.runId === runId && approval.status === "pending")
				.map(approval => ({ approvalRequestId: approval.approvalRequestId, nodeInstanceId: approval.nodeInstanceId, deadline: approval.deadline })),
			receiptIssued: batches.some(batch => batch.recordKind === "lifecycle-batch" && batch.receipt?.runId === runId),
			checkpoint: diagnostic ? { available: true as const, updatedAt: diagnostic.state.updatedAt, runtimeStatus: diagnostic.state.status, stale,
				...(effect ? { effect } : {}) } : { available: false as const, reason: "provider has no durable checkpoint for this run" },
		};
	});
}
