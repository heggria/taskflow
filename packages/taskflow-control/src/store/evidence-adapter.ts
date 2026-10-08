/** Evidence derived exclusively from the validated ControlStore journal. */
import { canonicalJson } from "taskflow-core/flowir/hash";
import { ControlError } from "../errors.ts";
import type { ArtifactRef } from "../schema/index.ts";
import { ControlStore } from "./store.ts";
import { JOURNAL_GENESIS, journalHash, type JournalBatch } from "./journal.ts";
import {
	createEvidenceStore, evidenceEventHash, type EvidenceLedgerView,
	type EvidenceStore, type EvidenceStoreOptions, type PreparedEvidenceReceipt,
} from "./evidence-store.ts";

export type ControlEvidenceOptions = Pick<EvidenceStoreOptions, "authorize" | "terminalEvidence" | "onDurabilityPoint">;

function fail(message: string): never {
	throw new ControlError("TF_DURABILITY_FAILED", message, { recoveryAction: "operator", sideEffects: "unknown" });
}

function batchTip(batches: readonly JournalBatch[]) {
	const last = batches.at(-1);
	return { commitSeq: last?.commitSeq ?? 0,
		hash: last ? last.recordKind === "lifecycle-batch" ? last.contentHash : journalHash(last) : JOURNAL_GENESIS };
}

/** No cached projection or caller-selected anchor becomes an evidence authority. */
export function readControlEvidence(store: ControlStore): EvidenceLedgerView {
	const batches = store.readJournal();
	const header = store.header;
	const view: EvidenceLedgerView = {
		projectId: header.projectId, controlDomainId: header.controlDomainId,
		directoryBinding: header.directoryBinding,
		anchorHash: JOURNAL_GENESIS, tipHash: JOURNAL_GENESIS, tipCommitSeq: 0,
		events: [], runs: {}, commands: {}, receipts: {},
	};
	const events: EvidenceLedgerView["events"][number][] = [];
	const runs: Record<string, EvidenceLedgerView["runs"][string]> = {};
	const commands: Record<string, EvidenceLedgerView["commands"][string]> = {};
	const receipts: Record<string, EvidenceLedgerView["receipts"][string]> = {};
	for (const batch of batches) {
		for (const event of batch.events) {
			const hash = evidenceEventHash(view.tipHash, event);
			events.push({ event, previousHash: view.tipHash, hash });
			view.tipHash = hash;
		}
		view.tipCommitSeq = batch.commitSeq;
		if (batch.command) commands[batch.command.commandId] = {
			...(batch.command.responseArtifactRef ? { responseArtifactRef: batch.command.responseArtifactRef } : {}),
		};
		if (batch.recordKind !== "lifecycle-batch") continue;
		if (batch.evidenceMetadata) {
			const metadata = batch.evidenceMetadata;
			if (Object.hasOwn(runs, metadata.runId)) fail("run evidence metadata was committed more than once");
			runs[metadata.runId] = { runId: metadata.runId, eventIds: [], artifactRefs: [],
				buildInfo: metadata.buildInfo, assurance: metadata.assurance };
		}
		if (batch.receipt) {
			if (!batch.receiptRef || !batch.manifestProofRef || Object.hasOwn(receipts, batch.receipt.runId)) fail("receipt issuance lacks unique atomic references");
			receipts[batch.receipt.runId] = { receiptRef: batch.receiptRef, manifestProofRef: batch.manifestProofRef };
		}
	}
	for (const run of Object.values(runs)) {
		const state = store.readRun(run.runId);
		if (!state) fail("evidence metadata has no committed run");
		run.boundPlanHash = state.boundPlanHash;
		run.boundFragmentHash = state.boundFragmentHash;
		const scoped = events.filter(({ event }) => event.correlationId === run.runId);
		const terminal = scoped.findIndex(({ event }) => event.payload.kind === "run.terminal");
		// Receipt issuance and later release snapshots must never change its manifest.
		const manifest = terminal < 0 ? scoped : scoped.slice(0, terminal + 1);
		run.eventIds = manifest.map(({ event }) => event.eventId);
		const refs: ArtifactRef[] = [];
		for (const { event } of manifest) {
			if (event.payload.kind !== "artifact.recorded" || event.payload.runId !== run.runId) continue;
			const ref = event.payload.artifact;
			if (!refs.some(candidate => canonicalJson(candidate) === canonicalJson(ref))) refs.push(ref);
		}
		run.artifactRefs = refs;
		if (terminal >= 0) {
			const event = scoped[terminal].event;
			if (event.payload.kind !== "run.terminal" || event.payload.status !== state.status || state.stage !== "terminal") fail("terminal event differs from authoritative run state");
			run.terminalEvidenceId = event.eventId;
		}
	}
	return { ...view, events, runs, commands, receipts };
}

/** Use the project's existing writer exclusion for staging, issuance and reads. */
export async function createControlEvidenceStore(store: ControlStore, options: ControlEvidenceOptions): Promise<EvidenceStore> {
	return createEvidenceStore({
		...options, storePath: store.storePath,
		ledger: {
			read: () => readControlEvidence(store),
			withWriter: operation => store.withWriter(() => operation(readControlEvidence(store))),
			async commitReceiptOnce(runId: string, prepared: PreparedEvidenceReceipt) {
				const current = readControlEvidence(store);
				if (prepared.expectedTip.commitSeq !== current.tipCommitSeq || prepared.expectedTip.hash !== current.tipHash) {
					throw new ControlError("TF_STALE_VERSION", "evidence journal advanced before receipt issuance");
				}
				const tip = batchTip(store.readJournal());
				store.appendReceipt(runId, { receipt: prepared.receipt, receiptRef: prepared.receiptRef,
					manifestProofRef: prepared.manifestProofRef }, tip);
			},
		},
	});
}

/** Advance only the logical visibility floor; retained journal and blobs survive. */
export async function compactControlEvidence(store: ControlStore, evidence: EvidenceStore, throughCommitSeq: number): Promise<void> {
	await store.withWriter(async () => {
		const prepared = await evidence.prepareCheckpoint(throughCommitSeq);
		const current = readControlEvidence(store);
		if (prepared.expectedTip.commitSeq !== current.tipCommitSeq || prepared.expectedTip.hash !== current.tipHash) {
			throw new ControlError("TF_STALE_VERSION", "journal advanced before compaction checkpoint");
		}
		store.appendCheckpoint(throughCommitSeq, batchTip(store.readJournal()));
	});
}
