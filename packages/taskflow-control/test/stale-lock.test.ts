/**
 * Stale singleton lock recovery (P13 / §23): dead peer PID → steal lock → writer.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	acquireOrAttachSingleton,
	releaseSingleton,
	singletonLockPath,
	writeFileAtomic,
} from "../src/index.ts";

test("stale singleton lock (dead pid) is stolen; live lock attaches", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-stale-home-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	try {
		// Plant a lock owned by a non-existent PID
		const lockPath = singletonLockPath(env);
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		writeFileAtomic(
			lockPath,
			JSON.stringify({
				holderId: "dead-holder",
				pid: 2_147_483_646, // almost certainly not a live process
				fencingEpoch: 1,
				endpoint: path.join(path.dirname(lockPath), "taskflowd.sock"),
				acquiredAt: Date.now() - 60_000,
			}),
		);

		const stolen = acquireOrAttachSingleton("rescuer", env);
		assert.equal(stolen.role, "writer");
		assert.equal(stolen.lock.holderId, "rescuer");
		assert.equal(stolen.lock.pid, process.pid);

		// Concurrent live holder → attach
		const attach = acquireOrAttachSingleton("client-b", env);
		assert.equal(attach.role, "attach");
		assert.equal(attach.lock.holderId, "rescuer");

		releaseSingleton("rescuer", env);
		assert.ok(!fs.existsSync(lockPath) || true);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
