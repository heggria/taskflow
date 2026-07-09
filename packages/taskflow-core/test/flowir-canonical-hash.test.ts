import assert from "node:assert/strict";
import { test } from "node:test";
import {
	canonicalizeFlowIR,
	hashFlowIR,
	hashNode,
} from "../src/flowir/canonical-hash.ts";
import type { FlowIR, FlowIRNode } from "../src/flowir/schema.ts";

function node(id: string, overrides: Partial<FlowIRNode> = {}): FlowIRNode {
	return {
		id,
		kind: "agent",
		inject: [],
		emits: [id],
		...overrides,
	};
}

function ir(nodes: FlowIRNode[], overrides: Partial<FlowIR> = {}): FlowIR {
	return { name: "test-flow", nodes, ...overrides };
}

// A reference IR used across many tests.
function referenceIR(): FlowIR {
	return ir([
		node("alpha", { inject: [], task: "do the first thing" }),
		node("beta", { inject: ["alpha"], task: "do the second thing", when: "{steps.alpha.output} == 'ok'" }),
		node("gamma", { kind: "gate", inject: ["beta"], when: "{steps.beta.output} != 'fail'" }),
	]);
}

test("hashFlowIR: returns 64 lowercase hex chars", () => {
	const h = hashFlowIR(referenceIR());
	assert.match(h, /^[0-9a-f]{64}$/);
});

