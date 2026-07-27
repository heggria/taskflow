/**
 * P13/C4 cancellation authority-loss boundaries.
 *
 * These tests deliberately exercise an injected singleton-style mutation
 * fence. They prove the ControlHost response and durable state at each
 * boundary; they do not claim a production stale-takeover implementation.
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
	SingletonAuthorityError,
	type ControlHost,
} from "../src/index.ts";

function temp(): { env: NodeJS.ProcessEnv; project: string; home: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-cancel-authority-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-cancel-authority-project-"));
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

function liveScriptProgram(marker: string): Record<string, unknown> {
	return {
		name: "cancel-authority-live-script",
		phases: [
			{
				id: "main",
				type: "script",
				run: [
					process.execPath,
					"-e",
					`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "live\\n"); setInterval(() => {}, 1_000);`,
				],
				final: true,
			},
		],
	};
}

function installCancelCommitHook(
	host: ControlHost,
	opts: {
		before?: (context: {
			call: number;
			request: Parameters<ControlHost["store"]["compareAndCommit"]>[0];
		}) => void;
		after?: (context: {
			call: number;
			result: ReturnType<ControlHost["store"]["compareAndCommit"]>;
		}) => void;
	},
): () => number {
	type MutableStore = {
		compareAndCommit: ControlHost["store"]["compareAndCommit"];
	};
	type CompareAndCommitRequest = Parameters<ControlHost["store"]["compareAndCommit"]>[0];
	type CompareAndCommitResult = ReturnType<ControlHost["store"]["compareAndCommit"]>;
	const mutableStore = host.store as unknown as MutableStore;
	const original = host.store.compareAndCommit.bind(host.store);
	let calls = 0;
	mutableStore.compareAndCommit = (request: CompareAndCommitRequest): CompareAndCommitResult => {
		calls += 1;
		opts.before?.({ call: calls, request });
		const result = original(request);
		opts.after?.({ call: calls, result });
		return result;
	};
	return () => calls;
}

function assertHeldNonterminalCancel(host: ControlHost, runId: string, commandId: string): void {
	const current = host.getSnapshot(runId)?.run;
	assert.ok(current, "cancelled fixture run must remain readable");
	assert.equal(current.status, "unknown");
	assert.equal(current.stage, "reconciling");
	assert.equal(current.cancelRequest?.commandId, commandId);
	assert.ok(current.reservationId, "nonterminal cancel must retain its capacity reservation");
	assert.notEqual(host.coordinator.getReservation(current.reservationId!)?.state, "released");
	assert.equal(host.store.getReceiptForRun(runId), null);
}

test("C4-0: authority loss before CancelRequested commit never accepts or signals the command", async () => {
	const t = temp();
	let host: ControlHost | undefined;
	try {
		let authoritative = true;
		const provider = createMockExecutionProvider({ outcome: "hang" });
		const originalCancel = provider.cancel.bind(provider);
		let providerCancelCalls = 0;
		provider.cancel = async (providerHandle, options) => {
			providerCancelCalls += 1;
			return originalCancel(providerHandle, options);
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			mutationAuthority: () => authoritative,
			mutationFence: <T>(fn: () => T): T => {
				if (!authoritative) throw new SingletonAuthorityError("C4-0 simulated takeover");
				return fn();
			},
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});
		const admitted = await host.admitAndRun({
			program: { name: "c4-before-request", phases: [{ id: "main", type: "script", run: "true", final: true }] },
		});
		const run = host.getSnapshot(admitted.run!.runId)!.run;
		const commandId = "c4-before-request";
		const cancelCalls = installCancelCommitHook(host, {
			before: ({ request }) => {
				if (request.expectedRunVersion === run.runVersion) authoritative = false;
			},
		});

		const result = await host.cancel(run.runId, {
			commandId,
			expectedRunVersion: run.runVersion,
		});

		assert.equal(cancelCalls(), 1);
		assert.equal(result.ok, false, JSON.stringify(result.error));
		assert.equal(result.error?.code, "TF_AUTHORITY_REVOKED");
		assert.equal(result.error?.recoveryAction, "retry-same-command");
		assert.equal(result.error?.sideEffects, "none");
		assert.equal(result.run?.cancelRequest, undefined, "fenced request write must not claim command ownership");
		assert.equal(host.store.getCommand(commandId), null, "failed request write must not publish a command");
		assert.equal(providerCancelCalls, 0, "failed request write must not reach the provider");
		assert.ok(result.run?.reservationId, "existing run remains capacity-accounted");
		assert.notEqual(host.coordinator.getReservation(result.run!.reservationId!)?.state, "released");
		assert.equal(host.store.getReceiptForRun(run.runId), null);
	} finally {
		host?.close();
		t.cleanup();
	}
});

test(
	"C4a: authority loss after CancelRequested fails closed before the first provider signal",
	{ skip: process.platform === "win32" },
	async () => {
		const t = temp();
		let host: ControlHost | undefined;
		let provider: ReturnType<typeof createScriptExecutionProvider> | undefined;
		let handle: string | undefined;
		try {
			let authoritative = true;
			provider = createScriptExecutionProvider({
				stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs"),
			});
			const originalCancel = provider.cancel.bind(provider);
			let providerCancelCalls = 0;
			provider.cancel = async (providerHandle, options) => {
				providerCancelCalls += 1;
				return originalCancel(providerHandle, options);
			};
			host = createControlHost({
				projectRoot: t.project,
				env: t.env,
				controlMode: "standalone",
				skipSingleton: true,
				mutationAuthority: () => authoritative,
				mutationFence: <T>(fn: () => T): T => {
					if (!authoritative) {
						throw new SingletonAuthorityError("C4a simulated takeover after CancelRequested");
					}
					return fn();
				},
				scriptProvider: provider,
			});
			const marker = path.join(t.project, "c4a-live.marker");
			const admitted = await host.admitAndRun({ program: liveScriptProgram(marker) });
			const run = host.getSnapshot(admitted.run!.runId)!.run;
			handle = run.providerHandle;
			assert.ok(handle, "fixture requires a durable Script handle");
			assert.equal(fs.readFileSync(marker, "utf8"), "live\n");

			const cancelCalls = installCancelCommitHook(host, {
				after: ({ result }) => {
					if (result.ok && result.run.cancelRequest?.state === "requested") authoritative = false;
				},
			});
			const commandId = "c4a-after-request";
			const result = await host.cancel(run.runId, {
				commandId,
				expectedRunVersion: run.runVersion,
			});

			assert.equal(cancelCalls(), 2, "C4a must attempt the durable signalling transition");
			assert.equal(result.ok, false, JSON.stringify(result.error));
			assert.equal(result.error?.code, "TF_AUTHORITY_REVOKED");
			assert.equal(result.error?.recoveryAction, "reconcile");
			assert.equal(result.error?.sideEffects, "none");
			assert.equal(providerCancelCalls, 0, "authority loss before signalling must not reach the provider");
			assert.equal(provider.isLive?.(handle), true, "the real Script must remain live");
			assertHeldNonterminalCancel(host, run.runId, commandId);
			assert.equal(host.getSnapshot(run.runId)?.run.cancelRequest?.state, "requested");
		} finally {
			host?.close();
			if (provider && handle) {
				const durable = provider.loadHandle?.(handle);
				if (durable?.pid) {
					try {
						process.kill(-durable.pid, "SIGKILL");
					} catch {
						/* fixture process already stopped */
					}
				}
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 40));
			t.cleanup();
		}
	},
);

