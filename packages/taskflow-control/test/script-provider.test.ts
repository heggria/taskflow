/**
 * Real ScriptExecutionProvider — truthful exit codes and no mock default in prod path.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	createControlHost,
	createScriptExecutionProvider,
	bootstrapControl,
} from "../src/index.ts";

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
