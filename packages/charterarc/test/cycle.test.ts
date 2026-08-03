import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import {
	emptyUsage,
	type RuntimeDeps,
	type Taskflow,
} from "taskflow-core";
import {
	defineProject,
	runProject,
	type ProjectDefinition,
} from "../src/index.ts";

const maintenance: Taskflow = {
	name: "maintain-test-project",
	phases: [{ id: "repair", type: "agent", agent: "worker", task: "repair", final: true }],
};

function projectWith(observe: ProjectDefinition["observe"]): ProjectDefinition {
	return defineProject({
		desired: "main is releasable",
		observe,
		maintain: maintenance,
	});
}

function taskflowRuntime(runTask: NonNullable<RuntimeDeps["runTask"]>): RuntimeDeps {
	return {
		cwd: process.cwd(),
		agents: [{
			name: "worker",
			description: "test worker",
			systemPrompt: "",
			source: "user",
			filePath: "",
		}],
		runTask,
	};
}

function runner(
	onTask?: (task: string) => void,
	options: { fail?: boolean } = {},
): NonNullable<RuntimeDeps["runTask"]> {
	return async (_cwd, _agents, agent, task) => {
		onTask?.(task);
		return {
			agent,
			task,
			exitCode: options.fail ? 1 : 0,
			output: options.fail ? "" : "repaired",
			stderr: options.fail ? "repair failed" : "",
			errorMessage: options.fail ? "repair failed" : undefined,
			stopReason: options.fail ? "error" : "end",
			usage: emptyUsage(),
		};
	};
}

test("runProject: healthy reality performs no Taskflow Run", async () => {
	let tasks = 0;
	const outcome = await runProject(
		projectWith(async () => ({ status: "satisfied" })),
		{ taskflow: taskflowRuntime(runner(() => tasks += 1)) },
	);

	assert.equal(outcome.status, "satisfied");
	assert.equal(outcome.before.status, "satisfied");
	assert.equal(tasks, 0);
	assert.equal(outcome.after, undefined);
});

test("runProject: confirmed drift uses the ordinary Taskflow engine", async () => {
	let observations = 0;
	let tasks = 0;
	const project = projectWith(async () => ({
		status: observations++ === 0 ? "drifted" : "satisfied",
	}));
	const outcome = await runProject(project, {
		taskflow: taskflowRuntime(runner(() => tasks += 1)),
	});

	assert.equal(outcome.before.status, "drifted");
	assert.equal(outcome.status, "satisfied");
	assert.equal(tasks, 1);
	assert.equal(outcome.run?.finalOutput, "repaired");
	assert.equal(outcome.after?.status, "satisfied");
});

test("runProject: exposes existing Taskflow usage without claiming unavailable cost is zero", async () => {
	let observations = 0;
	const runTask = runner();
	const meteredRunner: NonNullable<RuntimeDeps["runTask"]> = async (...args) => {
		const result = await runTask(...args);
		return {
			...result,
			usage: {
				input: 120,
				output: 30,
				cacheRead: 50,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 200,
				turns: 1,
			},
		};
	};
	(
		meteredRunner as typeof meteredRunner & { usageAccounting: "tokens-only" }
	).usageAccounting = "tokens-only";
	const outcome = await runProject(
		projectWith(async () => ({
			status: observations++ === 0 ? "drifted" : "satisfied",
		})),
		{ taskflow: taskflowRuntime(meteredRunner) },
	);

	assert.deepEqual(outcome.run?.usage, {
		input: 120,
		output: 30,
		cacheRead: 50,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 1,
	});
	assert.equal(outcome.run?.usageAccounting, "tokens-only");
});

test("runProject: unknown evidence holds without authorizing mutation", async () => {
	let tasks = 0;
	const outcome = await runProject(
		projectWith(async () => ({ status: "unknown", summary: "CI unavailable" })),
		{ taskflow: taskflowRuntime(runner(() => tasks += 1)) },
	);

	assert.equal(outcome.status, "unknown");
	assert.equal(tasks, 0);
	assert.equal(outcome.run, undefined);
});

test("runProject: malformed observer evidence is normalized to unknown", async () => {
	const outcome = await runProject(
		projectWith(async () => ({
			status: "drifted",
			extra: true,
		} as never)),
		{ taskflow: taskflowRuntime(runner()) },
	);

	assert.equal(outcome.status, "unknown");
	assert.equal(outcome.before.status, "unknown");
});

