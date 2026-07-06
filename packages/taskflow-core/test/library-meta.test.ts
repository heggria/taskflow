/**
 * Library meta derivation: phaseSignature, generality, agentUsage, phaseCount.
 * Refs: docs/rfc-library-reuse.md §3.2 (phaseSignature), §3.3 (generality v2).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Taskflow } from "../src/schema.ts";
import {
	computeGenerality,
	computePhaseSignature,
	countPhases,
	deriveMeta,
	extractAgentUsage,
} from "../src/library/meta.ts";

function flow(over: Partial<Taskflow>): Taskflow {
	return {
		name: over.name ?? "t",
		phases: over.phases ?? [],
		...over,
	} as Taskflow;
}

// ---------------------------------------------------------------------------
// phaseSignature
// ---------------------------------------------------------------------------

test("phaseSignature: linear chain", () => {
	const f = flow({
		phases: [
			{ id: "a", type: "agent", task: "x" },
			{ id: "b", type: "map", over: "{items}", task: "y", dependsOn: ["a"] },
			{ id: "c", type: "gate", task: "z", dependsOn: ["b"] },
			{ id: "d", type: "reduce", from: ["c"], task: "w", dependsOn: ["c"] },
		],
	});
	assert.equal(computePhaseSignature(f), "agent→map→gate→reduce");
	assert.equal(countPhases(f), 4);
});

test("phaseSignature: parallel same-layer joined with +", () => {
	const f = flow({
		phases: [
			{ id: "a", type: "agent", task: "x" },
			{ id: "b", type: "agent", task: "y" },
			{ id: "c", type: "agent", task: "z", dependsOn: ["a", "b"] },
		],
	});
	// a and b are layer 0 (parallel) → "agent+agent"; c is layer 1.
	assert.equal(computePhaseSignature(f), "agent+agent→agent");
});

test("phaseSignature: empty flow", () => {
	assert.equal(computePhaseSignature(flow({})), "");
	assert.equal(countPhases(flow({})), 0);
});

// ---------------------------------------------------------------------------
// agentUsage
// ---------------------------------------------------------------------------

test("agentUsage: distinct, sorted, includes parallel branches", () => {
	const f = flow({
		phases: [
			{ id: "a", type: "agent", agent: "scout", task: "x" },
			{ id: "b", type: "parallel", branches: [{ task: "y", agent: "analyst" }, { task: "y2", agent: "scout" }] },
			{ id: "c", type: "agent", agent: "writer", task: "z", dependsOn: ["b"] },
		],
	});
	assert.deepEqual(extractAgentUsage(f), ["analyst", "scout", "writer"]);
});

// ---------------------------------------------------------------------------
// generality (v2 formula — RFC §3.3, A8 fix)
// ---------------------------------------------------------------------------

test("generality: fully-hardcoded flow scores low", () => {
	const f = flow({
		phases: [{ id: "a", type: "agent", task: "review the auth code under src/api/users.ts for missing checks" }],
	});
	// 100% literal, 0 placeholders, 0 args, no description → low generality.
	assert.ok(computeGenerality(f) <= 0.05, `expected <=0.05, got ${computeGenerality(f)}`);
});

test("generality: highly parameterized flow scores high", () => {
	const f = flow({
		description: "audit endpoints",
		args: { dir: { default: "src/routes" }, threshold: { default: 0.5 } },
		budget: { maxUSD: 2 },
		phases: [
			{ id: "d", type: "agent", agent: "scout", task: "List endpoints under {args.dir}. Output JSON array.", output: "json" },
			{ id: "m", type: "map", over: "{steps.d.json}", as: "item", agent: "analyst", task: "Audit {item.route} ({item.file}).", dependsOn: ["d"] },
			{ id: "r", type: "reduce", from: ["m"], agent: "writer", task: "Write report:\n{steps.m.output}", dependsOn: ["m"], final: true },
		],
	});
	const g = computeGenerality(f);
	assert.ok(g >= 0.5, `expected parameterized flow >=0.5, got ${g}`);
});

test("generality: v2 formula softens (but does not eliminate) the verbosity penalty (A8)", () => {
	// Two flows with identical placeholder/arg structure but different literal verbosity.
	// v1 punished the verbose one ~41% via literalChars-in-denominator; v2 normalizes
	// by total content so the gap narrows (more literal content still lowers the ratio,
	// which is defensible — more hardcoded prose = less generic — but the penalty is mild).
	const terse = flow({
		description: "audit",
		args: { dir: { default: "x" } },
		phases: [{ id: "a", type: "agent", task: "scan {args.dir}", agent: "scout" }],
	});
	const verbose = flow({
		description: "audit",
		args: { dir: { default: "x" } },
		phases: [{ id: "a", type: "agent", task: "Carefully and thoroughly scan {args.dir} and produce a detailed structured report of everything found there.", agent: "scout" }],
	});
	const gt = computeGenerality(terse);
	const gv = computeGenerality(verbose);
	// v2: gap is mild (within 0.3), NOT the ~0.4 collapse v1 produced.
	assert.ok(Math.abs(gt - gv) <= 0.3, `v2 gap should be mild: terse=${gt}, verbose=${gv}`);
	// and both still score reasonably above an all-hardcoded flow
	assert.ok(gv > 0.1, `verbose-but-parameterized should still score >0.1, got ${gv}`);
});

// ---------------------------------------------------------------------------
// deriveMeta
// ---------------------------------------------------------------------------

test("deriveMeta: fresh meta has reuseCount 0, version 1", () => {
	const f = flow({
		phases: [{ id: "a", type: "agent", task: "{args.x}", agent: "scout" }],
		args: { x: { default: "1" } },
	});
	const m = deriveMeta(f, { purpose: "demo", tags: ["audit"] });
	assert.equal(m.schemaVersion, 1);
	assert.equal(m.reuseCount, 0);
	assert.equal(m.version, 1);
	assert.equal(m.purpose, "demo");
	assert.deepEqual(m.tags, ["audit"]);
	assert.equal(m.phaseSignature, "agent");
	assert.equal(m.phaseCount, 1);
	assert.equal(m.embedding, null);
	assert.ok(m.createdAt > 0);
});

test("deriveMeta: bumps version + preserves reuseCount when prevMeta given", () => {
	const f = flow({ phases: [{ id: "a", type: "agent", task: "x" }] });
	const prev = deriveMeta(f, {});
	prev.reuseCount = 5;
	const next = deriveMeta(f, { prevMeta: prev });
	assert.equal(next.version, 2);
	assert.equal(next.reuseCount, 5); // preserved across re-save
	assert.equal(next.phaseSignature, "agent");
});
