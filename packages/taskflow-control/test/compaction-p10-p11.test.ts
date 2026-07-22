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

		// note lower seq does not renumber max down
		noteCommitSeq(t.project, 3);
		assert.equal(loadCompactionState(t.project).maxCommitSeq, 10);
	} finally {
		t.cleanup();
	}
});

test("P11: deleteCompactedJournalFiles removes only fully-below-min segments", async () => {
	const t = temp();
	try {
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
		});
		await host.admitAndRun({
			program: {
				name: "j",
				phases: [{ id: "main", type: "script", run: "echo x", final: true }],
			},
		});
		host.close();

		const jdir = path.join(t.project, ".taskflow", "control", "journal");
		const before = fs.readdirSync(jdir).filter((f) => f.endsWith(".json"));
		assert.ok(before.length >= 1);

		// Fake a fully-old segment name below min after advance
		noteCommitSeq(t.project, 100);
		advanceMinAvailable(t.project, 50);
		const fake = path.join(jdir, "000000000001-000000000002.json");
		fs.writeFileSync(fake, JSON.stringify({ commitSeqStart: 1, commitSeqEnd: 2 }));
		const { removed } = deleteCompactedJournalFiles(t.project);
		assert.ok(removed >= 1);
		assert.equal(fs.existsSync(fake), false);
	} finally {
		t.cleanup();
	}
});
