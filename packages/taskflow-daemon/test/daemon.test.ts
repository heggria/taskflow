/**
 * taskflowd singleton multi-mount clerk tests.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { startDaemon } from "../src/daemon.ts";

test("daemon: concurrent start yields single writer", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-daemon-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-daemon-proj-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	try {
		const d1 = startDaemon({ env, projectRoots: [project], holderId: "d1" });
		const d2 = startDaemon({ env, projectRoots: [project], holderId: "d2" });
		const roles = [d1.role, d2.role];
		assert.ok(roles.includes("writer"));
		assert.ok(roles.includes("attach") || roles.filter((r) => r === "writer").length === 1);
		d1.stop();
		d2.stop();
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	}
});
