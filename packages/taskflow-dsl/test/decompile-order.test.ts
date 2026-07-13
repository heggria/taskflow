import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildSource } from "../src/build.ts";
import { decompileTaskflow } from "../src/decompile.ts";
import { executeTaskflow, validateTaskflow, type RunState, type RuntimeDeps, type Taskflow } from "taskflow-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");

const outOfOrder: Taskflow = {
	name: "out-of-order",
	phases: [
		{
			id: "quality-gate",
			type: "gate",
			task: "Review the seed and end with VERDICT: PASS or VERDICT: BLOCK.",
			dependsOn: ["seed"],
			final: true,
		},
		{ id: "seed", type: "agent", task: "Produce the seed." },
	],
};

test("decompile: emits dependencies before consumers for valid out-of-order JSON", () => {
	assert.equal(validateTaskflow(outOfOrder).ok, true);
	const source = decompileTaskflow(outOfOrder);
	assert.ok(source.indexOf("const seed = agent") < source.indexOf("const quality_gate = gate"));

	const rebuilt = buildSource(source, "out-of-order.tf.ts");
	assert.equal(
		rebuilt.ok,
		true,
		rebuilt.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
	);
	assert.deepEqual(rebuilt.taskflow?.phases.map((p) => p.id), ["seed", "quality-gate"]);
	assert.deepEqual(rebuilt.taskflow?.phases[1]?.dependsOn, ["seed"]);
	assert.equal(rebuilt.taskflow?.phases[1]?.final, true);
});

test("decompile CLI: successful stdout is rebuildable for out-of-order JSON", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-dsl-decompile-order-"));
	try {
		fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify(outOfOrder));
		const cli = path.join(repo, "packages/taskflow-dsl/src/cli.ts");
		const result = spawnSync(
			process.execPath,
			[
				"--conditions=development",
				"--experimental-strip-types",
				cli,
				"decompile",
				"flow.json",
				"--cwd",
				dir,
				"--out",
				"-",
			],
			{ cwd: repo, encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);
		const rebuilt = buildSource(result.stdout, "cli-out-of-order.tf.ts");
		assert.equal(
			rebuilt.ok,
			true,
			rebuilt.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
		);
		assert.deepEqual(rebuilt.taskflow?.phases.map((p) => p.id), ["seed", "quality-gate"]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("decompile: topological emission preserves implicit finalOutput semantics", async () => {
	const original: Taskflow = {
		name: "implicit-final-out-of-order",
		phases: [
			{ id: "consumer", type: "agent", task: "consumer", dependsOn: ["seed"] },
			{ id: "seed", type: "agent", task: "seed" },
		],
	};
	assert.equal(validateTaskflow(original).ok, true);
	const rebuilt = buildSource(decompileTaskflow(original), "implicit-final.tf.ts");
	assert.equal(rebuilt.ok, true, rebuilt.diagnostics.map((d) => d.message).join("\n"));
	assert.equal(rebuilt.taskflow?.phases.find((p) => p.id === "seed")?.final, true);

	const deps: RuntimeDeps = {
		runTask: async (_cwd, _agents, agent, task) => ({
			agent,
			task,
			exitCode: 0,
			output: `out:${task}`,
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, contextTokens: 0 },
		}),
		agents: [{ name: "default", description: "test", systemPrompt: "", source: "project", filePath: "test" }],
		cwd: process.cwd(),
	};
	const state = (def: Taskflow): RunState => ({
		runId: `test-${def.name}`,
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: process.cwd(),
	});
	const before = await executeTaskflow(state(original), deps);
	const after = await executeTaskflow(state(rebuilt.taskflow!), deps);
	assert.equal(before.finalOutput, "out:seed");
	assert.equal(after.finalOutput, before.finalOutput);
});
