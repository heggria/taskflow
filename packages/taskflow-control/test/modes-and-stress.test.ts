/**
 * controlMode fail-closed, 20-process singleton, concurrent same commandId.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	bootstrapControl,
	createControlHost,
	createScriptExecutionProvider,
	projectCoordinatorDir,
	coordinatorDir,
} from "../src/index.ts";
import { parentReleaseStart } from "./helpers/mp-barrier.mts";

const helpersDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers");

function temp(): { env: NodeJS.ProcessEnv; home: string; project: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mode-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mode-proj-"));
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

test("coordinated mode with no existing writer fails closed (TF_BOOTSTRAP_FAILED)", () => {
	const t = temp();
	try {
		assert.throws(
			() =>
				bootstrapControl({
					projectRoot: t.project,
					env: t.env,
					controlMode: "coordinated",
					holderId: "coord-alone",
					provider: createScriptExecutionProvider(),
				}),
			(e: unknown) => {
				const err = e as { code?: string; message?: string };
				assert.equal(err.code, "TF_BOOTSTRAP_FAILED");
				assert.match(err.message ?? "", /existing multi-mount writer|no authority/i);
				return true;
			},
		);
	} finally {
		t.cleanup();
	}
});

test("coordinated mode attaches when writer already holds singleton", async () => {
	const t = temp();
	try {
		const writer = bootstrapControl({
			projectRoot: t.project,
			env: t.env,
			controlMode: "auto",
			holderId: "writer-1",
			provider: createScriptExecutionProvider(),
		});
		assert.equal(writer.role, "writer");

		const client = bootstrapControl({
			projectRoot: t.project,
			env: t.env,
			controlMode: "coordinated",
			holderId: "coord-client",
			provider: createScriptExecutionProvider(),
		});
		assert.equal(client.role, "attach");
		assert.equal(client.host.canMutate, false);

		const denied = await client.host.admitAndRun({
			program: {
				name: "x",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		assert.equal(denied.ok, false);
		assert.equal(denied.error?.code, "TF_AUTHORITY_REVOKED");

		client.host.close();
		writer.host.close();
	} finally {
		t.cleanup();
	}
});

test("standalone uses project-local coordinator, not user-level coordinator dir", async () => {
	const t = temp();
	try {
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createScriptExecutionProvider(),
		});
		await host.admitAndRun({
			program: {
				name: "s",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		const userCoord = coordinatorDir(t.env);
		const projCoord = projectCoordinatorDir(t.project);
		assert.ok(fs.existsSync(path.join(projCoord, "state.json")), "project-local coordinator written");
		// User-level coordinator must not be required / claimed for standalone capacity
		assert.ok(
			!fs.existsSync(path.join(userCoord, "state.json")),
			"standalone must not write user-level coordinator state",
		);
		host.close();
	} finally {
		t.cleanup();
	}
});

test("20+ process parallel singleton: exactly one writer", async () => {
	const t = temp();
	try {
		const N = 24;
		const barrierDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-s20-"));
		const script = path.join(helpersDir, "mp-singleton-role.mts");
		const children: Array<Promise<{ status: number; stdout: string; stderr: string }>> = [];

		for (let i = 0; i < N; i++) {
			const id = String(i);
			const child: ChildProcess = spawn(
				process.execPath,
				["--conditions=development", "--experimental-strip-types", script, t.home, `h-${i}`],
				{
					env: { ...process.env, TF_MP_BARRIER: barrierDir, TF_MP_ID: id, TASKFLOW_HOME: t.home },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			children.push(
				new Promise((resolve) => {
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
						resolve({ status: 124, stdout, stderr: stderr + "\ntimeout" });
					}, 45_000);
					child.on("close", (code) => {
						clearTimeout(timer);
						resolve({ status: code ?? 1, stdout, stderr });
					});
				}),
			);
		}

		parentReleaseStart(barrierDir, N, 30_000);
		const results = await Promise.all(children);
		try {
			fs.rmSync(barrierDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}

		const roles: string[] = [];
		for (const r of results) {
			assert.equal(r.status, 0, r.stderr + r.stdout);
			const j = JSON.parse(r.stdout) as { role: string };
			roles.push(j.role);
		}
		const writers = roles.filter((r) => r === "writer");
		const attaches = roles.filter((r) => r === "attach");
		assert.equal(writers.length, 1, `writers=${writers.length} roles=${roles.join(",")}`);
		assert.equal(attaches.length, N - 1);
	} finally {
		t.cleanup();
	}
});

test("parallel same commandId: exactly one Run and one Receipt", async () => {
	const t = temp();
	try {
		const N = 8;
		const barrierDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-cmd-"));
		const script = path.join(helpersDir, "mp-admit-cmd.mts");
		const commandId = "shared-cmd-42";
		const children: Array<Promise<{ status: number; stdout: string; stderr: string }>> = [];

		for (let i = 0; i < N; i++) {
			const id = String(i);
			const child: ChildProcess = spawn(
				process.execPath,
				[
					"--conditions=development",
					"--experimental-strip-types",
					script,
					t.project,
					t.home,
					commandId,
				],
				{
					env: { ...process.env, TF_MP_BARRIER: barrierDir, TF_MP_ID: id, TASKFLOW_HOME: t.home },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			children.push(
				new Promise((resolve) => {
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
						resolve({ status: 124, stdout, stderr });
					}, 60_000);
					child.on("close", (code) => {
						clearTimeout(timer);
						resolve({ status: code ?? 1, stdout, stderr });
					});
				}),
			);
		}

		parentReleaseStart(barrierDir, N, 30_000);
		const results = await Promise.all(children);
		try {
			fs.rmSync(barrierDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}

		const runIds = new Set<string>();
		const receiptIds = new Set<string>();
		let okCount = 0;
		for (const r of results) {
			assert.equal(r.status, 0, r.stderr + r.stdout);
			const j = JSON.parse(r.stdout) as {
				ok: boolean;
				runId?: string;
				receiptId?: string | null;
			};
			if (j.ok && j.runId) {
				okCount += 1;
				runIds.add(j.runId);
				if (j.receiptId) receiptIds.add(j.receiptId);
			}
		}
		assert.ok(okCount >= 1, "at least one admit succeeds");
		assert.equal(runIds.size, 1, `expected 1 runId, got ${[...runIds].join(",")}`);
		// Durable store
		const store = (
			await import("../src/store/project-store.ts")
		).openProjectControlStore(t.project);
		const byCmd = store.getRunIdForCommand(commandId);
		assert.ok(byCmd);
		assert.equal(runIds.has(byCmd), true);
		const receiptsDir = path.join(t.project, ".taskflow", "control", "receipts");
		const receiptFiles = fs.existsSync(receiptsDir)
			? fs.readdirSync(receiptsDir).filter((f) => f.endsWith(".json") && !f.startsWith("by-run-"))
			: [];
		assert.equal(receiptFiles.length, 1, `receipts=${receiptFiles.join(",")}`);
		assert.equal(receiptIds.size, 1);
	} finally {
		t.cleanup();
	}
});
