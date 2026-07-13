import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	WriteIntentJournal,
	type PrepareWriteIntent,
} from "../src/resources/journal.ts";
import { MutationPermitRegistry } from "../src/resources/permits.ts";
import type { ExecutionOwner, ScopedContentEvidence } from "../src/resources/types.ts";

const OWNER: ExecutionOwner = {
	runId: "run",
	phaseId: "phase",
	attemptId: "attempt",
	unitId: "unit",
	ancestry: [],
};

function evidence(prefix: string, suffix: string, after = false): ScopedContentEvidence {
	return {
		canonicalPrefix: prefix,
		scopeDigest: `scope-${suffix}`,
		beforeContentId: `before-${suffix}`,
		...(after ? { afterContentId: `after-${suffix}` } : {}),
	};
}

function input(prefix: string, overrides: Partial<PrepareWriteIntent> = {}): PrepareWriteIntent {
	return {
		resourceDomainId: "repo",
		scopes: [evidence(prefix, path.basename(prefix))],
		owner: OWNER,
		beforeGeneration: 0,
		commitMode: "generation-only",
		externalMutation: "taskflow-managed",
		permitTtlMs: 5_000,
		...overrides,
	};
}

class FailingSettlementPermitRegistry extends MutationPermitRegistry {
	override async settleIntent(_intentId: string): Promise<void> {
		throw new Error("injected permit settlement failure");
	}
}

