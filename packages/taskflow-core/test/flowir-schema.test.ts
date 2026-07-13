import assert from "node:assert/strict";
import { test } from "node:test";
import {
	FlowIRNodeKind,
	FlowIRNodeSchema,
	FlowIREdgeSchema,
	FlowIRSchema,
	isFlowIRNode,
	assertFlowIR,
} from "../src/flowir/schema.ts";
import { PHASE_TYPES } from "../src/schema.ts";
import { Value } from "typebox/value";
import type { FlowIR, FlowIRNode } from "../src/flowir/schema.ts";

// ---------------------------------------------------------------------------
// Helpers — build canonical FlowIR nodes / IRs
// ---------------------------------------------------------------------------

function node(
	id: string,
	kind: FlowIRNode["kind"] = "agent",
	overrides?: Partial<FlowIRNode>,
): FlowIRNode {
	return { id, kind, inject: [], emits: [id], ...overrides };
}

function ir(nodes: FlowIRNode[], overrides?: Partial<FlowIR>): FlowIR {
	return { name: "test-flow", nodes, ...overrides };
}

// ---------------------------------------------------------------------------
// FlowIRNodeKind — closed literal union (= PHASE_TYPES, currently 12 kinds)
// ---------------------------------------------------------------------------

test("FlowIRNodeKind: tracks PHASE_TYPES (single source of truth, no drift)", () => {
	assert.equal(PHASE_TYPES.length, 12);
	for (const k of PHASE_TYPES) {
		// Each DSL phase kind is a member of the FlowIR kind schema.
		const decoded = Value.Decode(FlowIRNodeKind, k);
		assert.equal(decoded, k);
	}
	// Same closed set — if someone adds a kind to only one side, this fails.
	assert.deepEqual([...PHASE_TYPES], [
		"agent",
		"parallel",
		"map",
		"gate",
		"reduce",
		"approval",
		"flow",
		"loop",
		"tournament",
		"script",
		"race",
		"expand",
	]);
});

test("FlowIRNodeKind: rejects an unknown phase kind", () => {
	// typebox's Value.Decode throws a generic 'Decode' error on validation
	// failure (no value detail in the message); we assert it throws at all,
	// and that Value.Check returns false for the unknown kind.
	assert.throws(() => Value.Decode(FlowIRNodeKind, "nope"));
	assert.equal(Value.Check(FlowIRNodeKind, "nope"), false);
});

// ---------------------------------------------------------------------------
// isFlowIRNode — structural narrowing (pure, fail-closed)
// ---------------------------------------------------------------------------

test("isFlowIRNode: accepts a minimal valid node", () => {
	const n = node("a");
	assert.equal(isFlowIRNode(n), true);
});

test("isFlowIRNode: accepts a node with all optional fields populated", () => {
	const n = node("a", "gate", {
		when: "steps.x.output == 'ok'",
		task: "review the output",
		condRef: "cond#a",
		deps: ["x"],
		join: "any",
		timeout: 5000,
	});
	assert.equal(isFlowIRNode(n), true);
});

test("isFlowIRNode: accepts every FlowIRNodeKind", () => {
	for (const k of [
		"agent", "parallel", "map", "gate", "reduce",
		"approval", "flow", "loop", "tournament", "script",
	] as const) {
		assert.equal(isFlowIRNode(node(k, k)), true, `kind=${k}`);
	}
});

test("isFlowIRNode: rejects a non-object", () => {
	assert.equal(isFlowIRNode(null), false);
	assert.equal(isFlowIRNode(undefined), false);
	assert.equal(isFlowIRNode("agent"), false);
	assert.equal(isFlowIRNode(42), false);
	assert.equal(isFlowIRNode([]), false);
});

test("isFlowIRNode: rejects an empty id", () => {
	assert.equal(isFlowIRNode({ ...node("a"), id: "" }), false);
});

test("isFlowIRNode: rejects an invalid kind", () => {
	assert.equal(isFlowIRNode({ ...node("a"), kind: "nope" }), false);
	assert.equal(isFlowIRNode({ ...node("a"), kind: 7 }), false);
});

test("isFlowIRNode: rejects non-array inject/emits", () => {
	assert.equal(isFlowIRNode({ ...node("a"), inject: "b" }), false);
	assert.equal(isFlowIRNode({ ...node("a"), emits: null }), false);
	assert.equal(isFlowIRNode({ ...node("a"), inject: [1, 2] }), false);
});

