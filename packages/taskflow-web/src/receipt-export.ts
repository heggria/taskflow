import type { WebGeneratedClient } from "taskflow-control/web-protocol";

type WebReceiptPage = Awaited<
	ReturnType<WebGeneratedClient["runReceipt"]>
>;
type WebReceiptManifestEntry =
	WebReceiptPage["eventManifest"]["items"][number];

export type WebReceiptExportDocument = Readonly<{
	schemaVersion: "taskflow-receipt-export.v1";
	receipt: WebReceiptPage["receipt"];
	currentVerification: WebReceiptPage["verification"];
	artifactCount: number;
	eventManifest: readonly WebReceiptManifestEntry[];
}>;

export type CollectWebReceiptExportInput = Readonly<{
	client: Pick<WebGeneratedClient, "runReceipt">;
	params: Readonly<{
		projectId: string;
		controlDomainId: string;
		runId: string;
	}>;
	expectedRunVersion: number;
	expectedReceiptId: string;
}>;

const RECEIPT_EXPORT_PAGE_LIMIT = 200;

function canonicalJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalJsonValue);
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	const record = value as Readonly<Record<string, unknown>>;
	return Object.fromEntries(
		Object.keys(record)
			.sort((left, right) => left.localeCompare(right, "en"))
			.map((key) => [key, canonicalJsonValue(record[key])]),
	);
}

function compareManifestEntries(
	left: WebReceiptManifestEntry,
	right: WebReceiptManifestEntry,
): number {
	return (
		left.commitSeq - right.commitSeq ||
		left.eventId.localeCompare(right.eventId, "en")
	);
}

function assertReceiptPageIdentity(
	page: WebReceiptPage,
	input: CollectWebReceiptExportInput,
	firstReceiptCanonical: string,
): void {
	const { receipt, verification } = page;
	if (
		receipt.receiptId !== input.expectedReceiptId ||
		receipt.projectId !== input.params.projectId ||
		receipt.controlDomainId !== input.params.controlDomainId ||
		receipt.runId !== input.params.runId ||
		verification.receiptId !== input.expectedReceiptId
	) {
		throw new Error("Receipt export identity changed while reading it");
	}
	if (
		JSON.stringify(
			canonicalJsonValue({
				receipt,
				eventManifestCount:
					page.eventManifestCount ??
					receipt.eventManifest.length,
				eventManifestDigest:
					page.eventManifestDigest ?? null,
				artifactCount: page.artifactCount,
				artifactRefsDigest:
					page.artifactRefsDigest ?? null,
			}),
		) !==
		firstReceiptCanonical
	) {
		throw new Error("Receipt export changed between pages");
	}
}

async function eventIdDigest(
	eventIds: readonly string[],
): Promise<string> {
	const bytes = new TextEncoder().encode(
		JSON.stringify(eventIds),
	);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		bytes,
	);
	return `sha256:${Array.from(new Uint8Array(digest))
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("")}`;
}

async function assertCompleteManifest(
	receipt: WebReceiptPage["receipt"],
	entries: readonly WebReceiptManifestEntry[],
	expectedCount: number,
	expectedDigest: string,
): Promise<void> {
	if (entries.length !== expectedCount) {
		throw new Error("Receipt export is missing manifest entries");
	}
	const seen = new Set<string>();
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index]!;
		if (
			seen.has(entry.eventId) ||
			(index < receipt.eventManifest.length &&
				entry.eventId !==
					receipt.eventManifest[index]) ||
			entry.commitSeq < receipt.startCommitSeq ||
			entry.commitSeq > receipt.endCommitSeq ||
			(index > 0 &&
				compareManifestEntries(entries[index - 1]!, entry) >=
					0)
		) {
			throw new Error(
				"Receipt export manifest is duplicated, reordered, or outside its commit range",
			);
		}
		seen.add(entry.eventId);
	}
	if (
		(await eventIdDigest(
			entries.map((entry) => entry.eventId),
		)) !== expectedDigest
	) {
		throw new Error(
			"Receipt export manifest digest does not match the Receipt",
		);
	}
}

