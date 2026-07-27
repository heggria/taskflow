/**
 * P14 ControlStore integrity defects (D1–D5).
 *
 * These tests are intentionally red-first on the integration base: each defect
 * either fails closed with residual evidence preserved, or is reported
 * not-reproducing with green evidence after the base already handles it.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	openProjectControlStore,
	projectControlRoot,
	type ProjectControlStore,
} from "../src/index.ts";

function tempProject(): { project: string; cleanup: () => void } {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p14-"));
	return {
		project,
		cleanup: () => fs.rmSync(project, { recursive: true, force: true }),
	};
}

function controlPath(project: string, ...parts: string[]): string {
	return path.join(projectControlRoot(project), ...parts);
}

function assertDurabilityFailure(error: unknown): boolean {
	assert.equal((error as { code?: string }).code, "TF_DURABILITY_FAILED", String(error));
	return true;
}

function genericEvent(
	store: ProjectControlStore,
	eventId: string,
	streamId: string,
	kind: string,
	recordedAt: number,
) {
	return {
		eventId,
		schemaVersion: 1 as const,
		controlDomainId: store.header.controlDomainId,
		streamId,
		streamSeq: 0,
		commitSeq: 0,
		projectId: store.header.projectId,
		recordedAt,
		payload: { type: "Generic" as const, kind, data: {} },
	};
}

function baseRun(
	store: ProjectControlStore,
	runId: string,
	recordedAt: number,
	overrides: Record<string, unknown> = {},
) {
	return {
		runId,
		projectId: store.header.projectId,
		controlDomainId: store.header.controlDomainId,
		status: "running" as const,
		stage: "executing" as const,
		boundPlanHash: "bp:p14",
		needsOperator: false,
		createdAt: recordedAt,
		updatedAt: recordedAt,
		runVersion: 1,
		...overrides,
	};
}

/** Truncate the journal to the first N segments and keep residual derived bytes. */
function truncateJournalToSegments(project: string, keepCount: number): void {
	const journalDir = controlPath(project, "journal");
	const files = fs.readdirSync(journalDir).filter((f) => f.endsWith(".json")).sort();
	assert.ok(files.length >= keepCount, `expected at least ${keepCount} journal segments`);
	for (const file of files.slice(keepCount)) {
		fs.unlinkSync(path.join(journalDir, file));
	}
	const kept = files.slice(0, keepCount);
	const lastPath = path.join(journalDir, kept[kept.length - 1]!);
	const last = JSON.parse(fs.readFileSync(lastPath, "utf-8")) as {
		commitSeqEnd: number;
		segmentHash: string;
		events: Array<{ streamId: string; streamSeq: number }>;
	};
	const anchorPath = controlPath(project, "journal.anchor.json");
	const anchor = JSON.parse(fs.readFileSync(anchorPath, "utf-8")) as Record<string, unknown>;
	anchor.lastCommitSeq = last.commitSeqEnd;
	anchor.tailSegmentHash = last.segmentHash;
	anchor.updatedAt = Date.now();
	fs.writeFileSync(anchorPath, JSON.stringify(anchor, null, 2), "utf-8");
	fs.writeFileSync(
		controlPath(project, "commit-seq.json"),
		JSON.stringify({ next: last.commitSeqEnd + 1 }, null, 2),
		"utf-8",
	);
	const streamMap: Record<string, number> = {};
	for (const file of kept) {
		const entry = JSON.parse(fs.readFileSync(path.join(journalDir, file), "utf-8")) as {
			events: Array<{ streamId: string; streamSeq: number }>;
		};
		for (const event of entry.events) {
			streamMap[event.streamId] = Math.max(streamMap[event.streamId] ?? 0, event.streamSeq);
		}
	}
	fs.writeFileSync(controlPath(project, "stream-seq.json"), JSON.stringify(streamMap, null, 2), "utf-8");
}

// ─── D1: direction-aware journal-fold vs disk residual ───────────────────────

test("D1 disk-behind half-commit: missing projection rebuilds and opens", () => {
	const t = tempProject();
	try {
		const store = openProjectControlStore(t.project);
		const now = Date.now();
		const runId = "run-disk-behind";
		store.commit({
			events: [genericEvent(store, "ev-disk-behind", runId, "disk-behind", now)],
			run: baseRun(store, runId, now),
		});
		const projectionPath = controlPath(t.project, "projections", `run-${runId}.json`);
		assert.ok(fs.existsSync(projectionPath));
		fs.unlinkSync(projectionPath);

		const reopened = openProjectControlStore(t.project);
		const recovered = reopened.getRun(runId);
		assert.ok(recovered, "disk-behind half-commit must rebuild the projection from the journal fold");
		assert.equal(recovered!.runId, runId);
		assert.equal(recovered!.runVersion, 1);
	} finally {
		t.cleanup();
	}
});

/**
 * Case A (stale disk-behind, same id): journal legitimately contains commits the
 * on-disk projection has not applied yet. An old but self-consistent projection
 * for that id is a normal crash artifact — open MUST rebuild from the fold.
 * This is NOT the same as deleting a file; the residual bytes remain and are
 * simply behind the journal tail.
 */
