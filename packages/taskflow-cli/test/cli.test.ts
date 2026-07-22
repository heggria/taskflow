/**
 * CLI entry against shipped runCli / bootstrap + real bin subprocess launches.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
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
