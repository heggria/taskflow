import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { validateTaskflow, type Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

const AGENTS: AgentConfig[] = [{ name: "a", description: "t", systemPrompt: "", source: "user", filePath: "" }];

async function tmpCwd(): Promise<string> {
	return fs.promises.mkdtemp(path.join(os.tmpdir(), "ws-iso-cwd-"));
}

function mkState(def: Taskflow, cwd: string): RunState {
	return {
		runId: "ws-iso-run",
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

function ok(agentName: string, task: string, output: string): RunResult {
	return { agent: agentName, task, exitCode: 0, output, stderr: "", usage: { ...emptyUsage(), turns: 1 }, stopReason: "end" };
}

test("workspace isolation: cwd:'temp' runs the subagent in an allocated dir, removed afterwards", async () => {
	const cwd = await tmpCwd();
	let seenCwd: string | undefined;
	try {
		const runTask: RuntimeDeps["runTask"] = async (passedCwd, _a, agentName, task, o: RunOptions) => {
			seenCwd = o.cwd ?? passedCwd;
			return ok(agentName, task, "done");
		};
		const def: Taskflow = {
			name: "ws-temp",
			phases: [{ id: "scratch", type: "agent", agent: "a", cwd: "temp", task: "do work", final: true }],
		};
		const res = await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		assert.ok(res.ok);
		assert.ok(seenCwd, "runner received a cwd");
		assert.notEqual(path.resolve(seenCwd!), path.resolve(cwd), "did NOT run in the base cwd");
		assert.ok(seenCwd!.startsWith(os.tmpdir()), "ran in a temp dir under the OS tmpdir");
		assert.equal(fs.existsSync(seenCwd!), false, "temp workspace removed after the phase");
		// A diagnostic warning records the isolation.
		const warnings = res.state.phases["scratch"].warnings ?? [];
		assert.ok(warnings.some((w) => w.includes("workspace:temp")), `warning recorded: ${JSON.stringify(warnings)}`);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("workspace isolation: cwd:'dedicated' persists under the run state and is reused", async () => {
	const cwd = await tmpCwd();
	let seenCwd: string | undefined;
	try {
		const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task, o: RunOptions) => {
			seenCwd = o.cwd;
			return ok(agentName, task, "done");
		};
		const def: Taskflow = {
			name: "ws-ded",
			phases: [{ id: "keep", type: "agent", agent: "a", cwd: "dedicated", task: "do work", final: true }],
		};
		const res = await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		assert.ok(res.ok);
		assert.ok(seenCwd && seenCwd.includes(path.join("ws", "ws-iso-run", "keep")), `dedicated path: ${seenCwd}`);
		assert.ok(fs.existsSync(seenCwd!), "dedicated workspace KEPT after the phase");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("workspace isolation: a non-keyword cwd is passed through unchanged (back-compat)", async () => {
	const cwd = await tmpCwd();
	const sub = path.join(cwd, "sub");
	fs.mkdirSync(sub);
	let seenCwd: string | undefined;
	try {
		const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task, o: RunOptions) => {
			seenCwd = o.cwd;
			return ok(agentName, task, "done");
		};
		const def: Taskflow = {
			name: "ws-literal",
			phases: [{ id: "p", type: "agent", agent: "a", cwd: sub, task: "do work", final: true }],
		};
		await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		assert.equal(path.resolve(seenCwd!), path.resolve(sub), "literal cwd passed through verbatim");
		assert.ok(fs.existsSync(sub), "literal cwd not torn down");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("workspace isolation: reserved keyword in a DYNAMIC (LLM-authored) flow is rejected", () => {
	const dyn: Taskflow = {
		name: "evil",
		phases: [{ id: "x", type: "agent", cwd: "worktree", task: "mutate the repo" }],
	};
	const v = validateTaskflow(dyn, { dynamic: true, cwd: "/tmp/run" });
	assert.equal(v.ok, false);
	assert.ok(v.errors.some((e) => /reserved workspace keyword/i.test(e)), `errors: ${v.errors.join("; ")}`);

	// But the same flow is accepted when author-written (non-dynamic).
	const ok2 = validateTaskflow(dyn);
	assert.equal(ok2.ok, true, `author-written keyword cwd should be allowed: ${ok2.errors?.join("; ")}`);
});

test("workspace isolation: temp dir is torn down even when the phase FAILS", async () => {
	const cwd = await tmpCwd();
	let seenCwd: string | undefined;
	try {
		const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task, o: RunOptions) => {
			seenCwd = o.cwd;
			await new Promise((r) => setTimeout(r, 10));
			throw new Error("boom");
		};
		const def: Taskflow = {
			name: "ws-fail",
			phases: [{ id: "p", type: "agent", agent: "a", cwd: "temp", task: "work", final: true }],
		};
		await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		assert.ok(seenCwd, "runner got a cwd");
		assert.equal(fs.existsSync(seenCwd!), false, "temp workspace removed even on failure (finally teardown)");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("workspace isolation: a spawned subflow inherits the parent's isolated dir as its BASE cwd (consistent with flow{def}), and _cwdOverride does not force-leak", async () => {
	const { queueSpawn } = await import("../src/context-store.ts");
	const cwd = await tmpCwd();
	const seen: Record<string, string> = {};
	try {
		const runTask: RuntimeDeps["runTask"] = async (_c, _a, agentName, task, o: RunOptions) => {
			// Parent phase (isolated temp) queues a subflow, then the subflow's
			// inner phase runs — record each one's cwd.
			if (task.includes("PARENT") && o.ctxDir && o.nodeId) {
				queueSpawn(o.ctxDir, o.nodeId, [
					{ subflow: { phases: [{ id: "inner", type: "agent", agent: "a", task: "INNER work", final: true }] }, defaultAgent: "a" },
				]);
				seen.parent = o.cwd ?? "";
				return ok(agentName, task, "parent done");
			}
			if (task.includes("INNER")) seen.inner = o.cwd ?? "";
			return ok(agentName, task, "inner done");
		};
		const def: Taskflow = {
			name: "ws-spawn-leak",
			contextSharing: true,
			phases: [{ id: "lead", type: "agent", agent: "a", cwd: "temp", task: "PARENT work", final: true }],
		};
		await executeTaskflow(mkState(def, cwd), { cwd, agents: AGENTS, runTask, persist: () => {} });
		assert.ok(seen.parent && seen.parent.startsWith(os.tmpdir()), `parent ran in isolated temp: ${seen.parent}`);
		assert.ok(seen.inner !== undefined, "inner subflow phase ran");
		// The spawned subflow's inner phases use the parent's isolated dir as their
		// BASE cwd (same isolation scope) — this matches the flow{def} handler.
		// _cwdOverride is cleared so an inner phase that sets its own cwd would
		// re-resolve, but with no inner cwd it falls back to the propagated base.
		assert.equal(path.resolve(seen.inner), path.resolve(seen.parent), "inner inherits the parent's isolated dir as base cwd (consistent with flow{def})");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
