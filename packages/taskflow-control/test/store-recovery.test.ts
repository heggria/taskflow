/**
 * Journal-authoritative recovery after half-commit (projection deleted).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fsDefault from "node:fs";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	createControlHost,
	createScriptExecutionProvider,
	openProjectControlStore,
	openUserCoordinatorStore as openUserCoordinatorStoreRaw,
	projectControlRoot,
} from "../src/index.ts";

const helpersDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers");

/** Raw global C2 fixtures in this suite are explicit non-GA test plumbing. */
function openUserCoordinatorStore(env: NodeJS.ProcessEnv = process.env) {
	return openUserCoordinatorStoreRaw(env, {
		allowUnfencedMutationForExplicitNonGaMode: true,
	});
}

function assertDurabilityFailure(error: unknown): boolean {
	assert.equal((error as { code?: string }).code, "TF_DURABILITY_FAILED", String(error));
	return true;
}

async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(file)) {
		if (Date.now() >= deadline) {
			throw new Error(`timed out waiting for ${file}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function waitForChild(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolve) => {
		let stderr = "";
		child.stderr?.setEncoding("utf-8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("close", (code) => resolve({ code, stderr }));
	});
}

function appendGenericEvent(
	store: ReturnType<typeof openProjectControlStore>,
	eventId: string,
	streamId = eventId,
): void {
	store.commit({
		events: [
			{
				eventId,
				schemaVersion: 1,
				controlDomainId: store.header.controlDomainId,
				streamId,
				streamSeq: 0,
				commitSeq: 0,
				projectId: store.header.projectId,
				recordedAt: Date.now(),
				payload: { type: "Generic", kind: "test", data: {} },
			},
		],
	});
}

type MutableJournalEntry = {
	commitSeqStart: number;
	commitSeqEnd: number;
	command?: unknown;
	events: unknown[];
	run?: unknown;
	receipt?: unknown;
	recordedAt: number;
	previousSegmentHash: string | null;
	segmentHash: string;
};

/** Mirror the intentional canonical segment wire format so a test can prove
 * semantic validation still rejects an attacker who recomputes hashes. */
function rehashJournalEntry(entry: MutableJournalEntry): MutableJournalEntry {
	const base = {
		commitSeqStart: entry.commitSeqStart,
		commitSeqEnd: entry.commitSeqEnd,
		...(entry.command === undefined ? {} : { command: entry.command }),
		events: entry.events,
		...(entry.run === undefined ? {} : { run: entry.run }),
		...(entry.receipt === undefined ? {} : { receipt: entry.receipt }),
		recordedAt: entry.recordedAt,
		previousSegmentHash: entry.previousSegmentHash,
	};
	entry.segmentHash = createHash("sha256").update(JSON.stringify(base, null, 2), "utf-8").digest("hex");
	return entry;
}

function rewriteTailSegment(
	project: string,
	mutate: (entry: MutableJournalEntry) => void,
): void {
	const controlRoot = projectControlRoot(project);
	const journalDir = path.join(controlRoot, "journal");
	const files = fs.readdirSync(journalDir).filter((file) => file.endsWith(".json")).sort();
	const tailPath = path.join(journalDir, files.at(-1)!);
	const entry = JSON.parse(fs.readFileSync(tailPath, "utf-8")) as MutableJournalEntry;
	mutate(entry);
	rehashJournalEntry(entry);
	fs.writeFileSync(tailPath, JSON.stringify(entry, null, 2), "utf-8");

	const anchorPath = path.join(controlRoot, "journal.anchor.json");
	const anchor = JSON.parse(fs.readFileSync(anchorPath, "utf-8")) as Record<string, unknown>;
	anchor.tailSegmentHash = entry.segmentHash;
	fs.writeFileSync(anchorPath, JSON.stringify(anchor, null, 2), "utf-8");
}

test("journal recovery: deleted run projection rebuilds from journal on open", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-proj-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	try {
		const host = createControlHost({
			projectRoot: project,
			env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createScriptExecutionProvider(),
		});
		const r = await host.admitAndRun({
			program: {
				name: "recover-me",
				phases: [{ id: "main", type: "script", run: "echo recovered", final: true }],
			},
			commandId: "cmd-recover-1",
		});
		assert.equal(r.ok, true, JSON.stringify(r.error));
		const runId = r.run!.runId;
		const receiptId = r.receipt!.receiptId;
		host.close();

		// Simulate half-commit: journal intact, projection deleted
		const projPath = path.join(project, ".taskflow", "control", "projections", `run-${runId}.json`);
		assert.ok(fs.existsSync(projPath));
		fs.unlinkSync(projPath);
		const byRun = path.join(project, ".taskflow", "control", "receipts", `by-run-${runId}.json`);
		if (fs.existsSync(byRun)) fs.unlinkSync(byRun);
		const receiptPath = path.join(project, ".taskflow", "control", "receipts", `${receiptId}.json`);
		if (fs.existsSync(receiptPath)) fs.unlinkSync(receiptPath);

		const store = openProjectControlStore(project);
		const recovered = store.getRun(runId);
		assert.ok(recovered, "run projection must rebuild from journal");
		assert.equal(recovered!.status, "completed");
		assert.equal(recovered!.runId, runId);

		const cmd = store.getCommand("cmd-recover-1");
		assert.ok(cmd);
		assert.equal(cmd!.runId, runId);

		// Explicit recover after deleting again
		fs.unlinkSync(path.join(project, ".taskflow", "control", "projections", `run-${runId}.json`));
		const stats = store.recoverFromJournal();
		assert.ok(stats.rebuiltRuns >= 1);
		assert.ok(store.getRun(runId));
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("ControlStore startup: malformed header fails closed without minting a replacement identity", () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-bad-header-"));
	const headerPath = path.join(projectControlRoot(project), "header.json");
	const corrupt = "{ this is not JSON";
	try {
		fs.mkdirSync(path.dirname(headerPath), { recursive: true });
		fs.writeFileSync(headerPath, corrupt, "utf-8");

		assert.throws(() => openProjectControlStore(project), assertDurabilityFailure);
		assert.equal(
			fs.readFileSync(headerPath, "utf-8"),
			corrupt,
			"startup must preserve corrupt evidence rather than mint a new header",
		);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("ControlStore startup: a project-root anchor preserves control-subtree loss as durable evidence", () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-project-anchor-loss-"));
	const controlTree = path.join(project, ".taskflow");
	const anchorPath = path.join(project, ".taskflow-control.anchor.json");
	try {
		const initial = openProjectControlStore(project);
		assert.ok(fs.existsSync(anchorPath), "first durable identity must publish a project-root anchor");
		const anchorBytes = fs.readFileSync(anchorPath, "utf-8");
		const anchor = JSON.parse(anchorBytes) as {
			projectId: string;
			controlDomainId: string;
		};
		assert.equal(anchor.projectId, initial.header.projectId);
		assert.equal(anchor.controlDomainId, initial.header.controlDomainId);

		fs.rmSync(controlTree, { recursive: true, force: true });
		assert.throws(() => openProjectControlStore(project), assertDurabilityFailure);
		assert.equal(
			fs.existsSync(controlTree),
			false,
			"an anchored missing control subtree must not be silently recreated as a new authority",
		);
		assert.equal(fs.readFileSync(anchorPath, "utf-8"), anchorBytes);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("ControlStore startup: missing project-root anchor from an existing header fails closed", () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-project-anchor-missing-"));
	const anchorPath = path.join(project, ".taskflow-control.anchor.json");
	try {
		const initial = openProjectControlStore(project);
		const headerPath = path.join(projectControlRoot(project), "header.json");
		const headerBytes = fs.readFileSync(headerPath, "utf-8");
		assert.ok(fs.existsSync(anchorPath), "first durable identity must publish a project-root anchor");

		fs.unlinkSync(anchorPath);
		assert.throws(
			() => openProjectControlStore(project, { readOnly: true }),
			assertDurabilityFailure,
			"read-only attach must not treat missing identity evidence as a legacy store",
		);
		assert.throws(
			() => openProjectControlStore(project, { identityPolicy: "new-identity" }),
			assertDurabilityFailure,
			"new-identity must not turn deleted identity evidence into an implicit migration",
		);
		assert.throws(
			() => openProjectControlStore(project, { identityPolicy: "rebind" }),
			assertDurabilityFailure,
			"rebind must not turn deleted identity evidence into an implicit migration",
		);
		assert.throws(() => openProjectControlStore(project), assertDurabilityFailure);
		assert.equal(
			fs.readFileSync(headerPath, "utf-8"),
			headerBytes,
			"missing identity evidence must not rewrite or mint a replacement header",
		);
		assert.equal(initial.header.projectId.length > 0, true);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("ControlStore startup: a project-root anchor must match the durable header identity", () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-project-anchor-mismatch-"));
	const anchorPath = path.join(project, ".taskflow-control.anchor.json");
	try {
		const initial = openProjectControlStore(project);
		fs.writeFileSync(
			anchorPath,
			JSON.stringify(
				{
					schemaVersion: 1,
					projectId: initial.header.projectId,
					controlDomainId: "dom-anchor-mismatch",
					createdAt: 1,
				},
				null,
				2,
			),
			"utf-8",
		);

		assert.throws(() => openProjectControlStore(project), assertDurabilityFailure);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("P14 counterexample: a whole local control snapshot rollback is internally valid and undetectable", () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-whole-root-rollback-"));
	const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-whole-root-rollback-snapshot-"));
	const controlRoot = projectControlRoot(project);
	const rootAnchorPath = path.join(project, ".taskflow-control.anchor.json");
	const snapshotControlRoot = path.join(snapshot, "control");
	const snapshotRootAnchorPath = path.join(snapshot, "root-anchor.json");
	try {
		const initial = openProjectControlStore(project);
		appendGenericEvent(initial, "ev-before-whole-root-rollback", "whole-root-rollback");
		fs.cpSync(controlRoot, snapshotControlRoot, { recursive: true });
		fs.copyFileSync(rootAnchorPath, snapshotRootAnchorPath);

		appendGenericEvent(initial, "ev-after-whole-root-rollback", "whole-root-rollback");
		assert.deepEqual(
			initial.readEvents(1, initial.nextCommitSeq() - 1).map((event) => event.eventId),
			["ev-before-whole-root-rollback", "ev-after-whole-root-rollback"],
		);

		// An attacker/restorer that can replace both the mutable control subtree
		// and the project-root anchor gives the current local-only trust model a
		// self-consistent older history. This is deliberately a counterexample,
		// not a GA behavior claim: an external trust anchor or authorized repair
		// protocol is required before reopening may reject it.
		fs.rmSync(controlRoot, { recursive: true, force: true });
		fs.cpSync(snapshotControlRoot, controlRoot, { recursive: true });
		fs.copyFileSync(snapshotRootAnchorPath, rootAnchorPath);

		const reopened = openProjectControlStore(project);
		assert.equal(reopened.header.projectId, initial.header.projectId);
		assert.deepEqual(
			reopened.readEvents(1, reopened.nextCommitSeq() - 1).map((event) => event.eventId),
			["ev-before-whole-root-rollback"],
			"the current local anchor/hash chain cannot distinguish a coherent older snapshot",
		);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
		fs.rmSync(snapshot, { recursive: true, force: true });
	}
});

test(
	"ControlStore startup: a symlinked .taskflow root fails closed without creating external state",
	{ skip: process.platform === "win32" },
	() => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-symlink-root-"));
		const external = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-symlink-external-"));
		const sentinelPath = path.join(external, "must-not-change");
		try {
			fs.writeFileSync(sentinelPath, "outside durable target", "utf-8");
			fs.symlinkSync(external, path.join(project, ".taskflow"), "dir");

			assert.throws(() => openProjectControlStore(project), assertDurabilityFailure);
			assert.deepEqual(
				fs.readdirSync(external).sort(),
				["must-not-change"],
				"a rejected project root must not create header/journal data through the symlink",
			);
			assert.equal(fs.readFileSync(sentinelPath, "utf-8"), "outside durable target");
		} finally {
			fs.rmSync(project, { recursive: true, force: true });
			fs.rmSync(external, { recursive: true, force: true });
		}
	},
);

test(
	"ControlStore startup: a symlinked project-root anchor is rejected rather than followed",
	{ skip: process.platform === "win32" },
	() => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-symlink-root-anchor-"));
		const external = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-symlink-root-anchor-target-"));
		const anchorPath = path.join(project, ".taskflow-control.anchor.json");
		const externalAnchorPath = path.join(external, "anchor.json");
		try {
			fs.writeFileSync(externalAnchorPath, "outside durable root anchor", "utf-8");
			fs.symlinkSync(externalAnchorPath, anchorPath, "file");

			assert.throws(() => openProjectControlStore(project), assertDurabilityFailure);
			assert.equal(
				fs.readFileSync(externalAnchorPath, "utf-8"),
				"outside durable root anchor",
				"a failed open must not replace an external root-anchor target",
			);
		} finally {
			fs.rmSync(project, { recursive: true, force: true });
			fs.rmSync(external, { recursive: true, force: true });
		}
	},
);

test(
	"ControlStore startup: a symlinked durable header is rejected rather than followed",
	{ skip: process.platform === "win32" },
	() => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-symlink-header-"));
		const external = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-symlink-header-target-"));
		const headerPath = path.join(projectControlRoot(project), "header.json");
		const externalHeaderPath = path.join(external, "header.json");
		try {
			openProjectControlStore(project);
			fs.copyFileSync(headerPath, externalHeaderPath);
			const originalExternalHeader = fs.readFileSync(externalHeaderPath, "utf-8");
			fs.unlinkSync(headerPath);
			fs.symlinkSync(externalHeaderPath, headerPath, "file");

			assert.throws(() => openProjectControlStore(project), assertDurabilityFailure);
			assert.equal(
				fs.readFileSync(externalHeaderPath, "utf-8"),
				originalExternalHeader,
				"a failed durable open must not rewrite an external header target",
			);
		} finally {
			fs.rmSync(project, { recursive: true, force: true });
			fs.rmSync(external, { recursive: true, force: true });
		}
	},
);

test(
	"ControlStore startup: a symlinked journal directory is rejected rather than treated as local authority",
	{ skip: process.platform === "win32" },
	() => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-symlink-journal-"));
		const external = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-symlink-journal-target-"));
		const journalDir = path.join(projectControlRoot(project), "journal");
		const sentinelPath = path.join(external, "must-not-read-as-journal");
		try {
			const store = openProjectControlStore(project);
			fs.rmSync(journalDir, { recursive: true, force: true });
			fs.writeFileSync(sentinelPath, "external journal target", "utf-8");
			fs.symlinkSync(external, journalDir, "dir");

			assert.throws(
				() => appendGenericEvent(store, "ev-must-not-write-through-journal-symlink"),
				assertDurabilityFailure,
			);
			assert.throws(() => openProjectControlStore(project), assertDurabilityFailure);
			assert.deepEqual(fs.readdirSync(external).sort(), ["must-not-read-as-journal"]);
		} finally {
			fs.rmSync(project, { recursive: true, force: true });
			fs.rmSync(external, { recursive: true, force: true });
		}
	},
);

test(
	"ControlStore read-only journal snapshot: a post-open journal symlink fails closed",
	{ skip: process.platform === "win32" },
	() => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-symlink-snapshot-"));
		const external = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-symlink-snapshot-target-"));
		const journalDir = path.join(projectControlRoot(project), "journal");
		const sentinelPath = path.join(external, "must-not-read-as-snapshot");
		try {
			openProjectControlStore(project);
			const attach = openProjectControlStore(project, { readOnly: true });
			fs.rmSync(journalDir, { recursive: true, force: true });
			fs.writeFileSync(sentinelPath, "external snapshot target", "utf-8");
			fs.symlinkSync(external, journalDir, "dir");

			assert.throws(() => attach.getJournalRunSnapshot("attach-snapshot-run"), assertDurabilityFailure);
			assert.equal(fs.readFileSync(sentinelPath, "utf-8"), "external snapshot target");
		} finally {
			fs.rmSync(project, { recursive: true, force: true });
			fs.rmSync(external, { recursive: true, force: true });
		}
	},
);

test("ControlStore read-only journal snapshot: an anchor advance during observation fails closed then retries", () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-anchor-advance-"));
	const originalReadFileSync = fsDefault.readFileSync;
	let patched = false;
	try {
		const writer = openProjectControlStore(project);
		appendGenericEvent(writer, "anchor-observation-baseline", "anchor-observation-baseline");
		const anchorPath = path.join(projectControlRoot(project), "journal.anchor.json");
		const attach = openProjectControlStore(project, { readOnly: true });
		const patchedReadFileSync = ((...args: unknown[]) => {
			const value = Reflect.apply(originalReadFileSync, fsDefault, args);
			if (!patched && args[0] === anchorPath) {
				patched = true;
				Object.defineProperty(fsDefault, "readFileSync", {
					value: originalReadFileSync,
					configurable: true,
					writable: true,
				});
				syncBuiltinESMExports();
				appendGenericEvent(writer, "anchor-advance-during-read", "anchor-advance-during-read");
			}
			return value;
		}) as typeof fsDefault.readFileSync;
		Object.defineProperty(fsDefault, "readFileSync", {
			value: patchedReadFileSync,
			configurable: true,
			writable: true,
		});
		syncBuiltinESMExports();

		assert.throws(() => attach.getJournalRunSnapshot("anchor-advance-run"), assertDurabilityFailure);
		assert.equal(patched, true);
		assert.deepEqual(attach.getJournalRunSnapshot("anchor-advance-run"), {
			run: null,
			continuation: null,
			approval: null,
			receipt: null,
		});
	} finally {
		Object.defineProperty(fsDefault, "readFileSync", {
			value: originalReadFileSync,
			configurable: true,
			writable: true,
		});
		syncBuiltinESMExports();
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test(
	"ControlStore status reads: a symlinked derived projection directory fails closed without reading external state",
	{ skip: process.platform === "win32" },
	() => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-symlink-projections-"));
		const external = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-symlink-projections-target-"));
		const projectionsDir = path.join(projectControlRoot(project), "projections");
		const sentinelPath = path.join(external, "run-external.json");
		try {
			const store = openProjectControlStore(project);
			const externalProjection = JSON.stringify({
				runId: "external",
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
				status: "running",
				stage: "received",
				boundPlanHash: "plan-external",
				needsOperator: false,
				createdAt: 1,
				updatedAt: 1,
				runVersion: 1,
			});
			fs.rmSync(projectionsDir, { recursive: true, force: true });
			fs.writeFileSync(sentinelPath, externalProjection, "utf-8");
			fs.symlinkSync(external, projectionsDir, "dir");

			assert.throws(() => store.listRuns(), assertDurabilityFailure);
			assert.equal(fs.readFileSync(sentinelPath, "utf-8"), externalProjection);
		} finally {
			fs.rmSync(project, { recursive: true, force: true });
			fs.rmSync(external, { recursive: true, force: true });
		}
	},
);

test("ControlStore startup: malformed journal segment fails closed and remains inspectable", () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-bad-journal-"));
	const corrupt = "{ definitely not JSON";
	try {
		const initial = openProjectControlStore(project);
		appendGenericEvent(initial, "ev-recovery-corrupt", "recovery-corrupt");
		const segment = path.join(projectControlRoot(project), "journal", "000000000001-000000000001.json");
		fs.writeFileSync(segment, corrupt, "utf-8");

		assert.throws(() => openProjectControlStore(project), assertDurabilityFailure);
		assert.equal(fs.readFileSync(segment, "utf-8"), corrupt);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("ControlStore startup: malformed commit sequence fails closed without sequence reuse", () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-bad-seq-"));
	const corrupt = "{ next: definitely not JSON";
	const seqPath = path.join(projectControlRoot(project), "commit-seq.json");
	try {
		const initial = openProjectControlStore(project);
		appendGenericEvent(initial, "ev-recovery-seq");
		fs.writeFileSync(seqPath, corrupt, "utf-8");

		assert.throws(() => openProjectControlStore(project), assertDurabilityFailure);
		assert.equal(fs.readFileSync(seqPath, "utf-8"), corrupt);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("ControlStore recovery: a missing commit sequence is rebuilt from the authoritative journal", () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-seq-rebuild-"));
	const controlRoot = projectControlRoot(project);
	const seqPath = path.join(controlRoot, "commit-seq.json");
	try {
		const initial = openProjectControlStore(project);
		appendGenericEvent(initial, "ev-recovery-seq-first");
		fs.unlinkSync(seqPath);

		const recovered = openProjectControlStore(project);
		assert.deepEqual(JSON.parse(fs.readFileSync(seqPath, "utf-8")), { next: 2 });
		appendGenericEvent(recovered, "ev-recovery-seq-second");
		const files = fs
			.readdirSync(path.join(controlRoot, "journal"))
			.filter((file) => file.endsWith(".json"))
			.sort();
		assert.deepEqual(files, ["000000000001-000000000001.json", "000000000002-000000000002.json"]);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("ControlStore startup: a sequence ahead of the journal is an integrity failure", () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-seq-ahead-"));
	const seqPath = path.join(projectControlRoot(project), "commit-seq.json");
	try {
		const initial = openProjectControlStore(project);
		appendGenericEvent(initial, "ev-recovery-seq-ahead");
		fs.writeFileSync(seqPath, JSON.stringify({ next: 99 }), "utf-8");

		assert.throws(() => openProjectControlStore(project), assertDurabilityFailure);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("ControlStore startup: journal prefix loss is rejected against its durable anchor", () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-journal-prefix-"));
	const controlRoot = projectControlRoot(project);
	const journalDir = path.join(controlRoot, "journal");
	const anchorPath = path.join(controlRoot, "journal.anchor.json");
	try {
		const initial = openProjectControlStore(project);
		appendGenericEvent(initial, "ev-journal-prefix-1");
		appendGenericEvent(initial, "ev-journal-prefix-2");
		assert.ok(fs.existsSync(anchorPath), "first durable journal commit must publish an anchor");
		const files = fs.readdirSync(journalDir).filter((file) => file.endsWith(".json")).sort();
		assert.equal(files.length, 2);
		fs.unlinkSync(path.join(journalDir, files[0]!));

		assert.throws(() => openProjectControlStore(project), assertDurabilityFailure);
		assert.equal(fs.existsSync(path.join(journalDir, files[0]!)), false);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("ControlStore startup: all journal segments missing after an anchored commit fail closed", () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-journal-all-"));
	const controlRoot = projectControlRoot(project);
	const journalDir = path.join(controlRoot, "journal");
	try {
		const initial = openProjectControlStore(project);
		appendGenericEvent(initial, "ev-journal-all");
		fs.rmSync(journalDir, { recursive: true, force: true });

		assert.throws(() => openProjectControlStore(project), assertDurabilityFailure);
		assert.equal(fs.existsSync(journalDir), false, "reopen must preserve missing journal evidence");
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("ControlStore startup: journal payload tampering is rejected by the anchored hash chain", () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-journal-hash-"));
	const segmentPath = path.join(
		projectControlRoot(project),
		"journal",
		"000000000001-000000000001.json",
	);
	try {
		const initial = openProjectControlStore(project);
		appendGenericEvent(initial, "ev-journal-hash");
		const tampered = JSON.parse(fs.readFileSync(segmentPath, "utf-8")) as {
			events: Array<{ payload: unknown }>;
		};
		tampered.events[0]!.payload = { type: "Generic", kind: "tampered", data: {} };
		fs.writeFileSync(segmentPath, JSON.stringify(tampered, null, 2), "utf-8");

		assert.throws(() => openProjectControlStore(project), assertDurabilityFailure);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("ControlStore startup: a recomputed cross-domain run projection still fails semantic validation", () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-cross-domain-run-"));
	try {
		const store = openProjectControlStore(project);
		const now = Date.now();
		store.commit({
			events: [
				{
					eventId: "ev-cross-domain-run",
					schemaVersion: 1,
					controlDomainId: store.header.controlDomainId,
					streamId: "run-cross-domain",
					streamSeq: 0,
					commitSeq: 0,
					projectId: store.header.projectId,
					recordedAt: now,
					payload: { type: "RunReceived", runId: "run-cross-domain", boundPlanHash: "plan-cross-domain" },
				},
			],
			run: {
				runId: "run-cross-domain",
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
				status: "running",
				stage: "received",
				boundPlanHash: "plan-cross-domain",
				needsOperator: false,
				createdAt: now,
				updatedAt: now,
				runVersion: 1,
			},
		});

		rewriteTailSegment(project, (entry) => {
			(entry.run as { projectId: string }).projectId = "proj-other-domain";
		});

		assert.throws(() => openProjectControlStore(project), assertDurabilityFailure);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("ControlStore startup: recomputed duplicate event identity and stream gap fail semantic validation", () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-event-semantic-"));
	try {
		const store = openProjectControlStore(project);
		appendGenericEvent(store, "ev-semantic-first", "semantic-stream");
		appendGenericEvent(store, "ev-semantic-second", "semantic-stream");

		rewriteTailSegment(project, (entry) => {
			const event = entry.events[0] as { eventId: string; streamSeq: number };
			event.eventId = "ev-semantic-first";
			event.streamSeq = 7;
		});

		assert.throws(() => openProjectControlStore(project), assertDurabilityFailure);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("ControlStore startup: a recomputed receipt with an unbacked manifest fails semantic validation", () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-receipt-semantic-"));
	try {
		const store = openProjectControlStore(project);
		const now = Date.now();
		store.commit({
			events: [
				{
					eventId: "ev-receipt-semantic",
					schemaVersion: 1,
					controlDomainId: store.header.controlDomainId,
					streamId: "run-receipt-semantic",
					streamSeq: 0,
					commitSeq: 0,
					projectId: store.header.projectId,
					recordedAt: now,
					payload: {
						type: "ReceiptIssued",
						runId: "run-receipt-semantic",
						receiptId: "rcpt-receipt-semantic",
					},
				},
			],
			run: {
				runId: "run-receipt-semantic",
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
				status: "completed",
				stage: "terminal",
				boundPlanHash: "plan-receipt-semantic",
				needsOperator: false,
				createdAt: now,
				updatedAt: now,
				runVersion: 1,
				receiptId: "rcpt-receipt-semantic",
			},
			receipt: {
				receiptId: "rcpt-receipt-semantic",
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
				runId: "run-receipt-semantic",
				boundPlanHash: "plan-receipt-semantic",
				eventManifest: ["ev-receipt-semantic"],
				startCommitSeq: 1,
				endCommitSeq: 1,
				artifactRefs: [],
				assurance: {
					journalContinuity: "ok",
					providerOutcome: "ok",
					artifactIntegrity: "unknown",
					provenance: "unknown",
				},
				buildInfo: { packageVersion: "0.3.0", controlSchemaVersion: 1 },
				issuedAt: now,
			},
		});

		rewriteTailSegment(project, (entry) => {
			(entry.receipt as { eventManifest: string[] }).eventManifest = ["ev-not-in-journal"];
		});

		assert.throws(() => openProjectControlStore(project), assertDurabilityFailure);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("ControlStore recovery: command claims rebuild from the journal after derived indexes are lost", () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-command-claim-"));
	const commandId = "cmd-journal-authoritative";
	const commandPath = path.join(projectControlRoot(project), "commands", `${commandId}.json`);
	const byCommandPath = path.join(projectControlRoot(project), "commands", `by-cmd-${commandId}.json`);
	try {
		const initial = openProjectControlStore(project);
		assert.deepEqual(
			initial.claimCommand({
				commandId,
				requestHash: "claim-request-hash",
				callerPrincipal: "operator",
				kind: "admitAndRun",
				runId: "run-command-journal",
			}),
			{ kind: "claimed" },
		);
		assert.ok(fs.existsSync(commandPath));
		fs.unlinkSync(commandPath);
		fs.unlinkSync(byCommandPath);

		const reopened = openProjectControlStore(project);
		const command = reopened.getCommand(commandId);
		assert.ok(command, "journal recovery must restore a claimed command");
		assert.equal(command!.runId, "run-command-journal");
		assert.equal(reopened.getRunIdForCommand(commandId), "run-command-journal");
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("ControlStore recovery: stale derived records without journal authority are removed", () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-ghost-derived-"));
	const controlRoot = projectControlRoot(project);
	try {
		const initial = openProjectControlStore(project);
		appendGenericEvent(initial, "ev-ghost-derived");
		const ghostRun = "run-ghost-derived";
		const ghostCommand = "cmd-ghost-derived";
		const ghostReceipt = "rcpt-ghost-derived";
		fs.writeFileSync(
			path.join(controlRoot, "projections", `run-${ghostRun}.json`),
			JSON.stringify({ runId: ghostRun, status: "completed" }),
			"utf-8",
		);
		fs.writeFileSync(
			path.join(controlRoot, "commands", `${ghostCommand}.json`),
			JSON.stringify({ commandId: ghostCommand, runId: ghostRun }),
			"utf-8",
		);
		fs.writeFileSync(
			path.join(controlRoot, "commands", `by-cmd-${ghostCommand}.json`),
			JSON.stringify({ runId: ghostRun }),
			"utf-8",
		);
		fs.writeFileSync(
			path.join(controlRoot, "receipts", `${ghostReceipt}.json`),
			JSON.stringify({ receiptId: ghostReceipt, runId: ghostRun }),
			"utf-8",
		);
		fs.writeFileSync(
			path.join(controlRoot, "receipts", `by-run-${ghostRun}.json`),
			JSON.stringify({ receiptId: ghostReceipt }),
			"utf-8",
		);

		initial.recoverFromJournal();
		assert.equal(initial.getRun(ghostRun), null);
		assert.equal(initial.getCommand(ghostCommand), null);
		assert.equal(initial.getRunIdForCommand(ghostCommand), null);
		assert.equal(initial.getReceipt(ghostReceipt), null);
		assert.equal(initial.getReceiptForRun(ghostRun), null);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("ControlStore startup: recovery waits for the same commit lock used by mutations", async () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-lock-"));
	const readyPath = path.join(project, "holder-ready");
	let child: ChildProcess | undefined;
	try {
		const helper = path.join(helpersDir, "mp-hold-project-lock.mts");
		child = spawn(
			process.execPath,
			["--conditions=development", "--experimental-strip-types", helper, project, readyPath, "500"],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		const childDone = waitForChild(child);
		await waitForFile(readyPath);

		const startedAt = Date.now();
		openProjectControlStore(project);
		const elapsedMs = Date.now() - startedAt;
		const result = await childDone;
		assert.equal(result.code, 0, result.stderr);
		assert.ok(
			elapsedMs >= 300,
			`startup recovery escaped commit.lock after only ${elapsedMs}ms`,
		);
	} finally {
		if (child && !child.killed) {
			try {
				child.kill("SIGKILL");
			} catch {
				/* best effort cleanup */
			}
		}
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("Coordinator: corrupt state fails closed rather than resetting capacity", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-bad-coordinator-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const statePath = path.join(home, ".taskflow", "control", "coordinator", "state.json");
	try {
		const coordinator = openUserCoordinatorStore(env);
		coordinator.setMaxActiveRuns(9, {
			commandId: "set-capacity",
			callerPrincipal: "operator",
			requestBody: { maxActiveRuns: 9 },
		});
		const corrupt = "{ malformed coordinator";
		fs.writeFileSync(statePath, corrupt, "utf-8");

		assert.throws(() => openUserCoordinatorStore(env).maxActiveRuns, assertDurabilityFailure);
		assert.equal(fs.readFileSync(statePath, "utf-8"), corrupt);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("Coordinator: an unbound committed reservation fails closed before it can release capacity", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-semantic-coordinator-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const statePath = path.join(home, ".taskflow", "control", "coordinator", "state.json");
	try {
		const coordinator = openUserCoordinatorStore(env);
		coordinator.setMaxActiveRuns(1, {
			commandId: "set-capacity-semantic-corruption",
			callerPrincipal: "operator",
			requestBody: { maxActiveRuns: 1 },
		});
		const reservation = coordinator.reserve();
		assert.ok(reservation);
		coordinator.commitReservation(reservation.reservationId, {
			projectId: "project-semantic-corruption",
			projectControlDomainId: "domain-semantic-corruption",
			runId: "run-semantic-corruption",
			projectAdmitCommitSeq: 1,
		});

		const corrupted = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
			reservations: Array<Record<string, unknown>>;
		};
		const committed = corrupted.reservations.find(
			(candidate) => candidate.reservationId === reservation.reservationId,
		);
		assert.ok(committed, "test setup must find the committed capacity reservation");
		delete committed.projectId;
		delete committed.projectControlDomainId;
		delete committed.runId;
		delete committed.projectAdmitCommitSeq;
		const corruptBytes = JSON.stringify(corrupted, null, 2);
		fs.writeFileSync(statePath, corruptBytes, "utf-8");

		assert.throws(
			() =>
				openUserCoordinatorStore(env).normalRelease(reservation.reservationId, {
					noLiveOrAmbiguousSideEffects: true,
					runIsTerminal: true,
					runIsParkedAndFutureDispatchRequiresReadmission: false,
				}),
			assertDurabilityFailure,
		);
		assert.equal(
			fs.readFileSync(statePath, "utf-8"),
			corruptBytes,
			"a rejected semantic corruption must not be rewritten as a released capacity slot",
		);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("Coordinator: lowering capacity below occupied slots is rejected without recording a command", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-capacity-floor-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const statePath = path.join(home, ".taskflow", "control", "coordinator", "state.json");
	try {
		const coordinator = openUserCoordinatorStore(env);
		coordinator.setMaxActiveRuns(2, {
			commandId: "set-capacity-two",
			callerPrincipal: "operator",
			requestBody: { maxActiveRuns: 2 },
		});
		assert.ok(coordinator.reserve());
		assert.ok(coordinator.reserve());
		const before = fs.readFileSync(statePath, "utf-8");

		assert.throws(
			() =>
				coordinator.setMaxActiveRuns(1, {
					commandId: "set-capacity-below-occupied",
					callerPrincipal: "operator",
					requestBody: { maxActiveRuns: 1 },
				}),
			/occupied reservations/i,
		);
		assert.equal(
			fs.readFileSync(statePath, "utf-8"),
			before,
			"a rejected capacity decrease must not mint a CoordinatorCommandRecord",
		);
		assert.equal(openUserCoordinatorStore(env).maxActiveRuns, 2);
		assert.equal(openUserCoordinatorStore(env).occupyingCount(), 2);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("Coordinator: only the unbound-release path may release a reserved TTL lease", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-unbound-release-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	try {
		const coordinator = openUserCoordinatorStore(env);
		const reservation = coordinator.reserve();
		assert.ok(reservation);

		assert.throws(
			() =>
				coordinator.normalRelease(reservation.reservationId, {
					noLiveOrAmbiguousSideEffects: true,
					runIsTerminal: true,
					runIsParkedAndFutureDispatchRequiresReadmission: false,
				}),
			/cannot normalRelease from state reserved/,
		);
		assert.equal(coordinator.getReservation(reservation.reservationId)?.state, "reserved");

		assert.equal(
			coordinator.releaseUnboundReservation(reservation.reservationId).state,
			"released",
		);
		assert.equal(
			openUserCoordinatorStore(env).getReservation(reservation.reservationId)?.state,
			"released",
			"a released unbound lease must reopen as a valid non-TTL record",
		);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("Coordinator: command authority is state-atomic and never emitted as a writable sidecar", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-coordinator-command-batch-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const coordinatorDir = path.join(home, ".taskflow", "control", "coordinator");
	try {
		const coordinator = openUserCoordinatorStore(env);
		const capacityCommand = coordinator.setMaxActiveRuns(1, {
			commandId: "set-capacity-state-atomic",
			callerPrincipal: "operator",
			requestBody: { maxActiveRuns: 1 },
		});
		assert.equal(coordinator.getCommand(capacityCommand.commandId)?.kind, "setMaxActiveRuns");
		assert.deepEqual(
			fs.readdirSync(coordinatorDir).filter((file) => file.startsWith("cmd-")),
			[],
			"a state-write failure must not leave a command sidecar that falsely looks committed",
		);

		const reservation = coordinator.reserve();
		assert.ok(reservation);
		const forced = coordinator.forceRelease(reservation.reservationId, {
			commandId: "force-release-state-atomic",
			callerPrincipal: "operator",
			requestBody: { reservationId: reservation.reservationId, riskAcknowledged: true },
		});
		assert.equal(coordinator.getCommand(forced.command.commandId)?.kind, "forceRelease");
		assert.deepEqual(
			fs.readdirSync(coordinatorDir).filter((file) => file.startsWith("cmd-")),
			[],
			"force release must share the same sole coordinator state commit boundary",
		);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("Coordinator: malformed public mutations fail before they poison durable state", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-coordinator-public-input-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const statePath = path.join(home, ".taskflow", "control", "coordinator", "state.json");
	try {
		const coordinator = openUserCoordinatorStore(env);
		const reservation = coordinator.reserve();
		assert.ok(reservation);
		const before = fs.readFileSync(statePath, "utf-8");

		assert.throws(
			() => coordinator.reserve({ coordinatorEpoch: Number.NaN, ttlMs: 1 } as never),
			/TF_INVALID_ARGUMENT: invalid reserve options/,
		);
			assert.throws(
				() => coordinator.reserve({ ttlMs: 60_001 }),
				/TF_INVALID_ARGUMENT: reservation ttlMs exceeds maximum/,
			);
			assert.throws(
				() => coordinator.reserve({ ttlMs: null as unknown as number }),
				/TF_INVALID_ARGUMENT: invalid reservation ttlMs/,
			);
		assert.throws(
			() =>
				coordinator.setLease({
					holderId: "holder",
					fencingEpoch: Number.NaN,
					endpoint: "unix:///tmp/taskflow.sock",
					expiresAt: Date.now() + 1,
				}),
			/TF_INVALID_ARGUMENT: invalid lease epoch or expiry/,
		);
		assert.throws(
			() =>
				coordinator.commitReservation(reservation.reservationId, {
					projectId: "",
					projectControlDomainId: "domain",
					runId: "run",
					projectAdmitCommitSeq: 1,
				}),
			/TF_INVALID_ARGUMENT: unsafe projectId/,
		);
		assert.throws(
			() =>
				coordinator.setMaxActiveRuns(Number.MAX_SAFE_INTEGER + 1, {
					commandId: "unsafe-capacity",
					callerPrincipal: "operator",
					requestBody: { maxActiveRuns: Number.MAX_SAFE_INTEGER + 1 },
				}),
			/TF_INVALID_ARGUMENT: invalid maxActiveRuns/,
		);
		assert.throws(() => coordinator.reclaimExpiredReserved(Number.NaN), /TF_INVALID_ARGUMENT/);
		assert.equal(
			fs.readFileSync(statePath, "utf-8"),
			before,
			"rejected public values must leave the last reopenable state byte-for-byte intact",
		);
		assert.equal(openUserCoordinatorStore(env).occupyingCount(), 1);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("Coordinator: an elapsed reserved TTL is persisted as expired before commit is rejected", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-coordinator-expired-commit-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const statePath = path.join(home, ".taskflow", "control", "coordinator", "state.json");
	try {
		const coordinator = openUserCoordinatorStore(env);
		const reservation = coordinator.reserve({ ttlMs: 60_000 });
		assert.ok(reservation);
		const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
			reservations: Array<{ reservationId: string; reservedExpiresAt?: number }>;
		};
		const persisted = state.reservations.find(
			(candidate) => candidate.reservationId === reservation.reservationId,
		);
		assert.ok(persisted);
		persisted.reservedExpiresAt = Date.now() - 1;
		fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

		assert.throws(
			() =>
				openUserCoordinatorStore(env).commitReservation(reservation.reservationId, {
					projectId: "project-expired",
					projectControlDomainId: "domain-expired",
					runId: "run-expired",
					projectAdmitCommitSeq: 1,
				}),
			/cannot commit expired reservation/,
		);
		const reopened = openUserCoordinatorStore(env);
		assert.equal(reopened.getReservation(reservation.reservationId)?.state, "expired");
		assert.equal(reopened.occupyingCount(), 0);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("Coordinator: command ids are unique, idempotent, and principal-bound", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-coordinator-command-idempotency-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const statePath = path.join(home, ".taskflow", "control", "coordinator", "state.json");
	try {
		const coordinator = openUserCoordinatorStore(env);
		const first = coordinator.setMaxActiveRuns(2, {
			commandId: "set-capacity-once",
			callerPrincipal: "operator-a",
			requestBody: { maxActiveRuns: 2 },
		});
		const replay = coordinator.setMaxActiveRuns(2, {
			commandId: "set-capacity-once",
			callerPrincipal: "operator-a",
			requestBody: { maxActiveRuns: 2 },
		});
		assert.deepEqual(replay, first);
		const beforeConflict = fs.readFileSync(statePath, "utf-8");
		assert.throws(
			() =>
				coordinator.setMaxActiveRuns(3, {
					commandId: "set-capacity-once",
					callerPrincipal: "operator-a",
					requestBody: { maxActiveRuns: 3 },
				}),
			/TF_IDEMPOTENCY_CONFLICT/,
		);
		assert.equal(fs.readFileSync(statePath, "utf-8"), beforeConflict);

		const reservation = coordinator.reserve();
		assert.ok(reservation);
		coordinator.commitReservation(reservation.reservationId, {
			projectId: "project-command",
			projectControlDomainId: "domain-command",
			runId: "run-command",
			projectAdmitCommitSeq: 1,
		});
		coordinator.forceRelease(reservation.reservationId, {
			commandId: "force-release-once",
			callerPrincipal: "operator-a",
			requestBody: { reservationId: reservation.reservationId, riskAcknowledged: true },
		});
		assert.throws(
			() =>
				coordinator.forceRelease(reservation.reservationId, {
					commandId: "force-release-once",
					callerPrincipal: "operator-b",
					requestBody: { reservationId: reservation.reservationId, riskAcknowledged: true },
				}),
			/TF_CROSS_PRINCIPAL_COMMAND/,
		);
		assert.equal(coordinator.getReservation(reservation.reservationId)?.state, "released");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("Coordinator: a tampered command ledger fails closed before any capacity mutation", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-coordinator-command-corruption-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const statePath = path.join(home, ".taskflow", "control", "coordinator", "state.json");
	try {
		const coordinator = openUserCoordinatorStore(env);
		coordinator.setMaxActiveRuns(1, {
			commandId: "set-capacity-command-corruption",
			callerPrincipal: "operator",
			requestBody: { maxActiveRuns: 1 },
		});
		const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
			commands: Array<Record<string, unknown>>;
			nextCommandSeq: number;
		};
		state.commands.push({
			...state.commands[0],
			firstCommitSeq: 2,
			lastCommitSeq: 2,
		});
		state.nextCommandSeq = 3;
		const corruptBytes = JSON.stringify(state, null, 2);
		fs.writeFileSync(statePath, corruptBytes, "utf-8");

		assert.throws(() => openUserCoordinatorStore(env).reserve(), assertDurabilityFailure);
		assert.equal(fs.readFileSync(statePath, "utf-8"), corruptBytes);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("Coordinator: semantic command, capacity, and lease tampering fail closed", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-coordinator-semantic-corruption-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const statePath = path.join(home, ".taskflow", "control", "coordinator", "state.json");
	try {
		const coordinator = openUserCoordinatorStore(env);
		coordinator.setMaxActiveRuns(1, {
			commandId: "set-capacity-semantic-corruption",
			callerPrincipal: "operator",
			requestBody: { maxActiveRuns: 1 },
		});
		const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
			maxActiveRuns: number;
			lease: unknown;
			commands: Array<Record<string, unknown>>;
		};
		const [setCapacity] = state.commands;
		assert.ok(setCapacity);
		const originalHash = setCapacity.requestHash;

		setCapacity.requestHash = "0".repeat(64);
		let corruptBytes = JSON.stringify(state, null, 2);
		fs.writeFileSync(statePath, corruptBytes, "utf-8");
		assert.throws(() => openUserCoordinatorStore(env).maxActiveRuns, assertDurabilityFailure);
		assert.equal(fs.readFileSync(statePath, "utf-8"), corruptBytes);

		setCapacity.requestHash = originalHash;
		state.maxActiveRuns = 2;
		corruptBytes = JSON.stringify(state, null, 2);
		fs.writeFileSync(statePath, corruptBytes, "utf-8");
		assert.throws(() => openUserCoordinatorStore(env).maxActiveRuns, assertDurabilityFailure);
		assert.equal(fs.readFileSync(statePath, "utf-8"), corruptBytes);

		state.maxActiveRuns = 1;
		state.lease = {
			holderId: "   ",
			fencingEpoch: 1,
			endpoint: "unix:///tmp/taskflow.sock",
			expiresAt: Date.now() + 1_000,
		};
		corruptBytes = JSON.stringify(state, null, 2);
		fs.writeFileSync(statePath, corruptBytes, "utf-8");
		assert.throws(() => openUserCoordinatorStore(env).maxActiveRuns, assertDurabilityFailure);
		assert.equal(fs.readFileSync(statePath, "utf-8"), corruptBytes);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("Coordinator: a v2 ledger without a capacity command retains its default genesis capacity", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-coordinator-genesis-capacity-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const statePath = path.join(home, ".taskflow", "control", "coordinator", "state.json");
	try {
		const coordinator = openUserCoordinatorStore(env);
		assert.ok(coordinator.reserve());
		const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
			maxActiveRuns: number;
			commands: unknown[];
		};
		assert.deepEqual(state.commands, []);
		state.maxActiveRuns = 5;
		const corruptBytes = JSON.stringify(state, null, 2);
		fs.writeFileSync(statePath, corruptBytes, "utf-8");
		assert.throws(() => openUserCoordinatorStore(env).maxActiveRuns, assertDurabilityFailure);
		assert.equal(fs.readFileSync(statePath, "utf-8"), corruptBytes);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("Coordinator: a tampered force-release request hash fails closed", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-coordinator-force-hash-corruption-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const statePath = path.join(home, ".taskflow", "control", "coordinator", "state.json");
	try {
		const coordinator = openUserCoordinatorStore(env);
		const reservation = coordinator.reserve();
		assert.ok(reservation);
		coordinator.commitReservation(reservation.reservationId, {
			projectId: "project-force-hash",
			projectControlDomainId: "domain-force-hash",
			runId: "run-force-hash",
			projectAdmitCommitSeq: 1,
		});
		coordinator.forceRelease(reservation.reservationId, {
			commandId: "force-hash-corruption",
			callerPrincipal: "operator",
			requestBody: { reservationId: reservation.reservationId, riskAcknowledged: true },
		});
		const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
			commands: Array<Record<string, unknown>>;
		};
		const forceRelease = state.commands.find((command) => command.kind === "forceRelease");
		assert.ok(forceRelease);
		forceRelease.requestHash = "f".repeat(64);
		const corruptBytes = JSON.stringify(state, null, 2);
		fs.writeFileSync(statePath, corruptBytes, "utf-8");
		assert.throws(() => openUserCoordinatorStore(env).maxActiveRuns, assertDurabilityFailure);
		assert.equal(fs.readFileSync(statePath, "utf-8"), corruptBytes);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("Coordinator: unsafe command ids are rejected without a path-derived write", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-coordinator-command-path-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const statePath = path.join(home, ".taskflow", "control", "coordinator", "state.json");
	try {
		const coordinator = openUserCoordinatorStore(env);
		coordinator.setMaxActiveRuns(1, {
			commandId: "safe-initial-capacity",
			callerPrincipal: "operator",
			requestBody: { maxActiveRuns: 1 },
		});
		const before = fs.readFileSync(statePath, "utf-8");
		assert.throws(
			() =>
				coordinator.setMaxActiveRuns(1, {
					commandId: "x/../../outside",
					callerPrincipal: "operator",
					requestBody: { maxActiveRuns: 1 },
				}),
			/TF_INVALID_ARGUMENT: unsafe commandId/,
		);
		assert.equal(fs.readFileSync(statePath, "utf-8"), before);
		assert.equal(fs.existsSync(path.join(home, ".taskflow", "control", "outside.json")), false);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test(
	"Coordinator: a symlinked user control root fails closed without creating external capacity state",
	{ skip: process.platform === "win32" },
	() => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-coordinator-symlink-home-"));
		const external = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-coordinator-symlink-target-"));
		const env = { ...process.env, TASKFLOW_HOME: home };
		const sentinelPath = path.join(external, "must-not-change");
		try {
			fs.writeFileSync(sentinelPath, "outside coordinator target", "utf-8");
			fs.symlinkSync(external, path.join(home, ".taskflow"), "dir");

			assert.throws(
				() =>
					openUserCoordinatorStore(env).setMaxActiveRuns(2, {
						commandId: "set-capacity-through-symlink",
						callerPrincipal: "operator",
						requestBody: { maxActiveRuns: 2 },
					}),
				assertDurabilityFailure,
			);
			assert.deepEqual(fs.readdirSync(external).sort(), ["must-not-change"]);
			assert.equal(fs.readFileSync(sentinelPath, "utf-8"), "outside coordinator target");
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(external, { recursive: true, force: true });
		}
	},
);

test("Coordinator: missing initialized state fails closed rather than resetting capacity", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-missing-coordinator-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const statePath = path.join(home, ".taskflow", "control", "coordinator", "state.json");
	try {
		const coordinator = openUserCoordinatorStore(env);
		coordinator.setMaxActiveRuns(1, {
			commandId: "set-capacity-missing",
			callerPrincipal: "operator",
			requestBody: { maxActiveRuns: 1 },
		});
		const reservation = coordinator.reserve();
		assert.ok(reservation, "the initialized coordinator must contain an occupied slot");
		coordinator.commitReservation(reservation!.reservationId, {
			projectId: "project-missing-state",
			projectControlDomainId: "domain-missing-state",
			runId: "run-missing-state",
			projectAdmitCommitSeq: 1,
		});
		fs.unlinkSync(statePath);

		assert.throws(() => openUserCoordinatorStore(env).maxActiveRuns, assertDurabilityFailure);
		assert.equal(
			fs.existsSync(statePath),
			false,
			"reopen must preserve the missing-state evidence instead of recreating capacity",
		);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("Coordinator: missing initialization anchor fails closed rather than silently accepting state", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-missing-coordinator-anchor-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const controlDir = path.join(home, ".taskflow", "control");
	const anchorPath = path.join(controlDir, "coordinator.anchor.json");
	try {
		const coordinator = openUserCoordinatorStore(env);
		coordinator.setMaxActiveRuns(1, {
			commandId: "set-capacity-anchor",
			callerPrincipal: "operator",
			requestBody: { maxActiveRuns: 1 },
		});
		assert.ok(fs.existsSync(anchorPath), "initialization must leave a durable anchor");
		fs.unlinkSync(anchorPath);

		assert.throws(() => openUserCoordinatorStore(env).maxActiveRuns, assertDurabilityFailure);
		assert.equal(
			fs.existsSync(anchorPath),
			false,
			"reopen must preserve the missing-anchor evidence instead of minting a replacement",
		);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("Coordinator: deleted initialized directory fails closed without recreating capacity", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-missing-coordinator-dir-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const controlDir = path.join(home, ".taskflow", "control");
	const coordinatorDir = path.join(controlDir, "coordinator");
	const anchorPath = path.join(controlDir, "coordinator.anchor.json");
	try {
		const coordinator = openUserCoordinatorStore(env);
		coordinator.setMaxActiveRuns(1, {
			commandId: "set-capacity-dir",
			callerPrincipal: "operator",
			requestBody: { maxActiveRuns: 1 },
		});
		assert.ok(fs.existsSync(anchorPath));
		fs.rmSync(coordinatorDir, { recursive: true, force: true });

		assert.throws(() => openUserCoordinatorStore(env).maxActiveRuns, assertDurabilityFailure);
		assert.equal(
			fs.existsSync(coordinatorDir),
			false,
			"a read/open must not recreate a missing initialized coordinator directory",
		);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

/**
 * Deliberate non-GA witness. A static coordinatorId anchor cannot distinguish a
 * legitimate earlier state from a rollback of that state. Keep this replayable
 * until an external non-rollbackable witness + authorized repair protocol flips
 * the expected outcome under a versioned migration.
 */
test("P16 counterexample: state rollback behind an unchanged anchor reopens empty capacity", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-coordinator-state-rollback-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const statePath = path.join(home, ".taskflow", "control", "coordinator", "state.json");
	try {
		const coordinator = openUserCoordinatorStore(env);
		coordinator.setMaxActiveRuns(1, {
			commandId: "set-capacity-rollback",
			callerPrincipal: "operator",
			requestBody: { maxActiveRuns: 1 },
		});
		const preOccupancyState = fs.readFileSync(statePath, "utf-8");
		const first = coordinator.reserve();
		assert.ok(first);
		coordinator.commitReservation(first.reservationId, {
			projectId: "project-rollback",
			projectControlDomainId: "domain-rollback",
			runId: "run-rollback",
			projectAdmitCommitSeq: 1,
		});
		assert.equal(coordinator.occupyingCount(), 1);

		fs.writeFileSync(statePath, preOccupancyState, "utf-8");
		const reopened = openUserCoordinatorStore(env);
		assert.equal(reopened.occupyingCount(), 0);
		assert.ok(
			reopened.reserve(),
			"the unchanged static anchor accepts an old state and re-admits capacity",
		);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

/** Deliberate non-GA witness: both mutable state and static anchor share a root. */
test("P16 counterexample: deleting the coordinator parent control root recreates capacity", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-coordinator-parent-root-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const controlRoot = path.join(home, ".taskflow", "control");
	try {
		const coordinator = openUserCoordinatorStore(env);
		coordinator.setMaxActiveRuns(1, {
			commandId: "set-capacity-parent-root",
			callerPrincipal: "operator",
			requestBody: { maxActiveRuns: 1 },
		});
		const first = coordinator.reserve();
		assert.ok(first);
		coordinator.commitReservation(first.reservationId, {
			projectId: "project-parent-root",
			projectControlDomainId: "domain-parent-root",
			runId: "run-parent-root",
			projectAdmitCommitSeq: 1,
		});
		fs.rmSync(controlRoot, { recursive: true, force: true });

		const reopened = openUserCoordinatorStore(env);
		assert.equal(reopened.occupyingCount(), 0);
		assert.ok(reopened.reserve());
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("P16 coordinator: explicit non-GA fixtures derive epoch zero and reject caller-selected epochs", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-coordinator-epoch-bypass-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	try {
		const coordinator = openUserCoordinatorStore(env);
		coordinator.setLease({
			holderId: "holder-current",
			fencingEpoch: 0,
			endpoint: "unix:///tmp/taskflow-current.sock",
			expiresAt: Date.now() + 60_000,
		});
		assert.throws(
			() => coordinator.reserve({ coordinatorEpoch: 6 } as never),
			/TF_INVALID_ARGUMENT: invalid reserve options/,
		);
		const reservation = coordinator.reserve();
		assert.ok(reservation);
		assert.equal(reservation.coordinatorEpoch, 0);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("Coordinator: a legacy v1 state migrates on mutation to a paired durable anchor", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-coordinator-v1-migrate-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const coordinatorDir = path.join(home, ".taskflow", "control", "coordinator");
	const statePath = path.join(coordinatorDir, "state.json");
	const anchorPath = path.join(home, ".taskflow", "control", "coordinator.anchor.json");
	try {
		fs.mkdirSync(coordinatorDir, { recursive: true });
		fs.writeFileSync(
			statePath,
			JSON.stringify({
				schemaVersion: 1,
				maxActiveRuns: 1,
				lease: null,
				reservations: [],
				commands: [],
				nextCommandSeq: 1,
			}),
			"utf-8",
		);

		const coordinator = openUserCoordinatorStore(env);
		assert.equal(coordinator.maxActiveRuns, 1, "legacy state remains readable before migration");
		assert.ok(coordinator.reserve());

		const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
			schemaVersion: number;
			coordinatorId?: string;
			commands: Array<{ kind: string; payload: { maxActiveRuns?: number } }>;
		};
		const anchor = JSON.parse(fs.readFileSync(anchorPath, "utf-8")) as {
			coordinatorId?: string;
		};
		assert.equal(state.schemaVersion, 2);
		assert.ok(state.coordinatorId);
		assert.equal(state.commands.length, 1);
		assert.equal(state.commands[0]?.kind, "setMaxActiveRuns");
		assert.equal(state.commands[0]?.payload.maxActiveRuns, 1);
		assert.equal(anchor.coordinatorId, state.coordinatorId);
		assert.equal(openUserCoordinatorStore(env).reserve(), null);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
