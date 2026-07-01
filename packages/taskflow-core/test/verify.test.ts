import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyTaskflow, type VerifiableFlow } from "../src/verify.ts";
import type { Phase } from "../src/schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agent(id: string, deps?: string[], overrides?: Partial<Phase>): Phase {
	return { id, type: "agent", task: "task for " + id, dependsOn: deps, ...overrides };
}
function gate(id: string, deps?: string[], overrides?: Partial<Phase>): Phase {
	return { id, type: "gate", task: "gate " + id, dependsOn: deps, ...overrides };
}
function vf(phases: Phase[], opts?: { budget?: { maxTokens?: number; maxUSD?: number } }): VerifiableFlow {
	return { name: "test", phases, ...opts };
}

// ---------------------------------------------------------------------------
// Dead-end detection
// ---------------------------------------------------------------------------

test("verify: dead-end — terminal phase without 'final'", () => {
	const flow = vf([agent("a"), agent("b"), agent("c", ["b"])]);
	const r = verifyTaskflow(flow);
	assert.equal(r.ok, true, "warnings only");
	const dead = r.issues.filter((i) => i.category === "dead-end");
	assert.equal(dead.length, 1, "only 'a' is dead-end; 'c' is implicitly final as last phase");
	assert.equal(dead[0].phaseId, "a");
});

test("verify: dead-end — last phase is implicitly final", () => {
	const flow = vf([agent("a"), agent("b", ["a"])]);
	const r = verifyTaskflow(flow);
	const dead = r.issues.filter((i) => i.category === "dead-end");
	assert.equal(dead.length, 0, "last phase without 'final' flag is ok when no other final exists");
});

test("verify: dead-end — explicit final suppresses warning", () => {
	const flow = vf([agent("a", undefined, { final: true }), agent("b", ["a"])]);
	const r = verifyTaskflow(flow);
	const dead = r.issues.filter((i) => i.category === "dead-end");
	assert.equal(dead.length, 1, "b is terminal but not final");
	assert.equal(dead[0].phaseId, "b");
});

test("verify: reduce `from` counts as a real edge — upstream isn't terminal", () => {
	// `sum` depends on `scan` only via reduce `from` (not dependsOn). Graph helpers
	// must treat `from` as an edge (dependenciesOf = dependsOn ∪ from), or `scan`
	// is falsely flagged as a terminal dead-end.
	const flow = vf([
		agent("scan"),
		{ id: "sum", type: "reduce", from: ["scan"], task: "summarize", final: true } as Phase,
	]);
	const r = verifyTaskflow(flow);
	const dead = r.issues.filter((i) => i.category === "dead-end");
	assert.equal(dead.length, 0, "scan feeds the reduce, so it is not a dead-end");
	const unreachable = r.issues.filter((i) => i.category === "unreachable");
	assert.equal(unreachable.length, 0, "sum is reachable via its `from` edge");
});

test("verify: reduce `from` keeps upstream connected in a 3-phase chain", () => {
	// scan -> reduce(from) -> ship. The connectivity walk (detectUnreachable) must
	// also follow `from`, or `scan` is reported unreachable/disconnected even
	// though it feeds the reduce that feeds the final phase.
	const flow = vf([
		agent("scan"),
		{ id: "sum", type: "reduce", from: ["scan"], task: "summarize" } as Phase,
		agent("ship", ["sum"], { final: true }),
	]);
	const r = verifyTaskflow(flow);
	const unreachable = r.issues.filter((i) => i.category === "unreachable");
	assert.equal(unreachable.length, 0, "scan is connected via its reduce `from` edge");
	const dead = r.issues.filter((i) => i.category === "dead-end");
	assert.equal(dead.length, 0, "no dead-ends: scan->sum->ship all feed forward");
});

test("verify: tolerates null / non-object phase elements without throwing", () => {
	// A malformed phase list (validateTaskflow reports it) must degrade gracefully
	// — every detector, incl. the flow-taking ones (concurrency/budget), sees the
	// sanitized phase list, not raw nulls.
	assert.doesNotThrow(() => verifyTaskflow(vf([null as unknown as Phase])));
	assert.doesNotThrow(() => verifyTaskflow(vf(["nope" as unknown as Phase, agent("a", undefined, { final: true })])));
});

test("verify: non-string `when` doesn't crash guard-contradiction analysis", () => {
	// detectGuardContradictions calls .match()/.includes() on `when`; a non-string
	// value (validateTaskflow reports it) must be skipped, not throw.
	const flow = vf([
		agent("src"),
		{ ...agent("a", ["src"]), when: 1 } as unknown as Phase,
		{ ...agent("b", ["src"]), when: 2 } as unknown as Phase,
	]);
	assert.doesNotThrow(() => verifyTaskflow(flow));
});

// ---------------------------------------------------------------------------
// Unreachable detection
// ---------------------------------------------------------------------------

test("verify: unreachable — disconnected phase", () => {
	const flow = vf([agent("a"), agent("b", ["a"]), agent("orphan")]);
	const r = verifyTaskflow(flow);
	// orphan has zero edges — it's a standalone valid entry, not unreachable.
	// It IS a dead-end (terminal, not final, not last) → warning only, r.ok = true.
	assert.equal(r.ok, true, "standalone entry is valid; dead-end is a warning");
	const unr = r.issues.filter((i) => i.category === "unreachable");
	assert.equal(unr.length, 0, "standalone with no edges is not unreachable");
	const dead = r.issues.filter((i) => i.category === "dead-end");
	// "b" (terminal, not final, not last) is flagged; orphan is last phase (implicitly final)
	assert.equal(dead.length, 1, "b is the dead-end");
	assert.equal(dead[0].phaseId, "b");
});