test("D1 same-id stale disk-behind: old self-consistent projection rebuilds and opens", () => {
	const t = tempProject();
	try {
		const store = openProjectControlStore(t.project);
		const now = Date.now();
		const runId = "run-stale-behind";
		const v1 = baseRun(store, runId, now, { runVersion: 1, stage: "executing", status: "running" });
		store.commit({
			events: [genericEvent(store, "ev-stale-v1", runId, "v1", now)],
			run: v1,
		});
		const projectionPath = controlPath(t.project, "projections", `run-${runId}.json`);
		const staleProjection = fs.readFileSync(projectionPath, "utf-8");
		assert.match(staleProjection, /"runVersion": 1/);

		store.commit({
			events: [genericEvent(store, "ev-stale-v2", runId, "v2", now + 1)],
			run: baseRun(store, runId, now + 1, {
				status: "completed",
				stage: "terminal",
				runVersion: 2,
				updatedAt: now + 1,
			}),
		});
		assert.match(fs.readFileSync(projectionPath, "utf-8"), /"runVersion": 2/);

		// Crash artifact: journal tail is at v2, projection write for v2 never landed
		// (or was lost). Residual file is the older self-consistent v1 projection.
		fs.writeFileSync(projectionPath, staleProjection, "utf-8");
		assert.match(fs.readFileSync(projectionPath, "utf-8"), /"runVersion": 1/);

		const reopened = openProjectControlStore(t.project);
		const recovered = reopened.getRun(runId);
		assert.ok(recovered, "stale disk-behind same-id must rebuild from the journal fold, not brick open");
		assert.equal(recovered!.runVersion, 2, "rebuilt projection must reflect the journal fold tail");
		assert.equal(recovered!.status, "completed");
		assert.match(
			fs.readFileSync(projectionPath, "utf-8"),
			/"runVersion": 2/,
			"rebuild must publish the fold-current projection after a successful open",
		);
	} finally {
		t.cleanup();
	}
});

test("D1 disk-ahead orphan residual: open refuses and preserves exact residual bytes", () => {
	const t = tempProject();
	try {
		const store = openProjectControlStore(t.project);
		const now = Date.now();
		store.commit({
			events: [genericEvent(store, "ev-kept", "run-kept", "kept", now)],
			run: baseRun(store, "run-kept", now),
		});
		store.commit({
			events: [genericEvent(store, "ev-orphan", "run-orphan", "orphan", now + 1)],
			run: baseRun(store, "run-orphan", now + 1),
		});

		const orphanPath = controlPath(t.project, "projections", "run-run-orphan.json");
		const residual = fs.readFileSync(orphanPath, "utf-8");
		truncateJournalToSegments(t.project, 1);

		assert.throws(() => openProjectControlStore(t.project), assertDurabilityFailure);
		assert.equal(
			fs.readFileSync(orphanPath, "utf-8"),
			residual,
			"refuse path must not scrub orphan residual evidence",
		);
	} finally {
		t.cleanup();
	}
});

/**
 * Case B (disk-ahead / rolled-back journal): residual same-id content is ahead
 * of (or otherwise unexplained by) the verified journal fold. Open must refuse
 * and preserve residual bytes as evidence — never scrub via rebuild.
 */
test("D1 same-id disk-ahead divergent residual: open refuses and preserves exact residual bytes", () => {
	const t = tempProject();
	try {
		const store = openProjectControlStore(t.project);
		const now = Date.now();
		const runId = "run-same-id";
		store.commit({
			events: [genericEvent(store, "ev-same-v1", runId, "v1", now)],
			run: baseRun(store, runId, now, { runVersion: 1 }),
		});
		store.commit({
			events: [genericEvent(store, "ev-same-v2", runId, "v2", now + 1)],
			run: baseRun(store, runId, now + 1, {
				status: "completed",
				stage: "terminal",
				runVersion: 2,
				receiptId: "rcpt-same-id",
				updatedAt: now + 1,
			}),
			receipt: {
				receiptId: "rcpt-same-id",
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
				runId,
				boundPlanHash: "bp:p14",
				eventManifest: ["ev-same-v2"],
				startCommitSeq: 2,
				endCommitSeq: 2,
				artifactRefs: [],
				assurance: {
					journalContinuity: "ok",
					providerOutcome: "ok",
					artifactIntegrity: "unknown",
					provenance: "unknown",
				},
				buildInfo: { packageVersion: "0.3.0-test", controlSchemaVersion: 1 },
				issuedAt: now + 1,
			},
		});

		const projectionPath = controlPath(t.project, "projections", `run-${runId}.json`);
		const receiptPath = controlPath(t.project, "receipts", "rcpt-same-id.json");
		const residualProjection = fs.readFileSync(projectionPath, "utf-8");
		const residualReceipt = fs.readFileSync(receiptPath, "utf-8");
		assert.match(residualProjection, /"runVersion": 2/);

		truncateJournalToSegments(t.project, 1);

		assert.throws(() => openProjectControlStore(t.project), assertDurabilityFailure);
		assert.equal(fs.readFileSync(projectionPath, "utf-8"), residualProjection);
		assert.equal(fs.readFileSync(receiptPath, "utf-8"), residualReceipt);
	} finally {
		t.cleanup();
	}
});

