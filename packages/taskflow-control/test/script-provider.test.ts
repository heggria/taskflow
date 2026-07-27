/**
 * Real ScriptExecutionProvider — truthful exit codes and no mock default in prod path.
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
	bootstrapControl,
} from "../src/index.ts";
import { parentReleaseStart } from "./helpers/mp-barrier.mts";

const helpersDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers");

function temp(): { env: NodeJS.ProcessEnv; project: string; home: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-script-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-script-proj-"));
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

function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const check = () => {
			if (fs.existsSync(filePath)) {
				resolve();
				return;
			}
			if (Date.now() >= deadline) {
				reject(new Error(`timed out waiting for ${filePath}`));
				return;
			}
			setTimeout(check, 10);
		};
		check();
	});
}

function waitForChild(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve) => {
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
}

function captureChildOutput(
	child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
	});
}

test("script provider: exit 0 → completed + Receipt with fail-closed artifactIntegrity unknown", async () => {
	const t = temp();
	try {
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			// explicit production path: no mock
			provider: createScriptExecutionProvider({
				stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs"),
			}),
		});
		const r = await host.admitAndRun({
			program: {
				name: "ok-script",
				phases: [{ id: "main", type: "script", run: "echo hello-out", final: true }],
			},
		});
		assert.equal(r.ok, true, JSON.stringify(r.error ?? r.run));
		assert.equal(r.run?.status, "completed");
		assert.ok(r.receipt);
		assert.equal(r.receipt!.assurance.providerOutcome, "ok");
		// Unproven artifact integrity must not claim ok
		assert.equal(r.receipt!.assurance.artifactIntegrity, "unknown");
		assert.match(r.run?.finalOutput ?? "", /hello-out/);
		host.close();
	} finally {
		t.cleanup();
	}
});

test("script provider: exit 37 → failed terminal, no success Receipt", async () => {
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
				name: "fail-script",
				phases: [{ id: "main", type: "script", run: "exit 37", final: true }],
			},
		});
		assert.equal(r.ok, false);
		assert.equal(r.run?.status, "failed");
		assert.equal(r.run?.stage, "terminal");
		assert.match(r.run?.error ?? "", /37/);
		assert.equal(r.receipt, undefined);
		assert.equal(host.store.getReceiptForRun(r.run!.runId), null);
		host.close();
	} finally {
		t.cleanup();
	}
});

test("script provider: dead pid while status=running → poll fails closed (not still-running)", async () => {
	const t = temp();
	try {
		const stateDir = path.join(t.project, "jobs");
		fs.mkdirSync(stateDir, { recursive: true });
		// Simulate restart: durable handle claims running, but pid is already dead.
		// Use a pid that cannot be alive (process.pid of a short-lived child we wait for).
		const { spawnSync } = await import("node:child_process");
		const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"], { encoding: "utf-8" });
		assert.equal(dead.status, 0);
		// Re-spawn and capture pid then ensure it exits
		const { spawn } = await import("node:child_process");
		const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 1)"], {
			stdio: "ignore",
		});
		const deadPid = child.pid!;
		await new Promise<void>((resolve) => child.on("exit", () => resolve()));
		assert.ok(deadPid > 0);
		// Confirm not alive
		let alive = true;
		try {
			process.kill(deadPid, 0);
		} catch {
			alive = false;
		}
		assert.equal(alive, false, "fixture pid must be dead");

		const handle = "job_dead_pid_fixture";
		fs.writeFileSync(
			path.join(stateDir, `${handle}.json`),
			JSON.stringify({
				runId: "run-dead",
				pid: deadPid,
				cwd: t.project,
				cmd: "sleep 60",
				stdout: "",
				stderr: "",
				status: "running",
				startedAt: Date.now(),
			}),
		);

		const provider = createScriptExecutionProvider({ stateDir });
		const polled = await provider.poll(handle);
		assert.equal(polled.kind, "failed", JSON.stringify(polled));
		if (polled.kind === "failed") {
			assert.match(polled.error ?? "", /dead without recorded terminal/i);
		}
		// Must not report still-running (would hang host poll loop)
		assert.notEqual(polled.kind, "still-running");
		assert.equal(provider.isLive?.(handle), false);
		// Durable record updated to failed
		const loaded = provider.loadHandle!(handle);
		assert.equal(loaded?.status, "failed");
		const recon = await provider.reconcile(handle);
		assert.equal(recon.kind, "failed", JSON.stringify(recon));
	} finally {
		t.cleanup();
	}
});

test("script provider: durable idempotency survives restart and never re-spawns a completed side effect", async () => {
	const t = temp();
	try {
		const stateDir = path.join(t.project, "jobs");
		const marker = path.join(t.project, "idempotent.marker");
		const request = {
			runId: "idempotent-run",
			idempotencyKey: "stable-script-attempt",
			cwd: t.project,
			program: {
				name: "idempotent-script",
				phases: [
					{
						id: "main",
						type: "script",
						run: [
							process.execPath,
							"-e",
							`require("node:fs").appendFileSync(${JSON.stringify(marker)}, "once\\n")`,
						],
						final: true,
					},
				],
			},
		};
		const first = createScriptExecutionProvider({ stateDir });
		const submitted = await first.submit(request);
		assert.equal(submitted.kind, "accepted", JSON.stringify(submitted));
		if (submitted.kind !== "accepted") return;
		let terminal = await first.poll(submitted.handle);
		const deadline = Date.now() + 5_000;
		while (terminal.kind === "still-running" && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 15));
			terminal = await first.poll(submitted.handle);
		}
		assert.equal(terminal.kind, "completed", JSON.stringify(terminal));

		// A new provider process has no in-memory map. It must recover the same
		// durable handle rather than submit the command again.
		const restarted = createScriptExecutionProvider({ stateDir });
		const repeated = await restarted.submit(request);
		assert.equal(repeated.kind, "accepted", JSON.stringify(repeated));
		if (repeated.kind !== "accepted") return;
		assert.equal(repeated.handle, submitted.handle);
		const replayed = await restarted.poll(repeated.handle);
		assert.equal(replayed.kind, "completed", JSON.stringify(replayed));
		assert.equal(fs.readFileSync(marker, "utf8"), "once\n");
		const recoveredHandle = await restarted.lookupByIdempotency!(request);
		assert.equal(recoveredHandle.kind, "found", JSON.stringify(recoveredHandle));
		if (recoveredHandle.kind === "found") {
			assert.equal(recoveredHandle.handle, submitted.handle);
		}

		// A crash between idempotency reservation and durable job acknowledgement
		// must surface as ambiguity, never as permission to spawn a replacement.
		fs.unlinkSync(path.join(stateDir, `${submitted.handle}.json`));
		const missingAcknowledgementLookup = await restarted.lookupByIdempotency!(request);
		assert.equal(missingAcknowledgementLookup.kind, "ambiguous", JSON.stringify(missingAcknowledgementLookup));
		const noAcknowledgement = await createScriptExecutionProvider({ stateDir }).submit(request);
		assert.equal(noAcknowledgement.kind, "ambiguous", JSON.stringify(noAcknowledgement));
		if (noAcknowledgement.kind === "ambiguous") {
			assert.equal(noAcknowledgement.handle, submitted.handle);
		}
		assert.equal(fs.readFileSync(marker, "utf8"), "once\n");

		// A key is bound to the exact execution shape, not merely the run id.
		const conflict = await restarted.submit({
			...request,
			program: {
				name: "different-side-effect",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		assert.equal(conflict.kind, "rejected", JSON.stringify(conflict));
	} finally {
		t.cleanup();
	}
});

test("script provider: concurrent processes converge on one durable idempotency handle", async () => {
	const t = temp();
	const barrierDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-script-idempotency-barrier-"));
	try {
		const stateDir = path.join(t.project, "jobs");
		const marker = path.join(t.project, "multiprocess.marker");
		const childPath = path.join(helpersDir, "mp-idempotent-script.mts");
		const count = 4;
		const children: Array<Promise<{ id: string; status: number; stdout: string; stderr: string }>> = [];
		for (let index = 0; index < count; index += 1) {
			const id = String(index);
			const child: ChildProcess = spawn(
				process.execPath,
				[
					"--conditions=development",
					"--experimental-strip-types",
					childPath,
					stateDir,
					t.project,
					marker,
				],
				{
					env: { ...process.env, TF_MP_BARRIER: barrierDir, TF_MP_ID: id },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			children.push(
				new Promise((resolve) => {
					let stdout = "";
					let stderr = "";
					child.stdout?.setEncoding("utf8");
					child.stderr?.setEncoding("utf8");
					child.stdout?.on("data", (chunk: string) => {
						stdout += chunk;
					});
					child.stderr?.on("data", (chunk: string) => {
						stderr += chunk;
					});
					child.on("close", (code) => {
						resolve({ id, status: code ?? 1, stdout, stderr });
					});
				}),
			);
		}
		parentReleaseStart(barrierDir, count, 15_000);
		const results = await Promise.all(children);
		const parsed = results.map((result) => {
			assert.equal(result.status, 0, `child ${result.id} failed: ${result.stderr}`);
			return JSON.parse(result.stdout) as {
				kind: string;
				handle: string | null;
				terminal: string | null;
			};
		});
		assert.deepEqual(
			parsed.map((result) => result.kind),
			Array(count).fill("accepted"),
			JSON.stringify(parsed),
		);
		assert.deepEqual(
			parsed.map((result) => result.terminal),
			Array(count).fill("completed"),
			JSON.stringify(parsed),
		);
		assert.equal(new Set(parsed.map((result) => result.handle)).size, 1, JSON.stringify(parsed));
		assert.equal(fs.readFileSync(marker, "utf8"), "once\n");
	} finally {
		fs.rmSync(barrierDir, { recursive: true, force: true });
		t.cleanup();
	}
});

test("production default (no allowMockProvider) uses script provider name path", async () => {
	const t = temp();
	try {
		// bootstrap without provider injection → script default
		const { host } = bootstrapControl({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
		});
		const r = await host.admitAndRun({
			program: {
				name: "def",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		assert.equal(r.ok, true, JSON.stringify(r.error));
		assert.equal(r.run?.status, "completed");
		host.close();
	} finally {
		t.cleanup();
	}
});

test("terminal immutability: cancel after completed+Receipt rejected", async () => {
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
				name: "done",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		assert.equal(r.ok, true);
		assert.ok(r.receipt);
		const cancel = await host.cancel(r.run!.runId);
		assert.equal(cancel.ok, false);
		assert.equal(cancel.error?.code, "TF_INVALID_ARGUMENT");
		// Status unchanged
		assert.equal(host.getSnapshot(r.run!.runId)?.run.status, "completed");
		assert.ok(host.store.getReceiptForRun(r.run!.runId));
		host.close();
	} finally {
		t.cleanup();
	}
});

test("cancel stale CAS never reaches a real ScriptExecutionProvider", async () => {
	const t = temp();
	let provider: ReturnType<typeof createScriptExecutionProvider> | undefined;
	let handle: string | undefined;
	try {
		const marker = path.join(t.project, "stale-cancel-live.marker");
		provider = createScriptExecutionProvider({
			stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs"),
		});
		const originalCancel = provider.cancel.bind(provider);
		let cancelCalls = 0;
		provider.cancel = async (providerHandle) => {
			cancelCalls += 1;
			return originalCancel(providerHandle);
		};
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
				name: "stale-cancel-live-script",
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
			},
		});
		const run = admitted.run!;
		const current = host.getSnapshot(run.runId)!.run;
		handle = current.providerHandle ?? run.providerHandle;
		assert.ok(handle, "fixture requires a durable provider handle");
		assert.equal(fs.readFileSync(marker, "utf8"), "live\n");
		assert.equal(provider.isLive?.(handle), true, "fixture script must still be live");

		const stale = await host.cancel(run.runId, { expectedRunVersion: current.runVersion - 1 });
		assert.equal(stale.ok, false);
		assert.equal(stale.error?.code, "TF_STALE_VERSION");
		assert.equal(cancelCalls, 0, "stale CAS must not signal the provider");
		assert.equal(provider.isLive?.(handle), true, "stale CAS must leave the real script live");
		host.close();
	} finally {
		if (provider && handle) {
			await provider.cancel(handle);
		}
		t.cleanup();
	}
});

test(
	"C3: crash after durable Script cancel intent never re-signals or terminalizes on restart",
	{ skip: process.platform === "win32" },
	async () => {
		const t = temp();
		const stateDir = path.join(t.project, ".taskflow", "control", "provider-jobs");
		const marker = path.join(t.project, "c3-live.marker");
		const barrier = path.join(t.project, "c3-after-intent-before-signal.json");
		const helper = path.join(helpersDir, "mp-cancel-after-intent-before-signal.mts");
		const commandId = "c3-cancel-command";
		let setupHost: ReturnType<typeof createControlHost> | undefined;
		let restartedHost: ReturnType<typeof createControlHost> | undefined;
		let crashHost: ChildProcess | undefined;
		let handle: string | undefined;
		try {
			const setupProvider = createScriptExecutionProvider({ stateDir });
			setupHost = createControlHost({
				projectRoot: t.project,
				env: t.env,
				skipSingleton: true,
				controlMode: "standalone",
				scriptProvider: setupProvider,
				reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
			});
			const admitted = await setupHost.admitAndRun({
				program: {
					name: "c3-cancel-crash",
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
				},
			});
			const run = setupHost.getSnapshot(admitted.run!.runId)!.run;
			handle = run.providerHandle;
			assert.ok(handle, "fixture requires a durable Script handle");
			assert.equal(fs.readFileSync(marker, "utf8"), "live\n");
			assert.equal(setupProvider.isLive?.(handle), true, "fixture Script must be live before cancellation");
			setupHost.close();
			setupHost = undefined;

			crashHost = spawn(
				process.execPath,
				[
					"--conditions=development",
					"--experimental-strip-types",
					helper,
					t.project,
					t.home,
					run.runId,
					String(run.runVersion),
					commandId,
					barrier,
				],
				{
					env: { ...process.env, TASKFLOW_HOME: t.home, PI_TASKFLOW_BUILTIN_AGENTS_DIR: "" },
					stdio: ["ignore", "ignore", "pipe"],
				},
			);
			await waitForFile(barrier);
			const boundary = JSON.parse(fs.readFileSync(barrier, "utf8")) as {
				pid?: unknown;
				signal?: unknown;
				boundary?: unknown;
			};
			assert.equal(boundary.signal, "SIGKILL");
			assert.equal(typeof boundary.pid, "number");
			assert.ok((boundary.pid as number) < 0, "fixture must intercept the process-group signal");
			assert.equal(boundary.boundary, "after-durable-cancel-intent-before-os-signal");

			const durableDuringCrash = JSON.parse(
				fs.readFileSync(path.join(stateDir, `${handle}.json`), "utf8"),
			) as { status?: unknown; cancelRequestedAt?: unknown };
			assert.equal(durableDuringCrash.status, "running");
			assert.equal(typeof durableDuringCrash.cancelRequestedAt, "number");
			assert.equal(setupProvider.isLive?.(handle), true, "no OS signal may have reached the live Script");

			const crashExit = waitForChild(crashHost);
			crashHost.kill("SIGKILL");
			assert.equal((await crashExit).signal, "SIGKILL");
			crashHost = undefined;

			const restartedProvider = createScriptExecutionProvider({ stateDir });
			const originalCancel = restartedProvider.cancel.bind(restartedProvider);
			let retryProviderCancelCalls = 0;
			restartedProvider.cancel = async (providerHandle, options) => {
				retryProviderCancelCalls += 1;
				return originalCancel(providerHandle, options);
			};
			restartedHost = createControlHost({
				projectRoot: t.project,
				env: t.env,
				skipSingleton: true,
				controlMode: "standalone",
				scriptProvider: restartedProvider,
			});
			const beforeRetry = restartedHost.getSnapshot(run.runId)!.run;
			assert.equal(beforeRetry.status, "unknown");
			assert.equal(beforeRetry.stage, "reconciling");
			assert.equal(beforeRetry.cancelRequest?.commandId, commandId);
			assert.equal(beforeRetry.cancelRequest?.state, "signalling");
			assert.ok(beforeRetry.reservationId, "ambiguous cancel must retain its capacity reservation");
			assert.notEqual(
				restartedHost.coordinator.getReservation(beforeRetry.reservationId!)?.state,
				"released",
				"the cancellation crash window must not free capacity",
			);

			const retried = await restartedHost.cancel(run.runId, { commandId });
			assert.equal(retried.ok, false, JSON.stringify(retried.error));
			assert.equal(retried.error?.code, "TF_RECONCILE_REQUIRED");
			assert.equal(retried.error?.sideEffects, "possible");
			assert.equal(retryProviderCancelCalls, 0, "restart must not blindly emit a second OS signal");
			assert.equal(restartedHost.getSnapshot(run.runId)?.run.cancelRequest?.state, "signalling");
			assert.equal(restartedProvider.isLive?.(handle), true, "the unsignalled Script remains live for operator/reconcile");
			assert.equal(restartedHost.store.getReceiptForRun(run.runId), null);
			restartedHost.close();
			restartedHost = undefined;
	} finally {
		setupHost?.close();
		restartedHost?.close();
		if (crashHost && crashHost.exitCode === null && crashHost.signalCode === null) {
			try {
				crashHost.kill("SIGKILL");
			} catch {
				/* fixture process already stopped */
			}
		}
		if (handle) {
			const durable = createScriptExecutionProvider({ stateDir }).loadHandle?.(handle);
			if (durable?.pid) {
				try {
					process.kill(-durable.pid, "SIGKILL");
				} catch {
					/* fixture Script already stopped */
				}
			}
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 40));
		t.cleanup();
	}
	},
);

