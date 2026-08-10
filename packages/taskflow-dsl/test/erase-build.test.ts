import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildSource } from "../src/build.ts";
import { checkFile, checkSource } from "../src/check.ts";
import { decompileTaskflow } from "../src/decompile.ts";
import { flow, agent, TfDslEraseOnlyError, type ArgSpec } from "../src/index.ts";
import { compileTaskflowToFlowIR, hashFlowIR, validateTaskflow } from "taskflow-core";

test("runes throw TFDSL_ERASE_ONLY at runtime", () => {
	assert.throws(() => flow("x", () => agent("hi")), (e: unknown) => {
		return e instanceof TfDslEraseOnlyError || (e instanceof Error && e.message.includes("TFDSL_ERASE_ONLY"));
	});
});

test("ArgSpec is a discriminated union at compile time", () => {
	// @ts-expect-error number args cannot declare a string default
	const bad: ArgSpec = { type: "number", default: "not-a-number" };
	assert.equal(typeof bad, "object");
});

test("build: hello agent", () => {
	const src = `
import { flow, agent } from "taskflow-dsl";
export default flow("hello", () => agent("Say hello to {args.name}"));
`;
	const r = buildSource(src, "hello.tf.ts");
	assert.equal(r.ok, true, format(r));
	assert.equal(r.taskflow?.name, "hello");
	assert.equal(r.taskflow?.phases?.length, 1);
	assert.equal(r.taskflow?.phases?.[0]?.type, "agent");
	assert.match(String(r.taskflow?.phases?.[0]?.task), /Say hello/);
	assert.ok(r.irHash?.startsWith("ir:"));
});

test("build: typed relative-path arg and exact cwd bridge survive DSL + FlowIR", () => {
	const src = `
import { flow, agent } from "taskflow-dsl";
export default flow("workspace-review", (ctx) => {
  ctx.args.declare({ package: { type: "relative-path", required: true } });
  return agent("Review this package", { cwd: "{args.package}" });
});
`;
	const r = buildSource(src, "workspace-review.tf.ts", { irHash: true });
	assert.equal(r.ok, true, format(r));
	assert.deepEqual(r.taskflow?.args?.package, { type: "relative-path", required: true });
	assert.equal(r.taskflow?.phases[0]?.cwd, "{args.package}");
	const validation = validateTaskflow(r.taskflow);
	assert.equal(validation.ok, true, validation.errors.join("; "));
	const ir = compileTaskflowToFlowIR(r.taskflow!);
	assert.deepEqual(ir.canonical.nodes[0]?.payload?.cwdUse, {
		kind: "invocation-relative-arg",
		arg: "package",
		access: "read-write",
		intent: "existing-directory",
	});
	assert.match(r.irHash ?? "", /^ir:[0-9a-f]{64}$/);
	const sourceAgain = decompileTaskflow(r.taskflow!);
	assert.match(sourceAgain, /"type":\s*"relative-path"/);
	assert.match(sourceAgain, /cwd:\s*"\{args\.package\}"/);
	const rebuilt = buildSource(sourceAgain, "workspace-review-roundtrip.tf.ts");
	assert.equal(rebuilt.ok, true, format(rebuilt));
	assert.deepEqual(rebuilt.taskflow, r.taskflow);
});

test("build: agent map reduce chain + templates", () => {
	const src = `
import { flow, agent, map, reduce, json } from "taskflow-dsl";
export default flow("audit", (ctx) => {
  ctx.budget({ maxUSD: 2 });
  const discover = agent("List files under {args.dir}", {
    agent: "scout",
    output: json(),
  });
  const each = map(discover, (item) => agent(\`Audit \${item.path}\`, { agent: "analyst" }));
  return reduce([each], (p) => agent(\`Summary \${p.each.output}\`));
});
`;
	const r = buildSource(src, "audit.tf.ts");
	assert.equal(r.ok, true, format(r));
	assert.equal(r.taskflow?.name, "audit");
	assert.ok(r.taskflow?.budget);
	const types = (r.taskflow?.phases ?? []).map((p) => p.type);
	assert.deepEqual(types, ["agent", "map", "reduce"]);
	const mapPh = r.taskflow?.phases?.find((p) => p.type === "map");
	assert.match(String(mapPh?.task), /\{item\.path\}/);
	assert.match(String(mapPh?.over), /steps\.discover/);
	const red = r.taskflow?.phases?.find((p) => p.type === "reduce");
	assert.equal(red?.final, true);
});

