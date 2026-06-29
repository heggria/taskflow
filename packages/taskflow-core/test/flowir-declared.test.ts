import assert from "node:assert/strict";
import { test } from "node:test";
import { compileTaskflowToIR } from "../src/flowir/index.ts";
import type { Phase, Taskflow } from "../src/schema.ts";

// ---------------------------------------------------------------------------
// DeclaredDeps synthesis: one fixture per phase type (9 total).
// Verifies that `collectRefs`-derived `reads` and `[id]` `writes` are correct
// for every phase kind, and that the structural-equivalence canary holds
// (declared reads ⊆ transitive ancestors for valid fixtures).
// ---------------------------------------------------------------------------

function flow(phases: Phase[], name = "declared-test"): Taskflow {
	return { name, phases } as Taskflow;
}

test("DeclaredDeps: agent phase — reads {steps.X}, writes [self]", async () => {
	const f = flow([
		{ id: "scout", type: "agent", task: "scan" } as Phase,
		{ id: "audit", type: "agent", task: "audit {steps.scout.output}", dependsOn: ["scout"], final: true } as Phase,
	]);
	const ir = await compileTaskflowToIR(f);
	assert.deepEqual(ir.meta.declaredDeps.scout, { reads: [], writes: ["scout"] });
	assert.deepEqual(ir.meta.declaredDeps.audit, { reads: ["scout"], writes: ["audit"] });
});

test("DeclaredDeps: parallel — each branch's task refs are aggregated to the phase", async () => {
	const f = flow([
		{ id: "scout", type: "agent", task: "scan" } as Phase,
		{
			id: "fan",
			type: "parallel",
			branches: [{ task: "b1 {steps.scout.output}" }, { task: "b2 {steps.scout.output}" }],
			dependsOn: ["scout"],
			final: true,
		} as Phase,
	]);
	const ir = await compileTaskflowToIR(f);
	// collectRefs scans every branch task → scout appears once (Set semantics).
	assert.deepEqual(ir.meta.declaredDeps.fan.reads, ["scout"]);
	assert.deepEqual(ir.meta.declaredDeps.fan.writes, ["fan"]);
});

test("DeclaredDeps: map — over + task refs captured", async () => {
	const f = flow([
		{ id: "scout", type: "agent", task: "scan", output: "json" } as Phase,
		{ id: "each", type: "map", over: "{steps.scout.output}", task: "do {item}", dependsOn: ["scout"], final: true } as Phase,
	]);
	const ir = await compileTaskflowToIR(f);
	assert.deepEqual(ir.meta.declaredDeps.each.reads, ["scout"]);
	// {item} is not a steps ref → not in reads.
	assert.ok(!ir.meta.declaredDeps.each.reads.includes("item"));
});

test("DeclaredDeps: gate — task + eval refs captured", async () => {
	const f = flow([
		{ id: "scout", type: "agent", task: "scan" } as Phase,
		{ id: "g", type: "gate", task: "judge {steps.scout.output}", eval: ["{steps.scout.output} contains PASS"], dependsOn: ["scout"], final: true } as Phase,
	]);
	const ir = await compileTaskflowToIR(f);
	assert.deepEqual(ir.meta.declaredDeps.g.reads, ["scout"]);
});

test("DeclaredDeps: reduce — from + task refs captured", async () => {
	const f = flow([
		{ id: "a", type: "agent", task: "ta" } as Phase,
		{ id: "b", type: "agent", task: "tb" } as Phase,
		{ id: "r", type: "reduce", from: ["a", "b"], task: "sum {steps.a.output} {steps.b.output}", final: true } as Phase,
	]);
	const ir = await compileTaskflowToIR(f);
	assert.deepEqual([...ir.meta.declaredDeps.r.reads].sort(), ["a", "b"]);
});

test("DeclaredDeps: approval — task ref captured", async () => {
	const f = flow([
		{ id: "scout", type: "agent", task: "scan" } as Phase,
		{ id: "ap", type: "approval", task: "approve {steps.scout.output}", dependsOn: ["scout"], final: true } as Phase,
	]);
	const ir = await compileTaskflowToIR(f);
	assert.deepEqual(ir.meta.declaredDeps.ap.reads, ["scout"]);
});

test("DeclaredDeps: flow — task/use/with refs captured (def string refs too)", async () => {
	const f = flow([
		{ id: "scout", type: "agent", task: "scan", output: "json" } as Phase,
		{ id: "sub", type: "flow", use: "child", with: { plan: "{steps.scout.output}" }, dependsOn: ["scout"], final: true } as Phase,
	]);
	const ir = await compileTaskflowToIR(f);
	assert.deepEqual(ir.meta.declaredDeps.sub.reads, ["scout"]);
});