test(
	"C2: crash after durable cancel request before signalling never guesses a second signal",
	{ skip: process.platform === "win32" },
	async () => {
		const t = temp();
		const stateDir = path.join(t.project, ".taskflow", "control", "provider-jobs");
		const marker = path.join(t.project, "c2-live.marker");
		const barrier = path.join(t.project, "c2-after-request-before-signalling.json");
		const helper = path.join(helpersDir, "mp-cancel-after-request-before-signalling.mts");
		const commandId = "c2-cancel-command";
		let setupHost: ReturnType<typeof createControlHost> | undefined;
		let restartedHost: ReturnType<typeof createControlHost> | undefined;
		let crashHost: ChildProcess | undefined;
		let handle: string | undefined;
		try {
			const setupProvider = createScriptExecutionProvider({ stateDir });
			setupHost = createControlHost({
				projectRoot: t.project,
				env: t.env,
				skipSingleton: true,
				controlMode: "standalone",
				scriptProvider: setupProvider,
				reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
			});
			const admitted = await setupHost.admitAndRun({
				program: {
					name: "c2-cancel-crash",
					phases: [
						{
							id: "main",
							type: "script",
							run: [
								process.execPath,
								"-e",
								`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "live\\\\n"); setInterval(() => {}, 1_000);`,
							],
							final: true,
						},
					],
				},
			});
			const run = setupHost.getSnapshot(admitted.run!.runId)!.run;
			handle = run.providerHandle;
			assert.ok(handle, "C2 fixture requires a durable Script handle");
			assert.equal(fs.readFileSync(marker, "utf8"), "live\\n");
			assert.equal(setupProvider.isLive?.(handle), true, "C2 fixture Script must be live before cancellation");
			setupHost.close();
			setupHost = undefined;

			crashHost = spawn(
				process.execPath,
				[
					"--conditions=development",
					"--experimental-strip-types",
					helper,
					t.project,
					t.home,
					run.runId,
					String(run.runVersion),
					commandId,
					barrier,
					stateDir,
				],
				{
					env: { ...process.env, TASKFLOW_HOME: t.home, PI_TASKFLOW_BUILTIN_AGENTS_DIR: "" },
					stdio: ["ignore", "ignore", "pipe"],
				},
			);
			await waitForFile(barrier);
			const boundary = JSON.parse(fs.readFileSync(barrier, "utf8")) as {
				runId?: unknown;
				commandId?: unknown;
				cancelState?: unknown;
				runVersion?: unknown;
				boundary?: unknown;
			};
			assert.equal(boundary.runId, run.runId);
			assert.equal(boundary.commandId, commandId);
			assert.equal(boundary.cancelState, "requested");
			assert.equal(typeof boundary.runVersion, "number");
			assert.equal(boundary.boundary, "after-durable-request-before-signalling-cas");

			const targetJournalEntries = fs
				.readdirSync(path.join(t.project, ".taskflow", "control", "journal"))
				.filter((file) => file.endsWith(".json"))
				.map(
					(file) =>
						JSON.parse(fs.readFileSync(path.join(t.project, ".taskflow", "control", "journal", file), "utf8")) as {
							command?: { commandId?: unknown };
							run?: { cancelRequest?: { commandId?: unknown; state?: unknown } };
						},
				)
				.filter((entry) => entry.command?.commandId === commandId);
			assert.equal(targetJournalEntries.length, 1, "one durable command record must own the C2 cancellation");
			assert.equal(targetJournalEntries[0]?.run?.cancelRequest?.commandId, commandId);
			assert.equal(targetJournalEntries[0]?.run?.cancelRequest?.state, "requested");

			const durableBeforeCrash = JSON.parse(
				fs.readFileSync(path.join(stateDir, `${handle}.json`), "utf8"),
			) as { status?: unknown; cancelRequestedAt?: unknown };
			assert.equal(durableBeforeCrash.status, "running");
			assert.equal(durableBeforeCrash.cancelRequestedAt, undefined, "C2 must stop before the provider durable signal intent");
			assert.equal(setupProvider.isLive?.(handle), true, "C2 must stop before any OS group signal");

			const crashExit = waitForChild(crashHost);
			crashHost.kill("SIGKILL");
			assert.equal((await crashExit).signal, "SIGKILL");
			crashHost = undefined;

			const restartedProvider = createScriptExecutionProvider({ stateDir });
			const originalCancel = restartedProvider.cancel.bind(restartedProvider);
			let retryProviderCancelCalls = 0;
			restartedProvider.cancel = async (providerHandle, options) => {
				retryProviderCancelCalls += 1;
				return originalCancel(providerHandle, options);
			};
			restartedHost = createControlHost({
				projectRoot: t.project,
				env: t.env,
				skipSingleton: true,
				controlMode: "standalone",
				scriptProvider: restartedProvider,
			});
			const beforeRetry = restartedHost.getSnapshot(run.runId)!.run;
			assert.equal(beforeRetry.status, "unknown");
			assert.equal(beforeRetry.stage, "reconciling");
			assert.equal(beforeRetry.cancelRequest?.commandId, commandId);
			assert.equal(beforeRetry.cancelRequest?.state, "requested");
			assert.ok(beforeRetry.reservationId, "C2 must retain its capacity reservation");
			assert.notEqual(
				restartedHost.coordinator.getReservation(beforeRetry.reservationId!)?.state,
				"released",
				"C2 cancellation crash must not free capacity",
			);
			assert.equal(restartedHost.store.getReceiptForRun(run.runId), null);

			const retried = await restartedHost.cancel(run.runId, { commandId });
			assert.equal(retried.ok, false, JSON.stringify(retried.error));
			assert.equal(retried.error?.code, "TF_RECONCILE_REQUIRED");
			assert.equal(retried.error?.sideEffects, "unknown");
			assert.equal(retried.error?.recoveryAction, "reconcile");
			assert.equal(retryProviderCancelCalls, 0, "a fresh actor must not guess that it owns the first signal");
			assert.equal(restartedHost.getSnapshot(run.runId)?.run.cancelRequest?.state, "requested");
			const durableAfterRetry = JSON.parse(
				fs.readFileSync(path.join(stateDir, `${handle}.json`), "utf8"),
			) as { status?: unknown; cancelRequestedAt?: unknown };
			assert.equal(durableAfterRetry.status, "running");
			assert.equal(durableAfterRetry.cancelRequestedAt, undefined, "same-command reopen must emit zero provider signal intents");
			assert.equal(restartedProvider.isLive?.(handle), true, "the never-signalled Script must remain live for reconcile/operator action");
			assert.equal(restartedHost.store.getReceiptForRun(run.runId), null);
			restartedHost.close();
			restartedHost = undefined;
	} finally {
		setupHost?.close();
		restartedHost?.close();
		if (crashHost && crashHost.exitCode === null && crashHost.signalCode === null) {
			try {
				crashHost.kill("SIGKILL");
			} catch {
				/* fixture process already stopped */
			}
		}
		if (handle) {
			const durable = createScriptExecutionProvider({ stateDir }).loadHandle?.(handle);
			if (durable?.pid) {
				try {
					process.kill(-durable.pid, "SIGKILL");
				} catch {
					/* fixture Script already stopped */
				}
			}
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 40));
		t.cleanup();
	}
	},
);

