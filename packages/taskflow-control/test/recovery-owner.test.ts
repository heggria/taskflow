/**
 * P13 restart recovery owner: a real previous singleton writer dies after a
 * Script provider spawn but before DispatchAcknowledged. Automatic singleton
 * stale takeover is deliberately unavailable without a safe replacement
 * primitive, so each test first proves auto bootstrap fails closed. A separate
 * test-authorized actor then exercises the narrow recovery state machine: it
 * may locate/reconcile the exact durable idempotency handle, but must never
 * submit a replacement side effect or issue a Receipt.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	createControlHost,
	createScriptExecutionProvider,
	lookupDurableDispatchForRecovery,
	type ExecutionProvider,
	type ProviderSubmitRequest,
} from "../src/index.ts";

const helpersDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers");

function waitForFile(
	filePath: string,
	opts: {
		child?: ChildProcess;
		diagnostics?: () => string;
		timeoutMs?: number;
	} = {},
): Promise<void> {
	const timeoutMs = opts.timeoutMs ?? 30_000;
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			opts.child?.off("close", onClose);
			opts.child?.off("error", onError);
			if (error) reject(error);
			else resolve();
		};
		const diagnosticSuffix = () => {
			const details = opts.diagnostics?.().trim();
			return details ? `\nchild output:\n${details}` : "";
		};
		const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
			finish(
				new Error(
					`child exited before publishing ${filePath}: code=${code ?? "null"} signal=${signal ?? "none"}${diagnosticSuffix()}`,
				),
			);
		};
		const onError = (error: Error) => {
			finish(new Error(`child failed before publishing ${filePath}: ${error.message}${diagnosticSuffix()}`));
		};
		const check = () => {
			if (fs.existsSync(filePath)) {
				finish();
				return;
			}
			if (Date.now() >= deadline) {
				finish(
					new Error(
						`timed out after ${timeoutMs}ms waiting for ${filePath}${diagnosticSuffix()}`,
					),
				);
				return;
			}
			timer = setTimeout(check, 10);
		};
		const deadline = Date.now() + timeoutMs;
		opts.child?.once("close", onClose);
		opts.child?.once("error", onError);
		check();
	});
}

function waitForChild(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve) => {
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
}

function assertDurabilityFailure(error: unknown): boolean {
	assert.equal((error as { code?: string }).code, "TF_DURABILITY_FAILED", String(error));
	return true;
}

function tempFixture(): { home: string; project: string; barrier: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-recovery-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-recovery-project-"));
	const barrier = fs.mkdtempSync(path.join(os.tmpdir(), "tf-recovery-barrier-"));
	return {
		home,
		project,
		barrier,
		cleanup: () => {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(project, { recursive: true, force: true });
			fs.rmSync(barrier, { recursive: true, force: true });
		},
	};
}

test("P13: provider without durable lookup is a fail-closed recovery boundary", async () => {
	let submitCalls = 0;
	const opaqueProvider: ExecutionProvider = {
		name: "opaque-remote",
		async submit() {
			submitCalls += 1;
			return { kind: "accepted", handle: "must-not-submit" };
		},
		async poll() {
			return { kind: "still-running" };
		},
		async cancel() {
			return { kind: "ambiguous" };
		},
		async reconcile() {
			return { kind: "ambiguous", reason: "opaque provider cannot prove state" };
		},
	};
	const result = await lookupDurableDispatchForRecovery(
		{
			name: "opaque-recovery",
			phases: [{ id: "side-effect", type: "script", run: "true", final: true }],
		},
		{ script: opaqueProvider },
		{
			runId: "run-opaque-recovery",
			cwd: process.cwd(),
			continuation: {
				phaseOutputs: {},
				nextPhaseId: "side-effect",
				activeAttempt: {
					attemptId: "attempt-opaque-recovery",
					phaseId: "side-effect",
					type: "script",
					idempotencyKey: "opaque-stable-idempotency-key",
					providerName: "opaque-remote",
					state: "intent-recorded",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			},
		},
	);
	assert.equal(result.kind, "unsupported", JSON.stringify(result));
	assert.equal(submitCalls, 0, "recovery must not turn a missing lookup into a submit");
});

test("P13: auto recovery fails closed before Script fence; an authorized recovery actor does not replay", async () => {
	const t = tempFixture();
	const marker = path.join(t.project, "must-not-exist.marker");
	let oldWriter: ChildProcess | undefined;
	let newHost: ReturnType<typeof createControlHost> | undefined;
	try {
		const helper = path.join(helpersDir, "mp-pre-fence-crash.mts");
		let childOutput = "";
		oldWriter = spawn(
			process.execPath,
			[
				"--conditions=development",
				"--experimental-strip-types",
				helper,
				t.project,
				t.home,
				t.barrier,
				marker,
			],
			{ env: { ...process.env, PI_TASKFLOW_BUILTIN_AGENTS_DIR: "" }, stdio: ["ignore", "pipe", "pipe"] },
		);
		oldWriter.stdout?.setEncoding("utf8");
		oldWriter.stdout?.on("data", (chunk: string) => {
			childOutput += chunk;
		});
		oldWriter.stderr?.setEncoding("utf8");
		oldWriter.stderr?.on("data", (chunk: string) => {
			childOutput += chunk;
		});
		await waitForFile(path.join(t.barrier, "provider-submit-entered.json"), {
			child: oldWriter,
			diagnostics: () => childOutput,
		});
		assert.equal(fs.existsSync(marker), false, "old writer has not entered Script provider fence");

		oldWriter.kill("SIGKILL");
		const oldExit = await waitForChild(oldWriter);
		assert.equal(oldExit.signal, "SIGKILL");

		let lookupCalls = 0;
		let submitCalls = 0;
		const real = createScriptExecutionProvider({
			stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs"),
		});
		const observedProvider: ExecutionProvider = {
			name: real.name,
			probe: real.probe?.bind(real),
			prepare: real.prepare?.bind(real),
			collect: real.collect?.bind(real),
			watch: real.watch?.bind(real),
			poll: real.poll.bind(real),
			cancel: real.cancel.bind(real),
			reconcile: real.reconcile.bind(real),
			isLive: real.isLive?.bind(real),
			loadHandle: real.loadHandle?.bind(real),
			quiesceAll: real.quiesceAll?.bind(real),
			async submit(req: ProviderSubmitRequest) {
				submitCalls += 1;
				return real.submit(req);
			},
			async lookupByIdempotency(req) {
				lookupCalls += 1;
				return real.lookupByIdempotency!(req);
			},
		};
		assert.throws(
			() =>
				createControlHost({
					projectRoot: t.project,
					env: { ...process.env, TASKFLOW_HOME: t.home },
					controlMode: "auto",
					scriptProvider: observedProvider,
				}),
			assertDurabilityFailure,
			"a dead singleton pathname is not automatic takeover authority",
		);
		newHost = createControlHost({
			projectRoot: t.project,
			env: { ...process.env, TASKFLOW_HOME: t.home },
			controlMode: "auto",
			skipSingleton: true,
			scriptProvider: observedProvider,
		});
		assert.equal(newHost.role, "writer", "test-authorized recovery actor is not auto bootstrap");
		const run = newHost.store.listRuns()[0]!;
		const recovered = await newHost.reconcilePendingDispatch(run.runId, {
			commandId: "recover-pre-fence-command",
		});
		assert.equal(recovered.ok, false);
		assert.equal(recovered.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(lookupCalls, 1, "new writer must make an authoritative negative lookup");
		assert.equal(submitCalls, 0, "negative lookup is not permission for automatic replay");
		assert.equal(fs.existsSync(marker), false, "no Script marker may be created by recovery");
		const continuation = newHost.store.getContinuation(run.runId);
		assert.equal(continuation?.activeAttempt?.state, "intent-recorded");
		assert.equal(continuation?.activeAttempt?.providerHandle, undefined);
		assert.equal(newHost.store.getReceiptForRun(run.runId), null);
	} finally {
		newHost?.close();
		if (oldWriter && oldWriter.exitCode === null && oldWriter.signalCode === null) {
			try {
				oldWriter.kill("SIGKILL");
			} catch {
				/* best-effort fixture cleanup */
			}
		}
		t.cleanup();
	}
});