test("runProject: a hanging observer reaches the finite deadline and becomes unknown", async () => {
	let receivedSignal: AbortSignal | undefined;
	const outcome = await runProject(
		projectWith(async ({ signal }) => {
			receivedSignal = signal;
			return new Promise(() => undefined);
		}),
		{
			observeTimeoutMs: 5,
			taskflow: taskflowRuntime(runner()),
		},
	);

	assert.equal(receivedSignal?.aborted, true);
	assert.equal(outcome.status, "unknown");
	assert.match(outcome.before.summary ?? "", /timed out/);
});

test("runProject: an observer cannot turn its timeout abort into drift authority", async () => {
	let tasks = 0;
	const outcome = await runProject(
		projectWith(async ({ signal }) =>
			new Promise((resolve) => {
				signal.addEventListener(
					"abort",
					() => resolve({ status: "drifted" }),
					{ once: true },
				);
			})),
		{
			observeTimeoutMs: 5,
			taskflow: taskflowRuntime(runner(() => tasks += 1)),
		},
	);

	assert.equal(outcome.status, "unknown");
	assert.equal(tasks, 0);
});

test("runProject: status reports observed reality, not a causal changed claim", async () => {
	let observations = 0;
	const outcome = await runProject(
		projectWith(async () => ({
			status: observations++ === 0 ? "drifted" : "satisfied",
		})),
		{ taskflow: taskflowRuntime(runner(undefined, { fail: true })) },
	);

	assert.equal(outcome.run?.ok, false);
	assert.equal(outcome.status, "satisfied");
});

test("runProject: post-run observer failure preserves the completed Run outcome", async () => {
	let observations = 0;
	const outcome = await runProject(
		projectWith(async () => {
			if (observations++ > 0) throw new Error();
			return { status: "drifted" };
		}),
		{ taskflow: taskflowRuntime(runner()) },
	);

	assert.equal(outcome.run?.ok, true);
	assert.equal(outcome.status, "unknown");
	assert.equal(outcome.after?.summary, "observer failed");
});

test("runProject: direct callers cannot smuggle a second project identity", async () => {
	await assert.rejects(
		runProject(
			{
				name: "duplicate-project-name",
				desired: "main is releasable",
				observe: async () => ({ status: "satisfied" }),
				maintain: maintenance,
			} as never,
			{ taskflow: taskflowRuntime(runner()) },
		),
		/unknown field 'name'/,
	);
});

test("runProject: captures one stable ProjectDefinition before observation", async () => {
	let observations = 0;
	const observerCalls: string[] = [];
	const mutableProject = {
		desired: "original desired state",
		async observe(): ReturnType<ProjectDefinition["observe"]> {
			observerCalls.push("original");
			const before = observations++ === 0;
			if (before) {
				mutableProject.desired = "mutated desired state";
				mutableProject.observe = async () => {
					observerCalls.push("mutated");
					return { status: "unknown" };
				};
				mutableProject.maintain.phases[0]!.task = "mutated repair";
			}
			return { status: before ? "drifted" : "satisfied" };
		},
		maintain: {
			name: "mutable-maintain",
			phases: [{
				id: "repair",
				type: "agent" as const,
				task: "{args.charterarc.desired}: original repair",
				final: true,
			}],
		},
	};
	const tasks: string[] = [];
	await runProject(mutableProject, {
		taskflow: taskflowRuntime(runner((task) => tasks.push(task))),
	});

	assert.deepEqual(observerCalls, ["original", "original"]);
	assert.deepEqual(tasks, ["original desired state: original repair"]);
});

test("runProject: observation and maintenance stay bound to one runtime cwd", async () => {
	const cwd = process.cwd();
	const observedCwds: string[] = [];
	const taskCwds: string[] = [];
	let observations = 0;
	const baseRunner = runner();
	const runTask: NonNullable<RuntimeDeps["runTask"]> = async (
		taskCwd,
		agents,
		agent,
		task,
		options,
	) => {
		taskCwds.push(taskCwd);
		return baseRunner(taskCwd, agents, agent, task, options);
	};
	const runtime = {
		taskflow: taskflowRuntime(runTask),
	};
	const project = projectWith(async (context) => {
		observedCwds.push(context.cwd);
		if (observations++ === 0) {
			runtime.taskflow.cwd = os.tmpdir();
			return { status: "drifted" };
		}
		return { status: "satisfied" };
	});

	await runProject(project, runtime);

	assert.deepEqual(observedCwds, [cwd, cwd]);
	assert.deepEqual(taskCwds, [cwd]);
});
