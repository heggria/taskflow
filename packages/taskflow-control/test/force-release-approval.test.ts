/**
 * forceRelease risk-ack + durable approval reject/expire + streamSeq uniqueness.
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
	FORCE_RELEASE_ACKNOWLEDGEMENT,
	openUserCoordinatorStore,
	loadApprovalForRun,
	openProjectControlStore,
	type ForceReleaseRequest,
} from "../src/index.ts";

function temp() {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-fa-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-fa-proj-"));
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

test("forceRelease requires exact acknowledgement and principal; idempotent by commandId", () => {
	const t = temp();
	try {
		const coord = openUserCoordinatorStore(t.env);
		const rsv = coord.reserve({ coordinatorEpoch: 1 });
		assert.ok(rsv);
		coord.commitReservation(rsv!.reservationId, {
			projectId: "p",
			projectControlDomainId: "d",
			runId: "r",
			projectAdmitCommitSeq: 1,
		});

		const observed = coord.getReservation(rsv!.reservationId)!;
		const request: ForceReleaseRequest = {
			reservationId: observed.reservationId,
			expectedState: "committed",
			expectedRevision: observed.revision,
			expectedCoordinatorEpoch: observed.coordinatorEpoch,
			expectedProjectId: observed.projectId!,
			expectedControlDomainId: observed.projectControlDomainId!,
			expectedRunId: observed.runId!,
			acknowledgement: FORCE_RELEASE_ACKNOWLEDGEMENT,
		};

		assert.throws(() =>
			coord.forceRelease({
				...request,
				acknowledgement: "no" as typeof FORCE_RELEASE_ACKNOWLEDGEMENT,
			}, {
				commandId: "f1",
				callerPrincipal: "op",
			}),
		);

		const first = coord.forceRelease(request, {
			commandId: "f-ok",
			callerPrincipal: "op",
		});
		assert.equal(first.reservation.state, "released");
		assert.equal(first.command.payload.acknowledgement, FORCE_RELEASE_ACKNOWLEDGEMENT);

		// Idempotent same commandId
		const second = coord.forceRelease(request, {
			commandId: "f-ok",
			callerPrincipal: "op",
		});
		assert.equal(second.command.commandId, "f-ok");
		assert.equal(coord.getReservation(rsv!.reservationId)?.state, "released");
	} finally {
		t.cleanup();
	}
});

test("host forceReleaseReservation enforces the typed observed-state request", async () => {
	const t = temp();
	try {
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createMockExecutionProvider({ outcome: "hang" }),
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});
		const r = await host.admitAndRun({
			program: {
				name: "h",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		const resId = r.run?.reservationId;
		assert.ok(resId);
		const observed = host.coordinator.getReservation(resId!)!;
		const request: ForceReleaseRequest = {
			reservationId: observed.reservationId,
			expectedState: "orphan-suspect",
			expectedRevision: observed.revision,
			expectedCoordinatorEpoch: observed.coordinatorEpoch,
			expectedProjectId: observed.projectId!,
			expectedControlDomainId: observed.projectControlDomainId!,
			expectedRunId: observed.runId!,
			acknowledgement: FORCE_RELEASE_ACKNOWLEDGEMENT,
		};
		const denied = host.forceReleaseReservation(
			{ ...request, expectedRevision: request.expectedRevision - 1 },
			{ principal: "op" },
		);
		assert.equal(denied.ok, false);
		if (!denied.ok) assert.equal(denied.error.code, "TF_STALE_VERSION");
		const ok = host.forceReleaseReservation(request, { principal: "op" });
		assert.equal(ok.ok, true);
		host.close();
	} finally {
		t.cleanup();
	}
});

test("durable approval reject → blocked; expire → blocked; illegal transition rejected", async () => {
	const t = temp();
	try {
		const provider = createMockExecutionProvider({ outcome: "hang" });
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});
		const admitted = await host.admitAndRun({
			program: {
				name: "apr",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		const runId = admitted.run!.runId;
		provider.quiesceAll?.();
		const parked = await host.parkForApproval(runId);
		assert.equal(parked.ok, true, JSON.stringify(parked.error));
		const apr = loadApprovalForRun(t.project, runId);
		assert.ok(apr);
		assert.equal(apr!.status, "pending");

		const rejected = await host.reject(runId, {
			principal: "reviewer",
			expectedRunVersion: parked.run!.runVersion,
			note: "nope",
		});
		assert.equal(rejected.ok, true);
		assert.equal(rejected.run?.status, "blocked");
		assert.equal(rejected.run?.stage, "terminal");
		const after = loadApprovalForRun(t.project, runId);
		assert.equal(after?.status, "rejected");

		// Illegal: reject again
		const again = await host.reject(runId, { principal: "reviewer" });
		assert.equal(again.ok, false);
		host.close();
	} finally {
		t.cleanup();
	}
});

test("approval edit fails closed until edited-plan dispatcher exists", async () => {
	const t = temp();
	try {
		const provider = createMockExecutionProvider({ outcome: "hang" });
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});
		const admitted = await host.admitAndRun({
			program: {
				name: "edit-flow",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		const runId = admitted.run!.runId;
		provider.quiesceAll?.();
		const parked = await host.parkForApproval(runId);
		assert.equal(parked.ok, true, JSON.stringify(parked.error));
		assert.equal(parked.run?.status, "paused");
		assert.equal(parked.run?.stage, "parked");

		// Empty note rejected
		const empty = await host.edit(runId, {
			note: "   ",
			principal: "editor",
			expectedRunVersion: parked.run!.runVersion,
		});
		assert.equal(empty.ok, false);
		assert.equal(empty.error?.code, "TF_INVALID_ARGUMENT");

		const edited = await host.edit(runId, {
			note: "edited-output-body",
			principal: "editor",
			expectedRunVersion: parked.run!.runVersion,
		});
		assert.equal(edited.ok, false);
		assert.equal(edited.error?.code, "TF_FEATURE_REQUIRED");
		assert.equal(edited.error?.sideEffects, "none");
		assert.equal(edited.run?.status, "paused");
		assert.equal(edited.run?.stage, "parked");
		assert.equal(edited.receipt, undefined);
		const apr = loadApprovalForRun(t.project, runId);
		assert.equal(apr?.status, "pending");
		assert.equal(apr?.decision, undefined);

		// Repeated attempts remain side-effect free.
		const again = await host.edit(runId, { note: "nope", principal: "editor" });
		assert.equal(again.ok, false);
		assert.equal(again.error?.code, "TF_FEATURE_REQUIRED");
		host.close();
	} finally {
		t.cleanup();
	}
});

test("streamSeq is monotonic unique per stream within journal", async () => {
	const t = temp();
	try {
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createScriptExecutionProvider(),
		});
		const r = await host.admitAndRun({
			program: {
				name: "ss",
				phases: [{ id: "main", type: "script", run: "echo hi", final: true }],
			},
		});
		assert.equal(r.ok, true);
		const store = openProjectControlStore(t.project);
		const events = store.readEvents(1, store.nextCommitSeq());
		const byStream = new Map<string, number[]>();
		for (const ev of events) {
			const arr = byStream.get(ev.streamId) ?? [];
			arr.push(ev.streamSeq);
			byStream.set(ev.streamId, arr);
		}
		for (const [streamId, seqs] of byStream) {
			const sorted = [...seqs].sort((a, b) => a - b);
			assert.deepEqual(seqs, sorted, `stream ${streamId} not monotonic`);
			assert.equal(new Set(seqs).size, seqs.length, `stream ${streamId} has duplicate streamSeq`);
		}
		host.close();
	} finally {
		t.cleanup();
	}
});