test("journal: fsynced pending intent precedes permit issuance and activation is once-only", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-journal-"));
	const root = path.join(dir, "repo");
	fs.mkdirSync(root);
	try {
		const journal = new WriteIntentJournal({ directory: path.join(dir, "control"), journalEpoch: 1, pollMs: 5 });
		const prepared = await journal.prepare(input(root));
		const lines = fs.readFileSync(journal.walPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string });
		assert.deepEqual(lines.map((record) => record.type), ["write-intent"]);
		assert.equal(prepared.intent.status, "pending");
		assert.equal(await journal.permits.stateOf(prepared.permit.permitId), "issued");
		await assert.rejects(journal.commitGeneration(prepared.intent.intentId), /no active mutation permit/);
		await journal.activate([prepared.permit], OWNER);
		assert.equal(await journal.permits.stateOf(prepared.permit.permitId), "active");
		await assert.rejects(journal.activate([prepared.permit], OWNER), /activation replay rejected/);
		const committed = await journal.commitGeneration(prepared.intent.intentId);
		assert.equal(committed.commitGeneration, 1);
		assert.equal(committed.status, "committed-generation");
		assert.equal(await journal.permits.stateOf(prepared.permit.permitId), "settled");
		assert.equal(await journal.getDomainGeneration("repo"), 1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("journal: disjoint writers receive generations in durable commit WAL order", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-journal-order-"));
	const a = path.join(dir, "repo", "a");
	const b = path.join(dir, "repo", "b");
	fs.mkdirSync(a, { recursive: true });
	fs.mkdirSync(b, { recursive: true });
	try {
		const journal = new WriteIntentJournal({ directory: path.join(dir, "control"), journalEpoch: 1 });
		const first = await journal.prepare(input(a));
		const second = await journal.prepare(input(b, { owner: { ...OWNER, attemptId: "attempt-2" } }));
		assert.equal(first.intent.intentSequence, 1);
		assert.equal(second.intent.intentSequence, 2);
		await journal.activate([first.permit], first.intent.owner);
		await journal.activate([second.permit], second.intent.owner);
		const secondCommit = await journal.commitGeneration(second.intent.intentId);
		const firstCommit = await journal.commitGeneration(first.intent.intentId);
		assert.equal(secondCommit.commitGeneration, 1);
		assert.equal(firstCommit.commitGeneration, 2);
		const records = fs.readFileSync(journal.walPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; intentId?: string; commitGeneration?: number });
		const commits = records.filter((record) => record.type === "write-commit-generation");
		assert.deepEqual(commits.map((record) => [record.intentId, record.commitGeneration]), [
			[second.intent.intentId, 1],
			[first.intent.intentId, 2],
		]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("journal: post-commit permit cleanup failure never makes a committed write retryable", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-journal-postcommit-"));
	const root = path.join(dir, "repo");
	const control = path.join(dir, "control");
	fs.mkdirSync(root);
	const originalWarn = console.warn;
	console.warn = () => undefined;
	try {
		const permits = new FailingSettlementPermitRegistry({ directory: control, journalEpoch: 1 });
		const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1, permitRegistry: permits });
		const prepared = await journal.prepare(input(root));
		await journal.activate([prepared.permit], OWNER);
		const committed = await journal.commitGeneration(prepared.intent.intentId);
		assert.equal(committed.status, "committed-generation");
		assert.equal(committed.commitGeneration, 1);
		assert.equal(await permits.stateOf(prepared.permit.permitId), "active");

		const restarted = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
		const recovery = await restarted.recoverPending();
		assert.deepEqual(recovery.recoveredIntentIds, []);
		assert.equal((await restarted.getIntent(prepared.intent.intentId))?.status, "committed-generation");
		assert.equal(await restarted.permits.stateOf(prepared.permit.permitId), "settled");
	} finally {
		console.warn = originalWarn;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("journal: overlapping pending/dirty scopes block while disjoint scopes proceed", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-journal-overlap-"));
	const root = path.join(dir, "repo");
	const child = path.join(root, "child");
	const sibling = path.join(root, "sibling");
	fs.mkdirSync(child, { recursive: true });
	fs.mkdirSync(sibling);
	try {
		const journal = new WriteIntentJournal({ directory: path.join(dir, "control"), journalEpoch: 1 });
		const pending = await journal.prepare(input(child));
		await assert.rejects(journal.prepare(input(root, { owner: { ...OWNER, attemptId: "overlap" } })), /overlaps pending intent/);
		const disjoint = await journal.prepare(input(sibling, { owner: { ...OWNER, attemptId: "disjoint" } }));
		await journal.markUnknown(pending.intent.intentId, "writer crashed");
		await assert.rejects(journal.prepare(input(child, { owner: { ...OWNER, attemptId: "dirty" } })), /overlaps dirty-unknown intent/);
		await journal.markUnknown(disjoint.intent.intentId, "test cleanup");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("journal: explicit reconciliation durably advances generation and unblocks writes", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-journal-reconcile-"));
	const root = path.join(dir, "repo");
	fs.mkdirSync(root);
	try {
		const journal = new WriteIntentJournal({ directory: path.join(dir, "control"), journalEpoch: 1 });
		const dirty = await journal.prepare(input(root));
		await journal.markUnknown(dirty.intent.intentId, "writer outcome unknown");
		await assert.rejects(
			journal.prepare(input(root, { owner: { ...OWNER, attemptId: "blocked" } })),
			/overlaps dirty-unknown intent/,
		);

		const reconciled = await journal.reconcileDomain("repo", "operator inspected and accepted the tree");
		assert.deepEqual(reconciled, {
			resourceDomainId: "repo",
			previousGeneration: 0,
			generation: 1,
			reconciledIntentIds: [dirty.intent.intentId],
		});
		assert.equal((await journal.getIntent(dirty.intent.intentId))?.status, "reconciled");
		assert.equal(await journal.getDomainGeneration("repo"), 1);

		const next = await journal.prepare(input(root, {
			beforeGeneration: undefined,
			owner: { ...OWNER, attemptId: "after-reconcile" },
		}));
		await journal.markUnknown(next.intent.intentId, "test cleanup");
		const recordTypes = fs.readFileSync(journal.walPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as { type: string }).type);
		assert.deepEqual(recordTypes.slice(0, 3), ["write-intent", "write-unknown", "write-reconcile"]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("journal: startup recovery truncates a partial WAL tail and marks pending dirty-unknown", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-journal-recovery-"));
	const root = path.join(dir, "repo");
	fs.mkdirSync(root);
	try {
		const control = path.join(dir, "control");
		const first = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
		const prepared = await first.prepare(input(root));
		fs.appendFileSync(first.walPath, '{"journalVersion":1,"type":"write-commit-generation"');
		const restarted = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
		const recovery = await restarted.recoverPending();
		assert.deepEqual(recovery.recoveredIntentIds, [prepared.intent.intentId]);
		assert.deepEqual(recovery.dirtyDomains, ["repo"]);
		assert.equal((await restarted.getIntent(prepared.intent.intentId))?.status, "dirty-unknown");
		assert.equal(await restarted.permits.stateOf(prepared.permit.permitId), "settled");
		assert.ok(fs.readFileSync(restarted.walPath, "utf8").endsWith("\n"));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("journal: startup recovery preserves pending intents owned by a live writer", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-journal-live-owner-"));
	const root = path.join(dir, "repo");
	fs.mkdirSync(root);
	try {
		const journal = new WriteIntentJournal({ directory: path.join(dir, "control"), journalEpoch: 1 });
		const active = await journal.prepare(input(root));
		const abandoned = await journal.prepare(input(path.join(root, "disjoint"), {
			resourceDomainId: "other",
			owner: { ...OWNER, attemptId: "abandoned" },
		}));
		const recovery = await journal.recoverPending(undefined, {
			isOwnerActive: (owner) => owner.attemptId === active.intent.owner.attemptId,
		});
		assert.deepEqual(recovery.recoveredIntentIds, [abandoned.intent.intentId]);
		assert.equal((await journal.getIntent(active.intent.intentId))?.status, "pending");
		assert.equal(await journal.permits.stateOf(active.permit.permitId), "issued");
		assert.equal((await journal.getIntent(abandoned.intent.intentId))?.status, "dirty-unknown");
		assert.equal(await journal.permits.stateOf(abandoned.permit.permitId), "settled");
		await journal.markUnknown(active.intent.intentId, "test cleanup");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("journal: content commits require exact scopes and trustworthy post-state evidence", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-journal-content-"));
	const root = path.join(dir, "repo");
	const child = path.join(root, "child");
	fs.mkdirSync(child, { recursive: true });
	try {
		const journal = new WriteIntentJournal({ directory: path.join(dir, "control"), journalEpoch: 1 });
		const prepared = await journal.prepare(input(root, {
			commitMode: "content-snapshot",
			// Parent scope removes the contained child from the durable minimal cover.
			scopes: [evidence(root, "root"), evidence(child, "child")],
		}));
		assert.equal(prepared.intent.scopes.length, 1);
		await journal.activate([prepared.permit], OWNER);
		await assert.rejects(journal.commitContent(prepared.intent.intentId, [evidence(root, "root")]), /afterContentId/);
		await assert.rejects(journal.commitContent(prepared.intent.intentId, [evidence(child, "child", true)]), /do not match/);
		const committed = await journal.commitContent(prepared.intent.intentId, [evidence(root, "root", true)], ["snapshot-artifact"]);
		assert.equal(committed.status, "committed-content");
		assert.equal(committed.commitGeneration, 1);
		assert.deepEqual(committed.restorableSnapshotArtifactIds, ["snapshot-artifact"]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
