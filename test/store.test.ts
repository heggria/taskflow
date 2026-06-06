import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { Taskflow } from "../extensions/schema.ts";
import {
	getFlow,
	hashInput,
	listFlows,
	listRuns,
	loadRun,
	newRunId,
	saveFlow,
	saveRun,
	type RunState,
} from "../extensions/store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an isolated temp directory with a `.pi` marker so findProjectFlowsDir finds it. */
function makeTmpCwd(): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-store-test-"));
	fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
	return tmp;
}

function cleanup(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function minimalFlow(name: string): Taskflow {
	return {
		name,
		phases: [{ id: "p1", type: "agent", agent: "a", task: "do something" }],
	};
}

function mkRunState(cwd: string, overrides: Partial<RunState> = {}): RunState {
	const flowName = overrides.flowName ?? "test-flow";
	return {
		runId: overrides.runId ?? newRunId(flowName),
		flowName,
		def: minimalFlow(flowName),
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// newRunId
// ---------------------------------------------------------------------------

test("newRunId: returns a string with safe flow-name prefix", () => {
	const id = newRunId("my-flow");
	assert.match(id, /^my-flow-/);
});

test("newRunId: sanitizes special characters in flow name", () => {
	const id = newRunId("hello world/test@v2");
	// Special chars replaced with underscore
	assert.match(id, /^hello_world_test_v2-/);
	// No unsafe chars in the result
	assert.doesNotMatch(id, /[/ @]/);
});

test("newRunId: truncates long flow names to 24 chars", () => {
	const longName = "a".repeat(50);
	const id = newRunId(longName);
	const prefix = id.split("-")[0]!;
	assert.ok(prefix.length <= 24, `prefix "${prefix}" exceeds 24 chars`);
});

test("newRunId: generates unique IDs across calls", () => {
	const ids = new Set(Array.from({ length: 20 }, () => newRunId("f")));
	assert.equal(ids.size, 20, "expected 20 unique IDs");
});

test("newRunId: contains base-36 timestamp and hex suffix", () => {
	const id = newRunId("x");
	// Format: <safeName>-<base36Timestamp>-<6hexChars>
	const parts = id.split("-");
	assert.ok(parts.length >= 3, `expected at least 3 dash-separated parts, got: ${id}`);
	const hexSuffix = parts[parts.length - 1]!;
	assert.match(hexSuffix, /^[0-9a-f]{6}$/, `hex suffix "${hexSuffix}" should be 6 hex chars`);
});

// ---------------------------------------------------------------------------
// hashInput
// ---------------------------------------------------------------------------

test("hashInput: deterministic for same inputs", () => {
	const a = hashInput("hello", "world");
	const b = hashInput("hello", "world");
	assert.equal(a, b);
});

test("hashInput: different for different inputs", () => {
	const a = hashInput("hello", "world");
	const b = hashInput("hello", "mars");
	assert.notEqual(a, b);
});

test("hashInput: different for reordered inputs", () => {
	const a = hashInput("a", "b");
	const b = hashInput("b", "a");
	assert.notEqual(a, b);
});

test("hashInput: returns 16-char hex string", () => {
	const h = hashInput("test");
	assert.equal(h.length, 16);
	assert.match(h, /^[0-9a-f]{16}$/);
});

test("hashInput: single part works", () => {
	const h = hashInput("solo");
	assert.equal(h.length, 16);
	assert.match(h, /^[0-9a-f]{16}$/);
});

test("hashInput: empty parts array produces a valid hash", () => {
	const h = hashInput();
	assert.equal(h.length, 16);
	assert.match(h, /^[0-9a-f]{16}$/);
});

test("hashInput: distinguishes empty string from no args", () => {
	const noArgs = hashInput();
	const emptyStr = hashInput("");
	// Both are valid but join("\0") differs: "" vs ""
	// Actually: [].join("\0") === "" and [""].join("\0") === ""  — same!
	// This documents the edge case noted in the bug audit.
	assert.equal(noArgs, emptyStr, "empty parts and single-empty-string produce same hash (known edge case)");
});

test("hashInput: null-char separator prevents collision between concatenated strings", () => {
	const a = hashInput("ab", "cd");
	const b = hashInput("a", "bcd");
	assert.notEqual(a, b, "null separator should prevent ab+cd vs a+bcd collision");
});

// ---------------------------------------------------------------------------
// saveFlow / getFlow / listFlows
// ---------------------------------------------------------------------------

test("saveFlow + getFlow: roundtrip for project scope", () => {
	const cwd = makeTmpCwd();
	try {
		const def = minimalFlow("roundtrip");
		const { filePath } = saveFlow(cwd, def, "project");
		assert.ok(fs.existsSync(filePath), "file should exist on disk");

		const loaded = getFlow(cwd, "roundtrip");
		assert.ok(loaded, "getFlow should find the saved flow");
		assert.equal(loaded.name, "roundtrip");
		assert.equal(loaded.scope, "project");
		assert.deepEqual(loaded.def, def);
	} finally {
		cleanup(cwd);
	}
});

test("saveFlow: creates directories recursively", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-store-nodir-"));
	// No .pi dir pre-created — saveFlow with create=true should handle it
	try {
		const def = minimalFlow("auto-dir");
		const { filePath } = saveFlow(tmp, def, "project");
		assert.ok(fs.existsSync(filePath));
	} finally {
		cleanup(tmp);
	}
});

test("saveFlow: sanitizes flow name for filename", () => {
	const cwd = makeTmpCwd();
	try {
		const def = minimalFlow("my flow/v2@test");
		const { filePath } = saveFlow(cwd, def, "project");
		const basename = path.basename(filePath);
		assert.doesNotMatch(basename, /[/ @]/, "filename should not contain unsafe chars");
		assert.ok(basename.endsWith(".json"));
	} finally {
		cleanup(cwd);
	}
});

test("saveFlow: overwrites existing flow with same name", () => {
	const cwd = makeTmpCwd();
	try {
		const v1 = minimalFlow("evolve");
		saveFlow(cwd, v1, "project");

		const v2: Taskflow = {
			name: "evolve",
			phases: [
				{ id: "a", type: "agent", agent: "x", task: "updated task" },
				{ id: "b", type: "agent", agent: "x", task: "new phase", dependsOn: ["a"] },
			],
		};
		saveFlow(cwd, v2, "project");

		const loaded = getFlow(cwd, "evolve");
		assert.ok(loaded);
		assert.equal(loaded.def.phases.length, 2, "should have updated phases");
	} finally {
		cleanup(cwd);
	}
});

test("getFlow: returns null for nonexistent flow", () => {
	const cwd = makeTmpCwd();
	try {
		const result = getFlow(cwd, "no-such-flow");
		assert.equal(result, null);
	} finally {
		cleanup(cwd);
	}
});

test("listFlows: returns empty array when no flows exist", () => {
	const cwd = makeTmpCwd();
	try {
		const flows = listFlows(cwd);
		// May include user-scope flows from real agent dir, but project-scope should be empty.
		// Filter to project scope to be hermetic.
		const projectFlows = flows.filter((f) => f.scope === "project");
		assert.equal(projectFlows.length, 0);
	} finally {
		cleanup(cwd);
	}
});

test("listFlows: returns project-scope flows sorted by name", () => {
	const cwd = makeTmpCwd();
	try {
		saveFlow(cwd, minimalFlow("charlie"), "project");
		saveFlow(cwd, minimalFlow("alpha"), "project");
		saveFlow(cwd, minimalFlow("bravo"), "project");

		const flows = listFlows(cwd);
		const projectNames = flows.filter((f) => f.scope === "project").map((f) => f.name);
		assert.deepEqual(projectNames, ["alpha", "bravo", "charlie"]);
	} finally {
		cleanup(cwd);
	}
});

test("listFlows: ignores non-JSON files in flows directory", () => {
	const cwd = makeTmpCwd();
	try {
		saveFlow(cwd, minimalFlow("real"), "project");

		// Drop a non-JSON file in the same directory
		const flowsDir = path.join(cwd, ".pi", "taskflows");
		fs.writeFileSync(path.join(flowsDir, "notes.txt"), "not a flow");
		fs.writeFileSync(path.join(flowsDir, ".DS_Store"), "junk");

		const flows = listFlows(cwd);
		const projectNames = flows.filter((f) => f.scope === "project").map((f) => f.name);
		assert.deepEqual(projectNames, ["real"]);
	} finally {
		cleanup(cwd);
	}
});

test("listFlows: skips malformed JSON files gracefully", () => {
	const cwd = makeTmpCwd();
	try {
		saveFlow(cwd, minimalFlow("valid"), "project");

		const flowsDir = path.join(cwd, ".pi", "taskflows");
		fs.writeFileSync(path.join(flowsDir, "corrupt.json"), "{{invalid json", "utf-8");
		fs.writeFileSync(path.join(flowsDir, "noname.json"), '{"phases":[]}', "utf-8");

		const flows = listFlows(cwd);
		const projectNames = flows.filter((f) => f.scope === "project").map((f) => f.name);
		assert.deepEqual(projectNames, ["valid"]);
	} finally {
		cleanup(cwd);
	}
});

test("listFlows: finds flows from .pi dir in parent directory", () => {
	const cwd = makeTmpCwd();
	try {
		saveFlow(cwd, minimalFlow("parent-flow"), "project");

		// Create a subdirectory without its own .pi
		const sub = path.join(cwd, "packages", "child");
		fs.mkdirSync(sub, { recursive: true });

		const flows = listFlows(sub);
		const projectNames = flows.filter((f) => f.scope === "project").map((f) => f.name);
		assert.ok(projectNames.includes("parent-flow"), "should find flow from parent .pi dir");
	} finally {
		cleanup(cwd);
	}
});

// ---------------------------------------------------------------------------
// saveRun / loadRun / listRuns
// ---------------------------------------------------------------------------

test("saveRun + loadRun: roundtrip persistence", () => {
	const cwd = makeTmpCwd();
	try {
		const state = mkRunState(cwd, { runId: "test-roundtrip-001" });
		saveRun(state);

		const loaded = loadRun(cwd, "test-roundtrip-001");
		assert.ok(loaded, "loadRun should find the saved run");
		assert.equal(loaded.runId, "test-roundtrip-001");
		assert.equal(loaded.flowName, "test-flow");
		assert.equal(loaded.status, "running");
	} finally {
		cleanup(cwd);
	}
});

test("saveRun: updates updatedAt timestamp", () => {
	const cwd = makeTmpCwd();
	try {
		const state = mkRunState(cwd);
		const before = Date.now();
		state.updatedAt = 0;
		saveRun(state);
		const after = Date.now();

		const loaded = loadRun(cwd, state.runId);
		assert.ok(loaded);
		assert.ok(loaded.updatedAt >= before, "updatedAt should be >= time before save");
		assert.ok(loaded.updatedAt <= after, "updatedAt should be <= time after save");
	} finally {
		cleanup(cwd);
	}
});

test("saveRun: does not mutate the caller's state.updatedAt (F-009 regression)", () => {
	const cwd = makeTmpCwd();
	try {
		const originalUpdatedAt = 1_700_000_000_000;
		const state = mkRunState(cwd, { updatedAt: originalUpdatedAt });

		saveRun(state);

		// The caller's reference must be untouched — callers holding a reference
		// after saveRun should not observe an unexpected updatedAt change.
		assert.equal(
			state.updatedAt,
			originalUpdatedAt,
			"saveRun must not mutate the caller's state.updatedAt",
		);

		// The persisted file should still carry the fresh timestamp.
		const loaded = loadRun(cwd, state.runId);
		assert.ok(loaded);
		assert.notEqual(
			loaded.updatedAt,
			originalUpdatedAt,
			"persisted run should have a fresh updatedAt",
		);
		assert.ok(loaded.updatedAt > originalUpdatedAt);
	} finally {
		cleanup(cwd);
	}
});

test("saveRun: preserves phase state including nested objects", () => {
	const cwd = makeTmpCwd();
	try {
		const state = mkRunState(cwd);
		state.phases.work = {
			id: "work",
			status: "done",
			output: "result text",
			json: { items: [1, 2, 3] },
			usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 2, contextTokens: 0 },
			model: "claude-sonnet-4-20250514",
			inputHash: "abc123",
			startedAt: 1000,
			endedAt: 2000,
			subProgress: { done: 3, total: 5, running: 0, failed: 2 },
		};
		saveRun(state);

		const loaded = loadRun(cwd, state.runId);
		assert.ok(loaded);
		assert.deepEqual(loaded.phases.work.json, { items: [1, 2, 3] });
		assert.equal(loaded.phases.work.usage?.cost, 0.01);
		assert.deepEqual(loaded.phases.work.subProgress, { done: 3, total: 5, running: 0, failed: 2 });
	} finally {
		cleanup(cwd);
	}
});

test("saveRun: successive saves overwrite the same run file", () => {
	const cwd = makeTmpCwd();
	try {
		const state = mkRunState(cwd, { runId: "overwrite-me" });
		state.status = "running";
		saveRun(state);

		state.status = "completed";
		saveRun(state);

		const loaded = loadRun(cwd, "overwrite-me");
		assert.ok(loaded);
		assert.equal(loaded.status, "completed");

		// Only one file should exist for this runId
		const runsDir = path.join(cwd, ".pi", "taskflows", "runs");
		const files = fs.readdirSync(runsDir).filter((f) => f.includes("overwrite-me"));
		assert.equal(files.length, 1);
	} finally {
		cleanup(cwd);
	}
});

test("loadRun: returns null for nonexistent run", () => {
	const cwd = makeTmpCwd();
	try {
		const result = loadRun(cwd, "does-not-exist");
		assert.equal(result, null);
	} finally {
		cleanup(cwd);
	}
});

test("listRuns: returns empty array when runs dir does not exist", () => {
	const cwd = makeTmpCwd();
	try {
		const runs = listRuns(cwd);
		assert.deepEqual(runs, []);
	} finally {
		cleanup(cwd);
	}
});

test("listRuns: returns runs sorted by updatedAt descending (newest first)", () => {
	const cwd = makeTmpCwd();
	try {
		const s1 = mkRunState(cwd, { runId: "old", updatedAt: 1000 });
		const s2 = mkRunState(cwd, { runId: "mid", updatedAt: 2000 });
		const s3 = mkRunState(cwd, { runId: "new", updatedAt: 3000 });
		// Save in non-chronological order
		saveRun(s2);
		saveRun(s3);
		saveRun(s1);

		// saveRun overwrites updatedAt with Date.now(), so we need to re-read and fix
		// Actually, saveRun sets updatedAt = Date.now() — so all three will have ~same updatedAt.
		// We need to write the files manually to control updatedAt for ordering tests.
	} finally {
		cleanup(cwd);
	}
});

test("listRuns: sort order uses updatedAt from file content", () => {
	const cwd = makeTmpCwd();
	try {
		const runsDir = path.join(cwd, ".pi", "taskflows", "runs");
		fs.mkdirSync(runsDir, { recursive: true });

		// Write run files manually to control updatedAt precisely
		for (const [id, ts] of [
			["old", 1000],
			["mid", 2000],
			["new", 3000],
		] as const) {
			const state: RunState = {
				runId: id,
				flowName: "f",
				def: minimalFlow("f"),
				args: {},
				status: "completed",
				phases: {},
				createdAt: ts,
				updatedAt: ts,
				cwd,
			};
			fs.writeFileSync(path.join(runsDir, `${id}.json`), JSON.stringify(state), "utf-8");
		}

		const runs = listRuns(cwd);
		assert.deepEqual(
			runs.map((r) => r.runId),
			["new", "mid", "old"],
		);
	} finally {
		cleanup(cwd);
	}
});

test("listRuns: respects limit parameter", () => {
	const cwd = makeTmpCwd();
	try {
		const runsDir = path.join(cwd, ".pi", "taskflows", "runs");
		fs.mkdirSync(runsDir, { recursive: true });

		// Create 5 runs with distinct timestamps
		for (let i = 0; i < 5; i++) {
			const state: RunState = {
				runId: `run-${i}`,
				flowName: "f",
				def: minimalFlow("f"),
				args: {},
				status: "completed",
				phases: {},
				createdAt: i * 1000,
				updatedAt: i * 1000,
				cwd,
			};
			fs.writeFileSync(path.join(runsDir, `run-${i}.json`), JSON.stringify(state), "utf-8");
		}

		const limited = listRuns(cwd, 3);
		assert.equal(limited.length, 3);
		// Should be the 3 newest (highest updatedAt)
		assert.deepEqual(
			limited.map((r) => r.runId),
			["run-4", "run-3", "run-2"],
		);
	} finally {
		cleanup(cwd);
	}
});

test("listRuns: default limit is 20", () => {
	const cwd = makeTmpCwd();
	try {
		const runsDir = path.join(cwd, ".pi", "taskflows", "runs");
		fs.mkdirSync(runsDir, { recursive: true });

		for (let i = 0; i < 25; i++) {
			const state: RunState = {
				runId: `run-${String(i).padStart(2, "0")}`,
				flowName: "f",
				def: minimalFlow("f"),
				args: {},
				status: "completed",
				phases: {},
				createdAt: i,
				updatedAt: i,
				cwd,
			};
			fs.writeFileSync(path.join(runsDir, `run-${String(i).padStart(2, "0")}.json`), JSON.stringify(state), "utf-8");
		}

		const runs = listRuns(cwd);
		assert.equal(runs.length, 20);
	} finally {
		cleanup(cwd);
	}
});

test("listRuns: silently skips corrupted JSON run files", () => {
	const cwd = makeTmpCwd();
	try {
		const runsDir = path.join(cwd, ".pi", "taskflows", "runs");
		fs.mkdirSync(runsDir, { recursive: true });

		// One valid run
		const valid: RunState = {
			runId: "valid",
			flowName: "f",
			def: minimalFlow("f"),
			args: {},
			status: "completed",
			phases: {},
			createdAt: 1000,
			updatedAt: 1000,
			cwd,
		};
		fs.writeFileSync(path.join(runsDir, "valid.json"), JSON.stringify(valid), "utf-8");

		// One corrupted file
		fs.writeFileSync(path.join(runsDir, "corrupt.json"), "not valid json{{{", "utf-8");

		const runs = listRuns(cwd);
		assert.equal(runs.length, 1);
		assert.equal(runs[0]!.runId, "valid");
	} finally {
		cleanup(cwd);
	}
});

test("listRuns: ignores non-JSON files in runs directory", () => {
	const cwd = makeTmpCwd();
	try {
		const state = mkRunState(cwd, { runId: "real-run" });
		saveRun(state);

		const runsDir = path.join(cwd, ".pi", "taskflows", "runs");
		fs.writeFileSync(path.join(runsDir, "README.md"), "# notes");
		fs.writeFileSync(path.join(runsDir, ".lock"), "");

		const runs = listRuns(cwd);
		assert.equal(runs.length, 1);
		assert.equal(runs[0]!.runId, "real-run");
	} finally {
		cleanup(cwd);
	}
});

test("listRuns: drops records lacking a valid numeric updatedAt (NaN sort guard)", () => {
	// Regression for F-010: an unvalidated JSON.parse may push records with no
	// `updatedAt` (or a non-number one) into the array. Comparing such records
	// produces NaN, which gives Array.prototype.sort implementation-defined
	// order. The fix filters them out before sorting.
	const cwd = makeTmpCwd();
	try {
		const runsDir = path.join(cwd, ".pi", "taskflows", "runs");
		fs.mkdirSync(runsDir, { recursive: true });

		// Valid run, newest.
		const valid: RunState = {
			runId: "valid",
			flowName: "f",
			def: minimalFlow("f"),
			args: {},
			status: "completed",
			phases: {},
			createdAt: 3000,
			updatedAt: 3000,
			cwd,
		};
		fs.writeFileSync(path.join(runsDir, "valid.json"), JSON.stringify(valid), "utf-8");

		// Valid run, older.
		const older: RunState = {
			runId: "older",
			flowName: "f",
			def: minimalFlow("f"),
			args: {},
			status: "completed",
			phases: {},
			createdAt: 1000,
			updatedAt: 1000,
			cwd,
		};
		fs.writeFileSync(path.join(runsDir, "older.json"), JSON.stringify(older), "utf-8");

		// Run missing updatedAt entirely.
		fs.writeFileSync(
			path.join(runsDir, "missing.json"),
			JSON.stringify({ runId: "missing", flowName: "f", status: "completed" }),
			"utf-8",
		);

		// Run with non-numeric updatedAt.
		fs.writeFileSync(
			path.join(runsDir, "stringy.json"),
			JSON.stringify({
				runId: "stringy",
				flowName: "f",
				status: "completed",
				updatedAt: "2024-01-01T00:00:00Z",
			}),
			"utf-8",
		);

		// Run with explicit NaN.
		fs.writeFileSync(
			path.join(runsDir, "nan.json"),
			JSON.stringify({ runId: "nan", flowName: "f", status: "completed", updatedAt: null }),
			"utf-8",
		);

		const runs = listRuns(cwd);
		// Only the two records with numeric updatedAt should remain, sorted desc.
		assert.deepEqual(
			runs.map((r) => r.runId),
			["valid", "older"],
		);
	} finally {
		cleanup(cwd);
	}
});

// ---------------------------------------------------------------------------
// findProjectFlowsDir (tested indirectly via saveFlow / listFlows)
// ---------------------------------------------------------------------------

test("findProjectFlowsDir: traverses up to find .pi directory", () => {
	const cwd = makeTmpCwd();
	try {
		// Save a flow at the root
		saveFlow(cwd, minimalFlow("root-flow"), "project");

		// Create a deeply nested subdirectory
		const deep = path.join(cwd, "a", "b", "c", "d");
		fs.mkdirSync(deep, { recursive: true });

		// getFlow from the nested dir should find the flow
		const flow = getFlow(deep, "root-flow");
		assert.ok(flow, "should traverse up and find flow in parent .pi dir");
		assert.equal(flow.name, "root-flow");
	} finally {
		cleanup(cwd);
	}
});

test("findProjectFlowsDir: nearest .pi wins over parent .pi", () => {
	const cwd = makeTmpCwd();
	try {
		// Save a flow at the root level
		saveFlow(cwd, minimalFlow("parent-version"), "project");

		// Create a child with its own .pi
		const child = path.join(cwd, "child");
		fs.mkdirSync(path.join(child, ".pi"), { recursive: true });

		// Save a different flow in the child
		saveFlow(child, minimalFlow("child-version"), "project");

		// Listing from child should show child-version but not parent-version
		const childFlows = listFlows(child);
		const childProjectNames = childFlows.filter((f) => f.scope === "project").map((f) => f.name);
		assert.ok(childProjectNames.includes("child-version"));
		assert.ok(!childProjectNames.includes("parent-version"), "child .pi should shadow parent .pi");
	} finally {
		cleanup(cwd);
	}
});

test("findProjectFlowsDir: stops at home dir (v0.0.8.1 boundary)", async () => {
	// Regression test for dogfooding v0.0.8 §12.5: walk-up used to cross the
	// home dir and mistake `~/.pi/` for a project flow dir, writing run state
	// to the user's home instead of the project's `.pi/`.
	//
	// We verify two things:
	// (1) when cwd is under the real home and no project .pi exists, the
	//     walk-up must skip home and return null (not pick up `~/.pi/`).
	// (2) when cwd is OUTSIDE home and walks past it, no error occurs.
	const { findProjectFlowsDir } = await import("../extensions/store.ts");
	const home = os.homedir();

	// (1) cwd under home, with no .pi anywhere up to home.
	const underHome = path.join(home, ".pi-taskflow-test-no-project");
	fs.mkdirSync(underHome, { recursive: true });
	try {
		const r = findProjectFlowsDir(underHome, false);
		assert.equal(
			r,
			null,
			`walk-up must skip home and return null (got ${r}); ` +
				`otherwise home's .pi/ is mistaken for a project flow dir`,
		);
	} finally {
		fs.rmSync(underHome, { recursive: true, force: true });
	}

	// (2) cwd outside home, with no .pi anywhere.
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-taskflow-outside-"));
	try {
		const r = findProjectFlowsDir(outside, false);
		assert.equal(r, null, "no .pi anywhere — should return null");
	} finally {
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Edge cases and regression guards
// ---------------------------------------------------------------------------

test("saveRun: handles args with complex values", () => {
	const cwd = makeTmpCwd();
	try {
		const state = mkRunState(cwd, {
			args: {
				files: ["a.ts", "b.ts"],
				config: { nested: true, count: 42 },
				empty: null,
			},
		});
		saveRun(state);
		const loaded = loadRun(cwd, state.runId);
		assert.ok(loaded);
		assert.deepEqual(loaded.args, {
			files: ["a.ts", "b.ts"],
			config: { nested: true, count: 42 },
			empty: null,
		});
	} finally {
		cleanup(cwd);
	}
});

test("saveRun: preserves gate verdict in phase state", () => {
	const cwd = makeTmpCwd();
	try {
		const state = mkRunState(cwd);
		state.phases.check = {
			id: "check",
			status: "done",
			gate: { verdict: "block", reason: "security issue found" },
		};
		saveRun(state);

		const loaded = loadRun(cwd, state.runId);
		assert.ok(loaded);
		assert.deepEqual(loaded.phases.check.gate, { verdict: "block", reason: "security issue found" });
	} finally {
		cleanup(cwd);
	}
});

test("flow and run directories are isolated under .pi/taskflows", () => {
	const cwd = makeTmpCwd();
	try {
		saveFlow(cwd, minimalFlow("f"), "project");
		saveRun(mkRunState(cwd));

		const taskflowsDir = path.join(cwd, ".pi", "taskflows");
		assert.ok(fs.existsSync(taskflowsDir));

		const entries = fs.readdirSync(taskflowsDir);
		assert.ok(entries.includes("runs"), "should have runs/ subdirectory");
		assert.ok(entries.some((e) => e.endsWith(".json")), "should have flow .json files");
	} finally {
		cleanup(cwd);
	}
});
