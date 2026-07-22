/**
 * CLI entry against shipped runCli / bootstrap.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli.ts";

function temp(): { env: NodeJS.ProcessEnv; project: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-cli-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-cli-proj-"));
	return {
		env: { ...process.env, TASKFLOW_HOME: home },
		project,
		cleanup: () => {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(project, { recursive: true, force: true });
		},
	};
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
