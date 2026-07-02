import assert from "node:assert/strict";
import { test } from "node:test";
import { contractShapeErrors, contractViolations } from "../src/contract.ts";

// ---------------------------------------------------------------------------
// contractShapeErrors — static shape validation of author-written contracts
// ---------------------------------------------------------------------------

test("contract shape: a well-formed object contract passes", () => {
	const errs = contractShapeErrors({
		type: "object",
		required: ["score", "items"],
		properties: {
			score: { type: "number" },
			items: { type: "array", items: { type: "string" } },
			route: { enum: ["deep", "quick"] },
		},
	});
	assert.deepEqual(errs, []);
});

test("contract shape: non-object contract is rejected", () => {
	assert.equal(contractShapeErrors("nope").length, 1);
	assert.equal(contractShapeErrors([1, 2]).length, 1);
	assert.equal(contractShapeErrors(null).length, 1);
});

test("contract shape: unknown keywords and bad field types are reported with paths", () => {
	const errs = contractShapeErrors({
		type: "objekt",
		required: [1],
		properties: { a: "not-a-contract" },
		items: { enum: [] },
		bogus: true,
	});
	assert.ok(errs.some((e) => e.includes("expect.type")));
	assert.ok(errs.some((e) => e.includes("expect.required")));
	assert.ok(errs.some((e) => e.includes("expect.properties.a")));
	assert.ok(errs.some((e) => e.includes("expect.items.enum")));
	assert.ok(errs.some((e) => e.includes("expect.bogus")));
});

// ---------------------------------------------------------------------------
// contractViolations — runtime validation of parsed output
// ---------------------------------------------------------------------------

test("contract violations: matching value produces none", () => {
	const schema = {
		type: "object",
		required: ["score"],
		properties: { score: { type: "number" }, tags: { type: "array", items: { type: "string" } } },
	};
	assert.deepEqual(contractViolations({ score: 0.9, tags: ["a"] }, schema), []);
});

test("contract violations: type mismatch reports expected vs actual", () => {
	const v = contractViolations("a string", { type: "object" });
	assert.equal(v.length, 1);
	assert.match(v[0], /expected object, got string/);
});

test("contract violations: missing required key reported with path", () => {
	const v = contractViolations({ other: 1 }, { type: "object", required: ["score"] });
	assert.equal(v.length, 1);
	assert.match(v[0], /\$\.score: required key is missing/);
});

test("contract violations: nested property and array item paths", () => {
	const schema = {
		type: "object",
		properties: {
			items: { type: "array", items: { type: "object", required: ["id"] } },
		},
	};
	const v = contractViolations({ items: [{ id: 1 }, { nope: true }] }, schema);
	assert.equal(v.length, 1);
	assert.match(v[0], /\$\.items\[1\]\.id/);
});

test("contract violations: integer distinguishes from float; enum matches literals", () => {
	assert.deepEqual(contractViolations(3, { type: "integer" }), []);
	assert.match(contractViolations(3.5, { type: "integer" })[0], /expected integer/);
	assert.deepEqual(contractViolations("deep", { enum: ["deep", "quick"] }), []);
	assert.match(contractViolations("wat", { enum: ["deep", "quick"] })[0], /enum/);
});

test("contract violations: enum object literals match regardless of key order", () => {
	const schema = { enum: [{ a: 1, b: [2, { c: 3 }] }] };
	assert.deepEqual(contractViolations({ b: [2, { c: 3 }], a: 1 }, schema), []);
	assert.match(contractViolations({ a: 1, b: [2, { c: 4 }] }, schema)[0], /enum/);
});

test("contract violations: implicit object/array type from properties/items", () => {
	// No explicit `type`, but `required` implies an object contract.
	const v = contractViolations([1, 2], { required: ["x"] });
	assert.match(v[0], /expected object, got array/);
	const v2 = contractViolations("s", { items: { type: "number" } });
	assert.match(v2[0], /expected array, got string/);
});

test("contract violations: violation list is capped", () => {
	const schema = { type: "array", items: { type: "number" } };
	const v = contractViolations(Array.from({ length: 50 }, () => "x"), schema);
	assert.ok(v.length <= 8);
});

test("contract violations: malformed schema never throws, claims nothing", () => {
	assert.deepEqual(contractViolations({ a: 1 }, null), []);
	assert.deepEqual(contractViolations({ a: 1 }, "garbage"), []);
	assert.deepEqual(contractViolations({ a: 1 }, { type: 42 }), []);
});
