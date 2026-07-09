/**
 * taskflow-dsl must not import runtime/exec/hosts/mcp from core internals.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");

const FORBIDDEN = [
	"/runtime",
	"/exec/",
	"executeTaskflow",
	"taskflow-hosts",
	"taskflow-mcp-core",
	"detached-runner",
	"@earendil-works/",
];

function walk(dir: string, out: string[] = []): string[] {
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) walk(p, out);
		else if (ent.name.endsWith(".ts")) out.push(p);
	}
	return out;
}

test("import-lint: no forbidden runtime/host imports in taskflow-dsl src", () => {
	const files = walk(srcRoot);
	const hits: string[] = [];
	for (const f of files) {
		const text = fs.readFileSync(f, "utf8");
		for (const bad of FORBIDDEN) {
			if (text.includes(bad)) hits.push(`${path.relative(srcRoot, f)}: ${bad}`);
		}
	}
	assert.deepEqual(hits, [], hits.join("\n"));
});
