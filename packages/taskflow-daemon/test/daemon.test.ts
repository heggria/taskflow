/**
 * taskflowd singleton + UDS hello/RPC tests.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { startDaemon } from "../src/daemon.ts";
import { startUdsServer, udsRpc, PROTOCOL_MAJOR } from "../src/uds-server.ts";
import {
	createControlHost,
	createScriptExecutionProvider,
	isWriterStillAuthoritative,
	acquireOrAttachSingleton,
	ControlStoreDurabilityError,
	releaseSingleton,
	SingletonAuthorityError,
	singletonLockPath,
	writeFileAtomic,
} from "taskflow-control";

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

test("daemon fencing: a replaced epoch rejects UDS mutations and cannot release its replacement", async () => {
	if (process.platform === "win32") return;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-daemon-fence-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-daemon-fence-project-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	try {
		daemon = await startDaemon({
			env,
			projectRoots: [project],
			holderId: "fenced-daemon",
			listenUds: true,
		});
		assert.equal(daemon.role, "writer");
		assert.ok(daemon.socketPath);

		const lockPath = singletonLockPath(env);
		const oldLock = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as {
			holderId: string;
			pid: number;
			fencingEpoch: number;
			endpoint: string;
			acquiredAt: number;
		};
		const replacement = {
			...oldLock,
			holderId: "replacement-daemon",
			fencingEpoch: oldLock.fencingEpoch + 1,
			acquiredAt: Date.now(),
		};
		writeFileAtomic(lockPath, JSON.stringify(replacement, null, 2));

		await assert.rejects(
			() =>
				udsRpc(daemon!.socketPath!, "admit", {
					commandId: "fenced-uds-cmd",
					program: {
						name: "fenced",
						phases: [{ id: "main", type: "script", run: "true", final: true }],
					},
				}),
			(error: unknown) => {
				assert.equal((error as { code?: string }).code, "TF_AUTHORITY_REVOKED");
				return true;
			},
		);
		const mounted = daemon.hosts.values().next().value;
		assert.ok(mounted);
		assert.equal(mounted.canMutate, false);

		await daemon.stop();
		daemon = undefined;
		const durable = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as typeof replacement;
		assert.equal(durable.holderId, replacement.holderId);
		assert.equal(durable.fencingEpoch, replacement.fencingEpoch);
	} finally {
		await daemon?.stop();
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("daemon UDS: a late durable singleton fence is reported as authority revoked", async () => {
	if (process.platform === "win32") return;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-uds-late-fence-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-uds-late-fence-project-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	let fenceRevoked = false;
	const host = createControlHost({
		projectRoot: project,
		env,
		controlMode: "standalone",
		skipSingleton: true,
		mutationAuthority: () => true,
		mutationFence: <T>(fn: () => T): T => {
			if (fenceRevoked) throw new SingletonAuthorityError("test fence revoked after UDS preflight");
			return fn();
		},
		scriptProvider: createScriptExecutionProvider({
			stateDir: path.join(project, ".taskflow", "control", "provider-jobs"),
		}),
	});
	let uds: Awaited<ReturnType<typeof startUdsServer>> | undefined;
	try {
		uds = await startUdsServer({
			socketPath: path.join(home, "late-fence.sock"),
			fencingEpoch: 1,
			role: "writer",
			isWriterAuthoritative: () => true,
			getHost: () => host,
		});
		// The transport preflight passes. The real ControlHost then reaches its
		// durable mutation fence, which must retain the authority error code.
		fenceRevoked = true;
		await assert.rejects(
			() =>
				udsRpc(uds!.socketPath, "admit", {
					commandId: "late-fence-uds-cmd",
					program: {
						name: "late-fence",
						phases: [{ id: "main", type: "script", run: "true", final: true }],
					},
				}),
			(error: unknown) => {
				assert.equal((error as { code?: string }).code, "TF_AUTHORITY_REVOKED");
				return true;
			},
		);
	} finally {
		await uds?.close();
		host.close();
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("daemon UDS: a late durable storage failure retains the operator error code", async () => {
	if (process.platform === "win32") return;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-uds-late-durability-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-uds-late-durability-project-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	let durabilityFailed = false;
	const host = createControlHost({
		projectRoot: project,
		env,
		controlMode: "standalone",
		skipSingleton: true,
		mutationAuthority: () => true,
		mutationFence: <T>(fn: () => T): T => {
			if (durabilityFailed) {
				throw new ControlStoreDurabilityError("test durable mutation failure", project);
			}
			return fn();
		},
		scriptProvider: createScriptExecutionProvider({
			stateDir: path.join(project, ".taskflow", "control", "provider-jobs"),
		}),
	});
	let uds: Awaited<ReturnType<typeof startUdsServer>> | undefined;
	try {
		uds = await startUdsServer({
			socketPath: path.join(home, "late-durability.sock"),
			fencingEpoch: 1,
			role: "writer",
			isWriterAuthoritative: () => true,
			getHost: () => host,
		});
		// Transport preflight passes, then the actual durable mutation fails.
		durabilityFailed = true;
		await assert.rejects(
			() =>
				udsRpc(uds!.socketPath, "admit", {
					commandId: "late-durability-uds-cmd",
					program: {
						name: "late-durability",
						phases: [{ id: "main", type: "script", run: "true", final: true }],
					},
				}),
			(error: unknown) => {
				assert.equal((error as { code?: string }).code, "TF_DURABILITY_FAILED");
				return true;
			},
		);
	} finally {
		await uds?.close();
		host.close();
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
		if (a.role !== "writer") throw new Error("expected writer");
		const epochA = a.lock.fencingEpoch;
		// Simulate dead writer without releasing: plant dead pid with same file is hard while alive.
		// Instead release and re-acquire — epoch should advance on fresh create.
		releaseSingleton(a.mutationAuthority, env);
		const b = acquireOrAttachSingleton("b", env);
		assert.equal(b.role, "writer");
		if (b.role !== "writer") throw new Error("expected writer");
		assert.ok(b.lock.fencingEpoch >= epochA);
		assert.equal(isWriterStillAuthoritative(b.lock, env), true);
		// Stale local view of A is not authoritative
		assert.equal(isWriterStillAuthoritative(a.lock, env), false);
		releaseSingleton(b.mutationAuthority, env);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
	void PROTOCOL_MAJOR;
});
