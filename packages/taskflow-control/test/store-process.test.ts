/**
 * Process-level ControlStore crash matrix (A4) + recovery-vs-mutation (A5).
 *
 * Unix-only: SIGKILL injection is not part of the 3-OS process-supervisor
 * matrix. After restart the store must be old-complete, new-complete, or
 * fail-closed — never a mixed journal/projection/commit-seq state.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { ControlError } from "../src/errors.ts";
import { CONTROL_CRASH_ENV, openControlStore } from "../src/store/index.ts";

const UNIX_ONLY = { skip: process.platform === "win32" } as const;

const tempRoots: string[] = [];
const children: ChildProcess[] = [];

after(() => {
	for (const child of children) {
		try {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		} catch { /* best effort */ }
	}
	for (const root of tempRoots) {
		try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
	}
});

function makeStorePath(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-store-crash-"));
	tempRoots.push(root);
	return path.join(root, "project-store");
}

function spawnFixture(env: Record<string, string>): ChildProcess {
	const child = spawn(
		process.execPath,
		["--conditions=development", "--experimental-strip-types", path.join(import.meta.dirname, "fixtures", "store-mutate.ts")],
		{
			cwd: path.resolve(import.meta.dirname, "..", "..", ".."),
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	children.push(child);
	return child;
}

function waitForExit(child: ChildProcess, timeoutMs = 15_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			try { child.kill("SIGKILL"); } catch { /* best effort */ }
			reject(new Error("timeout waiting for store fixture exit"));
		}, timeoutMs);
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
	});
}

function assertNotMixed(storePath: string, expected: "old" | "new"): void {
	const store = openControlStore(storePath);
	try {
		assert.notEqual(store.status, "fail-closed");
		if (expected === "old") {
			assert.equal(store.commitSeq, 0);
			assert.equal(store.readCommand("00000000-0000-0000-0000-0000000000aa"), undefined);
		} else {
			assert.equal(store.commitSeq, 1);
			assert.ok(store.readCommand("00000000-0000-0000-0000-0000000000aa"));
		}
		const journal = path.join(storePath, "journal", "000001.jsonl");
		if (fs.existsSync(journal)) {
			const raw = fs.readFileSync(journal);
			if (raw.length > 0) {
				assert.equal(raw[raw.length - 1], 0x0a, "recovered journal must not keep a torn tail");
			}
		}
		const seq = JSON.parse(fs.readFileSync(path.join(storePath, "commit-seq.json"), "utf8")) as { commitSeq: number };
		assert.equal(seq.commitSeq, store.commitSeq, "commit-seq.json must match journal");
	} finally {
		store.close();
	}
}

test("store crash: SIGKILL after header fsync / before journal is old-complete (A4)", UNIX_ONLY, async () => {
	const storePath = makeStorePath();
	const child = spawnFixture({
		TF_TEST_STORE_PATH: storePath,
		TF_TEST_ACTION: "init",
		[CONTROL_CRASH_ENV]: "header-fsynced",
	});
	const result = await waitForExit(child);
	assert.equal(result.signal, "SIGKILL");
	assert.ok(fs.existsSync(path.join(storePath, "header")));
	assert.equal(fs.existsSync(path.join(storePath, "journal", "000001.jsonl")), false);
	assertNotMixed(storePath, "old");
});

test("store crash: SIGKILL mid journal append is old-complete (A4)", UNIX_ONLY, async () => {
	const storePath = makeStorePath();
	const primed = openControlStore(storePath);
	primed.close();

	const child = spawnFixture({
		TF_TEST_STORE_PATH: storePath,
		TF_TEST_ACTION: "mutate",
		TF_TEST_COMMAND_ID: "00000000-0000-0000-0000-0000000000aa",
		[CONTROL_CRASH_ENV]: "journal-append",
	});
	const result = await waitForExit(child);
	assert.equal(result.signal, "SIGKILL");
	assertNotMixed(storePath, "old");
});

test("store crash: SIGKILL during projection rebuild is new-complete (A4)", UNIX_ONLY, async () => {
	const storePath = makeStorePath();
	const primed = openControlStore(storePath);
	primed.close();

	const child = spawnFixture({
		TF_TEST_STORE_PATH: storePath,
		TF_TEST_ACTION: "mutate",
		TF_TEST_COMMAND_ID: "00000000-0000-0000-0000-0000000000aa",
		[CONTROL_CRASH_ENV]: "projection-rebuild",
	});
	const result = await waitForExit(child);
	assert.equal(result.signal, "SIGKILL");
	assertNotMixed(storePath, "new");
});

test("store crash: recovery racing a second writer fails closed (A5)", UNIX_ONLY, async () => {
	const storePath = makeStorePath();
	const holder = openControlStore(storePath);
	try {
		assert.throws(
			() => openControlStore(storePath),
			(error: unknown) => {
				assert.ok(error instanceof ControlError);
				assert.equal((error as ControlError).code, "TF_DURABILITY_FAILED");
				return true;
			},
		);
	} finally {
		holder.close();
	}
});