test("hashNode: returns 64 lowercase hex chars", () => {
	const h = hashNode(node("a"));
	assert.match(h, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// 1. DETERMINISM
// ---------------------------------------------------------------------------

test("DETERMINISM: hashFlowIR is identical across repeated calls", () => {
	const a = referenceIR();
	const h1 = hashFlowIR(a);
	const h2 = hashFlowIR(a);
	const h3 = hashFlowIR(a);
	assert.equal(h1, h2);
	assert.equal(h2, h3);
});

test("DETERMINISM: hashNode is identical across repeated calls", () => {
	const n = node("x", { task: "hello" });
	assert.equal(hashNode(n), hashNode(n));
});

test("DETERMINISM: canonicalizeFlowIR is identical across repeated calls", () => {
	const a = referenceIR();
	assert.equal(canonicalizeFlowIR(a), canonicalizeFlowIR(a));
});

test("DETERMINISM: structurally-cloned IR hashes identically", () => {
	const a = referenceIR();
	const b: FlowIR = JSON.parse(JSON.stringify(a));
	assert.equal(hashFlowIR(a), hashFlowIR(b));
});

// ---------------------------------------------------------------------------
// 2. ORDER / WHITESPACE INDEPENDENCE
// ---------------------------------------------------------------------------

test("INDEPENDENCE: reordering nodes yields the same hash", () => {
	const order1 = ir([node("a"), node("b"), node("c")]);
	const order2 = ir([node("c"), node("a"), node("b")]);
	const order3 = ir([node("b"), node("c"), node("a")]);
	assert.equal(hashFlowIR(order1), hashFlowIR(order2));
	assert.equal(hashFlowIR(order2), hashFlowIR(order3));
});

test("INDEPENDENCE: reordering nodes with inject edges yields the same hash", () => {
	const order1 = ir([
		node("a", { task: "first" }),
		node("b", { inject: ["a"], task: "second" }),
		node("c", { inject: ["a", "b"], task: "third" }),
	]);
	const order2 = ir([
		node("c", { inject: ["a", "b"], task: "third" }),
		node("b", { inject: ["a"], task: "second" }),
		node("a", { task: "first" }),
	]);
	assert.equal(hashFlowIR(order1), hashFlowIR(order2));
});

test("INDEPENDENCE: reordering object keys on a node yields the same hash", () => {
	const n1: FlowIRNode = {
		id: "x",
		kind: "agent",
		inject: ["a"],
		emits: ["x"],
		task: "do thing",
		join: "any",
		timeout: 5000,
	};
	const n2: FlowIRNode = {
		timeout: 5000,
		join: "any",
		task: "do thing",
		emits: ["x"],
		inject: ["a"],
		kind: "agent",
		id: "x",
	};
	assert.equal(hashNode(n1), hashNode(n2));
});

test("INDEPENDENCE: reordering object keys on the IR yields the same hash", () => {
	const nodes = [node("a")];
	const ir1: FlowIR = { name: "f", nodes, concurrency: 2, version: 1 };
	const ir2: FlowIR = { version: 1, concurrency: 2, nodes, name: "f" };
	assert.equal(hashFlowIR(ir1), hashFlowIR(ir2));
});

test("INDEPENDENCE: condition whitespace does not change the hash", () => {
	const spaced = node("g", { kind: "gate", when: "{steps.a.output} == 'ok'" });
	const compact = node("g", { kind: "gate", when: "{steps.a.output}=='ok'" });
	const padded = node("g", { kind: "gate", when: "  {steps.a.output} == 'ok'  " });
	assert.equal(hashNode(spaced), hashNode(compact));
	assert.equal(hashNode(compact), hashNode(padded));
});

test("INDEPENDENCE: redundant enclosing parens on a condition do not change the hash", () => {
	const bare = node("g", { kind: "gate", when: "{steps.a.output} == 'ok'" });
	const paren = node("g", { kind: "gate", when: "(({steps.a.output} == 'ok'))" });
	assert.equal(hashNode(bare), hashNode(paren));
});

test("INDEPENDENCE: condition operator spacing variants do not change the hash", () => {
	const a = node("g", { kind: "gate", when: "{steps.a.output}!='fail'" });
	const b = node("g", { kind: "gate", when: "{steps.a.output} != 'fail'" });
	const c = node("g", { kind: "gate", when: "{steps.a.output}  !=  'fail'" });
	assert.equal(hashNode(a), hashNode(b));
	assert.equal(hashNode(b), hashNode(c));
});

test("INDEPENDENCE: presence of undefined optionals does not change the hash", () => {
	const withUndefined = node("a", { task: "t", when: undefined, join: undefined });
	const without = node("a", { task: "t" });
	assert.equal(hashNode(withUndefined), hashNode(without));
});

test("INDEPENDENCE: equivalent IRs with different node order + key order + condition whitespace hash identically", () => {
	const ir1 = ir([
		node("alpha", { task: "first" }),
		node("beta", { inject: ["alpha"], when: "{steps.alpha.output} == 'ok'", task: "second" }),
	]);
	const ir2 = ir([
		node("beta", { task: "second", when: "(({steps.alpha.output}=='ok'))", inject: ["alpha"] }),
		node("alpha", { task: "first" }),
	]);
	assert.equal(hashFlowIR(ir1), hashFlowIR(ir2));
});

// ---------------------------------------------------------------------------
// 3. SENSITIVITY
// ---------------------------------------------------------------------------

test("SENSITIVITY: changing the task string changes the hash", () => {
	const a = node("x", { task: "do thing a" });
	const b = node("x", { task: "do thing b" });
	assert.notEqual(hashNode(a), hashNode(b));
});

test("SENSITIVITY: changing the kind changes the hash", () => {
	const a = node("x", { kind: "agent" });
	const b = node("x", { kind: "gate" });
	assert.notEqual(hashNode(a), hashNode(b));
});

test("SENSITIVITY: adding an inject edge changes the hash", () => {
	const a = node("x", { inject: [] });
	const b = node("x", { inject: ["upstream"] });
	assert.notEqual(hashNode(a), hashNode(b));
});

test("SENSITIVITY: removing an inject edge changes the hash", () => {
	const a = node("x", { inject: ["upstream", "other"] });
	const b = node("x", { inject: ["upstream"] });
	assert.notEqual(hashNode(a), hashNode(b));
});

test("SENSITIVITY: changing an inject edge target changes the hash", () => {
	const a = node("x", { inject: ["alpha"] });
	const b = node("x", { inject: ["beta"] });
	assert.notEqual(hashNode(a), hashNode(b));
});

test("SENSITIVITY: reordering inject edges changes the hash (order is semantic)", () => {
	const a = node("x", { inject: ["alpha", "beta"] });
	const b = node("x", { inject: ["beta", "alpha"] });
	assert.notEqual(hashNode(a), hashNode(b));
});

test("SENSITIVITY: changing emits changes the hash", () => {
	const a = node("x", { emits: ["x"] });
	const b = node("x", { emits: ["y"] });
	assert.notEqual(hashNode(a), hashNode(b));
});

test("SENSITIVITY: changing the node id changes the hash", () => {
	const a = node("x", { task: "same" });
	const b = node("y", { task: "same" });
	assert.notEqual(hashNode(a), hashNode(b));
});

test("SENSITIVITY: changing join changes the hash", () => {
	const a = node("x", { join: "all" });
	const b = node("x", { join: "any" });
	assert.notEqual(hashNode(a), hashNode(b));
});

test("SENSITIVITY: changing timeout changes the hash", () => {
	const a = node("x", { timeout: 1000 });
	const b = node("x", { timeout: 2000 });
	assert.notEqual(hashNode(a), hashNode(b));
});

test("SENSITIVITY: changing the condition's compared value changes the hash", () => {
	const a = node("g", { kind: "gate", when: "{steps.a.output} == 'ok'" });
	const b = node("g", { kind: "gate", when: "{steps.a.output} == 'block'" });
	assert.notEqual(hashNode(a), hashNode(b));
});

test("SENSITIVITY: changing the condition's referenced step changes the hash", () => {
	const a = node("g", { kind: "gate", when: "{steps.a.output} == 'ok'" });
	const b = node("g", { kind: "gate", when: "{steps.b.output} == 'ok'" });
	assert.notEqual(hashNode(a), hashNode(b));
});

test("SENSITIVITY: changing the IR name changes hashFlowIR", () => {
	const a = ir([node("a")], { name: "flow-one" });
	const b = ir([node("a")], { name: "flow-two" });
	assert.notEqual(hashFlowIR(a), hashFlowIR(b));
});

test("SENSITIVITY: changing a node's task changes hashFlowIR", () => {
	const a = ir([node("x", { task: "t1" })]);
	const b = ir([node("x", { task: "t2" })]);
	assert.notEqual(hashFlowIR(a), hashFlowIR(b));
});

test("SENSITIVITY: adding a node changes hashFlowIR", () => {
	const a = ir([node("x")]);
	const b = ir([node("x"), node("y")]);
	assert.notEqual(hashFlowIR(a), hashFlowIR(b));
});

test("SENSITIVITY: changing budget changes hashFlowIR", () => {
	const a = ir([node("x")], { budget: { maxUSD: 1 } });
	const b = ir([node("x")], { budget: { maxUSD: 2 } });
	assert.notEqual(hashFlowIR(a), hashFlowIR(b));
});

test("SENSITIVITY: changing concurrency changes hashFlowIR", () => {
	const a = ir([node("x")], { concurrency: 2 });
	const b = ir([node("x")], { concurrency: 4 });
	assert.notEqual(hashFlowIR(a), hashFlowIR(b));
});

test("SENSITIVITY: changing version changes hashFlowIR", () => {
	const a = ir([node("x")], { version: 1 });
	const b = ir([node("x")], { version: 2 });
	assert.notEqual(hashFlowIR(a), hashFlowIR(b));
});

test("SENSITIVITY: two distinct IRs do not collide", () => {
	const a = ir([
		node("a", { task: "task A" }),
		node("b", { inject: ["a"], task: "task B" }),
	]);
	const b = ir([
		node("a", { task: "different task" }),
		node("b", { inject: ["a"], task: "task B" }),
	]);
	assert.notEqual(hashFlowIR(a), hashFlowIR(b));
});
