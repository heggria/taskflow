/**
 * P13/C7: a bare provider `cancelled` enum is not a containment proof.
 *
 * The provider below behaves like a generic remote adapter that reports the
 * job cancelled and non-live, but supplies no evidence that all external side
 * effects (for example detached work) are contained. The host must preserve a
 * nonterminal, reconciling cancellation rather than minting a terminal state
 * or releasing capacity from that naked assertion.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	createControlHost,
	createMockExecutionProvider,
	ControlStoreDurabilityError,
	type ExecutionProvider,
	type ProviderJobHandle,
} from "../src/index.ts";

function temp(): { env: NodeJS.ProcessEnv; project: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-cancel-containment-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-cancel-containment-project-"));
	return {
		env: { ...process.env, TASKFLOW_HOME: home },
		project,
		cleanup: () => {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(project, { recursive: true, force: true });
		},
	};
}

function assertContainedCancellation(
	host: ReturnType<typeof createControlHost>,
	runId: string,
	commandId: string,
): void {
	const snapshot = host.getSnapshot(runId);
	assert.ok(snapshot, "run must remain durably observable");
	assert.equal(snapshot.run.status, "unknown");
	assert.equal(snapshot.run.stage, "reconciling");
	assert.equal(snapshot.run.cancelRequest?.commandId, commandId);
	assert.ok(
		snapshot.run.cancelRequest?.state === "requested" ||
			snapshot.run.cancelRequest?.state === "signalling" ||
			snapshot.run.cancelRequest?.state === "ambiguous",
		"the accepted cancel lifecycle must remain durable",
	);
	assert.ok(snapshot.run.reservationId, "uncontained cancellation must retain capacity");
	assert.notEqual(host.coordinator.getReservation(snapshot.run.reservationId!)?.state, "released");
	assert.equal(host.store.getReceiptForRun(runId), null);
}

/**
 * Two provider instances deliberately use disjoint handle namespaces. This
 * makes a wrong `scriptProvider` fallback observable: a control-plane route
 * must be selected from the durable providerName/attempt, never from which
 * provider happens to have an isLive/cancel method in the current host.
 */
function namedHangingProvider(name: string): {
	provider: ExecutionProvider;
	readonly cancelCalls: number;
	readonly isLiveCalls: number;
} {
	type Job = { runId: string; cwd: string; startedAt: number };
	const jobs = new Map<string, Job>();
	let submitted = 0;
	let cancelCalls = 0;
	let isLiveCalls = 0;
	const provider: ExecutionProvider = {
		name,
		async submit(req) {
			const handle = `${name}-handle-${++submitted}`;
			jobs.set(handle, { runId: req.runId, cwd: req.cwd, startedAt: Date.now() });
			return { kind: "accepted", handle };
		},
		async poll() {
			return { kind: "still-running" };
		},
		async cancel() {
			cancelCalls += 1;
			return { kind: "cancelled" };
		},
		async reconcile() {
			return { kind: "ambiguous", reason: "fixture retains a live external side effect" };
		},
		isLive(handle) {
			isLiveCalls += 1;
			return jobs.has(handle);
		},
		loadHandle(handle): ProviderJobHandle | null {
			const job = jobs.get(handle);
			if (!job) return null;
			return {
				handle,
				runId: job.runId,
				providerName: name,
				leaseEpoch: job.startedAt,
				cwd: job.cwd,
				startedAt: job.startedAt,
				status: "running",
			};
		},
	};
	return {
		provider,
		get cancelCalls() {
			return cancelCalls;
		},
		get isLiveCalls() {
			return isLiveCalls;
		},
	};
}

