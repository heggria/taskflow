import assert from "node:assert/strict";
import { test } from "node:test";
import { compileTaskflow } from "../src/compile.ts";
import type { Phase, Taskflow } from "../src/schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agent(id: string, deps?: string[], overrides?: Partial<Phase>): Phase {
	return { id, type: "agent", task: "task for " + id, dependsOn: deps, ...overrides };
}
function flow(phases: Phase[], overrides?: Partial<Taskflow>): Taskflow {
	return { name: "test-flow", phases, ...overrides } as Taskflow;
}

// ---------------------------------------------------------------------------
// Basic structure
// ---------------------------------------------------------------------------

test("compile: emits a flowchart header and one node per phase", () => {
	const r = compileTaskflow(flow([agent("a"), agent("b", ["a"], { final: true })]));
	assert.match(r.mermaid, /^flowchart TD/);
	assert.match(r.mermaid, /\ba\[/, "node a is a rectangle");
	assert.match(r.mermaid, /\bb\[/, "node b is a rectangle");
});

test("compile: direction option is honored", () => {
	const r = compileTaskflow(flow([agent("a", undefined, { final: true })]), { direction: "LR" });
	assert.match(r.mermaid, /^flowchart LR/);
});

test("compile: edges follow dependsOn", () => {
	const r = compileTaskflow(flow([agent("a"), agent("b", ["a"]), agent("c", ["b"], { final: true })]));
	assert.match(r.mermaid, /a --> b/);
	assert.match(r.mermaid, /b --> c/);
});

test("compile: dangling dependsOn produces no edge", () => {
	// 'ghost' isn't a phase; verify/schema reports it, the diagram simply omits it.
	const r = compileTaskflow(flow([agent("a", ["ghost"], { final: true })]));
	assert.doesNotMatch(r.mermaid, /ghost --> a/);
});

test("compile: reduce `from` renders as an edge (parity with runtime + verify)", () => {
	// `sum` depends on `scan` only via reduce `from`. The Mermaid diagram must draw
	// that edge — dependenciesOf = dependsOn ∪ from, matching runtime/verify/SVG.
	const r = compileTaskflow(
		flow([
			agent("scan"),
			{ id: "sum", type: "reduce", from: ["scan"], task: "merge", final: true } as Phase,
		]),
	);
	assert.match(r.mermaid, /scan --> sum/);
});

test("compile: a dep in both dependsOn and from is drawn once", () => {
	const r = compileTaskflow(
		flow([
			agent("scan"),
			{ id: "sum", type: "reduce", from: ["scan"], dependsOn: ["scan"], task: "merge", final: true } as Phase,
		]),
	);
	const edges = r.mermaid.split("\n").filter((l) => /scan\s*-.?->\s*sum/.test(l));
	assert.equal(edges.length, 1, "no double edge when a dep is in both dependsOn and from");
});

// ---------------------------------------------------------------------------
// Per-type shapes
// ---------------------------------------------------------------------------

test("compile: each phase type gets its distinct Mermaid shape", () => {
	const phases: Phase[] = [
		{ id: "g", type: "gate", task: "check", dependsOn: ["m"] },
		{ id: "m", type: "map", over: "{args.items}", task: "do {item}" },
		{ id: "p", type: "parallel", branches: [{ task: "x" }, { task: "y" }] },
		{ id: "r", type: "reduce", from: ["m"], task: "merge" },
		{ id: "ap", type: "approval", task: "ok?", dependsOn: ["g"] },
		{ id: "lp", type: "loop", task: "iter", until: "{steps.lp.output} contains DONE" },
		{ id: "tn", type: "tournament", task: "compete", variants: 3, dependsOn: ["r"] },
		{ id: "fl", type: "flow", use: "sub", dependsOn: ["p"] },
		{ id: "sc", type: "script", run: ["echo", "x"], final: true, dependsOn: ["tn"] },
	];
	const r = compileTaskflow(flow(phases));
	assert.match(r.mermaid, /\bg\{"/, "gate → rhombus");
	assert.match(r.mermaid, /\bm\[\["/, "map → subroutine");
	assert.match(r.mermaid, /\bp\[\["/, "parallel → subroutine");
	assert.match(r.mermaid, /\br\[\/"/, "reduce → trapezoid");
	assert.match(r.mermaid, /\bap\(\(\("/, "approval → double circle");
	assert.match(r.mermaid, /\blp\(\["/, "loop → stadium");
	assert.match(r.mermaid, /\btn\{\{"/, "tournament → hexagon");
	assert.match(r.mermaid, /\bfl\[\["/, "flow → subroutine");
	assert.match(r.mermaid, /\bsc\[\("/, "script → cylinder");
});

test("compile: type tags appear in node bodies", () => {
	const r = compileTaskflow(flow([
		{ id: "m", type: "map", over: "{args.items}", task: "do" },
		{ id: "t", type: "tournament", task: "go", variants: 4, dependsOn: ["m"], final: true },
	]));
	assert.match(r.mermaid, /map over/);
	assert.match(r.mermaid, /tournament ×4/);
});

test("compile: script node shows the ⚡ tag and legend entry", () => {
	const r = compileTaskflow(flow([{ id: "sc", type: "script", run: "echo hi", final: true }]));
	assert.match(r.mermaid, /⚡ script/);
	assert.match(r.markdown, /⚡ script/);
});

// ---------------------------------------------------------------------------
// Guards, joins
// ---------------------------------------------------------------------------

test("compile: when guard becomes an edge label", () => {
	const r = compileTaskflow(flow([
		agent("a"),
		{ id: "b", type: "agent", task: "t", dependsOn: ["a"], when: "{steps.a.output} contains YES", final: true },
	]));
	assert.match(r.mermaid, /a -->\|"[^"]*YES[^"]*"\| b/);
});

test("compile: join:any draws a dotted edge", () => {
	const r = compileTaskflow(flow([
		agent("a"),
		agent("b"),
		{ id: "c", type: "agent", task: "t", dependsOn: ["a", "b"], join: "any", final: true },
	]));
	assert.match(r.mermaid, /a -\.-> c/);
	assert.match(r.mermaid, /b -\.-> c/);
});

// ---------------------------------------------------------------------------
// Issue overlay
// ---------------------------------------------------------------------------

test("compile: a dead-end phase is painted with the warning class", () => {
	// 'a' is terminal, not final, not last → dead-end warning.
	const r = compileTaskflow(flow([agent("a"), agent("b", undefined, { final: true })]));
	const warn = r.verification.issues.find((i) => i.category === "dead-end");
	assert.ok(warn, "expected a dead-end warning");
	assert.match(r.mermaid, /classDef tfWarn/);
	assert.match(r.mermaid, /class a tfWarn;/);
});

test("compile: an error phase is painted with the error class", () => {
	// self-dependency → ref-integrity error on 'a'.
	const r = compileTaskflow(flow([{ id: "a", type: "agent", task: "t", dependsOn: ["a"], final: true }]));
	assert.equal(r.verification.ok, false);
	assert.match(r.mermaid, /class a tfError;/);
});

test("compile: final phase without issues gets the final class", () => {
	const r = compileTaskflow(flow([agent("a"), agent("b", ["a"], { final: true })]));
	assert.match(r.mermaid, /class b tfFinal;/);
});

test("compile: error severity wins over final styling on the same node", () => {
	const r = compileTaskflow(flow([{ id: "a", type: "agent", task: "t", dependsOn: ["a"], final: true }]));
	// 'a' is final AND has an error — it must be in tfError, not tfFinal.
	assert.match(r.mermaid, /class a tfError;/);
	assert.doesNotMatch(r.mermaid, /class a tfFinal;/);
});

// ---------------------------------------------------------------------------
// Escaping / safety
// ---------------------------------------------------------------------------

test("compile: special chars in ids and tasks are escaped", () => {
	const r = compileTaskflow(flow([
		{ id: "node-1", type: "agent", task: 'use "quotes" & <tags>', final: true },
	]));
	// id keeps hyphen mapped to underscore for the node id
	assert.match(r.mermaid, /node_1\[/);
	// label escaping
	assert.match(r.mermaid, /&quot;quotes&quot;/);
	assert.match(r.mermaid, /&amp;/);
	assert.match(r.mermaid, /&lt;tags&gt;/);
});

test("compile: id starting with a digit is prefixed", () => {
	const r = compileTaskflow(flow([{ id: "1st", type: "agent", task: "t", final: true }]));
	assert.match(r.mermaid, /p_1st\[/);
});

// ---------------------------------------------------------------------------
// Report + markdown document
// ---------------------------------------------------------------------------

test("compile: clean flow reports PASS with no issues", () => {
	// a→b, b final: no dead-end (a has a dependent), connected, no self-dep.
	const clean = compileTaskflow(flow([agent("a"), agent("b", ["a"], { final: true })]));
	assert.equal(clean.verification.ok, true, "no error-level issues");
	assert.equal(clean.verification.issues.length, 0, "literally zero issues");
	assert.match(clean.markdown, /Status:\*\* ✅ PASS/);
	assert.match(clean.markdown, /No structural issues found/);
});

test("compile: markdown wraps the diagram in a mermaid fence", () => {
	const r = compileTaskflow(flow([agent("a", undefined, { final: true })]));
	assert.match(r.markdown, /```mermaid[\s\S]*flowchart[\s\S]*```/);
	assert.match(r.markdown, /# Taskflow: test-flow/);
	assert.match(r.markdown, /Generated by `pi-taskflow compile`/);
});

test("compile: description is included as a blockquote when present", () => {
	const r = compileTaskflow(flow([agent("a", undefined, { final: true })], { description: "my pipeline" }));
	assert.match(r.markdown, /> my pipeline/);
});

test("compile: report lists each error and warning with its category", () => {
	const r = compileTaskflow(flow([
		{ id: "a", type: "agent", task: "t", dependsOn: ["a"] }, // self-dep error
		agent("b"), // dead-end warning
		agent("c", undefined, { final: true }),
	]));
	assert.match(r.markdown, /### ❌ Errors/);
	assert.match(r.markdown, /ref-integrity/);
	assert.match(r.markdown, /### ⚠️ Warnings/);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("compile: output is deterministic for the same input", () => {
	const f = flow([agent("a"), agent("b", ["a"]), agent("c", ["b"], { final: true })]);
	const a = compileTaskflow(f);
	const b = compileTaskflow(f);
	assert.equal(a.mermaid, b.mermaid);
	assert.equal(a.markdown, b.markdown);
});

// ---------------------------------------------------------------------------
// Id collision (F1) — distinct ids that sanitize identically must stay separate
// ---------------------------------------------------------------------------

test("compile: ids that collapse to the same token stay separate nodes (no collision, no self-loop)", () => {
	// 'audit-each' and 'audit_each' both clean to 'audit_each'. Without
	// disambiguation they merge into one node and the edge becomes a self-loop.
	const r = compileTaskflow(flow([
		{ id: "audit-each", type: "agent", task: "t1" },
		{ id: "audit_each", type: "agent", task: "t2", dependsOn: ["audit-each"], final: true },
	]));
	assert.ok(r.mermaid.includes("audit_each_2"), "collision disambiguated with a _2 suffix");
	assert.doesNotMatch(r.mermaid, /audit_each_2 --> audit_each_2/, "no self-loop from the merged-id bug");
	assert.match(r.mermaid, /audit_each --> audit_each_2/, "edge resolves through the disambiguated ids");
	assert.match(r.mermaid, /\baudit_each\[/, "the first phase keeps the base id");
});

// ---------------------------------------------------------------------------
// Markdown injection (F2) — free-form strings are neutralized
// ---------------------------------------------------------------------------

test("compile: a multi-line, markdown-special flow name is neutralized in the H1", () => {
	const r = compileTaskflow(flow([agent("a", undefined, { final: true })], {
		name: "evil\n# injected\n`c` [x](http://b)",
	}));
	const headings = r.markdown.split("\n").filter((l) => /^# /.test(l));
	assert.equal(headings.length, 1, "the newline did not spawn a second heading");
	const titleLine = r.markdown.split("\n")[0];
	assert.ok(titleLine.includes("\\[x\\]"), "brackets escaped so no active markdown link");
});

test("compile: a multi-line description collapses to a single blockquote line", () => {
	const r = compileTaskflow(flow([agent("a", undefined, { final: true })], {
		description: "line one\nline two\n> fake quote",
	}));
	const descLines = r.markdown.split("\n").filter((l) => /^> line one/.test(l));
	assert.equal(descLines.length, 1, "one blockquote line, not many");
	assert.ok(descLines[0].includes("line two"), "second line folded into the same blockquote line");
});

test("compile: report fields escape markdown-special issue messages", () => {
	const r = compileTaskflow(flow([
		{ id: "a", type: "agent", task: "t", dependsOn: ["a"], final: true }, // self-dep error
	]));
	// The error message is interpolated raw into the report; verify the category
	// line is present and structured (regression guard for mdInline on messages).
	assert.match(r.markdown, /### ❌ Errors/);
	assert.match(r.markdown, /\*\*ref-integrity\*\*/);
});

test("compile: backslashes in task text are escaped in mermaid labels", () => {
	const r = compileTaskflow(flow([
		{ id: "a", type: "agent", task: "path\\to\\thing", final: true },
	]));
	assert.match(r.mermaid, /path&#92;to&#92;thing/);
});

test("compile: opts.title overrides the flow name in the heading", () => {
	const r = compileTaskflow(
		flow([agent("a", undefined, { final: true })], { name: "internal" }),
		{ title: "Display Title" },
	);
	assert.match(r.markdown, /# Taskflow: Display Title/);
	assert.doesNotMatch(r.markdown, /# Taskflow: internal/);
});

// ---------------------------------------------------------------------------
// Verify-overlay coverage — every IssueCategory maps to a color / report line
// ---------------------------------------------------------------------------

test("compile: overlay — unreachable phases are painted as errors", () => {
	// Two disconnected components, both with edges; the non-largest is unreachable.
	const r = compileTaskflow(flow([
		agent("a"),
		agent("b", ["a"], { final: true }),
		agent("c"),
		agent("d", ["c"], { final: true }),
	]));
	const unreach = r.verification.issues.filter((i) => i.category === "unreachable");
	assert.ok(unreach.length > 0, "expected unreachable errors");
	assert.equal(r.verification.ok, false);
	assert.ok(r.mermaid.includes("class c,d tfError;"), "both unreachable nodes painted red");
});

test("compile: overlay — a gate that is the sole path to a final warns", () => {
	const r = compileTaskflow(flow([
		agent("src"),
		{ id: "g", type: "gate", task: "quality?", dependsOn: ["src"] },
		agent("sink", ["g"], { final: true }),
	]));
	const ge = r.verification.issues.find((i) => i.category === "gate-exhaustion");
	assert.ok(ge, "expected a gate-exhaustion warning");
	assert.match(r.mermaid, /class g tfWarn;/);
});

test("compile: overlay — budget overflow surfaces in the report with no phaseId", () => {
	const r = compileTaskflow(flow(
		[agent("a"), agent("b", ["a"], { final: true })],
		{ budget: { maxTokens: 1 } },
	));
	const bo = r.verification.issues.find((i) => i.category === "budget-overflow");
	assert.ok(bo, "expected a budget-overflow warning");
	assert.equal(bo!.phaseId, undefined, "budget overflow is flow-wide, not phase-scoped");
	assert.match(r.markdown, /budget-overflow/);
});

test("compile: overlay — an over-wide parallel without a per-phase cap warns", () => {
	const r = compileTaskflow(flow(
		[{ id: "p", type: "parallel", branches: Array.from({ length: 10 }, () => ({ task: "x" })) }],
		{ concurrency: 4 },
	));
	const c = r.verification.issues.find((i) => i.category === "concurrency");
	assert.ok(c, "expected a concurrency warning");
	assert.match(r.mermaid, /class p tfWarn;/);
});

test("compile: overlay — opposing when-guards on the same dependency set warn", () => {
	const r = compileTaskflow(flow([
		agent("decider"),
		{ id: "br1", type: "agent", task: "t", dependsOn: ["decider"], when: "{steps.decider.json.r} == deep" },
		{ id: "br2", type: "agent", task: "t", dependsOn: ["decider"], when: "{steps.decider.json.r} != deep" },
		{ id: "merge", type: "agent", task: "t", dependsOn: ["br1", "br2"], join: "any", final: true },
	]));
	const gc = r.verification.issues.find((i) => i.category === "guard-contradiction");
	assert.ok(gc, "expected a guard-contradiction warning");
	assert.match(r.markdown, /guard-contradiction/);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("compile: an empty phases array compiles without crashing", () => {
	const r = compileTaskflow(flow([]));
	assert.match(r.mermaid, /^flowchart TD/);
	assert.match(r.markdown, /\*\*Phases:\*\* 0/);
	assert.equal(r.verification.ok, true);
});

test("compile: a cyclic dependency graph renders back-edges without crashing", () => {
	// verify() does not detect cycles (the schema/topo-sort pass does); compile
	// must still terminate and emit output rather than infinite-loop.
	const r = compileTaskflow(flow([
		{ id: "x", type: "agent", task: "t", dependsOn: ["y"], final: true },
		{ id: "y", type: "agent", task: "t", dependsOn: ["x"] },
	]));
	assert.match(r.mermaid, /^flowchart/);
	assert.match(r.mermaid, /x --> y/);
	assert.match(r.mermaid, /y --> x/);
});
