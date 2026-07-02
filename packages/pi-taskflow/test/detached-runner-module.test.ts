/**
 * Regression guard for the detached-run runner-module resolution bug
 * (found 2026-07-02, second recurrence of the issue #3 class).
 *
 * The bug: the host serialized `runnerModule` for the detached child via
 * `import.meta.resolve("./runner.ts")`. tsc's `rewriteRelativeImportExtensions`
 * rewrites STATIC import specifiers (`import ... from "./runner.ts"` →
 * `"./runner.js"`) but does NOT touch string arguments of
 * `import.meta.resolve()`. The compiled dist/index.js therefore pointed the
 * detached child at `dist/runner.ts` — a file that does not exist — the
 * dynamic import failed, and EVERY detached phase died with
 * "No subagent runner injected" while unit tests (which run from src) passed.
 *
 * The fix: runner.ts self-reports its own path via `runnerModulePath()`
 * (`import.meta.url`), which is correct under BOTH conditions by construction.
 *
 * These tests pin the bug class three ways:
 *  1. The self-reported path exists and exports a working runner (current
 *     condition — src in dev, dist in prod).
 *  2. If a compiled dist/index.js exists, it must not contain ANY
 *     `import.meta.resolve("<relative>.ts")` — the exact compile-time trap.
 *  3. If a compiled dist/runner.js exists, importing it must yield
 *     `piSubagentRunner.runTask` AND `runnerModulePath()` must point back at
 *     that same dist file — proving the detached context would be valid in a
 *     published install, not just in the workspace.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runnerModulePath, piSubagentRunner } from "../src/runner.ts";

test("detached runnerModule: self-reported path exists and exports a SubagentRunner", async () => {
	const p = runnerModulePath();
	assert.ok(existsSync(p), `runnerModulePath() must exist on disk: ${p}`);
	// The detached-runner does exactly this dynamic import — replicate it.
	const mod = await import(p);
	const runner = mod["piSubagentRunner"];
	assert.ok(runner && typeof runner.runTask === "function",
		"dynamic import of runnerModulePath() must expose piSubagentRunner.runTask");
	assert.equal(runner.runTask, piSubagentRunner.runTask, "must be the same runner object");
});

test("detached runnerModule: compiled index.js must not resolve relative .ts specifiers", () => {
	const distIndex = fileURLToPath(new URL("../dist/index.js", import.meta.url));
	if (!existsSync(distIndex)) return; // dist not built in this checkout — covered in CI's build job
	const src = readFileSync(distIndex, "utf-8");
	// The trap: import.meta.resolve("./<anything>.ts") survives compilation
	// verbatim and points at a nonexistent file in dist.
	const bad = src.match(/import\.meta\.resolve\(\s*["']\.\.?\/[^"']*\.ts["']\s*\)/);
	assert.equal(bad, null,
		`compiled dist/index.js must not contain import.meta.resolve of a relative .ts specifier (found: ${bad?.[0]}) — ` +
		`rewriteRelativeImportExtensions does not rewrite it; use runnerModulePath() instead`);
});

test("detached runnerModule: compiled dist/runner.js (if built) is itself a valid runnerModule", async () => {
	const distRunner = fileURLToPath(new URL("../dist/runner.js", import.meta.url));
	if (!existsSync(distRunner)) return; // dist not built in this checkout — covered in CI's build job
	const mod = await import(distRunner);
	assert.ok(mod.piSubagentRunner && typeof mod.piSubagentRunner.runTask === "function",
		"dist/runner.js must export piSubagentRunner.runTask");
	assert.equal(typeof mod.runnerModulePath, "function", "dist/runner.js must export runnerModulePath");
	// In the compiled module, self-reporting must point at the dist file itself.
	assert.equal(mod.runnerModulePath(), distRunner,
		"compiled runnerModulePath() must self-report the dist path — this is what the detached context serializes");
});