test(
	"C1: two processes with the same cancel command converge without a second signal",
	{ skip: process.platform === "win32" },
	async () => {
		const t = temp();
		const barrierDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-cancel-c1-"));
		const stateDir = path.join(t.project, ".taskflow", "control", "provider-jobs");
		const marker = path.join(t.project, "c1-live.marker");
		const signalLog = path.join(barrierDir, "signals.log");
		const commandId = "c1-shared-cancel-command";
		const helper = path.join(helpersDir, "mp-cancel-same-command-race.mts");
		let setupHost: ReturnType<typeof createControlHost> | undefined;
		let verifierHost: ReturnType<typeof createControlHost> | undefined;
		let owner: { child: ChildProcess; done: ReturnType<typeof captureChildOutput> } | undefined;
		let loser: { child: ChildProcess; done: ReturnType<typeof captureChildOutput> } | undefined;
		let handle: string | undefined;
		try {
			const setupProvider = createScriptExecutionProvider({ stateDir });
			setupHost = createControlHost({
				projectRoot: t.project,
				env: t.env,
				skipSingleton: true,
				controlMode: "standalone",
				scriptProvider: setupProvider,
				reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
			});
			const admitted = await setupHost.admitAndRun({
				program: {
					name: "c1-same-command-race",
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
				},
			});
			const initial = setupHost.getSnapshot(admitted.run!.runId)!.run;
			handle = initial.providerHandle;
			assert.ok(handle, "C1 fixture requires a durable Script handle");
			assert.equal(fs.readFileSync(marker, "utf8"), "live\n");
			assert.equal(setupProvider.isLive?.(handle), true, "C1 fixture Script must be live");
			setupHost.close();
			setupHost = undefined;

			const launch = (role: "owner" | "loser") => {
				const child = spawn(
					process.execPath,
					[
						"--conditions=development",
						"--experimental-strip-types",
						helper,
						t.project,
						t.home,
						initial.runId,
						String(initial.runVersion),
						commandId,
						role,
						barrierDir,
						stateDir,
						signalLog,
					],
					{
						env: { ...process.env, TASKFLOW_HOME: t.home, PI_TASKFLOW_BUILTIN_AGENTS_DIR: "" },
						stdio: ["ignore", "pipe", "pipe"],
					},
				);
				return { child, done: captureChildOutput(child) };
			};

			owner = launch("owner");
			loser = launch("loser");
			await waitForFile(path.join(barrierDir, "read-owner"));
			await waitForFile(path.join(barrierDir, "read-loser"));
			fs.writeFileSync(path.join(barrierDir, "release-owner"), "go\n");
			await waitForFile(path.join(barrierDir, "owner-at-signal"));

			const durableAtSignalBoundary = JSON.parse(
				fs.readFileSync(path.join(stateDir, `${handle}.json`), "utf8"),
			) as { status?: unknown; cancelRequestedAt?: unknown };
			assert.equal(durableAtSignalBoundary.status, "running");
			assert.equal(typeof durableAtSignalBoundary.cancelRequestedAt, "number");
			assert.equal(setupProvider.isLive?.(handle), true, "owner must still be parked before the real signal");

			// The loser read the missing command before the winner committed it, but
			// only gets to issue that stale CAS after the winner has journaled
			// `signalling`. It must re-read and converge, never signal itself.
			fs.writeFileSync(path.join(barrierDir, "release-loser"), "go\n");
			const loserResult = await loser.done;
			assert.equal(loserResult.code, 0, loserResult.stderr);
			fs.writeFileSync(path.join(barrierDir, "release-owner-signal"), "go\n");
			const ownerResult = await owner.done;
			assert.equal(ownerResult.code, 0, ownerResult.stderr);

			const parsedOwner = JSON.parse(ownerResult.stdout) as {
				role: string;
				code: string | null;
				sideEffects: string | null;
				recoveryAction: string | null;
				status: string | null;
				stage: string | null;
				cancelState: string | null;
			};
			const parsedLoser = JSON.parse(loserResult.stdout) as typeof parsedOwner;
			assert.equal(parsedOwner.role, "owner");
			assert.equal(parsedLoser.role, "loser");
			assert.deepEqual(
				[parsedOwner.code, parsedLoser.code],
				["TF_RECONCILE_REQUIRED", "TF_RECONCILE_REQUIRED"],
				`same command must converge rather than expose stale/invalid CAS: owner=${ownerResult.stdout} loser=${loserResult.stdout}`,
			);
			assert.deepEqual(
				[
					[parsedOwner.sideEffects, parsedOwner.recoveryAction, parsedOwner.status, parsedOwner.stage],
					[parsedLoser.sideEffects, parsedLoser.recoveryAction, parsedLoser.status, parsedLoser.stage],
				],
				[
					["possible", "reconcile", "unknown", "reconciling"],
					["possible", "reconcile", "unknown", "reconciling"],
				],
				"both contenders must expose the same durable reconcile contract",
			);

			const signalLines = fs.existsSync(signalLog)
				? fs
						.readFileSync(signalLog, "utf8")
						.trim()
						.split("\n")
						.filter(Boolean)
				: [];
			assert.equal(signalLines.length, 1, `same cancel command emitted ${signalLines.length} process-group signals`);
			assert.match(signalLines[0]!, /^owner:-\d+$/);

			verifierHost = createControlHost({
				projectRoot: t.project,
				env: t.env,
				skipSingleton: true,
				controlMode: "standalone",
				scriptProvider: createScriptExecutionProvider({ stateDir }),
			});
			const finalRun = verifierHost.getSnapshot(initial.runId)!.run;
			assert.equal(finalRun.status, "unknown");
			assert.equal(finalRun.stage, "reconciling");
			assert.equal(finalRun.cancelRequest?.commandId, commandId);
			assert.ok(finalRun.cancelRequest?.state === "signalling" || finalRun.cancelRequest?.state === "ambiguous");
			assert.ok(finalRun.reservationId, "nonterminal cancellation must retain its reservation");
			assert.notEqual(verifierHost.coordinator.getReservation(finalRun.reservationId!)?.state, "released");
			assert.equal(verifierHost.store.getReceiptForRun(initial.runId), null);
			const command = verifierHost.store.getCommand(commandId);
			assert.equal(command?.runId, initial.runId);
			assert.equal(command?.callerPrincipal, "c1-principal");
			const foreignRetry = await verifierHost.cancel(initial.runId, {
				commandId,
				principal: "c1-foreign-principal",
			});
			assert.equal(foreignRetry.ok, false);
			assert.equal(foreignRetry.error?.code, "TF_CROSS_PRINCIPAL_COMMAND");
			assert.equal(foreignRetry.run, undefined, "foreign caller must not receive the durable Run snapshot");
			assert.equal(foreignRetry.snapshot, undefined, "foreign caller must not receive reconcile state");
			assert.equal(
				fs
					.readFileSync(signalLog, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean).length,
				1,
				"cross-principal retry must not create another provider signal",
			);
			const targetCommands = fs
				.readdirSync(path.join(t.project, ".taskflow", "control", "journal"))
				.filter((file) => file.endsWith(".json"))
				.map((file) => JSON.parse(fs.readFileSync(path.join(t.project, ".taskflow", "control", "journal", file), "utf8")) as {
					command?: { commandId?: unknown };
				})
				.filter((entry) => entry.command?.commandId === commandId);
			assert.equal(targetCommands.length, 1, "one durable command record must own the cancellation chain");
			verifierHost.close();
			verifierHost = undefined;
	} finally {
		for (const release of ["release-owner", "release-loser", "release-owner-signal"]) {
			try {
				fs.writeFileSync(path.join(barrierDir, release), "cleanup\n");
			} catch {
				/* barrier directory may already be gone */
			}
		}
		for (const raced of [owner, loser]) {
			if (raced?.child.exitCode === null && raced.child.signalCode === null) {
				try {
					raced.child.kill("SIGKILL");
				} catch {
					/* child already stopped */
				}
			}
		}
		setupHost?.close();
		verifierHost?.close();
		if (handle) {
			const durable = createScriptExecutionProvider({ stateDir }).loadHandle?.(handle);
			if (durable?.pid) {
				try {
					process.kill(-durable.pid, "SIGKILL");
				} catch {
					/* fixture Script already stopped */
				}
			}
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 40));
		fs.rmSync(barrierDir, { recursive: true, force: true });
		t.cleanup();
	}
	},
);

