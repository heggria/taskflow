/**
 * P16 admission crash boundaries that precede the first durable dispatch
 * intent.  These use a real ScriptExecutionProvider and a killed writer
 * process: an in-memory mock cannot distinguish a truthful retry disclosure
 * from a durable recovery owner.
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
	type ControlEvent,
	type RunContinuation,
} from "../src/index.ts";

const helpersDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers");

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

function tempFixture(): { home: string; project: string; barrier: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-admission-gap-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-admission-gap-project-"));
	const barrier = fs.mkdtempSync(path.join(os.tmpdir(), "tf-admission-gap-barrier-"));
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

function appendOnceProgram(marker: string, name = "post-executing-before-intent") {
	return {
		name,
		phases: [
			{
				id: "write-marker",
				type: "script" as const,
				run: [
					process.execPath,
					"-e",
					`require("node:fs").appendFileSync(${JSON.stringify(marker)}, "once\\n")`,
				],
				final: true,
			},
		],
	};
}

function persistPreparedAttemptWithoutIntent(
	host: ReturnType<typeof createControlHost>,
	runId: string,
): void {
	const persisted = host.store.compareAndCommit({
		runId,
		validate: (run) => (run.stage === "executing" ? null : "fixture requires executing run"),
		build: (run) => {
			const continuation = host.store.getContinuation(runId);
			assert.ok(continuation, "fixture requires durable continuation");
			const now = Date.now();
			const nextContinuation: RunContinuation = {
				...continuation,
				nextPhaseId: "write-marker",
				activeAttempt: {
					attemptId: "att-prepared-without-intent",
					phaseId: "write-marker",
					type: "script",
					idempotencyKey: `${runId}:write-marker:prepared-without-intent`,
					providerName: "script",
					state: "prepared",
					createdAt: now,
					updatedAt: now,
				},
				updatedAt: now,
				version: continuation.version + 1,
			};
			const event: ControlEvent = {
				eventId: "ev-prepared-without-intent",
				schemaVersion: 1,
				controlDomainId: host.controlDomainId,
				streamId: runId,
				streamSeq: 0,
				commitSeq: 0,
				projectId: host.projectId,
				recordedAt: now,
				payload: { type: "ContinuationStored", continuation: nextContinuation },
			};
			return {
				run: { ...run, updatedAt: now, runVersion: run.runVersion + 1 },
				events: [event],
			};
		},
	});
	assert.equal(persisted.ok, true, persisted.ok ? undefined : persisted.message);
}

test("P16 A4: retry after executing without a first intent fails closed instead of falsely reporting success", async () => {
	const t = tempFixture();
	const marker = path.join(t.project, "must-not-run.marker");
	let oldWriter: ChildProcess | undefined;
	let recoveryHost: ReturnType<typeof createControlHost> | undefined;
	try {
		oldWriter = spawn(
			process.execPath,
			[
				"--conditions=development",
				"--experimental-strip-types",
				path.join(helpersDir, "mp-post-executing-before-intent.mts"),
				t.project,
				t.home,
				t.barrier,
				marker,
			],
			{ env: { ...process.env, PI_TASKFLOW_BUILTIN_AGENTS_DIR: "" }, stdio: ["ignore", "pipe", "pipe"] },
		);
		await waitForFile(path.join(t.barrier, "executing-without-intent.json"));
		assert.equal(fs.existsSync(marker), false, "the pre-intent writer must not submit the script");

		oldWriter.kill("SIGKILL");
		const oldExit = await waitForChild(oldWriter);
		assert.equal(oldExit.signal, "SIGKILL");

		recoveryHost = createControlHost({
			projectRoot: t.project,
			env: { ...process.env, TASKFLOW_HOME: t.home },
			controlMode: "auto",
			skipSingleton: true,
			scriptProvider: createScriptExecutionProvider({
				stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs"),
			}),
		});
		const before = recoveryHost.store.listRuns();
		assert.equal(before.length, 1);
		const stranded = before[0]!;
		assert.equal(stranded.stage, "executing");
		assert.equal(
			recoveryHost.store.getContinuation(stranded.runId)?.activeAttempt,
			undefined,
			"fixture must prove no durable provider attempt exists",
		);
		assert.equal(recoveryHost.store.getReceiptForRun(stranded.runId), null);

		const retried = await recoveryHost.admitAndRun({
			commandId: "post-executing-before-intent-command",
			callerPrincipal: "cross-process-test",
			program: appendOnceProgram(marker),
		});
		assert.equal(retried.ok, false, "an ownerless first dispatch must not be disclosed as successful");
		assert.equal(retried.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(retried.error?.recoveryAction, "operator");
		assert.equal(retried.error?.sideEffects, "unknown");
		assert.equal(fs.existsSync(marker), false, "retry must not invent a replacement first dispatch");
		assert.equal(recoveryHost.store.getReceiptForRun(stranded.runId), null);
	} finally {
		recoveryHost?.close();
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

test("P16 A4: a prepared attempt is not evidence that the first dispatch has an owner", async () => {
	const t = tempFixture();
	const marker = path.join(t.project, "prepared-is-not-intent.marker");
	let oldWriter: ChildProcess | undefined;
	let recoveryHost: ReturnType<typeof createControlHost> | undefined;
	try {
		oldWriter = spawn(
			process.execPath,
			[
				"--conditions=development",
				"--experimental-strip-types",
				path.join(helpersDir, "mp-post-executing-before-intent.mts"),
				t.project,
				t.home,
				t.barrier,
				marker,
			],
			{ env: { ...process.env, PI_TASKFLOW_BUILTIN_AGENTS_DIR: "" }, stdio: ["ignore", "pipe", "pipe"] },
		);
		await waitForFile(path.join(t.barrier, "executing-without-intent.json"));
		oldWriter.kill("SIGKILL");
		const oldExit = await waitForChild(oldWriter);
		assert.equal(oldExit.signal, "SIGKILL");

		recoveryHost = createControlHost({
			projectRoot: t.project,
			env: { ...process.env, TASKFLOW_HOME: t.home },
			controlMode: "auto",
			skipSingleton: true,
			scriptProvider: createScriptExecutionProvider({
				stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs"),
			}),
		});
		const stranded = recoveryHost.store.listRuns()[0]!;
		persistPreparedAttemptWithoutIntent(recoveryHost, stranded.runId);
		assert.equal(
			recoveryHost.store.getContinuation(stranded.runId)?.activeAttempt?.state,
			"prepared",
			"prepared is a schema-valid pre-intent checkpoint, not provider ownership evidence",
		);

		const retried = await recoveryHost.admitAndRun({
			commandId: "post-executing-before-intent-command",
			callerPrincipal: "cross-process-test",
			program: appendOnceProgram(marker),
		});
		assert.equal(retried.ok, false, "prepared must not be disclosed as an owned first dispatch");
		assert.equal(retried.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(retried.error?.recoveryAction, "operator");
		assert.equal(retried.error?.sideEffects, "unknown");
		assert.equal(fs.existsSync(marker), false);
	} finally {
		recoveryHost?.close();
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

test("P16 A3 counterexample: SlotCommitted without a first intent remains explicitly recovery-owned", async () => {
	const t = tempFixture();
	const marker = path.join(t.project, "must-not-run-after-slot-commit.marker");
	let oldWriter: ChildProcess | undefined;
	let recoveryHost: ReturnType<typeof createControlHost> | undefined;
	try {
		oldWriter = spawn(
			process.execPath,
			[
				"--conditions=development",
				"--experimental-strip-types",
				path.join(helpersDir, "mp-post-slot-committed-before-intent.mts"),
				t.project,
				t.home,
				t.barrier,
				marker,
			],
			{ env: { ...process.env, PI_TASKFLOW_BUILTIN_AGENTS_DIR: "" }, stdio: ["ignore", "pipe", "pipe"] },
		);
		await waitForFile(path.join(t.barrier, "slot-committed-without-intent.json"));
		assert.equal(fs.existsSync(marker), false, "SlotCommitted alone must not submit the script");

		oldWriter.kill("SIGKILL");
		const oldExit = await waitForChild(oldWriter);
		assert.equal(oldExit.signal, "SIGKILL");

		recoveryHost = createControlHost({
			projectRoot: t.project,
			env: { ...process.env, TASKFLOW_HOME: t.home },
			controlMode: "auto",
			skipSingleton: true,
			scriptProvider: createScriptExecutionProvider({
				stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs"),
			}),
		});
		const command = recoveryHost.store.getCommand("post-slot-committed-before-intent-command");
		assert.equal(command?.admission?.state, "slot-committed");
		const stranded = recoveryHost.store.getRun(command!.admission!.runId);
		assert.ok(stranded);
		assert.equal(stranded.stage, "admitted");
		assert.ok(stranded.reservationId);
		assert.equal(recoveryHost.coordinator.getReservation(stranded.reservationId!)?.state, "committed");
		assert.equal(recoveryHost.store.getContinuation(stranded.runId)?.activeAttempt, undefined);

		const retried = await recoveryHost.admitAndRun({
			commandId: "post-slot-committed-before-intent-command",
			callerPrincipal: "cross-process-test",
			program: appendOnceProgram(marker, "post-slot-committed-before-intent"),
		});
		assert.equal(retried.ok, false, "a retry must not invent an unowned first provider dispatch");
		assert.equal(retried.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(retried.error?.recoveryAction, "operator");
		assert.equal(retried.error?.sideEffects, "unknown");
		assert.equal(fs.existsSync(marker), false, "no replacement script may be submitted");
		assert.equal(recoveryHost.store.getReceiptForRun(stranded.runId), null);
		const events = recoveryHost.store.readEvents(1, recoveryHost.store.nextCommitSeq() - 1);
		assert.equal(
			events.filter((event) => event.payload.type === "DispatchIntentRecorded").length,
			0,
			"the counterexample has no durable dispatch owner",
		);
	} finally {
		recoveryHost?.close();
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
