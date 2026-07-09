/**
 * S4: erase coverage for remaining phase kinds + A-track gate sugar.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSource } from "../src/build.ts";
import { decompileTaskflow } from "../src/decompile.ts";
import { resolveContainedOut } from "../src/paths.ts";
import { validateTaskflow } from "taskflow-core";

function fmt(r: { diagnostics?: { code: string; message: string }[] }): string {
	return (r.diagnostics ?? []).map((d) => `${d.code}: ${d.message}`).join("\n");
}

test("build: approval", () => {
	const src = `
import { flow, approval } from "taskflow-dsl";
export default flow("ap", () => approval({ request: "Ship it?", final: true }));
`;
	const r = buildSource(src, "ap.tf.ts");
	assert.equal(r.ok, true, fmt(r));
	const p = r.taskflow!.phases![0]!;
	assert.equal(p.type, "approval");
	assert.equal(p.task, "Ship it?");
});

test("build: loop with prev.output template", () => {
	const src = `
import { flow, loop } from "taskflow-dsl";
export default flow("lp", () =>
  loop({
    agent: "executor",
    maxIterations: 3,
    until: "false",
    task: (prev) => \`Improve:\\n\${prev.output}\`,
  }),
);
`;
	const r = buildSource(src, "lp.tf.ts");
	assert.equal(r.ok, true, fmt(r));
	const p = r.taskflow!.phases![0]!;
	assert.equal(p.type, "loop");
	assert.match(String(p.task), /\{steps\.main\.output\}|\{steps\.lp\.output\}|Improve/);
	// body uses loop phase id in {steps.<id>.output}
	assert.match(String(p.task), /\{steps\.[a-z0-9-]+\.output\}/);
});

test("build: tournament variants", () => {
	const src = `
import { flow, tournament } from "taskflow-dsl";
export default flow("tour", () =>
  tournament({
    variants: 2,
    mode: "best",
    agent: "executor",
    judgeAgent: "reviewer",
    task: "Solve the puzzle",
    judge: "Pick best. WINNER: <n>.",
  }),
);
`;
	const r = buildSource(src, "tour.tf.ts");
	assert.equal(r.ok, true, fmt(r));
	assert.equal(r.taskflow!.phases![0]!.type, "tournament");
	assert.equal(r.taskflow!.phases![0]!.variants, 2);
});

test("build: subflow use + expand.nested", () => {
	const src = `
import { flow, agent, subflow, expand, json } from "taskflow-dsl";
export default flow("sf", () => {
  const plan = agent("emit plan", { output: json() });
  const nested = expand.nested(plan.json);
  const saved = subflow("child-flow", { q: "1" }, { dependsOn: ["nested"] });
  return saved;
});
`;
	const r = buildSource(src, "sf.tf.ts");
	assert.equal(r.ok, true, fmt(r));
	const types = r.taskflow!.phases!.map((p) => p.type);
	assert.deepEqual(types, ["agent", "flow", "flow"]);
	const nested = r.taskflow!.phases!.find((p) => p.id === "nested");
	assert.match(String(nested?.def), /steps\.plan\.json/);
	const saved = r.taskflow!.phases!.find((p) => p.id === "saved");
	assert.equal(saved?.use, "child-flow");
});

test("build: gate.automated + gate.scored", () => {
	const src = `
import { flow, agent, gate } from "taskflow-dsl";
export default flow("gs", () => {
  const a = agent("work");
  const auto = gate.automated(a, {
    pass: ["{steps.a.output} contains OK"],
    task: "fallback llm gate",
  });
  return gate.scored(auto, {
    scorers: [{ type: "contains", value: "PASS" }],
    combine: "all",
  });
});
`;
	const r = buildSource(src, "gs.tf.ts");
	assert.equal(r.ok, true, fmt(r));
	const auto = r.taskflow!.phases!.find((p) => p.id === "auto");
	assert.ok(Array.isArray(auto?.eval));
	assert.equal(auto?.task, "fallback llm gate");
	const scored = r.taskflow!.phases!.find((p) => p.id === "phase-2" || p.type === "gate" && p.score);
	const withScore = r.taskflow!.phases!.find((p) => (p as { score?: unknown }).score !== undefined);
	assert.ok(withScore, JSON.stringify(r.taskflow?.phases));
	assert.equal((withScore as { score: { combine: string } }).score.combine, "all");
});

test("negative: unknown option warns", () => {
	const src = `
import { flow, agent } from "taskflow-dsl";
export default flow("u", () => agent("t", { notARealField: 1 } as never));
`;
	// without as never, TS would error at typecheck; source still has property
	const raw = `
import { flow, agent } from "taskflow-dsl";
export default flow("u", () => agent("t", { notARealField: 1 }));
`;
	const r = buildSource(raw, "u.tf.ts");
	// may still validate if unknown stripped
	assert.ok(r.diagnostics.some((d) => d.code === "TFDSL_RUNE_OPTS_UNKNOWN"));
});

test("negative: decompile rejects unknown phase type", () => {
	assert.throws(
		() =>
			decompileTaskflow({
				name: "x",
				phases: [{ id: "r", type: "race" as never, final: true }],
			}),
		/TFDSL_DECOMPILE_UNSUPPORTED/,
	);
});

test("paths: reject escape under cwd", () => {
	const bad = resolveContainedOut("/tmp/proj", "../../etc/passwd");
	assert.equal(bad.ok, false);
	const good = resolveContainedOut("/tmp/proj", "out/a.json");
	assert.equal(good.ok, true);
});

test("validate: built kinds pass core validateTaskflow", () => {
	const src = `
import { flow, agent, map, parallel, gate, reduce, approval, loop, tournament, script, json } from "taskflow-dsl";
export default flow("all", (ctx) => {
  ctx.concurrency(4);
  const a = agent("A", { agent: "scout" });
  const m = map(a, (item) => agent(\`i \${item}\`), { agent: "scout" });
  const p = parallel([agent("b1"), agent("b2")]);
  const g = gate(a, { agent: "reviewer" }, (i) => \`chk \${i.output}\`);
  const r = reduce([m], (parts) => agent(\`sum \${parts.m.output}\`));
  const ap = approval({ request: "ok?" });
  const l = loop({ agent: "executor", maxIterations: 2, until: "false", task: "once" });
  const t = tournament({ variants: 2, agent: "executor", task: "compete", mode: "best" });
  const s = script("echo hi");
  return s;
});
`;
	const r = buildSource(src, "all.tf.ts");
	assert.equal(r.ok, true, fmt(r));
	const v = validateTaskflow(r.taskflow!);
	assert.equal(v.ok, true, v.ok ? "" : v.errors.join("\n"));
});
