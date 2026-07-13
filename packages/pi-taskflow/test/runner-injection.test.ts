/**
 * Structural regression guard for the issue #3 bug CLASS: every host call site
 * of `executeTaskflow` / `recomputeTaskflow` MUST inject a `runTask`.
 *
 * Background: the monorepo split changed the engine's default `runTask` from
 * `runAgentTask` (same package) to a `noRunnerInjected` stub (core is
 * host-neutral). Every host adapter must therefore inject its own runner. This
 * was missed for pi-taskflow's foreground `runFlow` and the two `recompute`
 * paths — silently breaking ALL phase execution, not just detached. The unit
 * tests didn't catch it because they inject a mock runner at the engine layer,
 * never exercising the production call sites.
 *
 * This test reads the production source and asserts each deps object injects
 * runTask, so the class of bug cannot recur silently.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const SRC = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
const TEST_DIR = new URL("./", import.meta.url);

/**
 * Verify every `const deps: RuntimeDeps = { ... }` block in the source sets
 * `runTask`, AND every inline executeTaskflow(state, {...}) call passes runTask.
 * Covers both forms used in index.ts: inline deps for runFlow's executeTaskflow,
 * and a separately-declared `deps` variable for the recompute paths.
 */
function assertAllDepsInjectRunTask(): void {
	// Form 1: `const deps: RuntimeDeps = { ... }` — match each block to its `};`.
	const declRe = /const\s+deps\s*:\s*RuntimeDeps\s*=\s*\{/g;
	let m: RegExpExecArray | null;
	let declCount = 0;
	while ((m = declRe.exec(SRC)) !== null) {
		declCount++;
		const block = SRC.slice(m.index, m.index + 800);
		const end = block.indexOf("};");
		const body = end > 0 ? block.slice(0, end) : block;
		assert.ok(
			/runTask\s*:/m.test(body),
			`deps block #${declCount} at offset ${m.index} does NOT set runTask — issue #3 bug class (host must inject its runner)`,
		);
	}
	// Form 2: inline executeTaskflow(state, { ... }) — scan the inline object.
	const inlineRe = /executeTaskflow\(state,\s*\{/g;
	let inlineCount = 0;
	while ((m = inlineRe.exec(SRC)) !== null) {
		inlineCount++;
		const block = SRC.slice(m.index, m.index + 1200);
		const end = block.indexOf("})");
		const body = end > 0 ? block.slice(0, end) : block;
		assert.ok(
			/runTask\s*:/m.test(body),
			`inline executeTaskflow deps at offset ${m.index} does NOT set runTask — issue #3 bug class`,
		);
	}
	assert.ok(declCount >= 2, `expected >=2 'const deps: RuntimeDeps' blocks (recompute paths), found ${declCount}`);
	assert.ok(inlineCount >= 1, `expected >=1 inline executeTaskflow(state,{...}) call (runFlow), found ${inlineCount}`);
}

test("regression: every executeTaskflow / recomputeTaskflow deps in pi index.ts injects runTask", () => {
	assertAllDepsInjectRunTask();
});

test("regression: every direct-execution .mts test injects runTask", () => {
	const offenders: string[] = [];
	for (const name of readdirSync(TEST_DIR).filter((entry) => entry.endsWith(".mts"))) {
		const source = readFileSync(new URL(name, TEST_DIR), "utf-8");
		if (!/\bexecuteTaskflow\s*\(/.test(source)) continue;
		if (!/\brunTask\s*:/.test(source)) offenders.push(name);
	}
	assert.deepEqual(
		offenders,
		[],
		`direct-execution .mts tests must inject a real or mock host runner: ${offenders.join(", ")}`,
	);
});

test("regression: the detached context file carries a runnerModule (runner injection for the child process)", () => {
	// The detached path injects the runner indirectly: the host serializes a
	// runnerModule into the context file, which the child dynamically imports.
	// Accept either the shorthand (`runnerModule,`) or key (`runnerModule:`) form.
	assert.ok(/\brunnerModule\b[,:]/.test(SRC), "detached context must carry runnerModule");
	assert.match(SRC, /runnerExport:\s*"piSubagentRunner"/, "detached context must name the pi runner export");
});

test("regression: piSubagentRunner is imported into index.ts (the injected runner)", () => {
	assert.match(SRC, /import\s*\{[^}]*\bpiSubagentRunner\b[^}]*\}\s*from\s*"\.\/runner\.ts"/, "index.ts must import piSubagentRunner from ./runner.ts");
});
