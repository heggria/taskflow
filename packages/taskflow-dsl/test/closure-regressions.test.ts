import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildFile, buildSource } from "../src/build.ts";
import { checkFile } from "../src/check.ts";
import { decompileTaskflow } from "../src/decompile.ts";
import { resolveContainedOut, resolveInput } from "../src/paths.ts";
import { compileTaskflowToFlowIR, hashFlowIR, type Taskflow } from "taskflow-core";

function errors(result: { diagnostics: Array<{ code: string; message: string }> }): string {
	return result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n");
}

test("closure: duplicate explicit phase ids fail closed", () => {
	const result = buildSource(`
import { flow, agent } from "taskflow-dsl";
export default flow("duplicate", () => {
  const one = agent("one", { id: "same" });
  const two = agent("two", { id: "same" });
  return two;
});
`);
	assert.equal(result.ok, false);
	assert.ok(result.diagnostics.some((d) => d.code === "TFDSL_PHASE_ID_DUPLICATE"), errors(result));
});

test("closure: source bindings resolve to emitted ids in templates and dependencies", () => {
	const result = buildSource(`
import { flow, agent } from "taskflow-dsl";
export default flow("bindings", () => {
  const first = agent("one", { id: "first-step" });
  return agent(\`use \${first.output}\`, { id: "final-step" });
});
`);
	assert.equal(result.ok, true, errors(result));
	assert.deepEqual(result.taskflow?.phases?.map((p) => p.id), ["first-step", "final-step"]);
	assert.equal(result.taskflow?.phases?.[1]?.task, "use {steps.first-step.output}");
	assert.deepEqual(result.taskflow?.phases?.[1]?.dependsOn, ["first-step"]);
});

test("closure: json<T> infers primitives, arrays, objects, and optional properties", () => {
	const result = buildSource(`
import { flow, agent, json } from "taskflow-dsl";
export default flow("typed-json", () => {
  const count = agent("count", { output: json<number>() });
  return agent("rows", { output: json<{ name: string; score?: number; ok: boolean }[]>() });
});
`);
	assert.equal(result.ok, true, errors(result));
	assert.deepEqual(result.taskflow?.phases?.[0]?.expect, { type: "number" });
	assert.deepEqual(result.taskflow?.phases?.[1]?.expect, {
		type: "array",
		items: {
			type: "object",
			properties: {
				name: { type: "string" },
				score: { type: "number" },
				ok: { type: "boolean" },
			},
			required: ["name", "ok"],
		},
	});
});

test("closure: json<T> named and complex types fail closed", () => {
	const result = buildSource(`
import { flow, agent, json } from "taskflow-dsl";
type Result = { ok: boolean };
export default flow("complex-json", () => agent("x", { output: json<Result>() }));
`);
	assert.equal(result.ok, false);
	assert.ok(result.diagnostics.some((d) => d.code === "TFDSL_JSON_TYPE_UNSUPPORTED"), errors(result));
});

test("closure: inline defs accept static Taskflow shapes and reject dynamic values", () => {
	const good = buildSource(`
import { flow, expand } from "taskflow-dsl";
export default flow("inline", () => expand({
  name: "child",
  phases: [{ id: "child-main", type: "agent", task: "ok", final: true }],
}));
`);
	assert.equal(good.ok, true, errors(good));
	assert.equal(typeof good.taskflow?.phases?.[0]?.def, "object");
	const bad = buildSource(`
import { flow, expand } from "taskflow-dsl";
const dynamic = "x";
export default flow("inline", () => expand({ name: dynamic, phases: [] }));
`);
	assert.equal(bad.ok, false);
	assert.ok(bad.diagnostics.some((d) => d.code === "TFDSL_INLINE_DEF_DYNAMIC"), errors(bad));
});

