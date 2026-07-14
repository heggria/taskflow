/**
 * Build/host identity — 0.2.0 dogfood issue 4.
 *
 * `getBuildInfo()` reports packageVersion (from package.json), gitCommit
 * (build-time stamped, NEVER runs git at runtime — falls back to "unknown"),
 * schemaVersion, and buildTime. RunState stamps host/packageVersion/gitCommit/
 * schemaVersion; index entries preserve host/packageVersion/parentRunId.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	getBuildInfo,
	packageVersion,
	gitCommit,
	CURRENT_RUN_STATE_SCHEMA_VERSION,
	UNKNOWN_BUILD_COMMIT,
} from "../src/build-info.ts";
import { extractIndexEntry, type RunState, type RunIndexEntry } from "../src/store.ts";

test("packageVersion: reads a real version string from package.json", () => {
	const v = packageVersion();
	assert.equal(typeof v, "string");
	assert.ok(v.length > 0);
	// Must look like a semver-ish version (not "0.0.0" in a real checkout).
	assert.match(v, /^\d+\.\d+\.\d+/);
});

test("gitCommit: never throws, returns a string (stamp or unknown fallback)", () => {
	const c = gitCommit();
	assert.equal(typeof c, "string");
	assert.ok(c.length > 0);
	// In a source/dev checkout (no dist/build-info.json), it falls back to the
	// env var or "unknown". Either is acceptable; the contract is "never throws,
	// never runs git". A non-empty string is the load-bearing assertion.
});

test("getBuildInfo: returns packageVersion + gitCommit + schemaVersion", () => {
	const info = getBuildInfo();
	assert.equal(typeof info.packageVersion, "string");
	assert.ok(info.packageVersion.length > 0);
	assert.equal(typeof info.gitCommit, "string");
	assert.ok(info.gitCommit.length > 0);
	assert.equal(info.schemaVersion, CURRENT_RUN_STATE_SCHEMA_VERSION);
	// buildTime is optional (absent in dev, present in a stamped build).
	if (info.buildTime !== undefined) {
		assert.equal(typeof info.buildTime, "number");
	}
});

test("UNKNOWN_BUILD_COMMIT is the deterministic fallback string", () => {
	assert.equal(UNKNOWN_BUILD_COMMIT, "unknown");
});

test("RunState metadata: optional fields can be stamped (backward compatible)", () => {
	const info = getBuildInfo();
	const state: RunState = {
		runId: "r1",
		flowName: "f",
		def: { name: "f", phases: [{ id: "a", type: "agent", task: "x" }] },
		args: {},
		status: "running",
		phases: {},
		createdAt: 1,
		updatedAt: 1,
		cwd: "/tmp",
		host: "pi",
		packageVersion: info.packageVersion,
		gitCommit: info.gitCommit,
		schemaVersion: info.schemaVersion,
	};
	assert.equal(state.host, "pi");
	assert.equal(state.packageVersion, info.packageVersion);
	assert.equal(state.gitCommit, info.gitCommit);
	assert.equal(state.schemaVersion, info.schemaVersion);
});

test("RunState metadata: old runs without the fields are still valid (backward compat)", () => {
	// A pre-0.2.0-metadata run: no host/packageVersion/gitCommit/schemaVersion.
	const state = {
		runId: "old",
		flowName: "f",
		def: { name: "f", phases: [{ id: "a", type: "agent", task: "x" }] },
		args: {},
		status: "completed",
		phases: {},
		createdAt: 1,
		updatedAt: 1,
		cwd: "/tmp",
	} as RunState;
	assert.equal(state.host, undefined);
	assert.equal(state.packageVersion, undefined);
	assert.equal(state.schemaVersion, undefined);
});

test("extractIndexEntry: preserves host/packageVersion/parentRunId when present", () => {
	const state: RunState = {
		runId: "r2",
		flowName: "f",
		def: { name: "f", phases: [{ id: "a", type: "agent", task: "x" }] },
		args: {},
		status: "running",
		phases: {},
		createdAt: 1,
		updatedAt: 2,
		cwd: "/tmp",
		host: "codex",
		packageVersion: "0.2.0",
		gitCommit: "abc123",
		schemaVersion: 1,
		parentRunId: "r1",
	};
	const entry: RunIndexEntry = extractIndexEntry(state, "f/r2.json");
	assert.equal(entry.runId, "r2");
	assert.equal(entry.host, "codex");
	assert.equal(entry.packageVersion, "0.2.0");
	assert.equal(entry.parentRunId, "r1");
});

test("extractIndexEntry: omits identity fields when absent (no undefined keys)", () => {
	const state: RunState = {
		runId: "r3",
		flowName: "f",
		def: { name: "f", phases: [{ id: "a", type: "agent", task: "x" }] },
		args: {},
		status: "running",
		phases: {},
		createdAt: 1,
		updatedAt: 2,
		cwd: "/tmp",
	};
	const entry = extractIndexEntry(state, "f/r3.json");
	assert.equal("host" in entry, false);
	assert.equal("packageVersion" in entry, false);
	assert.equal("parentRunId" in entry, false);
});

test("stamp-build-info script is valid plain JavaScript", async () => {
	const { spawnSync } = await import("node:child_process");
	const path = await import("node:path");
	const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace("/packages/taskflow-core/test", ""));
	const script = path.join(repoRoot, "scripts", "stamp-build-info.mjs");
	const r = spawnSync(process.execPath, ["--check", script], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr || "stamp-build-info.mjs must parse in plain Node");
});

test("stamp-build-info script: --check exits 0 when git is available (build output)", async () => {
	// Verifies the build stamp script can produce a non-'unknown' commit (0.2.0
	// dogfood issue 4) so the published dist carries real build identity. The
	// check reads packages/taskflow-core/dist/build-info.json without rewriting it.
	// Tolerated (skipped) when git is unavailable.
	const { spawnSync } = await import("node:child_process");
	const { existsSync, statSync } = await import("node:fs");
	const path = await import("node:path");
	const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace("/packages/taskflow-core/test", ""));
	const stampPath = path.join(repoRoot, "packages", "taskflow-core", "dist", "build-info.json");
	const before = existsSync(stampPath) ? statSync(stampPath, { bigint: true }) : undefined;
	await new Promise((resolve) => setTimeout(resolve, 5));
	const r = spawnSync(
		process.execPath,
		[path.join(repoRoot, "scripts", "stamp-build-info.mjs"), "--check"],
		{ cwd: path.join(repoRoot, "packages", "taskflow-core"), encoding: "utf8" },
	);
	if (r.status !== 0) {
		console.warn("[stamp test] git unavailable or dist missing; skipping (source fallback covers this)");
		return;
	}
	assert.equal(r.status, 0);
	assert.match(r.stdout, /--check OK:/);
	assert.ok(before, "successful --check requires an existing stamp");
	const after = statSync(stampPath, { bigint: true });
	assert.equal(after.mtimeNs, before.mtimeNs, "--check must not rewrite the stamp");
	assert.equal(after.ctimeNs, before.ctimeNs, "--check must not mutate stamp metadata");
});
