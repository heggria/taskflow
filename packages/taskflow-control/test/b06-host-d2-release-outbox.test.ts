/**
 * B06 D2: durable reservation-release outbox.
 *
 * Capacity must never be detached from the Run without a durable release intent,
 * and a crash or Coordinator release error must leave a reconcile-required signal
 * plus an open-time path that recovers capacity — never force-release as the only exit.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
	createControlHost,
	createMockExecutionProvider,
	type ControlHost,
} from "../src/index.ts";

function temp(): { env: NodeJS.ProcessEnv; project: string; home: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-d2-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-d2-project-"));
	return {
		env: { ...process.env, TASKFLOW_HOME: home },
		home,
		project,
		cleanup: () => {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(project, { recursive: true, force: true });
		},
	};
}

function outboxDir(project: string): string {
	return path.join(project, ".taskflow", "control", "release-outbox");
}

function listPendingOutbox(project: string): string[] {
	const dir = outboxDir(project);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((n) => n.endsWith(".json"))
		.sort();
}

test("D2: park journals a durable release intent before Coordinator release", async () => {
	const t = temp();
	let host: ControlHost | undefined;
	try {
		const provider = createMockExecutionProvider({ outcome: "hang" });
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
			// Hang fixtures need a short phase budget independent of reconcile (B06 D1).
			phaseDeadlineMs: 80,
		});
		const admitted = await host.admitAndRun({
			program: {
				name: "d2-park-intent",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
			commandId: "d2-park-intent",
		});
		assert.ok(admitted.run, JSON.stringify(admitted.error));
		const reservationId = admitted.run!.reservationId;
		assert.ok(reservationId);
		provider.quiesceAll?.();

		const parked = await host.parkForApproval(admitted.run!.runId, {
			expectedRunVersion: admitted.run!.runVersion,
		});
		assert.equal(parked.ok, true, JSON.stringify(parked.error));
		assert.equal(host.coordinator.getReservation(reservationId)?.state, "released");

		// Durable outbox must have recorded the intent (released after success).
		// Outbox is file-backed (not a Run CAS) so runVersion stays stable for
		// approval/cancel optimistic concurrency.
		const intents = listPendingOutbox(t.project);
		assert.ok(intents.length >= 1, "park must write a durable release-outbox intent file");
		for (const name of intents) {
			const body = JSON.parse(
				fs.readFileSync(path.join(outboxDir(t.project), name), "utf8"),
			) as { status?: string; reason?: string; reservationId?: string };
			assert.equal(body.status, "released");
			assert.equal(body.reason, "parked");
			assert.equal(body.reservationId, reservationId);
		}
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("D2: Coordinator release failure surfaces reconcile-required and retains capacity ownership", async () => {
	const t = temp();
	let host: ControlHost | undefined;
	try {
		const provider = createMockExecutionProvider({ outcome: "hang" });
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
			phaseDeadlineMs: 80,
		});
		const admitted = await host.admitAndRun({
			program: {
				name: "d2-release-fail",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
			commandId: "d2-release-fail",
		});
		assert.ok(admitted.run, JSON.stringify(admitted.error));
		const reservationId = admitted.run!.reservationId!;
		provider.quiesceAll?.();

		const original = host.coordinator.normalRelease.bind(host.coordinator);
		let blocked = true;
		(host.coordinator as { normalRelease: typeof host.coordinator.normalRelease }).normalRelease = (
			id,
			ctx,
		) => {
			if (blocked && id === reservationId) {
				throw new Error("simulated Coordinator release failure");
			}
			return original(id, ctx);
		};

		const parked = await host.parkForApproval(admitted.run!.runId, {
			expectedRunVersion: admitted.run!.runVersion,
		});

		// Must not claim quiet success while capacity is still held without an outbox trail.
		assert.equal(parked.ok, false, "release failure must not return success");
		assert.equal(parked.error?.code, "TF_RECONCILE_REQUIRED");
		assert.notEqual(host.coordinator.getReservation(reservationId)?.state, "released");
		assert.ok(
			listPendingOutbox(t.project).length >= 1 ||
				(parked.run?.needsOperator === true),
			"must leave a durable release intent or needs-operator for reopen reconcile",
		);

		blocked = false;
		// Open-time / explicit reconcile path recovers capacity.
		const report =
			typeof (host as ControlHost & { reconcileReservationReleases?: () => unknown })
				.reconcileReservationReleases === "function"
				? (
						host as ControlHost & {
							reconcileReservationReleases: () => {
								releasedIntentIds: string[];
								pending: unknown[];
							};
						}
					).reconcileReservationReleases()
				: null;
		assert.ok(report, "host must expose reconcileReservationReleases for the outbox");
		assert.ok(report!.releasedIntentIds.length >= 1, JSON.stringify(report));
		assert.equal(host.coordinator.getReservation(reservationId)?.state, "released");
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("D2: crash between CAS and release recovers capacity on reopen (multi-process helper)", async () => {
	const t = temp();
	const helper = path.join(
		path.dirname(new URL(import.meta.url).pathname),
		"helpers",
		"mp-b06-crash-after-park-intent.mts",
	);
	try {
		// Child: admit + park CAS with release intent, exit before Coordinator release.
		const child = spawnSync(
			process.execPath,
			["--conditions=development", "--experimental-strip-types", helper, t.project],
			{
				env: { ...t.env, TASKFLOW_HOME: t.home },
				encoding: "utf8",
				timeout: 30_000,
			},
		);
		assert.equal(child.status, 0, `helper failed: ${child.stderr}\n${child.stdout}`);
		const payload = JSON.parse(child.stdout.trim()) as {
			runId: string;
			reservationId: string;
			releaseIntentId: string;
		};
		assert.ok(payload.reservationId);
		assert.ok(payload.releaseIntentId);

		// Capacity still occupied after crash window.
		const reopened = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			allowMockProvider: true,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
			phaseDeadlineMs: 80,
		});
		try {
			// Open-time reconcile must drain the durable outbox.
			assert.equal(
				reopened.coordinator.getReservation(payload.reservationId)?.state,
				"released",
				"reopen must recover capacity from durable release intent",
			);
			const snap = reopened.getSnapshot(payload.runId);
			assert.ok(snap);
			assert.equal(snap.run.stage, "parked");
		} finally {
			reopened.close();
		}
	} finally {
		t.cleanup();
	}
});

test("D2 MAJOR: wipe of park release intent after CAS still recovers capacity on reopen", async () => {
	const t = temp();
	try {
		const provider = createMockExecutionProvider({ outcome: "hang" });
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
			phaseDeadlineMs: 80,
		});
		const admitted = await host.admitAndRun({
			program: {
				name: "d2-wipe-intent",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
			commandId: "d2-wipe-intent",
		});
		const reservationId = admitted.run!.reservationId!;
		provider.quiesceAll?.();
		const crashed = await host.parkForApprovalCrashBeforeRelease(admitted.run!.runId, {
			expectedRunVersion: admitted.run!.runVersion,
		});
		assert.equal(host.store.getRun(crashed.runId)?.stage, "parked");
		assert.equal(host.store.getRun(crashed.runId)?.reservationId, undefined);
		// Capacity still held (crash before Coordinator release).
		assert.notEqual(host.coordinator.getReservation(reservationId)?.state, "released");

		// Wipe the durable outbox after the CAS-style park (counterexample).
		const dir = outboxDir(t.project);
		if (fs.existsSync(dir)) {
			for (const name of fs.readdirSync(dir)) {
				fs.unlinkSync(path.join(dir, name));
			}
		}
		assert.equal(listPendingOutbox(t.project).length, 0);
		host.close();

		// Reopen must reconstruct the parked release and free capacity.
		const reopened = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			allowMockProvider: true,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
			phaseDeadlineMs: 80,
		});
		try {
			assert.equal(
				reopened.coordinator.getReservation(reservationId)?.state,
				"released",
				"reopen must recover capacity even when the outbox intent was wiped after park CAS",
			);
			assert.equal(reopened.getSnapshot(crashed.runId)?.run.stage, "parked");
		} finally {
			reopened.close();
		}
	} finally {
		t.cleanup();
	}
});

test("D2 evidence: generic cancel does not journal terminal cancelled on this base (not-reproducing claim)", async () => {
	/**
	 * On base fb80f5e0 cancel is deliberately non-terminal (C7 containment).
	 * The reference-lane D2 premise "cancel journals terminal cancelled without
	 * ReservationReleaseIntent" therefore does not reproduce here. This test
	 * locks that evidence so we do not re-introduce terminal cancel without proof.
	 */
	const t = temp();
	let host: ControlHost | undefined;
	try {
		const provider = createMockExecutionProvider({ outcome: "hang" });
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
			phaseDeadlineMs: 80,
		});
		const admitted = await host.admitAndRun({
			program: {
				name: "d2-cancel-not-terminal",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		const before = host.getSnapshot(admitted.run!.runId)!.run;
		const cancelled = await host.cancel(before.runId, {
			commandId: "d2-cancel-not-terminal",
			expectedRunVersion: before.runVersion,
		});
		assert.equal(cancelled.ok, false);
		assert.notEqual(cancelled.run?.status, "cancelled");
		assert.notEqual(cancelled.run?.stage, "terminal");
		assert.ok(cancelled.run?.reservationId, "non-terminal cancel retains capacity on this base");
	} finally {
		host?.close();
		t.cleanup();
	}
});
