/**
 * Shorthand `cwd` — 0.2.0 dogfood issue 2.
 *
 * Top-level + per-step `cwd` for shorthand specs (single / chain / parallel):
 * desugar propagation, validation (per-branch workspace keywords rejected),
 * and runtime honoring of per-branch literal cwds (including mixed values).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { desugar, validateTaskflow } from "../src/schema.ts";
import type { AgentConfig } from "../src/agents.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { emptyUsage } from "../src/usage.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import type { RunState } from "../src/store.ts";

const AGENTS: AgentConfig[] = [{ name: "a", description: "test", systemPrompt: "", source: "user", filePath: "" }];

function mkState(def: ReturnType<typeof desugar>): RunState {
	return {
		runId: "t",
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: "/tmp",
	};
}

/** A mock runner that records the RunOptions.cwd passed to each call. */
function mockRunner(record?: { cwds: string[]; tasks: string[] }): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task, o: RunOptions): Promise<RunResult> => {
		record?.cwds.push(o.cwd ?? "(none)");
		record?.tasks.push(task);
		return {
			agent: agentName,
			task,
			exitCode: 0,
			output: `out:${task}`,
			stderr: "",
			usage: { ...emptyUsage(), output: 5, turns: 1 },
			stopReason: "end",
		};
	};
}

function deps(runTask: RuntimeDeps["runTask"]): RuntimeDeps {
	return { cwd: "/tmp", agents: AGENTS, runTask, persist: () => {}, onProgress: () => {} };
}

// ---------------------------------------------------------------------------
// desugar — cwd propagation
// ---------------------------------------------------------------------------

test("desugar single: top-level cwd lands on the main phase", () => {
	const def = desugar({ task: "x", cwd: "/repo" });
	assert.equal(def.phases[0].cwd, "/repo");
	assert.equal(validateTaskflow(def).ok, true);
});

test("desugar single: no cwd → phase.cwd undefined (uses run cwd)", () => {
	const def = desugar({ task: "x" });
	assert.equal(def.phases[0].cwd, undefined);
});

test("desugar chain: top-level cwd is the default for every step", () => {
	const def = desugar({ chain: [{ task: "a" }, { task: "b" }], cwd: "/repo" });
	assert.equal(def.phases[0].cwd, "/repo");
	assert.equal(def.phases[1].cwd, "/repo");
});

test("desugar chain: per-step cwd overrides top-level cwd", () => {
	const def = desugar({
		cwd: "/default",
		chain: [{ task: "a", cwd: "/step-a" }, { task: "b" }, { task: "c", cwd: "/step-c" }],
	});
	assert.equal(def.phases[0].cwd, "/step-a");
	assert.equal(def.phases[1].cwd, "/default");
	assert.equal(def.phases[2].cwd, "/step-c");
});

test("desugar parallel: top-level cwd lands on the phase (shared); per-branch cwd on each branch", () => {
	const def = desugar({
		cwd: "/shared",
		tasks: [{ task: "a" }, { task: "b", cwd: "/branch-b" }, { task: "c" }],
	});
	assert.equal(def.phases[0].cwd, "/shared"); // phase-level shared cwd
	assert.equal(def.phases[0].branches![0].cwd, undefined);
	assert.equal(def.phases[0].branches![1].cwd, "/branch-b");
	assert.equal(def.phases[0].branches![2].cwd, undefined);
	assert.equal(validateTaskflow(def).ok, true);
});

test("desugar parallel: per-branch cwd without top-level cwd", () => {
	const def = desugar({ tasks: [{ task: "a", cwd: "/x" }, { task: "b", cwd: "/y" }] });
	assert.equal(def.phases[0].cwd, undefined); // no shared phase cwd
	assert.equal(def.phases[0].branches![0].cwd, "/x");
	assert.equal(def.phases[0].branches![1].cwd, "/y");
});

// ---------------------------------------------------------------------------
// validation — per-branch workspace keywords rejected
// ---------------------------------------------------------------------------

test("validate: per-branch workspace keyword cwd is rejected with a precise message", () => {
	const def = desugar({ tasks: [{ task: "a", cwd: "temp" }, { task: "b" }] });
	const v = validateTaskflow(def);
	assert.equal(v.ok, false);
	assert.match(v.errors.join("\n"), /branches\[0\]\.cwd 'temp' is a reserved workspace keyword not supported per-branch/);
});

