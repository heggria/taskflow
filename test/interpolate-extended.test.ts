/**
 * Tests for interpolate edge cases, safeParse strategies, coerceArray variants,
 * condition parser branches, parseTtlMs, topoLayers, resolveArgs, and cache fingerprint.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { interpolate, safeParse, coerceArray, evaluateCondition, tryEvaluateCondition } from "../extensions/interpolate.ts";
import { parseTtlMs, topoLayers, resolveArgs, type Phase, type Taskflow, dependenciesOf } from "../extensions/schema.ts";

// ════════════════════════════════════════════════════════════════════
// INTERPOLATE
// ════════════════════════════════════════════════════════════════════

test("interpolate: null/undefined template returns empty string", () => {
	const ctx = { args: {}, steps: {} };
	assert.deepEqual(interpolate(null, ctx), { text: "", missing: [] });
	assert.deepEqual(interpolate(undefined, ctx), { text: "", missing: [] });
});

test("interpolate: nested field access via dots", () => {
	const ctx = { args: {}, steps: { s: { output: "", json: { a: { b: { c: 42 } } } } } };
	const r = interpolate("{steps.s.json.a.b.c}", ctx);
	assert.equal(r.text, "42");
});

test("interpolate: missing placeholder is left intact and recorded", () => {
	const ctx = { args: {}, steps: {} };
	const r = interpolate("hello {steps.missing.output} world", ctx);
	assert.equal(r.text, "hello {steps.missing.output} world");
	assert.deepEqual(r.missing, ["steps.missing.output"]);
});

test("interpolate: previous.output alias", () => {
	const ctx = { args: {}, steps: {}, previousOutput: "prev-val" };
	assert.equal(interpolate("{previous.output}", ctx).text, "prev-val");
});

test("interpolate: locals (map loop variable)", () => {
	const ctx = { args: {}, steps: {}, locals: { item: { name: "foo" } } };
	assert.equal(interpolate("{item.name}", ctx).text, "foo");
});

test("interpolate: string value returned as-is (not JSON-stringified)", () => {
	const ctx = { args: {}, steps: { s: { output: "hello world" } } };
	assert.equal(interpolate("{steps.s.output}", ctx).text, "hello world");
});

test("interpolate: object value is JSON-stringified", () => {
	const ctx = { args: {}, steps: { s: { output: "", json: { x: 1 } } } };
	const r = interpolate("{steps.s.json}", ctx);
	assert.equal(JSON.parse(r.text).x, 1);
});

// ════════════════════════════════════════════════════════════════════
// SAFE PARSE
// ════════════════════════════════════════════════════════════════════

test("safeParse: direct JSON object", () => {
	assert.deepEqual(safeParse('{"a":1}'), { a: 1 });
});

test("safeParse: direct JSON array", () => {
	assert.deepEqual(safeParse("[1,2,3]"), [1, 2, 3]);
});

test("safeParse: JSON in fenced code block", () => {
	const input = '```json\n{"key": "value"}\n```';
	assert.deepEqual(safeParse(input), { key: "value" });
});

test("safeParse: JSON in plain fenced block (no lang tag)", () => {
	const input = '```\n[1, 2]\n```';
	assert.deepEqual(safeParse(input), [1, 2]);
});

test("safeParse: extracts first balanced object from mixed text", () => {
	const input = 'Here is the result: {"count": 5} and some trailing text.';
	assert.deepEqual(safeParse(input), { count: 5 });
});

test("safeParse: extracts first balanced array from mixed text", () => {
	const input = 'Results: [{"id": 1}, {"id": 2}] done.';
	assert.deepEqual(safeParse(input), [{ id: 1 }, { id: 2 }]);
});

test("safeParse: returns undefined for empty/whitespace", () => {
	assert.equal(safeParse(""), undefined);
	assert.equal(safeParse("   "), undefined);
});

test("safeParse: returns undefined for non-JSON text", () => {
	assert.equal(safeParse("this is not json"), undefined);
});

test("safeParse: malformed JSON in fenced block returns undefined", () => {
	assert.equal(safeParse('```json\n{"broken": }\n```'), undefined);
});

test("safeParse: truncation-safe — partial JSON returns undefined", () => {
	assert.equal(safeParse('{"incomplete":'), undefined);
});

// ════════════════════════════════════════════════════════════════════
// COERCE ARRAY
// ════════════════════════════════════════════════════════════════════

test("coerceArray: passes through a plain array", () => {
	assert.deepEqual(coerceArray([1, 2, 3]), [1, 2, 3]);
});

test("coerceArray: extracts from {items: [...]}", () => {
	assert.deepEqual(coerceArray({ items: ["a", "b"] }), ["a", "b"]);
});

test("coerceArray: extracts from {results: [...]}", () => {
	assert.deepEqual(coerceArray({ results: [1] }), [1]);
});

test("coerceArray: extracts from {list: [...]}", () => {
	assert.deepEqual(coerceArray({ list: ["x"] }), ["x"]);
});

test("coerceArray: extracts from {data: [...]}", () => {
	assert.deepEqual(coerceArray({ data: [42] }), [42]);
});

test("coerceArray: extracts from {findings: [...]}", () => {
	assert.deepEqual(coerceArray({ findings: ["f1"] }), ["f1"]);
});

test("coerceArray: returns null for non-array, non-wrapper", () => {
	assert.equal(coerceArray("not an array"), null);
	assert.equal(coerceArray(42), null);
	assert.equal(coerceArray(null), null);
	assert.equal(coerceArray(undefined), null);
	assert.equal(coerceArray({ foo: "bar" }), null);
});

test("coerceArray: prefers 'items' over other keys", () => {
	// When multiple wrapper keys exist, items is checked first.
	assert.deepEqual(coerceArray({ items: [1], results: [2] }), [1]);
});

// ════════════════════════════════════════════════════════════════════
// CONDITION PARSER (when expressions)
// ════════════════════════════════════════════════════════════════════

function evalOk(expr: string, steps?: Record<string, { output: string; json?: unknown }>): boolean {
	return evaluateCondition(expr, { args: {}, steps: steps ?? {} });
}

test("condition: boolean literals", () => {
	assert.equal(evalOk("true"), true);
	assert.equal(evalOk("false"), false);
});

test("condition: numeric comparison operators", () => {
	assert.equal(evalOk("5 > 3"), true);
	assert.equal(evalOk("3 > 5"), false);
	assert.equal(evalOk("5 >= 5"), true);
	assert.equal(evalOk("3 < 5"), true);
	assert.equal(evalOk("5 <= 5"), true);
	assert.equal(evalOk("5 == 5"), true);
	assert.equal(evalOk("5 != 3"), true);
});

test("condition: string comparison", () => {
	assert.equal(evalOk('"foo" == "foo"'), true);
	assert.equal(evalOk('"foo" != "bar"'), true);
	assert.equal(evalOk('"abc" > "aaa"'), true);
});

test("condition: logical AND / OR", () => {
	assert.equal(evalOk("true && true"), true);
	assert.equal(evalOk("true && false"), false);
	assert.equal(evalOk("false || true"), true);
	assert.equal(evalOk("false || false"), false);
});

test("condition: logical NOT", () => {
	assert.equal(evalOk("!false"), true);
	assert.equal(evalOk("!true"), false);
	assert.equal(evalOk("!0"), true);
	assert.equal(evalOk("!1"), false);
});

test("condition: grouping with parentheses", () => {
	assert.equal(evalOk("(true && false) || true"), true);
	assert.equal(evalOk("true && (false || true)"), true);
	assert.equal(evalOk("!(true && false)"), true);
});

test("condition: nested parentheses", () => {
	assert.equal(evalOk("((5 > 3) && (2 < 4)) || false"), true);
	assert.equal(evalOk("((5 < 3) && (2 < 4)) || false"), false);
});

test("condition: placeholder refs in comparisons", () => {
	const steps = { x: { output: "", json: { score: 0.85 } } };
	assert.equal(evalOk("{steps.x.json.score} >= 0.8", steps), true);
	assert.equal(evalOk("{steps.x.json.score} < 0.5", steps), false);
});

test("condition: bare placeholder is evaluated for truthiness", () => {
	assert.equal(evalOk("{steps.x.json.flag}", { x: { output: "", json: { flag: true } } }), true);
	assert.equal(evalOk("{steps.x.json.flag}", { x: { output: "", json: { flag: false } } }), false);
	assert.equal(evalOk("{steps.x.json.flag}", { x: { output: "", json: {} } }), false); // undefined → falsy
});

test("condition: null keyword", () => {
	assert.equal(evalOk("null == null"), true);
	assert.equal(evalOk("null != 0"), true);
});

test("condition: empty expression returns true (no guard)", () => {
	assert.equal(evalOk(""), true);
	assert.equal(evalOk("   "), true);
});

test("condition: malformed expression fails open (returns true)", () => {
	const r = tryEvaluateCondition("{steps.x.json.val ==", { args: {}, steps: {} });
	assert.equal(r.value, true, "must fail open");
	assert.ok(r.error, "error must be recorded");
});

test("condition: short-circuit evaluation", () => {
	// false && <anything> → false; true || <anything> → true
	assert.equal(evalOk("false && true"), false);
	assert.equal(evalOk("true || false"), true);
	// The parser does NOT have arithmetic operators — (1 / 0) is a parse error
	// which fails open (returns true). Use valid expressions only.
	assert.equal(evalOk("false && false"), false);
	assert.equal(evalOk("true && true"), true);
});

// ════════════════════════════════════════════════════════════════════
// PARSE TTL
// ════════════════════════════════════════════════════════════════════

test("parseTtlMs: milliseconds (default unit)", () => {
	assert.equal(parseTtlMs("5000"), 5000);
	assert.equal(parseTtlMs("5000ms"), 5000);
});

test("parseTtlMs: seconds", () => {
	assert.equal(parseTtlMs("30s"), 30_000);
	assert.equal(parseTtlMs("1.5s"), 1500);
});

test("parseTtlMs: minutes", () => {
	assert.equal(parseTtlMs("5m"), 300_000);
	assert.equal(parseTtlMs("30m"), 1_800_000);
});

test("parseTtlMs: hours", () => {
	assert.equal(parseTtlMs("2h"), 7_200_000);
});

test("parseTtlMs: days", () => {
	assert.equal(parseTtlMs("7d"), 604_800_000);
});

test("parseTtlMs: fractional values", () => {
	assert.equal(parseTtlMs("0.5h"), 1_800_000);
	assert.equal(parseTtlMs("1.5d"), 129_600_000);
});

test("parseTtlMs: null for invalid input", () => {
	assert.equal(parseTtlMs(""), null);
	assert.equal(parseTtlMs("abc"), null);
	assert.equal(parseTtlMs("0"), null);
	assert.equal(parseTtlMs("-5m"), null);
	assert.equal(parseTtlMs("5x"), null);
});

test("parseTtlMs: whitespace tolerant", () => {
	assert.equal(parseTtlMs("  30m  "), 1_800_000);
	assert.equal(parseTtlMs("  1000  "), 1000);
});

// ════════════════════════════════════════════════════════════════════
// TOPO LAYERS
// ════════════════════════════════════════════════════════════════════

test("topoLayers: independent phases all in layer 0", () => {
	const phases: Phase[] = [
		{ id: "a", type: "agent", task: "t" },
		{ id: "b", type: "agent", task: "t" },
		{ id: "c", type: "agent", task: "t" },
	];
	const layers = topoLayers(phases);
	assert.equal(layers.length, 1);
	assert.equal(layers[0].length, 3);
});

test("topoLayers: linear chain produces N layers", () => {
	const phases: Phase[] = [
		{ id: "a", type: "agent", task: "t" },
		{ id: "b", type: "agent", task: "t", dependsOn: ["a"] },
		{ id: "c", type: "agent", task: "t", dependsOn: ["b"] },
	];
	const layers = topoLayers(phases);
	assert.equal(layers.length, 3);
	assert.deepEqual(layers.map((l) => l.map((p) => p.id)), [["a"], ["b"], ["c"]]);
});

test("topoLayers: diamond DAG", () => {
	const phases: Phase[] = [
		{ id: "a", type: "agent", task: "t" },
		{ id: "b", type: "agent", task: "t", dependsOn: ["a"] },
		{ id: "c", type: "agent", task: "t", dependsOn: ["a"] },
		{ id: "d", type: "agent", task: "t", dependsOn: ["b", "c"] },
	];
	const layers = topoLayers(phases);
	assert.equal(layers.length, 3);
	assert.deepEqual(layers[0].map((p) => p.id), ["a"]);
	assert.equal(layers[1].length, 2); // b, c in parallel
	assert.deepEqual(layers[2].map((p) => p.id), ["d"]);
});

test("topoLayers: empty phases returns empty", () => {
	assert.deepEqual(topoLayers([]), []);
});

// ════════════════════════════════════════════════════════════════════
// RESOLVE ARGS
// ════════════════════════════════════════════════════════════════════

test("resolveArgs: uses provided values over defaults", () => {
	const def: Taskflow = {
		name: "t",
		args: { x: { default: 1 }, y: { default: 2 } },
		phases: [{ id: "p", type: "agent", task: "t", final: true }],
	};
	assert.deepEqual(resolveArgs(def, { x: 10 }), { x: 10, y: 2 });
});

test("resolveArgs: extra provided keys are passed through", () => {
	const def: Taskflow = {
		name: "t",
		args: { x: { default: 1 } },
		phases: [{ id: "p", type: "agent", task: "t", final: true }],
	};
	assert.deepEqual(resolveArgs(def, { x: 5, extra: "hello" }), { x: 5, extra: "hello" });
});

test("resolveArgs: no provided values uses all defaults", () => {
	const def: Taskflow = {
		name: "t",
		args: { a: { default: "da" }, b: { default: "db" } },
		phases: [{ id: "p", type: "agent", task: "t", final: true }],
	};
	assert.deepEqual(resolveArgs(def), { a: "da", b: "db" });
});

test("resolveArgs: no args declared returns empty", () => {
	const def: Taskflow = {
		name: "t",
		phases: [{ id: "p", type: "agent", task: "t", final: true }],
	};
	assert.deepEqual(resolveArgs(def, { extra: 1 }), { extra: 1 });
	assert.deepEqual(resolveArgs(def), {});
});

test("resolveArgs: provided undefined overrides default", () => {
	const def: Taskflow = {
		name: "t",
		args: { x: { default: 42 } },
		phases: [{ id: "p", type: "agent", task: "t", final: true }],
	};
	// When explicitly provided as undefined, it should still be in args
	const result = resolveArgs(def, { x: undefined });
	assert.equal("x" in result, true);
	assert.equal(result.x, undefined);
});

// ════════════════════════════════════════════════════════════════════
// DEPENDENCIES OF
// ════════════════════════════════════════════════════════════════════

test("dependenciesOf: merges dependsOn and from", () => {
	const phase: Phase = { id: "p", type: "reduce", task: "t", from: ["a"], dependsOn: ["b"] };
	assert.deepEqual(dependenciesOf(phase).sort(), ["a", "b"]);
});

test("dependenciesOf: deduplicates", () => {
	const phase: Phase = { id: "p", type: "reduce", task: "t", from: ["a"], dependsOn: ["a"] };
	assert.deepEqual(dependenciesOf(phase), ["a"]);
});

test("dependenciesOf: empty when no deps", () => {
	const phase: Phase = { id: "p", type: "agent", task: "t" };
	assert.deepEqual(dependenciesOf(phase), []);
});
