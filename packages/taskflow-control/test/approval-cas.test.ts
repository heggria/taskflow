/**
 * Dual-client approval CAS (P15): expectedRunVersion first-commit-wins.
 * Includes true-parallel multi-process race (spawn + barrier).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	createControlHost,
	createMockExecutionProvider,
	openUserCoordinatorStore,
	projectCoordinatorDir,
} from "../src/index.ts";
import { parentReleaseStart } from "./helpers/mp-barrier.mts";

const SCRIPT_FLOW = {
	name: "cas-flow",
	phases: [{ id: "main", type: "script", run: "true", final: true }],
};

const helpersDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers");

function temp(): { env: NodeJS.ProcessEnv; project: string; home: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-cas-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-cas-proj-"));
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

test("dual-client approval CAS: stale expectedRunVersion loses (sequential)", async () => {
	const t = temp();
	try {
		const provider = createMockExecutionProvider({ outcome: "hang" });
		const a = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});
		const b = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});

		const admitted = await a.admitAndRun({ program: SCRIPT_FLOW, commandId: "cas-1" });
		const runId = admitted.run!.runId;
		provider.quiesceAll?.();

		const snap = a.getSnapshot(runId)!;
		const v0 = snap.run.runVersion;
		const parked = await a.parkForApproval(runId, { expectedRunVersion: v0 });
		assert.equal(parked.ok, true, JSON.stringify(parked.error));
		const vParked = parked.run!.runVersion;
		assert.ok(vParked > v0);

		const stale = await b.approve(runId, { expectedRunVersion: v0 });
		assert.equal(stale.ok, false);
		assert.equal(stale.error?.code, "TF_STALE_VERSION");

		const winningRequest = {
			commandId: "approve-winning-command",
			principal: "alice",
			expectedRunVersion: vParked,
		};
		const fresh = await b.approve(runId, winningRequest);
		assert.equal(fresh.ok, false);
		assert.equal(fresh.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(fresh.run?.status, "unknown");
		assert.equal(fresh.run?.stage, "reconciling");
		assert.equal(fresh.receipt, undefined);

		assert.equal(b.store.getCommand("approve-winning-command")?.status, "accepted");
		const retry = await a.approve(runId, winningRequest);
		assert.equal(retry.ok, false);
		assert.equal(retry.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(retry.run?.runVersion, fresh.run?.runVersion);
		const crossPrincipal = await a.approve(runId, { ...winningRequest, principal: "bob" });
		assert.equal(crossPrincipal.ok, false);
		assert.equal(crossPrincipal.error?.code, "TF_CROSS_PRINCIPAL_COMMAND");

		const again = await a.approve(runId, {
			commandId: "approve-losing-command",
			expectedRunVersion: vParked,
		});
		assert.equal(again.ok, false);
		assert.ok(
			again.error?.code === "TF_STALE_VERSION" || again.error?.code === "TF_INVALID_ARGUMENT",
		);

		// Approval is not provider completion: no Receipt exists yet.
		const receiptsDir = path.join(t.project, ".taskflow", "control", "receipts");
		const receiptFiles = fs
			.readdirSync(receiptsDir)
			.filter((f) => f.endsWith(".json") && !f.startsWith("by-run-"));
		assert.equal(receiptFiles.length, 0, `expected no receipt file, got ${receiptFiles.join(",")}`);

		a.close();
		b.close();
	} finally {
		t.cleanup();
	}
});

test("approve requires paused AND parked (not OR)", async () => {
	const t = temp();
	try {
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createMockExecutionProvider({ outcome: "completed" }),
		});
		// Completed run: status completed, stage terminal — neither alone should pass
		const r = await host.admitAndRun({ program: SCRIPT_FLOW });
		assert.equal(r.ok, true);
		const bad = await host.approve(r.run!.runId, { expectedRunVersion: r.run!.runVersion });
		assert.equal(bad.ok, false);
		assert.equal(bad.error?.code, "TF_INVALID_ARGUMENT");
		// Terminal+Receipt immutability wins over parked check for completed runs
		assert.match(bad.error?.message ?? "", /terminal|paused\+parked|Receipt/);
		host.close();
	} finally {
		t.cleanup();
	}
});

test("approve coordinator commit failure stays accepted and enters recoverable saga", async () => {
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
		const admitted = await host.admitAndRun({ program: SCRIPT_FLOW });
		provider.quiesceAll?.();
		const parked = await host.parkForApproval(admitted.run!.runId, {
			expectedRunVersion: host.getSnapshot(admitted.run!.runId)!.run.runVersion,
		});
		assert.equal(parked.ok, true, JSON.stringify(parked.error));

		host.coordinator.commitReservation = () => {
			throw new Error("injected coordinator commit failure");
		};
		const result = await host.approve(admitted.run!.runId, {
			commandId: "approve-coordinator-failure",
			principal: "alice",
			expectedRunVersion: parked.run!.runVersion,
		});
		assert.equal(result.ok, false);
		assert.equal(result.error?.code, "TF_RECONCILE_REQUIRED");
		assert.match(result.error?.message ?? "", /injected coordinator commit failure/);
		assert.equal(result.run?.status, "unknown");
		assert.equal(result.run?.stage, "reconciling");
		assert.equal(result.run?.needsOperator, true);
		assert.equal(host.store.getCommand("approve-coordinator-failure")?.status, "accepted");
		assert.equal(host.store.getReceiptForRun(admitted.run!.runId), null);
		assert.equal(
			host.coordinator.getReservation(result.run!.reservationId!)?.state,
			"orphan-suspect",
		);
		host.close();
	} finally {
		t.cleanup();
	}
});

test("park release failure retains reservation binding and needs operator", async () => {
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
		const admitted = await host.admitAndRun({ program: SCRIPT_FLOW });
		const reservationId = admitted.run!.reservationId!;
		provider.quiesceAll?.();
		host.coordinator.normalRelease = () => {
			throw new Error("injected release failure");
		};
		const result = await host.parkForApproval(admitted.run!.runId, {
			expectedRunVersion: host.getSnapshot(admitted.run!.runId)!.run.runVersion,
		});
		assert.equal(result.ok, false);
		assert.equal(result.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(result.run?.status, "paused");
		assert.equal(result.run?.stage, "parked");
		assert.equal(result.run?.reservationId, reservationId);
		assert.equal(result.run?.needsOperator, true);
		host.close();
	} finally {
		t.cleanup();
	}
});

test("cancel CAS: stale version rejected", async () => {
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
		const r = await host.admitAndRun({ program: SCRIPT_FLOW });
		const runId = r.run!.runId;
		const v = r.run!.runVersion;
		const bad = await host.cancel(runId, { expectedRunVersion: v - 1 });
		assert.equal(bad.ok, false);
		assert.equal(bad.error?.code, "TF_STALE_VERSION");
		const winningRequest = {
			commandId: "cancel-winning-command",
			principal: "alice",
			expectedRunVersion: host.getSnapshot(runId)!.run.runVersion,
		};
		const ok = await host.cancel(runId, winningRequest);
		assert.equal(ok.ok, true);
		assert.equal(ok.run?.status, "cancelled");
		assert.equal(host.store.getCommand("cancel-winning-command")?.status, "completed");
		const retry = await host.cancel(runId, winningRequest);
		assert.equal(retry.ok, true);
		assert.equal(retry.run?.runVersion, ok.run?.runVersion);
		host.close();
	} finally {
		t.cleanup();
	}
});

test("cancel without a recoverable provider handle stays unknown and holds capacity", async () => {
	const t = temp();
	try {
		const first = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createMockExecutionProvider({ outcome: "hang" }),
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});
		const admitted = await first.admitAndRun({ program: SCRIPT_FLOW });
		const runId = admitted.run!.runId;
		const reservationId = admitted.run!.reservationId!;
		first.close();

		// New host has durable Run state but no process-local provider handle.
		const reopened = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createMockExecutionProvider({ outcome: "completed" }),
		});
		const cancelled = await reopened.cancel(runId, {
			commandId: "cancel-missing-handle",
			expectedRunVersion: reopened.getSnapshot(runId)!.run.runVersion,
		});
		assert.equal(cancelled.ok, false);
		assert.equal(cancelled.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(cancelled.run?.status, "unknown");
		assert.equal(cancelled.run?.stage, "reconciling");
		assert.equal(cancelled.run?.needsOperator, true);
		assert.equal(reopened.coordinator.getReservation(reservationId)?.state, "orphan-suspect");
		assert.equal(reopened.coordinator.occupyingCount(), 1);
		assert.equal(reopened.store.getReceiptForRun(runId), null);
		assert.equal(reopened.store.getCommand("cancel-missing-handle")?.status, "accepted");
		reopened.close();
	} finally {
		t.cleanup();
	}
});

test("cancel may settle a reopened paused+parked run using durable quiescence proof", async () => {
	const t = temp();
	try {
		const provider = createMockExecutionProvider({ outcome: "hang" });
		const first = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});
		const admitted = await first.admitAndRun({ program: SCRIPT_FLOW });
		const runId = admitted.run!.runId;
		provider.quiesceAll?.();
		const parked = await first.parkForApproval(runId, {
			expectedRunVersion: first.getSnapshot(runId)!.run.runVersion,
		});
		assert.equal(parked.run?.stage, "parked");
		first.close();

		const reopened = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createMockExecutionProvider({ outcome: "completed" }),
		});
		const cancelled = await reopened.cancel(runId, {
			commandId: "cancel-parked",
			expectedRunVersion: reopened.getSnapshot(runId)!.run.runVersion,
		});
		assert.equal(cancelled.ok, true, JSON.stringify(cancelled.error));
		assert.equal(cancelled.run?.status, "cancelled");
		assert.equal(cancelled.run?.stage, "terminal");
		assert.equal(reopened.store.getCommand("cancel-parked")?.status, "completed");
		reopened.close();
	} finally {
		t.cleanup();
	}
});

/**
 * True-parallel dual-client approve: N children share the same expectedRunVersion,
 * barrier-release together, exactly one winner re-queues without a Receipt.
 */