/**
 * Mutation rebuild paths (claimCommand → rebuildFromJournal) must apply the same
 * residual refuse gate as open — not only the writer-open path.
 */
test("D1 mutation rebuild path refuses unexplained residual and preserves bytes", () => {
	const t = tempProject();
	try {
		const store = openProjectControlStore(t.project);
		const now = Date.now();
		const runId = "run-mutation-residual";
		store.commit({
			events: [genericEvent(store, "ev-mut-res", runId, "mut-res", now)],
			run: baseRun(store, runId, now, { runVersion: 1 }),
		});
		const projectionPath = controlPath(t.project, "projections", `run-${runId}.json`);
		const original = JSON.parse(fs.readFileSync(projectionPath, "utf-8")) as Record<string, unknown>;
		// Plant content the journal fold cannot explain (not an intermediate fold).
		const residualBytes = JSON.stringify({ ...original, runVersion: 99, planted: true }, null, 2);
		fs.writeFileSync(projectionPath, residualBytes, "utf-8");

		assert.throws(
			() =>
				store.claimCommand({
					commandId: "cmd-mut-res",
					requestHash: "h-mut-res",
					callerPrincipal: "operator",
					kind: "admitAndRun",
					runId: "run-mut-claim",
				}),
			assertDurabilityFailure,
		);
		assert.equal(
			fs.readFileSync(projectionPath, "utf-8"),
			residualBytes,
			"mutation rebuild refuse path must not scrub residual evidence",
		);
	} finally {
		t.cleanup();
	}
});

// ─── D2: prototype-key smuggling in authority comparison ─────────────────────

test("D2 __proto__ smuggled residual field: open refuses and preserves residual bytes", () => {
	const t = tempProject();
	try {
		const store = openProjectControlStore(t.project);
		const now = Date.now();
		const runId = "run-proto";
		store.commit({
			events: [genericEvent(store, "ev-proto", runId, "proto", now)],
			run: baseRun(store, runId, now),
		});

		const projectionPath = controlPath(t.project, "projections", `run-${runId}.json`);
		const original = JSON.parse(fs.readFileSync(projectionPath, "utf-8")) as Record<string, unknown>;
		// Own-property "__proto__" (quoted key) that is not part of the journal fold.
		// A plain `{}` + assignment canonicalize invokes the prototype setter,
		// silently drops the residual field, and can make a tampered residual
		// compare equal to the fold.
		const smuggled = { ...original, ["__proto__"]: { polluted: true } };
		const residualBytes = JSON.stringify(smuggled, null, 2);
		assert.match(residualBytes, /"__proto__"/);
		fs.writeFileSync(projectionPath, residualBytes, "utf-8");

		assert.throws(() => openProjectControlStore(t.project), assertDurabilityFailure);
		assert.equal(
			fs.readFileSync(projectionPath, "utf-8"),
			residualBytes,
			"refuse path must not rewrite residual with __proto__ evidence",
		);
	} finally {
		t.cleanup();
	}
});

// ─── D3: full index-grammar denylist (not a single by-cmd- prefix check) ──────

const INDEX_GRAMMAR_POISON_IDS = ["by-cmd-poison", "by-run-poison"] as const;

for (const poisonId of INDEX_GRAMMAR_POISON_IDS) {
	test(`D3 commandId reserved index prefix ${JSON.stringify(poisonId)} is refused before any claim is persisted`, () => {
		const t = tempProject();
		try {
			const store = openProjectControlStore(t.project);
			const commandPath = controlPath(t.project, "commands", `${poisonId}.json`);
			const indexPath = controlPath(t.project, "commands", `by-cmd-${poisonId}.json`);

			assert.throws(
				() =>
					store.claimCommand({
						commandId: poisonId,
						requestHash: `h-${poisonId}`,
						callerPrincipal: "attacker",
						kind: "admitAndRun",
						runId: "run-poison",
					}),
				assertDurabilityFailure,
			);
			assert.equal(fs.existsSync(commandPath), false, "poison command body must not be written");
			assert.equal(fs.existsSync(indexPath), false, "poison by-cmd index must not be written");

			// Store must remain openable and unpoisoned.
			const reopened = openProjectControlStore(t.project);
			assert.equal(reopened.getCommand(poisonId), null);
		} finally {
			t.cleanup();
		}
	});
}

test("D3 runId reserved index prefix by-run- is refused before any claim is persisted", () => {
	const t = tempProject();
	try {
		const store = openProjectControlStore(t.project);
		const poisonRunId = "by-run-poison-run";
		assert.throws(
			() =>
				store.claimCommand({
					commandId: "cmd-ok-body",
					requestHash: "h-run-poison",
					callerPrincipal: "attacker",
					kind: "admitAndRun",
					runId: poisonRunId,
				}),
			assertDurabilityFailure,
		);
		assert.equal(
			fs.existsSync(controlPath(t.project, "commands", "cmd-ok-body.json")),
			false,
			"claim with poison runId must not persist a command body",
		);
	} finally {
		t.cleanup();
	}
});

// ─── D4: pointer indexes must compare full content ───────────────────────────