test("build: parallel + script", () => {
	const src = `
import { flow, agent, parallel, script } from "taskflow-dsl";
export default flow("p", () => {
  const par = parallel([
    agent("auth"),
    agent("perf"),
  ]);
  const sh = script(["echo", "ok"], { dependsOn: ["par"] });
  return sh;
});
`;
	const r = buildSource(src, "p.tf.ts");
	assert.equal(r.ok, true, format(r));
	const types = (r.taskflow?.phases ?? []).map((p) => p.type);
	assert.ok(types.includes("parallel"));
	assert.ok(types.includes("script"));
});

test("build: race erases to type race", () => {
	const src = `
import { flow, agent, race } from "taskflow-dsl";
export default flow("r", () => race([agent("fast path"), agent("slow path")], { cancelLosers: true }));
`;
	const r = buildSource(src, "r.tf.ts");
	assert.equal(r.ok, true, format(r));
	assert.equal(r.taskflow?.phases?.[0]?.type, "race");
	assert.equal(r.taskflow?.phases?.[0]?.branches?.length, 2);
});

test("check: ok for hello", () => {
	const src = `import { flow, agent } from "taskflow-dsl";
export default flow("hello", () => agent("hi"));`;
	const r = checkSource(src);
	assert.equal(r.ok, true, format(r));
});