test("multi-process parallel approve CAS: one accepted saga, no fake success or Receipt", async () => {
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
		const admitted = await host.admitAndRun({ program: SCRIPT_FLOW, commandId: "mp-cas" });
		const runId = admitted.run!.runId;
		provider.quiesceAll?.();
		const v0 = host.getSnapshot(runId)!.run.runVersion;
		const parked = await host.parkForApproval(runId, { expectedRunVersion: v0 });
		assert.equal(parked.ok, true, JSON.stringify(parked.error));
		const expectedRunVersion = parked.run!.runVersion;
		host.close();

		const N = 6;
		// Standalone children use project-local coordinator — raise capacity there.
		const coord = openUserCoordinatorStore(t.env, {
			baseDir: projectCoordinatorDir(t.project),
		});
		coord.setMaxActiveRuns({
			value: N + 2,
			expectedMaxActiveRuns: 4,
			expectedCoordinatorEpoch: 0,
		}, {
			commandId: "mp-cas-cap",
			callerPrincipal: "op",
		});

		const barrierDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-cas-barrier-"));
		const scriptPath = path.join(helpersDir, "mp-approve.mts");
		const children: Array<{ done: Promise<{ status: number; stdout: string; stderr: string; id: string }> }> =
			[];

		for (let i = 0; i < N; i++) {
			const id = String(i);
			const child: ChildProcess = spawn(
				process.execPath,
				[
					"--conditions=development",
					"--experimental-strip-types",
					scriptPath,
					t.project,
					t.home,
					runId,
					String(expectedRunVersion),
				],
				{
					env: { ...process.env, TF_MP_BARRIER: barrierDir, TF_MP_ID: id },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			const done = new Promise<{ status: number; stdout: string; stderr: string; id: string }>(
				(resolve) => {
					let stdout = "";
					let stderr = "";
					child.stdout?.setEncoding("utf-8");
					child.stderr?.setEncoding("utf-8");
					child.stdout?.on("data", (c: string) => {
						stdout += c;
					});
					child.stderr?.on("data", (c: string) => {
						stderr += c;
					});
					const timer = setTimeout(() => {
						try {
							child.kill("SIGKILL");
						} catch {
							/* ignore */
						}
						resolve({ status: 124, stdout, stderr: stderr + "\ntimeout", id });
					}, 30_000);
					child.on("close", (code) => {
						clearTimeout(timer);
						resolve({ status: code ?? 1, stdout, stderr, id });
					});
				},
			);
			children.push({ done });
		}

		parentReleaseStart(barrierDir, N, 15_000);
		const results = await Promise.all(children.map((c) => c.done));
		try {
			fs.rmSync(barrierDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}

		const parsed = results.map((r) => {
			assert.equal(r.status, 0, `child ${r.id} failed: ${r.stderr}\n${r.stdout}`);
			return JSON.parse(r.stdout) as {
				ok: boolean;
				code: string | null;
				receiptId: string | null;
				status: string | null;
				stage: string | null;
			};
		});

		assert.equal(parsed.filter((p) => p.ok === true).length, 0);
		const accepted = parsed.filter((p) => p.code === "TF_RECONCILE_REQUIRED");
		const stale = parsed.filter((p) => p.code === "TF_STALE_VERSION");
		assert.ok(accepted.length >= 1, JSON.stringify(parsed));
		assert.equal(accepted.length + stale.length, N, JSON.stringify(parsed));
		assert.equal(accepted[0]!.receiptId, null);
		assert.equal(accepted[0]!.status, "unknown");
		assert.equal(accepted[0]!.stage, "reconciling");
		for (const result of parsed) assert.equal(result.receiptId, null);
		const approveCommands = fs
			.readdirSync(path.join(t.project, ".taskflow", "control", "commands"))
			.filter((file) => file.endsWith(".json") && !file.startsWith("by-cmd-"))
			.map((file) => JSON.parse(fs.readFileSync(
				path.join(t.project, ".taskflow", "control", "commands", file),
				"utf8",
			)) as { kind?: string; status?: string })
			.filter((command) => command.kind === "approve" && command.status === "accepted");
		assert.equal(approveCommands.length, 1, "exactly one approve command may win durable CAS");

		// Durable store: approval alone never creates a Receipt artifact.
		const receiptsDir = path.join(t.project, ".taskflow", "control", "receipts");
		const receiptFiles = fs
			.readdirSync(receiptsDir)
			.filter((f) => f.endsWith(".json") && !f.startsWith("by-run-"));
		assert.equal(
			receiptFiles.length,
			0,
			`expected no durable receipt, got ${receiptFiles.join(",")}`,
		);
		assert.equal(fs.existsSync(path.join(receiptsDir, `by-run-${runId}.json`)), false);
	} finally {
		t.cleanup();
	}
});