test("D4 by-cmd pointer with smuggled extra fields refuses open and preserves residual", () => {
	const t = tempProject();
	try {
		const store = openProjectControlStore(t.project);
		assert.deepEqual(
			store.claimCommand({
				commandId: "cmd-pointer",
				requestHash: "h-pointer",
				callerPrincipal: "operator",
				kind: "admitAndRun",
				runId: "run-pointer",
			}),
			{ kind: "claimed" },
		);
		const byCmdPath = controlPath(t.project, "commands", "by-cmd-cmd-pointer.json");
		const residual = JSON.stringify({ runId: "run-pointer", extra: "smuggled" }, null, 2);
		fs.writeFileSync(byCmdPath, residual, "utf-8");

		assert.throws(() => openProjectControlStore(t.project), assertDurabilityFailure);
		assert.equal(fs.readFileSync(byCmdPath, "utf-8"), residual);
	} finally {
		t.cleanup();
	}
});

test("D4 by-run pointer with smuggled extra fields refuses open and preserves residual", () => {
	const t = tempProject();
	try {
		const store = openProjectControlStore(t.project);
		const now = Date.now();
		const runId = "run-by-run-extra";
		const receiptId = "rcpt-by-run-extra";
		// Two events in one segment: a generic marker + ReceiptIssued so the
		// receipt is journal-valid. The only planted defect is the by-run body.
		store.commit({
			events: [
				genericEvent(store, "ev-by-run-extra", runId, "by-run-extra", now),
				{
					eventId: "ev-by-run-issued",
					schemaVersion: 1,
					controlDomainId: store.header.controlDomainId,
					streamId: runId,
					streamSeq: 0,
					commitSeq: 0,
					projectId: store.header.projectId,
					recordedAt: now,
					payload: { type: "ReceiptIssued", runId, receiptId },
				},
			],
			run: baseRun(store, runId, now, {
				status: "completed",
				stage: "terminal",
				receiptId,
			}),
			receipt: {
				receiptId,
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
				runId,
				boundPlanHash: "bp:p14",
				eventManifest: ["ev-by-run-extra", "ev-by-run-issued"],
				startCommitSeq: 1,
				endCommitSeq: 2,
				artifactRefs: [],
				assurance: {
					journalContinuity: "ok",
					providerOutcome: "ok",
					artifactIntegrity: "unknown",
					provenance: "unknown",
				},
				buildInfo: { packageVersion: "0.3.0-test", controlSchemaVersion: 1 },
				issuedAt: now,
			},
		});
		// Prove the store is otherwise coherent before we plant the pointer smuggle.
		openProjectControlStore(t.project);
		const byRunPath = controlPath(t.project, "receipts", `by-run-${runId}.json`);
		const residual = JSON.stringify({ receiptId, extra: "smuggled" }, null, 2);
		fs.writeFileSync(byRunPath, residual, "utf-8");

		assert.throws(() => openProjectControlStore(t.project), assertDurabilityFailure);
		assert.equal(fs.readFileSync(byRunPath, "utf-8"), residual);
	} finally {
		t.cleanup();
	}
});

// ─── Reviewer counterexamples CE1–CE4 (must fail if residual-gate fixes revert) ─

/**
 * CE1 / Case B open path: residual command body with firstCommitSeq=0 &&
 * lastCommitSeq=0 must NOT bypass assertDerivedArtifactsSupportedByJournal.
 * Open must refuse BEFORE removeStaleDerivedFiles/rebuild can scrub evidence.
 */
test("CE1 zero-zero residual command refuses open and preserves exact residual bytes", () => {
	const t = tempProject();
	try {
		const store = openProjectControlStore(t.project);
		const now = Date.now();
		store.commit({
			events: [genericEvent(store, "ev-ce1-kept", "run-ce1-kept", "kept", now)],
			run: baseRun(store, "run-ce1-kept", now),
		});

		const residualBytes = JSON.stringify(
			{
				commandId: "cmd-ce1-zero",
				requestHash: "h-ce1-zero",
				callerPrincipal: "attacker",
				authorizationContextHash: "h-ce1-zero",
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
				kind: "admitAndRun",
				status: "accepted",
				firstCommitSeq: 0,
				lastCommitSeq: 0,
				runId: "run-ce1-planted",
				recordedAt: now,
				planted: true,
			},
			null,
			2,
		);
		const cmdPath = controlPath(t.project, "commands", "cmd-ce1-zero.json");
		fs.writeFileSync(cmdPath, residualBytes, "utf-8");

		assert.throws(() => openProjectControlStore(t.project), assertDurabilityFailure);
		assert.equal(
			fs.readFileSync(cmdPath, "utf-8"),
			residualBytes,
			"CE1 refuse path must not scrub zero-zero residual evidence via rebuild/removeStale",
		);
	} finally {
		t.cleanup();
	}
});

/**
 * CE2: commit() is a derived rewrite mutation. Planted residual that claimCommand
 * refuses must also cause commit() to refuse — not happily overwrite evidence.
 */