test("validate: per-branch workspace keyword 'worktree' rejected", () => {
	const def = desugar({ tasks: [{ task: "a", cwd: "worktree" }] });
	const v = validateTaskflow(def);
	assert.equal(v.ok, false);
	assert.match(v.errors.join("\n"), /branches\[0\]\.cwd 'worktree'/);
});

test("validate: per-branch interpolated cwd placeholder rejected", () => {
	const def = desugar({ tasks: [{ task: "a", cwd: "{args.dir}" }] });
	const v = validateTaskflow(def);
	assert.equal(v.ok, false);
	assert.match(v.errors.join("\n"), /branches\[0\]\.cwd does not support interpolation placeholders/);
});

test("validate: top-level (phase) workspace keyword cwd is ALLOWED (full workspace lifecycle)", () => {
	// A phase-level cwd = 'temp' is fine (the runtime allocates a per-phase workspace).
	const def = desugar({ cwd: "temp", tasks: [{ task: "a" }, { task: "b" }] });
	assert.equal(def.phases[0].cwd, "temp");
	const v = validateTaskflow(def);
	assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test("validate: single shorthand with workspace keyword cwd is allowed", () => {
	const def = desugar({ task: "x", cwd: "dedicated" });
	assert.equal(def.phases[0].cwd, "dedicated");
	const v = validateTaskflow(def);
	assert.equal(v.ok, true, JSON.stringify(v.errors));
});

// ---------------------------------------------------------------------------
// runtime — per-branch literal cwd honored (mixed values)
// ---------------------------------------------------------------------------

test("e2e: parallel branches honor mixed per-branch literal cwds", async () => {
	const def = desugar({
		tasks: [
			{ task: "a", cwd: "/branch-a" },
			{ task: "b", cwd: "/branch-b" },
			{ task: "c" }, // no branch cwd → uses phase cwd (run cwd /tmp)
		],
	});
	const rec: { cwds: string[]; tasks: string[] } = { cwds: [], tasks: [] };
	const res = await executeTaskflow(mkState(def), deps(mockRunner(rec)));
	assert.equal(res.ok, true);
	assert.equal(rec.cwds.length, 3);
	assert.ok(rec.cwds.includes("/branch-a"), `branch-a cwd honored: ${rec.cwds.join(",")}`);
	assert.ok(rec.cwds.includes("/branch-b"), `branch-b cwd honored: ${rec.cwds.join(",")}`);
	assert.ok(rec.cwds.includes("/tmp"), `branch without cwd fell back to run cwd: ${rec.cwds.join(",")}`);
});

test("e2e: parallel top-level cwd is the shared default for branches without their own cwd", async () => {
	const def = desugar({
		cwd: "/shared",
		tasks: [{ task: "a" }, { task: "b", cwd: "/override" }],
	});
	const rec: { cwds: string[]; tasks: string[] } = { cwds: [], tasks: [] };
	const res = await executeTaskflow(mkState(def), deps(mockRunner(rec)));
	assert.equal(res.ok, true);
	assert.equal(rec.cwds.length, 2);
	assert.ok(rec.cwds.includes("/shared"), `shared top-level cwd used: ${rec.cwds.join(",")}`);
	assert.ok(rec.cwds.includes("/override"), `per-branch override used: ${rec.cwds.join(",")}`);
});

test("e2e: single shorthand cwd propagates to the subagent call", async () => {
	const def = desugar({ task: "x", cwd: "/repo" });
	const rec: { cwds: string[]; tasks: string[] } = { cwds: [], tasks: [] };
	const res = await executeTaskflow(mkState(def), deps(mockRunner(rec)));
	assert.equal(res.ok, true);
	assert.equal(rec.cwds.length, 1);
	assert.equal(rec.cwds[0], "/repo");
});

test("e2e: chain per-step cwd overrides top-level for each step's call", async () => {
	const def = desugar({
		cwd: "/default",
		chain: [{ task: "a", cwd: "/step-a" }, { task: "b" }],
	});
	const rec: { cwds: string[]; tasks: string[] } = { cwds: [], tasks: [] };
	const res = await executeTaskflow(mkState(def), deps(mockRunner(rec)));
	assert.equal(res.ok, true);
	assert.deepEqual(rec.cwds, ["/step-a", "/default"]);
});
