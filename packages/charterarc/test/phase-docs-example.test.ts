import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	emptyUsage,
	PHASE_TYPES,
	type RuntimeDeps,
} from "taskflow-core";
import {
	phaseDocsProject,
} from "../../../examples/charterarc-phase-docs.ts";
import { runProject } from "../src/index.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

function readmeWith(phases: readonly string[]): string {
	return [
		"# Fixture",
		"",
		`## One runtime, ${phases.length} phase types`,
		"",
		"| Family | Phases | Use them for |",
		"|---|---|---|",
		`| Work | ${phases.map((phase) => `\`${phase}\``).join(" · ")} | Ignore \`ordinary-code-word\` here |`,
		"",
		"Across those phase types, the runtime provides shared behavior.",
		"",
	].join("\n");
}

test("phase-docs project: the real Taskflow README satisfies the declared contract", async () => {
	assert.equal(phaseDocsProject.maintain.args, undefined);
	assert.equal(phaseDocsProject.maintain.phases[0]?.thinking, "low");
	assert.deepEqual(phaseDocsProject.maintain.phases[1]?.tools, READ_ONLY_TOOLS);
	let tasks = 0;
	const outcome = await runProject(phaseDocsProject, {
		taskflow: {
			cwd: repoRoot,
			agents: [],
			async runTask() {
				tasks += 1;
				throw new Error("a satisfied project must not run maintenance");
			},
		},
	});

	assert.equal(outcome.status, "satisfied");
	assert.equal(outcome.run, undefined);
	assert.equal(tasks, 0);
});

test("phase-docs project: observed drift is repaired by an ordinary Taskflow", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "charterarc-phase-docs-"));
	try {
		await writeFile(path.join(cwd, "README.md"), readmeWith(PHASE_TYPES.slice(0, -1)));
		const calls: string[] = [];
		const tasks: string[] = [];
		const runTask: NonNullable<RuntimeDeps["runTask"]> = async (
			_cwd,
			_agents,
			agent,
			task,
		) => {
			calls.push(agent);
			tasks.push(task);
			if (agent === "doc-writer") {
				await writeFile(path.join(cwd, "README.md"), readmeWith(PHASE_TYPES));
			}
			const output = agent === "reviewer" ? "VERDICT: PASS" : `completed: ${task}`;
			return {
				agent,
				task,
				exitCode: 0,
				output,
				stderr: "",
				stopReason: "end",
				usage: emptyUsage(),
			};
		};

		const outcome = await runProject(phaseDocsProject, {
			taskflow: {
				cwd,
				agents: ["doc-writer", "reviewer"].map((name) => ({
					name,
					description: `${name} fixture agent`,
					systemPrompt: "",
					source: "user" as const,
					filePath: "",
				})),
				runTask,
			},
		});

		assert.equal(outcome.before.status, "drifted");
		assert.match(outcome.before.summary ?? "", new RegExp(`expected ${PHASE_TYPES.length} phases:`));
		assert.match(outcome.before.summary ?? "", new RegExp(`missing: ${PHASE_TYPES.at(-1)}`));
		assert.equal(outcome.run?.ok, true);
		assert.equal(outcome.status, "satisfied");
		assert.equal(outcome.after?.status, "satisfied");
		assert.deepEqual(calls, ["doc-writer", "reviewer"]);
		assert.match(tasks[0] ?? "", /README\.md: expected/);
		assert.match(tasks[0] ?? "", /"observation":/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("phase-docs project: missing catalog structure is unknown and cannot authorize repair", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "charterarc-phase-docs-"));
	try {
		await writeFile(path.join(cwd, "README.md"), "# Fixture\n");
		let tasks = 0;
		const outcome = await runProject(phaseDocsProject, {
			taskflow: {
				cwd,
				agents: [],
				async runTask() {
					tasks += 1;
					throw new Error("unknown evidence must not run maintenance");
				},
			},
		});

		assert.equal(outcome.status, "unknown");
		assert.equal(outcome.before.status, "unknown");
		assert.equal(tasks, 0);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