test(
	"script cancel journals one intent, kills an inherited process group, and remains nonterminal",
	{ skip: process.platform === "win32" },
	async () => {
	const t = temp();
	let provider: ReturnType<typeof createScriptExecutionProvider> | undefined;
	let handle: string | undefined;
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		const parentMarker = path.join(t.project, "cancel-parent.marker");
		const escapedGrandchildMarker = path.join(t.project, "cancel-grandchild.marker");
		const releaseGrandchild = path.join(t.project, "release-grandchild.marker");
		const grandchildProgram = [
			`const fs = require("node:fs");`,
			`const release = ${JSON.stringify(releaseGrandchild)};`,
			`const timer = setInterval(() => {`,
			`  if (!fs.existsSync(release)) return;`,
			`  clearInterval(timer);`,
			`  fs.writeFileSync(${JSON.stringify(escapedGrandchildMarker)}, "escaped\\n");`,
			`}, 20);`,
		].join(" ");
		const parentProgram = [
			`const fs = require("node:fs");`,
			`const { spawn } = require("node:child_process");`,
			`fs.writeFileSync(${JSON.stringify(parentMarker)}, "parent\\n");`,
			`spawn(process.execPath, ["-e", ${JSON.stringify(grandchildProgram)}], { stdio: "ignore" });`,
			`setInterval(() => {}, 1_000);`,
		].join(" ");
		provider = createScriptExecutionProvider({
			stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs"),
		});
		const originalCancel = provider.cancel.bind(provider);
		let cancelCalls = 0;
		provider.cancel = async (providerHandle, options) => {
			cancelCalls += 1;
			return originalCancel(providerHandle, options);
		};
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});
		const admitted = await host.admitAndRun({
			program: {
				name: "cancel-group-script",
				phases: [
					{
						id: "main",
						type: "script",
						run: [process.execPath, "-e", parentProgram],
						final: true,
					},
				],
			},
		});
		const run = host.getSnapshot(admitted.run!.runId)!.run;
		handle = run.providerHandle;
		assert.ok(handle, "fixture requires a durable provider handle");
		assert.equal(fs.readFileSync(parentMarker, "utf8"), "parent\n");

		const commandId = "cancel-group-command";
		const cancelled = await host.cancel(run.runId, {
			commandId,
			expectedRunVersion: run.runVersion,
		});
		assert.equal(cancelled.ok, false, JSON.stringify(cancelled.error));
		assert.equal(cancelled.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(cancelled.run?.status, "unknown");
		assert.equal(cancelled.run?.stage, "reconciling");
		assert.equal(cancelled.run?.cancelRequest?.commandId, commandId);
		assert.equal(cancelled.run?.cancelRequest?.state, "ambiguous");
		assert.equal(cancelCalls, 1);
		const reconciled = await provider.reconcile(handle);
		assert.equal(reconciled.kind, "ambiguous", JSON.stringify(reconciled));
		fs.writeFileSync(releaseGrandchild, "release\n");
		await new Promise<void>((resolve) => setTimeout(resolve, 500));
		assert.equal(fs.existsSync(escapedGrandchildMarker), false, "inherited grandchild escaped cancel group");

		const repeated = await host.cancel(run.runId, {
			commandId,
			expectedRunVersion: 1,
		});
		assert.equal(repeated.ok, false, JSON.stringify(repeated.error));
		assert.equal(repeated.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(cancelCalls, 1, "same durable cancel command must not signal twice");
		host.close();
		host = undefined;
	} finally {
		if (host) host.close();
		if (provider && handle) {
			const durable = provider.loadHandle?.(handle);
			if (durable?.pid) {
				try {
					process.kill(process.platform === "win32" ? durable.pid : -durable.pid, "SIGKILL");
				} catch {
					/* fixture already stopped */
				}
			}
			}
			t.cleanup();
		}
	},
);

