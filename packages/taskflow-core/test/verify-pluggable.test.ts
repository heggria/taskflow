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
import { verifyTaskflow, pluginVerifierErrors, type VerifiableFlow, type TaskflowVerifier } from "../src/verify.ts";
import { compileTaskflow } from "../src/compile.ts";
import type { CacheStore } from "../src/cache.ts";
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

// ---------------------------------------------------------------------------
// Child-flow dispatch parity — the no-spend gate covers nested flows on BOTH
// engines (review of #84, issue 1: event-kernel saved-flow previously bypassed).
// ---------------------------------------------------------------------------

/** A saved child flow the parent will `use`. Single agent phase ⇒ kernel-eligible. */
const savedChild: Taskflow = {
	name: "child",
	phases: [{ id: "c1", type: "agent", agent: "a", task: "run inside child" }],
};
/** A verifier that blocks ONLY when the flow being verified is the child. */
const childOnlyBlocker: TaskflowVerifier = {
	name: "childOnly",
	verify: (f) => (f.name === "child" ? [{ phaseId: "c1", message: "child flow forbidden", severity: "error" }] : []),
};
const parentUsingChild: Taskflow = {
	name: "parent",
	phases: [{ id: "run-child", type: "flow", use: "child", final: true }],
};
function childLoader(name: string): Taskflow | undefined {
	return name === "child" ? savedChild : undefined;
}

test("runtime: a blocking verifier on a SAVED-flow child aborts the imperative run before child spend", async () => {
	// Imperative path: the saved flow recurses through executeTaskflow, whose
	// top-level preflight blocks on the child. Makes the plumbing explicit.
	const record: string[] = [];
	const deps = baseDeps(recordingRunner(record), { verifiers: [childOnlyBlocker], loadFlow: childLoader });
	const res = await executeTaskflow(mkState(parentUsingChild), deps);
	assert.equal(res.ok, false);
	assert.equal(record.length, 0, "child never dispatched — zero spend (imperative)");
	// The verifier message lands in the failed flow phase's error (the parent's
	// finalOutput is "(no output)" for a failed final phase on the imperative path).
	assert.match(res.state.phases["run-child"]?.error ?? "", /verifier preflight/);
});

test("runtime: a blocking verifier on a SAVED-flow child aborts the event-kernel run before child spend", async () => {
	// THE reproduction from review of #84: previously the event kernel returned
	// ok:true and ran the child (runNested had no plugin preflight). Now runNested
	// is the centralized chokepoint for both inline-def and saved-use children.
	assert.equal(canUseEventKernel(parentUsingChild, childLoader), true);
	const record: string[] = [];
	const deps = baseDeps(recordingRunner(record), {
		verifiers: [childOnlyBlocker],
		loadFlow: childLoader,
		eventKernel: true,
	});
	const res = await executeTaskflow(mkState(parentUsingChild), deps);
	assert.equal(res.ok, false);
	assert.equal(record.length, 0, "child never dispatched — zero spend (event-kernel path)");
	assert.match(res.finalOutput ?? "", /verifier preflight/);
});

// ---------------------------------------------------------------------------
// Cache/reuse parity — the preflight fires before a cached child is reused
// (review of #84, issue 1: "including before cache/resume reuse").
// ---------------------------------------------------------------------------

/** An in-memory CacheStore stand-in: isolated per instance (no disk, no
 *  project-root walk via findProjectFlowsDir), so a cross-run cache test is
 *  deterministic on every host regardless of tmpdir/home layout. */
function memCacheStore(): CacheStore {
	const map = new Map<string, Record<string, unknown>>();
	return {
		get: (key: string) => map.get(key) ?? null,
		put: (entry: Record<string, unknown> & { key: string }) => {
			map.set(entry.key, entry);
		},
		clear: () => {
			const n = map.size;
			map.clear();
			return n;
		},
	} as unknown as CacheStore;
}

