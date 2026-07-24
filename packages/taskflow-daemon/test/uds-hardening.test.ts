/**
 * UDS hardening adversarial tests (mandate 4):
 * - RPC before hello denied, no side effect
 * - missing/unknown projectId denied
 * - writer + CLI attach via ControlClient succeeds over UDS
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { startDaemon } from "../src/daemon.ts";
import { PROTOCOL_MAJOR } from "../src/uds-server.ts";
import { runCli } from "../../taskflow-cli/src/cli.ts";
import { controlClientRpc as rpc, probeControlEndpoint } from "taskflow-control";

function temp(): { env: NodeJS.ProcessEnv; home: string; project: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-uds-h-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-uds-h-proj-"));
	return {
		home,
		project,
		env: { ...process.env, TASKFLOW_HOME: home },
		cleanup: () => {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(project, { recursive: true, force: true });
		},
	};
}

/** Raw RPC without hello — must be denied. */
function rpcWithoutHello(
	socketPath: string,
	method: string,
	params: Record<string, unknown>,
): Promise<{ type: string; code?: string; message?: string }> {
	return new Promise((resolve, reject) => {
		const sock = net.connect(socketPath);
		const id = "no-hello-1";
		let acc = "";
		sock.on("connect", () => {
			sock.write(JSON.stringify({ type: "rpc", id, method, params }) + "\n");
		});
		sock.on("data", (chunk) => {
			acc += chunk.toString("utf8");
			const line = acc.split("\n")[0];
			if (!line) return;
			try {
				const msg = JSON.parse(line) as {
					type: string;
					code?: string;
					message?: string;
				};
				sock.end();
				resolve(msg);
			} catch {
				/* keep */
			}
		});
		sock.on("error", reject);
		setTimeout(() => {
			sock.destroy();
			reject(new Error("timeout"));
		}, 5_000);
	});
}

test("adversarial: RPC before hello is denied and performs no side effect", async () => {
	if (process.platform === "win32") return;
	const t = temp();
	try {
		const d = await startDaemon({
			env: t.env,
			projectRoots: [t.project],
			holderId: "uds-hello-guard",
			listenUds: true,
		});
		assert.equal(d.role, "writer");
		assert.ok(d.socketPath);

		const marker = path.join(t.project, "should-not-run.txt");
		const denied = await rpcWithoutHello(d.socketPath!, "admit", {
			program: {
				name: "no-hello",
				phases: [
					{
						id: "main",
						type: "script",
						run: `echo leaked > "${marker}"`,
						final: true,
					},
				],
			},
			commandId: "no-hello-cmd",
		});
		assert.equal(denied.type, "rpc-error");
		assert.equal(denied.code, "TF_PROTOCOL_INCOMPATIBLE");
		assert.match(denied.message ?? "", /hello required/i);
		assert.ok(!fs.existsSync(marker), "RPC before hello must not execute program");

		// After proper hello, admit works
		const ok = (await rpc(
			"admit",
			{
				program: {
					name: "with-hello",
					phases: [{ id: "main", type: "script", run: "echo ok", final: true }],
				},
				commandId: "with-hello-cmd",
				projectId: [...d.hosts.keys()][0],
			},
			{ socketPath: d.socketPath!, env: t.env, principal: "test" },
		)) as { ok?: boolean };
		assert.equal(ok.ok, true);

		await d.stop();
	} finally {
		t.cleanup();
	}
	void PROTOCOL_MAJOR;
});

test("adversarial: unknown projectId is denied", async () => {
	if (process.platform === "win32") return;
	const t = temp();
	try {
		const d = await startDaemon({
			env: t.env,
			projectRoots: [t.project],
			holderId: "uds-proj-id",
			listenUds: true,
		});
		assert.ok(d.socketPath);
		await assert.rejects(
			() =>
				rpc(
					"admit",
					{
						program: {
							name: "x",
							phases: [{ id: "main", type: "script", run: "true", final: true }],
						},
						projectId: "proj_does_not_exist_zzzz",
						commandId: "bad-proj",
					},
					{ socketPath: d.socketPath!, env: t.env, principal: "test" },
				),
			(e: Error & { code?: string }) =>
				e.code === "TF_NOT_FOUND" || /unknown or mismatched projectId/i.test(e.message),
		);
		await d.stop();
	} finally {
		t.cleanup();
	}
});

test("adversarial: daemon writer + CLI auto succeeds via UDS client not local attach", async () => {
	if (process.platform === "win32") return;
	const t = temp();
	try {
		const d = await startDaemon({
			env: t.env,
			projectRoots: [t.project],
			holderId: "uds-cli-writer",
			listenUds: true,
		});
		assert.equal(d.role, "writer");
		assert.ok(d.socketPath);
		const hello = await probeControlEndpoint({
			socketPath: d.socketPath!,
			env: t.env,
		});
		assert.ok(hello);
		assert.equal(hello!.role, "writer");

		// CLI under same TASKFLOW_HOME attaches and must route via UDS
		const r = await runCli(
			[
				"run",
				"--cwd",
				t.project,
				"--controlMode",
				"auto",
				"--commandId",
				"cli-uds-1",
				"--define",
				JSON.stringify({
					name: "cli-via-uds",
					phases: [{ id: "main", type: "script", run: "echo via-uds", final: true }],
				}),
			],
			{ env: t.env, cwd: t.project },
		);
		assert.equal(r.ok, true, JSON.stringify(r.json));
		const json = r.json as { via?: string; ok?: boolean; receipt?: { receiptId: string } };
		assert.equal(json.via, "uds-client", "CLI must use UDS when attach, not local mutate");
		assert.ok(json.receipt?.receiptId || (json as { run?: { status: string } }).run);

		await d.stop();
	} finally {
		t.cleanup();
	}
});

test("deep TASKFLOW_HOME uses a bounded private UDS path and remains reachable", async () => {
	if (process.platform === "win32") return;
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-uds-deep-"),
	);
	const home = path.join(
		root,
		"a".repeat(80),
		"nested-taskflow-home",
	);
	const project = path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	const env = { ...process.env, TASKFLOW_HOME: home };
	let socketDirectory: string | undefined;
	try {
		const daemon = await startDaemon({
			env,
			projectRoots: [project],
			holderId: "uds-deep-home",
			listenUds: true,
		});
		assert.equal(daemon.role, "writer");
		assert.ok(daemon.socketPath);
		assert.ok(
			Buffer.byteLength(daemon.socketPath!, "utf8") <= 103,
			daemon.socketPath,
		);
		assert.notEqual(
			path.dirname(daemon.socketPath!),
			path.join(home, ".taskflow", "control"),
		);
		socketDirectory = path.dirname(daemon.socketPath!);
		const hello = await probeControlEndpoint({
			socketPath: daemon.socketPath!,
			env,
			principal: "deep-home-test",
		});
		assert.equal(hello?.role, "writer");
		await daemon.stop();
		assert.equal(fs.existsSync(daemon.socketPath!), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		if (
			socketDirectory &&
			path.basename(socketDirectory).startsWith("tf-")
		) {
			fs.rmSync(socketDirectory, {
				recursive: true,
				force: true,
			});
		}
	}
});
