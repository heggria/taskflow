/**
 * Pluggable verifier seam — `verifyTaskflow(flow, { verifiers })`.
 *
 * Covers: issue ordering (built-ins first, then verifiers in registration
 * order), warning/error semantics, source/category attribution, fail-closed
 * handling of throwing + malformed verifiers, back-compat (no verifiers ⇒
 * identical output), the compile Mermaid/report overlay, and no-spend runtime
 * blocking on BOTH execution engines (imperative + event kernel).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyTaskflow, type VerifiableFlow, type TaskflowVerifier } from "../src/verify.ts";
import { compileTaskflow } from "../src/compile.ts";
import type { AgentConfig } from "../src/agents.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { canUseEventKernel } from "../src/exec/driver.ts";
import type { Phase, Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agent(id: string, deps?: string[], overrides?: Partial<Phase>): Phase {
	return { id, type: "agent", task: "task for " + id, dependsOn: deps, ...overrides };
}
/** A flow with one built-in dead-end warning on "a" (warning-only ⇒ ok:true). */
function flowWithDeadEnd(): VerifiableFlow {
	return { name: "test", phases: [agent("a"), agent("b"), agent("c", ["b"])] };
}
/** A clean single-final-phase flow (zero built-in issues). */
function cleanFlow(): VerifiableFlow {
	return { name: "test", phases: [agent("a", undefined, { final: true })] };
}

// ---------------------------------------------------------------------------
// Ordering + attribution
// ---------------------------------------------------------------------------

test("verifier: built-in issues precede verifier issues; verifier issues are stamped plugin + source", () => {
	const flow = flowWithDeadEnd(); // built-in dead-end warning on "a"
	const verifier: TaskflowVerifier = {
		name: "lint",
		verify: () => [{ phaseId: "b", message: "checker says no", severity: "warning" }],
	};
	const r = verifyTaskflow(flow, { verifiers: [verifier] });

	// Built-in issue comes first and carries no source.
	assert.equal(r.issues[0].category, "dead-end");
	assert.equal(r.issues[0].source, undefined);

	// Verifier issue comes after, attributed and forced to the plugin category.
	const vi = r.issues[r.issues.length - 1];
	assert.equal(vi.source, "lint");
	assert.equal(vi.category, "plugin");
	assert.equal(vi.severity, "warning");
	assert.equal(vi.phaseId, "b");
	assert.equal(vi.message, "checker says no");
});

test("verifier: multiple verifiers run in registration order", () => {
	const first: TaskflowVerifier = { name: "first", verify: () => [{ message: "one", severity: "warning" }] };
	const second: TaskflowVerifier = { name: "second", verify: () => [{ message: "two", severity: "warning" }] };
	const r = verifyTaskflow(cleanFlow(), { verifiers: [first, second] });
	assert.deepEqual(
		r.issues.map((i) => i.source),
		["first", "second"],
	);
});

// ---------------------------------------------------------------------------
// Warning / error semantics
// ---------------------------------------------------------------------------

test("verifier: a warning keeps ok true; an error flips ok false", () => {
	assert.equal(
		verifyTaskflow(cleanFlow(), {
			verifiers: [{ name: "w", verify: () => [{ message: "meh", severity: "warning" }] }],
		}).ok,
		true,
	);
	assert.equal(
		verifyTaskflow(cleanFlow(), {
			verifiers: [{ name: "e", verify: () => [{ message: "boom", severity: "error" }] }],
		}).ok,
		false,
	);
});

// ---------------------------------------------------------------------------
// Fail-closed: throwing + malformed verifiers
// ---------------------------------------------------------------------------

test("verifier: a throwing verifier is normalized to one error/plugin issue and siblings still run", () => {
	const r = verifyTaskflow(cleanFlow(), {
		verifiers: [
			{ name: "boom", verify: () => { throw new Error("exploded"); } },
			{ name: "good", verify: () => [{ message: "hi", severity: "warning" }] },
		],
	});
	const fail = r.issues.find((i) => i.source === "boom");
	assert.ok(fail, "fail-closed issue emitted for the throwing verifier");
	assert.equal(fail!.severity, "error");
	assert.equal(fail!.category, "plugin");
	assert.match(fail!.message, /boom/);
	assert.match(fail!.message, /exploded/);
	// The sibling verifier still ran.
	assert.ok(r.issues.some((i) => i.source === "good" && i.message === "hi"));
	// The fail-closed issue is error-severity ⇒ the whole result is not ok.
	assert.equal(r.ok, false);
});