test("C7/D38: parkForApproval uses the durable LLM provider rather than script fallback", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		const script = namedHangingProvider("script-route");
		const llm = namedHangingProvider("llm-route");
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			scriptProvider: script.provider,
			llmProvider: llm.provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 1 },
		});

		const admitted = await host.admitAndRun({
			program: {
				name: "llm-route-park",
				phases: [{ id: "agent", type: "agent", agent: "executor", task: "hold", final: true }],
			},
		});
		assert.equal(admitted.ok, false, JSON.stringify(admitted.error));
		const run = host.store.getRun(admitted.run!.runId)!;
		assert.equal(run.providerName, "llm-route");
		assert.match(run.providerHandle ?? "", /^llm-route-handle-/);

		const parked = await host.parkForApproval(run.runId, { expectedRunVersion: run.runVersion });

		assert.equal(parked.ok, false, JSON.stringify(parked.error));
		assert.equal(parked.error?.code, "TF_PROVIDER_AMBIGUOUS");
		assert.ok(llm.isLiveCalls > 0, "the durable LLM provider must prove quiescence");
		assert.equal(script.isLiveCalls, 0, "script must not inspect an LLM handle");
		assert.ok(run.reservationId, "fixture requires a held reservation");
		assert.notEqual(host.coordinator.getReservation(run.reservationId!)?.state, "released");
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("C7: cancel routes to the durable LLM provider after host reopen", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	let reopened: ReturnType<typeof createControlHost> | undefined;
	try {
		const script = namedHangingProvider("script-reopen-route");
		const llm = namedHangingProvider("llm-reopen-route");
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			scriptProvider: script.provider,
			llmProvider: llm.provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 1 },
		});
		const admitted = await host.admitAndRun({
			program: {
				name: "llm-route-reopen",
				phases: [{ id: "agent", type: "agent", agent: "executor", task: "hold", final: true }],
			},
		});
		assert.equal(admitted.ok, false, JSON.stringify(admitted.error));
		const before = host.store.getRun(admitted.run!.runId)!;
		assert.equal(before.providerName, "llm-reopen-route");
		assert.match(before.providerHandle ?? "", /^llm-reopen-route-handle-/);

		host.close();
		host = undefined;
		reopened = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			scriptProvider: script.provider,
			llmProvider: llm.provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 1 },
		});

		const cancelled = await reopened.cancel(before.runId, {
			commandId: "llm-route-after-reopen",
			expectedRunVersion: before.runVersion,
		});

		assert.equal(script.cancelCalls, 0, "script must never receive an LLM handle");
		assert.equal(llm.cancelCalls, 1, "the durable LLM provider must receive the cancel signal");
		assert.equal(cancelled.ok, false, JSON.stringify(cancelled.error));
		assert.equal(cancelled.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(cancelled.run?.providerName, "llm-reopen-route");
		assert.equal(cancelled.run?.cancelRequest?.providerName, "llm-reopen-route");
		assert.equal(cancelled.run?.cancelRequest?.continuationId, before.continuationId);
		assert.ok(cancelled.run?.cancelRequest?.continuationVersion);
		assert.ok(cancelled.run?.cancelRequest?.attemptId);
		assert.equal(cancelled.run?.cancelRequest?.phaseId, "agent");
		assertContainedCancellation(reopened, before.runId, "llm-route-after-reopen");
	} finally {
		reopened?.close();
		host?.close();
		t.cleanup();
	}
});

test("C7: missing durable provider after reopen never falls back by opaque handle", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	let reopened: ReturnType<typeof createControlHost> | undefined;
	try {
		const script = namedHangingProvider("script-no-fallback");
		const llm = namedHangingProvider("llm-missing-after-reopen");
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			scriptProvider: script.provider,
			llmProvider: llm.provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 1 },
		});
		const admitted = await host.admitAndRun({
			program: {
				name: "llm-no-fallback",
				phases: [{ id: "agent", type: "agent", agent: "executor", task: "hold", final: true }],
			},
		});
		const before = host.store.getRun(admitted.run!.runId)!;
		assert.equal(before.providerName, "llm-missing-after-reopen");

		host.close();
		host = undefined;
		reopened = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			scriptProvider: script.provider,
			// Deliberately omit the provider that owns the durable handle.
		reconcileBudget: { maxAttempts: 1, deadlineMs: 1 },
		});

		const cancelled = await reopened.cancel(before.runId, {
			commandId: "missing-llm-no-fallback",
			expectedRunVersion: before.runVersion,
		});

		assert.equal(script.cancelCalls, 0, "a missing LLM provider must not fall back to script");
		assert.equal(llm.cancelCalls, 0, "a closed host must not make an in-memory side effect");
		assert.equal(cancelled.ok, false, JSON.stringify(cancelled.error));
		assert.equal(cancelled.error?.code, "TF_RECONCILE_REQUIRED");
		assert.match(cancelled.run?.error ?? "", /no current ExecutionProvider is registered/i);
		assertContainedCancellation(reopened, before.runId, "missing-llm-no-fallback");
	} finally {
		reopened?.close();
		host?.close();
		t.cleanup();
	}
});

