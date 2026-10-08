#!/usr/bin/env node

// Check the adapter's direct dependency links, not the workspace root: pnpm
// can install different SDK versions at these two locations. These packages
// have import-only exports, so CommonJS require.resolve is not applicable.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const adapter = new URL("../packages/pi-taskflow/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", adapter), "utf8"));
for (const suffix of ["agent-core", "ai", "coding-agent", "tui"]) {
	const name = `@earendil-works/pi-${suffix}`;
	const expected = process.env.PI_TEST_PEER_VERSION ?? manifest.devDependencies[name];
	const installed = JSON.parse(readFileSync(new URL(`node_modules/${name}/package.json`, adapter), "utf8"));
	assert.equal(installed.name, name);
	assert.equal(installed.version, expected, `${name}: adapter must test the requested peer version`);
	console.log(`pi-taskflow resolves ${name}@${installed.version}`);
}