test("P13: auto recovery fails closed after Script spawn; an authorized recovery actor reconciles the exact handle", async () => {
	const t = tempFixture();
	const marker = path.join(t.project, "side-effect.marker");
	let oldWriter: ChildProcess | undefined;
	let newHost: ReturnType<typeof createControlHost> | undefined;
	try {
		const helper = path.join(helpersDir, "mp-post-spawn-lost-ack.mts");
		oldWriter = spawn(
			process.execPath,
			[
				"--conditions=development",
				"--experimental-strip-types",
				helper,
				t.project,
				t.home,
				t.barrier,
				marker,
			],
			{ env: { ...process.env, PI_TASKFLOW_BUILTIN_AGENTS_DIR: "" }, stdio: ["ignore", "pipe", "pipe"] },
		);
		let stderr = "";
		oldWriter.stderr?.setEncoding("utf8");
		oldWriter.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});

		await waitForFile(path.join(t.barrier, "provider-accepted.json"));
		await waitForFile(marker);
		const accepted = JSON.parse(
			fs.readFileSync(path.join(t.barrier, "provider-accepted.json"), "utf8"),
		) as { kind: string; handle: string | null };
		assert.equal(accepted.kind, "accepted", `old writer submit failed: ${stderr}`);
		assert.ok(accepted.handle, "real provider must expose a durable handle before crash");

		oldWriter.kill("SIGKILL");
		const oldExit = await waitForChild(oldWriter);
		assert.equal(oldExit.signal, "SIGKILL", `old writer did not die in crash window: ${stderr}`);

		let lookupCalls = 0;
		let reconcileCalls = 0;
		let submitCalls = 0;
		const real = createScriptExecutionProvider({
			stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs"),
		});
		const observedProvider: ExecutionProvider = {
			name: real.name,
			probe: real.probe?.bind(real),
			prepare: real.prepare?.bind(real),
			collect: real.collect?.bind(real),
			watch: real.watch?.bind(real),
			poll: real.poll.bind(real),
			cancel: real.cancel.bind(real),
			isLive: real.isLive?.bind(real),
			loadHandle: real.loadHandle?.bind(real),
			quiesceAll: real.quiesceAll?.bind(real),
			async submit(req: ProviderSubmitRequest) {
				submitCalls += 1;
				return real.submit(req);
			},
			async lookupByIdempotency(req) {
				lookupCalls += 1;
				return real.lookupByIdempotency!(req);
			},
			async reconcile(handle) {
				reconcileCalls += 1;
				return real.reconcile(handle);
			},
		};

		assert.throws(
			() =>
				createControlHost({
					projectRoot: t.project,
					env: { ...process.env, TASKFLOW_HOME: t.home },
					controlMode: "auto",
					scriptProvider: observedProvider,
				}),
			assertDurabilityFailure,
			"a dead singleton pathname is not automatic recovery authority",
		);
		newHost = createControlHost({
			projectRoot: t.project,
			env: { ...process.env, TASKFLOW_HOME: t.home },
			controlMode: "auto",
			skipSingleton: true,
			scriptProvider: observedProvider,
		});
		assert.equal(newHost.role, "writer", "test-authorized recovery actor is not auto bootstrap");
		assert.equal(newHost.canMutate, true);
		const before = newHost.store.listRuns();
		assert.equal(before.length, 1);
		const run = before[0]!;
		assert.equal(newHost.store.getContinuation(run.runId)?.activeAttempt?.state, "intent-recorded");

		const recovered = await newHost.reconcilePendingDispatch(run.runId, {
			commandId: "recover-post-spawn-command",
		});
		assert.equal(recovered.ok, false);
		assert.equal(recovered.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(recovered.receipt, undefined);
		assert.equal(lookupCalls, 1, "authorized recovery must look up the durable idempotency key once");
		assert.equal(reconcileCalls, 1, "authorized recovery must reconcile the recovered handle once");
		assert.equal(submitCalls, 0, "recovery must never submit a replacement script");
		assert.equal(fs.readFileSync(marker, "utf8"), "once\n", "external side effect must remain unique");

		const continuation = newHost.store.getContinuation(run.runId);
		assert.equal(continuation?.activeAttempt?.state, "acknowledged");
		assert.equal(continuation?.activeAttempt?.providerHandle, accepted.handle);
		assert.equal(newHost.store.getReceiptForRun(run.runId), null);
	} finally {
		newHost?.close();
		if (oldWriter && oldWriter.exitCode === null && oldWriter.signalCode === null) {
			try {
				oldWriter.kill("SIGKILL");
			} catch {
				/* best-effort fixture cleanup */
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 800));
		t.cleanup();
	}
});
