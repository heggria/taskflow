import assert from "node:assert/strict";
import { test } from "node:test";
import { dependenciesOf, finalPhase, type Taskflow, topoLayers, validateTaskflow } from "../extensions/schema.ts";

const valid: Taskflow = {
	name: "audit",
	phases: [
		{ id: "discover", type: "agent", agent: "a", task: "list", output: "json" },
		{ id: "audit", type: "map", over: "{steps.discover.json}", as: "item", agent: "a", task: "do {item}", dependsOn: ["discover"] },
		{ id: "report", type: "reduce", from: ["audit"], agent: "a", task: "sum {steps.audit.output}", dependsOn: ["audit"], final: true },
	],
};

test("validateTaskflow: accepts a valid flow", () => {
	const r = validateTaskflow(valid);
	assert.equal(r.ok, true, r.errors.join("; "));
});

test("validateTaskflow: rejects missing name / phases", () => {
	assert.equal(validateTaskflow({}).ok, false);
	assert.equal(validateTaskflow({ name: "x" }).ok, false);
	assert.equal(validateTaskflow({ name: "x", phases: [] }).ok, false);
});

test("validateTaskflow: per-type requirements", () => {
	assert.equal(validateTaskflow({ name: "x", phases: [{ id: "p", type: "agent" }] }).ok, false); // no task
	assert.equal(validateTaskflow({ name: "x", phases: [{ id: "p", type: "map", task: "t" }] }).ok, false); // no over
	assert.equal(validateTaskflow({ name: "x", phases: [{ id: "p", type: "parallel" }] }).ok, false); // no branches
	assert.equal(validateTaskflow({ name: "x", phases: [{ id: "p", type: "reduce", task: "t" }] }).ok, false); // no from
});

test("validateTaskflow: duplicate ids and unknown deps", () => {
	const dup = { name: "x", phases: [{ id: "p", type: "agent", task: "t" }, { id: "p", type: "agent", task: "t" }] };
	assert.equal(validateTaskflow(dup).ok, false);
	const badDep = { name: "x", phases: [{ id: "p", type: "agent", task: "t", dependsOn: ["ghost"] }] };
	assert.equal(validateTaskflow(badDep).ok, false);
});

test("validateTaskflow: detects cycles", () => {
	const cyc = {
		name: "x",
		phases: [
			{ id: "a", type: "agent", task: "t", dependsOn: ["b"] },
			{ id: "b", type: "agent", task: "t", dependsOn: ["a"] },
		],
	};
	const r = validateTaskflow(cyc);
	assert.equal(r.ok, false);
	assert.match(r.errors.join(" "), /cycle/i);
});

test("validateTaskflow: at most one final", () => {
	const two = {
		name: "x",
		phases: [
			{ id: "a", type: "agent", task: "t", final: true },
			{ id: "b", type: "agent", task: "t", final: true },
		],
	};
	assert.equal(validateTaskflow(two).ok, false);
});

test("topoLayers: produces correct execution layers", () => {
	const layers = topoLayers(valid.phases);
	assert.deepEqual(layers.map((l) => l.map((p) => p.id)), [["discover"], ["audit"], ["report"]]);
});

test("topoLayers: parallel phases share a layer", () => {
	const phases: Taskflow["phases"] = [
		{ id: "root", type: "agent", task: "t" },
		{ id: "x", type: "agent", task: "t", dependsOn: ["root"] },
		{ id: "y", type: "agent", task: "t", dependsOn: ["root"] },
		{ id: "join", type: "reduce", from: ["x", "y"], task: "t", dependsOn: ["x", "y"] },
	];
	const layers = topoLayers(phases);
	assert.deepEqual(layers[0].map((p) => p.id), ["root"]);
	assert.deepEqual(layers[1].map((p) => p.id).sort(), ["x", "y"]);
	assert.deepEqual(layers[2].map((p) => p.id), ["join"]);
});

test("dependenciesOf: unions dependsOn and from", () => {
	assert.deepEqual(dependenciesOf({ id: "p", from: ["a"], dependsOn: ["b"] }).sort(), ["a", "b"]);
});

test("finalPhase: explicit final, else last", () => {
	assert.equal(finalPhase(valid.phases).id, "report");
	const noFinal: Taskflow["phases"] = [{ id: "a", task: "t" }, { id: "b", task: "t" }];
	assert.equal(finalPhase(noFinal).id, "b");
});
