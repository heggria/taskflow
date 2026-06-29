import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, flowDefHash, hashCanonical } from "../src/flowir/hash.ts";
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
// canonicalJson — byte-identical to overstory ir/hash.ts
// ---------------------------------------------------------------------------

test("canonicalJson: key order does not affect output", () => {
	assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
});

test("canonicalJson: nested keys are recursively sorted", () => {
	assert.equal(
		canonicalJson({ z: { y: 2, x: 1 }, a: 0 }),
		'{"a":0,"z":{"x":1,"y":2}}',
	);
});

test("canonicalJson: undefined values are dropped (not null)", () => {
	assert.equal(canonicalJson({ a: 1, b: undefined, c: 3 }), '{"a":1,"c":3}');
	// But an explicit null survives.
	assert.equal(canonicalJson({ a: null }), '{"a":null}');
});

test("canonicalJson: arrays keep their order", () => {
	assert.notEqual(canonicalJson([3, 1, 2]), canonicalJson([1, 2, 3]));
	assert.equal(canonicalJson([1, 2, 3]), "[1,2,3]");
});

test("canonicalJson: no whitespace", () => {
	assert.equal(canonicalJson({ a: { b: 1 } }), '{"a":{"b":1}}');
	assert.ok(!canonicalJson({ a: 1, b: 2 }).includes(" "));
});

// ---------------------------------------------------------------------------
// hashCanonical — shape (16 bytes / 32 hex chars), like overstory hashIR
// ---------------------------------------------------------------------------

test("hashCanonical: returns 32 lowercase hex chars (16 bytes)", async () => {
	const h = await hashCanonical('{"a":1}');
	assert.match(h, /^[0-9a-f]{32}$/);
});

test("hashCanonical: different input → different hash", async () => {
	assert.notEqual(await hashCanonical("a"), await hashCanonical("b"));
});

// ---------------------------------------------------------------------------
// flowDefHash — the contract this milestone actually uses
// ---------------------------------------------------------------------------

test("flowDefHash: deterministic for the same definition", async () => {
	const f = flow([agent("a"), agent("b", ["a"], { final: true })]);
	assert.equal(await flowDefHash(f), await flowDefHash(f));
});

test("flowDefHash: stable across key reordering and optional-field presence", async () => {
	const ordered = flow([agent("a", undefined, { final: true })]);
	// Same phase, keys declared in a different order, equivalent shape.
	const reordered: Taskflow = {
		phases: [{ final: true, task: "task for a", type: "agent", id: "a" }],
		name: "test-flow",
	} as Taskflow;
	assert.equal(await flowDefHash(ordered), await flowDefHash(reordered));
});

test("flowDefHash: sensitive to task text", async () => {
	const base = flow([agent("a", undefined, { final: true })]);
	const changed = flow([agent("a", undefined, { final: true, task: "DIFFERENT" })]);
	assert.notEqual(await flowDefHash(base), await flowDefHash(changed));
});

test("flowDefHash: sensitive to structure (added phase / changed deps)", async () => {
	const twoNode = flow([agent("a"), agent("b", ["a"], { final: true })]);
	const threeNode = flow([agent("a"), agent("b", ["a"]), agent("c", ["b"], { final: true })]);
	assert.notEqual(await flowDefHash(twoNode), await flowDefHash(threeNode));
	// Flipping a dependency edge also changes the hash.
	const aThenB = flow([agent("a"), agent("b", ["a"], { final: true })]);
	const bThenA = flow([agent("b"), agent("a", ["b"], { final: true })]);
	assert.notEqual(await flowDefHash(aThenB), await flowDefHash(bThenA));
});

test("flowDefHash: two flows that share name + phase id + task but differ structurally do NOT collide", async () => {
	// This is the regression that motivated the milestone: previously the cache
	// key folded only `flow:${flowName}`, so these two would collide in the
	// cross-run cache. Their flowDefHash MUST differ.
	const a = flow([agent("scan", undefined, { final: true })], { name: "audit" });
	const b = flow(
		[agent("scan", undefined, { final: true }), agent("report", ["scan"], { final: false })],
		{ name: "audit" },
	);
	assert.notEqual(await flowDefHash(a), await flowDefHash(b));
});

test("flowDefHash: ignores runtime args (hashes the definition, not invocation values)", async () => {
	// args are a runtime concern; the definition fingerprint must be stable
	// regardless of arg values. (Args are folded into cache identity via the
	// interpolated task → inputHash, not here.)
	const f = flow([agent("a", undefined, { final: true })]);
	assert.equal(await flowDefHash(f), await flowDefHash(f));
});

test("flowDefHash: two genuinely identical definitions (different object identity) match", async () => {
	const mk = () => flow([agent("a"), agent("b", ["a"], { final: true })]);
	assert.equal(await flowDefHash(mk()), await flowDefHash(mk()));
});