test("CE2 commit() refuses planted residual that claimCommand also refuses", () => {
	const t = tempProject();
	try {
		const store = openProjectControlStore(t.project);
		const now = Date.now();
		const runId = "run-ce2";
		store.commit({
			events: [genericEvent(store, "ev-ce2-v1", runId, "v1", now)],
			run: baseRun(store, runId, now, { runVersion: 1 }),
		});
		const projectionPath = controlPath(t.project, "projections", `run-${runId}.json`);
		const original = JSON.parse(fs.readFileSync(projectionPath, "utf-8")) as Record<string, unknown>;
		// Schema-valid but unexplained by journal (same class claimCommand refuses).
		const residualBytes = JSON.stringify(
			{ ...original, stage: "reconciling", boundPlanHash: "bp:ce2-planted" },
			null,
			2,
		);
		fs.writeFileSync(projectionPath, residualBytes, "utf-8");

		assert.throws(
			() =>
				store.claimCommand({
					commandId: "cmd-ce2",
					requestHash: "h-ce2",
					callerPrincipal: "operator",
					kind: "admitAndRun",
					runId: "run-ce2-claim",
				}),
			assertDurabilityFailure,
		);
		assert.equal(fs.readFileSync(projectionPath, "utf-8"), residualBytes);

		assert.throws(
			() =>
				store.commit({
					events: [genericEvent(store, "ev-ce2-v2", runId, "v2", now + 1)],
					run: baseRun(store, runId, now + 1, {
						runVersion: 2,
						updatedAt: now + 1,
					}),
				}),
			assertDurabilityFailure,
		);
		assert.equal(
			fs.readFileSync(projectionPath, "utf-8"),
			residualBytes,
			"CE2 commit must not rewrite residual that claimCommand refused",
		);
	} finally {
		t.cleanup();
	}
});

/**
 * CE3: compareAndCommit rewrite must apply the same residual refuse gate.
 * Schema-valid planted residual that claimCommand refuses must not be scrubbed
 * by a CAS that would otherwise overwrite the projection.
 */
test("CE3 compareAndCommit refuses planted residual that claimCommand also refuses", () => {
	const t = tempProject();
	try {
		const store = openProjectControlStore(t.project);
		const now = Date.now();
		const runId = "run-ce3";
		store.commit({
			events: [genericEvent(store, "ev-ce3-v1", runId, "v1", now)],
			run: baseRun(store, runId, now, { runVersion: 1 }),
		});
		const projectionPath = controlPath(t.project, "projections", `run-${runId}.json`);
		const original = JSON.parse(fs.readFileSync(projectionPath, "utf-8")) as Record<string, unknown>;
		const residualBytes = JSON.stringify(
			{ ...original, stage: "reconciling", boundPlanHash: "bp:ce3-planted" },
			null,
			2,
		);
		fs.writeFileSync(projectionPath, residualBytes, "utf-8");

		assert.throws(
			() =>
				store.claimCommand({
					commandId: "cmd-ce3",
					requestHash: "h-ce3",
					callerPrincipal: "operator",
					kind: "admitAndRun",
					runId: "run-ce3-claim",
				}),
			assertDurabilityFailure,
		);
		assert.equal(fs.readFileSync(projectionPath, "utf-8"), residualBytes);

		assert.throws(
			() =>
				store.compareAndCommit({
					runId,
					expectedRunVersion: 1,
					build: (current) => ({
						events: [genericEvent(store, "ev-ce3-v2", runId, "v2", now + 1)],
						run: {
							...current,
							runVersion: 2,
							updatedAt: now + 1,
							stage: "executing",
							boundPlanHash: "bp:p14",
						},
					}),
				}),
			assertDurabilityFailure,
		);
		assert.equal(
			fs.readFileSync(projectionPath, "utf-8"),
			residualBytes,
			"CE3 compareAndCommit must not rewrite residual that claimCommand refused",
		);
	} finally {
		t.cleanup();
	}
});

/**
 * CE4: index-grammar denylist must be case-folded. By-cmd-* / BY-CMD-* / By-run-*
 * must refuse at claim time (same as lowercase by-cmd- / by-run-), including on
 * case-insensitive filesystems where body paths collide with index grammar.
 */
const CE4_POISON_IDS = ["By-cmd-poison", "BY-CMD-poison", "By-run-x", "by-CMD-y"] as const;

for (const poisonId of CE4_POISON_IDS) {
	test(`CE4 case-folded denylist refuses commandId ${JSON.stringify(poisonId)} before any claim is persisted`, () => {
		const t = tempProject();
		try {
			const store = openProjectControlStore(t.project);
			const commandPath = controlPath(t.project, "commands", `${poisonId}.json`);
			const indexPath = controlPath(t.project, "commands", `by-cmd-${poisonId}.json`);

			assert.throws(
				() =>
					store.claimCommand({
						commandId: poisonId,
						requestHash: `h-${poisonId}`,
						callerPrincipal: "attacker",
						kind: "admitAndRun",
						runId: "run-ce4-ok",
					}),
				assertDurabilityFailure,
			);
			assert.equal(fs.existsSync(commandPath), false, "CE4 poison command body must not be written");
			assert.equal(fs.existsSync(indexPath), false, "CE4 poison by-cmd index must not be written");

			const reopened = openProjectControlStore(t.project);
			assert.equal(reopened.getCommand(poisonId), null);
		} finally {
			t.cleanup();
		}
	});
}

// ─── Reviewer counterexample CE5: stream-seq is a non-entity derived watermark ─

