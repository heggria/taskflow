import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	clearDetachedProcessRegistry,
	detachedCancelRequestPath,
	detachedControlDir,
	DETACHED_CONTROL_CWD_ENV,
	DETACHED_CONTROL_INSTANCE_ENV,
	DETACHED_CONTROL_OWNER_PID_ENV,
	DETACHED_CONTROL_RUN_ID_ENV,
	probeProcess,
	registerDetachedProcessTreeFromEnv,
	requestDetachedCancel,
	terminateDetachedProcessTrees,
} from "../src/index.ts";

function withAgentDir(agentDir: string): () => void {
	const previous = process.env.TASKFLOW_AGENT_DIR;
	process.env.TASKFLOW_AGENT_DIR = agentDir;
	return () => {
		if (previous === undefined) delete process.env.TASKFLOW_AGENT_DIR;
		else process.env.TASKFLOW_AGENT_DIR = previous;
	};
}

test("detached control: repository .control symlinks cannot redirect markers", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-control-private-"));
	const cwd = path.join(root, "project");
	const outside = path.join(root, "outside");
	fs.mkdirSync(path.join(cwd, ".pi", "taskflows", "runs"), { recursive: true });
	fs.mkdirSync(outside);
	fs.symlinkSync(outside, path.join(cwd, ".pi", "taskflows", "runs", ".control"), "dir");
	const restore = withAgentDir(path.join(root, "agent"));
	try {
		requestDetachedCancel(cwd, "safe-run", "test");
		assert.equal(fs.readdirSync(outside).length, 0, "project-controlled symlink target stays untouched");
		assert.equal(fs.existsSync(detachedCancelRequestPath(cwd, "safe-run")), true);
		assert.equal(detachedCancelRequestPath(cwd, "safe-run").startsWith(detachedControlDir(cwd)), true);
	} finally {
		restore();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("detached control: a symlinked private control leaf fails closed", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-control-symlink-"));
	const cwd = path.join(root, "project");
	const outside = path.join(root, "outside");
	fs.mkdirSync(cwd);
	fs.mkdirSync(outside);
	const restore = withAgentDir(path.join(root, "agent"));
	try {
		const controlDir = detachedControlDir(cwd);
		fs.mkdirSync(path.dirname(controlDir), { recursive: true });
		fs.symlinkSync(outside, controlDir, "dir");
		assert.throws(() => requestDetachedCancel(cwd, "safe-run"), /private physical directory|EEXIST/);
		assert.deepEqual(fs.readdirSync(outside), []);
	} finally {
		restore();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("detached control: registered Host CLI process groups are reaped by instance", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-control-reap-"));
	const cwd = path.join(root, "project");
	fs.mkdirSync(cwd);
	const restore = withAgentDir(path.join(root, "agent"));
	const runId = "reap-run";
	const instanceId = "instance-a";
	const previousContext = {
		cwd: process.env[DETACHED_CONTROL_CWD_ENV],
		runId: process.env[DETACHED_CONTROL_RUN_ID_ENV],
		instance: process.env[DETACHED_CONTROL_INSTANCE_ENV],
		ownerPid: process.env[DETACHED_CONTROL_OWNER_PID_ENV],
	};
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		detached: process.platform !== "win32",
		stdio: "ignore",
	});
	assert.ok(child.pid);
	try {
		process.env[DETACHED_CONTROL_CWD_ENV] = cwd;
		process.env[DETACHED_CONTROL_RUN_ID_ENV] = runId;
		process.env[DETACHED_CONTROL_INSTANCE_ENV] = instanceId;
		process.env[DETACHED_CONTROL_OWNER_PID_ENV] = String(process.pid + 1);
		registerDetachedProcessTreeFromEnv(child.pid!);
		assert.deepEqual(
			terminateDetachedProcessTrees(cwd, runId, instanceId),
			[],
			"an inherited detached context cannot register from a non-owner process",
		);
		process.env[DETACHED_CONTROL_OWNER_PID_ENV] = String(process.pid);
		registerDetachedProcessTreeFromEnv(child.pid!);
		assert.deepEqual(terminateDetachedProcessTrees(cwd, runId, "wrong-instance"), []);
		assert.deepEqual(terminateDetachedProcessTrees(cwd, runId, instanceId), [child.pid]);

		const deadline = Date.now() + 5_000;
		while (probeProcess(child.pid!) !== "dead" && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.equal(probeProcess(child.pid!), "dead");
	} finally {
		try { child.kill("SIGKILL"); } catch { /* already reaped */ }
		clearDetachedProcessRegistry(cwd, runId, instanceId);
		if (previousContext.cwd === undefined) delete process.env[DETACHED_CONTROL_CWD_ENV];
		else process.env[DETACHED_CONTROL_CWD_ENV] = previousContext.cwd;
		if (previousContext.runId === undefined) delete process.env[DETACHED_CONTROL_RUN_ID_ENV];
		else process.env[DETACHED_CONTROL_RUN_ID_ENV] = previousContext.runId;
		if (previousContext.instance === undefined) delete process.env[DETACHED_CONTROL_INSTANCE_ENV];
		else process.env[DETACHED_CONTROL_INSTANCE_ENV] = previousContext.instance;
		if (previousContext.ownerPid === undefined) delete process.env[DETACHED_CONTROL_OWNER_PID_ENV];
		else process.env[DETACHED_CONTROL_OWNER_PID_ENV] = previousContext.ownerPid;
		restore();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("probeProcess: EPERM is unknown while ESRCH is dead", () => {
	const error = (code: string) => Object.assign(new Error(code), { code });
	assert.equal(probeProcess(123, () => { throw error("EPERM"); }), "unknown");
	assert.equal(probeProcess(123, () => { throw error("ESRCH"); }), "dead");
});