test("closure: decompile preserves ids, collisions, real final, fields, and FlowIR", () => {
	const def: Taskflow = {
		name: "roundtrip",
		description: "full fidelity",
		version: 2,
		agentScope: "both",
		strictInterpolation: true,
		contextSharing: true,
		incremental: true,
		budget: { maxTokens: 1000 },
		concurrency: 3,
		phases: [
			{
				id: "a-b",
				type: "agent",
				task: "first",
				agent: "executor",
				model: "m",
				thinking: "high",
				tools: ["read"],
				cwd: "/tmp",
				output: "json",
				expect: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
				retry: { max: 2, backoffMs: 1, factor: 2 },
				timeout: 1000,
				optional: true,
				idempotent: false,
				context: ["README.md"],
				contextLimit: 10,
				cache: { scope: "off" },
				shareContext: true,
			},
			{
				id: "a.b",
				type: "agent",
				task: "use {steps.a-b.output}",
				dependsOn: ["a-b"],
				when: "true",
				join: "all",
				final: true,
			},
			{ id: "class", type: "script", run: ["printf", "%s"], input: "hello" },
		],
	};
	const source = decompileTaskflow(def);
	assert.match(source, /id: "a-b"/);
	assert.match(source, /id: "a\.b"/);
	assert.match(source, /return a_b_2;/);
	const rebuilt = buildSource(source, "roundtrip.tf.ts", { irHash: true });
	assert.equal(rebuilt.ok, true, errors(rebuilt));
	assert.deepEqual(rebuilt.taskflow, def);
	assert.equal(
		rebuilt.irHash,
		hashFlowIR(compileTaskflowToFlowIR(def).canonical),
	);
});