test(
	"C4b: authority loss after signalling intent suppresses the provider call",
	{ skip: process.platform === "win32" },
	async () => {
		const t = temp();
		let host: ControlHost | undefined;
		let provider: ReturnType<typeof createScriptExecutionProvider> | undefined;
		let handle: string | undefined;
		try {
			let authoritative = true;
			provider = createScriptExecutionProvider({
				stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs"),
			});
			const originalCancel = provider.cancel.bind(provider);
			let providerCancelCalls = 0;
			provider.cancel = async (providerHandle, options) => {
				providerCancelCalls += 1;
				return originalCancel(providerHandle, options);
			};
			host = createControlHost({
				projectRoot: t.project,
				env: t.env,
				controlMode: "standalone",
				skipSingleton: true,
				mutationAuthority: () => authoritative,
				mutationFence: <T>(fn: () => T): T => {
					if (!authoritative) throw new SingletonAuthorityError("C4b simulated takeover");
					return fn();
				},
				scriptProvider: provider,
			});
			const marker = path.join(t.project, "c4b-live.marker");
			const admitted = await host.admitAndRun({ program: liveScriptProgram(marker) });
			const run = host.getSnapshot(admitted.run!.runId)!.run;
			handle = run.providerHandle;
			assert.ok(handle, "fixture requires a durable Script handle");

			const cancelCalls = installCancelCommitHook(host, {
				after: ({ result }) => {
					if (result.ok && result.run.cancelRequest?.state === "signalling") authoritative = false;
				},
			});
			const commandId = "c4b-after-signalling";
			const result = await host.cancel(run.runId, {
				commandId,
				expectedRunVersion: run.runVersion,
			});

			assert.equal(cancelCalls(), 2);
			assert.equal(result.ok, false, JSON.stringify(result.error));
			assert.equal(result.error?.code, "TF_AUTHORITY_REVOKED");
			assert.equal(result.error?.recoveryAction, "reconcile");
			assert.equal(result.error?.sideEffects, "none");
			assert.equal(providerCancelCalls, 0, "post-intent authority loss must suppress the provider call");
			assert.equal(provider.isLive?.(handle), true, "the real Script must remain live");
			assertHeldNonterminalCancel(host, run.runId, commandId);
			assert.equal(host.getSnapshot(run.runId)?.run.cancelRequest?.state, "signalling");
		} finally {
			host?.close();
			if (provider && handle) {
				const durable = provider.loadHandle?.(handle);
				if (durable?.pid) {
					try {
						process.kill(-durable.pid, "SIGKILL");
					} catch {
						/* fixture process already stopped */
					}
				}
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 40));
			t.cleanup();
		}
	},
);

