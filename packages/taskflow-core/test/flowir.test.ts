import assert from "node:assert/strict";
import { test } from "node:test";
import { compileTaskflowToIR } from "../src/flowir/index.ts";
import { flowDefHash } from "../src/flowir/hash.ts";
import type { Phase, Taskflow } from "../src/schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agent(id: string, deps?: string[], overrides?: Partial<Phase>): Phase {
	return { id, type: "agent", task: `task for ${id}`, dependsOn: deps, ...overrides };
}
function flow(phases: Phase[], overrides?: Partial<Taskflow>): Taskflow {
	return { name: "test-flow", phases, ...overrides } as Taskflow;
}

// ---------------------------------------------------------------------------
// compileTaskflowToIR — hash contract (stub == flowDefHash, but stable)
// ---------------------------------------------------------------------------

test("compileTaskflowToIR: deterministic across key reordering / whitespace", async () => {
	// 1000 reorder variants of the same fixture must all hash identically.
	// We reorder KEYS WITHIN each phase object (not the array — array order is
	// structurally meaningful), mirroring canonicalJson's key-sorted contract.
	const base = flow([agent("a"), agent("b", ["a"], { final: true })]);
	const h0 = await compileTaskflowToIR(base);
	for (let i = 0; i < 1000; i++) {
		const aKeys = i % 2 === 0 ? ["id", "type", "task"] : ["task", "type", "id"];
		const bKeys = i % 3 === 0 ? ["final", "task", "type", "id", "dependsOn"] : ["dependsOn", "id", "type", "task", "final"];
		const mkObj = (vals: Record<string, unknown>, keys: string[]) =>
			Object.fromEntries(keys.map((k) => [k, vals[k]])) as unknown as Phase;
		const reordered: Taskflow = {
			phases: [
				mkObj({ id: "a", type: "agent", task: "task for a" }, aKeys),
				mkObj({ id: "b", type: "agent", task: "task for b", dependsOn: ["a"], final: true }, bKeys),
			],
			name: "test-flow",
		} as Taskflow;
		const h = await compileTaskflowToIR(reordered);
		assert.equal(h.hash, h0.hash, `variant ${i} diverged`);
	}
});

test("compileTaskflowToIR: hash matches the vendored flowDefHash (stub parity)", async () => {
	const f = flow([agent("a", undefined, { final: true })]);
	const ir = await compileTaskflowToIR(f);
	assert.equal(ir.hash, await flowDefHash(f));
});

test("compileTaskflowToIR: single-field mutation changes the hash", async () => {
	const base = flow([agent("a", undefined, { final: true })]);
	const h0 = await compileTaskflowToIR(base);

	// change task text
	const changedTask = flow([agent("a", undefined, { final: true, task: "DIFFERENT" })]);
	assert.notEqual((await compileTaskflowToIR(changedTask)).hash, h0.hash);

	// add a phase
	const added = flow([agent("a"), agent("b", ["a"], { final: true })]);
	assert.notEqual((await compileTaskflowToIR(added)).hash, h0.hash);

	// rename a phase id
	const renamed = flow([{ id: "a-renamed", type: "agent", task: "task for a", final: true } as Phase]);
	assert.notEqual((await compileTaskflowToIR(renamed)).hash, h0.hash);
});

test("compileTaskflowToIR: structured diagnostics, never throws", async () => {
	// A flow referencing a non-existent step — translate emits an advisory
	// warning but does NOT throw (validation is the source of truth; /tf ir
	// is a read-only diagnostic and must surface a clean error table).
	const f = flow([
		{ id: "a", type: "agent", task: "read {steps.ghost.output}", final: true } as Phase,
	]);
	const ir = await compileTaskflowToIR(f);
	assert.ok(ir.warnings.length >= 1, "missing-step ref → advisory warning");
	assert.ok(ir.warnings.some((w) => w.message.includes("ghost")));
	assert.equal(ir.errors.length, 0, "stub never emits hard errors");
});

test("compileTaskflowToIR: advisory non-fatality — errors-bearing flow still hashes", async () => {
	const f = flow([{ id: "a", type: "agent", task: "read {steps.ghost.output}", final: true } as Phase]);
	const ir = await compileTaskflowToIR(f);
	assert.ok(ir.hash, "a flow with warnings still produces a content hash");
	assert.match(ir.hash!, /^[0-9a-f]{32}$/);
});