test("verify: unreachable — fully connected chain", () => {
	const flow = vf([agent("a"), agent("b", ["a"]), agent("c", ["b"])]);
	const r = verifyTaskflow(flow);
	const unr = r.issues.filter((i) => i.category === "unreachable");
	assert.equal(unr.length, 0);
});

// ---------------------------------------------------------------------------
// Gate exhaustion
// ---------------------------------------------------------------------------

test("verify: gate-exhaustion — gate is sole path to final", () => {
	const flow = vf([agent("a"), gate("g", ["a"]), agent("final", ["g"], { final: true })]);
	const r = verifyTaskflow(flow);
	const exh = r.issues.filter((i) => i.category === "gate-exhaustion");
	assert.equal(exh.length, 1);
	assert.equal(exh[0].phaseId, "g");
});

test("verify: gate-exhaustion — alternative route exists", () => {
	const flow = vf([
		agent("a"),
		gate("g", ["a"]),
		agent("b", ["a"]),
		agent("final", ["g", "b"], { final: true }),
	]);
	const r = verifyTaskflow(flow);
	const exh = r.issues.filter((i) => i.category === "gate-exhaustion");
	assert.equal(exh.length, 0, "b provides a bypass route to final");
});

// ---------------------------------------------------------------------------
// Budget overflow
// ---------------------------------------------------------------------------

test("verify: budget-overflow — impossible budget", () => {
	const flow = vf([agent("a"), agent("b"), agent("c")], { budget: { maxTokens: 1 } });
	const r = verifyTaskflow(flow);
	const bd = r.issues.filter((i) => i.category === "budget-overflow");
	assert.equal(bd.length, 1);
});

test("verify: budget-overflow — ample budget", () => {
	const flow = vf([agent("a"), agent("b"), agent("c")], { budget: { maxTokens: 1000 } });
	const r = verifyTaskflow(flow);
	const bd = r.issues.filter((i) => i.category === "budget-overflow");
	assert.equal(bd.length, 0);
});

// ---------------------------------------------------------------------------
// Self-dependency
// ---------------------------------------------------------------------------

test("verify: ref-integrity — self-dependency", () => {
	const flow = vf([agent("a", ["a"])]);
	const r = verifyTaskflow(flow);
	const ri = r.issues.filter((i) => i.category === "ref-integrity");
	assert.equal(ri.length, 1);
	assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// Guard contradiction
// ---------------------------------------------------------------------------

test("verify: guard-contradiction — no contradiction", () => {
	const flow = vf([
		agent("a"),
		agent("b", ["a"], { when: "{steps.a.output} == high" }),
		agent("c", ["a"]),
	]);
	const r = verifyTaskflow(flow);
	const gc = r.issues.filter((i) => i.category === "guard-contradiction");
	assert.equal(gc.length, 0);
});

test("verify: guard-contradiction — suspicious opposites", () => {
	const flow = vf([
		agent("a"),
		agent("b", ["a"], { when: "{steps.a.output} == high" }),
		agent("c", ["a"], { when: "{steps.a.output} != high" }),
	]);
	const r = verifyTaskflow(flow);
	const gc = r.issues.filter((i) => i.category === "guard-contradiction");
	assert.equal(gc.length, 1);
});

// ---------------------------------------------------------------------------
// Full result shape
// ---------------------------------------------------------------------------

test("verify: ok=true when only warnings", () => {
	const flow = vf([agent("a"), agent("b"), agent("c")]);
	const r = verifyTaskflow(flow);
	assert.equal(r.ok, true);
	assert.ok(r.issues.length > 0, "has dead-end warnings");
	assert.ok(r.issues.every((i) => i.severity === "warning"));
});

test("verify: ok=false when any error exists", () => {
	const flow = vf([agent("a", ["a"])]); // self-dependency
	const r = verifyTaskflow(flow);
	assert.equal(r.ok, false);
	assert.ok(r.issues.some((i) => i.severity === "error"));
});

// ---------------------------------------------------------------------------
// Budget overflow — maxUSD (M-9)
// ---------------------------------------------------------------------------

test("verify: budget-overflow — impossible maxUSD", () => {
	// 3 phases × $0.001 minimum = $0.003, but budget is only $0.001
	const flow = vf([agent("a"), agent("b"), agent("c")], { budget: { maxUSD: 0.001 } });
	const r = verifyTaskflow(flow);
	const bd = r.issues.filter((i) => i.category === "budget-overflow");
	assert.ok(bd.length >= 1, "should detect maxUSD overflow");
	assert.ok(bd.some((i) => i.message.includes("maxUSD")), "should mention maxUSD");
});

test("verify: budget-overflow — ample maxUSD", () => {
	const flow = vf([agent("a"), agent("b")], { budget: { maxUSD: 1.0 } });
	const r = verifyTaskflow(flow);
	const bd = r.issues.filter((i) => i.category === "budget-overflow");
	assert.equal(bd.length, 0, "ample budget should not trigger overflow");
});

test("verify: budget-overflow — both maxTokens and maxUSD checked independently", () => {
	// maxTokens is fine, but maxUSD is too low
	const flow = vf([agent("a"), agent("b"), agent("c")], { budget: { maxTokens: 1000, maxUSD: 0.001 } });
	const r = verifyTaskflow(flow);
	const bd = r.issues.filter((i) => i.category === "budget-overflow");
	assert.ok(bd.some((i) => i.message.includes("maxUSD")), "should flag maxUSD");
	assert.ok(!bd.some((i) => i.message.includes("maxTokens")), "should not flag maxTokens");
});
