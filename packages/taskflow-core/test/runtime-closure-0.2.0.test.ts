import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import { CacheStore } from "../src/cache.ts";
import { canUseEventKernel, kernelUnsupportedReason } from "../src/exec/driver.ts";
import { clampSubFlowBudget, containsInterpolationPlaceholder } from "../src/exec/kernel-policy.ts";
import { compileTaskflowToIR } from "../src/flowir/index.ts";
import { queueSpawn } from "../src/context-store.ts";
import type { RunOptions, RunResult } from "../src/host/runner-types.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { FileTraceSink, readTrace } from "../src/trace.ts";
import { foldEvents } from "../src/exec/fold.ts";
import { upgradeTraceEvent } from "../src/exec/events.ts";
import { emptyUsage } from "../src/usage.ts";

const AGENT: AgentConfig = {
	name: "a",
	description: "test",
	systemPrompt: "",
	source: "user",
	filePath: "",
};

function state(def: Taskflow, cwd: string, runId = `r-${Math.random()}`): RunState {
	return {
		runId,
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

function ok(agent: string, task: string, output = "ok", cost = 0): RunResult {
	return {
		agent,
		task,
		exitCode: 0,
		output,
		stderr: "",
		usage: { ...emptyUsage(), cost, turns: 1 },
		stopReason: "end",
	};
}

test("kernel admission safely falls back for every currently unsupported semantic", () => {
	const cases: Array<[Taskflow, RegExp]> = [
		[{ name: "cwd", phases: [{ id: "p", task: "x", cwd: "/tmp", final: true }] }, /cwd/],
		[{ name: "ctx", phases: [{ id: "p", task: "x", context: ["a.txt"], final: true }] }, /context/],
		[{ name: "stdin", phases: [{ id: "p", type: "script", run: ["cat"], input: "x", final: true }] }, /stdin/],
		[
			{ name: "argv", phases: [{ id: "p", type: "script", run: ["echo", "{args.x}"], final: true }] },
			/argv/,
		],
		[
			{
				name: "layer",
				phases: [
					{ id: "a", task: "a" },
					{ id: "b", task: "b", final: true },
				],
			},
			/concurrent DAG layers/,
		],
		[
			{
				name: "budget-map",
				budget: { maxUSD: 1 },
				phases: [{ id: "m", type: "map", over: "[]", task: "x", final: true }],
			},
			/budgeted fan-out/,
		],
	];
	for (const [def, reason] of cases) {
		assert.equal(canUseEventKernel(def), false, def.name);
		assert.match(kernelUnsupportedReason(def) ?? "", reason, def.name);
	}
});

test("kernel placeholder detection is linear and distinguishes static JSON", () => {
	assert.equal(containsInterpolationPlaceholder("{args.topic}"), true);
	assert.equal(containsInterpolationPlaceholder("prefix {steps.make.json.value} suffix"), true);
	assert.equal(containsInterpolationPlaceholder('{"name":"child","phases":[]}'), false);
	assert.equal(containsInterpolationPlaceholder("{".repeat(200_000)), false);
	assert.equal(
		canUseEventKernel({
			name: "static-string-child",
			phases: [{
				id: "child",
				type: "flow",
				def: JSON.stringify({ name: "nested", phases: [{ id: "run", type: "agent", task: "ok", final: true }] }),
				final: true,
			}],
		}),
		true,
	);
});

test("kernel opt-in falls back to imperative for script stdin and interpolated argv", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-kernel-fallback-"));
	try {
		const def: Taskflow = {
			name: "stdin-fallback",
			args: { value: {} },
			phases: [
				{
					id: "p",
					type: "script",
					run: ["node", "-e", "process.stdin.on('data',d=>process.stdout.write(d.toString()))"],
					input: "hello!",
				},
				{
					id: "argv",
					type: "script",
					run: ["node", "-e", "process.stdout.write(process.argv[1])", "{args.value}"],
					dependsOn: ["p"],
					final: true,
				},
			],
		};
		const runState = state(def, cwd);
		runState.args = { value: "argv-ok" };
		const result = await executeTaskflow(runState, {
			cwd,
			agents: [AGENT],
			runTask: async () => {
				throw new Error("script should not invoke agent");
			},
			eventKernel: true,
			persist: () => {},
		});
		assert.equal(result.ok, true);
		assert.equal(result.state.phases.p.output, "hello!");
		assert.equal(result.finalOutput, "argv-ok");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("kernel opt-in preserves literal cwd and context pre-read through safe fallback", async () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "tf-kernel-context-"));
	const phaseCwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-kernel-cwd-"));
	try {
		fs.writeFileSync(path.join(base, "context.txt"), "CONTEXT-MARKER");
		const def: Taskflow = {
			name: "cwd-context-fallback",
			phases: [
				{
					id: "p",
					task: "QUESTION",
					cwd: phaseCwd,
					context: [path.join(base, "context.txt")],
					final: true,
				},
			],
		};
		let observedCwd = "";
		let observedTask = "";
		await executeTaskflow(state(def, base), {
			cwd: base,
			agents: [AGENT],
			runTask: async (cwd, _agents, agent, task) => {
				observedCwd = cwd;
				observedTask = task;
				return ok(agent, task);
			},
			eventKernel: true,
			persist: () => {},
		});
		assert.equal(observedCwd, phaseCwd);
		assert.match(observedTask, /CONTEXT-MARKER/);
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
		fs.rmSync(phaseCwd, { recursive: true, force: true });
	}
});

test("kernel opt-in preserves same-layer concurrency semantics via fallback", async () => {
	const def: Taskflow = {
		name: "same-layer-gate",
		phases: [
			{ id: "gate", type: "gate", task: "judge" },
			{ id: "side", task: "independent", final: true },
		],
	};
	let calls = 0;
	const result = await executeTaskflow(state(def, process.cwd()), {
		cwd: process.cwd(),
		agents: [AGENT],
		runTask: async (_c, _a, agent, task) => {
			calls++;
			return ok(agent, task, task === "judge" ? "VERDICT: BLOCK" : "side-done");
		},
		eventKernel: true,
		persist: () => {},
	});
	assert.equal(calls, 2);
	assert.equal(result.state.phases.side.status, "done");
	assert.equal(result.state.status, "blocked");
});

test("kernel automatic transient retry works; resume is revalidated by imperative runtime", async () => {
	const cwd = process.cwd();
	const def: Taskflow = { name: "kernel-retry", phases: [{ id: "p", agent: "a", task: "x", retry: { max: 0, backoffMs: 0 }, final: true }] };
	assert.equal(canUseEventKernel(def), true);
	let calls = 0;
	const runTask: RuntimeDeps["runTask"] = async (_c, _a, agent, task) => {
		calls++;
		if (calls === 1) {
			return { ...ok(agent, task), exitCode: 1, stopReason: "error", errorMessage: "HTTP 429" };
		}
		return ok(agent, task, "recovered");
	};
	const first = await executeTaskflow(state(def, cwd, "kernel-retry"), {
		cwd,
		agents: [AGENT],
		runTask,
		eventKernel: true,
		persist: () => {},
	});
	assert.equal(first.ok, true);
	assert.equal(calls, 2);
	assert.equal(first.state.phases.p.attempts, 2);
	const resumed = await executeTaskflow(first.state, {
		cwd,
		agents: [AGENT],
		runTask,
		eventKernel: true,
		persist: () => {},
	});
	assert.equal(resumed.ok, true);
	assert.equal(calls, 3, "kernel output without an inputHash is safely re-executed, never blindly reused");
});

test("budget overflow stops transient retry after one call on imperative and kernel paths", async () => {
	const phases: Array<{ name: string; phase: Taskflow["phases"][number] }> = [
		{ name: "agent", phase: { id: "p", type: "agent", task: "agent", retry: { max: 0, backoffMs: 0 }, final: true } },
		{ name: "gate", phase: { id: "p", type: "gate", task: "gate", retry: { max: 0, backoffMs: 0 }, final: true } },
		{ name: "reduce", phase: { id: "p", type: "reduce", task: "reduce", retry: { max: 0, backoffMs: 0 }, final: true } },
		{ name: "map", phase: { id: "p", type: "map", over: '["x"]', task: "map {item}", retry: { max: 0, backoffMs: 0 }, final: true } },
		{ name: "parallel", phase: { id: "p", type: "parallel", branches: [{ task: "branch" }], retry: { max: 0, backoffMs: 0 }, final: true } },
	];
	for (const kernel of [false, true]) {
		for (const entry of phases) {
			let calls = 0;
			const def: Taskflow = {
				name: `retry-budget-${entry.name}-${kernel ? "kernel" : "imperative"}`,
				budget: { maxTokens: 1 },
				phases: [entry.phase],
			};
			await executeTaskflow(state(def, process.cwd()), {
				cwd: process.cwd(),
				agents: [AGENT],
				eventKernel: kernel,
				runTask: async (_c, _a, agent, task) => {
					calls++;
					return {
						...ok(agent, task),
						exitCode: 1,
						stopReason: "error",
						errorMessage: "HTTP 503",
						usage: { ...emptyUsage(), output: 2, turns: 1 },
					};
				},
				persist: () => {},
			});
			assert.equal(calls, 1, `${entry.name}/${kernel ? "kernel" : "imperative"}: over-budget attempt must not retry`);
		}
	}
});

test("kernel opt-in routes budgeted map to imperative per-item guard", async () => {
	const def: Taskflow = {
		name: "map-budget-fallback",
		budget: { maxUSD: 0.5 },
		phases: [{ id: "m", type: "map", over: '["a","b","c"]', task: "{item}", concurrency: 1, final: true }],
	};
	let calls = 0;
	const result = await executeTaskflow(state(def, process.cwd()), {
		cwd: process.cwd(),
		agents: [AGENT],
		runTask: async (_c, _a, agent, task) => {
			calls++;
			return ok(agent, task, task, 1);
		},
		eventKernel: true,
		persist: () => {},
	});
	assert.equal(calls, 1);
	assert.equal(result.state.status, "blocked");
	assert.equal(result.state.phases.m.budgetTruncated, true);
});

test("FlowIR hash includes agentScope and contextSharing", async () => {
	const base: Taskflow = { name: "semantic-hash", phases: [{ id: "p", task: "x", final: true }] };
	const user = await compileTaskflowToIR({ ...base, agentScope: "user" });
	const project = await compileTaskflowToIR({ ...base, agentScope: "project" });
	const plain = await compileTaskflowToIR({ ...base, contextSharing: false });
	const shared = await compileTaskflowToIR({ ...base, contextSharing: true });
	assert.notEqual(user.hash, project.hash);
	assert.notEqual(plain.hash, shared.hash);
});

test("cross-run cache cannot cross agentScope or contextSharing boundaries", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-semantic-cache-"));
	try {
		const store = new CacheStore(cwd);
		let calls = 0;
		const runTask: RuntimeDeps["runTask"] = async (_c, agents, agent, task, opts: RunOptions) => {
			calls++;
			return ok(agent, task, `${agents[0]?.systemPrompt}:${opts.ctxDir ? "shared" : "plain"}`);
		};
		const mk = (agentScope: "user" | "project", contextSharing: boolean): Taskflow => ({
			name: "semantic-cache",
			agentScope,
			contextSharing,
			phases: [{ id: "p", agent: "a", task: "x", cache: { scope: "cross-run" }, final: true }],
		});
		const userAgent = { ...AGENT, systemPrompt: "USER", source: "user" as const };
		const projectAgent = { ...AGENT, systemPrompt: "PROJECT", source: "project" as const };
		const r1 = await executeTaskflow(state(mk("user", false), cwd), {
			cwd,
			agents: [userAgent],
			runTask,
			cacheStore: store,
			persist: () => {},
		});
		const r2 = await executeTaskflow(state(mk("project", false), cwd), {
			cwd,
			agents: [projectAgent],
			runTask,
			cacheStore: store,
			persist: () => {},
		});
		const r3 = await executeTaskflow(state(mk("project", true), cwd), {
			cwd,
			agents: [projectAgent],
			runTask,
			cacheStore: store,
			persist: () => {},
		});
		const r4 = await executeTaskflow(state(mk("user", false), cwd), {
			cwd,
			agents: [{ ...userAgent, systemPrompt: "USER-V2" }],
			runTask,
			cacheStore: store,
			persist: () => {},
		});
		assert.equal(calls, 4);
		assert.equal(r1.finalOutput, "USER:plain");
		assert.equal(r2.finalOutput, "PROJECT:plain");
		assert.equal(r3.finalOutput, "PROJECT:shared");
		assert.equal(r4.finalOutput, "USER-V2:plain");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("per-item map cache retains agentScope semantic identity", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-map-scope-cache-"));
	try {
		const store = new CacheStore(cwd);
		let calls = 0;
		const runTask: RuntimeDeps["runTask"] = async (_c, agents, agent, task) => {
			calls++;
			return ok(agent, task, `${agents[0]?.systemPrompt}:${task}`);
		};
		const mk = (agentScope: "user" | "project"): Taskflow => ({
			name: "map-scope-cache",
			agentScope,
			phases: [
				{
					id: "m",
					type: "map",
					over: '["a","b"]',
					task: "{item}",
					cache: { scope: "cross-run" },
					final: true,
				},
			],
		});
		await executeTaskflow(state(mk("user"), cwd), {
			cwd,
			agents: [{ ...AGENT, systemPrompt: "USER", source: "user" }],
			runTask,
			cacheStore: store,
			persist: () => {},
		});
		const second = await executeTaskflow(state(mk("project"), cwd), {
			cwd,
			agents: [{ ...AGENT, systemPrompt: "PROJECT", source: "project" }],
			runTask,
			cacheStore: store,
			persist: () => {},
		});
		assert.equal(calls, 4, "project-scoped items execute instead of using user-scoped per-item entries");
		assert.match(second.finalOutput, /PROJECT/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("saved-flow content participates in parent flow cache identity", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-saved-flow-cache-"));
	try {
		const store = new CacheStore(cwd);
		const parent: Taskflow = {
			name: "parent",
			phases: [{ id: "child", type: "flow", use: "saved", cache: { scope: "cross-run" }, final: true }],
		};
		let version = 1;
		let calls = 0;
		const deps: RuntimeDeps = {
			cwd,
			agents: [AGENT],
			cacheStore: store,
			loadFlow: () => ({
				name: "saved",
				phases: [{ id: "p", agent: "a", task: `version-${version}`, final: true }],
			}),
			runTask: async (_c, _a, agent, task) => {
				calls++;
				return ok(agent, task, task);
			},
			persist: () => {},
		};
		const first = await executeTaskflow(state(parent, cwd), deps);
		version = 2;
		const second = await executeTaskflow(state(parent, cwd), deps);
		assert.equal(calls, 2);
		assert.match(first.finalOutput, /version-1/);
		assert.match(second.finalOutput, /version-2/);
		assert.equal(second.state.phases.child.cacheHit, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("race and expand never use cross-run default cache", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-horizon-cache-"));
	try {
		const store = new CacheStore(cwd);
		let calls = 0;
		const deps: RuntimeDeps = {
			cwd,
			agents: [AGENT],
			cacheStore: store,
			cacheScopeDefault: "cross-run",
			runTask: async (_c, _a, agent, task) => {
				calls++;
				return ok(agent, task, task);
			},
			persist: () => {},
		};
		const race: Taskflow = {
			name: "race-no-cross",
			phases: [{ id: "r", type: "race", branches: [{ task: "a" }, { task: "b" }], final: true }],
		};
		await executeTaskflow(state(race, cwd), deps);
		await executeTaskflow(state(race, cwd), deps);
		assert.equal(calls, 4);
		const expand: Taskflow = {
			name: "expand-no-cross",
			phases: [
				{
					id: "e",
					type: "expand",
					def: { name: "fragment", phases: [{ id: "p", task: "child", idempotent: false, final: true }] },
					final: true,
				},
			],
		};
		await executeTaskflow(state(expand, cwd), deps);
		await executeTaskflow(state(expand, cwd), deps);
		assert.equal(calls, 6);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("graft resume restores promoted children and optional promoted failure is fail-soft", async () => {
	const cwd = process.cwd();
	const def: Taskflow = {
		name: "graft-resume",
		phases: [
			{
				id: "grow",
				type: "expand",
				expandMode: "graft",
				def: {
					name: "fragment",
					phases: [{ id: "leaf", task: "fail-soft", optional: true, final: true }],
				},
				final: true,
			},
		],
	};
	let calls = 0;
	const deps: RuntimeDeps = {
		cwd,
		agents: [AGENT],
		runTask: async (_c, _a, agent, task) => {
			calls++;
			return {
				...ok(agent, task),
				exitCode: 1,
				stopReason: "error",
				errorMessage: "expected optional failure",
			};
		},
		persist: () => {},
	};
	const first = await executeTaskflow(state(def, cwd, "graft-resume"), deps);
	assert.equal(first.state.status, "completed");
	assert.equal(first.state.phases["grow-leaf"]?.status, "failed");
	assert.equal(first.state.phases["grow-leaf"]?.optional, true);
	delete first.state.phases["grow-leaf"];
	const resumed = await executeTaskflow(first.state, deps);
	assert.equal(calls, 1);
	assert.equal(resumed.state.phases.grow.cacheHit, "run-only");
	assert.equal(resumed.state.phases["grow-leaf"]?.status, "failed");
	assert.equal(resumed.state.status, "completed");
});

test("trace flush retains causing budget decision and nested run events stay isolated", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-trace-close-"));
	try {
		const tracePath = path.join(cwd, "run.trace.jsonl");
		const def: Taskflow = {
			name: "trace-parent",
			budget: { maxUSD: 0.5 },
			phases: [
				{
					id: "nested",
					type: "flow",
					def: { name: "child", phases: [{ id: "inside", task: "paid", final: true }] },
				},
				{ id: "expensive", task: "expensive", dependsOn: ["nested"] },
				{ id: "after", task: "after", dependsOn: ["expensive"], final: true },
			],
		};
		const result = await executeTaskflow(state(def, cwd, "parent-run"), {
			cwd,
			agents: [AGENT],
			runTask: async (_c, _a, agent, task) => ok(agent, task, "paid", task === "expensive" ? 1 : 0),
			trace: new FileTraceSink(tracePath),
			persist: () => {},
		});
		assert.equal(result.state.phases.nested.status, "done");
		assert.equal(result.state.phases.expensive.status, "done");
		assert.equal(result.state.phases.after.status, "skipped");
		const trace = readTrace(tracePath);
		assert.ok(trace.length > 0);
		assert.ok(trace.every((e) => e.runId === "parent-run"));
		assert.ok(trace.every((e) => e.phaseId !== "inside"));
		assert.ok(trace.some((e) => e.phaseId === "expensive" && e.decision?.type === "budget-hit"));
		const folded = foldEvents(trace.map((e) => upgradeTraceEvent(e as unknown as Record<string, unknown>)));
		assert.equal(folded.phases.expensive.status, "done", "budget-causing phase stays completed");
		assert.equal(folded.phases.after.status, "skipped");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("race and expand emit replay-safe parent trace records", async () => {
	const events: import("../src/trace.ts").TraceEvent[] = [];
	const trace = { emit: (event: import("../src/trace.ts").TraceEvent) => events.push(event), flush: () => {} };
	const race: Taskflow = {
		name: "trace-race",
		phases: [{ id: "fastest", type: "race", branches: [{ task: "a" }, { task: "b" }], final: true }],
	};
	await executeTaskflow(state(race, process.cwd(), "race-run"), {
		cwd: process.cwd(),
		agents: [AGENT],
		runTask: async (_c, _a, agent, task) => ok(agent, task, task),
		trace,
		persist: () => {},
	});
	assert.equal(events.filter((e) => e.phaseId === "fastest" && e.kind === "subagent-call").length, 2);
	assert.ok(events.every((e) => e.runId === "race-run"));
	events.length = 0;
	const expand: Taskflow = {
		name: "trace-expand",
		phases: [
			{
				id: "grow",
				type: "expand",
				def: { name: "fragment", phases: [{ id: "leaf", task: "x", final: true }] },
				final: true,
			},
		],
	};
	await executeTaskflow(state(expand, process.cwd(), "expand-run"), {
		cwd: process.cwd(),
		agents: [AGENT],
		runTask: async (_c, _a, agent, task) => ok(agent, task, task),
		trace,
		persist: () => {},
	});
	assert.ok(events.some((e) => e.phaseId === "grow" && e.decision?.type === "unreplayable"));
	assert.ok(events.every((e) => e.runId === "expand-run"));
	assert.ok(events.every((e) => e.phaseId !== "grow-leaf"));
});

test("kernel advanced agent callers all apply automatic transient retry", async () => {
	const cases: Taskflow[] = [
		{ name: "retry-reduce", phases: [{ id: "p", type: "reduce", task: "reduce", retry: { max: 0, backoffMs: 0 }, final: true }] },
		{ name: "retry-gate", phases: [{ id: "p", type: "gate", task: "gate", retry: { max: 0, backoffMs: 0 }, final: true }] },
		{ name: "retry-loop", phases: [{ id: "p", type: "loop", task: "loop", maxIterations: 1, retry: { max: 0, backoffMs: 0 }, final: true }] },
	];
	for (const def of cases) {
		let calls = 0;
		const result = await executeTaskflow(state(def, process.cwd()), {
			cwd: process.cwd(),
			agents: [AGENT],
			runTask: async (_c, _a, agent, task) => {
				calls++;
				if (calls === 1) return { ...ok(agent, task), exitCode: 1, stopReason: "error", errorMessage: "HTTP 429" };
				return ok(agent, task, def.name.includes("gate") ? "VERDICT: PASS" : "recovered");
			},
			eventKernel: true,
			persist: () => {},
		});
		assert.equal(result.ok, true, def.name);
		assert.equal(calls, 2, def.name);
	}

	const tournament: Taskflow = {
		name: "retry-tournament",
		phases: [{ id: "p", type: "tournament", task: "draft", variants: 2, judge: "judge", retry: { max: 0, backoffMs: 0 }, final: true }],
	};
	const seen = new Map<string, number>();
	const tournamentResult = await executeTaskflow(state(tournament, process.cwd()), {
		cwd: process.cwd(),
		agents: [AGENT],
		runTask: async (_c, _a, agent, task) => {
			const key = task.includes("Variant") ? "judge" : "variant";
			const n = (seen.get(key) ?? 0) + 1;
			seen.set(key, n);
			if (n === 1) return { ...ok(agent, task), exitCode: 1, stopReason: "error", errorMessage: "HTTP 503" };
			return ok(agent, task, key === "judge" ? "WINNER: 1" : "draft-ok");
		},
		eventKernel: true,
		persist: () => {},
	});
	assert.equal(tournamentResult.ok, true);
	assert.ok((seen.get("variant") ?? 0) >= 3, "variant transient failure retried");
	assert.equal(seen.get("judge"), 2, "judge transient failure retried");
});

test("kernel resume never reuses stale definition or non-idempotent output", async () => {
	let calls = 0;
	const def: Taskflow = {
		name: "kernel-safe-resume",
		phases: [{ id: "p", task: "v1", idempotent: false, final: true }],
	};
	const deps: RuntimeDeps = {
		cwd: process.cwd(),
		agents: [AGENT],
		runTask: async (_c, _a, agent, task) => {
			calls++;
			return ok(agent, task, task);
		},
		eventKernel: true,
		persist: () => {},
	};
	const first = await executeTaskflow(state(def, process.cwd(), "safe-resume"), deps);
	first.state.def = { ...def, phases: [{ ...def.phases[0], task: "v2" }] };
	const second = await executeTaskflow(first.state, deps);
	assert.equal(calls, 2);
	assert.equal(second.finalOutput, "v2");
	assert.equal(second.state.phases.p.cacheHit, undefined);
	assert.ok(second.state.phases.p.warnings?.some((w) => w.includes("side effect fired again")));
});

test("kernel budget decision is flushed and flow parent is marked unreplayable", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-kernel-trace-"));
	try {
		const budgetPath = path.join(cwd, "budget.trace.jsonl");
		const budget: Taskflow = {
			name: "kernel-budget-trace",
			budget: { maxUSD: 0.5 },
			phases: [
				{ id: "paid", task: "paid" },
				{ id: "after", task: "after", dependsOn: ["paid"], final: true },
			],
		};
		await executeTaskflow(state(budget, cwd, "kernel-budget"), {
			cwd,
			agents: [AGENT],
			runTask: async (_c, _a, agent, task) => ok(agent, task, task, 1),
			eventKernel: true,
			trace: new FileTraceSink(budgetPath),
			persist: () => {},
		});
		assert.ok(readTrace(budgetPath).some((e) => e.phaseId === "paid" && e.decision?.type === "budget-hit"));

		const flowPath = path.join(cwd, "flow.trace.jsonl");
		const flow: Taskflow = {
			name: "kernel-flow-trace",
			phases: [{ id: "outer", type: "flow", use: "child", final: true }],
		};
		await executeTaskflow(state(flow, cwd, "kernel-flow"), {
			cwd,
			agents: [AGENT],
			loadFlow: () => ({ name: "child", phases: [{ id: "inner", task: "x", final: true }] }),
			runTask: async (_c, _a, agent, task) => ok(agent, task, task),
			eventKernel: true,
			trace: new FileTraceSink(flowPath),
			persist: () => {},
		});
		const events = readTrace(flowPath);
		assert.ok(events.some((e) => e.phaseId === "outer" && e.decision?.type === "unreplayable"));
		assert.ok(events.every((e) => e.phaseId !== "inner"));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("changed graft fragment removes stale promoted children before replacement", async () => {
	const mk = (id: string, task: string): Taskflow => ({
		name: "graft-replace",
		phases: [
			{
				id: "grow",
				type: "expand",
				expandMode: "graft",
				def: { name: "fragment", phases: [{ id, task, final: true }] },
				final: true,
			},
		],
	});
	const deps: RuntimeDeps = {
		cwd: process.cwd(),
		agents: [AGENT],
		runTask: async (_c, _a, agent, task) => ok(agent, task, task),
		persist: () => {},
	};
	const first = await executeTaskflow(state(mk("v1", "old"), process.cwd(), "graft-replace"), deps);
	assert.equal(first.state.phases["grow-v1"]?.output, "old");
	first.state.def = mk("v2", "new");
	const second = await executeTaskflow(first.state, deps);
	assert.equal(second.state.phases["grow-v1"], undefined);
	assert.equal(second.state.phases["grow-v2"]?.output, "new");
});

test("kernel transient backoff is abortable for ordinary and advanced callers", async () => {
	const cases: Array<{ def: Taskflow; initialCalls: number }> = [
		{ def: { name: "abort-agent", phases: [{ id: "p", task: "x", final: true }] }, initialCalls: 1 },
		{ def: { name: "abort-map", phases: [{ id: "p", type: "map", over: '["x"]', task: "{item}", final: true }] }, initialCalls: 1 },
		{ def: { name: "abort-parallel", phases: [{ id: "p", type: "parallel", branches: [{ task: "x" }], final: true }] }, initialCalls: 1 },
		{ def: { name: "abort-reduce", phases: [{ id: "p", type: "reduce", task: "x", final: true }] }, initialCalls: 1 },
		{ def: { name: "abort-gate", phases: [{ id: "p", type: "gate", task: "x", final: true }] }, initialCalls: 1 },
		{ def: { name: "abort-loop", phases: [{ id: "p", type: "loop", task: "x", maxIterations: 3, final: true }] }, initialCalls: 1 },
		{ def: { name: "abort-tournament", phases: [{ id: "p", type: "tournament", task: "x", variants: 2, final: true }] }, initialCalls: 2 },
	];
	for (const { def, initialCalls } of cases) {
		const ac = new AbortController();
		let calls = 0;
		const started = Date.now();
		const timer = setTimeout(() => ac.abort(), 25);
		const result = await executeTaskflow(state(def, process.cwd()), {
			cwd: process.cwd(),
			agents: [AGENT],
			signal: ac.signal,
			runTask: async (_c, _a, agent, task) => {
				calls++;
				return { ...ok(agent, task), exitCode: 1, stopReason: "error", errorMessage: "HTTP 429" };
			},
			eventKernel: true,
			persist: () => {},
		});
		clearTimeout(timer);
		assert.ok(Date.now() - started < 500, `${def.name}: abort must interrupt the 2s backoff`);
		assert.equal(calls, initialCalls, `${def.name}: no retry call after abort`);
		assert.equal(result.state.status, "paused", def.name);
	}
});

test("graft rerun clears old children before empty, parse-failed, or failed replacement", async () => {
	const oldDef: Taskflow = {
		name: "graft-clear-all-paths",
		phases: [
			{
				id: "grow",
				type: "expand",
				expandMode: "graft",
				def: { name: "old", phases: [{ id: "old", task: "old", final: true }] },
				final: true,
			},
		],
	};
	const replacements: Array<{ label: string; def: unknown; expectedCost: number }> = [
		{ label: "empty", def: { name: "empty", phases: [] }, expectedCost: 0 },
		{ label: "parse-failed", def: "{not-json", expectedCost: 0 },
		{ label: "subflow-failed", def: { name: "bad", phases: [{ id: "bad", task: "new-fail", final: true }] }, expectedCost: 2 },
	];
	for (const replacement of replacements) {
		const deps: RuntimeDeps = {
			cwd: process.cwd(),
			agents: [AGENT],
			runTask: async (_c, _a, agent, task) =>
				task === "new-fail"
					? { ...ok(agent, task, "", 2), exitCode: 1, stopReason: "error", errorMessage: "new failed" }
					: ok(agent, task, "old", 1),
			persist: () => {},
		};
		const first = await executeTaskflow(state(oldDef, process.cwd(), `graft-${replacement.label}`), deps);
		assert.equal(first.state.phases["grow-old"]?.usage?.cost, 1);
		first.state.def = {
			...oldDef,
			phases: [{ ...oldDef.phases[0], def: replacement.def }],
		};
		const second = await executeTaskflow(first.state, deps);
		assert.equal(second.state.phases["grow-old"], undefined, replacement.label);
		assert.equal(second.totalUsage.cost, replacement.expectedCost, `${replacement.label}: old usage removed`);
	}
});

test("graft collision metadata never claims or later deletes an existing parent phase", async () => {
	const firstDef: Taskflow = {
		name: "graft-parent-collision",
		phases: [
			{ id: "grow-old", task: "parent", final: false },
			{
				id: "grow",
				type: "expand",
				expandMode: "graft",
				dependsOn: ["grow-old"],
				def: { name: "fragment", phases: [{ id: "old", task: "child", final: true }] },
				final: true,
			},
		],
	};
	const deps: RuntimeDeps = {
		cwd: process.cwd(),
		agents: [AGENT],
		runTask: async (_c, _a, agent, task) => ok(agent, task, task, task === "child" ? 1 : 0),
		persist: () => {},
	};
	const first = await executeTaskflow(state(firstDef, process.cwd(), "graft-parent-collision"), deps);
	assert.equal(first.state.phases["grow-old"]?.output, "parent");
	assert.equal(first.state.phases.grow.promotedPhases, undefined, "collision-skipped child is not owned metadata");
	assert.equal(first.state.phases.grow.usage?.cost, 1, "all-collision usage remains on expand");
	first.state.def = {
		...firstDef,
		phases: [
			firstDef.phases[0],
			{ ...firstDef.phases[1], def: { name: "empty", phases: [] } },
		],
	};
	const second = await executeTaskflow(first.state, deps);
	assert.equal(second.state.phases["grow-old"]?.status, "done");
	assert.equal(second.state.phases["grow-old"]?.output, "parent");
});

test("graft ownership migration cannot delete a newly declared upstream phase", async () => {
	const firstDef: Taskflow = {
		name: "graft-owned-to-declared",
		phases: [
			{
				id: "grow",
				type: "expand",
				expandMode: "graft",
				def: { name: "old-fragment", phases: [{ id: "x", task: "old-child", final: true }] },
				final: true,
			},
		],
	};
	const deps: RuntimeDeps = {
		cwd: process.cwd(),
		agents: [AGENT],
		runTask: async (_c, _a, agent, task) =>
			ok(agent, task, task, task === "old-child" ? 1 : task === "new-parent" ? 3 : 0),
		persist: () => {},
	};
	const first = await executeTaskflow(state(firstDef, process.cwd(), "graft-owned-to-declared"), deps);
	assert.equal(first.state.phases["grow-x"]?.output, "old-child");
	assert.equal(first.state.phases["grow-x"]?.usage?.cost, 1);
	assert.ok(first.state.phases.grow.promotedPhases?.["grow-x"]);

	first.state.def = {
		...firstDef,
		phases: [
			{ id: "grow-x", task: "new-parent" },
			{
				...firstDef.phases[0],
				dependsOn: ["grow-x"],
				def: { name: "empty-fragment", phases: [] },
			},
		],
	};
	const second = await executeTaskflow(first.state, deps);
	assert.equal(second.state.status, "completed");
	assert.equal(second.state.phases["grow-x"]?.status, "done");
	assert.equal(second.state.phases["grow-x"]?.output, "new-parent");
	assert.equal(second.state.phases["grow-x"]?.usage?.cost, 3);
	assert.equal(second.totalUsage.cost, 3);
});

test("mixed graft collision keeps residual usage and enforces parent budget", async () => {
	const def: Taskflow = {
		name: "graft-mixed-usage",
		budget: { maxUSD: 3.5 },
		phases: [
			{ id: "grow-collision", task: "parent", final: false },
			{
				id: "grow",
				type: "expand",
				expandMode: "graft",
				dependsOn: ["grow-collision"],
				def: {
					name: "mixed-fragment",
					phases: [
						{ id: "collision", task: "collision-fail", optional: true },
						{ id: "promoted", task: "promoted-ok", dependsOn: ["collision"], final: true },
					],
				},
				final: false,
			},
			{ id: "after", task: "after", dependsOn: ["grow"], final: true },
		],
	};
	const result = await executeTaskflow(state(def, process.cwd(), "graft-mixed-usage"), {
		cwd: process.cwd(),
		agents: [AGENT],
		runTask: async (_c, _a, agent, task) =>
			task === "collision-fail"
				? { ...ok(agent, task, "", 1), exitCode: 1, stopReason: "error", errorMessage: "optional failed" }
				: ok(agent, task, task, 1),
		persist: () => {},
	});
	assert.equal(result.state.phases["grow-collision"]?.usage?.cost, 1, "authored parent usage");
	assert.equal(result.state.phases["grow-promoted"]?.usage?.cost, 1, "promoted child owns its usage");
	assert.equal(result.state.phases.grow.usage?.cost, 1, "collision-skipped optional failure stays residual");
	assert.equal(result.state.phases.grow.promotedPhases?.["grow-collision"], undefined);
	assert.ok(result.state.phases.grow.promotedPhases?.["grow-promoted"]);
	assert.equal(result.state.phases.after?.usage?.cost, 1);
	assert.equal(result.totalUsage.cost, 4);
	assert.equal(result.state.status, "blocked", "residual usage participates in the parent budget");
});

test("nested flow budget uses parent remaining tokens across inline/saved/expand/kernel paths", async () => {
	const child: Taskflow = {
		name: "remaining-child",
		phases: [
			{ id: "c1", task: "c1" },
			{ id: "c2", task: "c2", dependsOn: ["c1"], final: true },
		],
	};
	const cases: Array<{ name: string; phase: Taskflow["phases"][number]; kernel: boolean }> = [
		{ name: "inline", phase: { id: "nested", type: "flow", def: child, dependsOn: ["spend"], final: true }, kernel: false },
		{ name: "saved", phase: { id: "nested", type: "flow", use: "remaining-child", dependsOn: ["spend"], final: true }, kernel: false },
		{ name: "expand-nested", phase: { id: "nested", type: "expand", def: child, dependsOn: ["spend"], final: true }, kernel: true },
		{ name: "expand-graft", phase: { id: "nested", type: "expand", expandMode: "graft", def: child, dependsOn: ["spend"], final: true }, kernel: true },
		{ name: "kernel-inline", phase: { id: "nested", type: "flow", def: child, dependsOn: ["spend"], final: true }, kernel: true },
		{ name: "kernel-saved", phase: { id: "nested", type: "flow", use: "remaining-child", dependsOn: ["spend"], final: true }, kernel: true },
	];
	for (const c of cases) {
		const def: Taskflow = {
			name: `remaining-${c.name}`,
			budget: { maxTokens: 100 },
			phases: [{ id: "spend", task: "parent-spend" }, c.phase],
		};
		const calls: string[] = [];
		const result = await executeTaskflow(state(def, process.cwd()), {
			cwd: process.cwd(),
			agents: [AGENT],
			loadFlow: () => child,
			runTask: async (_c, _a, agent, task) => {
				calls.push(task);
				return {
					...ok(agent, task, task),
					usage: { ...emptyUsage(), input: task === "parent-spend" ? 90 : 20, turns: 1 },
				};
			},
			eventKernel: c.kernel,
			persist: () => {},
		});
		assert.deepEqual(calls, ["parent-spend", "c1"], `${c.name}: c2 blocked by remaining cap`);
		assert.equal(result.totalUsage.input, 110, c.name);
		assert.equal(result.state.status, "blocked", c.name);
	}
});

test("remaining nested budget clamps USD and tokens independently", () => {
	const child: Taskflow = {
		name: "budget-child",
		budget: { maxUSD: 0.5, maxTokens: 50 },
		phases: [{ id: "p", task: "x", final: true }],
	};
	const clamped = clampSubFlowBudget(
		child,
		{ maxUSD: 10, maxTokens: 100 },
		{ ...emptyUsage(), cost: 9, input: 70, output: 20 },
	);
	assert.deepEqual(clamped.budget, { maxUSD: 0.5, maxTokens: 10 });
	const usdOnly = clampSubFlowBudget(child, { maxUSD: 10 }, { ...emptyUsage(), cost: 9 });
	assert.deepEqual(usdOnly.budget, { maxUSD: 0.5, maxTokens: 50 });
});

test("ctx_spawn flat siblings stop after the first atomic budget overshoot on either axis", async () => {
	for (const axis of ["tokens", "usd"] as const) {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `taskflow-spawn-${axis}-`));
		try {
			const calls: string[] = [];
			const def: Taskflow = {
				name: `spawn-flat-${axis}`,
				budget: axis === "tokens" ? { maxTokens: 10 } : { maxUSD: 0.01 },
				phases: [{ id: "root", task: "parent", shareContext: true, final: true }],
			};
			const result = await executeTaskflow(state(def, cwd), {
				cwd,
				agents: [AGENT],
				runTask: async (_c, _a, agent, task, opts: RunOptions) => {
					calls.push(task);
					if (task === "parent") queueSpawn(opts.ctxDir!, opts.nodeId!, [{ task: "child-1" }, { task: "child-2" }]);
					return {
						...ok(agent, task, task),
						usage: {
							...emptyUsage(),
							output: axis === "tokens" ? (task === "parent" ? 6 : 5) : 1,
							cost: axis === "usd" ? (task === "parent" ? 0.006 : 0.005) : 0,
							turns: 1,
						},
					};
				},
				persist: () => {},
			});
			assert.deepEqual(calls, ["parent", "child-1"], `${axis}: second sibling must not run`);
			assert.equal(result.state.status, "blocked", axis);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}
});

test("ctx_spawn inline subflow receives only the parent remaining budget", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-spawn-subflow-budget-"));
	try {
		const calls: string[] = [];
		const def: Taskflow = {
			name: "spawn-subflow-remaining",
			budget: { maxTokens: 10 },
			phases: [{ id: "root", task: "parent", shareContext: true, final: true }],
		};
		await executeTaskflow(state(def, cwd), {
			cwd,
			agents: [AGENT],
			runTask: async (_c, _a, agent, task, opts: RunOptions) => {
				calls.push(task);
				if (task === "parent") {
					queueSpawn(opts.ctxDir!, opts.nodeId!, [{
						subflow: {
							phases: [
								{ id: "inner-1", task: "inner-1" },
								{ id: "inner-2", task: "inner-2", dependsOn: ["inner-1"], final: true },
							],
						},
					}]);
				}
				return {
					...ok(agent, task, task),
					usage: { ...emptyUsage(), output: task === "parent" ? 6 : 5, turns: 1 },
				};
			},
			persist: () => {},
		});
		assert.deepEqual(calls, ["parent", "inner-1"], "inner-2 must be blocked after the atomic overshoot");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("ctx_spawn grandchild shares its ancestor batch budget ledger", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-spawn-grand-budget-"));
	try {
		const calls: string[] = [];
		const def: Taskflow = {
			name: "spawn-grand-remaining",
			budget: { maxTokens: 10 },
			phases: [{ id: "root", task: "parent", shareContext: true, final: true }],
		};
		await executeTaskflow(state(def, cwd), {
			cwd,
			agents: [AGENT],
			runTask: async (_c, _a, agent, task, opts: RunOptions) => {
				calls.push(task);
				if (task === "parent") queueSpawn(opts.ctxDir!, opts.nodeId!, [{ task: "child" }]);
				if (task === "child") queueSpawn(opts.ctxDir!, opts.nodeId!, [{ task: "grandchild" }]);
				return {
					...ok(agent, task, task),
					usage: { ...emptyUsage(), output: task === "parent" ? 6 : 5, turns: 1 },
				};
			},
			persist: () => {},
		});
		assert.deepEqual(calls, ["parent", "child"], "grandchild must not run after its ancestor crosses the cap");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("definition evolution removes stale ordinary phase failure and usage before scheduling", async () => {
	const oldDef: Taskflow = {
		name: "definition-evolution",
		phases: [{ id: "old-failed", task: "old-failed", final: true }],
	};
	const first = await executeTaskflow(state(oldDef, process.cwd(), "definition-evolution-run"), {
		cwd: process.cwd(),
		agents: [AGENT],
		runTask: async (_c, _a, agent, task) => ({
			...ok(agent, task, "", 7),
			exitCode: 1,
			stopReason: "error",
			errorMessage: "recorded old failure",
		}),
		persist: () => {},
	});
	assert.equal(first.state.status, "failed");
	assert.equal(first.totalUsage.cost, 7);

	const newDef: Taskflow = {
		name: "definition-evolution",
		phases: [{ id: "new-success", task: "new-success", final: true }],
	};
	first.state.def = newDef;
	const calls: string[] = [];
	const second = await executeTaskflow(first.state, {
		cwd: process.cwd(),
		agents: [AGENT],
		runTask: async (_c, _a, agent, task) => {
			calls.push(task);
			return ok(agent, task, "new result", 2);
		},
		persist: () => {},
	});
	assert.deepEqual(calls, ["new-success"]);
	assert.equal(second.state.phases["old-failed"], undefined);
	assert.equal(second.state.phases["new-success"]?.status, "done");
	assert.equal(second.state.status, "completed");
	assert.equal(second.totalUsage.cost, 2, "only phases declared by the new definition contribute usage");
});

test("graft preflights collisions against authored ids that have no state row yet", async () => {
	const def: Taskflow = {
		name: "graft-future-authored-collision",
		budget: { maxUSD: 2.5 },
		phases: [
			{
				id: "grow",
				type: "expand",
				expandMode: "graft",
				def: { name: "fragment", phases: [{ id: "authored", task: "dynamic-child", final: true }] },
			},
			{ id: "grow-authored", task: "authored-phase", dependsOn: ["grow"], final: true },
		],
	};
	const result = await executeTaskflow(state(def, process.cwd(), "graft-future-authored-collision"), {
		cwd: process.cwd(),
		agents: [AGENT],
		runTask: async (_c, _a, agent, task) => ok(agent, task, task, task === "dynamic-child" ? 1 : 2),
		persist: () => {},
	});
	assert.equal(result.state.phases.grow.promotedPhases, undefined, "collision child is never owned as promoted state");
	assert.equal(result.state.phases.grow.usage?.cost, 1, "collision child usage remains expand residual");
	assert.equal(result.state.phases["grow-authored"]?.usage?.cost, 2, "authored phase retains its own usage");
	assert.equal(result.totalUsage.cost, 3);
	assert.equal(result.state.status, "blocked", "residual + authored usage enforces the 2.5 budget");
});
