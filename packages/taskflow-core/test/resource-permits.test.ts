import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { WriteIntentJournal } from "../src/resources/journal.ts";
import {
	isIssuedMutationPermit,
	MutationPermitRegistry,
	type MutationPermit,
} from "../src/resources/permits.ts";
import type { ExecutionOwner } from "../src/resources/types.ts";

const OWNER: ExecutionOwner = {
	runId: "run",
	phaseId: "phase",
	attemptId: "attempt",
	unitId: "unit",
	ancestry: [],
};

function prepare(journal: WriteIntentJournal, prefix: string, owner = OWNER, ttl = 5_000) {
	return journal.prepare({
		resourceDomainId: "repo",
		scopes: [{ canonicalPrefix: prefix, scopeDigest: `scope-${path.basename(prefix)}` }],
		owner,
		beforeGeneration: 0,
		commitMode: "generation-only",
		externalMutation: "taskflow-managed",
		permitTtlMs: ttl,
	});
}

test("permits: owner mismatch, reconstruction, nonce tampering, and replay fail before activation", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-permits-"));
	const root = path.join(dir, "repo");
	fs.mkdirSync(root);
	try {
		const journal = new WriteIntentJournal({ directory: path.join(dir, "control"), journalEpoch: 7 });
		const prepared = await prepare(journal, root);
		await assert.rejects(
			journal.activate([prepared.permit], { ...OWNER, attemptId: "other-attempt" }),
			/owner mismatch/,
		);
		assert.equal(await journal.permits.stateOf(prepared.permit.permitId), "issued");

		const reconstructed = structuredClone(prepared.permit) as MutationPermit;
		assert.equal(isIssuedMutationPermit(prepared.permit), true);
		assert.equal(isIssuedMutationPermit(reconstructed), false);
		await assert.rejects(journal.activate([reconstructed], OWNER), /Unbranded or reconstructed/);
		const tampered = { ...prepared.permit, nonce: "tampered" } as MutationPermit;
		await assert.rejects(journal.activate([tampered], OWNER), /Unbranded or reconstructed/);
		assert.equal(await journal.permits.stateOf(prepared.permit.permitId), "issued");

		await journal.activate([prepared.permit], OWNER);
		await journal.assertActive(prepared.permit, OWNER);
		await assert.rejects(journal.activate([prepared.permit], OWNER), /activation replay rejected/);
		await journal.markUnknown(prepared.intent.intentId, "test settlement");
		await assert.rejects(journal.assertActive(prepared.permit, OWNER), /not pending|not active/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("permits: multi-permit activation is atomic", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-permits-atomic-"));
	const a = path.join(dir, "repo", "a");
	const b = path.join(dir, "repo", "b");
	fs.mkdirSync(a, { recursive: true });
	fs.mkdirSync(b, { recursive: true });
	try {
		const journal = new WriteIntentJournal({ directory: path.join(dir, "control"), journalEpoch: 1 });
		const first = await prepare(journal, a);
		const second = await prepare(journal, b);
		const fakeSecond = structuredClone(second.permit) as MutationPermit;
		await assert.rejects(journal.activate([first.permit, fakeSecond], OWNER), /Unbranded or reconstructed/);
		assert.equal(await journal.permits.stateOf(first.permit.permitId), "issued");
		assert.equal(await journal.permits.stateOf(second.permit.permitId), "issued");
		await journal.activate([first.permit, second.permit], OWNER);
		assert.equal(await journal.permits.stateOf(first.permit.permitId), "active");
		assert.equal(await journal.permits.stateOf(second.permit.permitId), "active");
		await journal.markUnknown(first.intent.intentId, "cleanup");
		await journal.markUnknown(second.intent.intentId, "cleanup");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("permits: expiry and journal epoch rotation invalidate prepared plans", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-permits-expiry-"));
	const root = path.join(dir, "repo");
	const sibling = path.join(dir, "sibling");
	fs.mkdirSync(root);
	fs.mkdirSync(sibling);
	let now = Date.now();
	try {
		const control = path.join(dir, "control");
		const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1, now: () => now });
		const expiring = await prepare(journal, root, OWNER, 10);
		now += 11;
		await assert.rejects(journal.activate([expiring.permit], OWNER), /expired.*replay rejected/);
		assert.equal(await journal.permits.stateOf(expiring.permit.permitId), "expired");
		const liveOldEpoch = await prepare(journal, sibling, { ...OWNER, attemptId: "old-epoch-live" }, 5_000);

		const epochTwo = new MutationPermitRegistry({ directory: control, journalEpoch: 2, now: () => now });
		assert.equal(await epochTwo.invalidateOlderEpochs(), 1);
		assert.equal(await epochTwo.stateOf(liveOldEpoch.permit.permitId), "expired");
		await journal.recoverPending();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("permits: activation TTL does not invalidate a live long-running mutation", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-permits-long-running-"));
	const root = path.join(dir, "repo");
	fs.mkdirSync(root);
	let now = 1_000;
	try {
		const journal = new WriteIntentJournal({
			directory: path.join(dir, "control"),
			journalEpoch: 1,
			now: () => now,
		});
		const prepared = await prepare(journal, root, OWNER, 10);
		await journal.activate([prepared.permit], OWNER);
		now = 10_000;
		assert.equal(await journal.permits.stateOf(prepared.permit.permitId), "active");
		const committed = await journal.commitGeneration(prepared.intent.intentId);
		assert.equal(committed.status, "committed-generation");
		assert.equal(await journal.permits.stateOf(prepared.permit.permitId), "settled");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
