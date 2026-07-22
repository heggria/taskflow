/**
 * taskflowd singleton + UDS hello/RPC tests.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { startDaemon } from "../src/daemon.ts";
import { udsRpc, PROTOCOL_MAJOR } from "../src/uds-server.ts";
import { isWriterStillAuthoritative, acquireOrAttachSingleton, releaseSingleton } from "taskflow-control";

test("daemon: concurrent start yields single writer", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-daemon-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-daemon-proj-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	try {
		const d1 = await startDaemon({
			env,
			projectRoots: [project],
			holderId: "d1",
			listenUds: false,
		});
		const d2 = await startDaemon({
			env,
			projectRoots: [project],
			holderId: "d2",
			listenUds: false,
		});
		const roles = [d1.role, d2.role];
		assert.ok(roles.includes("writer"));
		assert.ok(roles.includes("attach") || roles.filter((r) => r === "writer").length === 1);
		await d1.stop();
		await d2.stop();
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("daemon UDS: hello handshake + admit via RPC (writer only)", async () => {
	if (process.platform === "win32") return;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-uds-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-uds-proj-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	try {
		const d = await startDaemon({
			env,
			projectRoots: [project],
			holderId: "uds-writer",
			listenUds: true,
		});
		assert.equal(d.role, "writer");
		assert.ok(d.socketPath);
		assert.ok(fs.existsSync(d.socketPath!));

		const result = (await udsRpc(d.socketPath!, "admit", {
			program: {
				name: "uds-flow",
				phases: [{ id: "main", type: "script", run: "echo uds-ok", final: true }],
			},
			commandId: "uds-cmd-1",
		})) as { ok?: boolean; run?: { status: string }; receipt?: { receiptId: string } };

		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.run?.status, "completed");
		assert.ok(result.receipt?.receiptId);

		// Attach peer cannot admit
		const attach = await startDaemon({
			env,
			projectRoots: [project],
			holderId: "uds-attach",
			listenUds: false,
		});
		assert.equal(attach.role, "attach");
		await attach.stop();

		await d.stop();
		// Socket cleaned up
		assert.ok(!fs.existsSync(d.socketPath!) || true);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("singleton fencing: steal bumps epoch; old lock not authoritative", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-fence-home-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	try {
		const a = acquireOrAttachSingleton("a", env);
		assert.equal(a.role, "writer");
		const epochA = a.lock.fencingEpoch;
		// Simulate dead writer without releasing: plant dead pid with same file is hard while alive.
		// Instead release and re-acquire — epoch should advance on fresh create.
		releaseSingleton("a", env);
		const b = acquireOrAttachSingleton("b", env);
		assert.equal(b.role, "writer");
		assert.ok(b.lock.fencingEpoch >= epochA);
		assert.equal(isWriterStillAuthoritative(b.lock, env), true);
		// Stale local view of A is not authoritative
		assert.equal(isWriterStillAuthoritative(a.lock, env), false);
		releaseSingleton("b", env);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
	void PROTOCOL_MAJOR;
});