test("runtime: a blocking verifier on a child still blocks when the child result is cached (no cache-reuse bypass)", async () => {
	const cacheableChild: Taskflow = {
		name: "child",
		phases: [{ id: "c1", type: "agent", agent: "a", task: "cached work" }],
	};
	const parentCached: Taskflow = {
		name: "parent",
		phases: [{ id: "run-child", type: "flow", use: "child", final: true }],
	};
	const loader = (n: string): Taskflow | undefined => (n === "child" ? cacheableChild : undefined);
	const store = memCacheStore();

	// Run 1 — no verifiers: primes the cross-run cache (parent flow phase + child).
	const record1: string[] = [];
	const r1 = await executeTaskflow(
		mkState(parentCached),
		baseDeps(recordingRunner(record1), { loadFlow: loader, cacheStore: store, cacheScopeDefault: "cross-run" }),
	);
	assert.equal(r1.ok, true);
	assert.equal(record1.length, 1, "run 1 executed the child's agent once");

	// Run 2 — register a blocker on the child. Without the preflight-before-cache
	// the cached parent-flow result would be reused and the verifier bypassed.
	const record2: string[] = [];
	const r2 = await executeTaskflow(
		mkState(parentCached),
		baseDeps(recordingRunner(record2), {
			loadFlow: loader,
			cacheStore: store,
			cacheScopeDefault: "cross-run",
			verifiers: [childOnlyBlocker],
		}),
	);
	assert.equal(r2.ok, false, "a cached child must not bypass the verifier");
	assert.equal(record2.length, 0, "zero new spend on run 2");
	assert.match(r2.state.phases["run-child"]?.error ?? "", /verifier preflight/);
});

test("runtime: a blocking verifier on an INLINE-DEF child aborts the event-kernel run before child spend", async () => {
	// Inline def whose parsed name the verifier blocks on. After removing the
	// redundant step-kinds verify, runNested is the single preflight chokepoint,
	// so the inline-def branch is covered too (and verifiers run once, not twice).
	const parentInline: Taskflow = {
		name: "parentInline",
		phases: [
			{
				id: "run-inline",
				type: "flow",
				def: { name: "inline-child", phases: [{ id: "i1", type: "agent", agent: "a", task: "x" }] },
				final: true,
			},
		],
	};
	const inlineBlocker: TaskflowVerifier = {
		name: "inlineOnly",
		verify: (f) => (f.name === "inline-child" ? [{ message: "inline child forbidden", severity: "error" }] : []),
	};
	assert.equal(canUseEventKernel(parentInline), true);
	const record: string[] = [];
	const deps = baseDeps(recordingRunner(record), { verifiers: [inlineBlocker], eventKernel: true });
	const res = await executeTaskflow(mkState(parentInline), deps);
	assert.equal(res.ok, false);
	assert.equal(record.length, 0, "inline child never dispatched — zero spend (event-kernel path)");
	assert.match(res.finalOutput ?? "", /verifier preflight/);
});

test("runtime: a blocking verifier on an INLINE-DEF child aborts the IMPERATIVE run before child spend", async () => {
	// Cross-engine parity with the test above. Previously the imperative inline-def
	// path fail-opened (defFailOpen -> status:'done' -> res.ok=true), silently
	// swallowing the host's policy block; only the event kernel fail-closed. Now
	// plugin errors fail-close on both engines (built-in errors still fail-open).
	const parentInline: Taskflow = {
		name: "parentInline",
		phases: [
			{
				id: "run-inline",
				type: "flow",
				def: { name: "inline-child", phases: [{ id: "i1", type: "agent", agent: "a", task: "x" }] },
				final: true,
			},
		],
	};
	const inlineBlocker: TaskflowVerifier = {
		name: "inlineOnly",
		verify: (f) => (f.name === "inline-child" ? [{ message: "inline child forbidden", severity: "error" }] : []),
	};
	// No eventKernel flag -> imperative path (the hasDef branch in executePhaseInner).
	const record: string[] = [];
	const deps = baseDeps(recordingRunner(record), { verifiers: [inlineBlocker] });
	const res = await executeTaskflow(mkState(parentInline), deps);
	assert.equal(res.ok, false, "imperative: a plugin block fail-closes (parity with the event kernel)");
	assert.equal(record.length, 0, "inline child never dispatched — zero spend (imperative path)");
	assert.match(res.state.phases["run-inline"]?.error ?? "", /verifier preflight/);
});