test("isFlowIRNode: rejects a malformed optional field", () => {
	assert.equal(isFlowIRNode({ ...node("a"), when: 9 }), false);
	assert.equal(isFlowIRNode({ ...node("a"), task: 9 }), false);
	assert.equal(isFlowIRNode({ ...node("a"), condRef: 9 }), false);
	assert.equal(isFlowIRNode({ ...node("a"), deps: "x" }), false);
	assert.equal(isFlowIRNode({ ...node("a"), join: "maybe" }), false);
	assert.equal(isFlowIRNode({ ...node("a"), timeout: "5s" }), false);
});

test("isFlowIRNode: acts as a type guard (narrows unknown)", () => {
	const v: unknown = node("a", "agent", { task: "go" });
	if (isFlowIRNode(v)) {
		// Inside the guard, `v` is narrowed to FlowIRNode.
		assert.equal(v.id, "a");
		assert.equal(v.kind, "agent");
		assert.equal(v.task, "go");
	} else {
		assert.fail("guard should have narrowed");
	}
});

// ---------------------------------------------------------------------------
// assertFlowIR — fail-closed validation of a full FlowIR
// ---------------------------------------------------------------------------

test("assertFlowIR: accepts a valid minimal IR", () => {
	const f = ir([node("a"), node("b", "agent", { inject: ["a"] })]);
	assertFlowIR(f); // does not throw
});

test("assertFlowIR: accepts an IR with edges, budget, concurrency, meta", () => {
	const f = ir(
		[node("a"), node("b", "agent", { inject: ["a"] })],
		{
			version: 1,
			edges: [{ from: "a", to: "b" }],
			budget: { maxUSD: 1.5, maxTokens: 10000 },
			concurrency: 4,
			meta: { source: "pi", irVersion: 1 },
			args: { topic: { default: "x" } },
		},
	);
	assertFlowIR(f);
});

test("assertFlowIR: accepts the stub shape translate.ts produces (superset compatibility)", () => {
	// Mirror the exact minimal shape translateTaskflow emits: name + nodes
	// (+ optional args/budget/concurrency), each node {id,kind,inject,emits,when?}.
	const stubLike: unknown = {
		name: "audit",
		nodes: [
			{ id: "scan", kind: "agent", inject: [], emits: ["scan"] },
			{ id: "report", kind: "agent", inject: ["scan"], emits: ["report"], when: "steps.scan.output != ''" },
		],
		args: undefined,
		budget: undefined,
		concurrency: undefined,
	};
	assertFlowIR(stubLike); // does not throw — superset of the stub output
});

test("assertFlowIR: rejects a non-object", () => {
	assert.throws(() => assertFlowIR(null), /expected an object/);
	assert.throws(() => assertFlowIR("x"), /expected an object/);
	assert.throws(() => assertFlowIR([]), /expected an object/);
});

test("assertFlowIR: rejects an empty or missing name", () => {
	assert.throws(() => assertFlowIR({ nodes: [node("a")] }), /name/);
	assert.throws(() => assertFlowIR({ name: "", nodes: [node("a")] }), /non-empty string/);
});

test("assertFlowIR: rejects an empty nodes array", () => {
	assert.throws(() => assertFlowIR({ name: "f", nodes: [] }), /non-empty array/);
	assert.throws(() => assertFlowIR({ name: "f" }), /non-empty array/);
});

test("assertFlowIR: rejects a malformed node in the list", () => {
	assert.throws(
		() => assertFlowIR({ name: "f", nodes: [{ id: "a", kind: "nope", inject: [], emits: ["a"] }] }),
		/not a valid FlowIRNode/,
	);
});

test("assertFlowIR: rejects a non-array nodes element", () => {
	assert.throws(
		() => assertFlowIR({ name: "f", nodes: [{ id: "a", kind: "agent", inject: "x", emits: ["a"] }] }),
		/not a valid FlowIRNode/,
	);
});

test("assertFlowIR: rejects duplicate node ids", () => {
	assert.throws(
		() => assertFlowIR({ name: "f", nodes: [node("a"), node("a")] }),
		/duplicate node id 'a'/,
	);
});

test("assertFlowIR: rejects edges referencing unknown nodes", () => {
	assert.throws(
		() => assertFlowIR({ name: "f", nodes: [node("a")], edges: [{ from: "a", to: "zzz" }] }),
		/unknown node 'zzz'/,
	);
	assert.throws(
		() => assertFlowIR({ name: "f", nodes: [node("a")], edges: [{ from: "zzz", to: "a" }] }),
		/unknown node 'zzz'/,
	);
});