/**
 * CE5 / Case B non-entity watermark: stream-seq.json is a derived index rewritten
 * by rebuildFromJournal / commitUnlocked. Disk-ahead residue (watermark greater
 * than the verified journal fold, or an orphan stream id) must refuse open and
 * preserve residual bytes — never silently scrub like a half-commit repair.
 */
test("CE5 stream-seq disk-ahead residual: open refuses and preserves exact residual bytes", () => {
	const t = tempProject();
	try {
		const store = openProjectControlStore(t.project);
		const now = Date.now();
		const streamId = "run-ce5-stream";
		store.commit({
			events: [genericEvent(store, "ev-ce5-1", streamId, "v1", now)],
			run: baseRun(store, streamId, now),
		});

		const streamSeqPath = controlPath(t.project, "stream-seq.json");
		const residualBytes = JSON.stringify({ [streamId]: 99 }, null, 2);
		fs.writeFileSync(streamSeqPath, residualBytes, "utf-8");

		assert.throws(() => openProjectControlStore(t.project), assertDurabilityFailure);
		assert.equal(
			fs.readFileSync(streamSeqPath, "utf-8"),
			residualBytes,
			"CE5 refuse path must not scrub stream-seq disk-ahead residual via rebuild",
		);
	} finally {
		t.cleanup();
	}
});

test("CE5 stream-seq orphan-stream residual: open refuses and preserves exact residual bytes", () => {
	const t = tempProject();
	try {
		const store = openProjectControlStore(t.project);
		const now = Date.now();
		store.commit({
			events: [genericEvent(store, "ev-ce5-orphan-kept", "run-ce5-kept", "kept", now)],
			run: baseRun(store, "run-ce5-kept", now),
		});

		const streamSeqPath = controlPath(t.project, "stream-seq.json");
		const residualBytes = JSON.stringify(
			{
				"run-ce5-kept": 1,
				"run-ce5-planted-stream": 1,
			},
			null,
			2,
		);
		fs.writeFileSync(streamSeqPath, residualBytes, "utf-8");

		assert.throws(() => openProjectControlStore(t.project), assertDurabilityFailure);
		assert.equal(
			fs.readFileSync(streamSeqPath, "utf-8"),
			residualBytes,
			"CE5 refuse path must not scrub orphan stream-seq residual via rebuild",
		);
	} finally {
		t.cleanup();
	}
});

/**
 * CE5 mutation path: commitUnlocked also rewrites stream-seq. Planted disk-ahead
 * residue that open refuses must also cause commit() to refuse without scrubbing.
 */
test("CE5 commit() refuses stream-seq disk-ahead residual and preserves bytes", () => {
	const t = tempProject();
	try {
		const store = openProjectControlStore(t.project);
		const now = Date.now();
		const streamId = "run-ce5-commit";
		store.commit({
			events: [genericEvent(store, "ev-ce5-c1", streamId, "v1", now)],
			run: baseRun(store, streamId, now, { runVersion: 1 }),
		});

		const streamSeqPath = controlPath(t.project, "stream-seq.json");
		const residualBytes = JSON.stringify({ [streamId]: 42 }, null, 2);
		fs.writeFileSync(streamSeqPath, residualBytes, "utf-8");

		assert.throws(
			() =>
				store.commit({
					events: [genericEvent(store, "ev-ce5-c2", streamId, "v2", now + 1)],
					run: baseRun(store, streamId, now + 1, {
						runVersion: 2,
						updatedAt: now + 1,
					}),
				}),
			assertDurabilityFailure,
		);
		assert.equal(
			fs.readFileSync(streamSeqPath, "utf-8"),
			residualBytes,
			"CE5 commit must not scrub stream-seq disk-ahead residual",
		);
	} finally {
		t.cleanup();
	}
});

/**
 * Case A control: lagging/missing stream-seq (disk-behind half-commit after journal
 * append) remains rebuildable — direction-aware gate must not over-refuse.
 */
test("CE5 stream-seq disk-behind residual: open rebuilds and succeeds", () => {
	const t = tempProject();
	try {
		const store = openProjectControlStore(t.project);
		const now = Date.now();
		const streamId = "run-ce5-behind";
		store.commit({
			events: [genericEvent(store, "ev-ce5-b1", streamId, "v1", now)],
			run: baseRun(store, streamId, now),
		});
		store.commit({
			events: [genericEvent(store, "ev-ce5-b2", streamId, "v2", now + 1)],
			run: baseRun(store, streamId, now + 1, {
				runVersion: 2,
				updatedAt: now + 1,
			}),
		});

		const streamSeqPath = controlPath(t.project, "stream-seq.json");
		// Half-commit: journal has streamSeq=2, index still at 1 (or empty).
		fs.writeFileSync(streamSeqPath, JSON.stringify({ [streamId]: 1 }, null, 2), "utf-8");

		const reopened = openProjectControlStore(t.project);
		assert.ok(reopened.getRun(streamId));
		const rebuilt = JSON.parse(fs.readFileSync(streamSeqPath, "utf-8")) as Record<string, number>;
		assert.equal(rebuilt[streamId], 2, "disk-behind stream-seq must rebuild to journal fold");
	} finally {
		t.cleanup();
	}
});

