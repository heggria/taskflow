/**
 * B06 D5: D37 normalRelease ownership must bind independent project + provider
 * evidence — not echo getReservation fields and hardcode quiescence booleans.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	createControlHost,
	createMockExecutionProvider,
	createScriptExecutionProvider,
	type ControlHost,
} from "../src/index.ts";

function temp(): { env: NodeJS.ProcessEnv; project: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-d5-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-d5-project-"));
	return {
		env: { ...process.env, TASKFLOW_HOME: home },
		project,
		cleanup: () => {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(project, { recursive: true, force: true });
		},
	};
}

test("D5: forged reservation binding is refused by host-side D37 release path", async () => {
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
				name: "d5-forged",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
			commandId: "d5-forged",
		});
		assert.ok(admitted.run, JSON.stringify(admitted.error));
		const realReservationId = admitted.run!.reservationId!;
		provider.quiesceAll?.();

		// Create a foreign committed reservation that does not bind this run.
		const foreign = host.coordinator.reserve();
		assert.ok(foreign);
		host.coordinator.commitReservation(foreign.reservationId, {
			projectId: host.projectId,
			projectControlDomainId: host.controlDomainId,
			runId: "run-foreign-forged",
			projectAdmitCommitSeq: 99,
		});

		// Host must refuse to release a reservation whose independent binding
		// does not match the Run being parked/terminalized.
		const hostWithProbe = host as ControlHost & {
			releaseReservationWithProof?: (
				reservationId: string,
				opts: {
					runId: string;
					runIsTerminal?: boolean;
					runIsParkedAndFutureDispatchRequiresReadmission?: boolean;
				},
			) => { ok: true } | { ok: false; error: { code: string; message: string } };
		};
		assert.equal(
			typeof hostWithProbe.releaseReservationWithProof,
			"function",
			"host must expose an evidence-bound D37 release helper (or equivalent)",
		);

		const refused = hostWithProbe.releaseReservationWithProof!(foreign.reservationId, {
			runId: admitted.run!.runId,
			runIsParkedAndFutureDispatchRequiresReadmission: true,
		});
		assert.equal(refused.ok, false);
		assert.match(refused.ok === false ? refused.error.message : "", /binding|ownership|foreign|match/i);
		assert.equal(host.coordinator.getReservation(foreign.reservationId)?.state, "committed");

		// Legitimate binding releases only after the Run is actually parked.
		// Caller parked-readmit flag alone must not free capacity on reconciling.
		const parked = await host.parkForApproval(admitted.run!.runId, {
			expectedRunVersion: host.store.getRun(admitted.run!.runId)!.runVersion,
		});
		assert.equal(parked.ok, true, JSON.stringify(parked.error));
		assert.equal(host.store.getRun(admitted.run!.runId)?.stage, "parked");
		assert.equal(host.coordinator.getReservation(realReservationId)?.state, "released");
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("D5 MAJOR: effectiveParked requires stage===parked — reconciling cannot free capacity", async () => {
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
				name: "d5-reconciling-no-release",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		const run = admitted.run!;
		assert.ok(run.reservationId);
		provider.quiesceAll?.();
		// Hang fixtures land reconciling / non-parked — not stage===parked.
		const stage = host.store.getRun(run.runId)!.stage;
		assert.notEqual(stage, "parked", `fixture stage must not be parked (got ${stage})`);

		const hostWithProbe = host as ControlHost & {
			releaseReservationWithProof: (
				reservationId: string,
				opts: {
					runId: string;
					runIsTerminal?: boolean;
					runIsParkedAndFutureDispatchRequiresReadmission?: boolean;
				},
			) => { ok: true } | { ok: false; error: { code: string; message: string } };
		};
		const refused = hostWithProbe.releaseReservationWithProof(run.reservationId!, {
			runId: run.runId,
			runIsParkedAndFutureDispatchRequiresReadmission: true,
		});
		assert.equal(
			refused.ok,
			false,
			"caller parked-readmit + quiescence must not free capacity when stage!==parked",
		);
		assert.notEqual(host.coordinator.getReservation(run.reservationId!)?.state, "released");
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("D5: hardcoded noLive=true is refused when provider still reports live side effects", async () => {
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
				name: "d5-live",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		const run = admitted.run!;
		assert.ok(run.reservationId);
		// Provider is still live (hang). Host must not release via tautological booleans.
		const hostWithProbe = host as ControlHost & {
			releaseReservationWithProof?: (
				reservationId: string,
				opts: {
					runId: string;
					runIsTerminal?: boolean;
					runIsParkedAndFutureDispatchRequiresReadmission?: boolean;
				},
			) => { ok: true } | { ok: false; error: { code: string; message: string } };
		};
		const refused = hostWithProbe.releaseReservationWithProof!(run.reservationId!, {
			runId: run.runId,
			runIsTerminal: true,
		});
		assert.equal(refused.ok, false, "live provider must block D37 normalRelease");
		assert.notEqual(host.coordinator.getReservation(run.reservationId!)?.state, "released");
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("D5 MAJOR: crash-recovery release path derives noLive from evidence (not a bare true)", async () => {
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
				name: "d5-crash-derive",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		const reservationId = admitted.run!.reservationId!;
		provider.quiesceAll?.();
		const crashed = await host.parkForApprovalCrashBeforeRelease(admitted.run!.runId, {
			expectedRunVersion: admitted.run!.runVersion,
		});
		assert.equal(host.store.getRun(crashed.runId)?.stage, "parked");
		// Force the coordinator path by leaving intent pending; reconcile must free
		// only because stage is parked and side effects are proven quiescent.
		const report = host.reconcileReservationReleases();
		assert.ok(report.releasedIntentIds.length >= 1, JSON.stringify(report));
		assert.equal(host.coordinator.getReservation(reservationId)?.state, "released");
	} finally {
		host?.close();
		t.cleanup();
	}
});

/**
 * MAJOR: an unmounted / absent provider is absence of evidence, not proof that
 * no side effect is live. Crash-recovery parked release must fail closed
 * (reconcile-required / pending), never soft-hardcode free capacity.
 */