test("verifier: a malformed (non-array) return is normalized to a fail-closed error issue", () => {
	const r = verifyTaskflow(cleanFlow(), {
		verifiers: [{ name: "bad", verify: () => "not-an-array" as unknown as [] }],
	});
	const fail = r.issues.find((i) => i.source === "bad");
	assert.ok(fail);
	assert.equal(fail!.severity, "error");
	assert.equal(fail!.category, "plugin");
	assert.match(fail!.message, /non-array/);
	assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// Verifiers receive the sanitized flow (parity with built-in detectors)
// ---------------------------------------------------------------------------

test("verifier: receives the sanitized safeFlow — null/non-object phases are filtered out", () => {
	let seen: VerifiableFlow | undefined;
	const spy: TaskflowVerifier = {
		name: "spy",
		verify: (f) => { seen = f; return []; },
	};
	assert.doesNotThrow(() =>
		verifyTaskflow({ name: "t", phases: [null as unknown as Phase, agent("a", undefined, { final: true })] }, { verifiers: [spy] }),
	);
	assert.equal(seen?.phases.length, 1, "null phase filtered before the verifier sees the flow");
	assert.equal(seen?.phases[0].id, "a");
});

// ---------------------------------------------------------------------------
// Back-compat: the seam is additive
// ---------------------------------------------------------------------------

test("verifier: omitting verifiers, empty array, and undefined all behave identically to the pre-seam API", () => {
	const flow = flowWithDeadEnd();
	const bare = verifyTaskflow(flow);
	const withEmpty = verifyTaskflow(flow, { verifiers: [] });
	const withUndefined = verifyTaskflow(flow, { verifiers: undefined });
	assert.deepEqual(withEmpty.issues, bare.issues);
	assert.deepEqual(withUndefined.issues, bare.issues);
	assert.equal(withEmpty.ok, bare.ok);
});

// ---------------------------------------------------------------------------
// Compile overlay
// ---------------------------------------------------------------------------

test("compile: plugin verifier issues overlay on the Mermaid diagram + report", () => {
	const tf = { name: "t", phases: [agent("a", undefined, { final: true })] } as Taskflow;
	const r = compileTaskflow(tf, {
		verifiers: [{ name: "lint", verify: () => [{ phaseId: "a", message: "suspicious command", severity: "error" }] }],
	});
	assert.equal(r.verification.ok, false);
	// The report carries the attributed message + plugin category.
	assert.match(r.markdown, /suspicious command/);
	assert.match(r.markdown, /plugin/);
	// The error-severity plugin issue paints node "a" with the error class.
	assert.match(r.mermaid, /class a tfError/);
});

// ---------------------------------------------------------------------------
// Runtime: no-spend blocking on BOTH execution engines
// ---------------------------------------------------------------------------

const AGENTS: AgentConfig[] = [{ name: "a", description: "test", systemPrompt: "", source: "user", filePath: "" }];

function mkState(def: Taskflow): RunState {
	return {
		runId: "v-run",
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: "/tmp",
	};
}
/** A runner that records every task it is asked to execute (for no-spend checks). */
function recordingRunner(record: string[]): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task, _o: RunOptions): Promise<RunResult> => {
		record.push(task);
		return {
			agent: agentName,
			task,
			exitCode: 0,
			output: "ok",
			stderr: "",
			usage: { ...emptyUsage(), output: 1 },
			stopReason: "end",
		};
	};
}
function baseDeps(runTask: RuntimeDeps["runTask"], extra: Partial<RuntimeDeps> = {}): RuntimeDeps {
	return { cwd: "/tmp", agents: AGENTS, runTask, persist: () => {}, onProgress: () => {}, ...extra };
}

/** A clean linear chain eligible for BOTH engines (no built-in issues, kernel-admitted). */
const chainDef: Taskflow = {
	name: "vchain",
	phases: [
		{ id: "one", type: "agent", agent: "a", task: "start" },
		{ id: "two", type: "agent", agent: "a", task: "end", dependsOn: ["one"], final: true },
	],
};
const blocker: TaskflowVerifier = {
	name: "block",
	verify: () => [{ phaseId: "one", message: "verifier says stop", severity: "error" }],
};

test("runtime: a blocking verifier aborts the imperative run before any spend", async () => {
	const record: string[] = [];
	const deps = baseDeps(recordingRunner(record), { verifiers: [blocker] });
	const res = await executeTaskflow(mkState(chainDef), deps);
	assert.equal(res.ok, false);
	assert.equal(record.length, 0, "runTask never invoked — zero spend");
	assert.match(res.finalOutput ?? "", /verifier preflight/);
});

test("runtime: a blocking verifier aborts the event-kernel run before any spend", async () => {
	// Sanity: the flow is kernel-eligible, so this exercises the event-kernel
	// dispatch branch (not just the imperative fallback).
	assert.equal(canUseEventKernel(chainDef), true);
	const record: string[] = [];
	const deps = baseDeps(recordingRunner(record), { verifiers: [blocker], eventKernel: true });
	const res = await executeTaskflow(mkState(chainDef), deps);
	assert.equal(res.ok, false);
	assert.equal(record.length, 0, "runTask never invoked — zero spend (event-kernel path)");
	assert.match(res.finalOutput ?? "", /verifier preflight/);
});

test("runtime: a nameless verifier's fail-closed error still blocks the run (category, not source, discriminates)", async () => {
	// Regression: the top-level preflight discriminates plugin issues by
	// category === "plugin", not source !== undefined. A fail-closed error from a
	// verifier without a name is stamped source: undefined but category "plugin";
	// gating on source would silently let it through.
	const record: string[] = [];
	const namelessThrower = {
		name: undefined as unknown as string,
		verify: () => { throw new Error("boom"); },
	} as TaskflowVerifier;
	const deps = baseDeps(recordingRunner(record), { verifiers: [namelessThrower] });
	const res = await executeTaskflow(mkState(chainDef), deps);
	assert.equal(res.ok, false);
	assert.equal(record.length, 0, "zero spend — fail-closed plugin error gates the run even with no source attribution");
});

test("runtime: a warning-only verifier does NOT block the run", async () => {
	const record: string[] = [];
	const warnOnly: TaskflowVerifier = {
		name: "advisory",
		verify: () => [{ phaseId: "one", message: "just a heads up", severity: "warning" }],
	};
	const deps = baseDeps(recordingRunner(record), { verifiers: [warnOnly] });
	const res = await executeTaskflow(mkState(chainDef), deps);
	assert.equal(res.ok, true, "warnings never block at the top level");
	assert.equal(record.length, 2, "both phases executed despite the warning");
});
