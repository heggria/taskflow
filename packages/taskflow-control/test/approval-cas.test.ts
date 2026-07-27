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

test("approval rejects stale versions and remains parked until continuation is durable", async () => {
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

		const fresh = await b.approve(runId, { expectedRunVersion: vParked });
		assert.equal(fresh.ok, false);
		assert.equal(fresh.error?.code, "TF_FEATURE_REQUIRED");
		assert.equal(fresh.run?.status, "paused");
		assert.equal(fresh.run?.stage, "parked");
		assert.equal(fresh.receipt, undefined);

		const again = await a.approve(runId, { expectedRunVersion: vParked });
		assert.equal(again.ok, false);
		assert.equal(again.error?.code, "TF_FEATURE_REQUIRED");

		// No Receipt is allowed while there is no durable resume/attempt protocol.
		const receiptsDir = path.join(t.project, ".taskflow", "control", "receipts");
		const receiptFiles = fs
			.readdirSync(receiptsDir)
			.filter((f) => f.endsWith(".json") && !f.startsWith("by-run-"));
		assert.equal(receiptFiles.length, 0, `unexpected receipt file: ${receiptFiles.join(",")}`);

		a.close();
		b.close();
	} finally {
		t.cleanup();
	}
});

test("approval never signs a Receipt when no durable provider continuation exists", async () => {
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
		const admitted = await host.admitAndRun({ program: SCRIPT_FLOW, commandId: "approve-no-resume" });
		const runId = admitted.run!.runId;
		provider.quiesceAll?.();
		const parked = await host.parkForApproval(runId, {
			expectedRunVersion: host.getSnapshot(runId)!.run.runVersion,
		});
		assert.equal(parked.ok, true, JSON.stringify(parked.error));

		const approved = await host.approve(runId, {
			expectedRunVersion: parked.run!.runVersion,
		});
		assert.equal(approved.ok, false, "approval must not manufacture a terminal success");
		assert.equal(approved.error?.code, "TF_FEATURE_REQUIRED");
		assert.equal(approved.receipt, undefined);
		assert.equal(host.getSnapshot(runId)?.run.status, "paused");
		assert.equal(host.getSnapshot(runId)?.run.stage, "parked");
		assert.equal(host.getSnapshot(runId)?.receipt, null);
		host.close();
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

test("cancel CAS: stale version rejected; bare mock cancellation remains nonterminal", async () => {
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
		const unresolved = await host.cancel(runId, {
			expectedRunVersion: host.getSnapshot(runId)!.run.runVersion,
		});
		assert.equal(unresolved.ok, false, JSON.stringify(unresolved.error));
		assert.equal(unresolved.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(unresolved.run?.status, "unknown");
		assert.equal(unresolved.run?.cancelRequest?.state, "ambiguous");
		assert.ok(unresolved.run?.reservationId);
		assert.notEqual(host.coordinator.getReservation(unresolved.run!.reservationId!)?.state, "released");
		assert.equal(host.store.getReceiptForRun(runId), null);
		host.close();
	} finally {
		t.cleanup();
	}
});

/** All concurrent approval callers fail closed without issuing a Receipt. */
test("multi-process approval attempts preserve a parked run without a Receipt", async () => {
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
			};
		});

		for (const result of parsed) {
			assert.equal(result.ok, false, JSON.stringify(parsed));
			assert.equal(result.code, "TF_FEATURE_REQUIRED", JSON.stringify(parsed));
			assert.equal(result.status, "paused");
			assert.equal(result.receiptId, null);
		}

		// Durable store remains parked with no Receipt artifact.
		const receiptsDir = path.join(t.project, ".taskflow", "control", "receipts");
		const receiptFiles = fs
			.readdirSync(receiptsDir)
			.filter((f) => f.endsWith(".json") && !f.startsWith("by-run-"));
		assert.equal(receiptFiles.length, 0, `unexpected durable receipt: ${receiptFiles.join(",")}`);
		assert.equal(fs.existsSync(path.join(receiptsDir, `by-run-${runId}.json`)), false);
	} finally {
		t.cleanup();
	}
});
