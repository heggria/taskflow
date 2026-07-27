/**
 * Multi-process helper for B06 D2:
 * Admit a hanging run, park it with a durable release intent written to the
 * host outbox, then exit BEFORE Coordinator.normalRelease — simulating a crash
 * between CAS/outbox and capacity release.
 *
 * stdout: { runId, reservationId, releaseIntentId }
 */
import {
	createControlHost,
	createMockExecutionProvider,
} from "../../src/index.ts";

const projectRoot = process.argv[2];
if (!projectRoot) {
	console.error("usage: mp-b06-crash-after-park-intent.mts <projectRoot>");
	process.exit(2);
}

const provider = createMockExecutionProvider({ outcome: "hang" });
const host = createControlHost({
	projectRoot,
	env: process.env,
	controlMode: "standalone",
	skipSingleton: true,
	provider,
	reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
	phaseDeadlineMs: 80,
});

const admitted = await host.admitAndRun({
	program: {
		name: "mp-b06-crash-park",
		phases: [{ id: "main", type: "script", run: "true", final: true }],
	},
	commandId: "mp-b06-crash-park",
});
if (!admitted.run?.reservationId) {
	console.error(JSON.stringify(admitted.error ?? { message: "no reservation" }));
	host.close();
	process.exit(1);
}
provider.quiesceAll?.();

const crashed = await host.parkForApprovalCrashBeforeRelease(admitted.run.runId, {
	expectedRunVersion: admitted.run.runVersion,
});

// Simulate crash: hard-exit without close() draining the outbox.
process.stdout.write(
	JSON.stringify({
		runId: crashed.runId,
		reservationId: crashed.reservationId,
		releaseIntentId: crashed.releaseIntentId,
	}) + "\n",
);
process.exit(0);