test("check: typed json output, item fields, and phase handles typecheck", () => {
	const dir = fs.mkdtempSync(path.join(process.cwd(), "packages/taskflow-dsl/test/.tmp-typecheck-"));
	try {
		const file = path.join(dir, "typed.tf.ts");
		fs.writeFileSync(
			file,
			`
import { flow, agent, map, reduce, json, expand } from "taskflow-dsl";
export default flow("typed", () => {
  const discover = agent("list", { output: json<{ path: string }[]>() });
  const each = map(discover, (item) => agent(\`Audit \${item.path}\`));
  const nested = expand.nested(discover.json);
  return reduce([each, nested], (parts) => agent(\`Summary \${parts.each.output} \${parts.nested.output}\`));
});
`,
		);
		const r = checkFile(file, { typecheck: true, cwd: process.cwd() });
		assert.equal(r.ok, true, format(r));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("parity: DSL build hash matches hand JSON twin (map + json + templates)", () => {
	const src = `
import { flow, agent, map, json } from "taskflow-dsl";
export default flow("twin", () => {
  const discover = agent("list", { agent: "scout", output: json() });
  const each = map(discover, (item) => agent(\`Audit \${item.path}\`, { agent: "analyst" }));
  return each;
});
`;
	const r = buildSource(src, "twin.tf.ts", { irHash: true });
	assert.equal(r.ok, true, format(r));
	const hand = {
		name: "twin",
		phases: [
			{
				id: "discover",
				type: "agent",
				agent: "scout",
				task: "list",
				output: "json",
				expect: { type: "object" },
			},
			{
				id: "each",
				type: "map",
				over: "{steps.discover.json}",
				task: "Audit {item.path}",
				agent: "analyst",
				dependsOn: ["discover"],
				final: true,
			},
		],
	};
	assert.equal(validateTaskflow(hand).ok, true, validateTaskflow(hand).errors?.join("\n"));
	const h1 = r.irHash!;
	const h2 = hashFlowIR(compileTaskflowToFlowIR(hand as never).canonical);
	assert.match(h1, /^ir:[0-9a-f]{64}$/);
	assert.match(h2, /^ir:[0-9a-f]{64}$/);
	assert.equal(h1, h2, `FlowIR hash mismatch\nDSL=${h1}\nhand=${h2}\nDSL phases=${JSON.stringify(r.taskflow?.phases, null, 2)}`);
});

test("build: gate lambda (i) => template with i.output", () => {
	const src = `
import { flow, agent, gate } from "taskflow-dsl";
export default flow("g", () => {
  const a = agent("work");
  return gate(a, { agent: "reviewer" }, (i) => \`Check:\\n\${i.output}\`);
});
`;
	const r = buildSource(src, "g.tf.ts");
	assert.equal(r.ok, true, format(r));
	const g = r.taskflow?.phases?.find((p) => p.type === "gate");
	assert.match(String(g?.task), /\{steps\.a\.output\}/);
});

test("decompile: round-trip shape", () => {
	const def = {
		name: "d",
		phases: [{ id: "main", type: "agent" as const, task: "hello", final: true }],
	};
	assert.equal(validateTaskflow(def).ok, true);
	const src = decompileTaskflow(def);
	assert.match(src, /export default flow/);
	assert.match(src, /agent\(/);
});

test("register: explicit dependsOn unions with auto-wired template deps", () => {
	const src = `
import { flow, agent } from "taskflow-dsl";
export default flow("u", () => {
  const a = agent("A");
  const extra = agent("extra work", { dependsOn: ["a"] });
  // auto-dep via \${a.output}; explicit dependsOn also lists extra
  return agent(\`see \${a.output}\`, { dependsOn: ["extra"], final: true });
});
`;
	const r = buildSource(src, "union-deps.tf.ts");
	assert.equal(r.ok, true, format(r));
	const last = r.taskflow?.phases?.find((p) => p.final);
	const deps = new Set(last?.dependsOn ?? []);
	assert.ok(deps.has("a"), `expected auto dep a, got ${[...deps]}`);
	assert.ok(deps.has("extra"), `expected explicit dep extra, got ${[...deps]}`);
});

test("unknown rune hard-errors (bound and bare)", () => {
	const bound = buildSource(
		`
import { flow, agent } from "taskflow-dsl";
export default flow("x", () => {
  const z = mystery("nope");
  return agent("ok");
});
`,
		"unknown-bound.tf.ts",
	);
	assert.equal(bound.ok, false);
	assert.ok((bound.diagnostics ?? []).some((d) => d.code === "TFDSL_RUNE_UNKNOWN"));

	const bare = buildSource(
		`
import { flow, agent } from "taskflow-dsl";
export default flow("x", () => {
  mystery();
  return agent("ok");
});
`,
		"unknown-bare.tf.ts",
	);
	assert.equal(bare.ok, false);
	assert.ok((bare.diagnostics ?? []).some((d) => d.code === "TFDSL_RUNE_UNKNOWN"));
});

test("non-agent branch in race/parallel hard-errors TFDSL_BRANCH_KIND", () => {
	const race = buildSource(
		`
import { flow, agent, race, script } from "taskflow-dsl";
export default flow("r", () => race([agent("a"), script(["echo", "x"])]));
`,
		"race-branch.tf.ts",
	);
	assert.equal(race.ok, false);
	assert.ok((race.diagnostics ?? []).some((d) => d.code === "TFDSL_BRANCH_KIND"), format(race));

	const par = buildSource(
		`
import { flow, agent, parallel, script } from "taskflow-dsl";
export default flow("p", () => parallel([agent("a"), script(["echo", "x"])]));
`,
		"par-branch.tf.ts",
	);
	assert.equal(par.ok, false);
	assert.ok((par.diagnostics ?? []).some((d) => d.code === "TFDSL_BRANCH_KIND"), format(par));
});

test("decompile: race/expand imports + object def fail-closed + dependsOn preserved", () => {
	const withRace = decompileTaskflow({
		name: "r",
		phases: [
			{
				id: "q",
				type: "race",
				branches: [
					{ task: "fast", agent: "a" },
					{ task: "slow", agent: "a" },
				],
				cancelLosers: false,
				final: true,
			},
		],
	});
	assert.match(withRace, /import \{[^}]*\brace\b/);
	assert.match(withRace, /cancelLosers: false/);

	const withExpand = decompileTaskflow({
		name: "e",
		phases: [
			{ id: "plan", type: "agent", task: "plan" },
			{
				id: "grow",
				type: "expand",
				def: "{steps.plan.json}",
				expandMode: "graft",
				dependsOn: ["plan"],
				final: true,
			},
		],
	});
	assert.match(withExpand, /import \{[^}]*\bexpand\b/);
	assert.match(withExpand, /dependsOn: \["plan"\]/);
	assert.match(withExpand, /expandMode: "graft"/);

	assert.throws(
		() =>
			decompileTaskflow({
				name: "bad",
				phases: [
					{
						id: "g",
						type: "expand",
						def: { name: "inner", phases: [{ id: "c", type: "agent", task: "x" }] },
						final: true,
					},
				],
			}),
		/TFDSL_DECOMPILE_UNSUPPORTED/,
	);
});

function format(r: { diagnostics?: { code: string; message: string }[] }): string {
	return (r.diagnostics ?? []).map((d) => `${d.code}: ${d.message}`).join("\n");
}
