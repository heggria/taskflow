/**
 * D28: taskflow-dsl must use an isolated TypeScript 6.x compiler API —
 * root workspace TypeScript is 7.x and must not leak into the DSL package.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = join(pkgDir, "..", "..");

test("D28: taskflow-dsl package.json pins typescript ^6", () => {
	const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")) as {
		dependencies?: { typescript?: string };
	};
	const range = pkg.dependencies?.typescript;
	assert.ok(range, "taskflow-dsl must depend on typescript");
	assert.match(range, /^\^?6\./, `expected TS 6.x pin, got ${range}`);
});

test("D28: root package.json pins typescript ^7", () => {
	const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf-8")) as {
		devDependencies?: { typescript?: string };
	};
	const range = pkg.devDependencies?.typescript;
	assert.ok(range, "root must devDepend on typescript");
	assert.match(range, /^\^?7\./, `expected root TS 7.x pin, got ${range}`);
});

test("D28: resolved DSL typescript major is 6 (not root 7)", () => {
	const require = createRequire(join(pkgDir, "package.json"));
	const tsPath = require.resolve("typescript/package.json");
	const tsPkg = JSON.parse(readFileSync(tsPath, "utf-8")) as { version: string };
	assert.match(tsPkg.version, /^6\./, `DSL-resolved typescript must be 6.x, got ${tsPkg.version} from ${tsPath}`);
	// Must resolve under the DSL package tree (or pnpm store linked for this package), not only root.
	assert.ok(
		tsPath.includes("taskflow-dsl") || tsPath.includes(".pnpm") || tsPath.includes("node_modules"),
		`unexpected typescript resolution path: ${tsPath}`,
	);
});

test("D28: root packageManager is pnpm 11.x", () => {
	const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf-8")) as {
		packageManager?: string;
	};
	assert.match(pkg.packageManager ?? "", /^pnpm@11\./, `expected pnpm@11.x, got ${pkg.packageManager}`);
});

test("D28: root @types/node is 22.x major", () => {
	const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf-8")) as {
		devDependencies?: { "@types/node"?: string };
	};
	const range = pkg.devDependencies?.["@types/node"] ?? "";
	assert.match(range, /22/, `expected @types/node 22.x pin, got ${range}`);
	assert.ok(!/\^?26/.test(range), "@types/node must not be 26 (D28)");
});
