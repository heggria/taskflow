import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBudgetBound, preflightTaskflow, formatPreflightReport } from "../src/preflight.ts";
import type { Phase } from "../src/schema.ts";

test("preflight: missing required typed arg blocks plan", () => {
	const r = preflightTaskflow({
		name: "need-arg",
		args: { dir: { type: "string", required: true } },
		phases: [{ id: "a", type: "agent", task: "scan {args.dir}", final: true }],
	});
	assert.equal(r.ok, false);
	assert.ok(r.issues.some((i) => i.severity === "error" && /Missing required argument/.test(i.message)));
});

test("preflight: binds defaults and projects phase plan", () => {
	const r = preflightTaskflow(
		{
			name: "ok",
			args: { dir: { type: "string", default: "src" } },
			phases: [
				{ id: "a", type: "agent", task: "scan {args.dir}" },
				{ id: "b", type: "agent", task: "use {steps.a.output}", dependsOn: ["a"], final: true },
			],
		},
		{ args: {} },
	);
	assert.equal(r.ok, true);
	assert.equal(r.args.dir, "src");
	assert.equal(r.phases.length, 2);
	const a = r.phases.find((p) => p.id === "a")!;
	assert.ok(a.bindings.some((b) => b.path === "args.dir" && b.status === "bound"));
	const b = r.phases.find((p) => p.id === "b")!;
	assert.ok(b.bindings.some((x) => x.path === "steps.a" && x.status === "dynamic"));
	assert.match(formatPreflightReport(r), /plan — flow "ok"/);
});

test("budget bound: loop uses maxIterations", () => {
	const phases = [
		{ id: "l", type: "loop", task: "try", maxIterations: 3, until: "{steps.l.output}==done", final: true },
	] as Phase[];
	const b = computeBudgetBound(phases);
	assert.equal(b.maxAgentCalls, 3);
});

test("budget bound: dynamic map is unbounded", () => {
	const phases = [
		{ id: "m", type: "map", over: "{steps.x.json}", task: "t", final: true },
	] as Phase[];
	const b = computeBudgetBound(phases);
	assert.equal(b.maxAgentCalls, "unbounded");
	assert.ok(b.assumptions.some((a) => /unbounded/.test(a)));
});

test("budget bound: parallel branches count", () => {
	const phases = [
		{
			id: "p",
			type: "parallel",
			branches: [{ task: "a" }, { task: "b" }, { task: "c" }],
			final: true,
		},
	] as Phase[];
	const b = computeBudgetBound(phases);
	assert.equal(b.maxAgentCalls, 3);
});
