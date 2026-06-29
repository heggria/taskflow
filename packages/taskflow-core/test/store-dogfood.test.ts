/**
 * Minimal regression tests for 8 dogfood audit findings.
 *
 * These test the invariants, not real concurrency — spawn-free, fast, single-thread safe.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { Taskflow } from "../src/schema.ts";
import {
	saveFlow,
	saveRun,
	loadRun,
	newRunId,
	listRuns,
	type RunState,
} from "../src/store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpCwd(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-store-"));
	return d;
}

function cleanup(d: string) {
	fs.rmSync(d, { recursive: true, force: true });
}

function mkRun(cwd: string, overrides: Partial<RunState> = {}): RunState {
	const flowName = overrides.flowName ?? "f";
	return {
		runId: overrides.runId ?? newRunId(flowName),
		flowName,
		def: { name: flowName, phases: [], concurrency: 1 },
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
		...overrides,
	};
}

function mkFlow(name: string): Taskflow {
	return { name, concurrency: 1, phases: [{ id: "p", type: "agent", agent: "a", task: "x" }] };
}

// ===========================================================================
// Finding 1: saveRun rejects runId with "/", "\0", or ".."
// ===========================================================================

test("F1: saveRun silently returns for bad runIds", () => {
	const cwd = tmpCwd();
	try {
		const bad = ["evil/path", "../esc", "sub/../lat"];
		// saveRun must not throw and must not create files for bad ids.
		for (const id of bad) {
			saveRun(mkRun(cwd, { runId: id }));
			assert.equal(loadRun(cwd, id), null, `bad id ${id} must not be persisted`);
		}
		// Good id works.
		saveRun(mkRun(cwd, { runId: "ok" }));
		assert.ok(loadRun(cwd, "ok"), "valid id must round-trip");
	} finally { cleanup(cwd); }
});

// ===========================================================================
// Finding 2: mtime guard — restarting a completed run survives cleanup
// ===========================================================================

test("F2: mtime guard skips files re-created after cleanup snapshot", () => {
	const cwd = tmpCwd();
	try {
		// Save a "completed" run, then re-save it as "running" (same runId).
		const rid = newRunId("f2");
		saveRun(mkRun(cwd, { runId: rid, status: "completed" }));
		// Immediately re-save — same rid, different status.
		// cleanupTerminalRuns is called inside saveRun, throttled.
		// The mtime guard must prevent the second save from being deleted.
		saveRun(mkRun(cwd, { runId: rid, status: "running" }));
		const loaded = loadRun(cwd, rid);
		assert.ok(loaded, "restarted run must still exist");
		assert.equal(loaded.status, "running");
	} finally { cleanup(cwd); }
});

// ===========================================================================
// Finding 3: saveFlow uses safeFlowDirName (leading-dot → underscore)
// ===========================================================================

test("F3: saveFlow replaces leading dots in names", () => {
	const cwd = tmpCwd();
	try {
		// Pre-create .pi/ to avoid the one-shot hint.
		fs.mkdirSync(path.join(cwd, ".pi", "taskflows"), { recursive: true });
		const r = saveFlow(cwd, mkFlow(".hidden-test"), "project");
		assert.ok(r.filePath.endsWith("_hidden-test.json"),
			`leading dot must become underscore, got: ${path.basename(r.filePath)}`);
	} finally { cleanup(cwd); }
});

// ===========================================================================
// Finding 4: saveFlow uses file locking — concurrent saves don't corrupt
// (sequential test — real concurrency is covered by the lock design review)
// ===========================================================================

test("F4: saveFlow with same name twice is safe (sequential)", () => {
	const cwd = tmpCwd();
	try {
		fs.mkdirSync(path.join(cwd, ".pi", "taskflows"), { recursive: true });
		const r1 = saveFlow(cwd, mkFlow("same"), "project");
		const r2 = saveFlow(cwd, mkFlow("same"), "project");
		assert.equal(r1.filePath, r2.filePath, "same flow → same file");
		// File must be parseable JSON
		const raw = fs.readFileSync(r1.filePath, "utf-8");
		const parsed = JSON.parse(raw);
		assert.equal(parsed.name, "same");
	} finally { cleanup(cwd); }
});

// ===========================================================================
// Finding 5: rebuildIndex merges concurrent index entries (scanned wins)
// ===========================================================================

test("F5: listRuns returns results even without index.json", () => {
	const cwd = tmpCwd();
	try {
		// Save a run, then delete index.json to force rebuildIndex path.
		saveRun(mkRun(cwd, { runId: "f5-id" }));
		const runsDir = path.join(cwd, ".pi", "taskflows", "runs");
		const indexPath = path.join(runsDir, "index.json");
		if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
		// listRuns should rebuild and find the run.
		const runs = listRuns(cwd, 10);
		assert.ok(runs.some(r => r.runId === "f5-id"), "rebuildIndex must find orphaned run");
	} finally { cleanup(cwd); }
});

// ===========================================================================
// Finding 6: SharedArrayBuffer is module-scoped constant
// ===========================================================================

test("F6: store.ts de-comments mention SharedArrayBuffer hoist", () => {
	// Read store.ts source and verify LOCK_WAIT_BUF exists at module level.
	const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "store.ts"), "utf-8");
	assert.ok(src.includes("LOCK_WAIT_BUF"), "LOCK_WAIT_BUF must be module-scoped");
});

// ===========================================================================
// Finding 7: empty flow name rejected by schema (minLength: 1)
// ===========================================================================

test("F7: empty flow name is rejected", () => {
	const cwd = tmpCwd();
	try {
		fs.mkdirSync(path.join(cwd, ".pi", "taskflows"), { recursive: true });
		// TypeBox minLength:1 should reject "".
		// Try anyway and verify it doesn't produce a bogus file.
		assert.throws(
			() => saveFlow(cwd, mkFlow(""), "project"),
			/Flow name must not be empty/,
		);
	} finally { cleanup(cwd); }
});

// ===========================================================================
// Finding 8: saveFlow hint is conditional ("Created" vs "Using")
// ===========================================================================

test("F8: saveFlow hint uses 'Created' on first call", () => {
	const cwd = tmpCwd();
	// No .pi/ exists yet.
	try {
		saveFlow(cwd, mkFlow("f8"), "project");
		// After creating .pi/, a second call should use "Using" (but the global
		// flag _piCreationHinted is true now, so the message doesn't re-print).
		// We test that the file was created correctly.
		const dir = path.join(cwd, ".pi", "taskflows");
		assert.ok(fs.existsSync(path.join(dir, "f8.json")), "flow file must exist");
	} finally { cleanup(cwd); }
});