test("DeclaredDeps: loop — task + until refs captured (self-ref excluded)", async () => {
	const f = flow([
		{ id: "scout", type: "agent", task: "scan" } as Phase,
		{
			id: "refine",
			type: "loop",
			maxIterations: 3,
			until: "{steps.refine.output} == done",
			task: "refine {steps.scout.output}",
			dependsOn: ["scout"],
			final: true,
		} as Phase,
	]);
	const ir = await compileTaskflowToIR(f);
	// scout is a read; the self-ref ({steps.refine.output} in until) is excluded.
	assert.deepEqual(ir.meta.declaredDeps.refine.reads, ["scout"]);
});

test("DeclaredDeps: tournament — task + judge refs captured", async () => {
	const f = flow([
		{ id: "scout", type: "agent", task: "scan" } as Phase,
		{
			id: "pick",
			type: "tournament",
			variants: 2,
			mode: "best",
			judge: "Pick the variant that mentions {steps.scout.output}",
			task: "answer about {steps.scout.output}",
			dependsOn: ["scout"],
			final: true,
		} as Phase,
	]);
	const ir = await compileTaskflowToIR(f);
	assert.deepEqual(ir.meta.declaredDeps.pick.reads, ["scout"]);
});

test("DeclaredDeps: writes === [phase.id] for every kind", async () => {
	const f = flow([
		{ id: "a", type: "agent", task: "ta" } as Phase,
		{ id: "b", type: "parallel", branches: [{ task: "tb" }] } as Phase,
		{ id: "c", type: "map", over: "{steps.a.output}", task: "tc", dependsOn: ["a"] } as Phase,
		{ id: "d", type: "gate", task: "td", dependsOn: ["c"] } as Phase,
		{ id: "e", type: "reduce", from: ["b"], task: "te" } as Phase,
		{ id: "f", type: "approval", task: "tf" } as Phase,
		{ id: "g", type: "flow", use: "x" } as Phase,
		{ id: "h", type: "loop", maxIterations: 2, until: "{steps.h.output}==x", task: "th" } as Phase,
		{ id: "i", type: "tournament", variants: 2, mode: "best", task: "ti", final: true } as Phase,
	]);
	const ir = await compileTaskflowToIR(f);
	for (const p of f.phases) {
		assert.deepEqual(ir.meta.declaredDeps[p.id].writes, [p.id], `${p.id} writes === [self]`);
	}
});

// ---------------------------------------------------------------------------
// Structural-equivalence canary: for a valid fixture, declared reads are a
// SUBSET of transitive ancestors (via dependsOn ∪ from). A declared read
// outside the ancestor set is the authoring mistake validateTaskflow already
// flags — this canary ensures collectRefs and the ancestor walk agree.
// ---------------------------------------------------------------------------

test("DeclaredDeps (canary): declared reads ⊆ transitive ancestors for a valid chain", async () => {
	const f = flow([
		{ id: "a", type: "agent", task: "ta" } as Phase,
		{ id: "b", type: "agent", task: "tb {steps.a.output}", dependsOn: ["a"] } as Phase,
		{ id: "c", type: "agent", task: "tc {steps.a.output} {steps.b.output}", dependsOn: ["b"], final: true } as Phase,
	]);
	const ir = await compileTaskflowToIR(f);
	// c transitively reaches a (via b) and b.
	const anc = new Set(["a", "b"]);
	for (const r of ir.meta.declaredDeps.c.reads) {
		assert.ok(anc.has(r), `c declares read ${r} not in transitive ancestors`);
	}
});

test("DeclaredDeps: a {steps.X} ref to a non-existent phase is an advisory warning", async () => {
	const f = flow([{ id: "a", type: "agent", task: "read {steps.ghost.output}", final: true } as Phase]);
	const ir = await compileTaskflowToIR(f);
	assert.ok(ir.warnings.some((w) => w.phaseId === "a" && w.message.includes("ghost")));
	// The ghost ref is still recorded in declaredDeps (it's what the author wrote).
	assert.deepEqual(ir.meta.declaredDeps.a.reads, ["ghost"]);
});

test("DeclaredDeps: loop `until` refs are captured in the declared plane", async () => {
	const f = flow([
		{ id: "scout", type: "agent", task: "scan" } as Phase,
		{
			id: "refine",
			type: "loop",
			task: "refine",
			maxIterations: 3,
			until: "{steps.scout.output} == done",
			dependsOn: ["scout"],
			final: true,
		} as Phase,
	]);
	const ir = await compileTaskflowToIR(f);
	// The `until` condition depends on scout — it must appear in declared reads,
	// otherwise a /tf recompute seeded on scout would miss the loop phase.
	assert.deepEqual(ir.meta.declaredDeps.refine.reads, ["scout"]);
});

test("DeclaredDeps: gate `eval` refs are captured in the declared plane", async () => {
	const f = flow([
		{ id: "build", type: "agent", task: "build" } as Phase,
		{
			id: "quality",
			type: "gate",
			eval: ["{steps.build.output} contains SUCCESS"],
			task: "review {steps.build.output}",
			dependsOn: ["build"],
			final: true,
		} as Phase,
	]);
	const ir = await compileTaskflowToIR(f);
	assert.deepEqual(ir.meta.declaredDeps.quality.reads, ["build"]);
});
