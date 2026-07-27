/**
 * P10 rollback tiers + P11 compaction cursor — behavior tests.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	advanceMinAvailable,
	checkCursor,
	createControlHost,
	deleteCompactedJournalFiles,
	hasControlStoreWrites,
	loadCompactionState,
	noteCommitSeq,
	openProjectControlStore,
	rollbackTier,
} from "../src/index.ts";

function temp(): { home: string; project: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p11-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p11-proj-"));
	return {
		home,
		project,
		env: { ...process.env, TASKFLOW_HOME: home },
		cleanup: () => {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(project, { recursive: true, force: true });
		},
	};
}

function appendGenericEvent(store: ReturnType<typeof openProjectControlStore>, eventId: string): void {
	store.commit({
		events: [
			{
				eventId,
				schemaVersion: 1,
				controlDomainId: store.header.controlDomainId,
				streamId: eventId,
				streamSeq: 0,
				commitSeq: 0,
				projectId: store.header.projectId,
				recordedAt: Date.now(),
				payload: { type: "Generic", kind: "test", data: {} },
			},
		],
	});
}

test("P10: full rollback before writes; export-only after; DomainTransfer forbidden", async () => {
	const t = temp();
	try {
		assert.equal(hasControlStoreWrites(t.project), false);
		const full = rollbackTier({ hasControlStoreWrites: false });
		assert.equal(full.tier, "full");

		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
		});
		const r = await host.admitAndRun({
			program: {
				name: "w",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		assert.equal(r.ok, true);
		assert.equal(hasControlStoreWrites(t.project), true);
		const after = rollbackTier({ hasControlStoreWrites: true });
		assert.equal(after.tier, "read-only-export");

		const dt = rollbackTier({
			hasControlStoreWrites: true,
			domainTransferAsRollback: true,
		});
		assert.equal(dt.tier, "forbidden");
		host.close();
	} finally {
		t.cleanup();
	}
});

test("P11: commitSeq never renumbered; cursor below min → TF_CURSOR_EXPIRED", () => {
	const t = temp();
	try {
		const store = openProjectControlStore(t.project);
		for (let commitSeq = 1; commitSeq <= 10; commitSeq++) {
			appendGenericEvent(store, `p11-history-${commitSeq}`);
		}
		noteCommitSeq(t.project, 10);
		let s = loadCompactionState(t.project);
		assert.equal(s.minAvailableCommitSeq, 1);
		assert.equal(s.maxCommitSeq, 10);

		const ok = checkCursor(t.project, 5);
		assert.equal(ok.ok, true);

		const adv = advanceMinAvailable(t.project, 4);
		assert.ok(!("error" in adv));
		s = loadCompactionState(t.project);
		assert.equal(s.minAvailableCommitSeq, 5);

		// Cannot decrease min
		const bad = advanceMinAvailable(t.project, 2);
		assert.ok("error" in bad);

		const expired = checkCursor(t.project, 3);
		assert.equal(expired.ok, false);
		if (!expired.ok) {
			assert.equal(expired.error.code, "TF_CURSOR_EXPIRED");
		}

		const stillOk = checkCursor(t.project, 5);
		assert.equal(stillOk.ok, true);

		// A caller cannot write a lower tail. The checkpoint itself is the next
		// journal commit, so the authoritative tail has advanced to 11.
		assert.throws(() => noteCommitSeq(t.project, 3), /TF_DURABILITY_FAILED/);
		assert.equal(loadCompactionState(t.project).maxCommitSeq, 11);
	} finally {
		t.cleanup();
	}
});

test("P11 counterexample: deleting an unjournaled cursor file must not resurrect expired history", () => {
	const t = temp();
	try {
		const store = openProjectControlStore(t.project);
		appendGenericEvent(store, "p11-history");

		// This is a legitimate old cursor under the current journal, not a test-only
		// made-up sequence. A durable compaction checkpoint must keep it expired
		// even if a separately stored cache/pathname vanishes.
		noteCommitSeq(t.project, 1);
		const advanced = advanceMinAvailable(t.project, 1);
		assert.ok(!("error" in advanced));
		if (!("error" in advanced)) {
			assert.equal(advanced.minAvailableCommitSeq, 2);
			assert.equal(advanced.lastCheckpointCommitSeq, 2);
		}
		const checkpoint = store.readEvents(2, 2);
		assert.equal(checkpoint.length, 1);
		assert.deepEqual(checkpoint[0]?.payload, { type: "CompactionCheckpoint", throughCommitSeq: 1 });
		assert.equal(checkCursor(t.project, 1).ok, false);

		const looseCursorPath = path.join(t.project, ".taskflow", "control", "compaction.json");
		if (!fs.existsSync(looseCursorPath)) {
			fs.writeFileSync(looseCursorPath, JSON.stringify({ minAvailableCommitSeq: 2, maxCommitSeq: 1 }));
		}
		fs.unlinkSync(looseCursorPath);
		const afterDeletion = checkCursor(t.project, 1);
		assert.equal(
			afterDeletion.ok,
			false,
			"deleting a cache/pathname must not make an expired cursor usable again",
		);
		if (!afterDeletion.ok) assert.equal(afterDeletion.error.code, "TF_CURSOR_EXPIRED");
	} finally {
		t.cleanup();
	}
});

test("P11: a raw public commit cannot checkpoint beyond the already durable journal tail", () => {
	const t = temp();
	try {
		const store = openProjectControlStore(t.project);
		appendGenericEvent(store, "p11-tail");
		assert.throws(
			() =>
				store.commit({
					events: [
						{
							eventId: "p11-invalid-checkpoint",
							schemaVersion: 1,
							controlDomainId: store.header.controlDomainId,
							streamId: "system-compaction",
							streamSeq: 0,
							commitSeq: 0,
							projectId: store.header.projectId,
							recordedAt: Date.now(),
							payload: { type: "CompactionCheckpoint", throughCommitSeq: 2 },
						},
					],
				}),
			/TF_DURABILITY_FAILED/,
		);
		assert.equal(store.getCompactionState().minAvailableCommitSeq, 1);
		assert.equal(store.readEvents(1, 10).length, 1, "rejected checkpoint must not publish a journal segment");
	} finally {
		t.cleanup();
	}
});

test("P11: cursor reads fail closed when an anchored ControlStore subtree is missing", () => {
	const t = temp();
	try {
		const store = openProjectControlStore(t.project);
		appendGenericEvent(store, "p11-anchor");
		fs.rmSync(path.join(t.project, ".taskflow"), { recursive: true, force: true });
		assert.throws(() => loadCompactionState(t.project), /TF_DURABILITY_FAILED/);
		assert.throws(() => checkCursor(t.project, 1), /TF_DURABILITY_FAILED/);
	} finally {
		t.cleanup();
	}
});

test("P11: physical journal deletion stays deferred after a durable cursor checkpoint", () => {
	const t = temp();
	try {
		const store = openProjectControlStore(t.project);
		appendGenericEvent(store, "p11-retained-1");
		appendGenericEvent(store, "p11-retained-2");

		const jdir = path.join(t.project, ".taskflow", "control", "journal");
		const before = fs.readdirSync(jdir).filter((f) => f.endsWith(".json"));
		assert.equal(before.length, 2);

		const checkpoint = advanceMinAvailable(t.project, 1);
		assert.ok(!("error" in checkpoint));
		const { removed, deferred } = deleteCompactedJournalFiles(t.project);
		assert.equal(removed, 0);
		assert.ok(deferred >= 1);
		assert.equal(
			fs.existsSync(path.join(jdir, before[0]!)),
			true,
			"cursor checkpoint alone must not invalidate the journal anchor",
		);
	} finally {
		t.cleanup();
	}
});
