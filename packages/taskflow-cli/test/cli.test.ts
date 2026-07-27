/**
 * CLI entry against shipped runCli / bootstrap + real bin subprocess launches.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	bootstrapControl,
	singletonLockPath,
	udsPath,
	writeFileAtomic,
} from "taskflow-control";
import { runCli } from "../src/cli.ts";

const binPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "bin.ts");

function temp(): { env: NodeJS.ProcessEnv; project: string; home: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-cli-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-cli-proj-"));
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

/** Launch the shipped CLI bin entry (src/bin.ts) as a real process. */
function launchBin(args: string[], env: NodeJS.ProcessEnv): {
	status: number;
	json: unknown;
	stdout: string;
	stderr: string;
} {
	const r = spawnSync(
		process.execPath,
		["--conditions=development", "--experimental-strip-types", binPath, ...args],
		{ encoding: "utf-8", env, timeout: 30_000 },
	);
	let json: unknown = null;
	try {
		json = JSON.parse(r.stdout ?? "");
	} catch {
		json = { parseError: true, raw: r.stdout };
	}
	return { status: r.status ?? 1, json, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("cli version", async () => {
	const r = await runCli(["version"]);
	assert.equal(r.ok, true);
	assert.equal((r.json as { version: string }).version, "0.3.0");
});

test("cli run default script flow produces receipt", async () => {
	const t = temp();
	try {
		const r = await runCli(["run", "--cwd", t.project, "--controlMode", "standalone"], {
			env: t.env,
			cwd: t.project,
		});
		assert.equal(r.ok, true, JSON.stringify(r.json));
		const j = r.json as { receipt?: { receiptId: string }; run?: { status: string } };
		assert.ok(j.receipt?.receiptId);
		assert.equal(j.run?.status, "completed");
	} finally {
		t.cleanup();
	}
});

test("cli run twice (idempotent entry launch consistency)", async () => {
	const t = temp();
	try {
		const a = await runCli(["run", "--cwd", t.project, "--controlMode", "standalone", "--commandId", "same-1"], {
			env: t.env,
		});
		const b = await runCli(["run", "--cwd", t.project, "--controlMode", "standalone", "--commandId", "same-1"], {
			env: t.env,
		});
		assert.equal(a.ok, true);
		assert.equal(b.ok, true);
	} finally {
		t.cleanup();
	}
});

test("cli bin subprocess launch twice yields Receipt each time", () => {
	const t = temp();
	try {
		const args = ["run", "--cwd", t.project, "--controlMode", "standalone"];
		const launch1 = launchBin(args, t.env);
		assert.equal(launch1.status, 0, `launch1 fail: ${launch1.stderr}\n${launch1.stdout}`);
		const j1 = launch1.json as {
			ok?: boolean;
			receipt?: { receiptId: string; boundPlanHash: string };
			run?: { status: string };
		};
		assert.equal(j1.ok, true);
		assert.equal(j1.run?.status, "completed");
		assert.ok(j1.receipt?.receiptId);
		assert.ok(j1.receipt?.boundPlanHash.startsWith("bp:"));

		const launch2 = launchBin(args, t.env);
		assert.equal(launch2.status, 0, `launch2 fail: ${launch2.stderr}\n${launch2.stdout}`);
		const j2 = launch2.json as {
			ok?: boolean;
			receipt?: { receiptId: string };
			run?: { status: string };
		};
		assert.equal(j2.ok, true);
		assert.equal(j2.run?.status, "completed");
		assert.ok(j2.receipt?.receiptId);
	} finally {
		t.cleanup();
	}
});

test("cli attach rejects a live unrelated PID whose UDS epoch disagrees with the singleton record", async () => {
	if (process.platform === "win32") return;
	const t = temp();
	let fakeServer: net.Server | undefined;
	const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
		stdio: "ignore",
	});
	try {
		assert.ok(unrelated.pid, "fixture must create a live unrelated PID");
		const initial = bootstrapControl({
			projectRoot: t.project,
			controlMode: "standalone",
			env: t.env,
		});
		initial.host.close();

		const socketPath = udsPath(t.env);
		fs.mkdirSync(path.dirname(socketPath), { recursive: true });
		fakeServer = net.createServer((socket) => {
			let buffered = "";
			socket.on("data", (chunk) => {
				buffered += chunk.toString("utf8");
				let newline: number;
				while ((newline = buffered.indexOf("\n")) >= 0) {
					const line = buffered.slice(0, newline);
					buffered = buffered.slice(newline + 1);
					let message: { type?: unknown; id?: unknown };
					try {
						message = JSON.parse(line) as { type?: unknown; id?: unknown };
					} catch {
						continue;
					}
					if (message.type === "hello") {
						socket.write(
							JSON.stringify({
								type: "hello-ok",
								protocolMajor: 1,
								fencingEpoch: 42,
								role: "writer",
								capabilities: ["status"],
							}) + "\n",
						);
					} else if (message.type === "rpc") {
						socket.write(
							JSON.stringify({
								type: "rpc-result",
								id: message.id,
								result: { run: { runId: "forged", status: "completed" } },
							}) + "\n",
						);
					}
				}
			});
		});
		await new Promise<void>((resolve, reject) => {
			fakeServer!.once("error", reject);
			fakeServer!.listen(socketPath, resolve);
		});

		writeFileAtomic(
			singletonLockPath(t.env),
			JSON.stringify(
				{
					holderId: "unrelated-live-process",
					pid: unrelated.pid,
					fencingEpoch: 41,
					endpoint: socketPath,
					acquiredAt: Date.now(),
				},
				null,
				2,
			),
		);

		const result = await runCli(
			["status", "--cwd", t.project, "--controlMode", "auto", "--runId", "forged"],
			{ env: t.env, cwd: t.project },
		);
		const json = result.json as { error?: { code?: string }; via?: string };
		assert.equal(result.ok, false, JSON.stringify(result.json));
		assert.equal(json.error?.code, "TF_BOOTSTRAP_FAILED");
		assert.equal(json.via, "uds-identity-mismatch");
	} finally {
		if (fakeServer) {
			await new Promise<void>((resolve) => fakeServer!.close(() => resolve()));
		}
		if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill("SIGKILL");
		t.cleanup();
	}
});