test("C7: cancel refuses a same-name provider handle owned by another run", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		let cancelCalls = 0;
		let submitted: { runId: string; cwd: string; startedAt: number } | undefined;
		let recordRunId: string | undefined;
		const provider: ExecutionProvider = {
			name: "shared-provider-name",
			async submit(req) {
				submitted = { runId: req.runId, cwd: req.cwd, startedAt: Date.now() };
				recordRunId = req.runId;
				return { kind: "accepted", handle: "shared-opaque-handle" };
			},
			async poll() {
				return { kind: "still-running" };
			},
			async cancel() {
				cancelCalls += 1;
				return { kind: "cancelled" };
			},
			async reconcile() {
				return { kind: "ambiguous", reason: "fixture retains a foreign live handle" };
			},
			loadHandle(handle): ProviderJobHandle | null {
				if (!submitted || handle !== "shared-opaque-handle") return null;
				return {
					handle,
					runId: recordRunId!,
					providerName: "shared-provider-name",
					leaseEpoch: submitted.startedAt,
					cwd: submitted.cwd,
					startedAt: submitted.startedAt,
					status: "running",
				};
			},
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 1 },
		});
		const admitted = await host.admitAndRun({
			program: {
				name: "foreign-same-provider-handle",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		const before = host.store.getRun(admitted.run!.runId)!;
		assert.equal(before.providerName, "shared-provider-name");
		assert.equal(before.providerHandle, "shared-opaque-handle");
		recordRunId = "foreign-run:foreign-phase";

		const cancelled = await host.cancel(before.runId, {
			commandId: "foreign-same-provider-handle-cancel",
			expectedRunVersion: before.runVersion,
		});

		assert.equal(cancelCalls, 0, "a foreign provider record must never receive a cancel signal");
		assert.equal(cancelled.ok, false, JSON.stringify(cancelled.error));
		assert.equal(cancelled.error?.code, "TF_RECONCILE_REQUIRED");
		assert.match(cancelled.run?.error ?? "", /provider.*record|record.*route/i);
		assertContainedCancellation(host, before.runId, "foreign-same-provider-handle-cancel");
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("C7: pending-dispatch recovery refuses a same-name provider handle owned by another run", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		let reconcileCalls = 0;
		let submitted: { runId: string; cwd: string; startedAt: number } | undefined;
		let recordRunId: string | undefined;
		const provider: ExecutionProvider = {
			name: "shared-recovery-provider",
			async submit(req) {
				submitted = { runId: req.runId, cwd: req.cwd, startedAt: Date.now() };
				recordRunId = req.runId;
				return { kind: "accepted", handle: "shared-recovery-handle" };
			},
			async poll() {
				return { kind: "still-running" };
			},
			async cancel() {
				return { kind: "cancelled" };
			},
			async reconcile() {
				reconcileCalls += 1;
				return { kind: "ambiguous", reason: "foreign completion must not be observed" };
			},
			loadHandle(handle): ProviderJobHandle | null {
				if (!submitted || handle !== "shared-recovery-handle") return null;
				return {
					handle,
					runId: recordRunId!,
					providerName: "shared-recovery-provider",
					leaseEpoch: submitted.startedAt,
					cwd: submitted.cwd,
					startedAt: submitted.startedAt,
					status: "running",
				};
			},
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 1 },
		});
		const admitted = await host.admitAndRun({
			program: {
				name: "foreign-recovery-handle",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		assert.equal(admitted.ok, false, JSON.stringify(admitted.error));
		const before = host.store.getRun(admitted.run!.runId)!;
		assert.equal(host.store.getContinuation(before.runId)?.activeAttempt?.state, "acknowledged");
		reconcileCalls = 0;
		recordRunId = "foreign-recovery-run:foreign-phase";

		const recovered = await host.reconcilePendingDispatch(before.runId, {
			commandId: "foreign-same-provider-handle-recovery",
			expectedRunVersion: before.runVersion,
		});

		assert.equal(reconcileCalls, 0, "a foreign provider record must never receive reconciliation");
		assert.equal(recovered.ok, false, JSON.stringify(recovered.error));
		assert.equal(recovered.error?.code, "TF_RECONCILE_REQUIRED");
		assert.match(recovered.run?.error ?? "", /cannot verify recovered provider handle ownership/i);
		assert.equal(host.store.getReceiptForRun(before.runId), null);
		assert.ok(recovered.run?.reservationId, "foreign recovery must retain capacity");
		assert.notEqual(host.coordinator.getReservation(recovered.run!.reservationId!)?.state, "released");
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("C7-B: foreign accepted handle cannot be acknowledged, polled, or terminalized", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		let pollCalls = 0;
		let reconcileCalls = 0;
		const provider: ExecutionProvider = {
			name: "same-name-dispatch-provider",
			async submit() {
				return { kind: "accepted", handle: "foreign-dispatch-handle" };
			},
			async poll() {
				pollCalls += 1;
				return { kind: "completed", output: "foreign-job-output" };
			},
			async cancel() {
				return { kind: "cancelled" };
			},
			async reconcile() {
				reconcileCalls += 1;
				return { kind: "completed", output: "foreign-job-output" };
			},
			loadHandle(handle): ProviderJobHandle | null {
				if (handle !== "foreign-dispatch-handle") return null;
				return {
					handle,
					runId: "other-run:other-phase",
					providerName: "same-name-dispatch-provider",
					leaseEpoch: 1,
					cwd: t.project,
					startedAt: 1,
					status: "completed",
					stdout: "foreign-job-output",
				};
			},
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider,
		});

		const result = await host.admitAndRun({
			program: {
				name: "foreign-dispatch-handle",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});

		assert.equal(result.ok, false, JSON.stringify(result.error));
		assert.equal(result.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(pollCalls, 0, "foreign ownership must be rejected before terminal observation");
		assert.equal(reconcileCalls, 0, "foreign ownership must not be reconciled as this Run");
		assert.equal(result.run?.status, "unknown");
		assert.equal(result.run?.stage, "reconciling");
		assert.equal(result.run?.needsOperator, true);
		assert.equal(result.run?.providerHandle, undefined, "foreign handle must not be written to Run");
		assert.equal(host.store.getReceiptForRun(result.run!.runId), null);
		assert.ok(result.run?.reservationId, "unverified provider work must retain capacity");
		assert.notEqual(
			host.coordinator.getReservation(result.run!.reservationId!)?.state,
			"released",
		);
		const continuation = host.store.getContinuation(result.run!.runId);
		assert.equal(continuation?.activeAttempt?.state, "intent-recorded");
		assert.equal(continuation?.activeAttempt?.providerHandle, undefined);
		const events = host.store.readEvents(1, host.store.nextCommitSeq());
		assert.equal(
			events.some(
				(event) =>
					(event.payload as { type?: string; runId?: string }).type === "DispatchAcknowledged" &&
					(event.payload as { runId?: string }).runId === result.run!.runId,
			),
			false,
			"foreign handle must not receive a durable DispatchAcknowledged event",
		);
	} finally {
		host?.close();
		t.cleanup();
	}
});

/**
 * C7-C lower-bound counterexample, deliberately asserted as the current
 * unsafe behavior. The provider returns a matching record for the two host
 * checks (acknowledgement and entry to terminal observation), then rebinds the
 * opaque handle immediately before `poll`. A host-side read-before-use check
 * cannot distinguish that from a genuine terminal observation; only a
 * provider-side capability/incarnation/linearization contract can make this
 * test safe. Replace this negative assertion when that contract exists.
 */
test("C7-C counterexample: provider can rebind after ownership checks and false-terminalize", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		let routedRunId: string | undefined;
		let ownershipChecks = 0;
		let pollCalls = 0;
		const provider: ExecutionProvider = {
			name: "rebind-after-check-provider",
			async submit(req) {
				routedRunId = req.runId;
				return { kind: "accepted", handle: "rebind-after-check-handle" };
			},
			async poll() {
				pollCalls += 1;
				return { kind: "completed", output: "foreign-output-after-rebind" };
			},
			async cancel() {
				return { kind: "ambiguous" };
			},
			async reconcile() {
				return { kind: "ambiguous", reason: "provider record was rebound after host ownership check" };
			},
			loadHandle(handle): ProviderJobHandle | null {
				if (handle !== "rebind-after-check-handle" || !routedRunId) return null;
				ownershipChecks += 1;
				return {
					handle,
					// Check 1 is before acknowledgement; check 2 is immediately before
					// entering waitTerminal. The provider rebind happens after check 2.
					runId: ownershipChecks <= 2 ? routedRunId : "other-run:other-phase",
					providerName: "rebind-after-check-provider",
					leaseEpoch: 1,
					cwd: t.project,
					startedAt: 1,
					status: "completed",
					stdout: "foreign-output-after-rebind",
				};
			},
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider,
		});

		const result = await host.admitAndRun({
			program: {
				name: "rebind-after-check",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});

		assert.equal(ownershipChecks, 2, "the current scheduler checks only before acknowledgement and observation entry");
		assert.equal(pollCalls, 1, "provider can rebind after the last host-side check");
		assert.equal(result.ok, true, "this is the current C7-C false-terminal counterexample");
		assert.equal(result.run?.status, "completed");
		assert.equal(result.run?.finalOutput, "foreign-output-after-rebind");
		assert.ok(host.store.getReceiptForRun(result.run!.runId), "the current host signs a false Receipt");
		const finalRun = host.store.getRun(result.run!.runId)!;
		assert.ok(finalRun.reservationId, "counterexample must expose the released reservation");
		assert.equal(host.coordinator.getReservation(finalRun.reservationId!)?.state, "released");
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("C7-A: reentrant cancel cannot commit before a fence-protected submit side effect", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	let cancelPromise: Promise<Awaited<ReturnType<ReturnType<typeof createControlHost>["cancel"]>>> | undefined;
	let sideEffectRan = false;
	let cancelWasDurableBeforeSideEffect = false;
	let submitted: { runId: string; cwd: string; startedAt: number } | undefined;
	try {
		const provider: ExecutionProvider = {
			name: "reentrant-linearization",
			async submit(req) {
				assert.ok(req.submissionFence, "ControlHost must supply the provider submission fence");
				return req.submissionFence.execute(() => {
					submitted = { runId: req.runId, cwd: req.cwd, startedAt: Date.now() };
					const run = host!.store.listRuns()[0];
					assert.ok(run, "durable run must exist before provider submit");
					cancelPromise = host!.cancel(run.runId, {
						commandId: "reentrant-cancel-during-submit",
						principal: "adversarial-provider",
					});
					cancelWasDurableBeforeSideEffect = Boolean(host!.store.getRun(run.runId)?.cancelRequest);
					sideEffectRan = true;
					return { kind: "accepted", handle: "reentrant-linearization-handle" };
				});
			},
			async poll() {
				return { kind: "still-running" };
			},
			async cancel() {
				return { kind: "cancelled" };
			},
			async reconcile() {
				return { kind: "ambiguous", reason: "fixture preserves an uncontained side effect" };
			},
			isLive() {
				return true;
			},
			loadHandle(handle): ProviderJobHandle | null {
				if (!submitted || handle !== "reentrant-linearization-handle") return null;
				return {
					handle,
					runId: submitted.runId,
					providerName: "reentrant-linearization",
					leaseEpoch: submitted.startedAt,
					cwd: submitted.cwd,
					startedAt: submitted.startedAt,
					status: "running",
				};
			},
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 1 },
		});

		await host.admitAndRun({
			program: {
				name: "reentrant-cancel-linearization",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		assert.ok(cancelPromise, "provider must have attempted a reentrant cancellation");
		await cancelPromise;

		assert.equal(sideEffectRan, true, "fixture must cross the provider side-effect boundary");
		assert.equal(
			cancelWasDurableBeforeSideEffect,
			false,
			"a cancellation cannot become durable between the final lease check and the protected submit side effect",
		);
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("C7: generic provider cannot terminalize cancel with only cancelled plus isLive=false", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		const raw = createMockExecutionProvider({ outcome: "hang" });
		let cancelCalls = 0;
		const opaqueRemote: ExecutionProvider = {
			name: "opaque-remote",
			probe: raw.probe?.bind(raw),
			prepare: raw.prepare?.bind(raw),
			submit: raw.submit.bind(raw),
			poll: raw.poll.bind(raw),
			collect: raw.collect?.bind(raw),
			watch: raw.watch?.bind(raw),
			async cancel(handle, options) {
				cancelCalls += 1;
				return raw.cancel(handle, options);
			},
			reconcile: raw.reconcile.bind(raw),
			isLive: raw.isLive?.bind(raw),
			loadHandle(handle) {
				const record = raw.loadHandle?.(handle);
				return record ? { ...record, providerName: "opaque-remote" } : null;
			},
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider: opaqueRemote,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});
		const admitted = await host.admitAndRun({
			program: {
				name: "opaque-cancel-proof",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		const before = host.getSnapshot(admitted.run!.runId)!.run;
		assert.ok(before.providerHandle, "fixture requires a durable provider handle");

		const result = await host.cancel(before.runId, {
			commandId: "opaque-cancel-command",
			expectedRunVersion: before.runVersion,
		});

		assert.equal(cancelCalls, 1, "the provider crossed its cancellation boundary once");
		assert.equal(result.ok, false, JSON.stringify(result.error));
		assert.equal(result.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(result.error?.recoveryAction, "reconcile");
		assert.equal(result.error?.sideEffects, "possible");
		assert.equal(result.run?.status, "unknown");
		assert.equal(result.run?.stage, "reconciling");
		assert.equal(result.run?.cancelRequest?.state, "ambiguous");
		assert.ok(result.run?.reservationId, "ambiguous cancellation must retain capacity");
		assert.notEqual(host.coordinator.getReservation(result.run!.reservationId!)?.state, "released");
		assert.equal(host.store.getReceiptForRun(before.runId), null);
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("C7: generic provider cannot terminalize bounded reconciliation with only cancelled", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		const raw = createMockExecutionProvider({ outcome: "hang" });
		let reconcileCalls = 0;
		const opaqueRemote: ExecutionProvider = {
			name: "opaque-remote-reconcile",
			probe: raw.probe?.bind(raw),
			prepare: raw.prepare?.bind(raw),
			submit: raw.submit.bind(raw),
			poll: raw.poll.bind(raw),
			collect: raw.collect?.bind(raw),
			watch: raw.watch?.bind(raw),
			cancel: raw.cancel.bind(raw),
			async reconcile() {
				reconcileCalls += 1;
				return { kind: "cancelled" };
			},
			isLive: raw.isLive?.bind(raw),
			loadHandle(handle) {
				const record = raw.loadHandle?.(handle);
				return record ? { ...record, providerName: "opaque-remote-reconcile" } : null;
			},
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider: opaqueRemote,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});

		const result = await host.admitAndRun({
			program: {
				name: "opaque-reconcile-cancelled",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});

		assert.equal(reconcileCalls, 1, "fixture must cross the provider reconciliation boundary");
		assert.equal(result.ok, false, JSON.stringify(result.error));
		assert.equal(result.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(result.run?.status, "unknown");
		assert.equal(result.run?.stage, "reconciling");
		assert.equal(result.run?.needsOperator, true);
		assert.ok(result.run?.reservationId, "unproven cancellation must keep capacity accounted");
		assert.notEqual(host.coordinator.getReservation(result.run!.reservationId!)?.state, "released");
		assert.equal(host.store.getReceiptForRun(result.run!.runId), null);
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("C7: generic provider poll cancelled cannot terminalize or release capacity", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		const raw = createMockExecutionProvider({ outcome: "hang" });
		let pollCalls = 0;
		const opaqueRemote: ExecutionProvider = {
			name: "opaque-remote-poll-cancelled",
			probe: raw.probe?.bind(raw),
			prepare: raw.prepare?.bind(raw),
			submit: raw.submit.bind(raw),
			async poll() {
				pollCalls += 1;
				return { kind: "cancelled" };
			},
			cancel: raw.cancel.bind(raw),
			reconcile: raw.reconcile.bind(raw),
			isLive: raw.isLive?.bind(raw),
			loadHandle(handle) {
				const record = raw.loadHandle?.(handle);
				return record ? { ...record, providerName: "opaque-remote-poll-cancelled" } : null;
			},
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider: opaqueRemote,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});

		const result = await host.admitAndRun({
			program: {
				name: "opaque-poll-cancelled",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});

		assert.equal(pollCalls, 1, "fixture must cross the provider poll boundary");
		assert.equal(result.ok, false, JSON.stringify(result.error));
		assert.equal(result.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(result.run?.status, "unknown");
		assert.equal(result.run?.stage, "reconciling");
		assert.ok(result.run?.reservationId, "unproven cancellation must keep capacity accounted");
		assert.notEqual(host.coordinator.getReservation(result.run!.reservationId!)?.state, "released");
		assert.equal(host.store.getReceiptForRun(result.run!.runId), null);
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("C7: generic provider collect cancelled cannot terminalize or release capacity", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		const raw = createMockExecutionProvider({ outcome: "hang" });
		let collectCalls = 0;
		const opaqueRemote: ExecutionProvider = {
			name: "opaque-remote-collect-cancelled",
			probe: raw.probe?.bind(raw),
			prepare: raw.prepare?.bind(raw),
			submit: raw.submit.bind(raw),
			async poll() {
				throw new Error("scheduler must use the provider collect observation when it is available");
			},
			async collect() {
				collectCalls += 1;
				return { kind: "cancelled" };
			},
			cancel: raw.cancel.bind(raw),
			reconcile: raw.reconcile.bind(raw),
			isLive: raw.isLive?.bind(raw),
			loadHandle(handle) {
				const record = raw.loadHandle?.(handle);
				return record ? { ...record, providerName: "opaque-remote-collect-cancelled" } : null;
			},
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider: opaqueRemote,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});

		const result = await host.admitAndRun({
			program: {
				name: "opaque-collect-cancelled",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});

		assert.equal(collectCalls, 1, "fixture must cross the provider collect boundary");
		assert.equal(result.ok, false, JSON.stringify(result.error));
		assert.equal(result.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(result.run?.status, "unknown");
		assert.equal(result.run?.stage, "reconciling");
		assert.ok(result.run?.reservationId, "unproven cancellation must keep capacity accounted");
		assert.notEqual(host.coordinator.getReservation(result.run!.reservationId!)?.state, "released");
		assert.equal(host.store.getReceiptForRun(result.run!.runId), null);
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("C7: cancellation survives a late scheduler completion and reopen", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	let reopened: ReturnType<typeof createControlHost> | undefined;
	try {
		let releasePoll: (() => void) | undefined;
		const pollRelease = new Promise<void>((resolve) => {
			releasePoll = resolve;
		});
		let observePoll: (() => void) | undefined;
		const pollObserved = new Promise<void>((resolve) => {
			observePoll = resolve;
		});
		let pollCalls = 0;
		let cancelCalls = 0;
		let submitted: { runId: string; cwd: string; startedAt: number } | undefined;
		const opaqueRemote: ExecutionProvider = {
			name: "opaque-remote-race",
			async submit(req) {
				submitted = { runId: req.runId, cwd: req.cwd, startedAt: Date.now() };
				return { kind: "accepted", handle: "opaque-race-handle" };
			},
			async poll() {
				pollCalls += 1;
				observePoll?.();
				await pollRelease;
				return { kind: "completed", output: "late provider output" };
			},
			async cancel() {
				cancelCalls += 1;
				return { kind: "cancelled" };
			},
			async reconcile() {
				return { kind: "ambiguous", reason: "remote work lacks a containment proof" };
			},
			isLive() {
				return false;
			},
			loadHandle(handle): ProviderJobHandle | null {
				if (!submitted || handle !== "opaque-race-handle") return null;
				return {
					handle,
					runId: submitted.runId,
					providerName: "opaque-remote-race",
					leaseEpoch: submitted.startedAt,
					cwd: submitted.cwd,
					startedAt: submitted.startedAt,
					status: "running",
				};
			},
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider: opaqueRemote,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});

		const admission = host.admitAndRun({
			program: {
				name: "opaque-cancel-race",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		await pollObserved;
		const beforeCancel = host.store.listRuns()[0];
		assert.ok(beforeCancel, "scheduler must durably publish its run before polling");
		const commandId = "opaque-cancel-race-command";
		const cancelled = await host.cancel(beforeCancel.runId, {
			commandId,
			expectedRunVersion: beforeCancel.runVersion,
		});
		assert.equal(cancelled.ok, false, JSON.stringify(cancelled.error));
		assert.equal(cancelled.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(cancelCalls, 1, "only the cancel command may cross the provider cancel boundary");
		assertContainedCancellation(host, beforeCancel.runId, commandId);

		releasePoll?.();
		const afterLateCompletion = await admission;
		assert.equal(afterLateCompletion.ok, false, JSON.stringify(afterLateCompletion.error));
		assert.equal(afterLateCompletion.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(pollCalls, 1);
		assertContainedCancellation(host, beforeCancel.runId, commandId);

		host.close();
		host = undefined;
		reopened = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider: opaqueRemote,
		});
		assertContainedCancellation(reopened, beforeCancel.runId, commandId);
	} finally {
		reopened?.close();
		host?.close();
		t.cleanup();
	}
});

test("C7: cancel-associated run cannot create an orphan approval or release its slot", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		const raw = createMockExecutionProvider({ outcome: "hang" });
		const opaqueRemote: ExecutionProvider = {
			name: "opaque-remote-park",
			probe: raw.probe?.bind(raw),
			prepare: raw.prepare?.bind(raw),
			submit: raw.submit.bind(raw),
			poll: raw.poll.bind(raw),
			cancel: raw.cancel.bind(raw),
			reconcile: raw.reconcile.bind(raw),
			isLive: raw.isLive?.bind(raw),
			loadHandle(handle) {
				const record = raw.loadHandle?.(handle);
				return record ? { ...record, providerName: "opaque-remote-park" } : null;
			},
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider: opaqueRemote,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});
		const admitted = await host.admitAndRun({
			program: {
				name: "opaque-cancel-park",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		const beforeCancel = host.getSnapshot(admitted.run!.runId)!.run;
		const commandId = "opaque-cancel-park-command";
		const cancelled = await host.cancel(beforeCancel.runId, {
			commandId,
			expectedRunVersion: beforeCancel.runVersion,
		});
		assert.equal(cancelled.ok, false, JSON.stringify(cancelled.error));
		assertContainedCancellation(host, beforeCancel.runId, commandId);

		const parked = await host.parkForApproval(beforeCancel.runId, {
			expectedRunVersion: cancelled.run!.runVersion,
		});
		assert.equal(parked.ok, false, JSON.stringify(parked.error));
		assert.equal(parked.error?.code, "TF_RECONCILE_REQUIRED");
		assertContainedCancellation(host, beforeCancel.runId, commandId);
		const approvalsDir = path.join(t.project, ".taskflow", "control", "approvals");
		assert.equal(fs.existsSync(approvalsDir), false, "denied park must not leave an orphan approval");
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("C7: cancellation after DispatchIntentRecorded suppresses a new provider submit", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		let submitCalls = 0;
		let submitSawDurableCancel = false;
		const opaqueRemote: ExecutionProvider = {
			name: "opaque-remote-intent-race",
			async submit() {
				submitCalls += 1;
				submitSawDurableCancel = Boolean(host?.store.listRuns()[0]?.cancelRequest);
				return { kind: "accepted", handle: "must-not-submit-after-cancel" };
			},
			async poll() {
				return { kind: "still-running" };
			},
			async cancel() {
				throw new Error("cancel must not reach a provider before a durable submit handle exists");
			},
			async reconcile() {
				return { kind: "ambiguous", reason: "no durable handle after cancellation" };
			},
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider: opaqueRemote,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});

		const originalCompareAndCommit = host.store.compareAndCommit.bind(host.store);
		let armed = true;
		let cancelPromise: ReturnType<typeof host.cancel> | undefined;
		host.store.compareAndCommit = (opts) => {
			const result = originalCompareAndCommit(opts);
			const continuation = host!.store.getContinuation(opts.runId);
			if (armed && result.ok && continuation?.activeAttempt?.state === "intent-recorded") {
				armed = false;
				queueMicrotask(() => {
					const current = host!.store.getRun(opts.runId);
					assert.ok(current, "intent must have a durable run before cancellation");
					cancelPromise = host!.cancel(current.runId, {
						commandId: "cancel-between-intent-and-submit",
						expectedRunVersion: current.runVersion,
					});
				});
			}
			return result;
		};

		const admission = await host.admitAndRun({
			program: {
				name: "cancel-between-intent-and-submit",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		assert.ok(cancelPromise, "fixture must schedule cancellation after durable dispatch intent");
		const cancelled = await cancelPromise;

		assert.equal(submitCalls, 0, "cancel that linearizes first must suppress provider.submit");
		assert.equal(submitSawDurableCancel, false, "provider must never observe a post-cancel submit call");
		assert.equal(cancelled.ok, false, JSON.stringify(cancelled.error));
		assert.equal(cancelled.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(admission.ok, false, JSON.stringify(admission.error));
		assert.equal(admission.error?.code, "TF_RECONCILE_REQUIRED");
		assertContainedCancellation(host, cancelled.run!.runId, "cancel-between-intent-and-submit");
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("C7: cancel before the scheduler window returns a reconcile snapshot, never a durability exception", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		const opaqueRemote: ExecutionProvider = {
			name: "opaque-remote-pre-scheduler-race",
			async submit() {
				throw new Error("scheduler must not submit after cancellation wins before execution");
			},
			async poll() {
				return { kind: "still-running" };
			},
			async cancel() {
				throw new Error("cancel must not reach a provider before a durable submit handle exists");
			},
			async reconcile() {
				return { kind: "ambiguous", reason: "no durable handle after cancellation" };
			},
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider: opaqueRemote,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});

		const originalCommitReservation = host.coordinator.commitReservation.bind(host.coordinator);
		let armed = true;
		let cancelPromise: ReturnType<typeof host.cancel> | undefined;
		host.coordinator.commitReservation = (reservationId, binding) => {
			const reservation = originalCommitReservation(reservationId, binding);
			if (armed) {
				armed = false;
				const current = host!.store.getRun(binding.runId);
				assert.ok(current, "reservation binding must follow the durable run admission");
				cancelPromise = host!.cancel(current.runId, {
					commandId: "cancel-before-scheduler-window",
					expectedRunVersion: current.runVersion,
				});
			}
			return reservation;
		};

		const admission = await host.admitAndRun({
			program: {
				name: "cancel-before-scheduler-window",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		assert.ok(cancelPromise, "fixture must cancel immediately after reservation binding");
		const cancelled = await cancelPromise;

		assert.equal(cancelled.ok, false, JSON.stringify(cancelled.error));
		assert.equal(cancelled.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(admission.ok, false, JSON.stringify(admission.error));
		assert.equal(admission.error?.code, "TF_RECONCILE_REQUIRED");
		assertContainedCancellation(host, cancelled.run!.runId, "cancel-before-scheduler-window");
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("C7: terminal collect transport failure becomes a durable reconcile snapshot", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	let reopened: ReturnType<typeof createControlHost> | undefined;
	try {
		let collectCalls = 0;
		let pollCalls = 0;
		let submitted: { runId: string; cwd: string; startedAt: number } | undefined;
		const opaqueRemote: ExecutionProvider = {
			name: "opaque-remote-collect-failure",
			async submit(req) {
				submitted = { runId: req.runId, cwd: req.cwd, startedAt: Date.now() };
				return { kind: "accepted", handle: "collect-failure-handle" };
			},
			async collect() {
				collectCalls += 1;
				throw new Error("remote collect socket reset");
			},
			async poll() {
				pollCalls += 1;
				throw new Error("scheduler must not silently fall back from collect to poll");
			},
			async cancel() {
				return { kind: "ambiguous" };
			},
			async reconcile() {
				return { kind: "ambiguous", reason: "remote state unobservable after collect transport fault" };
			},
			loadHandle(handle): ProviderJobHandle | null {
				if (!submitted || handle !== "collect-failure-handle") return null;
				return {
					handle,
					runId: submitted.runId,
					providerName: "opaque-remote-collect-failure",
					leaseEpoch: submitted.startedAt,
					cwd: submitted.cwd,
					startedAt: submitted.startedAt,
					status: "running",
				};
			},
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider: opaqueRemote,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});
		const result = await host.admitAndRun({
			program: {
				name: "collect-transport-failure",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});

		assert.equal(collectCalls, 1, "fixture must cross the collect boundary exactly once");
		assert.equal(pollCalls, 0, "collect transport failure must not become a hidden poll fallback");
		assert.equal(result.ok, false, JSON.stringify(result.error));
		assert.equal(result.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(result.run?.status, "unknown");
		assert.equal(result.run?.stage, "reconciling");
		assert.equal(result.run?.needsOperator, true);
		assert.ok(result.run?.reservationId, "observation fault must retain capacity");
		assert.notEqual(host.coordinator.getReservation(result.run!.reservationId!)?.state, "released");
		assert.equal(host.store.getReceiptForRun(result.run!.runId), null);

		const runId = result.run!.runId;
		host.close();
		host = undefined;
		reopened = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider: opaqueRemote,
		});
		const snapshot = reopened.getSnapshot(runId);
		assert.equal(snapshot?.run.status, "unknown");
		assert.equal(snapshot?.run.stage, "reconciling");
		assert.ok(snapshot?.run.reservationId, "reopen must retain the uncertain run slot");
		assert.equal(reopened.store.getReceiptForRun(runId), null);
	} finally {
		reopened?.close();
		host?.close();
		t.cleanup();
	}
});

test("C7: unrelated scheduler durability failure is not misreported as a cancellation race", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		let submitCalls = 0;
		const opaqueRemote: ExecutionProvider = {
			name: "opaque-remote-durability-failure",
			async submit() {
				submitCalls += 1;
				return { kind: "accepted", handle: "must-not-submit-after-durability-failure" };
			},
			async poll() {
				return { kind: "still-running" };
			},
			async cancel() {
				return { kind: "ambiguous" };
			},
			async reconcile() {
				return { kind: "ambiguous", reason: "not reached" };
			},
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider: opaqueRemote,
		});
		const originalCompareAndCommit = host.store.compareAndCommit.bind(host.store);
		let armed = true;
		host.store.compareAndCommit = (opts) => {
			if (armed) {
				armed = false;
				throw new ControlStoreDurabilityError("injected unrelated journal I/O failure");
			}
			return originalCompareAndCommit(opts);
		};

		const result = await host.admitAndRun({
			program: {
				name: "unrelated-durability-failure",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});

		assert.equal(submitCalls, 0, "durability failure before submit must not create a provider side effect");
		assert.equal(result.ok, false, JSON.stringify(result.error));
		assert.equal(result.error?.code, "TF_DURABILITY_FAILED");
		assert.equal(result.error?.recoveryAction, "operator");
		assert.equal(result.error?.sideEffects, "unknown");
		assert.equal(result.run?.stage, "executing");
		assert.ok(result.run?.reservationId, "durability failure must retain capacity");
		assert.notEqual(host.coordinator.getReservation(result.run!.reservationId!)?.state, "released");
		assert.equal(host.store.getReceiptForRun(result.run!.runId), null);
	} finally {
		host?.close();
		t.cleanup();
	}
});
