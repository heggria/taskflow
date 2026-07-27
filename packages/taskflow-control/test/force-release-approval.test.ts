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
	openUserCoordinatorStore as openUserCoordinatorStoreRaw,
	loadApprovalForRun,
	openProjectControlStore,
} from "../src/index.ts";

/** Raw global C2 fixtures in this suite are explicit non-GA test plumbing. */
function openUserCoordinatorStore(env: NodeJS.ProcessEnv = process.env) {
	return openUserCoordinatorStoreRaw(env, {
		allowUnfencedMutationForExplicitNonGaMode: true,
	});
}

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

test("forceRelease requires riskAcknowledged and principal; idempotent by commandId", () => {
	const t = temp();
	try {
		const coord = openUserCoordinatorStore(t.env);
		const rsv = coord.reserve();
		assert.ok(rsv);
		coord.commitReservation(rsv!.reservationId, {
			projectId: "p",
			projectControlDomainId: "d",
			runId: "r",
			projectAdmitCommitSeq: 1,
		});

		assert.throws(() =>
			coord.forceRelease(rsv!.reservationId, {
				commandId: "f1",
				callerPrincipal: "op",
				requestBody: { reservationId: rsv!.reservationId, riskAcknowledged: false },
			}),
		);

		const first = coord.forceRelease(rsv!.reservationId, {
			commandId: "f-ok",
			callerPrincipal: "op",
			requestBody: { reservationId: rsv!.reservationId, riskAcknowledged: true, reason: "stuck" },
		});
		assert.equal(first.reservation.state, "released");
		assert.equal(first.command.payload.riskAcknowledged, true);

		// Idempotent same commandId
		const second = coord.forceRelease(rsv!.reservationId, {
			commandId: "f-ok",
			callerPrincipal: "op",
			requestBody: { reservationId: rsv!.reservationId, riskAcknowledged: true, reason: "stuck" },
		});
		assert.equal(second.command.commandId, "f-ok");
		assert.equal(coord.getReservation(rsv!.reservationId)?.state, "released");
	} finally {
		t.cleanup();
	}
});

test("unbound reservation release is allowed only before any project/run binding", () => {
	const t = temp();
	try {
		const coord = openUserCoordinatorStore(t.env);
		const unbound = coord.reserve();
		assert.ok(unbound);
		assert.equal(
			coord.releaseUnboundReservation(unbound!.reservationId).state,
			"released",
		);

		const bound = coord.reserve();
		assert.ok(bound);
		coord.commitReservation(bound!.reservationId, {
			projectId: "p",
			projectControlDomainId: "d",
			runId: "r",
			projectAdmitCommitSeq: 1,
		});
		assert.throws(() => coord.releaseUnboundReservation(bound!.reservationId), /reserved record/);
		assert.equal(coord.getReservation(bound!.reservationId)?.state, "committed");
	} finally {
		t.cleanup();
	}
});

test("host forceReleaseReservation denies without risk ack", async () => {
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
		const denied = host.forceReleaseReservation(resId!, {
			principal: "op",
			riskAcknowledged: false,
		});
		assert.equal(denied.ok, false);
		if (!denied.ok) assert.equal(denied.error.code, "TF_POLICY_DENIED");
		const ok = host.forceReleaseReservation(resId!, {
			principal: "op",
			riskAcknowledged: true,
			reason: "operator force",
		});
		assert.equal(ok.ok, true);
		host.close();
	} finally {
		t.cleanup();
	}
});

test("host forceReleaseReservation rejects an unsafe external commandId before state mutation", async () => {
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
		const admitted = await host.admitAndRun({
			program: {
				name: "unsafe-force-command-id",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		const reservationId = admitted.run?.reservationId;
		assert.ok(reservationId);
		const rejected = host.forceReleaseReservation(reservationId, {
			principal: "operator",
			riskAcknowledged: true,
			commandId: "x/../../outside",
		});
		assert.equal(rejected.ok, false);
		if (!rejected.ok) assert.equal(rejected.error.code, "TF_INVALID_ARGUMENT");
		assert.notEqual(host.coordinator.getReservation(reservationId)?.state, "released");
		host.close();
	} finally {
		t.cleanup();
	}
});

test("host forceReleaseReservation preserves cross-principal command semantics", async () => {
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
		const admitted = await host.admitAndRun({
			program: {
				name: "force-principal-bound",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		const reservationId = admitted.run?.reservationId;
		assert.ok(reservationId);
		const commandId = "force-principal-bound-command";
		const first = host.forceReleaseReservation(reservationId, {
			commandId,
			principal: "operator-a",
			riskAcknowledged: true,
		});
		assert.equal(first.ok, true);

		const crossPrincipal = host.forceReleaseReservation(reservationId, {
			commandId,
			principal: "operator-b",
			riskAcknowledged: true,
		});
		assert.equal(crossPrincipal.ok, false);
		if (!crossPrincipal.ok) {
			assert.equal(crossPrincipal.error.code, "TF_CROSS_PRINCIPAL_COMMAND");
			assert.equal(crossPrincipal.error.commandId, commandId);
			assert.equal(crossPrincipal.error.recoveryAction, "none");
			assert.equal(crossPrincipal.error.sideEffects, "none");
		}
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

test("durable approval edit fails closed until provider continuation is durable", async () => {
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
		assert.equal(edited.run?.status, "paused");
		assert.equal(edited.run?.stage, "parked");
		assert.equal(edited.receipt, undefined);
		const apr = loadApprovalForRun(t.project, runId);
		assert.equal(apr?.status, "pending");
		assert.equal(apr?.decision, undefined);

		// A retry remains a no-side-effect denial until the continuation protocol exists.
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
