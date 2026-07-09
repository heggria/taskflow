import assert from "node:assert/strict";
import { test } from "node:test";
import { compileTaskflowToIR, compileTaskflowToFlowIR, hashFlowIR } from "../src/flowir/index.ts";
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
// compileTaskflowToIR — S0 genuine compiler (IR content hash, not flowDefHash)
// ---------------------------------------------------------------------------

test("compileTaskflowToIR: deterministic across key reordering / whitespace", async () => {
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

test("compileTaskflowToIR: hash is IR content-addressed (ir:<64-hex>), not flowDefHash", async () => {
	const f = flow([agent("a", undefined, { final: true })]);
	const ir = await compileTaskflowToIR(f);
	assert.match(ir.hash!, /^ir:[0-9a-f]{64}$/);
	const c = compileTaskflowToFlowIR(f);
	assert.equal(ir.hash, hashFlowIR(c.canonical));
});

test("compileTaskflowToIR: single-field mutation changes the hash", async () => {
	const base = flow([agent("a", undefined, { final: true })]);
	const h0 = await compileTaskflowToIR(base);

	const changedTask = flow([agent("a", undefined, { final: true, task: "DIFFERENT" })]);
	assert.notEqual((await compileTaskflowToIR(changedTask)).hash, h0.hash);

	const added = flow([agent("a"), agent("b", ["a"], { final: true })]);
	assert.notEqual((await compileTaskflowToIR(added)).hash, h0.hash);

	const renamed = flow([{ id: "a-renamed", type: "agent", task: "task for a", final: true } as Phase]);
	assert.notEqual((await compileTaskflowToIR(renamed)).hash, h0.hash);
});

test("compileTaskflowToIR: hash changes for non-agent runtime payload fields", async () => {
	const cases: Array<[string, Taskflow, Taskflow]> = [
		[
			"parallel branch task",
			flow([{ id: "p", type: "parallel", branches: [{ agent: "a", task: "alpha" }], final: true } as Phase]),
			flow([{ id: "p", type: "parallel", branches: [{ agent: "a", task: "beta" }], final: true } as Phase]),
		],
		[
			"script run",
			flow([{ id: "s", type: "script", run: ["echo", "alpha"], final: true } as Phase]),
			flow([{ id: "s", type: "script", run: ["echo", "beta"], final: true } as Phase]),
		],
		[
			"map source",
			flow([{ id: "m", type: "map", over: "{steps.a.json}", task: "{item}", final: true } as Phase]),
			flow([{ id: "m", type: "map", over: "{steps.b.json}", task: "{item}", final: true } as Phase]),
		],
		[
			"flow definition",
			flow([{ id: "f", type: "flow", def: { name: "child", phases: [{ id: "a", task: "alpha" }] }, final: true } as Phase]),
			flow([{ id: "f", type: "flow", def: { name: "child", phases: [{ id: "a", task: "beta" }] }, final: true } as Phase]),
		],
		[
			"race cancelLosers",
			flow([{ id: "r", type: "race", branches: [{ task: "a" }, { task: "b" }], cancelLosers: true, final: true } as Phase]),
			flow([{ id: "r", type: "race", branches: [{ task: "a" }, { task: "b" }], cancelLosers: false, final: true } as Phase]),
		],
		[
			"expand maxNodes",
			flow([{ id: "e", type: "expand", def: { phases: [{ id: "a", task: "x" }] }, maxNodes: 5, final: true } as Phase]),
			flow([{ id: "e", type: "expand", def: { phases: [{ id: "a", task: "x" }] }, maxNodes: 6, final: true } as Phase]),
		],
	];

	for (const [label, a, b] of cases) {
		assert.notEqual((await compileTaskflowToIR(a)).hash, (await compileTaskflowToIR(b)).hash, label);
	}
});

test("compileTaskflowToIR: structured diagnostics, never throws", async () => {
	const f = flow([
		{ id: "a", type: "agent", task: "read {steps.ghost.output}", final: true } as Phase,
	]);
	const ir = await compileTaskflowToIR(f);
	assert.ok(ir.warnings.length >= 1, "missing-step ref → advisory warning");
	assert.ok(ir.warnings.some((w) => w.message.includes("ghost")));
	assert.equal(ir.errors.length, 0);
});

test("compileTaskflowToIR: advisory non-fatality — errors-bearing flow still hashes", async () => {
	const f = flow([{ id: "a", type: "agent", task: "read {steps.ghost.output}", final: true } as Phase]);
	const ir = await compileTaskflowToIR(f);
	assert.ok(ir.hash, "a flow with warnings still produces a content hash");
	assert.match(ir.hash!, /^ir:[0-9a-f]{64}$/);
});

test("compileTaskflowToIR: usedFallbackHash false for well-formed flows (S0 genuine compiler)", async () => {
	const plain = flow([agent("a", undefined, { final: true })]);
	const ir = await compileTaskflowToIR(plain);
	assert.equal(ir.usedFallbackHash, false);

	// `when` no longer forces fallback — cond is normalized into the IR hash.
	const withWhen = flow([agent("a", undefined, { final: true, when: "true" })]);
	const ir2 = await compileTaskflowToIR(withWhen);
	assert.equal(ir2.usedFallbackHash, false);
});

test("compileTaskflowToIR: equivalent when spellings share hash (cond normalization)", async () => {
	const a = flow([agent("g", undefined, { final: true, when: "{steps.x.output} == ok", type: "gate" as const })]);
	// need a prior phase for ref
	const f1 = flow([
		agent("x"),
		{ id: "g", type: "gate", task: "check", when: "{steps.x.output} == ok", dependsOn: ["x"], final: true } as Phase,
	]);
	const f2 = flow([
		agent("x"),
		{ id: "g", type: "gate", task: "check", when: "(({steps.x.output}==ok))", dependsOn: ["x"], final: true } as Phase,
	]);
	assert.equal((await compileTaskflowToIR(f1)).hash, (await compileTaskflowToIR(f2)).hash);
	void a;
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

test("compileTaskflowToIR: reduce.from contributes declared reads and edges", async () => {
	const f = flow([
		agent("a"),
		agent("b"),
		{ id: "r", type: "reduce", from: ["a", "b"], task: "summarize", final: true } as Phase,
	]);
	const ir = await compileTaskflowToIR(f);
	const r = ir.ir!.nodes.find((n) => n.id === "r")!;
	assert.deepEqual(r.inject, ["a", "b"]);
	assert.deepEqual(ir.meta.declaredDeps.r, { reads: ["a", "b"], writes: ["r"] });
	const c = compileTaskflowToFlowIR(f);
	assert.ok(c.canonical.edges?.some((e) => e.from === "a" && e.to === "r"));
	assert.ok(c.canonical.edges?.some((e) => e.from === "b" && e.to === "r"));
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

test("compileTaskflowToFlowIR: emits edges + condRef for when", () => {
	const f = flow([
		agent("x"),
		{ id: "g", type: "gate", task: "j", when: "  true  ", dependsOn: ["x"], final: true } as Phase,
	]);
	const c = compileTaskflowToFlowIR(f);
	assert.ok(c.canonical.edges && c.canonical.edges.length >= 1);
	const g = c.canonical.nodes.find((n) => n.id === "g")!;
	assert.equal(g.condRef, "true");
	assert.equal(g.when, "  true  ");
	assert.equal(c.usedFallbackHash, false);
});

test("compileTaskflowToIR: two genuinely identical definitions match", async () => {
	const mk = () => flow([agent("a"), agent("b", ["a"], { final: true })]);
	assert.equal((await compileTaskflowToIR(mk())).hash, (await compileTaskflowToIR(mk())).hash);
});

test("compileTaskflowToIR: two structurally-different flows sharing a name do NOT collide", async () => {
	const a = flow([agent("scan", undefined, { final: true })], { name: "audit" });
	const b = flow(
		[agent("scan", undefined, { final: true }), agent("report", ["scan"], { final: false })],
		{ name: "audit" },
	);
	assert.notEqual((await compileTaskflowToIR(a)).hash, (await compileTaskflowToIR(b)).hash);
});

test("formatFlowIR surface: stable hash + inject/emits + declared deps", async () => {
	const f = flow([
		agent("scout"),
		{ id: "audit", type: "agent", task: "audit {steps.scout.output}", dependsOn: ["scout"], final: true } as Phase,
	]);
	const ir = await compileTaskflowToIR(f);
	assert.ok(ir.hash && /^ir:[0-9a-f]{64}$/.test(ir.hash));
	assert.ok(ir.ir && ir.ir.nodes.length === 2);
	assert.ok(ir.meta.declaredDeps.audit);
	assert.equal(ir.meta.sourceFlowName, "test-flow");
	assert.equal(Array.isArray(ir.warnings), true);
	assert.equal(Array.isArray(ir.errors), true);
	assert.equal(typeof ir.usedFallbackHash, "boolean");
	assert.equal(ir.usedFallbackHash, false);
});