test("closure: decompile/build round-trips all twelve phase kinds", () => {
	const def: Taskflow = {
		name: "all-kinds-roundtrip",
		phases: [
			{ id: "seed", type: "agent", task: "seed", output: "json", expect: { type: "object" } },
			{ id: "mapped", type: "map", over: "{steps.seed.json}", as: "item", task: "map {item}", dependsOn: ["seed"], agent: "executor", output: "text" },
			{ id: "parallel-work", type: "parallel", branches: [{ task: "a", agent: "a" }, { task: "b" }], dependsOn: ["seed"], concurrency: 2 },
			{ id: "quality-gate", type: "gate", task: "review", agent: "reviewer", dependsOn: ["mapped"], onBlock: "halt", eval: ["true"] },
			{ id: "reduced", type: "reduce", from: ["mapped", "parallel-work"], task: "reduce", dependsOn: ["mapped", "parallel-work"], agent: "executor" },
			{ id: "approval-step", type: "approval", task: "Approve?", dependsOn: ["reduced"] },
			{ id: "child-flow", type: "flow", use: "saved-child", with: { q: "{steps.reduced.output}" }, dependsOn: ["reduced"] },
			{ id: "loop-step", type: "loop", task: "improve", until: "false", maxIterations: 2, convergence: false, reflexion: true, agent: "executor", dependsOn: ["reduced"] },
			{ id: "contest", type: "tournament", task: "solve", variants: 2, mode: "best", judge: "pick", judgeAgent: "reviewer", agent: "executor", dependsOn: ["reduced"] },
			{ id: "shell-step", type: "script", run: ["printf", "%s"], input: "hello", dependsOn: ["reduced"] },
			{ id: "race-step", type: "race", branches: [{ task: "fast" }, { task: "slow", agent: "executor" }], cancelLosers: false, dependsOn: ["reduced"] },
			{ id: "expand-step", type: "expand", def: "{steps.seed.json}", expandMode: "graft", maxNodes: 20, dependsOn: ["seed"], final: true },
		],
	};
	const source = decompileTaskflow(def);
	const rebuilt = buildSource(source, "all-kinds.tf.ts", { irHash: true });
	assert.equal(rebuilt.ok, true, errors(rebuilt));
	assert.deepEqual(rebuilt.taskflow, def);
	assert.equal(rebuilt.irHash, hashFlowIR(compileTaskflowToFlowIR(def).canonical));
	const dir = fs.mkdtempSync(path.join(process.cwd(), "packages/taskflow-dsl/test/.tmp-all-kinds-typecheck-"));
	try {
		const file = path.join(dir, "all-kinds.tf.ts");
		fs.writeFileSync(file, source);
		assert.equal(checkFile(file, { cwd: process.cwd() }).ok, true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("closure: JSONC comments and trailing commas are accepted", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-dsl-jsonc-"));
	try {
		const file = path.join(dir, "flow.jsonc");
		fs.writeFileSync(file, `{
  // comment
  "name": "jsonc",
  "phases": [{ "id": "main", "type": "agent", "task": "ok", "final": true, }],
}`);
		const result = buildFile(file);
		assert.equal(result.ok, true, errors(result));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("closure: syntax errors and missing taskflow-dsl module shape are diagnostics, not throws", () => {
	assert.doesNotThrow(() => buildSource(`import { flow } from "taskflow-dsl"; export default flow("x", () => {`));
	const syntax = buildSource(`import { flow } from "taskflow-dsl"; export default flow("x", () => {`);
	assert.equal(syntax.ok, false);
	assert.ok(syntax.diagnostics.some((d) => d.code.startsWith("TS")), errors(syntax));
	const missingImport = buildSource(`export default flow("x", () => agent("x"));`);
	assert.equal(missingImport.ok, false);
	assert.ok(missingImport.diagnostics.some((d) => d.code === "TFDSL_IMPORT_MISSING"), errors(missingImport));
});

test("closure: file and path failures are structured and symlink escapes are rejected", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-dsl-path-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-dsl-outside-"));
	try {
		const missing = buildFile(path.join(dir, "missing.tf.ts"));
		assert.equal(missing.ok, false);
		assert.equal(missing.diagnostics[0]?.code, "TFDSL_IO_MISSING");
		fs.symlinkSync(outside, path.join(dir, "escape"));
		assert.equal(resolveContainedOut(dir, "escape/result.json").ok, false);
		assert.throws(() => resolveInput(dir, "escape/input.tf.ts"), /symlink/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("closure: DSL package build cannot mask compiler or README failures", () => {
	const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
		scripts: { build: string };
	};
	assert.doesNotMatch(pkg.scripts.build, /\|\|\s*true/);
	assert.match(pkg.scripts.build, /copy-readme\.mjs taskflow-dsl/);
	const copyScript = fs.readFileSync(new URL("../../../scripts/copy-readme.mjs", import.meta.url), "utf8");
	assert.match(copyScript, /"taskflow-dsl"/);
});

test("closure: dynamic options, dependencies, and body control flow fail closed", () => {
	for (const source of [
		`import { flow, agent } from "taskflow-dsl";
const model = "m";
export default flow("dynamic-option", () => agent("x", { model }));`,
		`import { flow, agent } from "taskflow-dsl";
export default flow("dynamic-dep", () => { const a = agent("a"); return agent("b", { dependsOn: [missing] }); });`,
		`import { flow, agent } from "taskflow-dsl";
export default flow("control", () => { const a = agent("a"); if (true) agent("lost"); return a; });`,
	]) {
		const result = buildSource(source);
		assert.equal(result.ok, false, JSON.stringify(result.taskflow));
	}
});

test("closure: unresolved gate inputs, invalid ctx values, and extra arguments fail closed", () => {
	for (const source of [
		`import { flow, gate } from "taskflow-dsl";
export default flow("gate", () => gate(missing, {}, () => "review"));`,
		`import { flow, agent } from "taskflow-dsl";
export default flow("ctx", (ctx) => { ctx.concurrency({}); ctx.budget(1); return agent("x"); });`,
		`import { flow, agent } from "taskflow-dsl";
export default flow("flow-arity", {}, () => agent("x"), 123);`,
		`import { flow, agent } from "taskflow-dsl";
export default flow("agent-arity", () => agent("x", {}, 123));`,
		`import { flow, agent, parallel } from "taskflow-dsl";
export default flow("branch-arity", () => parallel([agent("x", {}, 123)]));`,
		`import { flow, parallel } from "taskflow-dsl";
export default flow("nested-import", () => parallel([agent("x")]));`,
		`import { flow, agent } from "taskflow-dsl";
export default flow("json-arity", () => agent("x", { output: json<string>(123) }));`,
	]) {
		const result = buildSource(source);
		assert.equal(result.ok, false, JSON.stringify(result.taskflow));
	}
});

test("closure: spreads and dynamic inline structures fail closed", () => {
	for (const source of [
		`import { flow, expand } from "taskflow-dsl";
const fragment = { phases: [{ id: "child", type: "agent", task: "work", final: true }] };
export default flow("inline", () => expand({ ...fragment }));`,
		`import { flow, agent } from "taskflow-dsl";
const opts = { contextSharing: true };
export default flow("flow-opts", { ...opts }, () => agent("x"));`,
		`import { flow, agent } from "taskflow-dsl";
const opts = { contextSharing: true };
export default flow("flow-opts-ref", opts, () => agent("x"));`,
		`import { flow, agent } from "taskflow-dsl";
export default flow("flow-opts-type", { contextSharing: "yes" }, () => agent("x"));`,
		`import { flow, subflow } from "taskflow-dsl";
const topic = "real";
export default flow("with", () => subflow("child", { topic }));`,
		`import { flow, agent, tournament } from "taskflow-dsl";
const branches = [agent("a"), agent("b")];
export default flow("branches", () => tournament({ branches, task: "judge" }));`,
	]) {
		const result = buildSource(source);
		assert.equal(result.ok, false, JSON.stringify(result.taskflow));
	}
});

test("closure: parallel destructure rejects options it cannot preserve", () => {
	const result = buildSource(`
import { flow, agent, parallel } from "taskflow-dsl";
export default flow("parallel-opts", () => {
  const seed = agent("seed");
  const [a, b] = parallel([agent("a"), agent("b")], { concurrency: 1, dependsOn: [seed] });
  return b;
});
`);
	assert.equal(result.ok, false);
	assert.ok(result.diagnostics.some((d) => d.code === "TFDSL_PARALLEL_DESTRUCTURE_OPTS"), errors(result));
});

test("closure: map inner agent execution options are preserved", () => {
	const result = buildSource(`
import { flow, agent, map, json } from "taskflow-dsl";
export default flow("map-options", () => {
  const seed = agent("seed", { output: json<string[]>() });
  return map(seed, (item) => agent("work", {
    model: "m", thinking: "high", tools: ["read"], cwd: "/tmp",
    retry: { max: 2 }, timeout: 1000, context: ["README.md"], shareContext: true,
  }));
});
`);
	assert.equal(result.ok, true, errors(result));
	const mapped = result.taskflow?.phases?.[1];
	assert.equal(mapped?.model, "m");
	assert.equal(mapped?.thinking, "high");
	assert.deepEqual(mapped?.tools, ["read"]);
	assert.equal(mapped?.cwd, "/tmp");
	assert.deepEqual(mapped?.retry, { max: 2 });
	assert.equal(mapped?.timeout, 1000);
	assert.deepEqual(mapped?.context, ["README.md"]);
	assert.equal(mapped?.shareContext, true);
});

test("closure: check typechecks by default and decompile emits type-correct options", () => {
	const dir = fs.mkdtempSync(path.join(process.cwd(), "packages/taskflow-dsl/test/.tmp-closure-typecheck-"));
	try {
		const invalid = path.join(dir, "invalid.tf.ts");
		fs.writeFileSync(invalid, `import { flow, agent } from "taskflow-dsl";\nconst bad: number = "wrong";\nexport default flow("invalid", () => agent("ok"));\n`);
		assert.equal(checkFile(invalid, { cwd: process.cwd() }).ok, false);
		assert.equal(checkFile(invalid, { cwd: process.cwd(), typecheck: false }).ok, true);

		const roundtrip = path.join(dir, "roundtrip.tf.ts");
		fs.writeFileSync(roundtrip, decompileTaskflow({
			name: "typed-decompile",
			phases: [{
				id: "main", type: "agent", task: "x", context: ["README.md"], contextLimit: 10,
				cache: { scope: "off" }, shareContext: true, final: true,
			}],
		}));
		assert.equal(checkFile(roundtrip, { cwd: process.cwd() }).ok, true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