// ---------------------------------------------------------------------------
// Issue 2: a verifier cannot mutate the real execution plan.
// ---------------------------------------------------------------------------

test("verifier: receives a deep-frozen snapshot — it cannot mutate the real plan or affect later verifiers", () => {
	const flow: VerifiableFlow = {
		name: "t",
		phases: [{ id: "a", type: "agent", task: "SAFE", final: true }],
		budget: { maxTokens: 100 },
	};
	const originalTask = flow.phases[0].task;
	const originalBudget = flow.budget!.maxTokens;

	const mutator: TaskflowVerifier = {
		name: "mutator",
		verify: (f) => {
			// Attempt to rewrite a phase task + raise the budget cap. On a frozen
		// snapshot this is either silently ignored (sloppy) or throws (strict) —
		// either way the real plan must come out unchanged.
			try {
				(f.phases[0] as { task: string }).task = "MUTATED";
				(f.budget as { maxTokens: number }).maxTokens = 9_999_999;
			} catch {
				/* strict-mode TypeError on a frozen object — expected */
			}
			return [];
		},
	};
	let spySawTask: unknown;
	const spy: TaskflowVerifier = {
		name: "spy",
		verify: (f) => {
			spySawTask = f.phases[0].task;
			return [];
		},
	};

	verifyTaskflow(flow, { verifiers: [mutator, spy] });

	// The real execution plan is unchanged.
	assert.equal(flow.phases[0].task, originalTask);
	assert.equal(flow.budget!.maxTokens, originalBudget);
	// A sibling verifier observed the un-mutated value (snapshot is frozen, so a
	// mutation by one verifier cannot leak into the snapshot another sees).
	assert.equal(spySawTask, "SAFE");
});

// ---------------------------------------------------------------------------
// Issue 3: malformed-verifier fail-closed handling is complete.
// ---------------------------------------------------------------------------

test("verifier: a null entry in the registry is fail-closed and siblings still run", () => {
	// Previously: [null, good] → try block threw on v.verify, catch re-read
	// v.name (null) → second TypeError → good never ran.
	const good: TaskflowVerifier = { name: "good", verify: () => [{ message: "hi", severity: "warning" }] };
	const r = verifyTaskflow(cleanFlow(), {
		verifiers: [null as unknown as TaskflowVerifier, good],
	});
	const fail = r.issues.find((i) => i.message.includes("malformed"));
	assert.ok(fail, "null entry normalized to a fail-closed malformed/plugin error");
	assert.equal(fail!.severity, "error");
	assert.equal(fail!.category, "plugin");
	assert.ok(r.issues.some((i) => i.source === "good" && i.message === "hi"), "sibling verifier still ran");
	assert.equal(r.ok, false);
});

test("verifier: a non-array registry is normalized to a single fail-closed error", () => {
	const r = verifyTaskflow(cleanFlow(), {
		verifiers: "not-an-array" as unknown as TaskflowVerifier[],
	});
	assert.equal(r.ok, false);
	assert.ok(r.issues.some((i) => i.category === "plugin" && i.message.includes("must be an array")));
});

