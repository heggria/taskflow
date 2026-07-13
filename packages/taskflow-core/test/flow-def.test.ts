/**
 * Tests for runtime dynamic sub-flows: `flow { def }`.
 *
 * A flow phase may carry an inline `def` (instead of `use`) that is resolved at
 * runtime — typically from an upstream phase's JSON output — validated, and
 * executed as a nested sub-flow. On any resolution/validation failure the phase
 * fails-open (defError) without aborting the run.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunResult } from "../src/runner-core.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { MAX_DYNAMIC_MAP_ITEMS, MAX_DYNAMIC_NESTING, MAX_DYNAMIC_PHASES, type Taskflow, validateTaskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test agent", systemPrompt: "", source: "user", filePath: "" },
	{ name: "planner", description: "planner", systemPrompt: "", source: "user", filePath: "" },
];

function mkState(def: Taskflow, args: Record<string, unknown> = {}): RunState {
	return {
		runId: "test-run",
		flowName: def.name,
		def,
		args,
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: "/tmp",
	};
}

function mockRunner(respond: (task: string, agent: string) => string): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task): Promise<RunResult> => ({
		agent: agentName,
		task,
		exitCode: 0,
		output: respond(task, agentName),
		stderr: "",
		usage: { ...emptyUsage(), output: 10, cost: 0.001, turns: 1 },
		stopReason: "end",
		errorMessage: undefined,
	});
}

function baseDeps(runTask: RuntimeDeps["runTask"], extra?: Partial<RuntimeDeps>): RuntimeDeps {
	return { cwd: "/tmp", agents: AGENTS, runTask, persist: () => {}, onProgress: () => {}, ...extra };
}

// ════════════════════════════════════════════════════════════════════
// SCHEMA: use XOR def
// ════════════════════════════════════════════════════════════════════

test("flow{def} schema: use XOR def — neither is an error", () => {
	const v = validateTaskflow({ name: "f", phases: [{ id: "p", type: "flow" }] });
	assert.equal(v.ok, false);
	assert.match(v.errors.join(" "), /requires 'use'.*or 'def'/);
});

test("flow{def} schema: use AND def are mutually exclusive", () => {
	const v = validateTaskflow({
		name: "f",
		phases: [{ id: "p", type: "flow", use: "saved", def: { name: "x", phases: [] } }],
	});
	assert.equal(v.ok, false);
	assert.match(v.errors.join(" "), /mutually exclusive/);
});

test("flow{def} schema: def-only is valid", () => {
	const v = validateTaskflow({
		name: "f",
		phases: [{ id: "p", type: "flow", def: "{steps.x.json}" }],
	});
	assert.equal(v.ok, true);
});

// ════════════════════════════════════════════════════════════════════
// BASIC: upstream phase emits a plan, flow{def} runs it
// ════════════════════════════════════════════════════════════════════

test("flow{def} basic: upstream phase emits a Taskflow, flow runs it and returns its final output", async () => {
	const plan: Taskflow = {
		name: "audit-plan",
		phases: [
			{ id: "step1", type: "agent", agent: "a", task: "audit file 1" },
			{ id: "step2", type: "agent", agent: "a", task: "audit file 2", dependsOn: ["step1"], final: true },
		],
	};
	const def: Taskflow = {
		name: "plan-then-execute",
		phases: [
			{ id: "plan", type: "agent", agent: "planner", task: "make a plan", output: "json" },
			{ id: "run", type: "flow", def: "{steps.plan.json}", dependsOn: ["plan"], final: true },
		],
	};
	const deps = baseDeps(
		mockRunner((t, agent) => {
			if (agent === "planner") return JSON.stringify(plan);
			return `did:${t}`;
		}),
	);
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.run.status, "done");
	assert.equal(res.state.phases.run.defError, undefined);
	// final output is the sub-flow's last phase output
	assert.match(res.finalOutput, /did:audit file 2/);
});

// ════════════════════════════════════════════════════════════════════
// SHAPE WRAPPING: bare array, {phases:[...]}, markdown fence
// ════════════════════════════════════════════════════════════════════

test("flow{def} wrap: bare phases array is auto-wrapped", async () => {
	const arr = [{ id: "only", type: "agent", agent: "a", task: "solo", final: true }];
	const def: Taskflow = {
		name: "wrap-array",
		phases: [
			{ id: "plan", type: "agent", agent: "planner", task: "plan", output: "json" },
			{ id: "run", type: "flow", def: "{steps.plan.json}", dependsOn: ["plan"], final: true },
		],
	};
	const deps = baseDeps(mockRunner((t, agent) => (agent === "planner" ? JSON.stringify(arr) : `ran:${t}`)));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.match(res.finalOutput, /ran:solo/);
});

test("flow{def} wrap: {phases:[...]} object is auto-wrapped", async () => {
	const payload = { phases: [{ id: "only", type: "agent", agent: "a", task: "solo", final: true }] };
	const def: Taskflow = {
		name: "wrap-obj",
		phases: [
			{ id: "plan", type: "agent", agent: "planner", task: "plan", output: "json" },
			{ id: "run", type: "flow", def: "{steps.plan.json}", dependsOn: ["plan"], final: true },
		],
	};
	const deps = baseDeps(mockRunner((t, agent) => (agent === "planner" ? JSON.stringify(payload) : `ran:${t}`)));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.match(res.finalOutput, /ran:solo/);
});

test("flow{def} wrap: markdown-fenced JSON is parsed (safeParse strips the fence)", async () => {
	const arr = [{ id: "only", type: "agent", agent: "a", task: "solo", final: true }];
	const fenced = "```json\n" + JSON.stringify(arr) + "\n```";
	const def: Taskflow = {
		name: "wrap-fence",
		phases: [
			{ id: "plan", type: "agent", agent: "planner", task: "plan", output: "json" },
			{ id: "run", type: "flow", def: "{steps.plan.json}", dependsOn: ["plan"], final: true },
		],
	};
	const deps = baseDeps(mockRunner((t, agent) => (agent === "planner" ? fenced : `ran:${t}`)));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.match(res.finalOutput, /ran:solo/);
});

test("flow{def} inline object literal (author-written, not generated)", async () => {
	const def: Taskflow = {
		name: "inline-literal",
		phases: [
			{
				id: "run",
				type: "flow",
				def: { name: "fixed", phases: [{ id: "x", type: "agent", agent: "a", task: "fixed work", final: true }] },
				final: true,
			},
		],
	};
	const deps = baseDeps(mockRunner((t) => `ran:${t}`));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.match(res.finalOutput, /ran:fixed work/);
});

// ════════════════════════════════════════════════════════════════════
// FAIL-OPEN: malformed / invalid def does not abort the run
// ════════════════════════════════════════════════════════════════════

test("flow{def} fail-open: non-JSON def string sets defError, run is NOT aborted (no optional needed)", async () => {
	const def: Taskflow = {
		name: "bad-json",
		phases: [
			{ id: "plan", type: "agent", agent: "planner", task: "plan" },
			// deliberately NO optional: true — true fail-open must not abort the run
			{ id: "run", type: "flow", def: "{steps.plan.output}", dependsOn: ["plan"] },
			{ id: "after", type: "agent", agent: "a", task: "carry on", dependsOn: ["run"], final: true },
		],
	};
	// planner returns prose, not JSON
	const deps = baseDeps(mockRunner((t, agent) => (agent === "planner" ? "just some prose, no json" : `ok:${t}`)));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true, "run must not be aborted by a bad def");
	// fail-open: phase resolves as done with a defError diagnostic + empty output
	assert.equal(res.state.phases.run.status, "done");
	assert.ok(res.state.phases.run.defError, "defError should be set");
	assert.equal(res.state.phases.run.output, "");
	// downstream phase that depends on the failed-open flow still runs
	assert.equal(res.state.phases.after.status, "done");
});

test("flow{def} fail-open: def with a dependency cycle is rejected (defError), upstream output preserved", async () => {
	const cyclic = {
		name: "cyclic",
		phases: [
			{ id: "x", type: "agent", agent: "a", task: "x", dependsOn: ["y"] },
			{ id: "y", type: "agent", agent: "a", task: "y", dependsOn: ["x"] },
		],
	};
	const def: Taskflow = {
		name: "cycle-def",
		phases: [
			{ id: "plan", type: "agent", agent: "planner", task: "plan", output: "json" },
			{ id: "run", type: "flow", def: "{steps.plan.json}", dependsOn: ["plan"], final: true },
		],
	};
	const deps = baseDeps(mockRunner((t, agent) => (agent === "planner" ? JSON.stringify(cyclic) : `ran:${t}`)));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.match(res.state.phases.run.defError ?? "", /cycle/i);
	// upstream planner output is preserved
	assert.ok(res.state.phases.plan.output);
});

test("flow{def} fail-open: def with duplicate phase ids is rejected", async () => {
	const dup = {
		name: "dup",
		phases: [
			{ id: "x", type: "agent", agent: "a", task: "x1" },
			{ id: "x", type: "agent", agent: "a", task: "x2" },
		],
	};
	const def: Taskflow = {
		name: "dup-def",
		phases: [
			{ id: "plan", type: "agent", agent: "planner", task: "plan", output: "json" },
			{ id: "run", type: "flow", def: "{steps.plan.json}", dependsOn: ["plan"], final: true },
		],
	};
	const deps = baseDeps(mockRunner((t, agent) => (agent === "planner" ? JSON.stringify(dup) : `ran:${t}`)));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.match(res.state.phases.run.defError ?? "", /duplicate/i);
});

test("flow{def} fail-open: primitive JSON (number/null) is rejected as unrecognized shape", async () => {
	for (const prim of ["42", "null", '"hello"', "true"]) {
		const def: Taskflow = {
			name: "prim-def",
			phases: [
				{ id: "plan", type: "agent", agent: "planner", task: "plan", output: "json" },
				{ id: "run", type: "flow", def: "{steps.plan.json}", dependsOn: ["plan"], final: true },
			],
		};
		const deps = baseDeps(mockRunner((_t, agent) => (agent === "planner" ? prim : "x")));
		const res = await executeTaskflow(mkState(def), deps);
		assert.equal(res.ok, true, `primitive ${prim} must fail-open`);
		assert.match(res.state.phases.run.defError ?? "", /not a Taskflow|parse/i);
	}
});

test("flow{def} fail-open: a def with a disconnected sub-component is rejected by verifyTaskflow", async () => {
	// Main DAG: a -> b (b final). A disconnected pair c -> d has internal edges but
	// no connection to the main DAG -> verifyTaskflow flags it as an `error`.
	const disconnected = {
		name: "disc",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "a" },
			{ id: "b", type: "agent", agent: "a", task: "b", dependsOn: ["a"], final: true },
			{ id: "c", type: "agent", agent: "a", task: "c" },
			{ id: "d", type: "agent", agent: "a", task: "d", dependsOn: ["c"] },
		],
	};
	const def: Taskflow = {
		name: "verify-def",
		phases: [
			{ id: "plan", type: "agent", agent: "planner", task: "plan", output: "json" },
			{ id: "run", type: "flow", def: "{steps.plan.json}", dependsOn: ["plan"], final: true },
		],
	};
	const deps = baseDeps(mockRunner((t, agent) => (agent === "planner" ? JSON.stringify(disconnected) : `ran:${t}`)));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	// verifyTaskflow flags the disconnected component as an error → fail-open
	assert.match(res.state.phases.run.defError ?? "", /verif|disconnected/i);
});

// ════════════════════════════════════════════════════════════════════
// EMPTY PLAN: no-op (planner decided there is nothing to do)
// ════════════════════════════════════════════════════════════════════

test("flow{def} empty: zero-phase plan is a no-op success (not a validation failure)", async () => {
	const def: Taskflow = {
		name: "empty-plan",
		phases: [
			{ id: "plan", type: "agent", agent: "planner", task: "plan", output: "json" },
			{ id: "run", type: "flow", def: "{steps.plan.json}", dependsOn: ["plan"], final: true },
		],
	};
	const deps = baseDeps(mockRunner((t, agent) => (agent === "planner" ? JSON.stringify({ phases: [] }) : `ran:${t}`)));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.run.status, "done");
	assert.equal(res.state.phases.run.defError, undefined);
	assert.equal(res.state.phases.run.output, "");
});

// ════════════════════════════════════════════════════════════════════
// NESTING GUARD: inline def that itself spawns inline defs
// ════════════════════════════════════════════════════════════════════

test("flow{def} nesting: inline depth guard fires at MAX_DYNAMIC_NESTING (observable at the boundary)", async () => {
	// Drive executeTaskflow with a _stack already holding MAX_DYNAMIC_NESTING `def:`
	// frames; a single top-level flow{def} must then trip the depth cap immediately,
	// so the defError is observable at the top-level boundary (not buried in a sub-run).
	const preStack = Array.from({ length: MAX_DYNAMIC_NESTING }, (_v, i) => `def:level-${i}`);
	const def: Taskflow = {
		name: "depth-boundary",
		phases: [
			{
				id: "run",
				type: "flow",
				def: { name: "x", phases: [{ id: "leaf", type: "agent", agent: "a", task: "leaf", final: true }] } as unknown as Taskflow,
				final: true,
			} as Taskflow["phases"][number],
		],
	};
	const deps = baseDeps(mockRunner((t) => `ran:${t}`), { _stack: preStack });
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.run.status, "done"); // fail-open, not crash
	assert.match(res.state.phases.run.defError ?? "", /nesting/i);
});

test("flow{def} nesting: deeply self-nesting inline defs terminate (no infinite recursion)", async () => {
	function nest(depth: number): Taskflow {
		if (depth === 0) {
			return { name: `leaf`, phases: [{ id: "leaf", type: "agent", agent: "a", task: "leaf work", final: true }] };
		}
		return {
			name: `level-${depth}`,
			phases: [{ id: "down", type: "flow", def: nest(depth - 1) as unknown as Taskflow, final: true } as Taskflow["phases"][number]],
		};
	}
	const deep = nest(MAX_DYNAMIC_NESTING + 2);
	const def: Taskflow = {
		name: "nesting-root",
		phases: [{ id: "run", type: "flow", def: deep as unknown as Taskflow, final: true } as Taskflow["phases"][number]],
	};
	const deps = baseDeps(mockRunner((t) => `ran:${t}`));
	const res = await executeTaskflow(mkState(def), deps);
	// The hard guarantee observable at the top level is TERMINATION (no hang/OOM).
	assert.ok(res.state.status === "completed" || res.state.status === "failed");
});

// ════════════════════════════════════════════════════════════════════════════
// DOWNSTREAM CONSUMPTION: flow{def} output feeds a later phase
// ════════════════════════════════════════════════════════════════════════════

test("flow{def} downstream: a non-final flow{def} output feeds a later phase", async () => {
	const plan: Taskflow = {
		name: "sub",
		phases: [{ id: "s", type: "agent", agent: "a", task: "produce VALUE", final: true }],
	};
	const def: Taskflow = {
		name: "downstream",
		phases: [
			{ id: "plan", type: "agent", agent: "planner", task: "plan", output: "json" },
			{ id: "run", type: "flow", def: "{steps.plan.json}", dependsOn: ["plan"] },
			{ id: "consume", type: "agent", agent: "a", task: "got: {steps.run.output}", dependsOn: ["run"], final: true },
		],
	};
	const deps = baseDeps(
		mockRunner((t, agent) => {
			if (agent === "planner") return JSON.stringify(plan);
			return `did[${t}]`;
		}),
	);
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.run.status, "done");
	// the consume phase saw the sub-flow's final output interpolated in
	assert.match(res.state.phases.consume.output ?? "", /produce VALUE/);
});

// ════════════════════════════════════════════════════════════════════════════
// LOOP + flow{def}: data-dependent iterative replanning
// ════════════════════════════════════════════════════════════════════════════

test("loop + flow{def}: each round's plan depends on the previous round's result, until done", async () => {
	// A loop body that emits JSON each round; round N reads {previous.output}.
	// Round 1 -> not done; round 2 -> done. The loop stops on `until`.
	let round = 0;
	const def: Taskflow = {
		name: "iterative",
		phases: [
			{
				id: "investigate",
				type: "loop",
				agent: "planner",
				maxIterations: 5,
				output: "json",
				until: "{steps.investigate.json.done} == true",
				task: "prev: {previous.output}",
			},
			{ id: "report", type: "agent", agent: "a", task: "report {steps.investigate.output}", dependsOn: ["investigate"], final: true },
		],
	};
	const deps = baseDeps(
		mockRunner((t, agent) => {
			if (agent === "planner") {
				round++;
				// round 2 references the round-1 result text in its input (data-dependent)
				if (round >= 2) return JSON.stringify({ done: true, summary: "converged" });
				return JSON.stringify({ done: false, findings: "round1" });
			}
			return `report:${t}`;
		}),
	);
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.investigate.loop?.stop, "until");
	assert.ok((res.state.phases.investigate.loop?.iterations ?? 0) >= 2);
	assert.match(res.state.phases.report.output ?? "", /converged/);
});

// ════════════════════════════════════════════════════════════════════════════
// SECURITY HARDENING: breadth caps, cwd containment, budget clamp
// ════════════════════════════════════════════════════════════════════════════

test("flow{def} security: a generated def with too many phases is rejected (breadth cap)", async () => {
	const phases = Array.from({ length: MAX_DYNAMIC_PHASES + 5 }, (_v, i) => ({
		id: `p-${i}`,
		type: "agent",
		agent: "a",
		task: `t${i}`,
	}));
	const huge = { name: "huge", phases };
	const def: Taskflow = {
		name: "breadth",
		phases: [
			{ id: "plan", type: "agent", agent: "planner", task: "plan", output: "json" },
			{ id: "run", type: "flow", def: "{steps.plan.json}", dependsOn: ["plan"], final: true },
		],
	};
	const deps = baseDeps(mockRunner((_t, agent) => (agent === "planner" ? JSON.stringify(huge) : "x")));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.match(res.state.phases.run.defError ?? "", /too many phases/i);
});

test("flow{def} security: a generated phase with an escaping cwd is rejected", async () => {
	const escaping = {
		name: "escape",
		phases: [{ id: "x", type: "agent", agent: "a", task: "read secrets", cwd: "/etc", final: true }],
	};
	const def: Taskflow = {
		name: "cwd-escape",
		phases: [
			{ id: "plan", type: "agent", agent: "planner", task: "plan", output: "json" },
			{ id: "run", type: "flow", def: "{steps.plan.json}", dependsOn: ["plan"], final: true },
		],
	};
	const deps = baseDeps(mockRunner((_t, agent) => (agent === "planner" ? JSON.stringify(escaping) : "x")));
	// run cwd is /tmp; /etc escapes it
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.match(res.state.phases.run.defError ?? "", /cwd selection is not allowed/i);
});

test("flow{def} security: generated context cannot pre-read files outside the invocation root", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-dynamic-context-root-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tf-dynamic-context-outside-"));
	const secret = path.join(outside, "secret.txt");
	fs.writeFileSync(secret, "OUTSIDE_SECRET_SHOULD_NOT_LEAK");
	const tasks: string[] = [];
	try {
		const plan = {
			name: "context-escape",
			phases: [{ id: "read", type: "agent", agent: "a", context: [secret], task: "summarize", final: true }],
		};
		const def: Taskflow = {
			name: "context-parent",
			phases: [
				{ id: "plan", type: "agent", agent: "planner", task: "plan", output: "json" },
				{ id: "run", type: "flow", def: "{steps.plan.json}", dependsOn: ["plan"], final: true },
			],
		};
		const runState = mkState(def);
		runState.cwd = root;
		const res = await executeTaskflow(runState, {
			...baseDeps(async (_cwd, _agents, agent, task) => {
				tasks.push(task);
				return {
					agent,
					task,
					exitCode: 0,
					output: agent === "planner" ? JSON.stringify(plan) : "unexpected",
					stderr: "",
					usage: emptyUsage(),
					stopReason: "end",
				};
			}),
			cwd: root,
		});
		assert.equal(res.ok, true, "generated definition rejection stays fail-open at the parent flow phase");
		assert.match(res.state.phases.run.defError ?? "", /context file pre-reads are not allowed/);
		assert.equal(tasks.some((task) => task.includes("OUTSIDE_SECRET_SHOULD_NOT_LEAK")), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("flow{def} security: a generated phase with high concurrency is rejected", async () => {
	const greedy = { name: "greedy", concurrency: 999, phases: [{ id: "x", type: "agent", agent: "a", task: "t", final: true }] };
	const def: Taskflow = {
		name: "conc",
		phases: [
			{ id: "plan", type: "agent", agent: "planner", task: "plan", output: "json" },
			{ id: "run", type: "flow", def: "{steps.plan.json}", dependsOn: ["plan"], final: true },
		],
	};
	const deps = baseDeps(mockRunner((_t, agent) => (agent === "planner" ? JSON.stringify(greedy) : "x")));
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.match(res.state.phases.run.defError ?? "", /concurrency too high/i);
});

test("flow{def} security: prototype-pollution payload does not pollute Object.prototype", async () => {
	// A crafted def carrying a __proto__ own-key must not leak onto the prototype.
	const evil = JSON.parse('{"name":"e","__proto__":{"polluted":true},"phases":[{"id":"x","type":"agent","agent":"a","task":"t","final":true}]}');
	const def: Taskflow = {
		name: "proto",
		phases: [{ id: "run", type: "flow", def: evil as unknown as Taskflow, final: true } as Taskflow["phases"][number]],
	};
	const deps = baseDeps(mockRunner((t) => `ran:${t}`));
	await executeTaskflow(mkState(def), deps);
	assert.equal(({} as Record<string, unknown>).polluted, undefined, "Object.prototype must not be polluted");
});

test("flow{def} security: validateTaskflow dynamic mode caps phases/concurrency/cwd; static mode does not", () => {
	const many = { name: "m", phases: Array.from({ length: MAX_DYNAMIC_PHASES + 1 }, (_v, i) => ({ id: `p-${i}`, type: "agent", agent: "a", task: "t", final: i === MAX_DYNAMIC_PHASES })) };
	// static (authored) validation: no breadth cap
	const staticV = validateTaskflow(many);
	assert.equal(staticV.ok, true, "authored flows are not breadth-capped");
	// dynamic validation: breadth cap fires
	const dynV = validateTaskflow(many, { dynamic: true, cwd: "/tmp" });
	assert.equal(dynV.ok, false);
	assert.match(dynV.errors.join(" "), /too many phases/i);
});

// ════════════════════════════════════════════════════════════════════
// CACHE IDENTITY: different generated plans → different results
// ════════════════════════════════════════════════════════════════════

test("flow{def} cache: identity includes resolved def content (different plan → re-executed)", async () => {
	let plannerCall = 0;
	const planA: Taskflow = {
		name: "p",
		phases: [{ id: "s", type: "agent", agent: "a", task: "task A", final: true }],
	};
	const planB: Taskflow = {
		name: "p",
		phases: [{ id: "s", type: "agent", agent: "a", task: "task B", final: true }],
	};
	const def: Taskflow = {
		name: "cache-identity",
		phases: [
			{ id: "plan", type: "agent", agent: "planner", task: "plan", output: "json" },
			{ id: "run", type: "flow", def: "{steps.plan.json}", dependsOn: ["plan"], final: true },
		],
	};
	const ranTasks: string[] = [];
	const deps = baseDeps(
		mockRunner((t, agent) => {
			if (agent === "planner") {
				plannerCall++;
				return JSON.stringify(plannerCall === 1 ? planA : planB);
			}
			ranTasks.push(t);
			return `ran:${t}`;
		}),
	);
	const r1 = await executeTaskflow(mkState(def), deps);
	const r2 = await executeTaskflow(mkState(def), deps);
	assert.equal(r1.ok, true);
	assert.equal(r2.ok, true);
	// Two distinct plans were executed (no false cross-plan cache hit).
	assert.ok(ranTasks.some((t) => t.includes("task A")));
	assert.ok(ranTasks.some((t) => t.includes("task B")));
});

// ════════════════════════════════════════════════════════════════════════════
// MAP FAN-OUT CAP: truncation in a dynamic sub-flow must NOT block the run
// ════════════════════════════════════════════════════════════════════════════

test("flow{def} security: dynamic map fan-out is truncated but the run is NOT marked budget-blocked", async () => {
	// A generated sub-flow whose map fans out over more than MAX_DYNAMIC_MAP_ITEMS.
	const big = Array.from({ length: MAX_DYNAMIC_MAP_ITEMS + 50 }, (_v, i) => i);
	const plan = {
		name: "fanout",
		phases: [
			{ id: "items", type: "agent", agent: "a", task: "emit", output: "json" },
			{ id: "work", type: "map", agent: "a", over: "{steps.items.json}", task: "do {item}", dependsOn: ["items"], final: true },
		],
	};
	const def: Taskflow = {
		name: "map-cap",
		phases: [
			{ id: "plan", type: "agent", agent: "planner", task: "plan", output: "json" },
			{ id: "run", type: "flow", def: "{steps.plan.json}", dependsOn: ["plan"], final: true },
		],
	};
	const deps = baseDeps(
		mockRunner((t, agent) => {
			if (agent === "planner") return JSON.stringify(plan);
			if (t.includes("emit")) return JSON.stringify(big);
			return `did:${t}`;
		}),
	);
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	// The run completes normally — truncation is a safety cap, not a budget overrun.
	assert.equal(res.state.status, "completed");
	assert.notEqual(res.state.status, "blocked");
});