// ─── Reviewer Majors: compareAndCommit residual order + Case B error mapping ───

/**
 * CE6 / Major 2: unexplained Case B residual reached through compareAndCommit
 * must map to TF_DURABILITY_FAILED — the same error class the open path uses —
 * not a soft CAS outcome (TF_STALE_VERSION / TF_INVALID_ARGUMENT / ok).
 *
 * Counterexample: plant a schema-valid projection that the journal never
 * produced, with a *different* runVersion so a CAS-first path short-circuits
 * to TF_STALE_VERSION without ever running residual classification.
 */
test("CE6 compareAndCommit Case B residual maps to TF_DURABILITY_FAILED not soft CAS", () => {
	const t = tempProject();
	try {
		const store = openProjectControlStore(t.project);
		const now = Date.now();
		const runId = "run-ce6";
		store.commit({
			events: [genericEvent(store, "ev-ce6-v1", runId, "v1", now)],
			run: baseRun(store, runId, now, { runVersion: 1 }),
		});
		const projectionPath = controlPath(t.project, "projections", `run-${runId}.json`);
		const original = JSON.parse(fs.readFileSync(projectionPath, "utf-8")) as Record<string, unknown>;
		// Case B: schema-valid (passes validateRunProjection / readRunFromDisk) but
		// unexplained by the journal fold, with version skew so a CAS-first path
		// short-circuits to soft TF_STALE_VERSION instead of residual refuse.
		// Do not add extra keys — those fail shape validation before CAS and mask
		// the ordering defect under review.
		const residualBytes = JSON.stringify(
			{
				...original,
				runVersion: 99,
				stage: "reconciling",
				boundPlanHash: "bp:ce6-planted",
			},
			null,
			2,
		);
		fs.writeFileSync(projectionPath, residualBytes, "utf-8");

		// Open path (control): same residual class must fail closed as durability.
		assert.throws(() => openProjectControlStore(t.project), assertDurabilityFailure);
		assert.equal(fs.readFileSync(projectionPath, "utf-8"), residualBytes);

		// Mutation path under review: residual classification must run before
		// version CAS, so Case B never surfaces as a soft CompareAndCommitResult.
		// Explicitly reject the soft-CAS misclassification the reviewer found.
		let softCas: unknown;
		try {
			softCas = store.compareAndCommit({
				runId,
				expectedRunVersion: 1,
				build: (current) => ({
					events: [genericEvent(store, "ev-ce6-v2", runId, "v2", now + 1)],
					run: {
						...current,
						runVersion: 2,
						updatedAt: now + 1,
						stage: "executing",
						boundPlanHash: "bp:p14",
					},
				}),
			});
		} catch (error) {
			assertDurabilityFailure(error);
			softCas = null;
		}
		if (softCas !== null) {
			assert.fail(
				`CE6 Case B residual must throw TF_DURABILITY_FAILED; got soft result ${JSON.stringify(softCas)}`,
			);
		}
		assert.equal(
			fs.readFileSync(projectionPath, "utf-8"),
			residualBytes,
			"CE6 Case B residual bytes must be preserved; soft CAS must not rewrite or reclassify them",
		);
	} finally {
		t.cleanup();
	}
});

/**
 * CE7 / Major 1: compareAndCommit must run residual classification and
 * rebuild-from-fold BEFORE the version CAS, exactly as claimCommand already does.
 *
 * Without that order, a Case A (stale disk-behind, historically explained)
 * residual is CASed against residual bytes rather than the fold. A client that
 * holds the fold-current version then soft-fails as TF_STALE_VERSION, and a
 * client that holds the residual version can rewrite from the stale residual —
 * a path the ADR residual gate says is rebuild-first, not residual-CAS-first.
 */