test(
	"script cancel never mistakes a detached descendant for whole-tree quiescence",
	{ skip: process.platform === "win32" },
	async () => {
		const t = temp();
		let provider: ReturnType<typeof createScriptExecutionProvider> | undefined;
		let handle: string | undefined;
		let host: ReturnType<typeof createControlHost> | undefined;
		const release = path.join(t.project, "release-detached.marker");
		try {
			const parentMarker = path.join(t.project, "detached-parent.marker");
			const escapedMarker = path.join(t.project, "detached-grandchild.marker");
			const grandchildProgram = [
				`const fs = require("node:fs");`,
				`const release = ${JSON.stringify(release)};`,
				`const timer = setInterval(() => {`,
				`  if (!fs.existsSync(release)) return;`,
				`  clearInterval(timer);`,
				`  fs.writeFileSync(${JSON.stringify(escapedMarker)}, "escaped\\n");`,
				`}, 20);`,
			].join(" ");
			const parentProgram = [
				`const fs = require("node:fs");`,
				`const { spawn } = require("node:child_process");`,
				`fs.writeFileSync(${JSON.stringify(parentMarker)}, "parent\\n");`,
				`spawn(process.execPath, ["-e", ${JSON.stringify(grandchildProgram)}], { detached: true, stdio: "ignore" }).unref();`,
				`setInterval(() => {}, 1_000);`,
			].join(" ");
			provider = createScriptExecutionProvider({
				stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs"),
			});
			const originalCancel = provider.cancel.bind(provider);
			let cancelCalls = 0;
			provider.cancel = async (providerHandle, options) => {
				cancelCalls += 1;
				return originalCancel(providerHandle, options);
			};
			host = createControlHost({
				projectRoot: t.project,
				env: t.env,
				skipSingleton: true,
				controlMode: "standalone",
				provider,
				reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
			});
			const admitted = await host.admitAndRun({
				program: {
					name: "cancel-detached-descendant",
					phases: [{ id: "main", type: "script", run: [process.execPath, "-e", parentProgram], final: true }],
				},
			});
			const run = host.getSnapshot(admitted.run!.runId)!.run;
			handle = run.providerHandle;
			assert.ok(handle, "fixture requires a durable provider handle");
			assert.equal(fs.readFileSync(parentMarker, "utf8"), "parent\n");

			const commandId = "cancel-detached-command";
			const cancelled = await host.cancel(run.runId, {
				commandId,
				expectedRunVersion: run.runVersion,
			});
			assert.equal(cancelled.ok, false, JSON.stringify(cancelled.error));
			assert.equal(cancelled.error?.code, "TF_RECONCILE_REQUIRED");
			assert.equal(cancelled.run?.status, "unknown");
		assert.equal(cancelled.run?.stage, "reconciling");
		assert.equal(cancelled.run?.cancelRequest?.state, "ambiguous");
		assert.equal(cancelCalls, 1);
		const reconciled = await provider.reconcile(handle);
		assert.equal(reconciled.kind, "ambiguous", JSON.stringify(reconciled));

		fs.writeFileSync(release, "release\n");
			const deadline = Date.now() + 3_000;
			while (!fs.existsSync(escapedMarker) && Date.now() < deadline) {
				await new Promise<void>((resolve) => setTimeout(resolve, 20));
			}
			assert.equal(fs.existsSync(escapedMarker), true, "fixture must prove the detached descendant escaped");

			const repeated = await host.cancel(run.runId, { commandId });
			assert.equal(repeated.ok, false, JSON.stringify(repeated.error));
			assert.equal(repeated.error?.code, "TF_RECONCILE_REQUIRED");
			assert.equal(cancelCalls, 1, "same cancel command must not re-signal an escaped tree");
			host.close();
			host = undefined;
		} finally {
			try {
				fs.writeFileSync(release, "release\n");
			} catch {
				/* fixture directory may already be gone */
			}
			if (host) host.close();
			if (provider && handle) {
				const durable = provider.loadHandle?.(handle);
				if (durable?.pid) {
					try {
						process.kill(process.platform === "win32" ? durable.pid : -durable.pid, "SIGKILL");
					} catch {
						/* fixture already stopped */
					}
				}
			}
			t.cleanup();
		}
	},
);

test("unsafe commandId rejected", async () => {
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
			commandId: "../evil",
			program: {
				name: "x",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		assert.equal(r.ok, false);
		assert.equal(r.error?.code, "TF_INVALID_ARGUMENT");
		host.close();
	} finally {
		t.cleanup();
	}
});
