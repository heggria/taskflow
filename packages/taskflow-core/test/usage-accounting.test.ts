import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

const agents: AgentConfig[] = [
	{ name: "a", description: "test", systemPrompt: "", source: "project", filePath: "" },
];

function state(def: Taskflow): RunState {
	return {
		runId: `usage-${Math.random()}`,
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

function deps(loadFlow?: (name: string) => Taskflow | undefined): RuntimeDeps & { calls: { value: number } } {
	const calls = { value: 0 };
	return {
		calls,
		cwd: process.cwd(),
		agents,
		usageAccounting: "unavailable",
		loadFlow,
		persist: () => {},
		runTask: async (_cwd, _agents, agent, task) => {
			calls.value++;
			return { agent, task, exitCode: 0, output: "unsafe", stderr: "", usage: emptyUsage() };
		},
	};
}

const child: Taskflow = {
	name: "metered-child",
	budget: { maxTokens: 1 },
	phases: [{ id: "work", type: "agent", agent: "a", task: "spend", final: true }],
};

test("usage-unavailable host rejects a top-level budget before any agent call", async () => {
	const d = deps();
	const result = await executeTaskflow(state(child), d);
	assert.equal(result.ok, false);
	assert.equal(d.calls.value, 0);
	assert.match(result.finalOutput, /usage accounting is unavailable/i);
});

test("runtime infers unavailable accounting from a bare runner function", async () => {
	const d = deps();
	delete d.usageAccounting;
	(d.runTask as NonNullable<RuntimeDeps["runTask"]> & { usageAccounting: "unavailable" }).usageAccounting = "unavailable";
	const result = await executeTaskflow(state(child), d);
	assert.equal(result.ok, false);
	assert.equal(d.calls.value, 0);
});

test("tokens-only accounting enforces maxTokens and rejects maxUSD", async () => {
	const tokenDef: Taskflow = {
		name: "token-budget",
		budget: { maxTokens: 10 },
		phases: [{ id: "work", type: "agent", agent: "a", task: "spend", final: true }],
	};
	const tokenDeps = deps();
	tokenDeps.usageAccounting = "tokens-only";
	const tokenResult = await executeTaskflow(state(tokenDef), tokenDeps);
	assert.equal(tokenResult.ok, true);
	assert.equal(tokenDeps.calls.value, 1);

	const dollarDef: Taskflow = { ...tokenDef, name: "dollar-budget", budget: { maxUSD: 1 } };
	const dollarDeps = deps();
	dollarDeps.usageAccounting = "tokens-only";
	const dollarResult = await executeTaskflow(state(dollarDef), dollarDeps);
	assert.equal(dollarResult.ok, false);
	assert.equal(dollarDeps.calls.value, 0);
	assert.match(dollarResult.finalOutput, /reports tokens but not cost/i);
});

test("usage-unavailable host rejects every executable nested budget form", async (t) => {
	const cases: Array<{
		name: string;
		phase: Taskflow["phases"][number];
		loadFlow?: (name: string) => Taskflow | undefined;
		eventKernel?: boolean;
	}> = [
		{ name: "inline-object", phase: { id: "nested", type: "flow", def: child, final: true } },
		{ name: "inline-string", phase: { id: "nested", type: "flow", def: JSON.stringify(child), final: true } },
		{
			name: "saved-flow",
			phase: { id: "nested", type: "flow", use: child.name, final: true },
			loadFlow: (name) => (name === child.name ? child : undefined),
			eventKernel: true,
		},
		{ name: "expand", phase: { id: "nested", type: "expand", def: child, expandMode: "nested", final: true } },
		{ name: "expand-graft", phase: { id: "nested", type: "expand", def: child, expandMode: "graft", final: true } },
	];
	for (const entry of cases) {
		await t.test(entry.name, async () => {
			const def: Taskflow = { name: `parent-${entry.name}`, phases: [entry.phase] };
			const d = deps(entry.loadFlow);
			if (entry.eventKernel) d.eventKernel = true;
			const result = await executeTaskflow(state(def), d);
			assert.equal(result.ok, false);
			assert.equal(d.calls.value, 0, `${entry.name} must fail before spending`);
			const diagnostics = [result.finalOutput, ...Object.values(result.state.phases).map((p) => p.error ?? "")].join("\n");
			assert.match(diagnostics, /usage accounting is unavailable/i);
		});
	}
});
