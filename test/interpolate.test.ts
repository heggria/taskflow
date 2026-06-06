import assert from "node:assert/strict";
import { test } from "node:test";
import { coerceArray, interpolate, safeParse } from "../extensions/interpolate.ts";

test("interpolate: args, steps.output, steps.json, previous, locals", () => {
	const ctx = {
		args: { dir: "src/api", n: 3 },
		steps: {
			discover: { output: "raw text", json: undefined },
			audit: { output: '{"score": 9}', json: { score: 9 } },
		},
		previousOutput: "PREV",
		locals: { item: { route: "/users", file: "u.ts" } },
	};

	assert.equal(interpolate("dir={args.dir}", ctx).text, "dir=src/api");
	assert.equal(interpolate("n={args.n}", ctx).text, "n=3");
	assert.equal(interpolate("o={steps.discover.output}", ctx).text, "o=raw text");
	assert.equal(interpolate("s={steps.audit.json.score}", ctx).text, "s=9");
	assert.equal(interpolate("p={previous.output}", ctx).text, "p=PREV");
	assert.equal(interpolate("r={item.route} f={item.file}", ctx).text, "r=/users f=u.ts");
});

test("interpolate: unknown placeholders are kept and reported", () => {
	const r = interpolate("a={args.missing} b={steps.nope.output}", { args: {}, steps: {} });
	assert.equal(r.text, "a={args.missing} b={steps.nope.output}");
	assert.deepEqual(r.missing.sort(), ["args.missing", "steps.nope.output"].sort());
});

test("interpolate: object value is JSON-stringified", () => {
	const ctx = { args: { obj: { a: 1 } }, steps: {} };
	assert.match(interpolate("{args.obj}", ctx).text, /"a": 1/);
});

test("interpolate: null/undefined template is coerced to empty string (no TypeError)", () => {
	const ctx = { args: { x: "v" }, steps: {} };
	assert.deepEqual(interpolate(null, ctx), { text: "", missing: [] });
	assert.deepEqual(interpolate(undefined, ctx), { text: "", missing: [] });
});

test("safeParse: direct, fenced, and embedded JSON", () => {
	assert.deepEqual(safeParse('[1,2,3]'), [1, 2, 3]);
	assert.deepEqual(safeParse('```json\n{"x":1}\n```'), { x: 1 });
	assert.deepEqual(safeParse('Here is the result: [{"a":1}] done'), [{ a: 1 }]);
	assert.equal(safeParse("not json at all"), undefined);
	assert.equal(safeParse(""), undefined);
});

test("safeParse: array + stray top-level key triggers diagnostic hint (v0.0.8.1)", () => {
	// Regression for dogfooding v0.0.8 §12.4: critic-style LLM output often
	// appends `"deferred": [...]` after a JSON array, producing a hybrid
	// that safeParse can't recover. We now emit a console.warn hint.
	const original = console.warn;
	const warnings: string[] = [];
	console.warn = (msg: string) => warnings.push(msg);
	try {
		const input = '[\n  {"id": "F-001"},\n  {"id": "F-002"}\n]\n"deferred": [\n  {"id": "D-001"}\n]';
		const result = safeParse(input);
		assert.equal(result, undefined, "hybrid array+key is unparseable");
		assert.equal(warnings.length, 1, "diagnostic hint should fire");
		assert.match(warnings[0], /array followed by a stray top-level key/);
		assert.match(warnings[0], /pi-taskflow safeParse/);
	} finally {
		console.warn = original;
	}
});

test("safeParse: malformed JSON inside array does NOT trigger the hint (no false positive)", () => {
	// Only the specific "syntactically valid array prefix + stray top-level key"
	// pattern should fire the hint. A genuinely malformed array (e.g. truncated
	// JSON with no trailing array) must NOT trigger the hint, so authors
	// aren't spammed.
	const original = console.warn;
	const warnings: string[] = [];
	console.warn = (msg: string) => warnings.push(msg);
	try {
		// Truncated JSON array — no balanced closing, no stray key.
		const result = safeParse("[1, 2, 3 random prose without quotes");
		assert.equal(result, undefined);
		assert.equal(warnings.length, 0, "no false-positive hint");
	} finally {
		console.warn = original;
	}
});

test("coerceArray: arrays and wrapped arrays", () => {
	assert.deepEqual(coerceArray([1, 2]), [1, 2]);
	assert.deepEqual(coerceArray({ items: ["a"] }), ["a"]);
	assert.deepEqual(coerceArray({ results: [{ x: 1 }] }), [{ x: 1 }]);
	assert.equal(coerceArray({ nope: 1 }), null);
	assert.equal(coerceArray("string"), null);
});