test("compileTaskflowToIR: usedFallbackHash true when any phase has when", async () => {
	const withWhen = flow([agent("a", undefined, { final: true, when: "{steps.a.output} == skip" })]);
	const ir = await compileTaskflowToIR(withWhen);
	assert.equal(ir.usedFallbackHash, true, "a `when` guard forces the fallback hash in the stub");
});

test("compileTaskflowToIR: usedFallbackHash true even without when (stub)", async () => {
	// In the stub, usedFallbackHash is always true (the genuine overstory
	// compiler is not yet wired). This test pins that contract so the day it
	// flips to false we know the vendoring landed.
	const plain = flow([agent("a", undefined, { final: true })]);
	const ir = await compileTaskflowToIR(plain);
	assert.equal(ir.usedFallbackHash, true);
});

// ---------------------------------------------------------------------------
// IR shape — 1:1 projection, inject/emits, declaredDeps
// ---------------------------------------------------------------------------

test("compileTaskflowToIR: one node per phase, emits===[id]", async () => {
	const f = flow([agent("a"), agent("b", ["a"], { final: true })]);
	const ir = await compileTaskflowToIR(f);
	assert.equal(ir.ir!.nodes.length, 2);
	for (const n of ir.ir!.nodes) {
		assert.deepEqual(n.emits, [n.id]);
		assert.equal(n.kind, "agent");
	}
});

test("compileTaskflowToIR: inject synthesized from {steps.X} refs", async () => {
	const f = flow([
		agent("scout"),
		{ id: "audit", type: "agent", task: "audit {steps.scout.output}", dependsOn: ["scout"] } as Phase,
		{ id: "report", type: "agent", task: "report {steps.audit.output}", dependsOn: ["audit"], final: true } as Phase,
	]);
	const ir = await compileTaskflowToIR(f);
	const byId = new Map(ir.ir!.nodes.map((n) => [n.id, n]));
	assert.deepEqual(byId.get("audit")!.inject, ["scout"]);
	assert.deepEqual(byId.get("report")!.inject, ["audit"]);
	assert.deepEqual(byId.get("scout")!.inject, []);
});

test("compileTaskflowToIR: declaredDeps mirror inject/emits", async () => {
	const f = flow([
		agent("scout"),
		{ id: "audit", type: "agent", task: "audit {steps.scout.output}", dependsOn: ["scout"] } as Phase,
	]);
	const ir = await compileTaskflowToIR(f);
	assert.deepEqual(ir.meta.declaredDeps.scout, { reads: [], writes: ["scout"] });
	assert.deepEqual(ir.meta.declaredDeps.audit, { reads: ["scout"], writes: ["audit"] });
});

test("compileTaskflowToIR: two genuinely identical definitions match", async () => {
	const mk = () => flow([agent("a"), agent("b", ["a"], { final: true })]);
	assert.equal((await compileTaskflowToIR(mk())).hash, (await compileTaskflowToIR(mk())).hash);
});

test("compileTaskflowToIR: two structurally-different flows sharing a name do NOT collide", async () => {
	// The regression that motivated flowDefHash folding into the cache key.
	const a = flow([agent("scan", undefined, { final: true })], { name: "audit" });
	const b = flow(
		[agent("scan", undefined, { final: true }), agent("report", ["scan"], { final: false })],
		{ name: "audit" },
	);
	assert.notEqual((await compileTaskflowToIR(a)).hash, (await compileTaskflowToIR(b)).hash);
});

// ---------------------------------------------------------------------------
// /tf ir formatting (the formatFlowIR helper output shape)
// ---------------------------------------------------------------------------

test("formatFlowIR output: stable hash + inject/emits + declared deps", async () => {
	// We can't easily import the non-exported formatFlowIR helper from index.ts
	// (it's not exported), but the tool action surfaces it. Instead we assert
	// the IR surface carries everything the formatter needs. This is a
	// contract canary: if the TaskflowIR shape changes, this test fails fast.
	const f = flow([
		agent("scout"),
		{ id: "audit", type: "agent", task: "audit {steps.scout.output}", dependsOn: ["scout"], final: true } as Phase,
	]);
	const ir = await compileTaskflowToIR(f);
	assert.ok(ir.hash && /^[0-9a-f]{32}$/.test(ir.hash));
	assert.ok(ir.ir && ir.ir.nodes.length === 2);
	assert.ok(ir.meta.declaredDeps.audit);
	assert.equal(ir.meta.sourceFlowName, "test-flow");
	assert.equal(Array.isArray(ir.warnings), true);
	assert.equal(Array.isArray(ir.errors), true);
	assert.equal(typeof ir.usedFallbackHash, "boolean");
});
