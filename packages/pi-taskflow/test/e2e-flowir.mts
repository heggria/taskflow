/**
 * E2E smoke test for the FlowIR compile seam (M1).
 *
 * Exercises `compileTaskflowToIR` against every flow in `examples/` plus a
 * deliberately-broken flow, asserting:
 *   - a stable 32-hex content hash is produced
 *   - inject/emits are synthesized per node
 *   - determinism (compile twice → identical hash)
 *   - a broken flow yields structured diagnostics (never throws)
 *
 * Uses the REAL compile seam (no mock); no live `pi` or model access needed.
 *
 * Run:  node --experimental-strip-types test/e2e-flowir.mts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { compileTaskflowToIR } from "../extensions/flowir/index.ts";
import type { Taskflow } from "taskflow-core";

const C = {
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
	ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
	bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
	hl: (s: string) => `\x1b[36m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.join(__dirname, "..", "examples");

let failures = 0;
const assert = (cond: boolean, msg: string) => {
	if (cond) console.log(`  ${C.ok("✓")} ${msg}`);
	else {
		console.log(`  ${C.bad("✗")} ${msg}`);
		failures++;
	}
};

async function main() {
	const files = fs.readdirSync(examplesDir).filter((f) => f.endsWith(".json"));
	console.log(C.bold(`\nFlowIR E2E — ${files.length} example flow(s)\n`));

	for (const file of files) {
		const raw = fs.readFileSync(path.join(examplesDir, file), "utf-8");
		const def = JSON.parse(raw) as Taskflow;
		console.log(C.hl(`▸ ${file}  (flow "${def.name}", ${def.phases.length} phases)`));

		const ir = await compileTaskflowToIR(def);
		assert(!!ir.hash && /^[0-9a-f]{32}$/.test(ir.hash), `hash: ${ir.hash}`);
		assert(ir.ir!.nodes.length === def.phases.length, `${ir.ir!.nodes.length} nodes (1:1)`);

		// Determinism: compile twice → identical hash.
		const ir2 = await compileTaskflowToIR(def);
		assert(ir.hash === ir2.hash, "deterministic across recompiles");

		// Every node emits [id] and inject is an array.
		for (const n of ir.ir!.nodes) {
			assert(Array.isArray(n.inject) && Array.isArray(n.emits), `node ${n.id}: inject/emits arrays`);
			assert(n.emits.length === 1 && n.emits[0] === n.id, `node ${n.id}: emits===[id]`);
		}

		// Declared deps present for every phase.
		assert(Object.keys(ir.meta.declaredDeps).length === def.phases.length, "declaredDeps for every phase");

		// usedFallbackHash is true in the stub.
		assert(ir.usedFallbackHash === true, "usedFallbackHash=true (stub)");

		if (ir.warnings.length) console.log(C.dim(`    warnings: ${ir.warnings.map((w) => w.message).join("; ")}`));
		console.log();
	}

	// Deliberately-broken flow: a {steps.ghost} ref to a non-existent phase.
	console.log(C.hl("▸ broken-flow (deliberate)"));
	const broken: Taskflow = {
		name: "broken",
		phases: [{ id: "a", type: "agent", task: "read {steps.ghost.output}", final: true }],
	} as Taskflow;
	const irB = await compileTaskflowToIR(broken);
	assert(irB.warnings.some((w) => w.message.includes("ghost")), "advisory warning for missing step ref");
	assert(!!irB.hash, "broken flow still produces a hash (non-fatal)");
	assert(irB.errors.length === 0, "stub emits no hard errors");
	console.log();

	if (failures === 0) {
		console.log(C.ok(C.bold("All FlowIR E2E checks passed.")));
	} else {
		console.log(C.bad(C.bold(`${failures} FlowIR E2E check(s) FAILED.`)));
		process.exit(1);
	}
}

main().catch((e) => {
	console.error(C.bad(`E2E crashed: ${e instanceof Error ? e.stack : String(e)}`));
	process.exit(1);
});