test(
	"C4c: authority loss after a fenced real Script signal never terminalizes or releases",
	{ skip: process.platform === "win32" },
	async () => {
		const t = temp();
		let host: ControlHost | undefined;
		let provider: ReturnType<typeof createScriptExecutionProvider> | undefined;
		let handle: string | undefined;
		try {
			let authoritative = true;
			let armProviderFence = false;
			let providerFenceCompleted = false;
			provider = createScriptExecutionProvider({
				stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs"),
			});
			const originalCancel = provider.cancel.bind(provider);
			let providerCancelCalls = 0;
			provider.cancel = async (providerHandle, options) => {
				providerCancelCalls += 1;
				return originalCancel(providerHandle, options);
			};
			host = createControlHost({
				projectRoot: t.project,
				env: t.env,
				controlMode: "standalone",
				skipSingleton: true,
				mutationAuthority: () => authoritative,
				mutationFence: <T>(fn: () => T): T => {
					if (!authoritative) throw new SingletonAuthorityError("C4c simulated takeover");
					if (armProviderFence && !providerFenceCompleted) {
						const result = fn();
						providerFenceCompleted = true;
						authoritative = false;
						return result;
					}
					return fn();
				},
				scriptProvider: provider,
			});
			const marker = path.join(t.project, "c4c-live.marker");
			const admitted = await host.admitAndRun({ program: liveScriptProgram(marker) });
			const run = host.getSnapshot(admitted.run!.runId)!.run;
			handle = run.providerHandle;
			assert.ok(handle, "fixture requires a durable Script handle");

			const cancelCalls = installCancelCommitHook(host, {
				after: ({ result }) => {
					if (result.ok && result.run.cancelRequest?.state === "signalling") {
						armProviderFence = true;
					}
				},
			});
			const commandId = "c4c-after-fenced-signal";
			const result = await host.cancel(run.runId, {
				commandId,
				expectedRunVersion: run.runVersion,
			});

			assert.equal(cancelCalls(), 2);
			assert.equal(providerFenceCompleted, true, "fixture must revoke only after Script signal critical section");
			assert.equal(providerCancelCalls, 1, "the fenced Script signal must be attempted exactly once");
			assert.equal(result.ok, false, JSON.stringify(result.error));
			assert.equal(result.error?.code, "TF_AUTHORITY_REVOKED");
			assert.equal(result.error?.recoveryAction, "reconcile");
			assert.equal(result.error?.sideEffects, "possible");
			assertHeldNonterminalCancel(host, run.runId, commandId);
			assert.equal(host.getSnapshot(run.runId)?.run.cancelRequest?.state, "signalling");
		} finally {
			host?.close();
			if (provider && handle) {
				const durable = provider.loadHandle?.(handle);
				if (durable?.pid) {
					try {
						process.kill(-durable.pid, "SIGKILL");
					} catch {
						/* fixture process already stopped */
					}
				}
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 40));
			t.cleanup();
		}
	},
);

