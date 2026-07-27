/**
 * B06 D1: per-phase execution budget must not reuse the 5s reconcile deadline.
 * A legitimate provider phase that runs longer than reconcile budget must still
 * be allowed to complete under the phase budget (finite safe default / phase policy).
 *
 * Determinism: providers complete after N polls (not wall-clock holds), so the
 * suite does not depend on host load to win a timing race.
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
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-d1-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-d1-project-"));
	return {
		env: { ...process.env, TASKFLOW_HOME: home },
		project,
		cleanup: () => {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(project, { recursive: true, force: true });
		},
	};
}

/**
 * Slow-but-finite provider keyed by observation count, not wall clock.
 * First `holdPolls` observations stay still-running; then complete.
 * Independent of reconcile deadlineMs (which only bounds reconcile loops).
 */
function slowThenCompleteProvider(holdPolls: number): ExecutionProvider {
	const jobs = new Map<string, { runId: string; cwd: string; startedAt: number; polls: number }>();
	let n = 0;
	return {
		name: "slow-then-complete",
		async submit(req) {
			const handle = `slow-${++n}`;
			jobs.set(handle, { runId: req.runId, cwd: req.cwd, startedAt: Date.now(), polls: 0 });
			return { kind: "accepted", handle };
		},
		async poll(handle) {
			const job = jobs.get(handle);
			if (!job) return { kind: "failed", error: "unknown" };
			job.polls += 1;
			if (job.polls <= holdPolls) return { kind: "still-running" };
			return { kind: "completed", output: "slow-ok" };
		},
		async cancel() {
			return { kind: "cancelled" };
		},
		async reconcile(handle) {
			const c = await this.poll(handle);
			if (c.kind === "still-running") return { kind: "running" };
			if (c.kind === "completed") return { kind: "completed", output: c.output };
			return { kind: "failed", error: "failed" };
		},
		isLive(handle) {
			const job = jobs.get(handle);
			if (!job) return false;
			return job.polls <= holdPolls;
		},
		loadHandle(handle): ProviderJobHandle | null {
			const job = jobs.get(handle);
			if (!job) return null;
			const live = job.polls <= holdPolls;
			return {
				handle,
				runId: job.runId,
				providerName: "slow-then-complete",
				leaseEpoch: job.startedAt,
				cwd: job.cwd,
				startedAt: job.startedAt,
				status: live ? "running" : "completed",
				stdout: live ? undefined : "slow-ok",
			};
		},
	};
}

test("D1: phase budget must not reuse reconcile 5ms deadline for a slow-but-finite provider", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		// Reconcile budget is intentionally tiny (5ms). Provider stays still-running
		// for several polls; phase budget (60s) must still allow completion.
		const provider = slowThenCompleteProvider(8);
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider,
			// Reconcile is tiny; phase budget must stay independent (explicit 60s).
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
			phaseDeadlineMs: 60_000,
		});

		const result = await host.admitAndRun({
			program: {
				name: "d1-slow-phase",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
			commandId: "d1-slow-phase-cmd",
		});

		// Expected after fix: completes under independent phase budget with Receipt.
		assert.equal(result.ok, true, JSON.stringify(result.error));
		assert.equal(result.run?.status, "completed");
		assert.equal(result.run?.finalOutput, "slow-ok");
		assert.ok(result.receipt, "legitimate slow phase must receive a Receipt");
		assert.equal(host.store.getReceiptForRun(result.run!.runId)?.receiptId, result.receipt!.receiptId);
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("D1: phase.timeout policy overrides default when finite and safe", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		const provider = slowThenCompleteProvider(4);
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider,
			// Even if reconcile is short, phase.timeout: 5_000 must allow completion.
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
			// Host default would be test-short under skipSingleton; phase.timeout wins.
			phaseDeadlineMs: 50,
		});

		const result = await host.admitAndRun({
			program: {
				name: "d1-phase-timeout",
				phases: [{ id: "main", type: "script", run: "true", timeout: 5_000, final: true }],
			},
			commandId: "d1-phase-timeout-cmd",
		});

		assert.equal(result.ok, true, JSON.stringify(result.error));
		assert.equal(result.run?.status, "completed");
		assert.ok(result.receipt);
	} finally {
		host?.close();
		t.cleanup();
	}
});
