import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildSource } from "../src/build.ts";
import type { Taskflow } from "taskflow-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const examples = path.resolve(here, "../examples");

test("comprehensive review example: committed artifact matches source and map alias", () => {
	const sourcePath = path.join(examples, "0.2.0-comprehensive-review.tf.ts");
	const artifactPath = path.join(examples, "0.2.0-comprehensive-review.taskflow.json");
	const built = buildSource(fs.readFileSync(sourcePath, "utf8"), sourcePath);
	assert.equal(
		built.ok,
		true,
		built.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("\n"),
	);
	const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as Taskflow;
	assert.deepEqual(built.taskflow, artifact);

	const mapPhase = artifact.phases.find((phase) => phase.id === "module-audits");
	assert.equal(mapPhase?.type, "map");
	assert.equal(mapPhase?.as, undefined);
	assert.match(mapPhase?.task ?? "", /\{item\.area\}/);
});
