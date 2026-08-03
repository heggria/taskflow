import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
	emptyUsage,
	type RuntimeDeps,
	type Taskflow,
} from "taskflow-core";
import { defineProject, runProject, type ProjectDefinition } from "../src/index.ts";
import { runPlainTaskflowProject } from "./fixtures/plain-taskflow-baseline.ts";

const flows: Record<string, Taskflow> = {
	types: {
		name: "repair-types",
		strictInterpolation: true,
		phases: [{
			id: "repair",
			type: "agent",
			agent: "worker",
			task:
				"{args.charterarc.selection.desired}|" +
				"{args.charterarc.desired}|{args.charterarc.snapshot.facts.failure}",
		}, {
			id: "review",
			type: "gate",
			agent: "worker",
			dependsOn: ["repair"],
			output: "json",
			expect: {
				type: "object",
				properties: { verdict: { enum: ["pass", "block"] } },
				required: ["verdict"],
			},
			task: "review {steps.repair.output}",
			final: true,
		}],
	},
	tests: {
		name: "repair-tests",
		strictInterpolation: true,
		phases: [{
			id: "repair",
			type: "agent",
			agent: "worker",
			task:
				"{args.charterarc.selection.desired}|" +
				"{args.charterarc.desired}|{args.charterarc.snapshot.facts.failure}",
		}, {
			id: "review",
			type: "gate",
			agent: "worker",
			dependsOn: ["repair"],
			output: "json",
			expect: {
				type: "object",
				properties: { verdict: { enum: ["pass", "block"] } },
				required: ["verdict"],
			},
			task: "review {steps.repair.output}",
			final: true,
		}],
	},
};

function project(route: "types" | "tests"): ProjectDefinition {
	let observations = 0;
	return {
		desired: {
			types: "TypeScript stays valid",
			tests: "Acceptance stays green",
		},
		maintain: flows,
		observe: async () => observations++ === 0
			? {
					status: "drifted",
					target: { desired: route },
					facts: { failure: route === "types" ? "TS2322" : "assertion" },
				}
			: { status: "satisfied", facts: { checks: "green" } },
	};
}

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
				output: task.startsWith("review ")
					? JSON.stringify({ verdict: "pass" })
					: "repaired",
				stderr: "",
				stopReason: "end",
				usage: emptyUsage(),
			};
		},
	};
}

test("plain baseline: matches CharterArc route, binding, Run count, and re-observation", async () => {
	for (const route of ["types", "tests"] as const) {
		const charterArcTasks: string[] = [];
		const plainTasks: string[] = [];
		const charterArc = await runProject(defineProject(project(route)), {
			taskflow: runtime(charterArcTasks),
		});
		const plain = await runPlainTaskflowProject(project(route), {
			taskflow: runtime(plainTasks),
		});

		assert.deepEqual(plain.selection, charterArc.selection);
		assert.deepEqual(plainTasks, charterArcTasks);
		assert.equal(plainTasks.length, 2);
		assert.match(plainTasks[1] ?? "", /^review repaired/);
		assert.equal(plain.run?.ok, charterArc.run?.ok);
		assert.equal(plain.after?.status, charterArc.after?.status);
		assert.equal(plain.ok, charterArc.ok);
	}
});

test("plain baseline: must reproduce healthy, unknown, and malformed no-Run safety", async () => {
	for (const snapshot of [
		{ status: "satisfied", facts: { checks: "green" } },
		{ status: "unknown", facts: { provider: "offline" } },
		{ status: "drifted", facts: { missing: "target" } },
		{ status: "satisfied", facts: {}, target: { desired: "types" } },
	]) {
		const tasks: string[] = [];
		const outcome = await runPlainTaskflowProject(
			{ ...project("types"), observe: async () => snapshot } as never,
			{ taskflow: runtime(tasks) },
		);
		assert.deepEqual(tasks, []);
		assert.equal(outcome.run, undefined);
		assert.equal(outcome.status, snapshot.status === "satisfied" && !("target" in snapshot)
			? "satisfied"
			: "unknown");
	}
});

test("plain baseline: its comparison is Taskflow-only and intentionally favorable", async () => {
	const source = await readFile(
		path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures/plain-taskflow-baseline.ts"),
		"utf8",
	);
	assert.match(source, /from "taskflow-core"/);
	assert.doesNotMatch(source, /import \{[^}]*defineProject|import \{[^}]*runProject/s);
	assert.match(source, /verifyTaskflow\(selected\.flow\)/);
	assert.match(source, /executeTaskflow\(state, runtime\)/);
	assert.match(source, /Deliberately favorable plain-Taskflow comparison/);
});
