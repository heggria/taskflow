import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebGeneratedClient } from "taskflow-control/web-protocol";
import {
	collectWebReceiptExport,
	serializeWebReceiptExport,
	webReceiptExportFileName,
} from "../src/receipt-export.ts";

type ReceiptPage = Awaited<
	ReturnType<WebGeneratedClient["runReceipt"]>
>;

const sourceObservation: ReceiptPage["sourceObservation"] = {
	coverage: "complete" as const,
	authority: "verified" as const,
	observedAt: 1_750_000_000_000,
	registryContext: {
		mode: "standalone",
		registryRevision: "standalone",
		visibleMounts: [
			{
				projectId: "project-1",
				controlDomainId: "domain-1",
			},
		],
	},
	watermarks: [
		{
			projectId: "project-1",
			controlDomainId: "domain-1",
			nextCommitSeq: 13,
			minAvailableCommitSeq: 1,
		},
	],
};

function receiptPage(input: {
	readonly items: ReceiptPage["eventManifest"]["items"];
	readonly nextCursor?: string;
}): ReceiptPage {
	return {
		receipt: {
			receiptId: "receipt-1",
			projectId: "project-1",
			controlDomainId: "domain-1",
			runId: "run-1",
			boundPlanHash: `bp:${"a".repeat(64)}`,
			eventManifest: ["event-1", "event-2"],
			startCommitSeq: 10,
			endCommitSeq: 12,
			artifactRefs: [
				{
					artifactId: "artifact-1",
					role: "result",
					digest: `sha256:${"b".repeat(64)}`,
					size: 12,
					mediaType: "text/plain",
					storageClass: "control-store",
					redactionClass: "project",
					receiptId: "receipt-1",
					integrity: "ok",
					disclosure: {
						access: "direct",
						action: {
							catalogVersion: "taskflow-content.v1",
							key: "artifact.download.action",
							args: [],
						},
					},
				},
			],
			issuedAt: 1_750_000_000_000,
			assurance: {
				journalContinuity: "ok",
				providerOutcome: "ok",
				artifactIntegrity: "ok",
				provenance: "ok",
			},
			buildInfo: {
				packageVersion: "0.3.0-beta.2",
				controlSchemaVersion: 1,
			},
		},
		verification: {
			state: "verified",
			reason: "all-required-checks-ok",
			label: {
				catalogVersion: "taskflow-content.v1",
				key: "verification.verified",
				args: [],
			},
			detail: {
				catalogVersion: "taskflow-content.v1",
				key: "verification.verified.detail",
				args: [],
			},
			checkedAt: 1_750_000_000_000,
			receiptId: "receipt-1",
			providerConsistency: {
				expected: {
					kind: "exact",
					outcome: "completed",
				},
				observed: "completed",
				check: "ok",
				sourceEventRefs: [],
			},
			eventManifest: "ok",
			journalContinuity: "ok",
			provenance: "ok",
			artifactIntegrity: "ok",
			artifactCheckCount: 1,
			requiredArtifactCheckCount: 1,
			artifactChecks: [
				{
					artifactId: "artifact-1",
					digest: `sha256:${"b".repeat(64)}`,
					required: true,
					state: "ok",
				},
			],
			sourceObservation,
		},
		artifactCount: 1,
		eventManifest: {
			items: input.items,
			...(input.nextCursor
				? { nextCursor: input.nextCursor }
				: {}),
			sourceObservation,
		},
		sourceObservation,
	};
}

const firstEntry = {
	eventId: "event-1",
	commitSeq: 10,
	eventKind: "RunStarted",
	eventDigest: `sha256:${"c".repeat(64)}`,
};
const secondEntry = {
	eventId: "event-2",
	commitSeq: 12,
	eventKind: "RunCompleted",
	eventDigest: `sha256:${"d".repeat(64)}`,
};
const params = {
	projectId: "project-1",
	controlDomainId: "domain-1",
	runId: "run-1",
};

test("Receipt export concatenates pages and serializes stable JSON", async () => {
	const cursors: Array<string | undefined> = [];
	const client = {
		async runReceipt(
			input: Parameters<WebGeneratedClient["runReceipt"]>[0],
		) {
			cursors.push(input.query.cursor);
			return input.query.cursor
				? receiptPage({ items: [secondEntry] })
				: receiptPage({
						items: [firstEntry],
						nextCursor: "cursor-1",
					});
		},
	};
	const document = await collectWebReceiptExport({
		client,
		params,
		expectedRunVersion: 3,
		expectedReceiptId: "receipt-1",
	});
	assert.deepEqual(cursors, [undefined, "cursor-1"]);
	assert.deepEqual(
		document.eventManifest.map((entry) => entry.eventId),
		["event-1", "event-2"],
	);
	assert.equal(
		serializeWebReceiptExport(document),
		serializeWebReceiptExport(document),
	);
	assert.match(
		serializeWebReceiptExport(document),
		/^\{\n  "artifactCount": 1,/u,
	);
	assert.equal(
		webReceiptExportFileName("receipt-1"),
		"taskflow-receipt-receipt-1.json",
	);
	assert.equal(
		webReceiptExportFileName("../unsafe receipt"),
		"taskflow-receipt-unsafe_receipt.json",
	);
});

test("Receipt export fails closed on missing, repeated, or changed evidence", async () => {
	await assert.rejects(
		collectWebReceiptExport({
			client: {
				async runReceipt() {
					return receiptPage({ items: [firstEntry] });
				},
			},
			params,
			expectedRunVersion: 3,
			expectedReceiptId: "receipt-1",
		}),
		/missing manifest entries/u,
	);
	await assert.rejects(
		collectWebReceiptExport({
			client: {
				async runReceipt() {
					return receiptPage({
						items: [firstEntry],
						nextCursor: "same-cursor",
					});
				},
			},
			params,
			expectedRunVersion: 3,
			expectedReceiptId: "receipt-1",
		}),
		/cursor repeated/u,
	);
	let call = 0;
	await assert.rejects(
		collectWebReceiptExport({
			client: {
				async runReceipt(input) {
					call += 1;
					const page =
						call === 1
							? receiptPage({
									items: [firstEntry],
									nextCursor: "next",
								})
							: receiptPage({
									items: [secondEntry],
								});
					return call === 1
						? page
						: {
								...page,
								receipt: {
									...page.receipt,
									endCommitSeq: 13,
								},
							};
				},
			},
			params,
			expectedRunVersion: 3,
			expectedReceiptId: "receipt-1",
		}),
		/changed between pages/u,
	);
});
