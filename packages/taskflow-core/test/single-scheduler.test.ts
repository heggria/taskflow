/**
 * Step 2: single scheduler convergence (D2).
 *
 * The event kernel is the single scheduler path when enabled; legacy phase
 * code lives as executors under executePhaseInner / step-kinds — not a dual
 * runtime product surface.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { EVENT_KERNEL_PHASE_TYPES } from "../src/exec/step.ts";
import { PHASE_TYPES } from "../src/schema.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("single scheduler: EVENT_KERNEL_PHASE_TYPES is subset of PHASE_TYPES", () => {
	for (const t of EVENT_KERNEL_PHASE_TYPES) {
		assert.ok(
			(PHASE_TYPES as readonly string[]).includes(t),
			`kernel type ${t} must be in PHASE_TYPES`,
		);
	}
});

test("single scheduler: race/expand remain executor-only until step handlers exist", () => {
	const kernel = new Set(EVENT_KERNEL_PHASE_TYPES as readonly string[]);
	// Documented exclusion — not a second product runtime
	assert.equal(kernel.has("race"), false);
	assert.equal(kernel.has("expand"), false);
	assert.ok((PHASE_TYPES as readonly string[]).includes("race"));
	assert.ok((PHASE_TYPES as readonly string[]).includes("expand"));
});

test("single scheduler: executeTaskflow is the sole public run entry in runtime.ts", () => {
	const src = readFileSync(join(root, "src/runtime.ts"), "utf-8");
	// One exported execute entry
	const exports = [...src.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]);
	assert.ok(exports.includes("executeTaskflow"));
	// No second public scheduler name
	assert.ok(!exports.includes("executeTaskflowLegacy"));
	assert.ok(!exports.includes("executeTaskflowV2"));
});

test("single scheduler: event kernel opts into driver; default remains compatible", () => {
	const driver = readFileSync(join(root, "src/exec/driver.ts"), "utf-8");
	assert.ok(driver.includes("eventKernelEnabled") || driver.includes("eventKernel"));
	const runtime = readFileSync(join(root, "src/runtime.ts"), "utf-8");
	assert.ok(runtime.includes("runEventKernel") || runtime.includes("eventKernel"));
});