test("assertFlowIR: rejects a malformed edge", () => {
	assert.throws(
		() => assertFlowIR({ name: "f", nodes: [node("a")], edges: [{ from: "a" }] }),
		/\{ from: string, to: string \}/,
	);
});

test("assertFlowIR: rejects a malformed budget", () => {
	assert.throws(
		() => assertFlowIR({ name: "f", nodes: [node("a")], budget: { maxUSD: "1" } }),
		/budget\.maxUSD/,
	);
	assert.throws(
		() => assertFlowIR({ name: "f", nodes: [node("a")], budget: 5 }),
		/budget/,
	);
});

test("assertFlowIR: rejects a malformed concurrency / args / meta", () => {
	assert.throws(() => assertFlowIR({ name: "f", nodes: [node("a")], concurrency: "4" }), /concurrency/);
	assert.throws(() => assertFlowIR({ name: "f", nodes: [node("a")], args: "x" }), /args/);
	assert.throws(() => assertFlowIR({ name: "f", nodes: [node("a")], meta: "x" }), /meta/);
});

test("assertFlowIR: narrows the type after assertion", () => {
	const v: unknown = ir([node("a")]);
	assertFlowIR(v);
	// `v` is now FlowIR — access fields freely.
	assert.equal(v.name, "test-flow");
	assert.equal(v.nodes.length, 1);
	assert.equal(v.nodes[0].id, "a");
});

// ---------------------------------------------------------------------------
// TypeBox schema decode — full structural validation (mirror of the guards)
// ---------------------------------------------------------------------------

test("FlowIRNodeSchema: decodes a valid node", () => {
	const n = node("a", "agent", { when: "true", timeout: 100 });
	const decoded = Value.Decode(FlowIRNodeSchema, n);
	assert.equal(decoded.id, "a");
	assert.equal(decoded.kind, "agent");
	assert.equal(decoded.timeout, 100);
});

test("FlowIRNodeSchema: rejects additional properties (Check is false)", () => {
	// typebox's Value.Decode silently ignores additional properties (it does
	// not throw), but Value.Check enforces `additionalProperties: false` and
	// returns false. (The lightweight isFlowIRNode guard intentionally does
	// NOT reject extra fields — it validates known fields only; use
	// Value.Check / assertFlowIR for full schema enforcement.)
	const n = { ...node("a"), bogus: 1 };
	assert.equal(Value.Check(FlowIRNodeSchema, n), false);
});

test("FlowIREdgeSchema: decodes a valid edge", () => {
	const e = Value.Decode(FlowIREdgeSchema, { from: "a", to: "b" });
	assert.equal(e.from, "a");
	assert.equal(e.to, "b");
});

test("FlowIRSchema: decodes a full valid IR", () => {
	const f = ir(
		[node("a"), node("b", "agent", { inject: ["a"], join: "any" })],
		{ version: 2, edges: [{ from: "a", to: "b" }], budget: { maxTokens: 5000 }, concurrency: 2 },
	);
	const decoded = Value.Decode(FlowIRSchema, f);
	assert.equal(decoded.name, "test-flow");
	assert.equal(decoded.version, 2);
	assert.equal(decoded.nodes.length, 2);
	assert.equal(decoded.edges?.length, 1);
});

test("FlowIRSchema: rejects a node with an invalid kind", () => {
	const f = { name: "f", nodes: [{ ...node("a"), kind: "wizard" }] };
	assert.throws(() => Value.Decode(FlowIRSchema, f));
	assert.equal(Value.Check(FlowIRSchema, f), false);
});

test("FlowIRSchema: rejects an empty name", () => {
	const f = { name: "", nodes: [node("a")] };
	assert.throws(() => Value.Decode(FlowIRSchema, f));
	assert.equal(Value.Check(FlowIRSchema, f), false);
});

test("FlowIRSchema: rejects an empty nodes array", () => {
	const f = { name: "f", nodes: [] };
	assert.throws(() => Value.Decode(FlowIRSchema, f));
	assert.equal(Value.Check(FlowIRSchema, f), false);
});

// ---------------------------------------------------------------------------
// Round-trip: a FlowIR built from all 10 kinds is valid
// ---------------------------------------------------------------------------

test("a FlowIR with one node of each of the 10 kinds is valid", () => {
	const kinds: FlowIRNode["kind"][] = [
		"agent", "parallel", "map", "gate", "reduce",
		"approval", "flow", "loop", "tournament", "script",
	];
	const nodes = kinds.map((k, i) => node(`${k}-${i}`, k));
	const f = ir(nodes);
	assertFlowIR(f);
	assert.equal(f.nodes.length, 10);
});
