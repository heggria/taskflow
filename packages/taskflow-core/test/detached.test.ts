import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { Taskflow } from "../src/schema.ts";
import {
	isProcessAlive,
	loadRun,
	newRunId,
	type RunState,
	saveFlow,
	saveRun,
} from "../src/store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpCwd(): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-detached-test-"));
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
// isProcessAlive
// ---------------------------------------------------------------------------

test("isProcessAlive: returns true for the current process", () => {
	assert.equal(isProcessAlive(process.pid), true);
});

test("isProcessAlive: returns false for a definitely-dead PID", () => {
	assert.equal(isProcessAlive(Number.MAX_SAFE_INTEGER), false);
});

// ---------------------------------------------------------------------------
// RunState backward compatibility (pid/detached optional)
// ---------------------------------------------------------------------------

test("store: RunState without pid/detached loads cleanly (backward compat)", () => {
	const cwd = makeTmpCwd();
	try {
		const state = mkRunState(cwd, { status: "completed" });
		// Manually write a JSON without pid/detached (simulating old format)
		const flowDir = path.join(cwd, ".pi", "taskflows", "runs", "test-flow");
		fs.mkdirSync(flowDir, { recursive: true });
		const filePath = path.join(flowDir, `${state.runId}.json`);
		const { pid: _pid, detached: _detached, ...oldFormat } = state as RunState & { pid?: number; detached?: boolean };
		fs.writeFileSync(filePath, JSON.stringify(oldFormat));

		const loaded = loadRun(cwd, state.runId);
		assert.ok(loaded, "should load old format");
		assert.equal(loaded!.status, "completed");
		assert.equal(loaded!.pid, undefined);
		assert.equal(loaded!.detached, undefined);
	} finally {
		cleanup(cwd);
	}
});

// ---------------------------------------------------------------------------
// RunState with pid/detached persists and loads
// ---------------------------------------------------------------------------

test("store: RunState with pid/detached persists and loads correctly", () => {
	const cwd = makeTmpCwd();
	try {
		const state = mkRunState(cwd, { status: "running", pid: 12345, detached: true });
		saveRun(state);

		const loaded = loadRun(cwd, state.runId);
		assert.ok(loaded, "should load detached run");
		assert.equal(loaded!.pid, 12345);
		assert.equal(loaded!.detached, true);
		assert.equal(loaded!.status, "running");
	} finally {
		cleanup(cwd);
	}
});

// ---------------------------------------------------------------------------
// Detached runner script: end-to-end
// ---------------------------------------------------------------------------