test("CE7 compareAndCommit rebuilds Case A residual before version CAS", () => {
	const t = tempProject();
	try {
		const store = openProjectControlStore(t.project);
		const now = Date.now();
		const runId = "run-ce7";
		const v1 = baseRun(store, runId, now, { runVersion: 1, stage: "executing", status: "running" });
		store.commit({
			events: [genericEvent(store, "ev-ce7-v1", runId, "v1", now)],
			run: v1,
		});
		const projectionPath = controlPath(t.project, "projections", `run-${runId}.json`);
		const residualV1 = fs.readFileSync(projectionPath, "utf-8");

		// Fold advances to v2; residual left behind as a crash artifact (Case A).
		store.commit({
			events: [genericEvent(store, "ev-ce7-v2", runId, "v2", now + 1)],
			run: baseRun(store, runId, now + 1, {
				runVersion: 2,
				stage: "executing",
				status: "running",
				updatedAt: now + 1,
				boundPlanHash: "bp:p14-fold-v2",
			}),
		});
		fs.writeFileSync(projectionPath, residualV1, "utf-8");
		assert.match(fs.readFileSync(projectionPath, "utf-8"), /"runVersion": 1/);

		// claimCommand control: residual classify + rebuild happens before any
		// derived-index authority use (same ordering compareAndCommit must share).
		const claim = store.claimCommand({
			commandId: "cmd-ce7-control",
			requestHash: "h-ce7",
			callerPrincipal: "operator",
			kind: "admitAndRun",
			runId: "run-ce7-claim",
		});
		assert.equal(claim.kind, "claimed");
		// claimCommand rebuilds under refuse policy; Case A residual must be fold-current.
		assert.match(
			fs.readFileSync(projectionPath, "utf-8"),
			/"runVersion": 2/,
			"claimCommand rebuild-before-use is the ordering compareAndCommit must match",
		);

		// Re-plant Case A residual for the compareAndCommit path under test.
		fs.writeFileSync(projectionPath, residualV1, "utf-8");
		assert.match(fs.readFileSync(projectionPath, "utf-8"), /"runVersion": 1/);

		// Fold-current client (expectedRunVersion: 2): must rebuild residual first,
		// then CAS against fold — not soft-fail TF_STALE_VERSION from residual v1.
		const advanced = store.compareAndCommit({
			runId,
			expectedRunVersion: 2,
			build: (current) => {
				assert.equal(
					current.runVersion,
					2,
					"build() must see fold-current run after residual rebuild, not residual v1",
				);
				assert.equal(current.boundPlanHash, "bp:p14-fold-v2");
				return {
					events: [genericEvent(store, "ev-ce7-v3", runId, "v3", now + 2)],
					run: {
						...current,
						runVersion: 3,
						updatedAt: now + 2,
						stage: "executing",
					},
				};
			},
		});
		assert.equal(advanced.ok, true, "fold-current CAS must succeed after Case A residual rebuild");
		if (advanced.ok) {
			assert.equal(advanced.run.runVersion, 3);
		}
		assert.match(fs.readFileSync(projectionPath, "utf-8"), /"runVersion": 3/);

		// Re-plant Case A residual again: residual-version client must NOT win CAS
		// against residual bytes and rewrite from stale state. After rebuild-first,
		// expectedRunVersion: 1 is stale relative to fold (now 3) → TF_STALE_VERSION.
		// First rewind journal-visible fold by planting residual of fold's prior body:
		// journal fold is v3; residual v1 is still Case A historical — rebuild yields v3.
		const residualAfterV3 = residualV1;
		fs.writeFileSync(projectionPath, residualAfterV3, "utf-8");
		const staleClient = store.compareAndCommit({
			runId,
			expectedRunVersion: 1,
			build: (current) => ({
				events: [genericEvent(store, "ev-ce7-stale-rewrite", runId, "stale", now + 3)],
				run: {
					...current,
					runVersion: 2,
					updatedAt: now + 3,
					stage: "reconciling",
					boundPlanHash: "bp:ce7-stale-rewrite",
				},
			}),
		});
		assert.equal(staleClient.ok, false, "residual-version client must not win CAS against residual bytes");
		if (!staleClient.ok) {
			assert.equal(
				staleClient.code,
				"TF_STALE_VERSION",
				"after rebuild-first, CAS loser reports TF_STALE_VERSION against fold, not residual rewrite",
			);
		}
		// Projection must remain fold-current (rebuild), never the stale rewrite body.
		const afterStale = fs.readFileSync(projectionPath, "utf-8");
		assert.match(afterStale, /"runVersion": 3/, "stale-client path must not rewrite residual into a new body");
		assert.doesNotMatch(afterStale, /bp:ce7-stale-rewrite/);
	} finally {
		t.cleanup();
	}
});

// ─── D5: multi-commit command firstCommitSeq must not be forced to segment start ─

test("D5 multi-commit command preserves firstCommitSeq across later segments", () => {
	const t = tempProject();
	try {
		const store = openProjectControlStore(t.project);
		const now = Date.now();
		const commandId = "cmd-multi";
		const runId = "run-multi";

		// First durable batch attaches the command at commitSeq 1.
		store.commit({
			command: {
				commandId,
				requestHash: "h-multi",
				callerPrincipal: "operator",
				authorizationContextHash: "h-multi",
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
				kind: "admitAndRun",
				status: "accepted",
				firstCommitSeq: 1,
				lastCommitSeq: 1,
				runId,
				recordedAt: now,
			},
			events: [genericEvent(store, "ev-multi-1", runId, "multi-1", now)],
			run: baseRun(store, runId, now, { runVersion: 1 }),
		});

		// Second batch advances the same command with preserved firstCommitSeq.
		store.commit({
			command: {
				commandId,
				requestHash: "h-multi",
				callerPrincipal: "operator",
				authorizationContextHash: "h-multi",
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
				kind: "admitAndRun",
				status: "completed",
				firstCommitSeq: 1,
				lastCommitSeq: 2,
				runId,
				recordedAt: now + 1,
			},
			events: [genericEvent(store, "ev-multi-2", runId, "multi-2", now + 1)],
			run: baseRun(store, runId, now + 1, {
				status: "completed",
				stage: "terminal",
				runVersion: 2,
				updatedAt: now + 1,
			}),
		});

		const reopened = openProjectControlStore(t.project);
		const command = reopened.getCommand(commandId);
		assert.ok(command, "multi-commit command must remain readable after reopen");
		assert.equal(command!.firstCommitSeq, 1, "firstCommitSeq must stay at the original segment start");
		assert.equal(command!.lastCommitSeq, 2);
		assert.equal(command!.status, "completed");
	} finally {
		t.cleanup();
	}
});
