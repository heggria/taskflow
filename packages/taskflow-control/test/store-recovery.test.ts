/**
 * Journal-authoritative recovery after half-commit (projection deleted).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	createControlHost,
	createScriptExecutionProvider,
	inspectProjectControlStore,
	openProjectControlStore,
	projectApprovalRecoveryIndexPath,
	projectRunIndexPath,
	type RunProjection,
} from "../src/index.ts";

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
		const boundPlanHash = r.run!.boundPlanHash;
		assert.equal(
			host.store.getBoundPlan(boundPlanHash)?.programName,
			"recover-me",
		);
		host.close();

		// Simulate half-commit: journal intact, projection deleted
		const projPath = path.join(project, ".taskflow", "control", "projections", `run-${runId}.json`);
		assert.ok(fs.existsSync(projPath));
		fs.unlinkSync(projPath);
		const byRun = path.join(project, ".taskflow", "control", "receipts", `by-run-${runId}.json`);
		if (fs.existsSync(byRun)) fs.unlinkSync(byRun);
		const receiptPath = path.join(project, ".taskflow", "control", "receipts", `${receiptId}.json`);
		if (fs.existsSync(receiptPath)) fs.unlinkSync(receiptPath);
		const boundPlanPath = path.join(
			project,
			".taskflow",
			"control",
			"bound-plans",
			`${boundPlanHash.replace(":", "-")}.json`,
		);
		assert.ok(fs.existsSync(boundPlanPath));
		fs.unlinkSync(boundPlanPath);

		const store = openProjectControlStore(project);
		const recovered = store.getRun(runId);
		assert.ok(recovered, "run projection must rebuild from journal");
		assert.equal(recovered!.status, "completed");
		assert.equal(recovered!.runId, runId);
		assert.equal(store.getBoundPlan(boundPlanHash)?.programName, "recover-me");

		const cmd = store.getCommand("cmd-recover-1");
		assert.ok(cmd);
		assert.equal(cmd!.runId, runId);

		// Explicit recover after deleting again
		fs.unlinkSync(path.join(project, ".taskflow", "control", "projections", `run-${runId}.json`));
		const stats = store.recoverFromJournal();
		assert.ok(stats.rebuiltRuns >= 1);
		assert.ok(store.getRun(runId));
		assert.ok(store.getBoundPlan(boundPlanHash));

		const projectionPath = path.join(
			project,
			".taskflow",
			"control",
			"projections",
			`run-${runId}.json`,
		);
		const runIndexPath = projectRunIndexPath(project);
		const bogus = {
			...JSON.parse(
				fs.readFileSync(projectionPath, "utf8"),
			),
			status: "failed",
		};
		fs.writeFileSync(
			projectionPath,
			JSON.stringify(bogus),
		);
		const staleIndex = JSON.parse(
			fs.readFileSync(runIndexPath, "utf8"),
		) as {
			runs: RunProjection[];
		};
		fs.writeFileSync(
			runIndexPath,
			JSON.stringify({
				...staleIndex,
				runs: staleIndex.runs.map((run) =>
					run.runId === runId
						? { ...run, status: "failed" }
						: run,
				),
			}),
		);

		const journalReopened =
			openProjectControlStore(project);
		assert.equal(
			journalReopened.getRun(runId)?.status,
			"completed",
			"journal must restore a same-watermark corrupted projection",
		);
		assert.equal(
			journalReopened
				.listRuns()
				.find((run) => run.runId === runId)
				?.status,
			"completed",
			"recovery must refresh a same-watermark project Run index",
		);
		assert.deepEqual(
			journalReopened.recoverFromJournal(),
			{
				rebuiltRuns: 0,
				rebuiltCommands: 0,
				rebuiltReceipts: 0,
				rebuiltBoundPlans: 0,
				rebuiltBoundFragments: 0,
				rebuiltBoundFragmentLinks: 0,
			},
			"an already-current journal recovery must be a write-free no-op",
		);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("approval recovery index is watermark-bound, rebuildable, and commit-maintained", () => {
	const project = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-approval-index-"),
	);
	try {
		const store = openProjectControlStore(project);
		const now = Date.now();
		const candidate: RunProjection = {
			runId: "run-approval-index",
			projectId: store.header.projectId,
			controlDomainId: store.header.controlDomainId,
			status: "running",
			stage: "queued",
			boundPlanHash: `bp:${"a".repeat(64)}`,
			needsOperator: false,
			createdAt: now,
			updatedAt: now,
			runVersion: 1,
			lastCommitSeq: 0,
			nodes: [],
			approvalRequestId: "approval-index",
			reservationId: "reservation-index",
		};
		store.commit({
			run: candidate,
			events: [],
		});
		assert.deepEqual(
			store
				.listApprovalRecoveryRuns()
				.map((run) => run.runId),
			[candidate.runId],
		);
		const committedRunIndex = JSON.parse(
			fs.readFileSync(projectRunIndexPath(project), "utf8"),
		) as {
			throughCommitSeq: number;
			projectionCount: number;
			runs: RunProjection[];
		};
		assert.equal(committedRunIndex.projectionCount, 1);
		assert.equal(
			committedRunIndex.throughCommitSeq,
			store.nextCommitSeq() - 1,
		);
		assert.equal(committedRunIndex.runs[0]?.runId, candidate.runId);

		fs.unlinkSync(projectApprovalRecoveryIndexPath(project));
		fs.unlinkSync(projectRunIndexPath(project));
		const reopened = openProjectControlStore(project);
		assert.deepEqual(
			reopened
				.listApprovalRecoveryRuns()
				.map((run) => run.runId),
			[candidate.runId],
			"missing index must rebuild from durable projections",
		);

		const current = reopened.getRun(candidate.runId)!;
		reopened.commit({
			run: {
				...current,
				status: "completed",
				stage: "terminal",
				updatedAt: now + 1,
				runVersion: 2,
			},
			events: [],
		});
		assert.deepEqual(
			reopened.listApprovalRecoveryRuns(),
			[],
			"settlement commit must remove the recovery candidate",
		);
		const index = JSON.parse(
			fs.readFileSync(
				projectApprovalRecoveryIndexPath(project),
				"utf8",
			),
		) as {
			throughCommitSeq: number;
			runIds: string[];
		};
		assert.equal(
			index.throughCommitSeq,
			reopened.nextCommitSeq() - 1,
		);
		assert.deepEqual(index.runIds, []);
		const settledRunIndex = JSON.parse(
			fs.readFileSync(projectRunIndexPath(project), "utf8"),
		) as {
			throughCommitSeq: number;
			projectionCount: number;
			runs: RunProjection[];
		};
		assert.equal(settledRunIndex.projectionCount, 1);
		assert.equal(
			settledRunIndex.throughCommitSeq,
			reopened.nextCommitSeq() - 1,
		);
		assert.equal(settledRunIndex.runs[0]?.status, "completed");

		fs.writeFileSync(
			projectRunIndexPath(project),
			JSON.stringify({
				...settledRunIndex,
				throughCommitSeq:
					settledRunIndex.throughCommitSeq - 1,
			}),
		);
		const inspected = inspectProjectControlStore(project);
		assert.equal(inspected.ok, false);
		if (!inspected.ok) {
			assert.equal(inspected.reason, "projection-invalid");
		}
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("journal recovery derives lastCommitSeq for pre-index Run records", () => {
	const project = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-run-index-migration-"),
	);
	try {
		const store = openProjectControlStore(project);
		const now = Date.now();
		const run: RunProjection = {
			runId: "run-index-migration",
			projectId: store.header.projectId,
			controlDomainId: store.header.controlDomainId,
			status: "completed",
			stage: "terminal",
			boundPlanHash: `bp:${"b".repeat(64)}`,
			needsOperator: false,
			createdAt: now,
			updatedAt: now,
			runVersion: 1,
			lastCommitSeq: 0,
			nodes: [],
		};
		const committed = store.commit({
			run,
			events: [],
		});
		const journalPath = path.join(
			project,
			".taskflow",
			"control",
			"journal",
			`${String(committed.commitSeqStart).padStart(12, "0")}-${String(
				committed.commitSeqEnd,
			).padStart(12, "0")}.json`,
		);
		const journal = JSON.parse(
			fs.readFileSync(journalPath, "utf8"),
		) as {
			run: RunProjection;
		};
		delete journal.run.lastCommitSeq;
		fs.writeFileSync(
			journalPath,
			JSON.stringify(journal, null, 2),
		);

		const projectionPath = path.join(
			project,
			".taskflow",
			"control",
			"projections",
			`run-${run.runId}.json`,
		);
		const projection = JSON.parse(
			fs.readFileSync(projectionPath, "utf8"),
		) as RunProjection;
		delete projection.lastCommitSeq;
		fs.writeFileSync(
			projectionPath,
			JSON.stringify(projection, null, 2),
		);
		fs.rmSync(projectRunIndexPath(project), {
			force: true,
		});

		const reopened = openProjectControlStore(project);
		assert.equal(
			reopened.getRun(run.runId)?.lastCommitSeq,
			committed.commitSeqEnd,
		);
		assert.equal(
			reopened.listRuns()[0]?.lastCommitSeq,
			committed.commitSeqEnd,
		);
		assert.deepEqual(
			reopened.recoverFromJournal(),
			{
				rebuiltRuns: 0,
				rebuiltCommands: 0,
				rebuiltReceipts: 0,
				rebuiltBoundPlans: 0,
				rebuiltBoundFragments: 0,
				rebuiltBoundFragmentLinks: 0,
			},
			"the migrated projection must be stable after its first recovery",
		);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
});
