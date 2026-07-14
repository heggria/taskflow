/**
 * Shorthand `cwd` — 0.2.0 dogfood issue 2.
 *
 * Top-level + per-step `cwd` for shorthand specs (single / chain / parallel):
 * desugar propagation, validation (per-branch workspace keywords rejected),
 * and runtime honoring of per-branch literal cwds (including mixed values).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { desugar, validateTaskflow, type Taskflow } from "../src/schema.ts";
import type { AgentConfig } from "../src/agents.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { emptyUsage } from "../src/usage.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { kernelUnsupportedReason } from "../src/exec/kernel-policy.ts";
import { CacheStore } from "../src/cache.ts";
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

test("validate: branches[].cwd is rejected for race and tournament instead of being ignored", () => {
	for (const type of ["race", "tournament"] as const) {
		const v = validateTaskflow({
			name: `${type}-branch-cwd`,
			phases: [{
				id: "p",
				type,
				branches: [{ task: "a", cwd: "." }, { task: "b" }],
				final: true,
			}],
		});
		assert.equal(v.ok, false);
		assert.match(v.errors.join("\n"), /branches\[0\]\.cwd is only supported for parallel phases/);
	}
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

// ---------------------------------------------------------------------------
// Relative branch cwd anchored to deps.cwd (0.2.0 dogfood issue 2)
// ---------------------------------------------------------------------------

test("e2e: relative branch cwd is resolved against deps.cwd", async () => {
	const def = desugar({
		cwd: "/base",
		tasks: [{ task: "a", cwd: "subdir" }, { task: "b" }],
	});
	const rec: { cwds: string[]; tasks: string[] } = { cwds: [], tasks: [] };
	// Override deps.cwd so the relative path is anchored there.
	const depsCustom: RuntimeDeps = { cwd: "/workspace", agents: AGENTS, runTask: mockRunner(rec), persist: () => {}, onProgress: () => {} };
	const res = await executeTaskflow(mkState(def), depsCustom);
	assert.equal(res.ok, true);
	assert.equal(rec.cwds.length, 2);
	// Phase cwd = "/base" (from shorthand top-level). Branch a has relative "subdir"
	// which is resolved as path.resolve(deps.cwd, callCwd) = "/workspace/subdir".
	// Branch b has undefined branch cwd → uses phase cwd "/base".
	assert.equal(rec.cwds[0], path.resolve("/workspace", "subdir"));
	assert.equal(rec.cwds[1], "/base");
});

// ---------------------------------------------------------------------------
// Non-shorthand classic parallel with mixed cwds (no desugar)
// ---------------------------------------------------------------------------

test("e2e: classic parallel phase with mixed per-branch cwds works", async () => {
	// Directly construct a flow with a parallel phase (not via desugar).
	const def: Taskflow = {
		name: "classic-parallel",
		phases: [
			{
				id: "p", type: "parallel",
				agent: "a", task: "shared",
				branches: [
					{ task: "branch-a", cwd: "/branch-a" },
					{ task: "branch-b" }, // no cwd → uses phase cwd
					{ task: "branch-c", cwd: "/branch-c" },
				],
				final: true,
			},
		],
	};
	const rec: { cwds: string[]; tasks: string[] } = { cwds: [], tasks: [] };
	const res = await executeTaskflow(
		{ runId: "t", flowName: def.name, def, args: {}, status: "running", phases: {}, createdAt: Date.now(), updatedAt: Date.now(), cwd: "/tmp" },
		{ cwd: "/tmp", agents: AGENTS, runTask: mockRunner(rec), persist: () => {}, onProgress: () => {} },
	);
	assert.equal(res.ok, true);
	assert.equal(rec.cwds.length, 3);
	assert.ok(rec.cwds.includes("/branch-a"));
	assert.ok(rec.cwds.includes("/tmp"));
	assert.ok(rec.cwds.includes("/branch-c"));
});

test("e2e: relative branch cwd is canonicalized in cross-run cache identity", async () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "tf-branch-cache-"));
	const rootA = path.join(base, "a");
	const rootB = path.join(base, "b");
	const cacheRoot = path.join(base, "cache-root");
	fs.mkdirSync(rootA, { recursive: true });
	fs.mkdirSync(rootB, { recursive: true });
	fs.mkdirSync(cacheRoot, { recursive: true });
	try {
		const def: Taskflow = {
			name: "parallel-cwd-cache",
			phases: [{
				id: "p",
				type: "parallel",
				branches: [{ task: "where", cwd: "." }],
				cache: { scope: "cross-run" },
				final: true,
			}],
		};
		const cacheStore = new CacheStore(cacheRoot);
		let calls = 0;
		const runTask: RuntimeDeps["runTask"] = async (cwd, _agents, agentName, task) => {
			calls++;
			return {
				agent: agentName,
				task,
				exitCode: 0,
				output: cwd,
				stderr: "",
				usage: emptyUsage(),
				stopReason: "end",
			};
		};
		const runAt = async (cwd: string, runId: string) => executeTaskflow({
			runId,
			flowName: def.name,
			def,
			args: {},
			status: "running",
			phases: {},
			createdAt: Date.now(),
			updatedAt: Date.now(),
			cwd,
		}, { cwd, agents: AGENTS, runTask, cacheStore, persist: () => {} });

		const first = await runAt(rootA, "cwd-a");
		const second = await runAt(rootB, "cwd-b");
		assert.equal(first.ok, true);
		assert.equal(second.ok, true);
		assert.equal(calls, 2, "different resolved branch directories must not share a cache entry");
		assert.equal(second.state.phases.p.cacheHit, undefined);
		assert.match(second.finalOutput, new RegExp(rootB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Validation: per-branch cwd rejected with phase-level workspace keyword
// ---------------------------------------------------------------------------

test("validate: per-branch cwd rejected when phase has workspace keyword cwd", () => {
	const def = desugar({
		cwd: "temp", // phase-level workspace keyword
		tasks: [{ task: "a", cwd: "/my-cwd" }, { task: "b" }],
	});
	const v = validateTaskflow(def);
	assert.equal(v.ok, false);
	assert.match(v.errors.join("\n"), /branches\[0\]\.cwd cannot override phase cwd 'temp'/);
});

test("validate: per-branch cwd rejected when phase has cwd placeholder", () => {
	const def = desugar({
		cwd: "{args.dir}", // cwd placeholder referencing an argument
		tasks: [{ task: "a", cwd: "/my-cwd" }, { task: "b" }],
	});
	const v = validateTaskflow(def);
	assert.equal(v.ok, false);
	assert.match(v.errors.join("\n"), /branches\[0\]\.cwd cannot override phase cwd/);
});

// ---------------------------------------------------------------------------
// Validation: dynamic sub-flow branch cwd rejected
// ---------------------------------------------------------------------------

test("validate: dynamic sub-flow phase with branches[].cwd is rejected", () => {
	const def: Taskflow = {
		name: "dynamic-subflow-cwd",
		phases: [
			{ id: "s", type: "agent", agent: "a", task: "gen" },
			{ id: "f", type: "flow", dependsOn: ["s"],
				def: "{steps.s.json}",
				final: true,
				branches: [{ task: "branch-a", cwd: "/my-cwd" }],
			},
		],
	};
	// The dynamic hardening checks require opts.dynamic = true.
	const v = validateTaskflow(def, { dynamic: true });
	assert.equal(v.ok, false);
	assert.match(v.errors.join("\n"), /branches\[0\]\.cwd selection is not allowed/);
});

test("kernel admission: parallel branches with cwd force imperative fallback", () => {
	const def: Taskflow = {
		name: "branch-cwd-kernel",
		phases: [{
			id: "p", type: "parallel", final: true,
			branches: [{ task: "a", cwd: "/tmp" }, { task: "b" }],
		}],
	};
	assert.match(kernelUnsupportedReason(def) ?? "", /per-branch cwd requires the imperative runtime/);
});


test("e2e: runtime boundary guard rejects per-branch cwd outside boundary", async () => {
	// NOTE: on macOS /tmp is a symlink to /private/tmp, and directoryIdentity()
	// calls fs.realpathSync() which resolves it. So _cwdBoundary and the
	// branch cwds must use realpath-ed paths for comparison to work.
	const fs = await import("node:fs");
	const os = await import("node:os");
	const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tf-boundary-")));
	const boundaryDir = path.join(base, "boundary");
	const innerAllowed = path.join(boundaryDir, "allowed");
	const escapeDir = path.join(base, "outside");
	fs.mkdirSync(innerAllowed, { recursive: true });
	fs.mkdirSync(escapeDir, { recursive: true });

	const def: Taskflow = {
		name: "boundary-guard",
		phases: [
			{
				id: "p", type: "parallel",
				agent: "a", task: "shared",
				branches: [
					{ task: "good", cwd: innerAllowed },
					{ task: "escape", cwd: escapeDir },
				],
				final: true,
			},
		],
	};
	const rec: { cwds: string[]; tasks: string[] } = { cwds: [], tasks: [] };
	const depsBoundary: RuntimeDeps = {
		cwd: boundaryDir,
		agents: AGENTS,
		runTask: mockRunner(rec),
		persist: () => {},
		onProgress: () => {},
		_cwdBoundary: boundaryDir,
	};
	const state = { runId: "t", flowName: def.name, def: def, args: {}, status: "running" as const, phases: {}, createdAt: Date.now(), updatedAt: Date.now(), cwd: boundaryDir };
	const res = await executeTaskflow(state, depsBoundary);
	// The run fails because the escape branch is blocked.
	assert.equal(res.ok, false);
	// The good (inside-boundary) branch should have run.
	assert.equal(rec.cwds.length, 1, "only the allowed branch should run");
	// Verify the phase output mentions the boundary escape.
	const ps = res.state.phases.p;
	assert.ok(ps, "phase p must exist");
	const psText = JSON.stringify(ps);
	assert.match(psText, /TF_CWD_BOUNDARY_ESCAPE/);

	try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
});

test("e2e: runtime guard rejects per-branch cwd when phase has workspace binding", async () => {
	// When a phase-level workspace binding is active, any per-branch cwd is
	// rejected (even if inside the boundary).
	const def: Taskflow = {
		name: "binding-guard",
		phases: [
			{
				id: "p", type: "parallel",
				agent: "a", task: "shared", cwd: "temp", // workspace keyword
				branches: [
					{ task: "branch-a", cwd: "/any" },
				],
				final: true,
			},
		],
	};
	// This flow would normally fail at validation - test that validation rejects it.
	const vBefore = validateTaskflow(def);
	assert.equal(vBefore.ok, false);
	assert.match(vBefore.errors.join("\n"), /cannot override phase cwd 'temp'/);
});
