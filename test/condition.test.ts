import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCondition, tryEvaluateCondition, type InterpolationContext } from "../extensions/interpolate.ts";

function ctx(partial: Partial<InterpolationContext>): InterpolationContext {
	return { args: {}, steps: {}, ...partial };
}

test("condition: string equality against a step json field", () => {
	const c = ctx({ steps: { triage: { output: "", json: { route: "deep" } } } });
	assert.equal(evaluateCondition("{steps.triage.json.route} == deep", c), true);
	assert.equal(evaluateCondition("{steps.triage.json.route} == quick", c), false);
	assert.equal(evaluateCondition("{steps.triage.json.route} != quick", c), true);
});

test("condition: quoted strings and numbers", () => {
	const c = ctx({ args: { n: 5, label: "go live" } });
	assert.equal(evaluateCondition("{args.n} > 3", c), true);
	assert.equal(evaluateCondition("{args.n} >= 5", c), true);
	assert.equal(evaluateCondition("{args.n} < 5", c), false);
	assert.equal(evaluateCondition('{args.label} == "go live"', c), true);
});

test("condition: boolean truthiness of bare refs", () => {
	assert.equal(evaluateCondition("{args.flag}", ctx({ args: { flag: true } })), true);
	assert.equal(evaluateCondition("{args.flag}", ctx({ args: { flag: false } })), false);
	assert.equal(evaluateCondition("{args.flag}", ctx({ args: { flag: "false" } })), false);
	assert.equal(evaluateCondition("{args.flag}", ctx({ args: { flag: "yes" } })), true);
	// missing ref → undefined → falsy
	assert.equal(evaluateCondition("{args.missing}", ctx({})), false);
});

test("condition: logical operators and grouping", () => {
	const c = ctx({ args: { a: 1, b: 0, name: "prod" } });
	assert.equal(evaluateCondition("{args.a} && {args.name} == prod", c), true);
	assert.equal(evaluateCondition("{args.b} || {args.name} == prod", c), true);
	assert.equal(evaluateCondition("{args.b} && {args.name} == prod", c), false);
	assert.equal(evaluateCondition("!{args.b}", c), true);
	assert.equal(evaluateCondition("({args.b} || {args.a}) && {args.name} == prod", c), true);
});

test("condition: array/object truthiness", () => {
	assert.equal(evaluateCondition("{steps.x.json}", ctx({ steps: { x: { output: "", json: [1, 2] } } })), true);
	assert.equal(evaluateCondition("{steps.x.json}", ctx({ steps: { x: { output: "", json: [] } } })), false);
	assert.equal(evaluateCondition("{steps.x.json}", ctx({ steps: { x: { output: "", json: {} } } })), false);
});

test("condition: empty expression is true (no guard)", () => {
	assert.equal(evaluateCondition("", ctx({})), true);
	assert.equal(evaluateCondition("   ", ctx({})), true);
});

test("condition: parse errors fail OPEN with a recorded error", () => {
	const r = tryEvaluateCondition("{args.a} == == 3", ctx({ args: { a: 1 } }));
	assert.equal(r.value, true);
	assert.ok(r.error, "should record a parse error");
});
