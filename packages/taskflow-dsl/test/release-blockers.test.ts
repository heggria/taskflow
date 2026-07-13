import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSource } from "../src/build.ts";
import { checkFile } from "../src/check.ts";

test("map: callback alias and opts.as must agree", () => {
	const mismatch = buildSource(`
import { flow, agent, map } from "taskflow-dsl";
export default flow("bad-map-alias", () =>
  map("[]", (row) => agent(\`use \${row.name}\`), { as: "item" })
);`);
	assert.equal(mismatch.ok, false);
	assert.ok(mismatch.diagnostics.some((d) => d.code === "TFDSL_MAP_AS_MISMATCH"));

	const matching = buildSource(`
import { flow, agent, map } from "taskflow-dsl";
export default flow("good-map-alias", () =>
  map("[]", (row) => agent(\`use \${row.name}\`), { as: "row" })
);`);
	assert.equal(matching.ok, true, matching.diagnostics.map((d) => d.message).join("\n"));
	assert.equal(matching.taskflow?.phases?.[0]?.as, "row");
	assert.equal(matching.taskflow?.phases?.[0]?.task, "use {row.name}");
});

test("map: inner agent options cannot be silently shadowed by outer options", () => {
	const result = buildSource(`
import { flow, agent, map } from "taskflow-dsl";
export default flow("shadow", () =>
  map("[]", (row) => agent(\`use \${row.name}\`, { model: "inner" }), { model: "outer" })
);`);
	assert.equal(result.ok, false);
	assert.ok(result.diagnostics.some((d) => d.code === "TFDSL_MAP_OPTION_SHADOW"));
});

test("dynamic templates: approval.request, script.input, and tournament tasks wire dependencies", () => {
	const result = buildSource(`
import { flow, agent, approval, script, tournament } from "taskflow-dsl";
export default flow("dynamic-fields", () => {
  const seed = agent("seed");
  const approve = approval({ request: \`Approve \${seed.output}\` });
  const feed = script(["cat"], { input: \`stdin \${seed.output}\` });
  return tournament({
    branches: [agent(\`branch \${seed.output}\`), agent("static")],
    task: \`judge \${seed.output}\`,
    dependsOn: [approve, feed],
  });
});`);
	assert.equal(result.ok, true, result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
	const phases = result.taskflow?.phases ?? [];
	const approve = phases.find((p) => p.id === "approve");
	const feed = phases.find((p) => p.id === "feed");
	const contest = phases.find((p) => p.type === "tournament");
	assert.equal(approve?.task, "Approve {steps.seed.output}");
	assert.deepEqual(approve?.dependsOn, ["seed"]);
	assert.equal(feed?.input, "stdin {steps.seed.output}");
	assert.deepEqual(feed?.dependsOn, ["seed"]);
	assert.equal(contest?.task, "judge {steps.seed.output}");
	assert.equal(contest?.branches?.[0]?.task, "branch {steps.seed.output}");
	assert.deepEqual(new Set(contest?.dependsOn), new Set(["approve", "feed", "seed"]));
});

test("check: malformed and invalid tsconfig diagnostics fail closed", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-dsl-tsconfig-"));
	try {
		const source = path.join(root, "flow.tf.ts");
		fs.writeFileSync(source, 'import { flow, agent } from "taskflow-dsl"; export default flow("x", () => agent("x"));');

		fs.writeFileSync(path.join(root, "tsconfig.json"), '{ "compilerOptions": { "notARealOption": true } }');
		const invalid = checkFile(source, { cwd: root });
		assert.equal(invalid.ok, false);
		assert.ok(invalid.diagnostics.some((d) => d.code === "TS5023"), invalid.diagnostics.map((d) => d.message).join("\n"));

		fs.writeFileSync(path.join(root, "tsconfig.json"), '{ "compilerOptions": ');
		const malformed = checkFile(source, { cwd: root });
		assert.equal(malformed.ok, false);
		assert.ok(malformed.diagnostics.some((d) => d.code.startsWith("TS")));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