test("C4c-ambiguous: authority loss while persisting an ambiguous provider result stays an authority error", async () => {
	const t = temp();
	let host: ControlHost | undefined;
	try {
		let authoritative = true;
		const provider = createMockExecutionProvider({ outcome: "hang" });
		let providerCancelCalls = 0;
		provider.cancel = async () => {
			providerCancelCalls += 1;
			return { kind: "ambiguous" };
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			mutationAuthority: () => authoritative,
			mutationFence: <T>(fn: () => T): T => {
				if (!authoritative) throw new SingletonAuthorityError("C4c ambiguous-state simulated takeover");
				return fn();
			},
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});
		const admitted = await host.admitAndRun({
			program: { name: "c4c-ambiguous-provider", phases: [{ id: "main", type: "script", run: "true", final: true }] },
		});
		const run = host.getSnapshot(admitted.run!.runId)!.run;
		let signallingRunVersion: number | undefined;
		const cancelCalls = installCancelCommitHook(host, {
			before: ({ request }) => {
				if (request.expectedRunVersion === signallingRunVersion) authoritative = false;
			},
			after: ({ result }) => {
				if (result.ok && result.run.cancelRequest?.state === "signalling") {
					signallingRunVersion = result.run.runVersion;
				}
			},
		});
		const commandId = "c4c-ambiguous-persist";
		const result = await host.cancel(run.runId, {
			commandId,
			expectedRunVersion: run.runVersion,
		});

		assert.equal(cancelCalls(), 3, "fixture must lose authority at the ambiguity persistence write");
		assert.equal(providerCancelCalls, 1);
		assert.equal(result.ok, false, JSON.stringify(result.error));
		assert.equal(result.error?.code, "TF_AUTHORITY_REVOKED");
		assert.equal(result.error?.recoveryAction, "reconcile");
		assert.equal(result.error?.sideEffects, "possible");
		assertHeldNonterminalCancel(host, run.runId, commandId);
		assert.equal(host.getSnapshot(run.runId)?.run.cancelRequest?.state, "signalling");
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("C4c-observe: a quiescence-observation fault after provider cancel stays ambiguous", async () => {
	const t = temp();
	let host: ControlHost | undefined;
	try {
		const provider = createMockExecutionProvider({ outcome: "hang" });
		const originalCancel = provider.cancel.bind(provider);
		const originalIsLive = provider.isLive!.bind(provider);
		let providerCancelCalls = 0;
		let throwObservation = false;
		provider.cancel = async (providerHandle, options) => {
			providerCancelCalls += 1;
			const result = await originalCancel(providerHandle, options);
			throwObservation = true;
			return result;
		};
		provider.isLive = (providerHandle) => {
			if (throwObservation) throw new Error("C4c injected provider liveness read failure");
			return originalIsLive(providerHandle);
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});
		const admitted = await host.admitAndRun({
			program: { name: "c4c-observe-provider", phases: [{ id: "main", type: "script", run: "true", final: true }] },
		});
		const run = host.getSnapshot(admitted.run!.runId)!.run;
		const commandId = "c4c-observe-fault";

		const result = await host.cancel(run.runId, {
			commandId,
			expectedRunVersion: run.runVersion,
		});

		assert.equal(providerCancelCalls, 1, "provider cancellation happened before the observation fault");
		assert.equal(result.ok, false, JSON.stringify(result.error));
		assert.equal(result.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(result.error?.recoveryAction, "reconcile");
		assert.equal(result.error?.sideEffects, "possible");
		assertHeldNonterminalCancel(host, run.runId, commandId);
		assert.equal(host.getSnapshot(run.runId)?.run.cancelRequest?.state, "ambiguous");
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("C4c-observe-store: a ControlStore observation fault after provider cancel stays ambiguous", async () => {
	const t = temp();
	let host: ControlHost | undefined;
	try {
		const provider = createMockExecutionProvider({ outcome: "hang" });
		const originalCancel = provider.cancel.bind(provider);
		let providerCancelCalls = 0;
		let throwRunRead = false;
		provider.cancel = async (providerHandle, options) => {
			providerCancelCalls += 1;
			const result = await originalCancel(providerHandle, options);
			throwRunRead = true;
			return result;
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});
		const admitted = await host.admitAndRun({
			program: { name: "c4c-observe-store", phases: [{ id: "main", type: "script", run: "true", final: true }] },
		});
		const run = host.getSnapshot(admitted.run!.runId)!.run;
		type MutableStore = { getRun: ControlHost["store"]["getRun"] };
		const mutableStore = host.store as unknown as MutableStore;
		const originalGetRun = host.store.getRun.bind(host.store);
		mutableStore.getRun = (runId) => {
			if (throwRunRead) throw new Error("C4c injected ControlStore read failure after provider cancel");
			return originalGetRun(runId);
		};
		const commandId = "c4c-observe-store-fault";

		const result = await host.cancel(run.runId, {
			commandId,
			expectedRunVersion: run.runVersion,
		});
		throwRunRead = false;

		assert.equal(providerCancelCalls, 1, "provider cancellation happened before the observation fault");
		assert.equal(result.ok, false, JSON.stringify(result.error));
		assert.equal(result.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(result.error?.recoveryAction, "reconcile");
		assert.equal(result.error?.sideEffects, "possible");
		assertHeldNonterminalCancel(host, run.runId, commandId);
		assert.equal(host.getSnapshot(run.runId)?.run.cancelRequest?.state, "ambiguous");
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("C4d: authority loss before post-signal ambiguity commit never returns a terminal cancel", async () => {
	const t = temp();
	let host: ControlHost | undefined;
	try {
		let authoritative = true;
		const provider = createMockExecutionProvider({ outcome: "hang" });
		const originalCancel = provider.cancel.bind(provider);
		let providerCancelCalls = 0;
		provider.cancel = async (providerHandle, options) => {
			providerCancelCalls += 1;
			return originalCancel(providerHandle, options);
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			mutationAuthority: () => authoritative,
			mutationFence: <T>(fn: () => T): T => {
				if (!authoritative) throw new SingletonAuthorityError("C4d simulated takeover");
				return fn();
			},
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});
		const admitted = await host.admitAndRun({
			program: { name: "c4d-terminal-provider", phases: [{ id: "main", type: "script", run: "true", final: true }] },
		});
		const run = host.getSnapshot(admitted.run!.runId)!.run;
		assert.ok(run.providerHandle, "fixture requires a durable provider handle");

		let signallingRunVersion: number | undefined;
		const cancelCalls = installCancelCommitHook(host, {
			before: ({ request }) => {
				if (request.expectedRunVersion === signallingRunVersion) authoritative = false;
			},
			after: ({ result }) => {
				if (result.ok && result.run.cancelRequest?.state === "signalling") {
					signallingRunVersion = result.run.runVersion;
				}
			},
		});
		const commandId = "c4d-before-settlement";
		const result = await host.cancel(run.runId, {
			commandId,
			expectedRunVersion: run.runVersion,
		});

		assert.equal(cancelCalls(), 3, "C4d must reach the post-signal ambiguity write");
		assert.equal(providerCancelCalls, 1, "provider cancellation must have occurred before ambiguity race");
		assert.equal(result.ok, false, JSON.stringify(result.error));
		assert.equal(result.error?.code, "TF_AUTHORITY_REVOKED");
		assert.equal(result.error?.recoveryAction, "reconcile");
		assert.equal(result.error?.sideEffects, "possible");
		assertHeldNonterminalCancel(host, run.runId, commandId);
		assert.equal(host.getSnapshot(run.runId)?.run.cancelRequest?.state, "signalling");
	} finally {
		host?.close();
		t.cleanup();
	}
});