test("detached-runner: completes flow and persists terminal state", async () => {
	const cwd = makeTmpCwd();
	try {
		// Create a saved flow that the runner can execute.
		const def = minimalFlow("detach-e2e");
		saveFlow(cwd, def, "project");

		const state = mkRunState(cwd, { flowName: "detach-e2e", status: "running", detached: true });
		saveRun(state);

		// Write a mock detached-runner script that simulates the real runner
		// without needing live model access.
		const mockRunnerPath = path.join(cwd, "mock-detached-runner.mts");
		fs.writeFileSync(mockRunnerPath, `
import { readFileSync } from "node:fs";
import { loadRun, saveRun } from "${path.resolve("packages/taskflow-core/src/store.ts")}";

interface DetachContext {
	runId: string;
	defName: string;
	args: Record<string, unknown>;
	cwd: string;
}

const ctx: DetachContext = JSON.parse(readFileSync(process.argv[2]!, "utf-8"));
const state = loadRun(ctx.cwd, ctx.runId);
if (!state) { console.error("Run not found"); process.exit(1); }
// Only update status and phases — preserve pid, detached, and all other fields.
state.status = "completed";
state.phases = {
	p1: {
		id: "p1",
		status: "done",
		output: "detached completed",
		endedAt: Date.now(),
	},
};
saveRun(state);
`);

		// Spawn the mock runner as a detached process.
		const { spawn } = await import("node:child_process");
		const tmpFile = path.join(os.tmpdir(), `taskflow-detach-ctx-${state.runId}.json`);
		fs.writeFileSync(tmpFile, JSON.stringify({
			runId: state.runId,
			defName: "detach-e2e",
			args: {},
			cwd,
		}));

		const child = spawn(process.execPath, ["--experimental-strip-types", mockRunnerPath, tmpFile], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();

		// Record PID and persist (mirrors index.ts detach logic).
		state.pid = child.pid ?? undefined;
		saveRun(state);

		// Wait for the runner to finish (poll the file).
		let loaded: RunState | null = null;
		for (let i = 0; i < 50; i++) {
			await new Promise((r) => setTimeout(r, 100));
			loaded = loadRun(cwd, state.runId);
			if (loaded && loaded.status !== "running") break;
		}

		assert.ok(loaded, "should load run after completion");
		assert.equal(loaded!.status, "completed");
		assert.equal(loaded!.detached, true);
		assert.equal(loaded!.pid, child.pid);
		assert.equal(loaded!.phases.p1?.output, "detached completed");

		// Cleanup temp files.
		try { fs.unlinkSync(mockRunnerPath); } catch { /* ignore */ }
		try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
	} finally {
		cleanup(cwd);
	}
});

// ---------------------------------------------------------------------------
// Detached runner: process crash persists failure
// ---------------------------------------------------------------------------

test("detached-runner: script crash results in failed state (manual test)", () => {
	const cwd = makeTmpCwd();
	try {
		const state = mkRunState(cwd, { status: "running", detached: true, pid: Number.MAX_SAFE_INTEGER });
		saveRun(state);

		// Simulate what the real detached-runner does on crash:
		// load the state, mark it failed, persist.
		const loaded = loadRun(cwd, state.runId);
		assert.ok(loaded, "should load the running state");
		assert.equal(loaded!.status, "running");

		// Simulate the crash handler from detached-runner.ts
		loaded!.status = "failed";
		saveRun(loaded!);

		const afterCrash = loadRun(cwd, state.runId);
		assert.ok(afterCrash, "should load the failed state");
		assert.equal(afterCrash!.status, "failed");
		assert.equal(afterCrash!.detached, true);
		assert.equal(afterCrash!.pid, Number.MAX_SAFE_INTEGER);
	} finally {
		cleanup(cwd);
	}
});

// ---------------------------------------------------------------------------
// Resume a crashed detached run
// ---------------------------------------------------------------------------

test("store: resume works for a failed detached run", () => {
	const cwd = makeTmpCwd();
	try {
		const state = mkRunState(cwd, {
			status: "failed",
			detached: true,
			pid: Number.MAX_SAFE_INTEGER,
			phases: {
				p1: { id: "p1", status: "failed", error: "subagent crashed", endedAt: Date.now() },
			},
		});
		saveRun(state);

		// Load and simulate resume (clear stale endedAt/error on the failed phase).
		const prev = loadRun(cwd, state.runId);
		assert.ok(prev, "should load the failed run");
		assert.equal(prev!.status, "failed");
		assert.equal(prev!.detached, true);

		// Simulate resume: reset status and phase state.
		prev!.status = "running";
		prev!.phases.p1!.status = "pending";
		delete prev!.phases.p1!.error;
		delete prev!.phases.p1!.endedAt;
		saveRun(prev!);

		const resumed = loadRun(cwd, state.runId);
		assert.ok(resumed, "should load the resumed state");
		assert.equal(resumed!.status, "running");
		assert.equal(resumed!.phases.p1!.status, "pending");
		assert.equal(resumed!.phases.p1!.error, undefined);
	} finally {
		cleanup(cwd);
	}
});

// ---------------------------------------------------------------------------
// Stale PID detection via isProcessAlive
// ---------------------------------------------------------------------------

test("isProcessAlive: stale PID detected correctly", () => {
	const cwd = makeTmpCwd();
	try {
		const state = mkRunState(cwd, {
			status: "running",
			detached: true,
			pid: Number.MAX_SAFE_INTEGER, // definitely not alive
		});
		saveRun(state);

		const loaded = loadRun(cwd, state.runId);
		assert.ok(loaded, "should load the state");
		assert.equal(isProcessAlive(loaded!.pid!), false, "stale PID should be detected as not alive");
	} finally {
		cleanup(cwd);
	}
});