test("verifier: an entry whose verify is not a function is fail-closed", () => {
	const r = verifyTaskflow(cleanFlow(), {
		verifiers: [{ name: "shapeless", verify: "nope" as unknown as () => [] }],
	});
	const fail = r.issues.find((i) => i.source === "shapeless");
	assert.ok(fail);
	assert.equal(fail!.severity, "error");
	assert.match(fail!.message, /malformed/);
	assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// Issue 4: an unknown plugin phaseId cannot inject Mermaid syntax.
// ---------------------------------------------------------------------------

test("compile: a plugin phaseId not present in the DAG cannot inject Mermaid syntax via the class statement", () => {
	const tf = { name: "t", phases: [agent("a", undefined, { final: true })] } as Taskflow;
	// A malicious plugin-supplied phaseId carrying a newline + a classDef
	// directive. Previously emitted raw into `class <id> tfError;`.
	const evil = "a\nclassDef x fill:#fff\n";
	const r = compileTaskflow(tf, {
		verifiers: [{ name: "evil", verify: () => [{ phaseId: evil, message: "x", severity: "error" }] }],
	});
	assert.equal(r.verification.ok, false);
	// The real node "a" is NOT painted (the plugin issue named an unknown id).
	assert.doesNotMatch(r.mermaid, /class a tfError/);
	// And the injected classDef directive did not leak into the diagram.
	assert.doesNotMatch(r.mermaid, /classDef x/);
	// The finding still appears (escaped) in the report, attributed to "evil".
	assert.match(r.markdown, /evil/);
});

// ---------------------------------------------------------------------------
// Hardening pass (on top of #84): budget-clamp parity across engines,
// "never throws" fail-closed, and single-run (no redundant verification).
// ---------------------------------------------------------------------------

// A saved-use child that DECLARES a budget larger than its parent caps.
const bigBudgetChild: Taskflow = {
	name: "child",
	budget: { maxUSD: 100 },
	phases: [{ id: "c1", type: "agent", agent: "a", task: "big-budget child work" }],
};
const parentWithBudgetCap: Taskflow = {
	name: "parent",
	budget: { maxUSD: 30 },
	phases: [{ id: "rc", type: "flow", use: "child", final: true }],
};
const bigBudgetLoader = (n: string): Taskflow | undefined => (n === "child" ? bigBudgetChild : undefined);

test("runtime: a budget-policy verifier sees the DECLARED child budget on both engines (no clamp divergence)", async () => {
	// The verifier must observe the child's declared budget (100), not the value
	// clampSubFlowBudget tightens to the parent's cap (30). Before the fix the
	// event kernel verified the clamped def and saw 30.
	assert.equal(canUseEventKernel(parentWithBudgetCap, bigBudgetLoader), true, "flow is kernel-eligible");
	const observed: Record<string, number | undefined> = {};
	const observer: TaskflowVerifier = {
		name: "cap-observer",
		verify: (f) => {
			if (f.name === "child") observed.child = f.budget?.maxUSD;
			return [];
		},
	};
	for (const eventKernel of [false, true]) {
		observed.child = undefined;
		await executeTaskflow(
			mkState(parentWithBudgetCap),
			baseDeps(recordingRunner([]), { verifiers: [observer], loadFlow: bigBudgetLoader, eventKernel }),
		);
		assert.equal(observed.child, 100, `${eventKernel ? "event-kernel" : "imperative"} saw the DECLARED budget, not the clamped 30`);
	}
});

test("runtime: a blocking budget-policy verifier stops a child from spending on BOTH engines", async () => {
	// The no-spend guarantee: a child whose declared budget violates policy is
	// blocked before any agent runs, on both engines. (Before the fix the event
	// kernel saw the clamped value and let the child spend.)
	assert.equal(canUseEventKernel(parentWithBudgetCap, bigBudgetLoader), true);
	const cap: TaskflowVerifier = {
		name: "cap",
		verify: (f) => (f.budget?.maxUSD ?? 0) > 50 ? [{ message: "declares too much budget", severity: "error" }] : [],
	};
	for (const eventKernel of [false, true]) {
		const record: string[] = [];
		const res = await executeTaskflow(
			mkState(parentWithBudgetCap),
			baseDeps(recordingRunner(record), { verifiers: [cap], loadFlow: bigBudgetLoader, eventKernel }),
		);
		assert.equal(record.length, 0, `${eventKernel ? "event-kernel" : "imperative"}: child never dispatched (zero spend)`);
		assert.equal(res.ok, false, `${eventKernel ? "event-kernel" : "imperative"}: run fails (saved-use fail-closes)`);
	}
});

test("runtime: an inline-def child's declared budget is also seen unclamped on the event kernel", async () => {
	// Same parity check for the inline-def path (step-kinds passes the declared
	// `wrapped`, not a pre-clamped def, to runNested).
	const parentInlineBudget: Taskflow = {
		name: "parent",
		budget: { maxUSD: 30 },
		phases: [
			{
				id: "rc",
				type: "flow",
				def: { name: "inline-child", budget: { maxUSD: 100 }, phases: [{ id: "i1", type: "agent", agent: "a", task: "inline big-budget" }] },
				final: true,
			},
		],
	};
	assert.equal(canUseEventKernel(parentInlineBudget), true);
	const observed: Record<string, number | undefined> = {};
	const observer: TaskflowVerifier = {
		name: "cap-observer",
		verify: (f) => {
			if (f.name === "inline-child") observed.c = f.budget?.maxUSD;
			return [];
		},
	};
	await executeTaskflow(mkState(parentInlineBudget), baseDeps(recordingRunner([]), { verifiers: [observer], eventKernel: true }));
	assert.equal(observed.c, 100, "event-kernel inline-def saw the DECLARED budget, not the clamped 30");
});

test("runtime: a plugin verifier runs exactly ONCE per child on each engine (no redundant preflight)", async () => {
	// Regression guard: a non-cached flow-phase child must not be verified 2-3x.
	const counts: Record<string, number> = {};
	const counter: TaskflowVerifier = {
		name: "counter",
		verify: (f) => {
			counts[f.name] = (counts[f.name] ?? 0) + 1;
			return [];
		},
	};
	// saved-use child, both engines
	for (const eventKernel of [false, true]) {
		counts.child = 0;
		await executeTaskflow(
			mkState(parentUsingChild),
			baseDeps(recordingRunner([]), { verifiers: [counter], loadFlow: childLoader, eventKernel }),
		);
		assert.equal(counts.child, 1, `${eventKernel ? "event-kernel" : "imperative"} saved-use: verified once`);
	}
	// inline-def child, both engines
	const parentInline1: Taskflow = {
		name: "parentInline",
		phases: [{ id: "run-inline", type: "flow", def: { name: "inline-child", phases: [{ id: "i1", type: "agent", agent: "a", task: "x" }] }, final: true }],
	};
	for (const eventKernel of [false, true]) {
		counts["inline-child"] = 0;
		await executeTaskflow(mkState(parentInline1), baseDeps(recordingRunner([]), { verifiers: [counter], eventKernel }));
		assert.equal(counts["inline-child"], 1, `${eventKernel ? "event-kernel" : "imperative"} inline-def: verified once`);
	}
});

test("verifier: a throwing name/verify getter is normalized (never throws, siblings run)", () => {
	// A Proxy/getter entry that throws on property access must be fail-closed,
	// not crash verifyTaskflow (pluginVerifierErrors documents "never throws").
	const good: TaskflowVerifier = { name: "good", verify: () => [{ message: "sibling ran", severity: "warning" }] };
	const evil: Record<string, unknown> = { name: "evil" };
	Object.defineProperty(evil, "verify", { get() { throw new Error("boom-getter"); }, enumerable: true });
	const r = verifyTaskflow(cleanFlow(), { verifiers: [evil as unknown as TaskflowVerifier, good] });
	assert.equal(r.ok, false, "the throwing-getter entry is a fail-closed plugin error");
	assert.ok(r.issues.some((i) => i.category === "plugin" && i.severity === "error" && i.message.includes("boom-getter")), "throwing getter normalized to a plugin error");
	assert.ok(r.issues.some((i) => i.source === "good"), "sibling verifier still ran");
});

test("verifier: a non-cloneable leaf (function/Symbol) is dropped, not fail-closed", () => {
	// A host may attach a callback or Symbol to a phase (the schema permits
	// Record<string,unknown> fields like `with`). The isolation snapshot must
	// tolerate it — dropping the non-cloneable leaf — rather than fail-closing
	// verification, which would block the run whenever any verifier is registered.
	let sawTask: unknown;
	const flow: VerifiableFlow = {
		name: "t",
		phases: [{ id: "a", type: "agent", task: "x", final: true, with: { cb: () => 1, sym: Symbol("s") } } as unknown as Phase],
	};
	const r = verifyTaskflow(flow, {
		verifiers: [{ name: "spy", verify: (f) => { sawTask = f.phases[0].task; return []; } }],
	});
	assert.equal(r.ok, true, "non-cloneable leaves do not block verification");
	assert.equal(sawTask, "x", "the verifier still ran and observed the cloneable phase data");
});

test("verifier: a throwing getter while cloning the snapshot is fail-closed", () => {
	// cloneForVerifier tolerates ordinary non-cloneable leaves, but a getter that
	// throws while enumerating genuinely cannot be inspected — that stays
	// fail-closed (rare, malformed host object).
	const phase: Record<string, unknown> = { id: "a", type: "agent", task: "x", final: true };
	Object.defineProperty(phase, "boom", { get() { throw new Error("getter-boom"); }, enumerable: true });
	const flow: VerifiableFlow = { name: "t", phases: [phase as unknown as Phase] };
	const r = verifyTaskflow(flow, { verifiers: [{ name: "spy", verify: () => [] }] });
	assert.equal(r.ok, false, "a throwing getter is a fail-closed plugin error");
	assert.ok(r.issues.some((i) => i.category === "plugin" && i.message.includes("snapshot")), "snapshot failure normalized to a plugin error");
});

test("verifier: pluginVerifierErrors attributes the verifier source in its messages", () => {
	// The runtime preflight surfaces these strings; source attribution lets a host
	// tell WHICH verifier blocked.
	const errs = pluginVerifierErrors(cleanFlow(), [
		{ name: "named", verify: () => [{ message: "nope", severity: "error" }] },
	]);
	assert.deepEqual(errs, ["named: nope"]);
	const errsUnnamed = pluginVerifierErrors(cleanFlow(), [
		{ name: undefined as unknown as string, verify: () => [{ message: "anon", severity: "error" }] } as TaskflowVerifier,
	]);
	assert.deepEqual(errsUnnamed, ["anon"], "no source prefix when the verifier is unnamed");
});

// ---------------------------------------------------------------------------
// Regression: a cyclic host value must not block verification. Before the
// cycle guard, cloneForVerifier recursed forever on a back-edge → RangeError →
// fail-closed → a valid run was blocked whenever ANY verifier was registered
// (even one that never reads `with`). Cycles are now broken at the back-edge
// with a "[Circular]" marker; shared (DAG) subtrees still clone in full.
// ---------------------------------------------------------------------------

test("verifier: a cyclic host value in a phase does not block verification (no snapshot overflow)", () => {
	// A host attaches a cyclic graph to a phase `with` field (the schema permits
	// Record<string, unknown>). Before the guard this overflowed the isolation
	// snapshot and blocked the run; now the back-edge is replaced with a marker.
	const node: Record<string, unknown> = { id: "child" };
	node.parent = { id: "root", children: [node] }; // cycle: node.parent.children[0] === node
	const flow: VerifiableFlow = {
		name: "t",
		phases: [{ id: "a", type: "agent", task: "x", final: true, with: { node } } as unknown as Phase],
	};

	let ran = false;
	let sawTask: unknown;
	const benign: TaskflowVerifier = {
		name: "ids-only",
		verify: (f) => {
			ran = true;
			sawTask = f.phases[0].task;
			return [];
		},
	};

	const r = verifyTaskflow(flow, { verifiers: [benign] });
	assert.equal(r.ok, true, "cyclic host data does not block verification");
	assert.equal(ran, true, "the verifier still ran");
	assert.equal(sawTask, "x", "the verifier observed the cloneable phase data");
	assert.ok(!r.issues.some((i) => /snapshot|Maximum call stack/i.test(i.message)), "no snapshot-overflow issue");
	// pluginVerifierErrors is the runtime no-spend gate — it must not report errors.
	assert.equal(pluginVerifierErrors(flow, [benign]), null);
	// The ORIGINAL flow's cyclic structure is intact (the marker lives on the clone only).
	assert.equal((flow.phases[0] as unknown as { with: { node: { parent: { children: unknown[] } } } }).with.node.parent.children[0], node);
});

test("verifier: a shared (DAG) subtree is cloned fully — only true cycles are broken", () => {
	// Two phases reference the SAME sub-object (a diamond/DAG, not a cycle). It
	// must clone in full on both phases — NOT be replaced with "[Circular]".
	const shared = { kind: "config", n: 7 };
	const flow: VerifiableFlow = {
		name: "t",
		phases: [
			{ id: "a", type: "agent", task: "x", final: true, with: { c: shared } } as unknown as Phase,
			{ id: "b", type: "agent", task: "y", dependsOn: ["a"], with: { c: shared } } as unknown as Phase,
		],
	};

	const observed: unknown[] = [];
	const spy: TaskflowVerifier = {
		name: "spy",
		verify: (f) => {
			for (const p of f.phases) observed.push((p as { with?: { c?: unknown } }).with?.c);
			return [];
		},
	};

	verifyTaskflow(flow, { verifiers: [spy] });
	assert.equal(observed.length, 2);
	assert.deepEqual(observed[0], { kind: "config", n: 7 }, "first phase saw the full shared subtree");
	assert.deepEqual(observed[1], { kind: "config", n: 7 }, "second phase saw the full subtree, not a cycle marker");
	assert.ok(observed.every((o) => o !== "[Circular]"), "no false cycle marker on a shared (non-cyclic) subtree");
});

// ---------------------------------------------------------------------------
// Pin: built-in graph detectors are advisory on the event-kernel child path
// (this PR centralized a PLUGIN-only preflight in runNested). The only
// error-severity built-ins — `unreachable` and self-dependency — cannot reach a
// dispatching event-kernel child, so no spend divergence with the imperative
// path is reachable. This locks that in so it can't silently regress.
// ---------------------------------------------------------------------------

test("runtime: an event-kernel child with a built-in error-severity issue is screened out before dispatch (no spend divergence)", () => {
	// Pins the absence of a cross-engine spend divergence. The only error-severity
	// built-in detectors are `unreachable` and self-dependency; all others are
	// warnings (advisory on BOTH engines, never blocked). Neither error-severity
	// built-in can reach a DISPATCHING event-kernel child:
	const unreachableChild: Taskflow = {
		name: "child",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "child-a", final: true },
			{ id: "b", type: "agent", agent: "a", task: "child-b", dependsOn: ["a"] },
			{ id: "c", type: "agent", agent: "a", task: "child-c", dependsOn: ["d"] },
			{ id: "d", type: "agent", agent: "a", task: "child-d" },
		],
	};
	assert.equal(verifyTaskflow(unreachableChild).ok, false, "the child carries an error-severity built-in (unreachable)");
	// canUseEventKernel recurses into nested inline defs: the unreachable child's
	// concurrent DAG layers make the PARENT kernel-ineligible, so the whole run
	// takes the imperative path — where the built-in detectors still run.
	const parent: Taskflow = { name: "parent", phases: [{ id: "run-child", type: "flow", def: unreachableChild, final: true }] };
	assert.equal(canUseEventKernel(parent), false, "nesting an unreachable child makes the flow kernel-ineligible");
});