/**
 * Reads every byte-budgeted Receipt manifest page again at export time and
 * fails closed if the immutable identity changes, a cursor loops, or the
 * exported event list is not an exact ordered match for the Receipt.
 *
 * This is an export-consistency check. The authoritative journal, artifact,
 * provider and provenance checks remain the server projection carried in
 * currentVerification.
 */
export async function collectWebReceiptExport(
	input: CollectWebReceiptExportInput,
): Promise<WebReceiptExportDocument> {
	let cursor: string | undefined;
	let firstPage: WebReceiptPage | undefined;
	let firstReceiptCanonical = "";
	const seenCursors = new Set<string>();
	const eventManifest: WebReceiptManifestEntry[] = [];
	let pageCount = 0;

	while (true) {
		pageCount += 1;
		const page = await input.client.runReceipt({
			params: input.params,
			query: {
				expectedRunVersion: input.expectedRunVersion,
				expectedReceiptId: input.expectedReceiptId,
				limit: RECEIPT_EXPORT_PAGE_LIMIT,
				cursor,
			},
			body: {},
		});
		if (!firstPage) {
			firstPage = page;
			firstReceiptCanonical = JSON.stringify(
				canonicalJsonValue({
					receipt: page.receipt,
					eventManifestCount:
						page.eventManifestCount ??
						page.receipt.eventManifest
							.length,
					eventManifestDigest:
						page.eventManifestDigest ??
						null,
					artifactCount:
						page.artifactCount,
					artifactRefsDigest:
						page.artifactRefsDigest ??
						null,
				}),
			);
		}
		assertReceiptPageIdentity(
			page,
			input,
			firstReceiptCanonical,
		);
		const expectedManifestCount =
			page.eventManifestCount ??
			page.receipt.eventManifest.length;
		const expectedManifestDigest =
			page.eventManifestDigest ??
			(await eventIdDigest(
				page.receipt.eventManifest,
			));
		if (
			pageCount >
			Math.max(1, expectedManifestCount)
		) {
			throw new Error(
				"Receipt export cursor exceeded the manifest progress bound",
			);
		}
		eventManifest.push(...page.eventManifest.items);
		if (
			eventManifest.length >
			expectedManifestCount
		) {
			throw new Error(
				"Receipt export contains more events than the Receipt",
			);
		}
		const nextCursor = page.eventManifest.nextCursor;
		if (!nextCursor) {
			await assertCompleteManifest(
				page.receipt,
				eventManifest,
				expectedManifestCount,
				expectedManifestDigest,
			);
			if (
				page.receipt.artifactRefs.length >
				page.artifactCount
			) {
				throw new Error(
					"Receipt export artifact preview exceeds its count",
				);
			}
			return {
				schemaVersion: "taskflow-receipt-export.v1",
				receipt: firstPage.receipt,
				currentVerification: firstPage.verification,
				artifactCount: firstPage.artifactCount,
				eventManifest,
			};
		}
		if (
			page.eventManifest.items.length === 0
		) {
			throw new Error(
				"Receipt export cursor did not make bounded progress",
			);
		}
		if (seenCursors.has(nextCursor)) {
			throw new Error("Receipt export cursor repeated");
		}
		seenCursors.add(nextCursor);
		cursor = nextCursor;
	}
}

export function serializeWebReceiptExport(
	document: WebReceiptExportDocument,
): string {
	return `${JSON.stringify(canonicalJsonValue(document), null, 2)}\n`;
}

export function webReceiptExportFileName(receiptId: string): string {
	const safeReceiptId =
		receiptId
			.replace(/[^A-Za-z0-9._-]/gu, "_")
			.replace(/^[._-]+/u, "") || "unknown";
	return `taskflow-receipt-${safeReceiptId}.json`;
}
