/**
 * Structural guard (RFC §11): replay.ts must never import process-spawning or
 * runtime modules — otherwise offline replay could spend tokens.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

const FORBIDDEN = new Set([
	"runtime.ts",
	"exec/driver.ts",
	"exec/step.ts",
	"detached-runner.ts",
	"runner.ts", // pi host runner if ever present under core
]);

/** Resolve a relative import specifier from `fromFile` to an absolute .ts path. */
function resolveImport(fromFile: string, spec: string): string | null {
	if (!spec.startsWith(".")) return null; // bare package imports OK (none for replay)
	let resolved = path.resolve(path.dirname(fromFile), spec);
	if (!resolved.endsWith(".ts") && !resolved.endsWith(".js")) {
		if (fs.existsSync(resolved + ".ts")) resolved += ".ts";
		else if (fs.existsSync(path.join(resolved, "index.ts"))) resolved = path.join(resolved, "index.ts");
		else return null;
	}
	if (resolved.endsWith(".js")) resolved = resolved.replace(/\.js$/, ".ts");
	return resolved;
}

function collectRelativeImports(file: string): string[] {
	const text = fs.readFileSync(file, "utf8");
	const specs: string[] = [];
	// import … from "…"  |  export … from "…"  |  import("…")
	const re = /(?:import|export)\s+(?:type\s+)?(?:[^'"\n]+?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		const spec = m[1] ?? m[2];
		if (spec) specs.push(spec);
	}
	return specs;
}

/** BFS closure of relative imports starting at entry. */
function importClosure(entry: string): string[] {
	const seen = new Set<string>();
	const queue = [entry];
	while (queue.length) {
		const cur = queue.pop()!;
		if (seen.has(cur)) continue;
		if (!fs.existsSync(cur)) continue;
		seen.add(cur);
		for (const spec of collectRelativeImports(cur)) {
			const next = resolveImport(cur, spec);
			if (next && !seen.has(next)) queue.push(next);
		}
	}
	return [...seen];
}

test("replay import graph: does not reach runtime/driver/step", () => {
	const entry = path.join(SRC_ROOT, "replay.ts");
	assert.ok(fs.existsSync(entry), "replay.ts must exist");
	const files = importClosure(entry);
	const rel = files.map((f) => path.relative(SRC_ROOT, f).replace(/\\/g, "/"));
	for (const f of FORBIDDEN) {
		assert.ok(!rel.includes(f), `replay closure must not include ${f}; got: ${rel.join(", ")}`);
	}
	// Positive: must pull fold + events + deterministic
	assert.ok(rel.some((r) => r === "exec/fold.ts" || r.endsWith("/exec/fold.ts")));
	assert.ok(rel.some((r) => r === "exec/events.ts" || r.endsWith("/exec/events.ts")));
	assert.ok(rel.some((r) => r === "deterministic.ts"));
});

test("replay.ts source text has no forbidden import strings", () => {
	const text = fs.readFileSync(path.join(SRC_ROOT, "replay.ts"), "utf8");
	assert.doesNotMatch(text, /from\s+["']\.\/runtime/);
	assert.doesNotMatch(text, /from\s+["']\.\/exec\/driver/);
	assert.doesNotMatch(text, /from\s+["']\.\/exec\/step/);
	assert.doesNotMatch(text, /from\s+["']\.\/detached-runner/);
});
