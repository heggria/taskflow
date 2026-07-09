import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSource } from "../src/build.ts";
import { checkSource } from "../src/check.ts";
import { decompileTaskflow } from "../src/decompile.ts";
import { flow, agent, TfDslEraseOnlyError } from "../src/index.ts";
import { compileTaskflowToFlowIR, hashFlowIR, validateTaskflow } from "taskflow-core";

test("runes throw TFDSL_ERASE_ONLY at runtime", () => {
	assert.throws(() => flow("x", () => agent("hi")), (e: unknown) => {
		return e instanceof TfDslEraseOnlyError || (e instanceof Error && e.message.includes("TFDSL_ERASE_ONLY"));
	});
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

test("build: race is unsupported error", () => {
	const src = `
import { flow, agent, race } from "taskflow-dsl";
export default flow("r", () => race([agent("a"), agent("b")]));
`;
	const r = buildSource(src, "r.tf.ts");
	assert.equal(r.ok, false);
	assert.ok(r.diagnostics.some((d) => d.code === "TFDSL_PHASE_UNSUPPORTED"));
});

test("check: ok for hello", () => {
	const src = `import { flow, agent } from "taskflow-dsl";
export default flow("hello", () => agent("hi"));`;
	const r = checkSource(src);
	assert.equal(r.ok, true, format(r));
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
				as: "item",
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

function format(r: { diagnostics?: { code: string; message: string }[] }): string {
	return (r.diagnostics ?? []).map((d) => `${d.code}: ${d.message}`).join("\n");
}
