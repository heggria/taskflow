// pnpm may resolve different SDK versions at the root and adapter. Verify the
// direct links used by adapter imports before claiming compatibility coverage.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const expected = process.env.PI_TEST_PEER_VERSION;
assert.ok(expected, "PI_TEST_PEER_VERSION must identify the matrix version");
for (const suffix of ["agent-core", "ai", "coding-agent", "tui"]) {
	const name = `@earendil-works/pi-${suffix}`;
	const installed = JSON.parse(readFileSync(new URL(`../packages/pi-taskflow/node_modules/${name}/package.json`, import.meta.url), "utf8"));
	assert.equal(installed.name, name);
	assert.equal(installed.version, expected, `${name}: adapter must resolve the requested peer version`);
	console.log(`pi-taskflow resolves ${name}@${installed.version}`);
}
