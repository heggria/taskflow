/**
 * Native approval continuation (P15): a parked approval must resume the exact
 * durable phase cursor after restart.  This is intentionally a real script
 * provider test: rerunning `prep` would be observable duplicate work.
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
	openProjectControlStore,
	SingletonAuthorityError,
} from "../src/index.ts";
import { parentReleaseStart } from "./helpers/mp-barrier.mts";

const helpersDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers");

function temp(): { env: NodeJS.ProcessEnv; project: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-approval-cont-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-approval-cont-project-"));
	return {
		env: { ...process.env, TASKFLOW_HOME: home },
		project,
		cleanup: () => {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(project, { recursive: true, force: true });
		},
	};
}

function appendProgram(marker: string, value: string): string[] {
	return [
		process.execPath,
		"-e",
		`require("node:fs").appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(value + "\n")})`,
	];
}

test("native approval restart resumes only the durable downstream cursor and signs after provider terminal", async () => {
	const t = temp();
	try {
		const prepMarker = path.join(t.project, "prep.marker");
		const finishMarker = path.join(t.project, "finish.marker");
		const program = {
			name: "native-approval-continuation",
			phases: [
				{ id: "prep", type: "script", run: appendProgram(prepMarker, "prep") },
				{
					id: "human-checkpoint",
					type: "approval",
					task: "Approve the already-completed preparation before finish.",
					dependsOn: ["prep"],
				},
				{
					id: "finish",
					type: "script",
					run: appendProgram(finishMarker, "finish"),
					dependsOn: ["human-checkpoint"],
					final: true,
				},
			],
		};

		const first = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			scriptProvider: createScriptExecutionProvider({
				stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs"),
			}),
		});
		const parked = await first.admitAndRun({ program, commandId: "native-approval-admit" });
		assert.equal(parked.ok, true, JSON.stringify(parked.error));
		assert.equal(parked.run?.status, "paused");
		assert.equal(parked.run?.stage, "parked");
		assert.equal(first.getSnapshot(parked.run!.runId)?.receipt, null);
		assert.equal(fs.readFileSync(prepMarker, "utf8"), "prep\n");
		assert.equal(fs.existsSync(finishMarker), false, "finish must not run before approval");
		const runId = parked.run!.runId;
		const expectedRunVersion = parked.run!.runVersion;
		first.close();

		// A fresh host has no in-memory scheduler state. It must read the immutable
		// BoundPlan and continuation from the journal, not rerun prep from source.
		const restarted = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			scriptProvider: createScriptExecutionProvider({
				stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs"),
			}),
		});
		const completed = await restarted.approve(runId, {
			commandId: "native-approval-decision",
			principal: "reviewer",
			expectedRunVersion,
		});
		assert.equal(completed.ok, true, JSON.stringify(completed.error));
		assert.equal(completed.run?.status, "completed");
		assert.equal(completed.run?.stage, "terminal");
		assert.ok(completed.receipt, "Receipt is permitted only after finish reaches provider terminal");
		assert.equal(fs.readFileSync(prepMarker, "utf8"), "prep\n", "prep must run exactly once");
		assert.equal(fs.readFileSync(finishMarker, "utf8"), "finish\n", "finish runs once after approve");
		restarted.close();
	} finally {
		t.cleanup();
	}
});

test("native approval: cancellation after downstream intent suppresses the real script spawn", async () => {
	const t = temp();
	try {
		const prepMarker = path.join(t.project, "cancel-intent-prep.marker");
		const finishMarker = path.join(t.project, "cancel-intent-finish.marker");
		const providerStateDir = path.join(t.project, ".taskflow", "control", "provider-jobs");
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			scriptProvider: createScriptExecutionProvider({ stateDir: providerStateDir }),
		});
		try {
			const parked = await host.admitAndRun({
				commandId: "native-approval-cancel-intent-admit",
				program: {
					name: "native-approval-cancel-intent",
					phases: [
						{ id: "prep", type: "script", run: appendProgram(prepMarker, "prep") },
						{ id: "approval", type: "approval", task: "approve finish", dependsOn: ["prep"] },
						{
							id: "finish",
							type: "script",
							run: appendProgram(finishMarker, "finish"),
							dependsOn: ["approval"],
							final: true,
						},
					],
				},
			});
			assert.equal(parked.ok, true, JSON.stringify(parked.error));
			assert.equal(fs.readFileSync(prepMarker, "utf8"), "prep\n");
			assert.equal(fs.existsSync(finishMarker), false);

			const originalCompareAndCommit = host.store.compareAndCommit.bind(host.store);
			let armed = true;
			let cancelPromise: ReturnType<typeof host.cancel> | undefined;
			host.store.compareAndCommit = (opts) => {
				const result = originalCompareAndCommit(opts);
				const continuation = host.store.getContinuation(opts.runId);
				if (
					armed &&
					result.ok &&
					continuation?.activeAttempt?.phaseId === "finish" &&
					continuation.activeAttempt.state === "intent-recorded"
				) {
					armed = false;
					queueMicrotask(() => {
						const current = host.store.getRun(opts.runId);
						assert.ok(current, "downstream intent must retain a durable run");
						cancelPromise = host.cancel(current.runId, {
							commandId: "native-approval-cancel-between-intent-and-submit",
							expectedRunVersion: current.runVersion,
						});
					});
				}
				return result;
			};

			const approved = await host.approve(parked.run!.runId, {
				commandId: "native-approval-cancel-intent-approve",
				principal: "reviewer",
				expectedRunVersion: parked.run!.runVersion,
			});
			assert.ok(cancelPromise, "fixture must schedule cancel after the finish dispatch intent");
			const cancelled = await cancelPromise;

			assert.equal(cancelled.ok, false, JSON.stringify(cancelled.error));
			assert.equal(cancelled.error?.code, "TF_RECONCILE_REQUIRED");
			assert.equal(approved.ok, false, JSON.stringify(approved.error));
			assert.equal(approved.error?.code, "TF_RECONCILE_REQUIRED");
			for (let attempt = 0; attempt < 8; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.equal(fs.existsSync(finishMarker), false, "cancel that linearizes first must suppress script spawn");
			const snapshot = host.getSnapshot(parked.run!.runId);
			assert.equal(snapshot?.run.status, "unknown");
			assert.equal(snapshot?.run.stage, "reconciling");
			assert.equal(
				snapshot?.run.cancelRequest?.commandId,
				"native-approval-cancel-between-intent-and-submit",
			);
			assert.equal(snapshot?.run.cancelRequest?.state, "ambiguous");
			assert.ok(snapshot?.run.reservationId, "cancelled approval continuation must retain capacity");
			assert.notEqual(host.coordinator.getReservation(snapshot!.run.reservationId!)?.state, "released");
			assert.equal(host.store.getReceiptForRun(parked.run!.runId), null);
		} finally {
			host.close();
		}
	} finally {
		t.cleanup();
	}
});

test("native approval CAS after restart dispatches the downstream provider exactly once", async () => {
	const t = temp();
	try {
		const prepMarker = path.join(t.project, "cas-prep.marker");
		const finishMarker = path.join(t.project, "cas-finish.marker");
		const program = {
			name: "native-approval-cas",
			phases: [
				{ id: "prep", type: "script", run: appendProgram(prepMarker, "prep") },
				{
					id: "approval",
					type: "approval",
					task: "One reviewer must approve.",
					dependsOn: ["prep"],
				},
				{
					id: "finish",
					type: "script",
					run: appendProgram(finishMarker, "finish"),
					dependsOn: ["approval"],
					final: true,
				},
			],
		};
		const initial = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			scriptProvider: createScriptExecutionProvider({
				stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs"),
			}),
		});
		const parked = await initial.admitAndRun({ program, commandId: "native-approval-cas-admit" });
		assert.equal(parked.ok, true, JSON.stringify(parked.error));
		const runId = parked.run!.runId;
		const expectedRunVersion = parked.run!.runVersion;
		initial.close();

		const count = 4;
		const barrierDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-native-approval-barrier-"));
		const scriptPath = path.join(helpersDir, "mp-native-approve.mts");
		const children: Array<Promise<{ id: string; status: number; stdout: string; stderr: string }>> = [];
		for (let index = 0; index < count; index += 1) {
			const id = String(index);
			const child: ChildProcess = spawn(
				process.execPath,
				[
					"--conditions=development",
					"--experimental-strip-types",
					scriptPath,
					t.project,
					t.env.TASKFLOW_HOME!,
					runId,
					String(expectedRunVersion),
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
		fs.rmSync(barrierDir, { recursive: true, force: true });
		const parsed = results.map((result) => {
			assert.equal(result.status, 0, `child ${result.id} failed: ${result.stderr}`);
			return JSON.parse(result.stdout) as {
				ok: boolean;
				code: string | null;
				status: string | null;
				receiptId: string | null;
			};
		});
		assert.equal(parsed.filter((result) => result.ok).length, 1, JSON.stringify(parsed));
		for (const result of parsed.filter((result) => !result.ok)) {
			assert.equal(result.code, "TF_STALE_VERSION", JSON.stringify(result));
		}
		assert.equal(fs.readFileSync(prepMarker, "utf8"), "prep\n");
		assert.equal(fs.readFileSync(finishMarker, "utf8"), "finish\n");
	} finally {
		t.cleanup();
	}
});

test("native approval retries the same accepted command after capacity frees across restart without replaying prep", async () => {
	const t = temp();
	try {
		const prepMarker = path.join(t.project, "capacity-prep.marker");
		const finishMarker = path.join(t.project, "capacity-finish.marker");
		const providerStateDir = path.join(t.project, ".taskflow", "control", "provider-jobs");
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			scriptProvider: createScriptExecutionProvider({
				stateDir: providerStateDir,
			}),
		});
		host.coordinator.setMaxActiveRuns(1, {
			commandId: "native-approval-capacity-limit",
			callerPrincipal: "operator",
			requestBody: { maxActiveRuns: 1 },
		});
		const parked = await host.admitAndRun({
			commandId: "native-approval-capacity-admit",
			program: {
				name: "native-approval-capacity",
				phases: [
					{ id: "prep", type: "script", run: appendProgram(prepMarker, "prep") },
					{ id: "approval", type: "approval", task: "approve after capacity frees", dependsOn: ["prep"] },
					{
						id: "finish",
						type: "script",
						run: appendProgram(finishMarker, "finish"),
						dependsOn: ["approval"],
						final: true,
					},
				],
			},
		});
		assert.equal(parked.ok, true, JSON.stringify(parked.error));
		const runId = parked.run!.runId;
		const approvalVersion = parked.run!.runVersion;

		// Occupy the sole slot after park; this fixture has no provider side effect.
		const blocker = host.coordinator.reserve();
		assert.ok(blocker, "fixture must occupy the sole slot");
		const first = await host.approve(runId, {
			commandId: "native-approval-capacity-decision",
			principal: "reviewer",
			expectedRunVersion: approvalVersion,
		});
		assert.equal(first.ok, false);
		assert.equal(first.error?.code, "TF_CAPACITY_EXCEEDED");
		assert.equal(first.run?.stage, "queued");
		assert.equal(first.receipt, undefined);
		assert.equal(fs.readFileSync(prepMarker, "utf8"), "prep\n");
		assert.equal(fs.existsSync(finishMarker), false);

		host.coordinator.releaseUnboundReservation(blocker!.reservationId);
		host.close();

		// Retrying after a fresh host attach proves that the accepted command and
		// queued continuation, rather than in-memory scheduler state, own the retry.
		const restarted = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			scriptProvider: createScriptExecutionProvider({ stateDir: providerStateDir }),
		});
		const retried = await restarted.approve(runId, {
			commandId: "native-approval-capacity-decision",
			principal: "reviewer",
		});
		assert.equal(retried.ok, true, JSON.stringify(retried.error));
		assert.equal(retried.run?.status, "completed");
		assert.ok(retried.receipt);
		assert.equal(fs.readFileSync(prepMarker, "utf8"), "prep\n");
		assert.equal(fs.readFileSync(finishMarker, "utf8"), "finish\n");

		const replay = await restarted.approve(runId, {
			commandId: "native-approval-capacity-decision",
			principal: "reviewer",
		});
		assert.equal(replay.ok, true, JSON.stringify(replay.error));
		assert.equal(replay.receipt?.receiptId, retried.receipt?.receiptId);
		assert.equal(fs.readFileSync(finishMarker, "utf8"), "finish\n");
		restarted.close();
	} finally {
		t.cleanup();
	}
});

test("native approval: expired pre-commit reservation is structured and never re-disclosed as success", async () => {
	const t = temp();
	try {
		const prepMarker = path.join(t.project, "expired-pre-commit-prep.marker");
		const finishMarker = path.join(t.project, "expired-pre-commit-finish.marker");
		const providerStateDir = path.join(t.project, ".taskflow", "control", "provider-jobs");
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			scriptProvider: createScriptExecutionProvider({ stateDir: providerStateDir }),
		});
		try {
			const parked = await host.admitAndRun({
				commandId: "native-approval-expired-pre-commit-admit",
				program: {
					name: "native-approval-expired-pre-commit",
					phases: [
						{ id: "prep", type: "script", run: appendProgram(prepMarker, "prep") },
						{ id: "approval", type: "approval", task: "approve finish", dependsOn: ["prep"] },
						{
							id: "finish",
							type: "script",
							run: appendProgram(finishMarker, "finish"),
							dependsOn: ["approval"],
							final: true,
						},
					],
				},
			});
			assert.equal(parked.ok, true, JSON.stringify(parked.error));
			assert.equal(fs.readFileSync(prepMarker, "utf8"), "prep\n");
			assert.equal(fs.existsSync(finishMarker), false);

			const reserve = host.coordinator.reserve.bind(host.coordinator);
			let expireFirstApprovalReservation = true;
			host.coordinator.reserve = (opts) => {
				const reservation = reserve(opts);
				if (expireFirstApprovalReservation && reservation) {
					expireFirstApprovalReservation = false;
					host.coordinator.reclaimExpiredReserved(reservation.reservedExpiresAt!);
				}
				return reservation;
			};

			const commandId = "native-approval-expired-pre-commit-approve";
			const first = await host.approve(parked.run!.runId, {
				commandId,
				principal: "reviewer",
				expectedRunVersion: parked.run!.runVersion,
			});
			assert.equal(first.ok, false, "an expired reservation must not surface as a raw provider error");
			assert.equal(first.error?.code, "TF_RECONCILE_REQUIRED");
			assert.equal(first.error?.recoveryAction, "operator");
			assert.equal(first.error?.sideEffects, "none");
			assert.equal(first.run?.stage, "admitted");
			assert.equal(first.run?.status, "running");
			assert.ok(first.run?.reservationId);
			assert.equal(host.coordinator.getReservation(first.run!.reservationId!)?.state, "expired");
			assert.equal(host.store.getContinuation(first.run!.runId)?.activeAttempt, undefined);
			assert.equal(fs.existsSync(finishMarker), false, "the expired reservation must precede the finish intent");

			const retry = await host.approve(parked.run!.runId, { commandId, principal: "reviewer" });
			assert.equal(retry.ok, false, "same approval command must not falsely report admitted success");
			assert.equal(retry.error?.code, "TF_RECONCILE_REQUIRED");
			assert.equal(retry.error?.recoveryAction, "operator");
			assert.equal(retry.error?.sideEffects, "none");
			assert.equal(fs.readFileSync(prepMarker, "utf8"), "prep\n", "settled prep is never replayed");
			assert.equal(fs.existsSync(finishMarker), false);
			const events = host.store.readEvents(1, host.store.nextCommitSeq() - 1);
			assert.equal(
				events.filter(
					(event) =>
						event.payload.type === "DispatchIntentRecorded" && event.payload.attempt.phaseId === "finish",
				).length,
				0,
				"native approval has no durable downstream dispatch owner after expiry",
			);
			assert.equal(host.store.getReceiptForRun(parked.run!.runId), null);
		} finally {
			host.close();
		}
	} finally {
		t.cleanup();
	}
});

test("concurrent retry of one accepted native approval command admits one downstream dispatch without a false durability error", async () => {
	const t = temp();
	let barrierDir: string | undefined;
	try {
		const prepMarker = path.join(t.project, "retry-race-prep.marker");
		const finishMarker = path.join(t.project, "retry-race-finish.marker");
		const providerStateDir = path.join(t.project, ".taskflow", "control", "provider-jobs");
		const initial = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			scriptProvider: createScriptExecutionProvider({ stateDir: providerStateDir }),
		});
		initial.coordinator.setMaxActiveRuns(1, {
			commandId: "native-approval-retry-race-limit",
			callerPrincipal: "operator",
			requestBody: { maxActiveRuns: 1 },
		});
		const parked = await initial.admitAndRun({
			commandId: "native-approval-retry-race-admit",
			program: {
				name: "native-approval-retry-race",
				phases: [
					{ id: "prep", type: "script", run: appendProgram(prepMarker, "prep") },
					{ id: "approval", type: "approval", task: "approve once", dependsOn: ["prep"] },
					{
						id: "finish",
						type: "script",
						run: appendProgram(finishMarker, "finish"),
						dependsOn: ["approval"],
						final: true,
					},
				],
			},
		});
		assert.equal(parked.ok, true, JSON.stringify(parked.error));
		const runId = parked.run!.runId;
		const approvalVersion = parked.run!.runVersion;
		const blocker = initial.coordinator.reserve();
		assert.ok(blocker, "fixture must occupy the sole slot");
		const queued = await initial.approve(runId, {
			commandId: "native-approval-retry-race-command",
			principal: "reviewer",
			expectedRunVersion: approvalVersion,
		});
		assert.equal(queued.ok, false);
		assert.equal(queued.error?.code, "TF_CAPACITY_EXCEEDED");
		initial.coordinator.releaseUnboundReservation(blocker!.reservationId);
		initial.close();

		const count = 4;
		barrierDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-native-approval-retry-race-"));
		const scriptPath = path.join(helpersDir, "mp-native-approve.mts");
		const children: Array<Promise<{ id: string; status: number; stdout: string; stderr: string }>> = [];
		for (let index = 0; index < count; index += 1) {
			const id = String(index);
			const child: ChildProcess = spawn(
				process.execPath,
				[
					"--conditions=development",
					"--experimental-strip-types",
					scriptPath,
					t.project,
					t.env.TASKFLOW_HOME!,
					runId,
					String(approvalVersion),
					"native-approval-retry-race-command",
					"reviewer",
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
				ok: boolean;
				code: string | null;
				message: string | null;
				recoveryAction: string | null;
				sideEffects: string | null;
				status: string | null;
				receiptId: string | null;
			};
		});
		assert.ok(parsed.some((result) => result.ok && result.receiptId), JSON.stringify(parsed));
		for (const result of parsed.filter((result) => !result.ok)) {
			assert.ok(
				result.code === "TF_CAPACITY_EXCEEDED" || result.code === "TF_RECONCILE_REQUIRED",
				JSON.stringify(parsed),
			);
			if (result.code === "TF_CAPACITY_EXCEEDED") {
				assert.equal(result.recoveryAction, "retry-same-command", JSON.stringify(parsed));
				assert.equal(result.sideEffects, "none", JSON.stringify(parsed));
			} else {
				// A losing contender can observe the winner after project admission but
				// before that legacy native path durably records its first intent. Until
				// P16-1R supplies that owner, it must stop explicitly, not report a
				// torn Run/Continuation pair as TF_DURABILITY_FAILED or synthesize success.
				assert.equal(result.recoveryAction, "operator", JSON.stringify(parsed));
				assert.equal(result.sideEffects, "unknown", JSON.stringify(parsed));
				assert.equal(result.receiptId, null, JSON.stringify(parsed));
			}
		}
		assert.equal(fs.readFileSync(prepMarker, "utf8"), "prep\n");
		assert.equal(fs.readFileSync(finishMarker, "utf8"), "finish\n");
	} finally {
		if (barrierDir) fs.rmSync(barrierDir, { recursive: true, force: true });
		t.cleanup();
	}
});

test("journal snapshot: read-only attach derives Run and continuation from one journal tail", async () => {
	const t = temp();
	const host = createControlHost({
		projectRoot: t.project,
		env: t.env,
		skipSingleton: true,
		controlMode: "standalone",
		scriptProvider: createScriptExecutionProvider({
			stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs"),
		}),
	});
	try {
		const parked = await host.admitAndRun({
			commandId: "journal-snapshot-attach-admit",
			program: {
				name: "journal-snapshot-attach",
				phases: [
					{ id: "prep", type: "script", run: appendProgram(path.join(t.project, "snapshot-prep.marker"), "prep") },
					{ id: "approval", type: "approval", task: "pause for snapshot", dependsOn: ["prep"] },
				],
			},
		});
		assert.equal(parked.ok, true, JSON.stringify(parked.error));
		const runId = parked.run!.runId;
		const priorRun = host.store.getRun(runId);
		const priorContinuation = host.store.getContinuation(runId);
		assert.ok(priorRun);
		assert.ok(priorContinuation);
		const projectionPath = path.join(t.project, ".taskflow", "control", "projections", `run-${runId}.json`);
		const staleProjection = fs.readFileSync(projectionPath, "utf8");
		const attach = openProjectControlStore(t.project, { readOnly: true });
		const now = Math.max(Date.now(), priorContinuation.updatedAt + 1, priorRun.updatedAt + 1);
		const nextContinuation: typeof priorContinuation = {
			...priorContinuation,
			updatedAt: now,
			version: priorContinuation.version + 1,
		};
		const nextRun: typeof priorRun = {
			...priorRun,
			updatedAt: now,
			runVersion: priorRun.runVersion + 1,
		};
		host.store.commit({
			run: nextRun,
			events: [
				{
					eventId: "journal-snapshot-continuation-update",
					schemaVersion: 1,
					controlDomainId: host.store.header.controlDomainId,
					streamId: runId,
					streamSeq: 0,
					commitSeq: 0,
					projectId: host.store.header.projectId,
					recordedAt: now,
					payload: { type: "ContinuationStored", continuation: nextContinuation },
				},
			],
		});

		// This is the durable writer publication window: journal tail is newer than
		// the rebuildable projection. An attach must never compose this old file
		// with the newer ContinuationStored record.
		fs.writeFileSync(projectionPath, staleProjection, "utf8");
		assert.equal(attach.getRun(runId)?.runVersion, priorRun.runVersion, "fixture must expose the stale derived Run");
		const snapshot = attach.getJournalRunSnapshot(runId);
		assert.equal(snapshot.run?.runVersion, nextRun.runVersion);
		assert.equal(snapshot.continuation?.version, nextContinuation.version);
		assert.equal(snapshot.approval?.approvalRequestId, priorRun.approvalRequestId);
		assert.equal(snapshot.receipt, null);

		// Restore the derived file before shutdown; the assertion above intentionally
		// models only the finite publication window, not journal corruption.
		host.store.recoverFromJournal();
	} finally {
		host.close();
		t.cleanup();
	}
});

test("same native approval command never succeeds from a pre-submit intent or reconciling snapshot", async () => {
	const t = temp();
	const finishMarker = path.join(t.project, "intent-disclosure-finish.marker");
	const host = createControlHost({
		projectRoot: t.project,
		env: t.env,
		skipSingleton: true,
		controlMode: "standalone",
		scriptProvider: createScriptExecutionProvider({
			stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs"),
		}),
	});
	try {
		host.coordinator.setMaxActiveRuns(1, {
			commandId: "intent-disclosure-limit",
			callerPrincipal: "operator",
			requestBody: { maxActiveRuns: 1 },
		});
		const parked = await host.admitAndRun({
			commandId: "intent-disclosure-admit",
			program: {
				name: "intent-disclosure",
				phases: [
					{ id: "prep", type: "script", run: appendProgram(path.join(t.project, "intent-disclosure-prep.marker"), "prep") },
					{ id: "approval", type: "approval", task: "approve exactly once", dependsOn: ["prep"] },
					{ id: "finish", type: "script", run: appendProgram(finishMarker, "finish"), dependsOn: ["approval"], final: true },
				],
			},
		});
		assert.equal(parked.ok, true, JSON.stringify(parked.error));
		const runId = parked.run!.runId;
		const commandId = "intent-disclosure-approve";
		const blocker = host.coordinator.reserve();
		assert.ok(blocker);
		const queued = await host.approve(runId, {
			commandId,
			principal: "reviewer",
			expectedRunVersion: parked.run!.runVersion,
		});
		assert.equal(queued.ok, false);
		assert.equal(queued.error?.code, "TF_CAPACITY_EXCEEDED");
		host.coordinator.releaseUnboundReservation(blocker.reservationId);
		const queuedRun = host.store.getRun(runId);
		const queuedContinuation = host.store.getContinuation(runId);
		assert.ok(queuedRun);
		assert.ok(queuedContinuation);
		const now = Math.max(Date.now(), queuedRun.updatedAt + 1, queuedContinuation.updatedAt + 1);
		const intentAttempt = {
			attemptId: "intent-disclosure-attempt",
			phaseId: "finish",
			type: "script",
			idempotencyKey: `${runId}:finish:intent-disclosure-attempt`,
			providerName: "script",
			state: "intent-recorded" as const,
			createdAt: now,
			updatedAt: now,
		};
		const intentContinuation: typeof queuedContinuation = {
			...queuedContinuation,
			status: "active",
			activeAttempt: intentAttempt,
			updatedAt: now,
			version: queuedContinuation.version + 1,
		};
		const intentRun: typeof queuedRun = {
			...queuedRun,
			status: "running",
			stage: "executing",
			updatedAt: now,
			runVersion: queuedRun.runVersion + 1,
		};
		host.store.commit({
			run: intentRun,
			events: [
				{
					eventId: "intent-disclosure-status",
					schemaVersion: 1,
					controlDomainId: host.store.header.controlDomainId,
					streamId: runId,
					streamSeq: 0,
					commitSeq: 0,
					projectId: host.store.header.projectId,
					recordedAt: now,
					payload: { type: "RunStatusChanged", runId, status: "running", stage: "executing" },
				},
				{
					eventId: "intent-disclosure-continuation",
					schemaVersion: 1,
					controlDomainId: host.store.header.controlDomainId,
					streamId: runId,
					streamSeq: 0,
					commitSeq: 0,
					projectId: host.store.header.projectId,
					recordedAt: now,
					payload: { type: "ContinuationStored", continuation: intentContinuation },
				},
				{
					eventId: "intent-disclosure-recorded",
					schemaVersion: 1,
					controlDomainId: host.store.header.controlDomainId,
					streamId: runId,
					streamSeq: 0,
					commitSeq: 0,
					projectId: host.store.header.projectId,
					recordedAt: now,
					payload: {
						type: "DispatchIntentRecorded",
						runId,
						continuationId: intentContinuation.continuationId,
						attempt: intentAttempt,
					},
				},
			],
		});
		const preSubmitReplay = await host.approve(runId, { commandId, principal: "reviewer" });
		assert.equal(preSubmitReplay.ok, false, JSON.stringify(preSubmitReplay));
		assert.equal(preSubmitReplay.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(preSubmitReplay.run?.stage, "executing");
		assert.equal(preSubmitReplay.receipt, undefined);
		assert.equal(fs.existsSync(finishMarker), false, "a disclosure must not submit the pre-recorded intent");

		const reconcilingRun: typeof intentRun = {
			...intentRun,
			status: "unknown",
			stage: "reconciling",
			needsOperator: true,
			updatedAt: now + 1,
			runVersion: intentRun.runVersion + 1,
		};
		host.store.commit({
			run: reconcilingRun,
			events: [
				{
					eventId: "intent-disclosure-reconciling",
					schemaVersion: 1,
					controlDomainId: host.store.header.controlDomainId,
					streamId: runId,
					streamSeq: 0,
					commitSeq: 0,
					projectId: host.store.header.projectId,
					recordedAt: now + 1,
					payload: { type: "RunStatusChanged", runId, status: "unknown", stage: "reconciling" },
				},
				{
					eventId: "intent-disclosure-needs-operator",
					schemaVersion: 1,
					controlDomainId: host.store.header.controlDomainId,
					streamId: runId,
					streamSeq: 0,
					commitSeq: 0,
					projectId: host.store.header.projectId,
					recordedAt: now + 1,
					payload: { type: "NeedsOperator", runId, code: "TF_RECONCILE_REQUIRED" },
				},
			],
		});
		const reconcilingReplay = await host.approve(runId, { commandId, principal: "reviewer" });
		assert.equal(reconcilingReplay.ok, false, JSON.stringify(reconcilingReplay));
		assert.equal(reconcilingReplay.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(reconcilingReplay.run?.stage, "reconciling");
		assert.equal(reconcilingReplay.receipt, undefined);
		assert.equal(fs.existsSync(finishMarker), false);
	} finally {
		host.close();
		t.cleanup();
	}
});

test("native approval: authority lost after downstream intent suppresses the real script submit", async () => {
	const t = temp();
	try {
		const prepMarker = path.join(t.project, "authority-prep.marker");
		const finishMarker = path.join(t.project, "authority-finish.marker");
		const providerStateDir = path.join(t.project, ".taskflow", "control", "provider-jobs");
		let remainingAuthorityChecks: number | undefined;
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			mutationAuthority: () => {
				if (remainingAuthorityChecks === undefined) return true;
				if (remainingAuthorityChecks <= 0) return false;
				remainingAuthorityChecks -= 1;
				return true;
			},
			scriptProvider: createScriptExecutionProvider({ stateDir: providerStateDir }),
		});
		try {
			const parked = await host.admitAndRun({
				commandId: "authority-native-approval-admit",
				program: {
					name: "authority-native-approval",
					phases: [
						{ id: "prep", type: "script", run: appendProgram(prepMarker, "prep") },
						{ id: "approval", type: "approval", task: "approve finish", dependsOn: ["prep"] },
						{
							id: "finish",
							type: "script",
							run: appendProgram(finishMarker, "finish"),
							dependsOn: ["approval"],
							final: true,
						},
					],
				},
			});
			assert.equal(parked.ok, true, JSON.stringify(parked.error));
			assert.equal(fs.readFileSync(prepMarker, "utf8"), "prep\n");

			// approve() is allowed to make its public authority check. Its immediate
			// pre-submit check for `finish` must then deny the external side effect.
			remainingAuthorityChecks = 1;
			const denied = await host.approve(parked.run!.runId, {
				commandId: "authority-native-approval-approve",
				principal: "reviewer",
				expectedRunVersion: parked.run!.runVersion,
			});
			assert.equal(denied.ok, false);
			assert.equal(denied.error?.code, "TF_AUTHORITY_REVOKED");
			assert.equal(denied.error?.recoveryAction, "retry-same-command");
			assert.equal(denied.error?.sideEffects, "none");
			assert.equal(denied.receipt, undefined);
			assert.equal(fs.existsSync(finishMarker), false, "finish must never be submitted");
			assert.equal(denied.run?.status, "running");
			assert.equal(denied.run?.stage, "executing");
			assert.ok(denied.run?.reservationId, "durable intent keeps capacity held");

			const continuation = host.store.getContinuation(parked.run!.runId);
			assert.equal(continuation?.activeAttempt?.phaseId, "finish");
			assert.equal(continuation?.activeAttempt?.state, "intent-recorded");
			assert.equal(fs.readFileSync(prepMarker, "utf8"), "prep\n", "completed work is not replayed");
		} finally {
			host.close();
		}
	} finally {
		t.cleanup();
	}
});

test("native approval: authority lost after downstream spawn reports possible side effects", async () => {
	const t = temp();
	try {
		const prepMarker = path.join(t.project, "authority-after-spawn-prep.marker");
		const finishMarker = path.join(t.project, "authority-after-spawn-finish.marker");
		const providerStateDir = path.join(t.project, ".taskflow", "control", "provider-jobs");
		let resumingApproval = false;
		let approvalAuthorityChecks = 0;
		let providerFenceEntered = false;
		let providerFenceCompleted = false;
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			mutationAuthority: () => {
				if (!resumingApproval) return true;
				approvalAuthorityChecks += 1;
				// approve() public check is first; the scheduler pre-check is second.
				if (approvalAuthorityChecks === 2) providerFenceEntered = true;
				return true;
			},
			mutationFence: <T>(fn: () => T): T => {
				if (providerFenceEntered && !providerFenceCompleted) {
					const result = fn();
					providerFenceCompleted = true;
					return result;
				}
				if (providerFenceCompleted) {
					throw new SingletonAuthorityError("test takeover after native approval spawn");
				}
				return fn();
			},
			scriptProvider: createScriptExecutionProvider({ stateDir: providerStateDir }),
		});
		try {
			const parked = await host.admitAndRun({
				commandId: "authority-after-spawn-approval-admit",
				program: {
					name: "authority-after-spawn-approval",
					phases: [
						{ id: "prep", type: "script", run: appendProgram(prepMarker, "prep") },
						{ id: "approval", type: "approval", task: "approve finish", dependsOn: ["prep"] },
						{
							id: "finish",
							type: "script",
							run: appendProgram(finishMarker, "finish"),
							dependsOn: ["approval"],
							final: true,
						},
					],
				},
			});
			assert.equal(parked.ok, true, JSON.stringify(parked.error));

			resumingApproval = true;
			const result = await host.approve(parked.run!.runId, {
				commandId: "authority-after-spawn-approval-approve",
				principal: "reviewer",
				expectedRunVersion: parked.run!.runVersion,
			});
			assert.equal(result.ok, false);
			assert.equal(result.error?.code, "TF_AUTHORITY_REVOKED");
			assert.equal(result.error?.recoveryAction, "reconcile");
			assert.equal(result.error?.sideEffects, "possible");
			assert.equal(result.receipt, undefined);
			assert.equal(result.run?.status, "running");
			assert.equal(result.run?.stage, "executing");
			assert.ok(result.run?.reservationId);
			assert.equal(approvalAuthorityChecks, 3);

			for (let attempt = 0; attempt < 20 && !fs.existsSync(finishMarker); attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			assert.equal(fs.existsSync(finishMarker), true, "finish may already have started");
			assert.equal(fs.readFileSync(prepMarker, "utf8"), "prep\n");
			const continuation = host.store.getContinuation(parked.run!.runId);
			assert.equal(continuation?.activeAttempt?.phaseId, "finish");
			assert.equal(continuation?.activeAttempt?.state, "intent-recorded");
			assert.equal(continuation?.activeAttempt?.providerHandle, undefined);
		} finally {
			host.close();
		}
	} finally {
		t.cleanup();
	}
});
