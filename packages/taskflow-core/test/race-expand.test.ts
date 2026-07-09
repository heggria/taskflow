/**
 * Horizon B: race + expand (nested/graft) imperative runtime.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { validateTaskflow, type Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { emptyUsage } from "../src/usage.ts";
import type { AgentConfig } from "../src/agents.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "t", systemPrompt: "", source: "user", filePath: "" },
];

function mkState(def: Taskflow): RunState {
	return {
		runId: "race-expand-test",
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: process.cwd(),
	};
}

function runner(fn: (task: string) => string | Promise<string>): RuntimeDeps["runTask"] {
	return async (_c, _a, agent, task, _o: RunOptions): Promise<RunResult> => ({
		agent,
		task,
		exitCode: 0,
		output: await fn(task),
		stderr: "",
		usage: { ...emptyUsage(), input: 1, output: 1, cost: 0.001, turns: 1 },
		stopReason: "end",
	});
}

test("validate: race + expand shapes", () => {
	assert.equal(
		validateTaskflow({
			name: "r",
			phases: [
				{
					id: "r",
					type: "race",
					branches: [
						{ task: "a", agent: "a" },
						{ task: "b", agent: "a" },
					],
					final: true,
				},
			],
		}).ok,
		true,
	);
	assert.equal(
		validateTaskflow({
			name: "e",
			phases: [
				{
					id: "e",
					type: "expand",
					def: { name: "child", phases: [{ id: "c", type: "script", run: "echo hi", final: true }] },
					expandMode: "nested",
					final: true,
				},
			],
		}).ok,
		true,
	);
	assert.equal(
		validateTaskflow({
			name: "bad-race",
			phases: [
				{
					id: "r",
					type: "race",
					branches: [
						{ task: "a", agent: "a" },
						{ task: "b", agent: "a" },
					],
					cancelLosers: "false",
				} as never,
			],
		}).ok,
		false,
	);
});

test("race: first successful branch wins", async () => {
	const def: Taskflow = {
		name: "race-flow",
		phases: [
			{
				id: "r",
				type: "race",
				branches: [
					{ task: "slow", agent: "a" },
					{ task: "fast", agent: "a" },
				],
				final: true,
			},
		],
	};
	const st = mkState(def);
	await executeTaskflow(st, {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: runner(async (task) => {
			if (task.includes("slow")) {
				await new Promise((r) => setTimeout(r, 40));
				return "SLOW";
			}
			return "FAST";
		}),
	});
	assert.equal(st.status, "completed");
	assert.equal(st.phases.r?.status, "done");
	assert.equal(st.phases.r?.output?.trim(), "FAST");
	assert.ok(st.phases.r?.warnings?.some((w) => /branch 2/.test(w)));
	assert.ok(st.phases.r?.warnings?.some((w) => /cancelLosers aborted/.test(w ?? "")));
	// Usage aggregates both branches
	assert.ok((st.phases.r?.usage?.cost ?? 0) >= 0.001);
});

test("race: first-success ignores fast failure (slow success wins)", async () => {
	const def: Taskflow = {
		name: "race-fail-fast",
		phases: [
			{
				id: "r",
				type: "race",
				cancelLosers: false,
				branches: [
					{ task: "fail-fast", agent: "a" },
					{ task: "slow-ok", agent: "a" },
				],
				final: true,
			},
		],
	};
	const st = mkState(def);
	await executeTaskflow(st, {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: async (_c, _a, agent, task) => {
			if (task.includes("fail-fast")) {
				return {
					agent,
					task,
					exitCode: 1,
					output: "",
					stderr: "boom",
					usage: { ...emptyUsage(), input: 1, output: 0, cost: 0.001, turns: 1 },
					stopReason: "error",
					errorMessage: "boom",
				};
			}
			await new Promise((r) => setTimeout(r, 20));
			return {
				agent,
				task,
				exitCode: 0,
				output: "RECOVERED",
				stderr: "",
				usage: { ...emptyUsage(), input: 1, output: 1, cost: 0.002, turns: 1 },
				stopReason: "end",
			};
		},
	});
	assert.equal(st.status, "completed");
	assert.equal(st.phases.r?.status, "done");
	assert.equal(st.phases.r?.output?.trim(), "RECOVERED");
	assert.ok((st.phases.r?.usage?.cost ?? 0) >= 0.002);
});

test("race: cancelLosers aborts losing branch via AbortSignal", async () => {
	const def: Taskflow = {
		name: "race-cancel",
		phases: [
			{
				id: "r",
				type: "race",
				cancelLosers: true,
				branches: [
					{ task: "slow-path", agent: "a" },
					{ task: "fast-path", agent: "a" },
				],
				final: true,
			},
		],
	};
	const st = mkState(def);
	let slowSawAbort = false;
	await executeTaskflow(st, {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: async (_c, _a, agent, task, opts) => {
			if (task.includes("slow")) {
				await new Promise<void>((resolve) => {
					const t = setTimeout(() => resolve(), 5000);
					const onAbort = () => {
						slowSawAbort = true;
						clearTimeout(t);
						resolve();
					};
					if (opts?.signal?.aborted) onAbort();
					else opts?.signal?.addEventListener("abort", onAbort, { once: true });
				});
				return {
					agent,
					task,
					exitCode: 1,
					output: "",
					stderr: "aborted",
					usage: { ...emptyUsage(), input: 1, output: 0, cost: 0, turns: 0 },
					stopReason: "error",
					errorMessage: "aborted",
				};
			}
			await new Promise((r) => setTimeout(r, 15));
			return {
				agent,
				task,
				exitCode: 0,
				output: "FAST-WIN",
				stderr: "",
				usage: { ...emptyUsage(), input: 1, output: 1, cost: 0.001, turns: 1 },
				stopReason: "end",
			};
		},
	});
	assert.equal(st.status, "completed");
	assert.equal(st.phases.r?.output?.trim(), "FAST-WIN");
	assert.equal(slowSawAbort, true);
});

test("race: cancelLosers false leaves loser running to completion", async () => {
	const def: Taskflow = {
		name: "race-no-cancel",
		phases: [
			{
				id: "r",
				type: "race",
				cancelLosers: false,
				branches: [
					{ task: "slow-path", agent: "a" },
					{ task: "fast-path", agent: "a" },
				],
				final: true,
			},
		],
	};
	const st = mkState(def);
	let slowFinished = false;
	await executeTaskflow(st, {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: async (_c, _a, agent, task) => {
			if (task.includes("slow")) {
				await new Promise((r) => setTimeout(r, 40));
				slowFinished = true;
				return {
					agent,
					task,
					exitCode: 0,
					output: "SLOW",
					stderr: "",
					usage: { ...emptyUsage(), input: 1, output: 1, cost: 0.001, turns: 1 },
					stopReason: "end",
				};
			}
			return {
				agent,
				task,
				exitCode: 0,
				output: "FAST",
				stderr: "",
				usage: { ...emptyUsage(), input: 1, output: 1, cost: 0.001, turns: 1 },
				stopReason: "end",
			};
		},
	});
	assert.equal(st.phases.r?.output?.trim(), "FAST");
	assert.equal(slowFinished, true);
	assert.ok(!st.phases.r?.warnings?.some((w) => /cancelLosers aborted/.test(w)));
});

test("race: cancelLosers returns after a bounded grace when loser ignores abort", async () => {
	const def: Taskflow = {
		name: "race-noncooperative-loser",
		phases: [
			{
				id: "r",
				type: "race",
				cancelLosers: true,
				branches: [
					{ task: "fast-path", agent: "a" },
					{ task: "slow-ignores-abort", agent: "a" },
				],
				final: true,
			},
		],
	};
	const st = mkState(def);
	const started = Date.now();
	await executeTaskflow(st, {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: async (_c, _a, agent, task) => {
			if (task.includes("slow")) {
				await new Promise((r) => setTimeout(r, 250));
				return {
					agent,
					task,
					exitCode: 0,
					output: "SLOW",
					stderr: "",
					usage: { ...emptyUsage(), input: 1, output: 1, cost: 0.001, turns: 1 },
					stopReason: "end",
				};
			}
			await new Promise((r) => setTimeout(r, 10));
			return {
				agent,
				task,
				exitCode: 0,
				output: "FAST",
				stderr: "",
				usage: { ...emptyUsage(), input: 1, output: 1, cost: 0.001, turns: 1 },
				stopReason: "end",
			};
		},
	});
	assert.equal(st.status, "completed");
	assert.equal(st.phases.r?.output?.trim(), "FAST");
	assert.ok(Date.now() - started < 180, `race waited for non-cooperative loser`);
	assert.ok(st.phases.r?.warnings?.some((w) => /did not acknowledge abort/.test(w)));
});

test("expand nested: runs fragment as sub-flow", async () => {
	const def: Taskflow = {
		name: "exp-nested",
		phases: [
			{
				id: "e",
				type: "expand",
				expandMode: "nested",
				def: {
					name: "frag",
					phases: [{ id: "inner", type: "agent", agent: "a", task: "say nested-hi", final: true }],
				},
				final: true,
			},
		],
	};
	const st = mkState(def);
	await executeTaskflow(st, {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: runner((t) => (t.includes("nested") ? "nested-hi" : "x")),
	});
	assert.equal(st.status, "completed");
	assert.equal(st.phases.e?.status, "done");
	assert.equal(st.phases.e?.defError, undefined, st.phases.e?.defError);
	assert.match(st.phases.e?.output ?? "", /nested-hi/);
	assert.equal(st.phases.inner, undefined);
});

test("expand graft: promotes child phases onto parent", async () => {
	const def: Taskflow = {
		name: "exp-graft",
		phases: [
			{
				id: "grow",
				type: "expand",
				expandMode: "graft",
				def: {
					name: "frag",
					phases: [{ id: "leaf", type: "agent", agent: "a", task: "say grafted", final: true }],
				},
				final: true,
			},
		],
	};
	const st = mkState(def);
	await executeTaskflow(st, {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: runner((t) => (t.includes("grafted") ? "grafted-ok" : "x")),
	});
	assert.equal(st.status, "completed");
	assert.equal(st.phases.grow?.status, "done");
	assert.equal(st.phases.grow?.defError, undefined, st.phases.grow?.defError);
	assert.equal(st.phases["grow-leaf"]?.status, "done");
	assert.match(st.phases["grow-leaf"]?.output ?? "", /grafted-ok/);
	// No usage double-count: expand usage zeroed; child holds cost
	assert.equal(st.phases.grow?.usage?.cost ?? 0, 0);
	assert.ok((st.phases["grow-leaf"]?.usage?.cost ?? 0) > 0);
});

test("expand graft: multi-phase rewrites {steps.*} and avoids usage double-count", async () => {
	const def: Taskflow = {
		name: "exp-graft-chain",
		phases: [
			{
				id: "grow",
				type: "expand",
				expandMode: "graft",
				def: {
					name: "frag",
					phases: [
						{ id: "a", type: "agent", agent: "a", task: "part-a-out" },
						{
							id: "b",
							type: "agent",
							agent: "a",
							task: "chain from {steps.a.output}",
							dependsOn: ["a"],
							final: true,
						},
					],
				},
				final: true,
			},
		],
	};
	const st = mkState(def);
	const seen: string[] = [];
	await executeTaskflow(st, {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: runner((t) => {
			seen.push(t);
			if (t.includes("part-a")) return "A-VALUE";
			if (t.includes("chain from")) return `B-SEES-${t}`;
			return "x";
		}),
	});
	assert.equal(st.status, "completed", st.phases.grow?.defError ?? st.phases.grow?.error);
	assert.equal(st.phases.grow?.defError, undefined, st.phases.grow?.defError);
	assert.equal(st.phases["grow-a"]?.status, "done");
	assert.equal(st.phases["grow-b"]?.status, "done");
	assert.match(st.phases["grow-b"]?.output ?? "", /A-VALUE/);
	// expand usage zeroed after promote; children hold cost
	assert.equal(st.phases.grow?.usage?.cost ?? 0, 0);
	assert.ok((st.phases["grow-a"]?.usage?.cost ?? 0) > 0);
});

test("race: all branches fail → phase failed + usage", async () => {
	const def: Taskflow = {
		name: "race-all-fail",
		phases: [
			{
				id: "r",
				type: "race",
				cancelLosers: false,
				branches: [
					{ task: "fail-a", agent: "a" },
					{ task: "fail-b", agent: "a" },
				],
				final: true,
			},
		],
	};
	const st = mkState(def);
	await executeTaskflow(st, {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: async (_c, _a, agent, task) => ({
			agent,
			task,
			exitCode: 1,
			output: "",
			stderr: `err-${task}`,
			usage: { ...emptyUsage(), input: 1, output: 0, cost: 0.001, turns: 1 },
			stopReason: "error",
			errorMessage: `err-${task}`,
		}),
	});
	assert.equal(st.status, "failed");
	assert.equal(st.phases.r?.status, "failed");
	assert.match(st.phases.r?.error ?? "", /all 2 branches failed/);
	assert.ok(st.phases.r?.warnings?.some((w) => /all branches failed/.test(w)));
	assert.ok((st.phases.r?.usage?.cost ?? 0) >= 0.002);
});

test("race: parent abort bounds wait when branch ignores signal", async () => {
	const def: Taskflow = {
		name: "race-parent-abort",
		phases: [
			{
				id: "r",
				type: "race",
				cancelLosers: true,
				branches: [
					{ task: "hang-a", agent: "a" },
					{ task: "hang-b", agent: "a" },
				],
				final: true,
			},
		],
	};
	const st = mkState(def);
	const ac = new AbortController();
	const started = Date.now();
	const run = executeTaskflow(st, {
		cwd: process.cwd(),
		agents: AGENTS,
		signal: ac.signal,
		runTask: async (_c, _a, agent, task) => {
			// Ignore AbortSignal — would hang forever without race grace.
			await new Promise((r) => setTimeout(r, 5000));
			return {
				agent,
				task,
				exitCode: 0,
				output: "too-late",
				stderr: "",
				usage: emptyUsage(),
				stopReason: "end",
			};
		},
	});
	// Abort shortly after start so both branches are in-flight.
	await new Promise((r) => setTimeout(r, 15));
	ac.abort();
	await run;
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 2000, `expected bounded wait, took ${elapsed}ms`);
	// Parent abort → all branches aborted; non-cooperative → grace → all-fail path
	assert.ok(st.phases.r?.status === "failed" || st.phases.r?.status === "done");
});
