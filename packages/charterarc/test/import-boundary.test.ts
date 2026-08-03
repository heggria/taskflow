import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("architecture: CharterArc depends only on Taskflow core and Node built-ins", () => {
	const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
	for (const file of fs.globSync("**/*.ts", { cwd: sourceRoot })) {
		const source = fs.readFileSync(path.join(sourceRoot, file), "utf8");
		assert.doesNotMatch(
			source,
			/from\s+["'](?:taskflow-(?:control|daemon|hosts|mcp-core)|pi-taskflow|codex-taskflow|claude-taskflow|opencode-taskflow|grok-taskflow)/,
			`${file} crossed the CharterArc dependency boundary`,
		);
		assert.doesNotMatch(
			source,
			/from\s+["']taskflow-core\/(?:runtime|exec|store)/,
			`${file} imported Taskflow execution internals directly`,
		);
	}
});

test("architecture: the runtime surface has only defineProject and runProject", async () => {
	const api = await import("../src/index.ts");
	assert.deepEqual(Object.keys(api).sort(), [
		"defineProject",
		"runProject",
	]);
});

test("package: published exports resolve only to built files", () => {
	const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
		publishConfig?: { exports?: unknown };
	};
	assert.deepEqual(manifest.publishConfig?.exports, {
		".": {
			types: "./dist/index.d.ts",
			default: "./dist/index.js",
		},
	});
	assert.doesNotMatch(JSON.stringify(manifest.publishConfig), /development|src\//);
});
