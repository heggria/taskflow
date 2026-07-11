import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildSource } from "../src/build.ts";
import { decompileTaskflow } from "../src/decompile.ts";
import { validateTaskflow, type Taskflow } from "taskflow-core";

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