test("D5 MAJOR: crash-recovery release fails closed when the durable provider is not mounted", async () => {
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
				name: "d5-absent-provider",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
			commandId: "d5-absent-provider",
		});
		const reservationId = admitted.run!.reservationId!;
		const runId = admitted.run!.runId;
		assert.equal(host.store.getRun(runId)?.providerName, "mock");
		assert.ok(host.store.getRun(runId)?.providerHandle);
		provider.quiesceAll?.();
		const crashed = await host.parkForApprovalCrashBeforeRelease(runId, {
			expectedRunVersion: host.store.getRun(runId)!.runVersion,
		});
		assert.equal(host.store.getRun(crashed.runId)?.stage, "parked");
		assert.notEqual(
			host.coordinator.getReservation(reservationId)?.state,
			"released",
			"fixture requires capacity still held after crash-before-release",
		);
		host.close();

		// Reopen without mounting "mock" — only a script provider is present.
		// Absence of the durable provider is not evidence of quiescence.
		const reopened = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider: createScriptExecutionProvider({
				stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs-reopen"),
			}),
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
			phaseDeadlineMs: 80,
		});
		try {
			const stateAfterOpen = reopened.coordinator.getReservation(reservationId)?.state;
			assert.notEqual(
				stateAfterOpen,
				"released",
				"absent provider must not soft-hardcode free capacity on open-time crash-recovery release",
			);
			const report = reopened.reconcileReservationReleases();
			assert.notEqual(
				reopened.coordinator.getReservation(reservationId)?.state,
				"released",
				"must remain unreleased after explicit reconcile without the durable provider",
			);
			// Must not claim a successful free; pending / reconcile-required path.
			assert.equal(report.releasedIntentIds.length, 0, JSON.stringify(report));
			assert.ok(report.pending.length >= 1, `expected pending reconcile, got ${JSON.stringify(report)}`);
			assert.ok(
				report.pending.some((p) =>
					/provider|mount|quiescen|evidence|ambiguous|reconcile|live/i.test(p.reason),
				),
				`pending reason must surface missing evidence: ${JSON.stringify(report)}`,
			);
		} finally {
			reopened.close();
		}
	} finally {
		t.cleanup();
	}
});
