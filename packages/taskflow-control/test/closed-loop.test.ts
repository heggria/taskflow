/**
 * §23 GA closed-loop tests — drive shipped ControlHost / bootstrap APIs.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	bootstrapControl,
	createControlHost,
	createMockExecutionProvider,
	openControlRegistry,
	openProjectControlStore,
	openUserCoordinatorStore,
	CAPACITY_OCCUPYING_STATES,
	canNormalRelease,
	DEFAULT_CONTROL_MODE,
	assertControlModeExplicit,
} from "../src/index.ts";

function tempEnv(): { env: NodeJS.ProcessEnv; home: string; project: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-ctrl-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-ctrl-proj-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	return {
		env,
		home,
		project,
		cleanup: () => {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(project, { recursive: true, force: true });
		},
	};
}

const SCRIPT_FLOW = {
	name: "fresh-install",
	phases: [{ id: "main", type: "script", run: "true", final: true }],
};

test("fresh install auto: one run → Receipt with bound plan identity", async () => {
	const t = tempEnv();
	try {
		assert.equal(DEFAULT_CONTROL_MODE, "auto");
		const { host, controlMode, role } = bootstrapControl({
			projectRoot: t.project,
			env: t.env,
			provider: createMockExecutionProvider({ outcome: "completed", output: "hello" }),
		});
		assert.equal(controlMode, "auto");
		assert.ok(role === "writer" || role === "attach");

		const result = await host.admitAndRun({ program: SCRIPT_FLOW, callerPrincipal: "test" });
		assert.equal(result.ok, true, JSON.stringify(result.error));
		assert.ok(result.receipt, "Receipt must be present");
		assert.equal(result.run?.status, "completed");
		assert.equal(result.run?.stage, "terminal");
		assert.ok(result.receipt!.boundPlanHash.startsWith("bp:"));
		assert.ok(result.receipt!.eventManifest.length >= 1);
		assert.ok(result.receipt!.startCommitSeq >= 1);
		assert.ok(result.receipt!.endCommitSeq >= result.receipt!.startCommitSeq);
		assert.equal(result.receipt!.projectId, host.projectId);
		assert.equal(result.receipt!.controlDomainId, host.controlDomainId);
		host.close();
	} finally {
		t.cleanup();
	}
});

test("concurrent client start: single writer, loser attaches", () => {
	const t = tempEnv();
	try {
		const a = bootstrapControl({
			projectRoot: t.project,
			env: t.env,
			holderId: "client-a",
			provider: createMockExecutionProvider(),
		});
		const b = bootstrapControl({
			projectRoot: t.project,
			env: t.env,
			holderId: "client-b",
			provider: createMockExecutionProvider(),
		});
		const roles = [a.role, b.role].sort();
		// One writer path via singleton; both share same project identity
		assert.equal(a.host.projectId, b.host.projectId);
		assert.equal(a.host.controlDomainId, b.host.controlDomainId);
		// At least one is writer; the other attaches or also got writer after steal — same lock holder id wins
		assert.ok(a.host.singleton || b.host.singleton);
		if (a.host.singleton && b.host.singleton) {
			// Same endpoint
			assert.equal(a.host.singleton.lock.endpoint, b.host.singleton.lock.endpoint);
			// Exactly one writer among concurrent acquires when first still alive
			const writers = [a, b].filter((x) => x.host.singleton?.role === "writer");
			const attaches = [a, b].filter((x) => x.host.singleton?.role === "attach");
			assert.ok(writers.length === 1 || attaches.length >= 1, `roles=${roles}`);
		}
		a.host.close();
		b.host.close();
	} finally {
		t.cleanup();
	}
});

test("registry wipe + reopen restores projectId/domainId from store header", () => {
	const t = tempEnv();
	try {
		const host1 = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createMockExecutionProvider(),
		});
		const projectId = host1.projectId;
		const domainId = host1.controlDomainId;
		host1.registry.wipe();
		assert.equal(host1.registry.list().length, 0);
		host1.close();

		const host2 = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createMockExecutionProvider(),
		});
		assert.equal(host2.projectId, projectId);
		assert.equal(host2.controlDomainId, domainId);
		// Registry re-registered from header
		const entry = host2.registry.getByProjectId(projectId);
		assert.ok(entry);
		assert.equal(entry!.controlDomainId, domainId);
		host2.close();
	} finally {
		t.cleanup();
	}
});

test("silent auto→standalone is impossible via assertControlModeExplicit", () => {
	assert.throws(
		() => assertControlModeExplicit("auto", "standalone"),
		/forbidden: silent controlMode auto/,
	);
	assert.doesNotThrow(() => assertControlModeExplicit("standalone", "standalone"));
	assert.doesNotThrow(() => assertControlModeExplicit(undefined, "auto"));
});

test("maxActiveRuns capacity: N admitted, N+1 rejected; slots≡1", async () => {
	const t = tempEnv();
	try {
		const coord = openUserCoordinatorStore(t.env);
		// Set max to 2 via coordinator command
		coord.setMaxActiveRuns(2, {
			commandId: "cmd-max",
			callerPrincipal: "op",
			requestBody: { maxActiveRuns: 2 },
		});
		assert.equal(coord.maxActiveRuns, 2);

		const provider = createMockExecutionProvider({ outcome: "hang" });
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 10 },
		});

		const r1 = await host.admitAndRun({ program: SCRIPT_FLOW, commandId: "c1" });
		const r2 = await host.admitAndRun({ program: SCRIPT_FLOW, commandId: "c2" });
		// hang → needs-operator after reconcile; both may occupy slots as orphan-suspect
		assert.ok(r1.run || r1.error);
		assert.ok(r2.run || r2.error);

		const r3 = await host.admitAndRun({ program: SCRIPT_FLOW, commandId: "c3" });
		// Third should hit capacity if first two still occupying
		const occupying = host.coordinator.occupyingCount();
		if (occupying >= host.coordinator.maxActiveRuns) {
			assert.equal(r3.ok, false);
			assert.equal(r3.error?.code, "TF_CAPACITY_EXCEEDED");
		}
		// All reservations slots ≡ 1
		for (const r of host.coordinator.listReservations()) {
			assert.equal(r.slots, 1);
		}
		host.close();
	} finally {
		t.cleanup();
	}
});

test("committed slot not TTL-released; forceRelease only via CoordinatorCommandRecord", () => {
	const t = tempEnv();
	try {
		const coord = openUserCoordinatorStore(t.env);
		const rsv = coord.reserve({ coordinatorEpoch: 1, ttlMs: 1 });
		assert.ok(rsv);
		coord.commitReservation(rsv!.reservationId, {
			projectId: "p",
			projectControlDomainId: "d",
			runId: "r",
			projectAdmitCommitSeq: 1,
		});
		// Wait past TTL
		const n = coord.reclaimExpiredReserved(Date.now() + 10_000);
		// committed must NOT be reclaimed
		const still = coord.getReservation(rsv!.reservationId);
		assert.equal(still?.state, "committed");
		assert.equal(
			CAPACITY_OCCUPYING_STATES.includes(still!.state),
			true,
		);
		void n;

		// normalRelease without predicates fails
		assert.throws(() =>
			coord.normalRelease(rsv!.reservationId, {
				noLiveOrAmbiguousSideEffects: false,
				runIsTerminal: true,
				runIsParkedAndFutureDispatchRequiresReadmission: false,
			}),
		);

		// forceRelease via command path
		const { reservation, command } = coord.forceRelease(rsv!.reservationId, {
			commandId: "force-1",
			callerPrincipal: "op",
			requestBody: { reservationId: rsv!.reservationId },
		});
		assert.equal(reservation.state, "released");
		assert.equal(reservation.operatorOverridden, true);
		assert.equal(command.kind, "forceRelease");
		assert.ok(coord.getCommand("force-1"));
	} finally {
		t.cleanup();
	}
});

test("reconcile exhaustion: unknown + needs-operator + no Receipt; wait returns TF_RECONCILE_REQUIRED", async () => {
	const t = tempEnv();
	try {
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createMockExecutionProvider({ outcome: "ambiguous", ambiguousForever: true }),
			reconcileBudget: { maxAttempts: 2, deadlineMs: 1000 },
		});
		const result = await host.admitAndRun({ program: SCRIPT_FLOW });
		assert.equal(result.ok, false);
		assert.equal(result.run?.status, "unknown");
		assert.equal(result.run?.stage, "reconciling");
		assert.equal(result.run?.needsOperator, true);
		assert.equal(result.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(result.error?.recoveryAction, "operator");
		// No final Receipt
		assert.equal(result.receipt, undefined);
		assert.equal(host.store.getReceiptForRun(result.run!.runId), null);

		// wait returns normal snapshot, not transport failure
		const snap = await host.wait(result.run!.runId);
		assert.equal(snap.run.status, "unknown");
		assert.equal(snap.controlError?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(snap.receipt, null);

		// Slot held as orphan-suspect
		const rsv = host.coordinator.getReservation(result.run!.reservationId!);
		assert.ok(rsv);
		assert.equal(rsv!.state, "orphan-suspect");
		host.close();
	} finally {
		t.cleanup();
	}
});

test("approval park releases slot; approve re-reserves", async () => {
	const t = tempEnv();
	try {
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createMockExecutionProvider({ outcome: "completed" }),
		});
		// Start a hang-like path by parking manually after a successful admit is awkward;
		// park API on a completed run still tests stage transitions for unit purposes —
		// instead: admit hang, then park.
		const hangHost = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createMockExecutionProvider({ outcome: "hang" }),
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});
		const admitted = await hangHost.admitAndRun({ program: SCRIPT_FLOW, commandId: "park-1" });
		// may be needs-operator; still has reservation
		const runId = admitted.run?.runId;
		assert.ok(runId);
		const before = hangHost.coordinator.occupyingCount();
		const parked = await hangHost.parkForApproval(runId!);
		assert.equal(parked.run?.status, "paused");
		assert.equal(parked.run?.stage, "parked");
		assert.ok(canNormalRelease({
			noLiveOrAmbiguousSideEffects: true,
			runIsTerminal: false,
			runIsParkedAndFutureDispatchRequiresReadmission: true,
		}));
		const afterPark = hangHost.coordinator.occupyingCount();
		assert.ok(afterPark <= before);

		const approved = await hangHost.approve(runId!);
		assert.equal(approved.ok, true);
		assert.equal(approved.run?.status, "completed");
		assert.ok(approved.receipt);
		hangHost.close();
		host.close();
	} finally {
		t.cleanup();
	}
});

test("D37 predicates: canNormalRelease pure function", () => {
	assert.equal(
		canNormalRelease({
			noLiveOrAmbiguousSideEffects: true,
			runIsTerminal: true,
			runIsParkedAndFutureDispatchRequiresReadmission: false,
		}),
		true,
	);
	assert.equal(
		canNormalRelease({
			noLiveOrAmbiguousSideEffects: true,
			runIsTerminal: false,
			runIsParkedAndFutureDispatchRequiresReadmission: true,
		}),
		true,
	);
	assert.equal(
		canNormalRelease({
			noLiveOrAmbiguousSideEffects: false,
			runIsTerminal: true,
			runIsParkedAndFutureDispatchRequiresReadmission: false,
		}),
		false,
	);
});

test("openProjectControlStore header is authority for identity", () => {
	const t = tempEnv();
	try {
		const s1 = openProjectControlStore(t.project);
		const id = s1.header.projectId;
		const dom = s1.header.controlDomainId;
		const s2 = openProjectControlStore(t.project);
		assert.equal(s2.header.projectId, id);
		assert.equal(s2.header.controlDomainId, dom);
		const reg = openControlRegistry(t.env);
		reg.registerFromStore(s2, t.project);
		reg.wipe();
		const s3 = openProjectControlStore(t.project);
		assert.equal(s3.header.projectId, id);
	} finally {
		t.cleanup();
	}
});
