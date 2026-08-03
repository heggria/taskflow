import assert from "node:assert/strict";
import { test } from "node:test";
import {
	emptyUsage,
	type RuntimeDeps,
	type Taskflow,
} from "taskflow-core";
import { defineProject, runProject } from "../src/index.ts";
import type { ObservationResult } from "../src/index.ts";

// @ts-expect-error Every observation is an explicit snapshot with facts.
const missingFacts: ObservationResult = { status: "satisfied" };
// @ts-expect-error Confirmed drift must identify one desired target.
const missingTarget: ObservationResult = { status: "drifted", facts: {} };
// @ts-expect-error Healthy snapshots cannot carry mutation authority.
const healthyTarget: ObservationResult = { status: "satisfied", facts: {}, target: { desired: "types" } };
// @ts-expect-error Structured facts must not reopen authority on a healthy snapshot.
const healthyObservedTarget: ObservationResult = { status: "satisfied", facts: { observed: "satisfied" }, target: { desired: "types" } };
void [missingFacts, missingTarget, healthyTarget, healthyObservedTarget];

const typesFlow: Taskflow = {
	name: "repair-types",
	strictInterpolation: true,
	phases: [{
		id: "repair",
		type: "agent",
		agent: "worker",
		task:
			"types|{args.charterarc.selection.desired}|" +
			"{args.charterarc.desired}|{args.charterarc.snapshot.facts.diagnostic}",
		final: true,
	}],
};

const testsFlow: Taskflow = {
	name: "repair-tests",
	strictInterpolation: true,
	phases: [{
		id: "repair",
		type: "agent",
		agent: "worker",
		task:
			"tests|{args.charterarc.selection.desired}|" +
			"{args.charterarc.desired}|{args.charterarc.snapshot.facts.diagnostic}",
		final: true,
	}],
};

function runtime(tasks: string[]): RuntimeDeps {
	return {
		cwd: process.cwd(),
		agents: [{
			name: "worker",
			description: "fixture worker",
			systemPrompt: "",
			source: "user",
			filePath: "",
		}],
		async runTask(_cwd, _agents, agent, task) {
			tasks.push(task);
			return {
				agent,
				task,
				exitCode: 0,
				output: "repaired",
				stderr: "",
				stopReason: "end",
				usage: emptyUsage(),
			};
		},
	};
}

function declaration(
	first: Readonly<Record<string, unknown>>,
	desired: Readonly<Record<string, string>> = {
		types: "TypeScript contracts stay valid",
		tests: "Acceptance tests stay green",
	},
	maintain: Readonly<Record<string, Taskflow>> = {
		types: typesFlow,
		tests: testsFlow,
	},
	modules?: Readonly<Record<string, unknown>>,
) {
	let observations = 0;
	return defineProject({
		desired,
		maintain,
		...(modules === undefined ? {} : { modules }),
		observe: async () => observations++ === 0
			? first
			: { status: "satisfied", facts: { checks: "green" } },
	} as never);
}

test("reconcile: one declaration routes different gaps to different ordinary Taskflows", async () => {
	const typeTasks: string[] = [];
	const typeOutcome = await runProject(
		declaration({
			status: "drifted",
			target: { desired: "types" },
			facts: { diagnostic: "TS2322" },
		}),
		{ taskflow: runtime(typeTasks) },
	);
	assert.deepEqual(
		(typeOutcome as unknown as { selection?: unknown }).selection,
		{ desired: "types", flow: "repair-types" },
	);
	assert.deepEqual(typeTasks, [
		"types|types|TypeScript contracts stay valid|TS2322",
	]);
	assert.equal(typeOutcome.run?.ok, true);
	assert.equal(typeOutcome.after?.status, "satisfied");

	const testTasks: string[] = [];
	const testOutcome = await runProject(
		declaration({
			status: "drifted",
			target: { desired: "tests" },
			facts: { diagnostic: "assertion" },
		}),
		{ taskflow: runtime(testTasks) },
	);
	assert.deepEqual(
		(testOutcome as unknown as { selection?: unknown }).selection,
		{ desired: "tests", flow: "repair-tests" },
	);
	assert.deepEqual(testTasks, [
		"tests|tests|Acceptance tests stay green|assertion",
	]);
	assert.equal(testOutcome.run?.ok, true);
	assert.equal(testOutcome.after?.status, "satisfied");
});

test("reconcile: healthy and unknown snapshots start no Taskflow", async () => {
	for (const snapshot of [
		{ status: "satisfied", facts: { checks: "green" } },
		{ status: "unknown", facts: { provider: "offline" }, summary: "CI unavailable" },
	]) {
		const tasks: string[] = [];
		const outcome = await runProject(declaration(snapshot), {
			taskflow: runtime(tasks),
		});
		assert.deepEqual(tasks, []);
		assert.equal(outcome.run, undefined);
		assert.equal(outcome.after, undefined);
		assert.deepEqual((outcome.before as unknown as { facts: unknown }).facts, snapshot.facts);
	}
});

test("reconcile: an optional Module narrows desired state and Flow selection", async () => {
	const docsFlow: Taskflow = {
		name: "repair-docs",
		strictInterpolation: true,
		phases: [{
			id: "repair",
			type: "agent",
			agent: "worker",
			task:
				"{args.charterarc.selection.module}|" +
				"{args.charterarc.selection.desired}|{args.charterarc.desired}",
			final: true,
		}],
	};
	const tasks: string[] = [];
	const outcome = await runProject(
		declaration(
			{
				status: "drifted",
				target: { module: "docs", desired: "catalog" },
				facts: { missing: "race" },
			},
			{},
			{},
			{
				docs: {
					desired: { catalog: "The phase catalog is complete" },
					maintain: { catalog: docsFlow },
				},
			},
		),
		{ taskflow: runtime(tasks) },
	);

	assert.deepEqual(
		(outcome as unknown as { selection?: unknown }).selection,
		{ module: "docs", desired: "catalog", flow: "repair-docs" },
	);
	assert.deepEqual(tasks, ["docs|catalog|The phase catalog is complete"]);
});

test("reconcile: malformed or unbound observations are unknown and non-authorizing", async () => {
	for (const snapshot of [
		{ status: "satisfied" },
		{
			status: "satisfied",
			target: { desired: "types" },
			facts: { diagnostic: "healthy cannot authorize" },
		},
		{ status: "drifted", facts: { diagnostic: "missing target" } },
		{
			status: "drifted",
			target: { desired: "types" },
		},
		{
			status: "drifted",
			target: { desired: "not-declared" },
			facts: { diagnostic: "unbound" },
		},
		{ status: "satisfied", facts: [] },
	]) {
		const tasks: string[] = [];
		const outcome = await runProject(declaration(snapshot), {
			taskflow: runtime(tasks),
		});
		assert.equal(outcome.status, "unknown");
		assert.equal(outcome.before.status, "unknown");
		assert.deepEqual(tasks, []);
		assert.equal(outcome.run, undefined);
	}
});

test("reconcile: every declared Flow must pass Taskflow static verification", () => {
	const unverified: Taskflow = {
		name: "unverified-flow",
		strictInterpolation: true,
		phases: [{
			id: "repair",
			type: "agent",
			task: "use {steps.missing.output}",
			final: true,
		}],
	};

	assert.throws(
		() => declaration(
			{ status: "satisfied", facts: {} },
			{ contract: "The Flow is valid" },
			{ contract: unverified },
		),
		/invalid Taskflow|static verification/i,
	);
});
