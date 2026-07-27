/**
 * B06 D3: pending dispatch settlement with proof.
 *
 * An ambiguous / acknowledged activeAttempt whose handle is provably dead must
 * be clearable; without that evidence the dispatch stays and capacity stays
 * fail-closed (orphan-suspect / non-quiescent path).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	createControlHost,
	type ExecutionProvider,
	type ProviderJobHandle,
} from "../src/index.ts";

function temp(): { env: NodeJS.ProcessEnv; project: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-d3-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-d3-project-"));
	return {
		env: { ...process.env, TASKFLOW_HOME: home },
		project,
		cleanup: () => {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(project, { recursive: true, force: true });
		},
	};
}

function deadAfterCancelProvider(): {
	provider: ExecutionProvider;
	kill: (handle: string) => void;
} {
	const jobs = new Map<
		string,
		{ runId: string; cwd: string; startedAt: number; live: boolean }
	>();
	let n = 0;
	const provider: ExecutionProvider = {
		name: "dead-after-cancel",
		async submit(req) {
			const handle = `dead-${++n}`;
			jobs.set(handle, {
				runId: req.runId,
				cwd: req.cwd,
				startedAt: Date.now(),
				live: true,
			});
			return { kind: "accepted", handle };
		},
		async poll() {
			return { kind: "still-running" };
		},
		async cancel(handle) {
			const job = jobs.get(handle);
			if (!job) return { kind: "already-terminal" };
			// Provider reports cancelled but side effect may still be live until kill().
			return { kind: "cancelled" };
		},
		async reconcile() {
			return { kind: "ambiguous", reason: "no containment proof" };
		},
		isLive(handle) {
			return jobs.get(handle)?.live === true;
		},
		loadHandle(handle): ProviderJobHandle | null {
			const job = jobs.get(handle);
			if (!job) return null;
			return {
				handle,
				runId: job.runId,
				providerName: "dead-after-cancel",
				leaseEpoch: job.startedAt,
				cwd: job.cwd,
				startedAt: job.startedAt,
				status: job.live ? "running" : "cancelled",
			};
		},
	};
	return {
		provider,
		kill(handle: string) {
			const job = jobs.get(handle);
			if (job) job.live = false;
		},
	};
}

test("D3: cancel clears activeAttempt only when handle is provably dead (settlement with proof)", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		const fixture = deadAfterCancelProvider();
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider: fixture.provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
			phaseDeadlineMs: 80,
		});
		const admitted = await host.admitAndRun({
			program: {
				name: "d3-settle-with-proof",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		assert.equal(admitted.ok, false);
		const run = host.store.getRun(admitted.run!.runId)!;
		assert.ok(run.providerHandle);
		assert.equal(host.store.getContinuation(run.runId)?.activeAttempt?.state, "acknowledged");

		// Cancel while still live: dispatch must remain (fail-closed, no false settle).
		const commandId = "d3-cancel-settle";
		const stillLive = await host.cancel(run.runId, {
			commandId,
			expectedRunVersion: run.runVersion,
		});
		assert.equal(stillLive.ok, false);
		const afterLive = host.store.getContinuation(run.runId)?.activeAttempt;
		assert.ok(afterLive, "live handle must not settle pending dispatch");
		assert.equal(afterLive?.providerHandle, run.providerHandle);

		// Prove the handle dead, then the same cancel command retry must settle.
		// No soft-path via reconcilePendingDispatch: cancel settlement regression
		// must fail this test hard.
		fixture.kill(run.providerHandle!);
		const current = host.store.getRun(run.runId)!;
		const afterDead = await host.cancel(current.runId, {
			commandId,
			expectedRunVersion: current.runVersion,
		});
		assert.equal(afterDead.ok, false);
		const settled = host.store.getContinuation(run.runId)?.activeAttempt;
		assert.equal(
			settled,
			undefined,
			"cancel retry with death proof must settle activeAttempt (no reconcile soft-path)",
		);
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("D3: absent settlement evidence keeps activeAttempt (fail-closed)", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		const fixture = deadAfterCancelProvider();
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider: fixture.provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
			phaseDeadlineMs: 80,
		});
		const admitted = await host.admitAndRun({
			program: {
				name: "d3-no-evidence",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		const run = host.store.getRun(admitted.run!.runId)!;
		const cancelled = await host.cancel(run.runId, {
			commandId: "d3-no-evidence-cancel",
			expectedRunVersion: run.runVersion,
		});
		assert.equal(cancelled.ok, false);
		assert.ok(
			host.store.getContinuation(run.runId)?.activeAttempt,
			"without death proof the pending dispatch must remain",
		);
		assert.ok(run.reservationId);
		assert.notEqual(host.coordinator.getReservation(run.reservationId!)?.state, "released");
	} finally {
		host?.close();
		t.cleanup();
	}
});
