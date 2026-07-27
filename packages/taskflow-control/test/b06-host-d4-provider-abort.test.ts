/**
 * B06 D4: host-llm provider cancel must wire AbortSignal and stay non-quiescent
 * until the in-flight runTask promise is provably finished.
 *
 * Waits are event-driven (promise gates + scheduler yield), not fixed wall-clock
 * sleep counts used to win a race.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	createControlHost,
	createHostLlmExecutionProvider,
} from "../src/index.ts";

function temp(): { env: NodeJS.ProcessEnv; project: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-d4-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-d4-project-"));
	return {
		env: { ...process.env, TASKFLOW_HOME: home },
		project,
		cleanup: () => {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(project, { recursive: true, force: true });
		},
	};
}

const YIELD = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/** Yield the event loop / OS scheduler until predicate holds or deadline. */
async function waitUntil(pred: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!pred()) {
		if (Date.now() > deadline) {
			throw new Error(`timeout waiting for ${label}`);
		}
		// Microtask drain + brief scheduler yield (not a race-winning fixed sleep).
		await Promise.resolve();
		Atomics.wait(YIELD, 0, 0, 1);
	}
}

test("D4: cancel wires AbortSignal and isLive stays true while runTask ignores abort", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	let releaseTask: (() => void) | undefined;
	const taskGate = new Promise<void>((resolve) => {
		releaseTask = resolve;
	});
	let sawAbortSignal = false;
	let abortFired = false;
	let taskFinished = false;
	/** Resolves when runTask has entered (handle journaled soon after). */
	let enteredRunTask: (() => void) | undefined;
	const runTaskEntered = new Promise<void>((r) => {
		enteredRunTask = r;
	});

	try {
		const llm = createHostLlmExecutionProvider({
			runTask: async (req) => {
				sawAbortSignal = req.signal instanceof AbortSignal;
				if (req.signal) {
					req.signal.addEventListener("abort", () => {
						abortFired = true;
					});
				}
				enteredRunTask?.();
				// Deliberately ignore abort — side effects stay live.
				await taskGate;
				taskFinished = true;
				return { ok: true, output: "late-output" };
			},
		});

		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			llmProvider: llm,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
			phaseDeadlineMs: 5_000,
		});

		const admission = host.admitAndRun({
			program: {
				name: "d4-host-llm-abort",
				phases: [
					{
						id: "agent",
						type: "agent",
						agent: "executor",
						task: "long work",
						final: true,
					},
				],
			},
		});

		await runTaskEntered;
		await waitUntil(
			() => Boolean(host!.store.listRuns()[0]?.providerHandle),
			"durable host-llm handle",
		);
		const handle = host.store.listRuns()[0]!.providerHandle!;
		assert.equal(llm.isLive?.(handle), true, "in-flight task must be live before cancel");

		const run = host.store.listRuns()[0]!;
		const cancelled = await host.cancel(run.runId, {
			commandId: "d4-cancel-inflight",
			expectedRunVersion: run.runVersion,
		});

		assert.equal(sawAbortSignal, true, "runTask must receive AbortSignal");
		assert.equal(abortFired, true, "cancel must abort the signal");
		assert.equal(
			llm.isLive?.(handle),
			true,
			"isLive must remain true while runTask promise is still in-flight",
		);
		assert.equal(taskFinished, false, "fixture must still be in-flight");
		assert.equal(cancelled.ok, false, JSON.stringify(cancelled.error));
		// Capacity must not be released while side effects are live.
		assert.ok(cancelled.run?.reservationId ?? run.reservationId);
		const resId = cancelled.run?.reservationId ?? run.reservationId!;
		assert.notEqual(host.coordinator.getReservation(resId)?.state, "released");

		releaseTask?.();
		await admission.catch(() => undefined);
		await waitUntil(() => taskFinished && llm.isLive?.(handle) === false, "task settle + isLive false");
		assert.equal(taskFinished, true);
		assert.equal(llm.isLive?.(handle), false);
	} finally {
		releaseTask?.();
		host?.close();
		t.cleanup();
	}
});

test("D4: cancel that settles with abort reports non-live only after promise finishes", async () => {
	const t = temp();
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		let resolveInner: (() => void) | undefined;
		const inner = new Promise<void>((r) => {
			resolveInner = r;
		});
		let enteredRunTask: (() => void) | undefined;
		const runTaskEntered = new Promise<void>((r) => {
			enteredRunTask = r;
		});
		const llm = createHostLlmExecutionProvider({
			runTask: async (req) => {
				enteredRunTask?.();
				await new Promise<void>((resolve, reject) => {
					const onAbort = () => {
						// Cooperative abort path.
						reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
					};
					if (req.signal?.aborted) {
						onAbort();
						return;
					}
					req.signal?.addEventListener("abort", onAbort, { once: true });
					void inner.then(() => {
						req.signal?.removeEventListener("abort", onAbort);
						resolve();
					});
				});
				return { ok: true, output: "should-not" };
			},
		});
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			llmProvider: llm,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
			phaseDeadlineMs: 5_000,
		});
		const p = host.admitAndRun({
			program: {
				name: "d4-coop-abort",
				phases: [{ id: "a", type: "agent", agent: "x", task: "t", final: true }],
			},
		});
		await runTaskEntered;
		await waitUntil(
			() => Boolean(host!.store.listRuns()[0]?.providerHandle),
			"durable host-llm handle (coop)",
		);
		const handle = host.store.listRuns()[0]!.providerHandle!;
		const run = host.store.listRuns()[0]!;
		await host.cancel(run.runId, {
			commandId: "d4-coop",
			expectedRunVersion: run.runVersion,
		});
		await waitUntil(() => llm.isLive?.(handle) === false, "cooperative abort settle");
		assert.equal(llm.isLive?.(handle), false, "cooperative abort must settle in-flight work");
		resolveInner?.();
		await p.catch(() => undefined);
	} finally {
		host?.close();
		t.cleanup();
	}
});
