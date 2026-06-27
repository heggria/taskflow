import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../extensions/agents.ts";
import { CacheStore } from "../extensions/cache.ts";
import { executeTaskflow, summarizeReuse, type RuntimeDeps } from "../extensions/runtime.ts";
import type { RunResult, RunOptions } from "../extensions/runner.ts";
import type { Taskflow } from "../extensions/schema.ts";
import type { RunState } from "../extensions/store.ts";
import { emptyUsage } from "../extensions/usage.ts";

// summarizeReuse: the incremental-reuse accounting behind the run summary.
// A phase counts as reused iff it carries a `cacheHit` marker (within-run
// resume → "run-only"; cross-run store → "cross-run").

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test agent", systemPrompt: "", source: "user", filePath: "" },
];

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tf-reuse-"));
}

function mkState(def: Taskflow, cwd: string): RunState {
	return {
		runId: `run-${Math.random().toString(36).slice(2, 8)}`,
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
	};
}

function runner(): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task, _o: RunOptions): Promise<RunResult> => ({
		agent: agentName,
		task,
		exitCode: 0,
		output: `out:${task}`,
		stderr: "",
		usage: { ...emptyUsage(), output: 10, cost: 0.002, turns: 1 },
		stopReason: "end",
	});
}

const CHAIN: Taskflow = {
	name: "reuse-chain",
	phases: [
		{ id: "scout", type: "agent", agent: "a", task: "scan" },
		{ id: "audit", type: "agent", agent: "a", task: "audit {steps.scout.output}", dependsOn: ["scout"] },
		{ id: "report", type: "agent", agent: "a", task: "report {steps.audit.output}", dependsOn: ["audit"], final: true },
	],
} as Taskflow;

test("summarizeReuse: a first run executes every phase, reuses none", async () => {
	const dir = tmpDir();
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: runner() };
	const r = await executeTaskflow(mkState(CHAIN, dir), deps);

	const s = summarizeReuse(r.state);
	assert.equal(s.executed, 3, "all three phases executed");
	assert.equal(s.reusedRunOnly, 0);
	assert.equal(s.reusedCrossRun, 0);
	assert.equal(s.done, 3);
	assert.equal(s.savedUSD, 0, "nothing reused → nothing saved");
	assert.deepEqual(r.reuse, s, "RuntimeResult.reuse matches summarizeReuse(state)");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("summarizeReuse: resuming a completed run reuses every phase within-run (savedUSD > 0)", async () => {
	const dir = tmpDir();
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: runner() };
	const state = mkState(CHAIN, dir);
	await executeTaskflow(state, deps);

	// Re-run the SAME state object: every phase is already `done` with a matching
	// inputHash → the within-run resume path serves each from its prior.
	const r2 = await executeTaskflow(state, deps);
	const s = summarizeReuse(r2.state);

	assert.equal(s.executed, 0, "nothing re-executed on resume");
	assert.equal(s.reusedRunOnly, 3, "all three reused within-run");
	assert.equal(s.reusedCrossRun, 0);
	assert.equal(s.done, 3);
	// Each phase preserved its prior usage (cost 0.002) → 3 × 0.002 saved.
	assert.ok(Math.abs(s.savedUSD - 0.006) < 1e-9, `savedUSD should be ~0.006, got ${s.savedUSD}`);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("summarizeReuse: a second run under cross-run cache counts cross-run reuse", async () => {
	const dir = tmpDir();
	const store = new CacheStore(dir);
	const deps: RuntimeDeps = {
		cwd: dir,
		agents: AGENTS,
		runTask: runner(),
		cacheStore: store,
		cacheScopeDefault: "cross-run",
	};
	await executeTaskflow(mkState(CHAIN, dir), deps);
	// A fresh state (new runId) re-running the same flow hits the cross-run store.
	const r2 = await executeTaskflow(mkState(CHAIN, dir), deps);
	const s = summarizeReuse(r2.state);

	assert.equal(s.reusedCrossRun, 3, "all three restored from cross-run cache");
	assert.equal(s.executed, 0, "nothing executed the second run");
	// Cross-run hits zero their usage → original cost not recoverable.
	assert.equal(s.savedUSD, 0, "cross-run reuse does not claim a dollar figure");
	assert.equal(s.done, 3);
	fs.rmSync(dir, { recursive: true, force: true });
});
