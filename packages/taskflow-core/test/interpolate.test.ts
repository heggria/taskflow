import assert from "node:assert/strict";
import { test } from "node:test";
import { coerceArray, evaluateCondition, interpolate, safeParse } from "../src/interpolate.ts";

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

test("safeParse: ReDoS-safe on pathological fence/stray-key inputs (linear time)", () => {
	// The fence + stray-key regexes were made linear (js/polynomial-redos). A
	// pathological input (fence opener + a long whitespace run, no closing fence)
	// must return promptly, not backtrack super-linearly. A generous wall-clock
	// bound catches a regression without being flaky.
	const pathologicalFence = "```" + " \t".repeat(100_000);
	const pathologicalKey = "]" + " ".repeat(100_000);
	const t0 = Date.now();
	assert.equal(safeParse(pathologicalFence), undefined);
	assert.equal(safeParse(pathologicalKey), undefined);
	const elapsed = Date.now() - t0;
	assert.ok(elapsed < 1000, `safeParse must stay linear on adversarial input (took ${elapsed}ms)`);
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

// ---------------------------------------------------------------------------
// M3: observed-read hook (onRead)
// ---------------------------------------------------------------------------

test("interpolate: onRead fires only on successful resolution", () => {
	const calls: string[] = [];
	const ctx = {
		args: { dir: "src" },
		steps: { a: { output: "OUT" }, b: { output: '{"k":1}' } },
		previousOutput: "PREV",
		onRead: (ref: string) => calls.push(ref),
	};
	interpolate(
		"a={steps.a.output} b={steps.b.json.k} ghost={steps.ghost.output} arg={args.dir} prev={previous.output}",
		ctx,
	);
	// Every successfully-resolved ref is recorded…
	assert.deepEqual([...calls].sort(), ["args.dir", "previous.output", "steps.a.output", "steps.b.json.k"]);
	// …but the unresolved ref is NOT (it becomes a `missing` warning instead).
	assert.ok(!calls.includes("steps.ghost.output"));
});

test("interpolate: onRead is optional (default undefined → no throw)", () => {
	const ctx = { args: {}, steps: { a: { output: "x" } } };
	assert.equal(interpolate("{steps.a.output}", ctx).text, "x");
});

test("interpolate: condition evaluation records reads via onRead too", () => {
	const calls: string[] = [];
	const ctx = {
		args: { force: "true" },
		steps: { triage: { output: '{"route":"deep"}', json: { route: "deep" } } },
		onRead: (r: string) => calls.push(r),
	};
	// `&&` short-circuits, but both refs resolve before the boolean fold, so
	// both are observed reads of this condition.
	evaluateCondition("{steps.triage.json.route} == deep && {args.force} != true", ctx);
	assert.ok(calls.includes("steps.triage.json.route"));
	assert.ok(calls.includes("args.force"));
});
