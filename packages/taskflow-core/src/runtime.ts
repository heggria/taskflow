/**
 * Taskflow runtime — the orchestration engine.
 *
 * Resolves the phase DAG into topological layers and executes each phase by
 * delegating to isolated subagents. Intermediate phase outputs live here (in
 * RunState) and never enter the host conversation's context window — only the
 * final phase output is returned to the caller.
 *
 * Supports resume: phases whose resolved input hash matches a cached completed
 * result are skipped.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { AgentConfig } from "./agents.ts";
import { coerceArray, evaluateCondition, interpolate, interpolateValue, type InterpolationContext, safeParse, tryEvaluateCondition } from "./interpolate.ts";
import { contractViolations } from "./contract.ts";
import { isFailed, isTransientError, mapWithConcurrencyLimit, PHASE_TIMEOUT_ABORT_GRACE_MS, sanitizeErrorMessage } from "./runner-core.ts";
import type { LiveUpdate, RunResult, SubagentRunner } from "./host/runner-types.ts";

/** The host-neutral subagent runner signature the engine drives. A host adapter
 *  (pi, codex) injects a concrete `runTask` via `RuntimeDeps`. */
type RunTaskFn = SubagentRunner<any>["runTask"];

/** Default runner used when no host injected one: fail loudly rather than
 *  silently spawn anything (core is host-neutral and cannot spawn pi/codex). */
const noRunnerInjected: RunTaskFn = async (_cwd, _agents, agentName, task) => ({
	agent: agentName,
	task,
	exitCode: 1,
	output: "",
	stderr: "No subagent runner injected. A host adapter must set RuntimeDeps.runTask (e.g. piSubagentRunner or codexSubagentRunner).",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	errorMessage: "No subagent runner injected",
	stopReason: "error",
});
export { PHASE_TIMEOUT_ABORT_GRACE_MS } from "./runner-core.ts";
import { aggregateUsage, emptyUsage, type UsageStats } from "./usage.ts";
import { type Budget, type CacheScope, asArray, dependenciesOf, LOOP_DEFAULT_MAX_ITERATIONS, LOOP_HARD_MAX_ITERATIONS, MAX_DYNAMIC_MAP_ITEMS, MAX_DYNAMIC_NESTING, MAX_DYNAMIC_PHASES, parseTtlMs, type Phase, resolveArgs, type Taskflow, topoLayers, TOURNAMENT_DEFAULT_VARIANTS, TOURNAMENT_HARD_MAX_VARIANTS, type TournamentMode, validateInvocationArgs, validateTaskflow } from "./schema.ts";
import { verifyTaskflow, type TaskflowVerifier } from "./verify.ts";
import { combineScores, combineWithJudge, evaluatePureScorer, formatScorerReport, parseJudgeOutput, SCORE_DEFAULT_THRESHOLD, type ScoreConfig, scoreResultJSON, type ScorerResult, scorerShapeErrors } from "./scorers.ts";
import { parseGateVerdict, overBudget as overBudgetCheck, parseTournamentWinner, type BudgetCheckInput } from "./deterministic.ts";
export { parseTournamentWinner } from "./deterministic.ts";
import { type TraceEvent, type TraceSink } from "./trace.ts";
// Re-export so existing `import { parseGateVerdict } from "./runtime.ts"` callers
// (and tests) keep working; the implementation now lives in deterministic.ts.
export { parseGateVerdict };
import { runCodeCompilesScorer } from "./scorer-runtime.ts";
import { buildReflexionSummary, isContractViolation, REFLEXION_SENTINEL, type ReflexionInput } from "./reflexion.ts";
import { hashInput, newRunId, type PhaseState, type RunState, runsDir } from "./store.ts";
import { resolveFinalOutput } from "./final-output.ts";
import { CacheStore, resolveFingerprint } from "./cache.ts";
import { compileTaskflowToIR, phaseFingerprint } from "./flowir/index.ts";
import { computeStaleFrontier, declaredReadMapOfDef, readMapOf } from "./stale.ts";
import { ctxDirFor, drainPendingSpawns, initCtxDir, registerNode, setNodeStatus, type SpawnAssignment } from "./context-store.ts";
import { allocateWorkspace, isWorkspaceKeyword, type Workspace } from "./workspace.ts";
import {
	cwdArgName,
	directoryIdentity,
	isPathWithin,
	resolveCwdArg,
	type CwdBridgeMode,
	type DirectoryIdentity,
} from "./cwd-bridge.ts";
import {
	createResolveOnlyWorkspaceSession,
	type ResolveOnlyPhaseBinding,
	type ResolveOnlyWorkspaceSession,
} from "./resources/execution.ts";

/** A human-in-the-loop approval request raised by an `approval` phase. */
export interface ApprovalRequest {
	phaseId: string;
	/** Interpolated prompt shown to the human. */
	message: string;
	/** Output of the immediately-upstream phase, for context. */
	upstream?: string;
}

/** The human's decision. `edit` carries guidance passed downstream as the phase output. */
export interface ApprovalDecision {
	decision: "approve" | "reject" | "edit";
	note?: string;
}

export interface RuntimeDeps {
	cwd: string;
	agents: AgentConfig[];
	globalThinking?: string;
	/** Whether the host reports authoritative token/cost usage. A host that
	 *  cannot observe usage must reject every actually-executed budgeted flow,
	 *  including nested/dynamic flows, rather than silently bypassing the cap. */
	usageAccounting?: "available" | "tokens-only" | "unavailable";
	signal?: AbortSignal;
	/** Persist run state after each phase (for resume). */
	persist?: (state: RunState) => void;
	/** Live progress callback for TUI streaming. */
	onProgress?: (state: RunState) => void;
	/** Injectable task runner (defaults to spawning a real subagent). Enables testing. */
	runTask?: RunTaskFn;
	/** Resolve an `approval` phase. Omit for non-interactive runs (auto-reject). */
	requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
	/** Resolve a saved taskflow by name for `flow` (sub-workflow) phases. */
	loadFlow?: (name: string) => Taskflow | undefined;
	/** Cross-run memoization store. Omit to construct a default one for `deps.cwd`. */
	cacheStore?: CacheStore;
	/** Default cache scope for phases that don't specify one. */
	cacheScopeDefault?: CacheScope;
	/** Deterministic-replay trace sink (best-effort, fail-open). When injected,
	 *  the runtime records each phase's subagent calls + its own decisions to an
	 *  append-only trace for offline replay. Absent → no-op (runs behave
	 *  identically to today). See `trace.ts`. */
	trace?: TraceSink;
	/**
	 * S2 strangler: when true, eligible flows run on `exec/driver` (event kernel).
	 * Covers core kinds except `race`/`expand`; advanced features force imperative
	 * fallback. Default false; also set `PI_TASKFLOW_EVENT_KERNEL=1`.
	 */
	eventKernel?: boolean;
	/** Caller-supplied zero-token verifiers (see verify.ts). Threaded into every
	 *  `verifyTaskflow` preflight the runtime performs — dynamic subflows (spawn +
	 *  inline `flow{def}`), the event-kernel path, and the top-level pre-execution
	 *  gate (which blocks only on error-severity plugin issues, leaving built-in
	 *  detectors advisory at the top level as before). A host embedding the engine
	 *  registers the verifiers it trusts here. Undefined ⇒ built-in detectors only. */
	verifiers?: TaskflowVerifier[];
	/** Internal: sub-flow call stack, for recursion detection. */
	_stack?: string[];
	/** Internal: pre-resolved Shared Context Tree dir for this run (sub-flows inherit the parent's). */
	_ctxDir?: string;
	/** Internal: an isolated workspace dir override for the current phase (worktree isolation). */
	_cwdOverride?: string;
	/** Host-owned 0.2.1 cwd bridge mode. Undefined is fail-closed. Flow data
	 * cannot enable this; adapters may opt into the documented resolve-only mode. */
	cwdBridgeMode?: CwdBridgeMode;
	/** Optional trusted control-plane location for workspace leases/journal/HMAC
	 * state. Defaults outside the flow workspace under ~/.taskflow. */
	workspaceControlDirectory?: string;
	/** Host-created W1a resolve-only session. Ordinarily constructed lazily from
	 * cwdBridgeMode; injectable for delivery policy and conformance tests. */
	workspaceSession?: ResolveOnlyWorkspaceSession;
	/** Internal: a cwd-bridge flow may mutate workspace state, so output-only
	 * cache/resume reuse is disabled for the entire nested execution tree. */
	_disableCache?: boolean;
	/** Internal: execution originated from an LLM-authored flow{def}/ctx_spawn.
	 * Resource-bearing fields remain denied through every nested frame. */
	_dynamic?: boolean;
	/** Internal: canonical directory capability inherited from a cwd-bridge
	 * phase. Nested phases may stay inside or narrow it, never escape it. */
	_cwdBoundary?: string;
	/** Internal: only resource-selected execution trees opt into cwd-sensitive
	 * cache keys. Ordinary legacy root phases retain their existing key format. */
	_cacheCwdIdentity?: string;
	/** Internal: one immutable loader view per top-level execution. Saved-flow
	 * definitions must not change between capability scan and execution. */
	_flowLoaderSnapshot?: Map<string, FlowLoaderSnapshotEntry>;
	/** Internal phase-scoped W1a execution binding inherited only by descendants
	 * that remain inside the selected cwd capability. */
	_workspaceBinding?: ResolveOnlyPhaseBinding;
}

type FlowLoaderSnapshotEntry =
	| { ok: true; value: Taskflow | undefined }
	| { ok: false; error: unknown };

export interface RuntimeResult {
	state: RunState;
	finalOutput: string;
	ok: boolean;
	totalUsage: UsageStats;
	/** The id of the PhaseState whose output supplied `finalOutput`. For the
	 *  normal case this is the (fallback) final phase that actually completed.
	 *  For gate/budget prefixes, it is retained when underlying partial output
	 *  is included (the blocking gate/approval phase, or the fallback final
	 *  phase for a budget halt); `undefined` when no phase output is available
	 *  (no phase completed). Never the designated skipped/failed final phase. */
	outputSourcePhaseId?: string;
	/** Incremental-reuse summary: how many phases were reused from cache vs.
	 *  freshly executed this run, and the cost the reused work would otherwise
	 *  have incurred (known only for within-run resume; cross-run hits zero
	 *  their usage so their original cost is not recoverable). Optional &
	 *  additive — callers that ignore it are unaffected. */
	reuse?: ReuseSummary;
}

// Re-export the shared final-output helper + types so callers importing from
// the runtime barrel get them from one place. The event kernel
// (`exec/driver.ts`) imports these directly from `./final-output.ts` to avoid
// a static runtime↔driver import cycle.
export {
	resolveFinalOutput,
	type FinalOutputBlockedCtx,
	type FinalOutputResolution,
} from "./final-output.ts";

/** A run's incremental-reuse accounting (see RuntimeResult.reuse). */
export interface ReuseSummary {
	/** Phases that completed by executing a subagent this run. */
	executed: number;
	/** Phases served from the within-run resume cache (no new tokens). */
	reusedRunOnly: number;
	/** Phases restored from the cross-run store (no new tokens). */
	reusedCrossRun: number;
	/** Total phases that reached `done` (executed + reused). */
	done: number;
	/** USD the within-run-reused phases would have cost if re-executed (their
	 *  preserved prior usage). Cross-run hits are excluded (cost not recoverable). */
	savedUSD: number;
}

/** Compute the incremental-reuse summary from a run's terminal phase states.
 *  Pure, total, never throws. A phase is "reused" iff it carries a `cacheHit`
 *  marker (set by `cachedPhase` for both within-run resume and cross-run hits). */
export function summarizeReuse(state: RunState): ReuseSummary {
	let executed = 0;
	let reusedRunOnly = 0;
	let reusedCrossRun = 0;
	let savedUSD = 0;
	for (const ps of Object.values(state.phases)) {
		if (ps.status !== "done") continue;
		if (ps.cacheHit === "run-only") {
			reusedRunOnly++;
			savedUSD += ps.usage?.cost ?? 0; // within-run resume preserves prior usage
		} else if (ps.cacheHit === "cross-run") {
			reusedCrossRun++; // cross-run hits zero their usage — cost not recoverable
		} else {
			executed++;
		}
	}
	return {
		executed,
		reusedRunOnly,
		reusedCrossRun,
		done: executed + reusedRunOnly + reusedCrossRun,
		savedUSD,
	};
}

function buildInterpolationContext(
	state: RunState,
	previousOutput: string | undefined,
	locals?: Record<string, unknown>,
	onRead?: (ref: string) => void,
	reflexion?: string,
): InterpolationContext {
	const steps: Record<string, { output: string; json?: unknown }> = {};
	for (const [id, ps] of Object.entries(state.phases)) {
		// Include both done AND failed phases so downstream phases can see
		// error info. Skipped phases (upstream failure cascade) are excluded.
		if (ps.status === "done" || ps.status === "failed") {
			if (ps.output !== undefined) {
				steps[id] = { output: ps.output, json: ps.json };
			} else if (ps.status === "failed") {
				// M-3: Failed phases without output get a placeholder so
				// downstream references like {steps.X.output} resolve to a
				// sensible value instead of leaving the raw placeholder intact.
				steps[id] = { output: "[previous phase failed]", json: undefined };
			}
		}
	}
	return { args: state.args, steps, previousOutput, locals, onRead, reflexion };
}

function resultToPhaseState(id: string, r: RunResult, inputHash: string, parseJson: boolean): PhaseState {	const failed = isFailed(r);
	const attempts = attemptsOf(r);
	// For failed phases, embed the error info in the output so downstream
	// phases (and the user) can see what went wrong. The raw r.output is
	// often a useless placeholder like "(upstream error: subagent failed)".
	const output = failed
		? r.errorMessage || r.stderr || r.output
		: r.output;
	return {
		id,
		status: failed ? "failed" : "done",
		output,
		json: parseJson && !failed ? safeParse(r.output) : undefined,
		usage: r.usage,
		model: r.model,
		attempts: attempts > 1 ? attempts : undefined,
		timedOut: r.phaseTimeout || undefined,
		error: failed ? r.errorMessage || r.stderr || r.output : undefined,
		inputHash,
		endedAt: Date.now(),
	};
}

/**
 * Synthesize a 0-token `RunResult` from a cached per-item `PhaseState` so a
 * cross-run per-item cache hit flows through `mergePhaseState` as a normal
 * successful fan-out item. `stopReason: "cache-hit"` is NOT in `isFailed`'s
 * failure set (only "error"/"aborted"/non-zero exit), so the item counts as
 * success. Usage is `emptyUsage()` — a cached item spent no new tokens this
 * run, so `mergePhaseState`'s `aggregateUsage` charges nothing for it.
 *
 * Used only by the `map` per-item cache path (see `runFanout`). Fail-open by
 * construction: this is only reached AFTER a successful `cachedPhase` lookup,
 * so `ps.output` is always present.
 */
function phaseStateToRunResult(ps: PhaseState, it: { agent: string; task: string }): RunResult {
	return {
		agent: it.agent,
		task: it.task,
		exitCode: 0,
		output: ps.output ?? "",
		stderr: "",
		usage: emptyUsage(),
		model: ps.model,
		stopReason: "cache-hit",
	};
}

/** Convert observed read refs (e.g. "steps.scout.output") into a structured
 *  readSet keyed by upstream phase id, tagging each with the version
 *  (= inputHash) that was current when read. Only `steps.*` refs are upstream
 *  phase dependencies; args/item/previous are invocation/loop values. */
function readRefsToReads(
	refs: string[],
	state: RunState,
): Array<{ stepId: string; version?: string }> {
	const out: Array<{ stepId: string; version?: string }> = [];
	const seen = new Set<string>();
	for (const ref of refs) {
		const m = /^steps\.([A-Za-z0-9_-]+)\b/.exec(ref);
		if (!m) continue;
		const stepId = m[1] as string;
		if (seen.has(stepId)) continue;
		seen.add(stepId);
		out.push({ stepId, version: state.phases[stepId]?.inputHash });
	}
	return out;
}

/**
 * Surface unresolved interpolation placeholders (the `missing[]` from
 * `interpolate()`). Without this they are silently left intact in the task —
 * the doc comment in interpolate.ts promises "a recorded warning". We both
 * log to the console and return a string to attach to PhaseState.warnings so
 * the warning is persisted in the run record and visible in `/tf runs`.
 * Returns undefined when nothing is missing.
 */
function warnUnresolvedRefs(phaseId: string, missing: string[]): string | undefined {
	if (!missing.length) return undefined;
	const unique = Array.from(new Set(missing));
	const msg = `unresolved refs in task: ${unique.map((m) => `{${m}}`).join(", ")} — left intact (check dependsOn / placeholder spelling)`;
	console.warn(`[taskflow] phase '${phaseId}': ${msg}`);
	return msg;
}

/** Attempts recorded by the retry wrapper (defaults to 1). */
function attemptsOf(r: RunResult): number {
	const a = r.attempts;
	return typeof a === "number" && a > 0 ? a : 1;
}

/** Cancellable delay used between retry attempts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (ms <= 0) return resolve();
		let onAbort: (() => void) | undefined;
		const t = setTimeout(() => {
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		if (signal) {
			if (signal.aborted) {
				clearTimeout(t);
				return resolve();
			}
			onAbort = () => {
				clearTimeout(t);
				resolve();
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

function failPhase(id: string, error: string): PhaseState {
	return { id, status: "failed", error, inputHash: hashInput(id, error), endedAt: Date.now(), usage: emptyUsage() };
}

/**
 * Normalize an inline `flow.def` payload into a full Taskflow shape.
 * Accepts: a full Taskflow ({name?,phases:[...]}), a bare phases array, or
 * {phases:[...]}. Returns undefined if the shape is unrecognized. A recognized
 * shape with ZERO phases is returned as-is (caller treats it as a no-op) so the
 * empty-plan case is distinguishable from a malformed one.
 *
 * The payload is deep-cloned so the runtime never shares references with (or
 * mutates) the upstream phase's parsed JSON. Cloning also drops any non-own /
 * prototype-shadowing `__proto__` own-property that a crafted JSON could carry.
 */
function normalizeInlineDef(parsed: unknown, phaseId: string): Taskflow | undefined {
	let shaped: Taskflow | undefined;
	if (Array.isArray(parsed)) {
		shaped = { name: `${phaseId}-inline`, phases: parsed as Taskflow["phases"] };
	} else if (parsed && typeof parsed === "object") {
		const o = parsed as Record<string, unknown>;
		if (Array.isArray(o.phases)) {
			const name = typeof o.name === "string" && o.name.length > 0 ? (o.name as string) : `${phaseId}-inline`;
			shaped = { ...(o as object), name, phases: o.phases as Taskflow["phases"] } as Taskflow;
		}
	}
	if (!shaped) return undefined;
	// Deep clone via JSON round-trip: severs shared references with upstream output
	// and drops any own "__proto__" key (JSON.stringify omits it). As belt-and-
	// suspenders, also delete inert `constructor`/`prototype` own-keys a crafted
	// payload could carry, so the returned object is clean of pollution vectors.
	try {
		const clone = JSON.parse(JSON.stringify(shaped)) as Record<string, unknown>;
		for (const k of ["__proto__", "constructor", "prototype"]) {
			if (Object.prototype.hasOwnProperty.call(clone, k)) delete clone[k];
		}
		return clone as unknown as Taskflow;
	} catch {
		return undefined;
	}
}

/**
 * Clamp a runtime-generated sub-flow's budget so it can only ever be TIGHTER
 * than the parent's, never looser. A generated def cannot raise the spend cap by
 * declaring its own large budget. Each dimension becomes min(child, parent).
 */
function clampSubFlowBudget(
	sub: Taskflow,
	parentBudget: Budget | undefined,
	spent: UsageStats = emptyUsage(),
): Taskflow {
	if (!parentBudget) return sub;
	const child = sub.budget;
	const remainingUSD =
		parentBudget.maxUSD === undefined ? Infinity : Math.max(0, parentBudget.maxUSD - spent.cost);
	const remainingTokens =
		parentBudget.maxTokens === undefined
			? Infinity
			: Math.max(0, parentBudget.maxTokens - (spent.input + spent.output));
	const clamped: Budget = {
		maxUSD: Math.min(child?.maxUSD ?? Infinity, remainingUSD),
		maxTokens: Math.min(child?.maxTokens ?? Infinity, remainingTokens),
	};
	// Drop Infinity dimensions (no cap on that axis).
	const budget: Budget = {};
	if (Number.isFinite(clamped.maxUSD)) budget.maxUSD = clamped.maxUSD;
	if (Number.isFinite(clamped.maxTokens)) budget.maxTokens = clamped.maxTokens;
	return { ...sub, budget: budget.maxUSD === undefined && budget.maxTokens === undefined ? undefined : budget };
}

/** Aggregate run cost/tokens so far and test against the budget. */
function overBudget(state: RunState): { over: boolean; reason: string } {
	const budget: Budget | undefined = state.def.budget;
	if (!budget) return { over: false, reason: "" };
	const input: BudgetCheckInput = {
		maxUSD: budget.maxUSD,
		maxTokens: budget.maxTokens,
		usages: Object.values(state.phases).map((p) => p.usage ?? emptyUsage()),
	};
	return overBudgetCheck(input);
}

/** Merge several sub-results into a single PhaseState (for map/parallel). */
function mergePhaseState(
	id: string,
	results: RunResult[],
	inputHash: string,
	parseJson: boolean,
): PhaseState {
	const budgetSkips = results.filter((r) => r.stopReason === "budget-skipped");
	const ran = results.filter((r) => r.stopReason !== "budget-skipped");
	const anyFailed = ran.some(isFailed);
	const usage = aggregateUsage(results.map((r) => r.usage));
	// B12: surface the model(s) used in the fan-out so consumers can show
	// which model produced the merged output.
	const model = ran.find((r) => r.model !== undefined)?.model;
	// Combine outputs as a labelled list; also expose a JSON array of outputs.
	// For failed items, use the error message instead of the useless placeholder.
	// Labels are positionally aligned to the ORIGINAL `over` array: we iterate
	// over ALL results (including budget-skipped, which are filtered to null) and
	// use `results.length` as N, so item k's label reads `[k/N]` matching its
	// position in `over` — not its rank among non-skipped items. Per-item cache
	// hits (`stopReason: "cache-hit"`) are not budget-skipped, so they keep their
	// original positional label.
	const combinedText = results
		.map((r, i) => {
			if (r.stopReason === "budget-skipped") return null;
			const label = `### [${i + 1}/${results.length}] ${r.agent}${isFailed(r) ? " (failed)" : ""}`;
			const content = isFailed(r) ? (r.errorMessage || r.stderr || r.output) : r.output;
			return `${label}\n\n${content}`;
		})
		.filter((x): x is string => x !== null)
		.join("\n\n---\n\n");
	// Only successful runs feed the parsed JSON array (no error/skip strings).
	const jsonArray = parseJson ? ran.filter((r) => !isFailed(r)).map((r) => safeParse(r.output) ?? r.output) : undefined;
	const failedCount = ran.filter(isFailed).length;
	const attempts = results.reduce((sum, r) => sum + attemptsOf(r), 0);
	const errors = ran.filter(isFailed).map((r) => `${r.agent}: ${r.errorMessage ?? r.stderr}`);
	if (budgetSkips.length) errors.push(`${budgetSkips.length} item(s) skipped: budget exceeded`);
	return {
		id,
		status: anyFailed ? "failed" : "done",
		output: combinedText,
		json: jsonArray,
		usage,
		model,
		attempts: attempts > results.length ? attempts : undefined,
		timedOut: ran.some((r) => r.phaseTimeout) || undefined,
		budgetTruncated: budgetSkips.length > 0 || undefined,
		subProgress: { done: ran.length, total: results.length, running: 0, failed: failedCount },
		error: errors.length ? errors.join("; ") : undefined,
		inputHash,
		endedAt: Date.now(),
	};
}

/**
 * A live-update sink that mirrors a subagent's streaming progress into a single
 * phase's state row, then notifies the TUI. Shared by all single-agent phases.
 */
/** Fail-open trace emit: a throwing/missing sink must NEVER crash a run.
 *  Mirrors the `safeEmit` discipline used for `persist`/`onProgress`. */
function traceEmit(deps: RuntimeDeps, event: TraceEvent): void {
	try {
		deps.trace?.emit(event);
	} catch {
		/* trace is best-effort; never run-breaking */
	}
}

/** Emit a `decision` event (S1: full decision coverage for fold/replay). Fail-open. */
function traceDecision(
	deps: RuntimeDeps,
	state: RunState,
	phaseId: string,
	decision: NonNullable<TraceEvent["decision"]>,
): void {
	traceEmit(deps, {
		ts: Date.now(),
		runId: state.runId,
		phaseId,
		kind: "decision",
		decision,
	});
}

/** Emit gate decision as gate-score when scores present, else gate-verdict. */
function traceGateDecision(
	deps: RuntimeDeps,
	state: RunState,
	phaseId: string,
	gate: NonNullable<PhaseState["gate"]>,
	judgeOutput?: string,
): void {
	if (gate.scores) {
		traceDecision(deps, state, phaseId, {
			type: "gate-score",
			target: "",
			results: gate.scores.results,
			combined: gate.scores.combined,
			threshold: gate.scores.threshold,
			verdict: gate.verdict,
			judgeOutput,
		});
	} else {
		traceDecision(deps, state, phaseId, {
			type: "gate-verdict",
			value: gate.verdict,
			reason: gate.reason,
		});
	}
}

/** Fail-open trace flush at phase-end. */
function traceFlush(deps: RuntimeDeps, phaseId: string): void {
	try {
		deps.trace?.flush(phaseId);
	} catch {
		/* trace is best-effort; never run-breaking */
	}
}

/** Emit a `decision: unreplayable` marker for a phase whose inputs the trace
 *  cannot fully capture (Shared Context Tree, inner sub-flows, context files,
 *  unobservable interpolation deps). Offline replay marks such phases
 *  `needs-live-rerun` instead of silently reusing a recorded output.
 *  Single-phase analog of `hasUnobservedDependencies`. Fail-open. */
function emitUnreplayableMarker(deps: RuntimeDeps, state: RunState, phase: Phase): void {
	const reason = unreplayableReason(state, phase);
	if (!reason) return;
	traceEmit(deps, {
		ts: Date.now(), runId: state.runId, phaseId: phase.id, kind: "decision",
		decision: { type: "unreplayable", reason },
	});
}

/** Why (if at all) a single phase cannot be deterministically replayed. */
function unreplayableReason(state: RunState, phase: Phase): "context-sharing" | "inner-flow" | "context-files" | "unobservable-deps" | undefined {
	if (phase.shareContext === true || state.def.contextSharing === true) return "context-sharing";
	if (phase.type === "flow" || phase.type === "expand") return "inner-flow";
	if (phase.context && phase.context.length > 0) return "context-files";
	// Interpolation refs that don't resolve through steps.*/args.*/item.* are
	// unobservable to the trace (previous.output is observable via dependsOn).
	const scan = (text: string | undefined): boolean =>
		!!text && /\{(previous\.output|item\b|item\.)/.test(text);
	if (scan(phase.task) || scan(phase.when) || scan(phase.until) || (Array.isArray(phase.eval) && phase.eval.some(scan))) {
		return "unobservable-deps";
	}
	return undefined;
}

function liveSink(state: RunState, phaseId: string, emitProgress: () => void): (l: LiveUpdate) => void {
	return (l: LiveUpdate) => {
		const live = state.phases[phaseId];
		if (live) {
			live.liveText = l.text;
			live.usage = l.usage;
			live.model = l.model;
		}
		emitProgress();
	};
}


/**
 * Pre-read files listed in a phase's `context` field and return them as
 * markdown code blocks. Handles:
 * - literal paths
 * - interpolation refs (e.g. `{steps.scout.json}` resolving to `["a.ts"]`)
 * - per-file truncation via `contextLimit`
 *
 * The result is a single string that should be prepended to the phase task so
 * the subagent never needs to spend turns on file exploration.
 */
const CONTEXT_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_TOTAL_CONTEXT_CHARS = 200_000;

async function resolvePhaseContext(
	phase: Phase,
	ctx: InterpolationContext,
	cwd: string,
	boundary?: string,
): Promise<string> {
	const entries = phase.context;
	if (!entries || entries.length === 0) return "";
	const limit = phase.contextLimit ?? 8000;

	const paths: string[] = [];
	for (const entry of entries) {
		const r = interpolate(entry, ctx);
		if (r.text !== entry) {
			// Resolved — may be a JSON array from {steps.X.json}
			const parsed = safeParse(r.text);
			if (Array.isArray(parsed)) {
				for (const item of parsed) {
					if (typeof item === "string" && item.trim()) paths.push(item.trim());
				}
			} else if (typeof r.text === "string" && r.text.trim()) {
				paths.push(r.text.trim());
			}
		} else {
			// Unchanged — literal path
			paths.push(entry);
		}
	}

	const unique = Array.from(new Set(paths));

	// Diagnose JSON blobs masquerading as file paths — common when a context
	// entry like {steps.discover.output} resolves to {"files":[...]} instead
	// of a flat path or JSON array. The author should use {steps.discover.json.files}.
	const jsonBlobs = unique.filter((p) => p.startsWith("{"));
	for (const blob of jsonBlobs) {
		console.warn(
			`[taskflow] Context entry "${blob.slice(0, 80)}…" looks like a JSON object, not a file path. ` +
				`Use {steps.<id>.json.<field>} to extract a specific field.`,
		);
	}
	const filtered = jsonBlobs.length ? unique.filter((p) => !p.startsWith("{")) : unique;

	const blocks: string[] = [];
	for (const p of filtered) {
		try {
			const abs = path.resolve(cwd, p);
			if (boundary && !isPathWithin(boundary, abs)) {
				throw new Error(`TF_CWD_BOUNDARY_ESCAPE: context path '${p}' escapes the inherited cwd boundary`);
			}
			const canonical = fs.realpathSync(abs);
			if (boundary && !isPathWithin(boundary, canonical)) {
				throw new Error(`TF_CWD_BOUNDARY_ESCAPE: context path '${p}' resolves outside the inherited cwd boundary`);
			}
			const stat = fs.statSync(canonical);
			if (!stat.isFile()) continue;
			if (stat.size > CONTEXT_MAX_FILE_BYTES) continue;
			const content = fs.readFileSync(canonical, "utf-8");
			const truncated =
				content.length > limit
					? content.slice(0, limit) + `\n... [truncated ${content.length - limit} chars]`
					: content;
			const ext = path.extname(p).slice(1) || "txt";
			blocks.push(`## File: ${p}\n\n\`\`\`${ext}\n${truncated}\n\`\`\``);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("TF_CWD_BOUNDARY_ESCAPE:")) throw error;
			console.warn(`[taskflow] Skipped unreadable context file: ${p}`);
		}
	}

	// Safety cap: truncate total context when too many files are listed.
	let result = blocks.join("\n\n") + "\n\n";
	if (result.length > MAX_TOTAL_CONTEXT_CHARS) {
		result = result.slice(0, MAX_TOTAL_CONTEXT_CHARS) + `\n\n... [truncated ${result.length - MAX_TOTAL_CONTEXT_CHARS} total chars]`;
	}
	return result;
}

/**
 * Supervision loop: run the child tasks a parent node queued via ctx_spawn.
 * Each child is an isolated subagent registered under the parent in the tree.
 * Children themselves may share context (and recursively spawn, up to the depth
 * cap enforced inside the ctx_spawn tool). Returns a markdown block of the
 * children's reports to fold into the parent phase's output, or undefined.
 *
 * Fail-open: a child failure is recorded in its report text but never throws.
 */
/** What a spawned child contributed: its folded report text + the tokens it burned. */
interface SpawnedResult {
	reports: string | undefined;
	usage: UsageStats;
	failed: boolean;
	errors: string[];
}

/**
 * Spend produced by the current ctx_spawn supervision tree but not yet folded
 * into `state.phases`.  A single ledger is shared by siblings and descendants,
 * otherwise every recursive call observes the same stale parent state and can
 * independently spend the full remaining allowance.
 */
interface SpawnBudgetLedger {
	usage: UsageStats;
}

type SpawnChildRunner = (
	agentName: string,
	task: string,
	childNodeId: string,
	usageBefore: UsageStats | undefined,
) => Promise<RunResult>;

function spawnedOverBudget(state: RunState, local: UsageStats): boolean {
	const budget = state.def.budget;
	if (!budget) return false;
	return overBudgetCheck({
		maxUSD: budget.maxUSD,
		maxTokens: budget.maxTokens,
		usages: [...Object.values(state.phases).map((p) => p.usage ?? emptyUsage()), local],
	}).over;
}

/**
 * Run an inline sub-flow queued via `ctx_spawn({subflow})`. Reuses the SAME
 * validation + execution machinery as a `flow{def}` phase (normalizeInlineDef →
 * validateTaskflow(dynamic) → verifyTaskflow → nested executeTaskflow), so a
 * spawned DAG is held to the same safety bar as an author-written one.
 *
 * Crucially it extends `deps._stack` with a `def:spawn-<childNodeId>` frame so
 * the existing inline-nesting guard counts spawn-subflows AND flow{def} on the
 * SAME counter — neither axis can independently reach MAX_DYNAMIC_NESTING and
 * multiply with the other (verdict Issue 1). Failures are fail-open: a bad
 * subflow returns a diagnostic string, never throws.
 */
/**
 * The effective working directory for a phase's execution. Honours an allocated
 * workspace override (`_cwdOverride`, set by the executePhase wrapper for
 * isolated `temp`/`dedicated`/`worktree` cwds) and never passes a reserved
 * keyword through to a runner (keywords are resolved upstream into a real dir).
 * Single source of truth — do not inline this formula (divergence here caused
 * two isolation-leak bugs in the 0.0.23 review).
 */
function resolveEffCwd(deps: RuntimeDeps, phase: Phase): string {
	if (deps._cwdOverride) return deps._cwdOverride;
	if (!phase.cwd || isWorkspaceKeyword(phase.cwd)) return deps.cwd;
	// Node resolves a relative spawn cwd against the Taskflow process cwd. That
	// is not necessarily the invocation root, so anchor legacy literals here.
	return path.resolve(deps.cwd, phase.cwd);
}

/** Resolve a literal per-branch cwd once for BOTH cache identity and execution.
 * Existing directories are realpath-canonicalized so aliases/symlinks cannot
 * collide with a different invocation root under the same raw cwd string. */
function resolveBranchCwd(deps: RuntimeDeps, cwd: string): string {
	const resolved = path.resolve(deps.cwd, cwd);
	return directoryIdentity(resolved)?.canonicalPath ?? resolved;
}

function flowTreeUsesCwdBridge(
	def: Taskflow,
	loadFlow: RuntimeDeps["loadFlow"],
	seenUses = new Set<string>(),
): boolean {
	if (def.phases.some((phase) => cwdArgName(phase.cwd) !== undefined)) return true;
	if (!loadFlow) return false;
	for (const phase of def.phases) {
		if ((phase.type ?? "agent") !== "flow" || !phase.use) continue;
		if (seenUses.has(phase.use)) continue;
		seenUses.add(phase.use);
		try {
			const child = loadFlow(phase.use);
			if (child && flowTreeUsesCwdBridge(child, loadFlow, seenUses)) return true;
		} catch {
			// Unknown is treated as capability-bearing: disable reuse, then let the
			// normal phase execution path report the loader failure coherently.
			return true;
		}
	}
	return false;
}

/**
 * Freeze the saved-flow namespace for one top-level execution. Capability
 * discovery and phase execution must observe the same definition, including
 * the same loader error, or a mutable loader could introduce a bridge only
 * after the root binding and cache policy were decided.
 */
function snapshotFlowLoader(deps: RuntimeDeps): RuntimeDeps {
	if (!deps.loadFlow || deps._flowLoaderSnapshot) return deps;
	const source = deps.loadFlow;
	const snapshot = new Map<string, FlowLoaderSnapshotEntry>();
	const loadFlow = (name: string): Taskflow | undefined => {
		let entry = snapshot.get(name);
		if (!entry) {
			try {
				const loaded = source(name);
				// Loader-owned objects may be mutated asynchronously. Capability scan
				// and execution operate on a detached structured snapshot, never the
				// loader's live reference.
				entry = { ok: true, value: loaded === undefined ? undefined : structuredClone(loaded) };
			} catch (error) {
				entry = { ok: false, error };
			}
			snapshot.set(name, entry);
		}
		if (!entry.ok) throw entry.error;
		return entry.value;
	};
	return { ...deps, loadFlow, _flowLoaderSnapshot: snapshot };
}

function sameDirectoryIdentity(a: DirectoryIdentity | undefined, b: DirectoryIdentity | undefined): boolean {
	return !!a && !!b && a.canonicalPath === b.canonicalPath && a.device === b.device && a.inode === b.inode;
}

async function runInlineSubflow(
	subflowSpec: unknown,
	defaultAgent: string | undefined,
	childNodeId: string,
	phase: Phase,
	deps: RuntimeDeps,
	state: RunState,
	localSpawnUsage: UsageStats,
): Promise<{ output: string; usage: UsageStats; failed: boolean; error?: string }> {
	const stack = deps._stack ?? [];
	const inlineDepth = stack.filter((s) => s.startsWith("def:")).length;
	if (inlineDepth >= MAX_DYNAMIC_NESTING) {
		const error = `spawned subflow rejected: nesting exceeded MAX_DYNAMIC_NESTING (${MAX_DYNAMIC_NESTING})`;
		return { output: `(${error})`, usage: emptyUsage(), failed: true, error };
	}
	const wrapped = normalizeInlineDef(subflowSpec, childNodeId);
	if (!wrapped) return { output: "(spawned subflow is not a Taskflow / phases array)", usage: emptyUsage(), failed: true, error: "spawned subflow is not a Taskflow / phases array" };
	if (wrapped.phases.length === 0) return { output: "(spawned subflow had zero phases — no-op)", usage: emptyUsage(), failed: false };
	// Inner phases without their own agent inherit the assignment's defaultAgent.
	if (defaultAgent) {
		for (const p of wrapped.phases as Phase[]) if (!p.agent) p.agent = defaultAgent;
	}
	const spawnCwd = resolveEffCwd(deps, phase);
	const dynCwd = spawnCwd;
	const v = validateTaskflow(wrapped, { dynamic: true, cwd: dynCwd });
	if (!v.ok) {
		const error = `spawned subflow failed validation: ${v.errors.join("; ")}`;
		return { output: `(${error})`, usage: emptyUsage(), failed: true, error };
	}
	const ver = verifyTaskflow({ name: wrapped.name, phases: wrapped.phases as Phase[], budget: wrapped.budget, concurrency: wrapped.concurrency }, { verifiers: deps.verifiers });
	if (!ver.ok) {
		const errs = ver.issues.filter((i) => i.severity === "error").map((i) => i.message);
		const error = `spawned subflow failed verification: ${errs.join("; ")}`;
		return { output: `(${error})`, usage: emptyUsage(), failed: true, error };
	}
	// The generated sub-flow gets only what remains after both already-folded
	// parent spend and siblings/ancestors in this still-running spawn batch.  USD
	// and tokens are clamped independently by clampSubFlowBudget.  Like the main
	// runtime, this is an atomic-call ceiling: one call may cross the cap, then no
	// subsequent call is admitted.
	const parentAndBatchSpent = aggregateUsage([
		...Object.values(state.phases).map((p) => p.usage ?? emptyUsage()),
		localSpawnUsage,
	]);
	const subDef = clampSubFlowBudget(wrapped, state.def.budget, parentAndBatchSpent);
	const subState: RunState = {
		runId: newRunId(subDef.name),
		flowName: subDef.name,
		def: subDef,
		args: resolveArgs(subDef, {}),
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: dynCwd,
	};
	try {
		const subResult = await executeTaskflow(subState, {
			...deps,
			cwd: dynCwd,
			_cacheCwdIdentity: phase.cwd !== undefined || deps._cacheCwdIdentity !== undefined ? dynCwd : undefined,
			_dynamic: true,
			// The parent phase's isolated workspace (if any) applies only to the
			// parent — each spawned sub-phase resolves its own cwd. Clear the
			// override so the whole subflow doesn't inherit the parent's dir
			// (mirrors the `flow` phase handler discipline).
			_cwdOverride: undefined,
			// Don't let spawned sub-phases persist the parent's run state.
			persist: undefined,
			// Unify the nesting counter across both recursion axes (verdict Issue 1).
			_stack: [...stack, state.flowName, `def:spawn-${childNodeId}`],
			_ctxDir: deps._ctxDir,
			onProgress: undefined,
		});
		// Sum every sub-phase's usage so the parent's budget guard sees spawn spend
		// (verdict Issue 2).
		const usage = aggregateUsage(Object.values(subResult.state.phases).map((p) => p.usage ?? emptyUsage()));
		return {
			output: subResult.finalOutput ?? "",
			usage,
			failed: !subResult.ok,
			...(!subResult.ok ? { error: sanitizeErrorMessage(subResult.finalOutput || "spawned subflow failed") } : {}),
		};
	} catch (e) {
		const error = sanitizeErrorMessage(e instanceof Error ? e.message : String(e));
		return { output: `(spawned subflow failed: ${error})`, usage: emptyUsage(), failed: true, error };
	}
}

async function runSpawnedChildren(
	assignments: SpawnAssignment[],
	ctxDir: string,
	parentNodeId: string,
	phase: Phase,
	deps: RuntimeDeps,
	state: RunState,
	runChild: SpawnChildRunner,
	ledger: SpawnBudgetLedger = { usage: emptyUsage() },
): Promise<SpawnedResult> {
	const capped = assignments.slice(0, MAX_DYNAMIC_MAP_ITEMS);
	const lines: string[] = [];
	const usages: UsageStats[] = [];
	const errors: string[] = [];
	let idx = 0;
	for (const a of capped) {
		if (deps.signal?.aborted || spawnedOverBudget(state, ledger.usage)) break;
		idx++;
		const childNodeId = `${parentNodeId}--c${idx}`.replace(/[^A-Za-z0-9._-]+/g, "_");
		const isSubflow = a.subflow !== undefined && a.subflow !== null;
		const agentName = isSubflow ? "(subflow)" : resolveAgent(a.agent ?? phase.agent, deps, state);
		registerNode(ctxDir, childNodeId, `${phase.id}:spawn`, parentNodeId, "running");
		let out = "";
		try {
			if (isSubflow) {
				const sub = await runInlineSubflow(
					a.subflow,
					a.defaultAgent ?? phase.agent,
					childNodeId,
					phase,
					deps,
					state,
					ledger.usage,
				);
				out = sub.output;
				usages.push(sub.usage);
				ledger.usage = aggregateUsage([ledger.usage, sub.usage]);
				if (sub.failed) errors.push(sub.error ?? `spawned subflow ${childNodeId} failed`);
				setNodeStatus(ctxDir, childNodeId, sub.failed ? "failed" : "done");
			} else {
				const task = a.task ?? "";
				// Flat ctx_spawn children use the SAME runOne policy as their parent:
				// phase timeout, idle watchdog, retries, budget accounting, tracing,
				// prompt diagnostics, cwd capability, and workspace binding.
				const usageBefore = ledger.usage;
				const r = await runChild(agentName, task, childNodeId, usageBefore);
				out = r.output ?? "";
				if (isFailed(r)) {
					const detail = sanitizeErrorMessage(r.errorMessage ?? r.stderr ?? "spawned child failed");
					errors.push(detail);
					if (!out) out = `(spawned child failed: ${detail})`;
				}
				if (r.usage) {
					usages.push(r.usage);
					ledger.usage = aggregateUsage([ledger.usage, r.usage]);
				}
				setNodeStatus(ctxDir, childNodeId, isFailed(r) ? "failed" : "done");
				// A child may itself have queued spawns — recurse (depth-capped by the tool).
				const grand = drainPendingSpawns(ctxDir, childNodeId);
				if (grand.length > 0 && !deps.signal?.aborted && !spawnedOverBudget(state, ledger.usage)) {
					const rec = await runSpawnedChildren(grand, ctxDir, childNodeId, phase, deps, state, runChild, ledger);
					if (rec.reports) out += rec.reports;
					usages.push(rec.usage);
					errors.push(...rec.errors);
				}
			}
		} catch (e) {
			setNodeStatus(ctxDir, childNodeId, "failed");
			const detail = sanitizeErrorMessage(e instanceof Error ? e.message : String(e));
			errors.push(detail);
			out = `(spawned child failed: ${detail})`;
		}
		lines.push(`### spawned child ${idx} (${agentName})\n${out}`);
	}
	const usage = aggregateUsage(usages);
	if (lines.length === 0) return { reports: undefined, usage, failed: errors.length > 0, errors };
	return {
		reports: `\n\n<!-- ctx_spawn: ${lines.length} child report(s) -->\n${lines.join("\n\n")}`,
		usage,
		failed: errors.length > 0,
		errors,
	};
}


/**
 * Public phase executor. Resolves an isolated workspace when `phase.cwd` is a
 * reserved keyword (`temp`/`dedicated`/`worktree`), runs the phase against it,
 * and tears it down afterwards. All allocation is fail-open: a failed allocation
 * degrades to the base cwd so a phase never fails to run because of isolation.
 */
/** Optional per-invocation execution flags (e.g. M5 recompute forces a
 *  phase to re-run, bypassing the cross-run cache so the result refreshes). */
interface PhaseExecOpts {
	/** Bypass the cache entirely (within-run prior AND cross-run store) and
	 *  re-execute. Used by `/tf recompute` on the seeded phase so its new
	 *  output — and only the downstream whose inputHash actually moves — refreshes. */
	forceRerun?: boolean;
	/** Internal: a resource-bearing wrapper evaluated the guard before binding. */
	whenPrechecked?: boolean;
	/** Upstream refs observed while performing that early guard evaluation. */
	whenReadRefs?: string[];
	/** Resource context before this phase narrowed/allocated its own cwd. Gate
	 * retries must re-run upstream phases in this parent context. */
	upstreamDeps?: RuntimeDeps;
	/** Internal exact prompt list, populated once per actual subagent attempt. */
	promptCalls?: string[];
}

async function executePhase(
	phase: Phase,
	state: RunState,
	deps: RuntimeDeps,
	prior: PhaseState | undefined,
	emitProgress: () => void,
	_retryDepth = 0,
	opts?: PhaseExecOpts,
): Promise<PhaseState> {
	// Trace: phase-start (fail-open). Record whether this phase is replayable
	// up front so replay can short-circuit it without guessing from output.
	traceEmit(deps, {
		ts: Date.now(),
		runId: state.runId,
		phaseId: phase.id,
		kind: "phase-start",
		dependencies: dependenciesOf(phase),
		optional: phase.optional === true,
	});
	if (deps.trace) emitUnreplayableMarker(deps, state, phase);
	let result: PhaseState;
	let threw = false;
	const promptCalls: string[] = [];
	const trackedOpts: PhaseExecOpts = { ...opts, promptCalls };
	try {
		result = await executePhaseImpl(phase, state, deps, prior, emitProgress, _retryDepth, trackedOpts);
	} catch (e) {
		threw = true;
		// Trace: phase-end on failure (fail-open) before re-throwing.
		traceEmit(deps, {
			ts: Date.now(), runId: state.runId, phaseId: phase.id, kind: "phase-end",
			status: "failed", error: e instanceof Error ? e.message : String(e),
		});
		traceFlush(deps, phase.id);
		throw e;
	}
	if (threw) return result; // unreachable; satisfies TS
	if (promptCalls.length > 0 && !result.cacheHit) {
		setPromptStats(result, promptCalls);
	}
	// S1: cache-hit decision (within-run or cross-run) for fold/replay.
	if (result.cacheHit) {
		traceDecision(deps, state, phase.id, {
			type: "cache-hit",
			scope: result.cacheHit === "cross-run" ? "cross-run" : "run-only",
		});
	}
	// Trace: phase-end with the real status, then flush buffered events.
	traceEmit(deps, {
		ts: Date.now(), runId: state.runId, phaseId: phase.id, kind: "phase-end",
		status: result.status, error: result.error,
	});
	traceFlush(deps, phase.id);
	return result;
}

/** The pre-trace body of executePhase (workspace lifecycle + stamping). */
async function executePhaseImpl(
	phase: Phase,
	state: RunState,
	deps: RuntimeDeps,
	prior: PhaseState | undefined,
	emitProgress: () => void,
	_retryDepth = 0,
	opts?: PhaseExecOpts,
): Promise<PhaseState> {
	// Side-effect classification: stamp the marker at the single exit point so
	// every type branch inside executePhaseInner is covered. A skipped phase ran
	// nothing — no side effect to record.
	const stamp = (ps: PhaseState): PhaseState => {
		if (phase.optional === true) ps.optional = true;
		if (phase.idempotent === false && ps.status !== "skipped") {
			ps.sideEffect = true;
			// Resume double-fire warning (issue #20): a non-idempotent phase is never
			// cached, so on resume it RE-EXECUTES even though a prior attempt already
			// completed — re-firing its side effect. Surface it so operators aren't
			// surprised by a second webhook/deploy. Only when a prior DONE state
			// existed (the resume signal) and this run actually re-ran (status done).
			if (prior?.status === "done" && ps.status === "done" && !ps.cacheHit) {
				ps.warnings = [...(ps.warnings ?? []), "idempotent:false phase re-executed on resume (a prior attempt had completed) — its side effect fired again"];
			}
		}
		return ps;
	};
	const cwdArg = cwdArgName(phase.cwd);
	let innerOpts: PhaseExecOpts = { ...opts, upstreamDeps: deps };
	if ((cwdArg !== undefined || deps._dynamic === true || deps._cwdBoundary !== undefined) && phase.when !== undefined) {
		const whenReadRefs: string[] = [];
		const whenCtx = buildInterpolationContext(
			state,
			lastCompletedOutput(state, phase),
			undefined,
			(ref) => whenReadRefs.push(ref),
		);
		const whenResult = evaluateCondition(phase.when, whenCtx);
		traceDecision(deps, state, phase.id, {
			type: "when-guard",
			expression: phase.when,
			result: whenResult,
		});
		if (!whenResult) {
			return stamp({
				id: phase.id,
				status: "skipped",
				error: `Condition not met: ${phase.when}`,
				endedAt: Date.now(),
				usage: emptyUsage(),
				reads: readRefsToReads(whenReadRefs, state),
			});
		}
		innerOpts = { ...innerOpts, whenPrechecked: true, whenReadRefs };
	}
	if (deps._dynamic === true && ((phase.context?.length ?? 0) > 0 || phase.cwd !== undefined)) {
		return stamp({
			id: phase.id,
			status: "failed",
			error: "TF_DYNAMIC_RESOURCE_FORBIDDEN: generated sub-flows cannot declare cwd or context file pre-reads",
			endedAt: Date.now(),
			usage: emptyUsage(),
		});
	}
	if (cwdArg !== undefined) {
		const spec = state.def.args?.[cwdArg] as { type?: string } | undefined;
		if (spec?.type !== "relative-path") {
			return stamp({
				id: phase.id,
				status: "failed",
				error: `TF_CWD_ARG_INVALID: cwd argument '${cwdArg}' is not declared with type 'relative-path'`,
				endedAt: Date.now(),
				usage: emptyUsage(),
			});
		}
		const bridgeMode = deps.workspaceSession ? "resolve-only" : deps.cwdBridgeMode;
		const bound = resolveCwdArg(deps.cwd, cwdArg, state.args[cwdArg], bridgeMode);
		if (!bound.ok) {
			return stamp({
				id: phase.id,
				status: "failed",
				error: `${bound.code}: ${bound.message}`,
				endedAt: Date.now(),
				usage: emptyUsage(),
			});
		}
		if (deps._cwdBoundary && !isPathWithin(deps._cwdBoundary, bound.value.absolutePath)) {
			return stamp({
				id: phase.id,
				status: "failed",
				error: `TF_CWD_BOUNDARY_ESCAPE: cwd argument '${cwdArg}' resolves outside the inherited cwd boundary`,
				endedAt: Date.now(),
				usage: emptyUsage(),
			});
		}
		let workspaceBinding: ResolveOnlyPhaseBinding | undefined;
		try {
			workspaceBinding = await deps.workspaceSession?.bindPhase({
				invocationRoot: deps.cwd,
				runId: state.runId,
				phaseId: phase.id,
				argName: cwdArg,
				argDefinitions: state.def.args ?? {},
				argValues: state.args,
			});
		} catch (error) {
			return stamp({
				id: phase.id,
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
				endedAt: Date.now(),
				usage: emptyUsage(),
			});
		}
		if (workspaceBinding && workspaceBinding.absolutePath !== bound.value.absolutePath) {
			return stamp({
				id: phase.id,
				status: "failed",
				error: "TFWS_IDENTITY_MISMATCH: compatibility resolver and capability resolver selected different cwd identities",
				endedAt: Date.now(),
				usage: emptyUsage(),
			});
		}
		const innerDeps: RuntimeDeps = {
			...deps,
			_cwdOverride: bound.value.absolutePath,
			_cwdBoundary: bound.value.absolutePath,
			_cacheCwdIdentity: bound.value.absolutePath,
			_disableCache: true,
			_workspaceBinding: workspaceBinding,
		};
		const ps = await executePhaseInner(phase, state, innerDeps, prior, emitProgress, _retryDepth, innerOpts);
		ps.warnings = [
			...(ps.warnings ?? []),
			`cwd bridge: resolve-only {args.${cwdArg}} -> ${bound.value.logicalPath}; principal/root authorization, cross-process lease, and write journal are active, but filesystem access outside this directory is not sandbox-enforced`,
		];
		return stamp(ps);
	}
	if (deps._cwdBoundary && phase.cwd) {
		if (isWorkspaceKeyword(phase.cwd)) {
			return stamp({
				id: phase.id,
				status: "failed",
				error: `TF_CWD_BOUNDARY_ESCAPE: workspace provider '${phase.cwd}' cannot expand an inherited cwd boundary`,
				endedAt: Date.now(),
				usage: emptyUsage(),
			});
		}
		const selected = directoryIdentity(path.resolve(deps.cwd, phase.cwd));
		if (!selected || !isPathWithin(deps._cwdBoundary, selected.canonicalPath)) {
			return stamp({
				id: phase.id,
				status: "failed",
				error: `TF_CWD_BOUNDARY_ESCAPE: cwd '${phase.cwd}' must select an existing directory inside the inherited cwd boundary`,
				endedAt: Date.now(),
				usage: emptyUsage(),
			});
		}
		let narrowedBinding: ResolveOnlyPhaseBinding | undefined;
		try {
			narrowedBinding = await deps.workspaceSession?.bindPhase({
				invocationRoot: selected.canonicalPath,
				runId: state.runId,
				phaseId: phase.id,
				argDefinitions: state.def.args ?? {},
				argValues: state.args,
			});
		} catch (error) {
			return stamp({
				id: phase.id,
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
				endedAt: Date.now(),
				usage: emptyUsage(),
			});
		}
		return stamp(await executePhaseInner(
			phase,
			state,
			{
				...deps,
				_cwdOverride: selected.canonicalPath,
				_cwdBoundary: selected.canonicalPath,
				_cacheCwdIdentity: selected.canonicalPath,
				_workspaceBinding: narrowedBinding,
			},
			prior,
			emitProgress,
			_retryDepth,
			innerOpts,
		));
	}
	// Non-keyword cwd (or none): no workspace lifecycle — run directly.
	if (!isWorkspaceKeyword(phase.cwd)) {
		return stamp(await executePhaseInner(phase, state, deps, prior, emitProgress, _retryDepth, innerOpts));
	}
	let ws: Workspace | undefined;
	try {
		ws = allocateWorkspace(phase.cwd, {
			baseCwd: deps.cwd,
			runId: state.runId,
			phaseId: phase.id,
			runsRoot: runsDir(deps.cwd),
		});
	} catch {
		ws = undefined; // fail-open: run in the base cwd
	}
	const innerDeps: RuntimeDeps = ws ? { ...deps, _cwdOverride: ws.dir, _cacheCwdIdentity: ws.dir } : deps;
	try {
		const ps = await executePhaseInner(phase, state, innerDeps, prior, emitProgress, _retryDepth, innerOpts);
		if (ws && (ws.kind !== "inherited" || ws.note)) {
			const tag = ws.kind === "inherited" ? "workspace" : `workspace:${ws.kind}`;
			const msg = ws.note ? `${tag} — ${ws.note}` : `${tag} at ${ws.dir}`;
			ps.warnings = [...(ps.warnings ?? []), msg];
		}
		return stamp(ps);
	} finally {
		try {
			ws?.teardown();
		} catch {
			/* fail-open: teardown best-effort */
		}
	}
}

async function executePhaseInner(
	phase: Phase,
	state: RunState,
	deps: RuntimeDeps,
	prior: PhaseState | undefined,
	emitProgress: () => void,
	_retryDepth = 0,
	opts?: PhaseExecOpts,
): Promise<PhaseState> {
	const type = phase.type ?? "agent";
	const concurrency = phase.concurrency ?? state.def.concurrency ?? 8;
	// BREAKING (dogfood issue 1): a reduce phase's {previous.output} aggregates
	// ALL completed `from[]` outputs in from-array order (one → raw, many →
	// `### <id>\n\n<output>` joined by `\n\n---\n\n`). Other phase types keep the
	// historical "last completed dependency" behavior. The aggregated from-ids
	// are recorded as observed reads (below) so staleness tracks them.
	const reduceAgg = type === "reduce" ? aggregateReduceFrom(state, phase) : undefined;
	const previousOutput = reduceAgg ? reduceAgg.value : lastCompletedOutput(state, phase);
	const run = deps.runTask ?? noRunnerInjected;
	// Effective working directory for THIS phase's execution. When an isolated
	// workspace was allocated (worktree isolation), `_cwdOverride` is its dir and
	// takes precedence; otherwise a literal `phase.cwd` (non-keyword) or the run
	// cwd is used. Keyword cwds are never passed to a runner (they're resolved
	// upstream in the executePhase wrapper).
	const effCwd = resolveEffCwd(deps, phase);

	// Shared Context Tree opt-in (per-phase or flow-wide). When on, the subagent
	// gets ctx_* tools backed by a per-run blackboard directory. nodeId is
	// deterministic per phase so a resume re-uses the same tree node (idempotent
	// upsert in registerNode prevents duplication). Sub-items (map/parallel) get
	// a suffixed nodeId so concurrent siblings write to distinct findings files.
	const sharing = (phase.shareContext ?? state.def.contextSharing) === true;
	let ctxDir: string | undefined;
	if (sharing) {
		try {
			ctxDir = deps._ctxDir ?? initCtxDir(ctxDirFor(runsDir(deps.cwd), state.runId));
		} catch {
			ctxDir = undefined; // fail-open: degrade to no sharing
		}
	}
	const nodeIdFor = (suffix?: string): string =>
		`${phase.id}${suffix ? `-${suffix}` : ""}`.replace(/[^A-Za-z0-9._-]+/g, "_");

	// Resolve context pre-read files once, before any type branching.
	// The content is prepended to every task so the subagent never spends
	// turns on file exploration for files the flow author already knows.
	// M3 observed-readSet: collect every upstream ref this phase resolves, so we
	// can record what its result ACTUALLY depended on (not just its declared
	// dependsOn). Shared by every interpolation in this phase (task / when / …).
	const readRefs: string[] = [...(opts?.whenReadRefs ?? [])];
	const onRead = (ref: string): void => {
		readRefs.push(ref);
	};
	// Record the reduce-aggregated from-ids as observed reads: the phase consumed
	// these upstream outputs (folded into {previous.output}) even when the task
	// references {previous.output} once (a single placeholder read would otherwise
	// record only "previous.output", not the real upstream ids).
	if (reduceAgg) {
		for (const id of reduceAgg.ids) readRefs.push(`steps.${id}.output`);
	}
	const ctx = buildInterpolationContext(state, previousOutput, undefined, onRead);

	// M3 observed-readSet: when conditions are part of the phase's real
	// dependencies. Evaluate them inside executePhaseInner so every upstream
	// interpolation is captured by the shared onRead hook, not silently dropped
	// by a separate out-of-band context.
	if (phase.when !== undefined && opts?.whenPrechecked !== true) {
		const whenResult = evaluateCondition(phase.when, ctx);
		traceDecision(deps, state, phase.id, {
			type: "when-guard",
			expression: phase.when,
			result: whenResult,
		});
		if (!whenResult) {
			return {
				id: phase.id,
				status: "skipped",
				error: `Condition not met: ${phase.when}`,
				endedAt: Date.now(),
				usage: emptyUsage(),
				reads: readRefsToReads(readRefs, state),
			};
		}
	}

	// `context` keeps its historical invocation-root meaning. Phase cwd may be a
	// temporary/worktree directory; rebasing context there would silently stop
	// existing flows from reading authored source files.
	const preRead = await resolvePhaseContext(phase, ctx, deps.cwd, deps._cwdBoundary);

	// Resolve this phase's cache policy once. Default scope is "run-only" (the
	// historical within-run resume behavior). Only "cross-run" phases resolve a
	// fingerprint and consult the persistent store.
	let cacheScope: CacheScope = (phase.cache?.scope ?? deps.cacheScopeDefault ?? "run-only") as CacheScope;
	// Defense in depth: gate/approval/loop/tournament must produce a fresh result
	// each run (schema already rejects explicit cross-run, but the default-scope
	// path must also be blocked). If flowDefHash failed, cross-run is unsafe
	// because the key degrades to flowName-only and reopens cross-flow collisions.
	const CROSS_RUN_BLOCKED_TYPES = new Set(["gate", "approval", "loop", "tournament", "script", "race", "expand"]);
	if (cacheScope === "cross-run" && CROSS_RUN_BLOCKED_TYPES.has(type)) {
		cacheScope = "run-only";
	}
	if (state.flowDefHash === "failed" && cacheScope === "cross-run") {
		cacheScope = "run-only";
	}
	// Side-effect classification: a non-idempotent phase is NEVER cached — not
	// served from within-run resume, not served from or written to the cross-run
	// store (cachedPhase and recordCache both gate on scope). One assignment
	// covers every cache path, including the map per-item path (perItemCacheable
	// requires scope === "cross-run").
	if (phase.idempotent === false) {
		cacheScope = "off";
	}
	if (deps._disableCache) {
		cacheScope = "off";
	}
	const cc: PhaseCacheCtx = {
		scope: cacheScope,
		ttlMs: phase.cache?.ttl ? (parseTtlMs(phase.cache.ttl) ?? undefined) : undefined,
		fingerprint: cacheScope === "cross-run" ? resolveFingerprint(phase.cache?.fingerprint, effCwd) : "",
		store: deps.cacheStore ?? new CacheStore(deps.cwd),
		prior,
		phaseId: phase.id,
		flowName: state.flowName,
		runId: state.runId,
		flowDefHash: state.flowDefHash === "failed" ? undefined : state.flowDefHash,
		phaseFp: state.phaseFingerprints?.[phase.id],
		forceRerun: opts?.forceRerun,
		thinking: phase.thinking,
		tools: phase.tools,
		preRead,
		agentScope: state.def.agentScope,
		contextSharing: state.def.contextSharing === true,
		agentDefinitions: agentDefinitionsIdentity(deps.agents),
		executionCwd: directoryIdentity(effCwd)?.canonicalPath ?? path.resolve(effCwd),
	};

	// Effective idle watchdog (ms): phase overrides flow; host default (300000)
	// applies when neither sets it. `0` disables the watchdog (validation already
	// required a finite wall `timeout` in that case). Threaded into RunOptions so
	// every host runner that delegates to runSubagentProcess honors it.
	const effIdleTimeoutMs = resolveIdleTimeoutMs(phase, state.def);

	const baseRun = (
		agentName: string,
		task: string,
		onLive?: (l: LiveUpdate) => void,
		ctxNodeId?: string,
		signal?: AbortSignal,
		callCwd?: string,
		onTerminalCommit?: () => void,
	) => {
		const invocationCwd = callCwd ? path.resolve(deps.cwd, callCwd) : effCwd;
		// A per-branch cwd cannot replace a phase-level workspace/cwd-bridge
		// binding: that would bypass the binding's containment/dirty-state
		// lifecycle. Validation rejects this shape; keep a runtime fail-closed
		// guard for direct callers or legacy persisted definitions.
		if (callCwd && (deps._workspaceBinding || isWorkspaceKeyword(phase.cwd))) {
			return Promise.resolve({
				agent: agentName,
				task,
				exitCode: 1,
				output: "",
				stderr: "TF_CWD_BRANCH_BINDING_CONFLICT: per-branch cwd cannot override a phase workspace binding",
				usage: emptyUsage(),
				stopReason: "error",
				errorMessage: "TF_CWD_BRANCH_BINDING_CONFLICT: per-branch cwd cannot override a phase workspace binding",
			});
		}
		if (callCwd && deps._cwdBoundary) {
			const selected = directoryIdentity(invocationCwd);
			if (!selected || !isPathWithin(deps._cwdBoundary, selected.canonicalPath)) {
				return Promise.resolve({
					agent: agentName,
					task,
					exitCode: 1,
					output: "",
					stderr: "TF_CWD_BOUNDARY_ESCAPE: per-branch cwd must select an existing directory inside the inherited cwd boundary",
					usage: emptyUsage(),
					stopReason: "error",
					errorMessage: "TF_CWD_BOUNDARY_ESCAPE: per-branch cwd must select an existing directory inside the inherited cwd boundary",
				});
			}
		}
		opts?.promptCalls?.push(task);
		const runOptions = {
			model: phase.model,
			thinking: phase.thinking,
			tools: phase.tools,
			cwd: invocationCwd,
			signal: signal ?? deps.signal,
			onLive,
			ctxDir: ctxDir,
			nodeId: ctxDir ? ctxNodeId : undefined,
			idleTimeoutMs: effIdleTimeoutMs,
			onTerminalCommit,
		};
		const invoke = () => run(
			invocationCwd,
			deps.agents,
			agentName,
			task,
			runOptions,
			deps.globalThinking,
		);
		return deps._workspaceBinding
			? deps._workspaceBinding.runAgent({
				agents: deps.agents,
				agentName,
				task,
				opts: runOptions,
				globalThinking: deps.globalThinking,
				unitId: ctxNodeId ?? phase.id,
				invoke,
			})
			: invoke();
	};

	// Wrap each subagent call in the phase's retry policy. Usage is summed across
	// attempts; the attempt count rides along on the result for the TUI.
	//
	// Even without an explicit `phase.retry`, transient provider errors (rate
	// limits, overload, 5xx, timeouts) are retried with backoff so a momentary
	// 429 is absorbed inside this run instead of bubbling up and provoking the
	// calling agent to re-invoke the whole tool (which stacks duplicate progress
	// blocks in the transcript).
	const retry = phase.retry;
	const DEFAULT_TRANSIENT_RETRIES = 3;
	const DEFAULT_TRANSIENT_BACKOFF_MS = 2000;
	const DEFAULT_TRANSIENT_FACTOR = 2;
	// Per-phase timeout: caps EACH subagent call of an agent-running phase.
	// (script phases enforce their own child-process timeout — see the script branch.)
	const phaseTimeoutMs =
		type !== "script" && typeof phase.timeout === "number" && Number.isFinite(phase.timeout) && phase.timeout >= 1000
			? phase.timeout
			: undefined;
	const runOne = async (
		agentName: string,
		task: string,
		onLive?: (l: LiveUpdate) => void,
		ctxNodeId?: string,
		check?: (r: RunResult) => string[],
		/** Extra abort (e.g. race branch cancelLosers) — chained with run + phase timeout. */
		extraSignal?: AbortSignal,
		/** Per-call cwd override (e.g. a parallel branch's literal cwd). Falls back
		 *  to the phase effective cwd when absent. Workspace keywords are rejected
		 *  by validation for branches, so this is always a literal path or undefined. */
		callCwd?: string,
		/** Usage already spent by earlier calls inside this same multi-call phase
		 * (tree reduce). Included in live budget accounting, but not returned as
		 * this call's own usage. */
		usageBefore?: UsageStats,
		/** Optional hard admission guard invoked immediately before EVERY actual
		 * runner attempt. Return an error message to deny that attempt. */
		beforeAttempt?: () => string | undefined,
	): Promise<RunResult> => {
		const explicitMax = Math.max(1, 1 + Math.max(0, Math.floor(retry?.max ?? 0)));
		// Allow enough attempts to cover whichever policy applies on a given attempt.
		const maxAttempts = Math.max(explicitMax, 1 + DEFAULT_TRANSIENT_RETRIES);
		const usages: UsageStats[] = [];
		let last: RunResult | undefined;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (deps.signal?.aborted || extraSignal?.aborted) break;
			const admissionError = beforeAttempt?.();
			if (admissionError) {
				last = {
					agent: agentName,
					task,
					exitCode: 1,
					output: "",
					stderr: admissionError,
					usage: emptyUsage(),
					stopReason: "error",
					errorMessage: admissionError,
				};
				break;
			}
			// AbortController chains: run signal + optional extra (race cancel) + phase timeout.
			// Deterministic: a timed-out call is never retried (would double-spend).
			let timedOut = false;
			let terminalCommitted = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let forceReturnTimer: ReturnType<typeof setTimeout> | undefined;
			const removers: Array<() => void> = [];
			let callSignal: AbortSignal | undefined;
			let timeoutController: AbortController | undefined;
			if (phaseTimeoutMs || extraSignal) {
				const ac = new AbortController();
				timeoutController = ac;
				callSignal = ac.signal;
				if (deps.signal?.aborted || extraSignal?.aborted) ac.abort();
				else {
					if (deps.signal) {
						const fn = () => ac.abort();
						deps.signal.addEventListener("abort", fn, { once: true });
						removers.push(() => deps.signal?.removeEventListener("abort", fn));
					}
					if (extraSignal) {
						const fn = () => ac.abort();
						extraSignal.addEventListener("abort", fn, { once: true });
						removers.push(() => extraSignal.removeEventListener("abort", fn));
					}
				}
			}
			try {
				const onTerminalCommit = () => {
					if (timedOut) return;
					terminalCommitted = true;
					if (timer) {
						clearTimeout(timer);
						timer = undefined;
					}
				};
				const invocation = baseRun(agentName, task, onLive, ctxNodeId, callSignal, callCwd, onTerminalCommit);
				if (phaseTimeoutMs && timeoutController) {
					const timeoutFallback = new Promise<RunResult>((resolve) => {
						timer = setTimeout(() => {
							if (terminalCommitted) return;
							timedOut = true;
							timeoutController?.abort();
							forceReturnTimer = setTimeout(() => resolve({
								agent: agentName,
								task,
								exitCode: 1,
								output: "",
								stderr: "",
								usage: emptyUsage(),
								stopReason: "error",
								errorMessage: `Phase runner did not stop within ${PHASE_TIMEOUT_ABORT_GRACE_MS}ms after abort`,
								phaseTimeout: true,
								completionSource: "phase-timeout",
							}), PHASE_TIMEOUT_ABORT_GRACE_MS);
						}, phaseTimeoutMs);
					});
					last = await Promise.race([invocation, timeoutFallback]);
				} else {
					last = await invocation;
				}
			} finally {
				if (timer) clearTimeout(timer);
				if (forceReturnTimer) clearTimeout(forceReturnTimer);
				for (const r of removers) r();
			}
			if (timedOut) {
				// Reclassify the abort as a phase timeout: a distinct, deterministic
				// failure (stopReason "error" keeps it in the failed bucket; the
				// phaseTimeout marker excludes it from transient retry).
				last = {
					...last,
					exitCode: last.exitCode === 0 ? 1 : last.exitCode,
					stopReason: "error",
					errorMessage: `Phase timed out after ${phaseTimeoutMs}ms (subagent aborted)`,
					phaseTimeout: true,
					completionSource: "phase-timeout",
				};
				usages.push(last.usage);
				traceEmit(deps, {
					ts: Date.now(), runId: state.runId, phaseId: phase.id, kind: "subagent-call",
					input: { agent: agentName, model: phase.model, task, preRead, nodePath: ctxNodeId ?? phase.id, attempt },
					output: {
						text: last.output, model: last.model, usage: last.usage, stopReason: last.stopReason,
						completionSource: last.completionSource,
						reapedAfterTerminal: last.reapedAfterTerminal,
						terminalGraceMs: last.terminalGraceMs,
					},
				});
				traceFlush(deps, phase.id);
				break;
			}
			usages.push(last.usage);
			// Output contract (`expect`): a successful attempt whose JSON output
			// violates the declared contract is a failure — eligible for the phase's
			// explicit retry policy (never the transient fallback).
			if (check && !isFailed(last)) {
				const violations = check(last);
				if (violations.length > 0) {
					last = {
						...last,
						exitCode: last.exitCode === 0 ? 1 : last.exitCode,
						stopReason: "error",
						errorMessage: `Output contract violated:\n- ${violations.join("\n- ")}`,
					};
				}
			}
			// B6: aggregate and surface cumulative usage before the retry decision,
			// so the TUI / budget guard see the in-flight spend on every attempt.
			const liveRetry = state.phases[phase.id];
			if (liveRetry) liveRetry.usage = aggregateUsage(usageBefore ? [usageBefore, ...usages] : usages);
			// Persist every attempt, not only the final aggregate. This is required
			// for honest replay/cost accounting when a transient or explicit retry
			// succeeds after earlier spend.
			traceEmit(deps, {
				ts: Date.now(), runId: state.runId, phaseId: phase.id, kind: "subagent-call",
				input: { agent: agentName, model: phase.model, task, preRead, nodePath: ctxNodeId ?? phase.id, attempt },
				output: {
					text: last.output, model: last.model, usage: last.usage, stopReason: last.stopReason,
					completionSource: last.completionSource,
					reapedAfterTerminal: last.reapedAfterTerminal,
					terminalGraceMs: last.terminalGraceMs,
				},
			});
			traceFlush(deps, phase.id);
			if (!isFailed(last)) break;
			// Stop retrying on abort (run-level or race cancel) or once over budget.
			if (deps.signal?.aborted || extraSignal?.aborted || overBudget(state).over) break;
			if (deps._workspaceBinding) {
				// A failed RW-capability attempt has an unknown filesystem outcome and
				// is durably marked dirty. Retrying it cannot be proven idempotent until
				// workspace snapshots/restoration exist, so preserve the first failure
				// instead of replacing it with a later TFWS_RESOURCE_DIRTY refusal.
				const requestedRetry = (retry?.max ?? 0) > 0 || isTransientError(last);
				if (requestedRetry && last.workspaceMutationStarted) {
					last = {
						...last,
						errorMessage: `${last.errorMessage ?? last.stderr ?? "workspace execution failed"}\nTFWS_RETRY_UNSAFE: retry suppressed because the prior read-write attempt may have mutated the workspace; reconcile before a new attempt`,
					};
				}
				break;
			}
			// Decide whether THIS failure warrants another attempt. Explicit retry
			// policy covers all failures up to its cap; the transient fallback covers
			// only retryable provider errors. A non-transient failure with no explicit
			// policy stops immediately (no point burning attempts on a hard error).
			const withinExplicit = attempt < explicitMax - 1;
			const transient = isTransientError(last);
			// Side-effect classification: the implicit transient retry is a runtime
			// safety net the author did not ask for — repeating a side-effecting
			// call behind the author's back is exactly the hazard idempotent:false
			// exists to prevent. Explicit retry{} (withinExplicit) stays honored:
			// it is the author's declaration that a repeat is acceptable.
			const allowTransient = phase.idempotent !== false;
			const withinTransient = transient && allowTransient && attempt < DEFAULT_TRANSIENT_RETRIES;
			if (!withinExplicit && !withinTransient) break;
			// Backoff: prefer the explicit policy's curve when the phase defines one
			// (covers transient retries too, and keeps tests fast with backoffMs:0),
			// otherwise use the transient defaults.
			const baseMs = retry?.backoffMs != null ? retry.backoffMs : DEFAULT_TRANSIENT_BACKOFF_MS;
			// Factor asymmetry is intentional:
			// - Explicit retry: backoffMs * (factor ?? 1) ^ attempt — user's
			//   curve, defaults to flat (factor=1 → constant backoff).
			// - Transient fallback: backoffMs * 2 ^ attempt — exponential.
			// This lets users opt into flat retry with retry: {max:3} without
			// specifying factor, while transient errors get proper exponential
			// backoff.
			const factor = retry ? (retry.factor ?? 1) : DEFAULT_TRANSIENT_FACTOR;
			const wait = Math.min(60000, Math.round(baseMs * factor ** attempt));
			if (wait > 0) {
				// Honor run abort and/or race-branch cancel during backoff.
				if (deps.signal && extraSignal) {
					const ac = new AbortController();
					const ab = () => ac.abort();
					if (deps.signal.aborted || extraSignal.aborted) ac.abort();
					else {
						deps.signal.addEventListener("abort", ab, { once: true });
						extraSignal.addEventListener("abort", ab, { once: true });
					}
					try {
						await delay(wait, ac.signal);
					} finally {
						deps.signal.removeEventListener("abort", ab);
						extraSignal.removeEventListener("abort", ab);
					}
				} else {
					await delay(wait, extraSignal ?? deps.signal);
				}
			}
		}
		// Aborted before any attempt ran → return a clean aborted result (no crash).
		if (!last) {
			return {
				agent: agentName,
				task,
				exitCode: 1,
				output: "",
				stderr: "Aborted before execution",
				usage: emptyUsage(),
				stopReason: "aborted",
				errorMessage: "Aborted before execution",
				attempts: 0,
			};
		}
		if (usages.length > 0) last.usage = aggregateUsage(usages);
		last.attempts = usages.length;
		return last;
	};

	const runSpawnedChild: SpawnChildRunner = async (agentName, task, childNodeId, spawnedUsageBefore) => {
		// runOne updates the live phase usage so retry/budget admission sees current
		// spend. A spawned child is folded into the parent result later, so restore
		// the parent's pre-child usage after the call to avoid replacing/doubling it.
		const livePhase = state.phases[phase.id];
		const parentUsage = livePhase?.usage ? { ...livePhase.usage } : undefined;
		const totalUsageBefore = aggregateUsage([
			parentUsage ?? emptyUsage(),
			spawnedUsageBefore ?? emptyUsage(),
		]);
		try {
			return await runOne(
				agentName,
				task,
				undefined,
				childNodeId,
				undefined,
				undefined,
				undefined,
				totalUsageBefore,
			);
		} finally {
			if (livePhase) {
				if (parentUsage) livePhase.usage = parentUsage;
					else livePhase.usage = undefined;
			}
		}
	};

	const parseJson = phase.output === "json";

	// Output contract (`expect`): validates the parsed JSON output of a finished
	// subagent call. Wired into `runOne` so a violation counts as a failed attempt
	// (retryable under the phase's explicit `retry` policy).
	const contractCheck =
		phase.expect !== undefined && parseJson
			? (r: RunResult): string[] => {
					const parsed = safeParse(r.output);
					if (parsed === undefined) return ["$: output is not valid JSON (contract could not be checked)"];
					return contractViolations(parsed, phase.expect);
				}
			: undefined;

	// Runs a list of sub-tasks with live fan-out progress + aggregate live usage/activity.
	// `perItem` (map only) enables per-item cross-run caching: each item is looked
	// up in the cache before spawning a subagent, and a successful fresh item is
	// recorded so a later run with that item unchanged hits per-item. When
	// `perItem` is undefined (parallel, or non-cacheable maps) the path is inert.
	const runFanout = async (
		items: Array<{ agent: string; task: string; cwd?: string }>,
		perItem?: { keyOf: (idx: number) => CacheKeys | null; cc: PhaseCacheCtx },
	): Promise<RunResult[]> => {
		let done = 0;
		let running = 0;
		let failed = 0;
		const total = items.length;
		const live = state.phases[phase.id];
		const liveUsages: UsageStats[] = items.map(() => emptyUsage());
		let latestText = "";
		let latestModel: string | undefined;
		const refresh = () => {
			if (live) {
				live.subProgress = { done, total, running, failed };
				live.usage = aggregateUsage(liveUsages);
				live.liveText = latestText;
				live.model = latestModel;
			}
			emitProgress();
		};
		refresh();
		// Usage is only authoritative after a call reports it. Serial admission for
		// budgeted fan-out prevents N siblings from all observing the same remaining
		// allowance and overshooting it concurrently.
		const admissionConcurrency = state.def.budget ? 1 : concurrency;
		return mapWithConcurrencyLimit(items, admissionConcurrency, async (it, idx) => {
			// Budget guard: stop spawning new fan-out items once the run is over budget.
			if (overBudget(state).over) {
				done++;
				refresh();
				return {
					agent: it.agent,
					task: it.task,
					exitCode: 0,
					output: "(skipped: budget exceeded)",
					stderr: "",
					usage: emptyUsage(),
					stopReason: "budget-skipped",
				} satisfies RunResult;
			}
			// Per-item cross-run cache lookup (map only). A hit synthesizes a 0-token
			// RunResult and returns immediately — the item never spawns a subagent and
			// never reaches the ctx_spawn drain below (a cached item can't have queued
			// new spawns). Fail-open: any error in the lookup path degrades to executing.
			if (perItem) {
				try {
					const ckItem = perItem.keyOf(idx);
					if (ckItem) {
						const hit = cachedPhase(perItem.cc, ckItem);
						if (hit) {
							done++;
							const synth = phaseStateToRunResult(hit, it);
							liveUsages[idx] = emptyUsage();
							if (hit.model) latestModel = hit.model;
							refresh();
							return synth;
						}
					}
				} catch {
					/* fail-open: a cache read error must never sink the item */
				}
			}
			running++;
			refresh();
			if (ctxDir) {
				try { registerNode(ctxDir, nodeIdFor(String(idx)), phase.id, undefined, "running"); } catch { /* fail-open */ }
			}
			const r = await runOne(it.agent, it.task, (l) => {
				liveUsages[idx] = l.usage;
				if (l.text) latestText = l.text;
				if (l.model) latestModel = l.model;
				refresh();
			}, ctxDir ? nodeIdFor(String(idx)) : undefined, undefined, undefined, it.cwd);
			running--;
			done++;
			if (isFailed(r)) failed++;
			liveUsages[idx] = r.usage;
			// Publish the just-finished sibling's spend before considering any
			// ctx_spawn intents. Budgeted fan-out allows one atomic call to cross the
			// ceiling, but must not admit descendants after that overshoot.
			refresh();
			// Per-item cross-run cache record (map only): persist a successful fresh
			// item so a later run with this item unchanged hits per-item instead of
			// re-running. Failed and budget-skipped items are never cached (a stale
			// failure would be served on the next run). Fail-open: a write error never
			// sinks the item — the fresh `r` is already in hand and flows downstream.
			if (perItem && !isFailed(r) && r.stopReason !== "budget-skipped") {
				try {
					const ckItem = perItem.keyOf(idx);
					if (ckItem) {
						const ccItem: PhaseCacheCtx = { ...perItem.cc, phaseId: `${phase.id}#item${idx}` };
						const itemPs = resultToPhaseState(`${phase.id}#item${idx}`, r, ckItem.key, parseJson);
						recordCache(ccItem, itemPs);
					}
				} catch {
					/* fail-open: cache write must never sink the item */
				}
			}
			if (ctxDir) {
				try {
					const itemNid = nodeIdFor(String(idx));
					setNodeStatus(ctxDir, itemNid, isFailed(r) ? "failed" : "done");
					// A fan-out item may itself ctx_spawn children. Without this drain a
					// map/parallel item's spawn intents are silently orphaned (the
					// post-run drain below only covers single-agent phases).
					const spawned = drainPendingSpawns(ctxDir, itemNid);
					if (spawned.length > 0 && !deps.signal?.aborted && !overBudget(state).over) {
						const child = await runSpawnedChildren(
							spawned,
							ctxDir,
							itemNid,
							phase,
							deps,
							state,
							runSpawnedChild,
							{ usage: emptyUsage() },
						);
						if (child.reports) r.output = `${r.output ?? ""}${child.reports}`;
						if (child.failed && deps._workspaceBinding) {
							r.exitCode = r.exitCode === 0 ? 1 : r.exitCode;
							r.stopReason = "error";
							r.errorMessage = `Workspace ctx_spawn descendant failed: ${child.errors.join("; ")}`;
						}
						if (child.usage) {
							r.usage = aggregateUsage([r.usage ?? emptyUsage(), child.usage]);
							liveUsages[idx] = r.usage;
						}
					}
				} catch { /* fail-open */ }
			}
			refresh();
			return r;
		});
	};

	// Single-agent phases: agent, gate, and reduce all run one subagent on an
	// interpolated task. gate additionally parses a verdict; reduce simply pulls
	// its inputs from `from` phases (already exposed via interpolation).
	//
	// Tree reduce (`reduceStrategy: "tree"`) is handled FIRST: it runs batched
	// intermediate reducer calls over the aggregated `from[]` inputs, reusing
	// `runOne` so retry/timeout/budget/idleTimeout behavior is identical to a
	// one-shot call. It forces the imperative runtime (the event kernel falls
	// back via kernelUnsupportedReason). The corrected `{previous.output}`
	// aggregation (all completed `from[]` sources) applies to EVERY round.
	if (type === "reduce" && (phase as { reduceStrategy?: string }).reduceStrategy === "tree") {
		const stratBs = (phase as { batchSize?: number }).batchSize;
		const batchSize = typeof stratBs === "number" && Number.isFinite(stratBs) && stratBs >= 2 ? Math.floor(stratBs) : 2;
		const {
			collectTreeReduceInputs,
			executeTreeReduction,
			treeReduceCacheParts,
		} = await import("./runtime/phases/reduce.ts");
		const inputs = collectTreeReduceInputs(state, phase);
		// 0–1 completed inputs: tree reduction is a no-op — fall through to the
		// one-shot path (which handles the degenerate case correctly).
		if (inputs.length >= 2) {
			const agentName = resolveAgent(phase.agent, deps, state);
			const cacheKey = cacheKeys(cc, treeReduceCacheParts(state, phase, inputs, batchSize));
			const cached = cachedPhase(cc, cacheKey);
			if (cached) return cached;

			const execution = await executeTreeReduction({
				phase,
				inputs,
				batchSize,
				agentName,
				inputHash: cacheKey.key,
				isAborted: () => deps.signal?.aborted === true,
				isOverBudget: () => overBudget(state).over,
				resolveTask: (batchValue) => {
					const batchCtx = buildInterpolationContext(state, batchValue, undefined, onRead);
					const interp = interpolate(phase.task ?? "", batchCtx);
					return {
						task: appendGateFormatSuffix(preRead + interp.text, phase),
						warning: warnUnresolvedRefs(phase.id, interp.missing),
					};
				},
				runOne: async (task, usageBefore, beforeAttempt, callId) => {
					const batchNodeId = nodeIdFor(`tree-${callId}`);
					if (ctxDir) {
						try { registerNode(ctxDir, batchNodeId, phase.id, undefined, "running"); } catch { /* fail-open */ }
					}
					const result = await runOne(
						agentName,
						task,
						liveSink(state, phase.id, emitProgress),
						batchNodeId,
						contractCheck,
						undefined,
						undefined,
						usageBefore,
						beforeAttempt,
					);
					if (ctxDir) {
						try {
							const spawned = drainPendingSpawns(ctxDir, batchNodeId);
							if (spawned.length > 0 && !deps.signal?.aborted && !overBudget(state).over) {
								const child = await runSpawnedChildren(
									spawned,
									ctxDir,
									batchNodeId,
									phase,
									deps,
									state,
									runSpawnedChild,
									{ usage: emptyUsage() },
								);
								if (child.reports) result.output = `${result.output ?? ""}${child.reports}`;
								if (child.failed && deps._workspaceBinding) {
									result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
									result.stopReason = "error";
									result.errorMessage = `Workspace ctx_spawn descendant failed: ${child.errors.join("; ")}`;
								}
								result.usage = aggregateUsage([result.usage ?? emptyUsage(), child.usage]);
							}
							setNodeStatus(ctxDir, batchNodeId, isFailed(result) ? "failed" : "done");
						} catch { /* fail-open */ }
					}
					const livePhase = state.phases[phase.id];
					if (livePhase) {
						livePhase.usage = aggregateUsage([
							usageBefore ?? emptyUsage(),
							result.usage ?? emptyUsage(),
						]);
					}
					return result;
				},
			});
			const ps = execution.phaseState;
			if (parseJson && ps.status === "done") ps.json = safeParse(ps.output ?? "");
			if (readRefs.length) ps.reads = readRefsToReads(readRefs, state);
			if (execution.refWarning) ps.warnings = [...(ps.warnings ?? []), execution.refWarning];
			if (ps.budgetTruncated) {
				ps.warnings = [...(ps.warnings ?? []), "tree reduction stopped by the run budget; output is partial"];
			}
			attachReduceInputStats(ps, state, phase);
			if (execution.cacheable) recordCache(cc, ps);
			return ps;
		}
		// inputs.length < 2 → fall through to one-shot (below).
	}
	if (type === "agent" || type === "gate" || type === "reduce") {
		// Eval gate: zero-token machine checks before the LLM gate.
		if (type === "gate" && Array.isArray(phase.eval) && phase.eval.length > 0) {
			const evalCtx = buildInterpolationContext(state, previousOutput, undefined, onRead);
			let allPassed = true;
			for (const check of phase.eval) {
				// Defensive: a non-string check (validation reports it) must not crash the
				// gate. Treat it as a failed check so the LLM gate runs (fail-safe).
				if (typeof check !== "string") {
					allPassed = false;
					break;
				}
				let expr = check;
				// Pre-process `contains` expressions: "{steps.x.output} contains PASS"
				// Convert to: interpolate LHS, check RHS substring inclusion.
				const containsIdx = expr.indexOf(" contains ");
				if (containsIdx > 0) {
					const lhs = expr.slice(0, containsIdx).trim();
					const rhs = expr.slice(containsIdx + " contains ".length).trim();
					const lhsVal = interpolate(lhs, evalCtx);
					// An unresolved LHS ref (e.g. a typo'd or not-yet-produced step) must NOT
					// silently auto-PASS the gate — that would skip a safety check. Treat a
					// missing ref as a failed eval so the LLM gate runs (fail-safe).
					if (lhsVal.missing.length > 0) {
						allPassed = false;
						break;
					}
					const lhsStr = lhsVal.text;
					if (!lhsStr.includes(rhs)) {
						allPassed = false;
						break;
					}
					continue;
				}
				// A parse error must NOT auto-PASS the safety gate (evaluateCondition
				// fails open with `true`). Treat an unparseable/false eval as a failed
				// check so the LLM gate runs (fail-safe).
				const { value: passed, error: evalErr } = tryEvaluateCondition(expr, evalCtx);
				if (evalErr || !passed) {
					allPassed = false;
					break;
				}
			}
			if (allPassed) {
				// All evals passed — skip the LLM gate, return an auto-pass.
				const inputHash = cacheKeys(cc, [phase.id, "eval-skip"]).key;
				const ps: PhaseState = {
					id: phase.id,
					status: "done",
					output: "PASS (eval checks passed — no LLM call)",
					gate: { verdict: "pass" },
					usage: emptyUsage(),
					inputHash,
					endedAt: Date.now(),
				};
				if (readRefs.length) ps.reads = readRefsToReads(readRefs, state);
				recordCache(cc, ps);
				return ps;
			}
		}

		// Scoring gate (`score`): deterministic scorers → zero-token auto-pass /
		// LLM judge / task fallback. Self-contained (including its own onBlock:retry
		// mirror) so the non-score gate path below stays byte-identical.
		const scoreRaw = type === "gate" ? (phase as { score?: unknown }).score : undefined;
		if (scoreRaw !== undefined) {
			const shapeErrs = scorerShapeErrors(scoreRaw);
			if (shapeErrs.length === 0) {
				const sc = scoreRaw as ScoreConfig;
				const combine = sc.combine ?? "all";
				const threshold = combine === "weighted" ? (sc.threshold ?? SCORE_DEFAULT_THRESHOLD) : undefined;
				const scoreId = JSON.stringify(scoreRaw);

				// One full score evaluation (deterministics → auto-pass | judge | task |
				// deterministic BLOCK). Re-invoked by the onBlock:retry loop, so it
				// rebuilds its interpolation context from the CURRENT state each call.
				const evaluateScore = async (): Promise<PhaseState> => {
					const freshPrev = lastCompletedOutput(state, phase);
					const freshCtx = buildInterpolationContext(state, freshPrev, undefined, onRead);
					const tInterp = interpolate(sc.target ?? "{previous.output}", freshCtx);
					const targetResolved = tInterp.missing.length === 0;
					const target = tInterp.text;

					// Deterministic scorers — pure ones inline, code-compiles via the
					// impure runtime module. Skipped entirely when the target ref did not
					// resolve (scoring a literal placeholder would be noise).
					const results: ScorerResult[] = [];
					if (targetResolved) {
						for (let i = 0; i < sc.scorers.length; i++) {
							const s = sc.scorers[i];
							results.push(
								s.type === "code-compiles"
									? await runCodeCompilesScorer(s, i, target)
									: evaluatePureScorer(s, i, target),
							);
						}
					}
					// Weighted + judge: the judge's weight enlarges the denominator so the
					// deterministic combination is a LOWER BOUND — clearing the threshold
					// without the judge means the judge could not change the outcome.
					const judgeWeight =
						combine === "weighted" && sc.judge ? (sc.weights?.[sc.scorers.length] ?? 1) : 0;
					const det = combineScores(results, combine, sc.weights, threshold ?? SCORE_DEFAULT_THRESHOLD, judgeWeight);

					// Auto-pass is only sound when the judge could not veto it:
					//  - no judge configured → the deterministics ARE the decision;
					//  - weighted + judge → det.passed used the judge-inflated denominator
					//    (lower bound), so the judge's score cannot drop it below threshold.
					// all/any WITH a judge must NOT auto-skip: there the judge's verdict is
					// authoritative (it may check what scorers cannot — e.g. factuality) and
					// skipping it would silently bypass a configured quality check.
					const judgeCannotVeto = !sc.judge || combine === "weighted";
					if (targetResolved && det.passed && judgeCannotVeto) {
						// AUTO-PASS — zero LLM tokens (mirrors the eval-skip fast-path).
						const inputHash = cacheKeys(cc, [phase.id, "score-skip", scoreId, target]).key;
						const scores = { results, combined: det.combined, threshold };
						const ps: PhaseState = {
							id: phase.id,
							status: "done",
							output: "PASS (scorers passed — no LLM call)",
							gate: { verdict: "pass", scores },
							json: scoreResultJSON(results, det.combined, "pass", threshold),
							usage: emptyUsage(),
							inputHash,
							endedAt: Date.now(),
						};
						if (readRefs.length) ps.reads = readRefsToReads(readRefs, state);
						traceGateDecision(deps, state, phase.id, ps.gate!, undefined);
						return ps;
					}

					const report = targetResolved
						? formatScorerReport(results, det.combined, threshold)
						: `## Deterministic scorer report\n(scorers skipped — score.target did not resolve: ${tInterp.missing.join(", ")})`;

					// Judge fallback — the LLM-as-judge decides, with the target and the
					// deterministic report in evidence. Fail-open on unparseable output.
					if (sc.judge) {
						const judgeAgent = resolveAgent(sc.judge.agent ?? phase.agent, deps, state);
						const judgeText = interpolate(sc.judge.task, freshCtx).text;
						// Neutralize fences in the (model-produced) target so it cannot
						// close the evidence block and inject instructions at prompt level.
						const safeTarget = target.replace(/```/g, "`\u200b``");
						const fullJudgeTask =
							`${preRead}${judgeText}\n\n---\n\n## Target under evaluation\n\`\`\`\n${safeTarget}\n\`\`\`\n\n${report}\n\n` +
							`Return JSON {"score": 0.0-1.0, "verdict": "pass"|"block", "reason": "..."} (or end with VERDICT: PASS|BLOCK).`;
						const ckJ = cacheKeys(cc, [phase.id, judgeAgent, phase.model ?? "", fullJudgeTask, scoreId]);
						const inputHash = ckJ.key;
						const cachedJ = cachedPhase(cc, ckJ);
						if (cachedJ) return cachedJ;
						const r = await runOne(judgeAgent, fullJudgeTask, liveSink(state, phase.id, emitProgress), nodeIdFor("judge"));
						const ps = resultToPhaseState(phase.id, r, inputHash, false);
						if (ps.status === "done") {
							const judged = parseJudgeOutput(r.output);
							// Weighted: the judge's score folds into the combination and the
							// threshold decides. all/any: the judge's verdict is authoritative.
							const final =
								combine === "weighted"
									? combineWithJudge(results, sc.weights, threshold ?? SCORE_DEFAULT_THRESHOLD, judged.score)
									: { combined: judged.score, passed: judged.verdict === "pass" };
							const verdict: "pass" | "block" = final.passed ? "pass" : "block";
							ps.gate = { verdict, reason: judged.reason, scores: { results, combined: final.combined, threshold } };
							ps.json = scoreResultJSON(results, final.combined, verdict, threshold, { score: judged.score, reason: judged.reason });
							traceGateDecision(deps, state, phase.id, ps.gate, r.output);
						}
						if (readRefs.length) ps.reads = readRefsToReads(readRefs, state);
						return ps;
					}

					// Task fallback — the gate's own LLM task runs with the scorer report
					// appended, verdict parsed as usual.
					if (phase.task) {
						const agentName = resolveAgent(phase.agent, deps, state);
						const text = interpolate(phase.task, freshCtx).text;
						const fullTask = appendGateFormatSuffix(`${preRead}${text}\n\n---\n\n${report}`, phase);
						const ckT = cacheKeys(cc, [phase.id, agentName, phase.model ?? "", fullTask, scoreId]);
						const inputHash = ckT.key;
						const cachedT = cachedPhase(cc, ckT);
						if (cachedT) return cachedT;
						const r = await runOne(agentName, fullTask, liveSink(state, phase.id, emitProgress), nodeIdFor(), contractCheck);
						const ps = resultToPhaseState(phase.id, r, inputHash, parseJson);
						if (ps.status === "done") {
							const v = parseGateVerdict(r.output);
							ps.gate = { ...v, scores: { results, combined: det.combined, threshold } };
							ps.json = scoreResultJSON(results, det.combined, v.verdict, threshold);
						}
						if (readRefs.length) ps.reads = readRefsToReads(readRefs, state);
						return ps;
					}

					// No LLM fallback configured.
					if (!targetResolved) {
						// Unresolved target with no judge/task is AMBIGUITY, not an explicit
						// failure — fail-open PASS with a warning (project invariant).
						const inputHash = cacheKeys(cc, [phase.id, "score-unresolved", scoreId]).key;
						return {
							id: phase.id,
							status: "done",
							output: "PASS (score.target did not resolve — fail-open)",
							gate: { verdict: "pass", reason: `score.target unresolved: ${tInterp.missing.join(", ")}` },
							json: scoreResultJSON([], 0, "pass", threshold),
							warnings: [`gate score.target did not resolve (${tInterp.missing.join(", ")}) — fail-open PASS`],
							usage: emptyUsage(),
							inputHash,
							endedAt: Date.now(),
						};
					}
					// Deterministic explicit failure is NOT ambiguity: BLOCK.
					const inputHash = cacheKeys(cc, [phase.id, "score-block", scoreId, target]).key;
					const scores = { results, combined: det.combined, threshold };
					const ps: PhaseState = {
						id: phase.id,
						status: "done",
						output: `BLOCK (deterministic scorers failed — no LLM fallback)\n\n${report}`,
						gate: { verdict: "block", reason: "deterministic scorers below threshold", scores },
						json: scoreResultJSON(results, det.combined, "block", threshold),
						usage: emptyUsage(),
						inputHash,
						endedAt: Date.now(),
					};
					if (readRefs.length) ps.reads = readRefsToReads(readRefs, state);
					return ps;
				};

				let ps = await evaluateScore();
				// onBlock:retry — mirrors the non-score gate loop below (re-run upstream
				// deps, then RE-SCORE), sharing its depth cap and budget/abort guards.
				if (ps.gate?.verdict === "block") {
					const onBlockV: string = phase.onBlock ?? "halt";
					const MAX_RETRY_DEPTH = 3;
					let attempt = 0;
					while (onBlockV === "retry" && attempt < (phase.retry?.max ?? 1)) {
						if (deps.signal?.aborted || overBudget(state).over) break;
						attempt++;
						if (_retryDepth < MAX_RETRY_DEPTH) {
							const depsForUpstream = opts?.upstreamDeps ?? deps;
							for (const depId of phase.dependsOn ?? []) {
								const d = state.def.phases.find((p) => p.id === depId);
								if (!d) continue;
								const dPs = await executePhase(d, state, depsForUpstream, prior, emitProgress, _retryDepth + 1, undefined);
								state.phases[depId] = dPs;
							}
						}
						const prevAttempts = ps.attempts ?? 0;
						ps = await evaluateScore();
						ps.attempts = prevAttempts + (ps.attempts ?? 0);
						if (ps.gate?.verdict !== "block" || overBudget(state).over) break;
					}
					if (attempt > 0) ps.attempts = Math.max(ps.attempts ?? 0, attempt);
				}
				recordCache(cc, ps);
				return ps;
			}
			// Malformed score (validation reports it) — fail-open: fall through to
			// the plain LLM gate with a warning so an authoring slip degrades to the
			// historical behavior instead of crashing the phase.
			const scoreWarning = `gate 'score' is malformed and was ignored: ${shapeErrs[0]}`;
			const interpM = interpolate(phase.task ?? "", ctx);
			const textM = interpM.text;
			const refWarningM = warnUnresolvedRefs(phase.id, interpM.missing);
			const fullTaskM = appendGateFormatSuffix(preRead + textM, phase);
			const agentNameM = resolveAgent(phase.agent, deps, state);
			const ckM = cacheKeys(cc, [phase.id, agentNameM, phase.model ?? "", fullTaskM]);
			const cachedM = cachedPhase(cc, ckM);
			if (cachedM) return cachedM;
			const rM = await runOne(agentNameM, fullTaskM, liveSink(state, phase.id, emitProgress), nodeIdFor(), contractCheck);
			const psM = resultToPhaseState(phase.id, rM, ckM.key, parseJson);
			if (readRefs.length) psM.reads = readRefsToReads(readRefs, state);
			psM.warnings = [...(psM.warnings ?? []), scoreWarning, ...(refWarningM ? [refWarningM] : [])];
			if (psM.status === "done") psM.gate = parseGateVerdict(rM.output);
			recordCache(cc, psM);
			return psM;
		}
		const interp = interpolate(phase.task ?? "", ctx);
		const text = interp.text;
		const refWarning = warnUnresolvedRefs(phase.id, interp.missing);
		const fullTask = appendGateFormatSuffix(preRead + text, phase);
		const agentName = resolveAgent(phase.agent, deps, state);
		const ck = cacheKeys(cc, [phase.id, agentName, phase.model ?? "", fullTask]);
		const inputHash = ck.key;
		const cached = cachedPhase(cc, ck);
		if (cached) return cached;

		const r = await runOne(agentName, fullTask, liveSink(state, phase.id, emitProgress), nodeIdFor(), contractCheck);
		const ps = resultToPhaseState(phase.id, r, inputHash, parseJson);
		if (readRefs.length) ps.reads = readRefsToReads(readRefs, state);
		if (refWarning) ps.warnings = [...(ps.warnings ?? []), refWarning];
		// Prompt-size diagnostics for the single agent call (durable).
		attachPromptStats(ps, [fullTask]);
		// reduce: record aggregate input stats.
		if (type === "reduce") attachReduceInputStats(ps, state, phase);
		if (type === "gate" && ps.status === "done") {
			ps.gate = parseGateVerdict(r.output);
			// Trace: gate decision (fail-open). Replay re-adjudicates thresholds.
			if (ps.gate) traceGateDecision(deps, state, phase.id, ps.gate);
		}

		// Shared Context Tree: register this node, mark its terminal status, and
		// pick up any ctx_spawn intents the subagent queued. The spawned child
		// tasks run here (supervision loop) and their reports are folded into this
		// phase's output so the parent — and downstream phases — can see them.
		if (ctxDir) {
			try {
				const nid = nodeIdFor();
				registerNode(ctxDir, nid, phase.id, undefined, ps.status === "failed" ? "failed" : "done");
				const spawned = drainPendingSpawns(ctxDir, nid);
				if (spawned.length > 0 && !deps.signal?.aborted && !overBudget(state).over) {
					const child = await runSpawnedChildren(
						spawned,
						ctxDir,
						nid,
						phase,
						deps,
						state,
						runSpawnedChild,
						{ usage: emptyUsage() },
					);
					if (child.reports) ps.output = `${ps.output ?? ""}${child.reports}`;
					if (child.failed && deps._workspaceBinding) {
						ps.status = "failed";
						ps.error = `Workspace ctx_spawn descendant failed: ${child.errors.join("; ")}`;
					}
					// Fold spawned spend into this phase's usage so the run-wide budget
					// guard accounts for it (verdict Issue 2).
					ps.usage = aggregateUsage([ps.usage ?? emptyUsage(), child.usage]);
				}
			} catch {
				/* fail-open: context-tree bookkeeping must never sink the phase */
			}
		}

		// onBlock:retry — re-execute upstream + gate until pass or max attempts.
		if (type === "gate" && ps.gate?.verdict === "block") {
			const onBlockV: string = phase.onBlock ?? "halt";
			const MAX_RETRY_DEPTH = 3;
			let attempt = 0;
			let gatePs = ps;
			while (onBlockV === "retry" && attempt < (phase.retry?.max ?? 1)) {
				// H1: guard against unbounded spend and user abort
				if (deps.signal?.aborted || overBudget(state).over) break;
				attempt++;
				// H2: cap nested retry depth to prevent exponential re-execution
				// when a gate's upstream dependency is itself a gate with onBlock:retry
				if (_retryDepth < MAX_RETRY_DEPTH) {
					// Re-executing upstream deps must NOT inherit this gate's isolated
					// workspace — each dep resolves its own cwd. Strip the override.
					// NOTE: we intentionally pass the gate's `prior` (not the dep's own
					// completed state) so the dep does NOT cache-hit and actually
					// RE-RUNS — re-running upstream is the whole point of onBlock:retry.
					const depsForUpstream = opts?.upstreamDeps ?? deps;
					for (const depId of phase.dependsOn ?? []) {
						const d = state.def.phases.find((p) => p.id === depId);
						if (!d) continue;
						const dPs = await executePhase(d, state, depsForUpstream, prior, emitProgress, _retryDepth + 1, undefined);
						state.phases[depId] = dPs;
					}
				}
				const retryCtx = buildInterpolationContext(state, lastCompletedOutput(state, phase));
				const retryText = interpolate(phase.task ?? "", retryCtx).text;
				const retryTask = appendGateFormatSuffix(preRead + retryText, phase);
				const retryIH = cacheKeys(cc, [phase.id, agentName, phase.model ?? "", retryTask]).key;
				const retryR = await runOne(agentName, retryTask, liveSink(state, phase.id, emitProgress), undefined, contractCheck);
				gatePs = resultToPhaseState(phase.id, retryR, retryIH, parseJson);
				if (gatePs.status === "done") gatePs.gate = parseGateVerdict(retryR.output);
				if (gatePs.gate?.verdict !== "block" || overBudget(state).over) break;
			}
			gatePs.attempts = (ps.attempts ?? 0) + attempt;
			recordCache(cc, gatePs);
			return gatePs;
		}
		recordCache(cc, ps);
		return ps;
	}

	// script — zero-token shell (spawn/timeout/size caps in runtime/phases/script.ts)
	if (type === "script") {
		const { runScriptCommand, scriptResultToPhaseState, scriptSpawnErrorToPhaseState } =
			await import("./runtime/phases/script.ts");
		const cmd = phase.run;
		if (!cmd) {
			return {
				id: phase.id,
				status: "failed",
				error: "script phase requires 'run'",
				endedAt: Date.now(),
				usage: emptyUsage(),
			};
		}
		// Array form: interpolate each element (safe — schema rejects placeholders in string form).
		// String form: skip interpolation — schema already guarantees no {placeholders}.
		const interpRun = Array.isArray(cmd)
			? cmd.map((s) => interpolate(s, ctx))
			: [{ text: cmd, missing: [] as string[] }];
		for (const r of interpRun) {
			if (r.missing.length) warnUnresolvedRefs(phase.id, r.missing);
		}
		const interpRunText = interpRun.map((r) => r.text);
		const stdinInterp = phase.input !== undefined ? interpolate(phase.input, ctx) : undefined;
		if (stdinInterp?.missing.length) warnUnresolvedRefs(phase.id, stdinInterp.missing);
		const stdinInput = stdinInterp?.text;

		const ck = cacheKeys(cc, [phase.id, JSON.stringify(interpRunText), stdinInput ?? ""]);
		const inputHash = ck.key;
		const cached = cachedPhase(cc, ck);
		if (cached) return cached;

		const SCRIPT_TIMEOUT_MS = phase.timeout ?? 60_000;
		const reads = readRefs.length ? readRefsToReads(readRefs, state) : undefined;
		try {
			const invoke = () => runScriptCommand({
				interpRunText,
				arrayForm: Array.isArray(cmd),
				cwd: effCwd,
				signal: deps.signal,
				stdinInput,
				timeoutMs: SCRIPT_TIMEOUT_MS,
			});
			const result = deps._workspaceBinding
				? await deps._workspaceBinding.runScript({ unitId: phase.id, signal: deps.signal, invoke })
				: await invoke();
			const ps = scriptResultToPhaseState(phase, result, {
				inputHash,
				timeoutMs: SCRIPT_TIMEOUT_MS,
				reads,
			});
			// Non-zero exit: cache (deterministic). Timeout/spawn: don't cache (transient).
			if (ps.status === "done" || (ps.status === "failed" && !ps.timedOut)) {
				recordCache(cc, ps);
			}
			return ps;
		} catch (err: unknown) {
			// Spawn errors intentionally NOT cached — re-execute on resume/retry.
			return scriptSpawnErrorToPhaseState(phase.id, err, { inputHash, reads });
		}
	}

	// parallel — all branches; merge via shared mergePhaseState (phases/parallel.ts)
	if (type === "parallel") {
		const { executeParallelBranches } = await import("./runtime/phases/parallel.ts");
		const branches = (phase.branches ?? []).map((b) => {
			const r = interpolate(b.task, ctx);
			return {
				agent: resolveAgent(b.agent ?? phase.agent, deps, state),
				task: preRead + r.text,
				cwd: typeof b.cwd === "string" ? resolveBranchCwd(deps, b.cwd) : undefined,
			};
		});
		const ck = cacheKeys(cc, [phase.id, phase.model ?? "", JSON.stringify(branches)]);
		const inputHash = ck.key;
		const cached = cachedPhase(cc, ck);
		if (cached) return cached;

		const ps = await executeParallelBranches(phase, branches, runFanout, mergePhaseState, {
			inputHash,
			parseJson,
			reads: readRefs.length ? readRefsToReads(readRefs, state) : undefined,
		});
		recordCache(cc, ps);
		return ps;
	}

	// Horizon B: race — implementation lives in runtime/phases/race.ts
	if (type === "race") {
		const { executeRaceBranches } = await import("./runtime/phases/race.ts");
		const branches = (phase.branches ?? []).map((b) => {
			const r = interpolate(b.task, ctx);
			return {
				agent: resolveAgent(b.agent ?? phase.agent, deps, state),
				task: preRead + r.text,
			};
		});
		const ck = cacheKeys(cc, [phase.id, "race", phase.model ?? "", JSON.stringify(branches)]);
		const inputHash = ck.key;
		const cached = cachedPhase(cc, ck);
		if (cached) return cached;
		const raceRunOne = (agent: string, task: string, branchSignal?: AbortSignal) =>
			runOne(agent, task, undefined, undefined, undefined, branchSignal);
		const ps = await executeRaceBranches(phase, branches, raceRunOne, isFailed, {
			inputHash,
			parseJson,
			readRefs: readRefs.length ? readRefsToReads(readRefs, state) : undefined,
			parentSignal: deps.signal,
		});
		recordCache(cc, ps);
		return ps;
	}

	if (type === "map") {
		const overResolved = interpolate(phase.over ?? "", ctx).text;
		// `over` may itself be a placeholder that resolved to a JSON string.
		let arr = coerceArray(safeParse(overResolved)) ?? coerceArray(directRef(phase.over ?? "", state));
		// Breadth cap for untrusted dynamic sub-flows: a `def:` frame in the stack
		// means we are inside a runtime-generated flow. Truncate giant fan-outs to
		// bound subprocess blast radius (fail-open: keep the first N rather than abort).
		let mapTruncated = false;
		if (arr && (deps._stack ?? []).some((s) => s.startsWith("def:")) && arr.length > MAX_DYNAMIC_MAP_ITEMS) {
			arr = arr.slice(0, MAX_DYNAMIC_MAP_ITEMS);
			mapTruncated = true;
		}
		if (!arr) {
			return {
				id: phase.id,
				status: "failed",
				error: `map phase '${phase.id}': 'over' (${phase.over}) did not resolve to an array`,
				inputHash: hashInput(phase.id, "no-array"),
				endedAt: Date.now(),
				usage: emptyUsage(),
			};
		}
		const loopVar = phase.as ?? "item";
		const tasks = arr.map((item) => {
			const localCtx = buildInterpolationContext(state, previousOutput, { [loopVar]: item }, onRead);
			return {
				agent: resolveAgent(phase.agent, deps, state),
				task: preRead + interpolate(phase.task ?? "", localCtx).text,
			};
		});
		// Per-item caching is sound ONLY when ALL of:
		//  - cross-run scope: run-only has no persistent store, so per-item entries
		//    could never be re-read (no point keying them).
		//  - no Shared Context Tree (`!sharing`): a sharing map item can read sibling
		//    blackboard writes OUTSIDE its declared deps, so the per-item key (which
		//    folds only the item's own task) under-approximates real reads and could
		//    serve a stale result. Fall back to whole-map.
		//  - not inside a runtime-generated sub-flow (`def:` frame in the stack):
		//    such flows are untrusted / possibly non-deterministic, so per-item reuse
		//    is unsafe. Fall back to whole-map (which still applies breadth caps).
		// `undefined phaseFingerprint` is NOT a blocker for soundness — it is a
		// DELIBERATE design choice: per-item keys omit BOTH phaseFp and flowDefHash
		// (via ccPerItem below) so a changing `over` cannot move unchanged items'
		// keys. See ccPerItem for the full soundness argument.
		const perItemCacheable =
			cc.scope === "cross-run" &&
			!sharing &&
			!(deps._stack ?? []).some((s) => s.startsWith("def:"));
		// Per-item cache context: structural fingerprints (phaseFp + flowDefHash)
		// are OMITTED so a changing `over` cannot move unchanged items' keys. Both
		// fingerprints hash `over` (the array source); folding either into a
		// per-item key means editing one item invalidates EVERY per-item key at
		// once (no partial reuse) — the bug fixed here. A single item's output is
		// fully specified by `it.task` (template + {item}/{as} value + any
		// upstream-output refs + args) + `it.agent` + model + thinking/tools/preRead
		// + the world-state `fingerprint`; `over` only determines WHICH items
		// exist, not WHAT any item computes. `flowName` is retained for cross-flow
		// collision prevention. Soundness: docs/internal/cache-migration.md.
		// NB: perItemCacheable already gates on scope === "cross-run", which is
		// blocked upstream when flowDefHash === "failed", so ccPerItem is only
		// built when flowDefHash is a real hash (or already undefined) — setting
		// it to undefined here is a safe no-op for the failed case.
		const ccPerItem: PhaseCacheCtx = { ...cc, phaseFp: undefined, flowDefHash: undefined };
		// Pre-compute per-item CacheKeys once so the lookup and the record path use
		// the IDENTICAL key (built from ccPerItem, NOT the whole-phase cc). The
		// per-item key folds `it.agent` (Arbiter fix): a different agent means
		// different output, so a per-item key WITHOUT the agent could serve a stale
		// cross-agent hit when only `phase.agent` changed (the whole-map key would
		// correctly miss via JSON.stringify(tasks), but per-item keys would not).
		const perItemKeys: (CacheKeys | null)[] = perItemCacheable
			? tasks.map((it) => cacheKeys(ccPerItem, [phase.id, it.agent, phase.model ?? "", it.task]))
			: tasks.map(() => null);
		const perItem = perItemCacheable
			? { keyOf: (idx: number): CacheKeys | null => perItemKeys[idx] ?? null, cc: ccPerItem }
			: undefined;
		// Whole-map key keeps the FULL cc (phaseFp + flowDefHash) so its fast path
		// and any pre-existing whole-map entries are unchanged (backward compat).
		const ck = cacheKeys(cc, [phase.id, phase.model ?? "", JSON.stringify(tasks)]);
		const inputHash = ck.key;
		const cached = cachedPhase(cc, ck);
		if (cached) return cached;

		const results = await runFanout(tasks, perItem);
		const ps = mergePhaseState(phase.id, results, inputHash, parseJson);
		if (readRefs.length) ps.reads = readRefsToReads(readRefs, state);
		if (mapTruncated) {
			ps.warnings = [...(ps.warnings ?? []), `map fan-out truncated to MAX_DYNAMIC_MAP_ITEMS (${MAX_DYNAMIC_MAP_ITEMS}) inside a dynamic sub-flow`];
			// NB: do NOT set ps.budgetTruncated — that field drives the run-level
			// budget-blocked path and would mislabel the run as "budget exceeded".
			// This is a safety fan-out cap, not a cost overrun; a warning is enough.
		}
		recordCache(cc, ps);
		return ps;
	}

	// approval — HITL pause (decision → PhaseState in runtime/phases/approval.ts)
	if (type === "approval") {
		const { approvalDecisionToPhaseState } = await import("./runtime/phases/approval.ts");
		const readRefs: string[] = [];
		const ctx = buildInterpolationContext(state, previousOutput, undefined, (ref) => readRefs.push(ref));
		const message = interpolate(phase.task ?? "Approve to continue?", ctx).text;
		const ck = cacheKeys(cc, [phase.id, phase.model ?? "", "approval", message]);
		const inputHash = ck.key;
		const cached = cachedPhase(cc, ck);
		if (cached) return cached;

		const reads = readRefsToReads(readRefs, state);
		// Non-interactive (headless/CI/detached): auto-REJECT — safety boundary, never bypass.
		if (!deps.requestApproval) {
			return approvalDecisionToPhaseState(phase.id, { decision: "reject" }, {
				inputHash,
				reads,
				auto: true,
			});
		}
		const decision = await deps.requestApproval({
			phaseId: phase.id,
			message,
			upstream: previousOutput,
		});
		return approvalDecisionToPhaseState(phase.id, decision, { inputHash, reads });
	}

	if (type === "flow" || type === "expand") {
		const readRefs: string[] = [];
		const ctx = buildInterpolationContext(state, previousOutput, undefined, (ref) => readRefs.push(ref));
		// expand always requires `def`; flow may use `use` or `def`.
		const hasDef =
			type === "expand" ? (phase as { def?: unknown }).def !== undefined : (phase as { def?: unknown }).def !== undefined;
		const stack = deps._stack ?? [];
		const { resolveExpandMode, resolveMaxNodes, prefixGraftFragment, promoteGraftPhases } =
			await import("./runtime/phases/expand.ts");
		const expandMode = type === "expand" ? resolveExpandMode(phase) : "nested";
		const maxNodes = type === "expand" ? resolveMaxNodes(phase, MAX_DYNAMIC_PHASES) : 50;
		if (type === "expand" && expandMode === "graft") {
			// Rerun replacement semantics: prior promoted children belong to the old
			// fragment and must disappear before ANY new resolution path. This is
			// intentionally before parse/validation/empty/sub-flow failure returns so
			// stale children and their usage cannot survive a failed or empty v2 plan.
			const declaredIds = new Set(state.def.phases.map((p) => p.id));
			for (const oldId of Object.keys(prior?.promotedPhases ?? {})) {
				// Definition evolution may promote an old dynamic id into a real
				// authored parent phase. That declared phase owns its state now and must
				// never be deleted by stale graft metadata.
				if (!declaredIds.has(oldId)) delete state.phases[oldId];
			}
		}

		let subDef: Taskflow | undefined;
		let name: string;
		let recursionKey: string; // identity used for cache key + recursion guard

		if (type === "expand" && !hasDef) {
			return failPhase(phase.id, `expand phase '${phase.id}' requires 'def'`);
		}

		if (hasDef) {
			// --- Inline `def`: resolve at runtime, validate, fail-OPEN on any error. ---
			// Fail-open contract: a bad def NEVER aborts the run. The phase resolves
			// as `done` with empty output and a `defError` diagnostic, and the
			// upstream output is preserved for downstream phases. (Authors who want
			// a bad plan to be a hard failure can add their own gate downstream.)
			const defFailOpen = (diag: string): PhaseState => ({
				id: phase.id,
				status: "done",
				output: "",
				json: parseJson ? safeParse("") : undefined,
				usage: emptyUsage(),
				inputHash: hashInput(phase.id, `flow-def-error:${diag}`),
				reads: readRefsToReads(readRefs, state),
				endedAt: Date.now(),
				defError: diag,
			});
			// Nesting guard: each `flow{def}` adds a frame to _stack; cap inline depth.
			const inlineDepth = stack.filter((s) => s.startsWith("def:")).length;
			if (inlineDepth >= MAX_DYNAMIC_NESTING) {
				return defFailOpen(`inline sub-flow nesting exceeded MAX_DYNAMIC_NESTING (${MAX_DYNAMIC_NESTING}): depth ${inlineDepth}`);
			}
			const rawDef = (phase as { def?: unknown }).def;
			// String defs are interpolated then JSON-parsed; objects are used directly.
			let parsed: unknown;
			if (typeof rawDef === "string") {
				const resolved = interpolate(rawDef, ctx).text;
				parsed = safeParse(resolved);
				if (parsed === undefined) {
					return defFailOpen("inline def string did not parse as JSON");
				}
			} else {
				parsed = rawDef;
			}
			// Accept a full Taskflow, a bare phases array, or {phases:[...]}; wrap the latter two.
			let wrapped = normalizeInlineDef(parsed, phase.id);
			if (!wrapped) {
				return defFailOpen("inline def is not a Taskflow, phases array, or {phases:[...]}");
			}
			// Empty plan is a valid no-op (a planner deciding there is nothing to do):
			// succeed with empty output instead of failing validation on zero phases.
			if (wrapped.phases.length === 0) {
				return {
					id: phase.id,
					status: "done",
					output: "",
					json: parseJson ? safeParse("") : undefined,
					usage: emptyUsage(),
					inputHash: hashInput(phase.id, type === "expand" ? "expand-def-empty" : "flow-def-empty"),
					reads: readRefsToReads(readRefs, state),
					endedAt: Date.now(),
				};
			}
			// expand: cap fragment size + prefix ids for graft (helpers in phases/expand.ts).
			if (type === "expand") {
				if (wrapped.phases.length > maxNodes) {
					return defFailOpen(
						`expand fragment has ${wrapped.phases.length} phases (maxNodes=${maxNodes})`,
					);
				}
				if (expandMode === "graft") {
					wrapped = prefixGraftFragment(wrapped, phase.id);
				}
			}
			// Validate with `dynamic` hardening (breadth caps + cwd containment) since
			// this content is LLM-authored / untrusted. cwd anchors containment checks.
			const dynCwd = effCwd;
			const v = validateTaskflow(wrapped, { dynamic: true, cwd: dynCwd });
			if (!v.ok) {
				return defFailOpen(`inline def failed validation: ${v.errors.join("; ")}`);
			}
			// Static verification (dead-ends, unreachable, gate-exhaustion, budget,
			// concurrency). Only error-severity issues block; warnings are advisory.
			const ver = verifyTaskflow({ name: wrapped.name, phases: wrapped.phases as Phase[], budget: wrapped.budget, concurrency: wrapped.concurrency }, { verifiers: deps.verifiers });
			if (!ver.ok) {
				const errs = ver.issues.filter((i) => i.severity === "error").map((i) => i.message);
				return defFailOpen(`inline def failed verification: ${errs.join("; ")}`);
			}
			// Budget containment: a generated def may not raise the parent's cap. Clamp
			// each dimension to min(child, parent) so it can only ever be tighter.
			subDef = clampSubFlowBudget(wrapped, state.def.budget);
			name = subDef.name;
			recursionKey = `def:${name}`;
		} else {
			// --- Saved flow via `use` (unchanged behavior). ---
			const useName = phase.use;
			if (!useName) return failPhase(phase.id, `flow phase '${phase.id}' requires 'use' or 'def'`);
			if (!deps.loadFlow) return failPhase(phase.id, `flow phase '${phase.id}': no sub-flow loader available`);
			subDef = deps.loadFlow(useName);
			if (!subDef) return failPhase(phase.id, `flow phase '${phase.id}': saved flow not found: '${useName}'`);
			name = useName;
			recursionKey = useName;
		}

		if (recursionKey === state.flowName || stack.includes(recursionKey)) {
			return failPhase(phase.id, `flow phase '${phase.id}': recursive sub-flow ${[...stack, state.flowName, recursionKey].join(" -> ")}`);
		}
		// Resolve sub-flow args (interpolate string values), then apply declared defaults.
		const provided: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(phase.with ?? {})) {
			provided[k] = interpolateValue(v, ctx);
		}
		const subArgs = resolveArgs(subDef, provided);
		if (deps._dynamic === true) {
			const dynamicChild = validateTaskflow(subDef, { dynamic: true, cwd: effCwd, args: subArgs });
			if (!dynamicChild.ok) {
				return failPhase(phase.id, `dynamic nested flow '${subDef.name}' is invalid: ${dynamicChild.errors.join("; ")}`);
			}
		}
		// Re-check the exact loaded definition at the cache boundary. A loader may
		// change between the root pre-scan and this phase (or return aliases), and
		// a bridge-bearing child must never be skipped by a cached parent result.
		const nestedBridgeTree = flowTreeUsesCwdBridge(subDef, deps.loadFlow);
		if (nestedBridgeTree) deps._disableCache = true;
		const flowCc: PhaseCacheCtx = nestedBridgeTree ? { ...cc, scope: "off" } : cc;
		// Every sub-flow cache identity includes the resolved definition. A saved
		// flow's name alone is insufficient: its contents can change without the
		// parent definition moving.
		const flowIdentity = `${hasDef ? "def" : "flow"}:${name}:${JSON.stringify(subDef)}`;
		const ck = cacheKeys(flowCc, [phase.id, flowIdentity, preRead, JSON.stringify(subArgs)]);
		const inputHash = ck.key;
		const cached = cachedPhase(flowCc, ck);
		if (cached) {
			if (type === "expand" && expandMode === "graft" && cached.promotedPhases) {
				const promo = promoteGraftPhases(state, cached.promotedPhases);
				if (promo.promotedIds.length > 0) {
					cached.promotedPhases = Object.fromEntries(
						promo.promotedIds.map((id) => [id, { ...cached.promotedPhases![id] }]),
					);
				} else {
					delete cached.promotedPhases;
				}
			}
			return cached;
		}

		const live = state.phases[phase.id];
			// A nested flow receives only the parent's remaining allowance, then its
			// own cap (if any) may tighten each dimension independently.
			const parentSpent = aggregateUsage(Object.values(state.phases).map((p) => p.usage ?? emptyUsage()));
			const subDefEffective = clampSubFlowBudget(subDef, state.def.budget, parentSpent);
		const subState: RunState = {
			runId: newRunId(subDef.name),
			flowName: subDef.name,
			def: subDefEffective,
			args: subArgs,
			status: "running",
			phases: {},
			createdAt: Date.now(),
			updatedAt: Date.now(),
			cwd: effCwd,
		};
		// B8: pass this flow phase's preRead content to every sub-flow phase by
		// wrapping runTask — sub-phase preRead still gets prepended on top of it.
		const baseRunTask = deps.runTask ?? noRunnerInjected;
		const subRunTask: RunTaskFn = (cwd, agents, agentName, subTask, opts, globalThinking) =>
			baseRunTask(cwd, agents, agentName, preRead + subTask, opts, globalThinking);
		const subResult = await executeTaskflow(subState, {
			...deps,
			// A trace file is scoped to one runId. The parent flow phase carries an
			// unreplayable marker; nested events must not be mixed into that file.
			trace: undefined,
			// Override deps.cwd with the flow phase's own cwd so that sub-flow
			// phases without an explicit cwd derive their subagents from the
			// flow's cwd (not the caller's cwd).
			cwd: effCwd,
			_cacheCwdIdentity: phase.cwd !== undefined || deps._cacheCwdIdentity !== undefined ? effCwd : undefined,
			_dynamic: hasDef || deps._dynamic === true ? true : undefined,
			// The workspace override applies only to THIS flow phase, not to the
			// nested sub-phases (each resolves its own cwd). Clear it so the child
			// phases don't all inherit this phase's isolated dir as an override.
			_cwdOverride: undefined,
			runTask: subRunTask,
			_stack: hasDef ? [...stack, state.flowName, recursionKey] : [...stack, state.flowName],
			_ctxDir: ctxDir ?? deps._ctxDir,
			persist: undefined,
			onProgress: () => {
				if (live) {
					const ph = Object.values(subState.phases);
					// B-F015: `done` must include both success and failure so the
					// renderer's `done - failed` shows the true success count.
					live.subProgress = {
						done: ph.filter((p) => p.status === "done" || p.status === "failed").length,
						total: subDef.phases.length,
						running: ph.filter((p) => p.status === "running").length,
						failed: ph.filter((p) => p.status === "failed").length,
					};
					const cur = ph.find((p) => p.status === "running");
					if (cur) live.liveText = `↳ ${cur.id}${cur.liveText ? `: ${cur.liveText}` : ""}`;
					live.usage = aggregateUsage(ph.map((p) => p.usage ?? emptyUsage()));
				}
				emitProgress();
			},
		});
		const sp = Object.values(subState.phases);
		const nestedFailure = sp.find((nested) => nested.status === "failed")?.error;
		// expand graft promote — pure helper (see runtime/phases/expand.ts)
		const warnings: string[] = [];
		let graftPromotedIds: string[] = [];
		if (type === "expand" && expandMode === "graft" && subResult.ok) {
			const promo = promoteGraftPhases(state, subState.phases);
			warnings.push(...promo.warnings);
			graftPromotedIds = promo.promotedIds;
		}
		// Graft accounting is ownership-based. Successfully promoted children carry
		// their own usage in parent state; children skipped on id collision remain
		// owned by the expand phase and their residual usage must stay here. This
		// yields: all promoted => 0, all collision => all child usage, mixed => only
		// collision residual (no loss and no double count).
		const phaseUsage =
			type === "expand" && expandMode === "graft" && subResult.ok
				? aggregateUsage(
						Object.entries(subState.phases)
							.filter(([id]) => !graftPromotedIds.includes(id))
							.map(([, ps]) => ps.usage ?? emptyUsage()),
					)
				: subResult.totalUsage;
		const flowPs: PhaseState = {
			id: phase.id,
			status: subResult.ok ? "done" : "failed",
			output: subResult.finalOutput,
			json: parseJson ? safeParse(subResult.finalOutput) : undefined,
			usage: phaseUsage,
			// B-F015: include failed in `done` so the renderer's
			// `done - failed` formula gives the success count (matches the
			// map/parallel runner's overlapping-counter convention).
			subProgress: {
				done: sp.filter((p) => p.status === "done" || p.status === "failed").length,
				total: subDef.phases.length,
				running: 0,
				failed: sp.filter((p) => p.status === "failed").length,
			},
			error: subResult.ok
				? undefined
				: `sub-flow '${name}' ${subResult.state.status}${nestedFailure ? `: ${nestedFailure}` : ""}`,
			inputHash,
			reads: readRefsToReads(readRefs, state),
			endedAt: Date.now(),
			...(warnings.length ? { warnings } : {}),
			...(type === "expand" && expandMode === "graft" && subResult.ok && graftPromotedIds.length > 0
				? { promotedPhases: Object.fromEntries(graftPromotedIds.map((id) => [id, { ...subState.phases[id] }])) }
				: {}),
		};
		recordCache(flowCc, flowPs);
		return flowPs;
	}

	// loop-until-done: run the body repeatedly until `until` is truthy, the output
	// converges to a fixed point, or maxIterations is hit (always terminates).
	if (type === "loop") {
		const readRefs: string[] = [];
		const agentName = resolveAgent(phase.agent, deps, state);
		const rawMax = phase.maxIterations ?? LOOP_DEFAULT_MAX_ITERATIONS;
		const maxIters = Math.max(1, Math.min(LOOP_HARD_MAX_ITERATIONS, Math.floor(rawMax)));
		const convergence = phase.convergence ?? true;
		const reflexionOn = phase.reflexion === true;

		// Canonical first-iteration body for the cache key. It must fold in the
		// interpolated task/upstream refs so that a changed upstream changes the
		// key and recompute no longer silently reuses a stale loop (critic finding).
		// Reflexion loops resolve {reflexion} to the SENTINEL here so the key
		// reflects the true first prompt (not a literal placeholder).
		const firstBodyCtx = buildInterpolationContext(state, previousOutput, {
			loop: { iteration: 1, lastOutput: "", maxIterations: maxIters },
		}, (ref) => readRefs.push(ref), reflexionOn ? REFLEXION_SENTINEL : undefined);
		const firstBody = preRead + interpolate(phase.task ?? "", firstBodyCtx).text;
		const inputHash = hashInput(phase.id, "loop", phase.until ?? "", firstBody, String(maxIters), reflexionOn ? "reflexion" : "");

		const usages: UsageStats[] = [];
		const loopWarnings: string[] = [];
		let lastOutput = "";
		let prevOutput: string | undefined;
		let iterations = 0;
		let stop: NonNullable<PhaseState["loop"]>["stop"] = "maxIterations";
		let failedResult: RunResult | undefined;
		// Bounded history of failed iterations (issue #17): when a reflexion loop
		// continues past failures, only the terminal one survives in `error` — keep
		// the rest for post-hoc debugging. Capped to avoid unbounded state growth.
		const LOOP_FAILURE_HISTORY_CAP = 20;
		const loopFailures: Array<{ iteration: number; error: string }> = [];
		const recordLoopFailure = (iteration: number, r: RunResult): void => {
			const err = isContractViolation(r.errorMessage)
				? r.errorMessage!
				: sanitizeErrorMessage(r.errorMessage || r.stderr || "") || `iteration ${iteration} failed`;
			loopFailures.push({ iteration, error: err });
			if (loopFailures.length > LOOP_FAILURE_HISTORY_CAP) loopFailures.shift();
		};
		// Reflexion state: what the NEXT iteration should be told about THIS one.
		let reflexionNext: ReflexionInput | undefined;
		let lastReflexion: string | undefined;
		let reflexionAppendWarned = false;
		// With reflexion on, a failed iteration continues (as feedback) instead of
		// terminating — track whether the LAST iteration failed so an exhausted
		// loop still fails (reflexion defers failure, it does not erase it).
		let lastIterationFailed = false;

		for (let i = 1; i <= maxIters; i++) {
			if (deps.signal?.aborted) {
				stop = "aborted";
				break;
			}
			iterations = i;
			// Assemble the reflexion summary for this iteration (fail-open: a
			// reflexion assembly bug must never sink the phase).
			let reflexionStr: string | undefined;
			if (reflexionOn) {
				if (i === 1 || !reflexionNext) {
					reflexionStr = REFLEXION_SENTINEL;
				} else {
					try {
						reflexionStr = buildReflexionSummary(reflexionNext);
					} catch (e) {
						reflexionStr = REFLEXION_SENTINEL;
						loopWarnings.push(`reflexion summary failed to assemble (iteration ${i}): ${e instanceof Error ? e.message : String(e)}`);
					}
					lastReflexion = reflexionStr;
				}
			}
			// The body sees its iteration number and the prior iteration's output.
			const bodyCtx = buildInterpolationContext(state, previousOutput, {
				loop: { iteration: i, lastOutput, maxIterations: maxIters },
			}, (ref) => readRefs.push(ref), reflexionStr);
			let body = preRead + interpolate(phase.task ?? "", bodyCtx).text;
			// Auto-append: reflexion is on but the task never mentions {reflexion} —
			// inject the summary anyway (opt-in via the flag IS the author's intent)
			// and tell them once how to control placement.
			if (reflexionOn && reflexionStr && reflexionStr !== REFLEXION_SENTINEL && !(phase.task ?? "").includes("{reflexion}")) {
				body = `${body}\n\n---\n\n${reflexionStr}`;
				if (!reflexionAppendWarned) {
					reflexionAppendWarned = true;
					loopWarnings.push("reflexion: true but the task has no {reflexion} placeholder — the summary was auto-appended; add {reflexion} to control placement");
				}
			}
			const r = await runOne(agentName, body, liveSink(state, phase.id, emitProgress), undefined, contractCheck);
			usages.push(r.usage);
			// Fold cumulative loop spend into the live phase state so the run-level
			// budget guard (overBudget reads state.phases[*].usage) sees the loop's
			// accrual mid-phase — otherwise each iteration would overwrite the last
			// and a reflexion loop could spend past the ceiling unnoticed.
			const livePs = state.phases[phase.id];
			if (livePs) livePs.usage = aggregateUsage(usages);
			if (isFailed(r)) {
				// Reflexion mode: a body failure becomes feedback for the next
				// iteration instead of terminating the loop. Timeout, abort, and an
				// exhausted budget still hard-stop (consistent with "timedOut is never
				// retried"; continuing past the budget would spend past the ceiling).
				const hardStop = !reflexionOn || r.phaseTimeout === true || deps.signal?.aborted === true || overBudget(state).over;
				if (hardStop) {
					failedResult = r;
					stop = "failed";
					recordLoopFailure(i, r);
					break;
				}
				failedResult = r;
				lastIterationFailed = true;
				recordLoopFailure(i, r);
				// Sanitize before injecting into the next prompt: raw provider errors
				// can carry HTML/transport noise (same policy as the transcript path).
				const rawErr = r.errorMessage || r.stderr || undefined;
				reflexionNext = {
					iteration: i,
					outcome: isContractViolation(r.errorMessage) ? "contract-violation" : "subagent-error",
					output: r.output,
					errorMessage: isContractViolation(r.errorMessage) ? r.errorMessage : rawErr ? sanitizeErrorMessage(rawErr) : undefined,
				};
				continue;
			}
			lastIterationFailed = false;
			failedResult = undefined;
			prevOutput = lastOutput;
			lastOutput = r.output;

			// Expose this iteration's output as {steps.<thisId>.output|json} so the
			// `until` condition can inspect it (e.g. "{steps.refine.json.done}==true").
			// Loop locals ({loop.iteration} etc.) are available to the condition too.
			const untilCtx = buildInterpolationContext(state, previousOutput, {
				loop: { iteration: i, lastOutput, maxIterations: maxIters },
			}, (ref) => readRefs.push(ref));
			untilCtx.steps[phase.id] = { output: lastOutput, json: safeParse(lastOutput) };
			const { value: done, error: condErr } = tryEvaluateCondition(phase.until ?? "", untilCtx);
			// A malformed condition must not spin forever: stop and surface a warning
			// so the author learns the `until` never actually evaluated.
			if (condErr) {
				loopWarnings.push(`loop 'until' could not be evaluated (stopped early): ${condErr}`);
				stop = "until";
				break;
			}
			if (done) {
				stop = "until";
				break;
			}
			// Fixed-point convergence: identical consecutive output ⇒ further work is wasted.
			if (convergence && prevOutput !== undefined && prevOutput === lastOutput) {
				stop = "converged";
				break;
			}
			// Succeeded but not done — the next iteration reflects on the unmet
			// stop condition (until-not-met is a signal too, not just failures).
			if (reflexionOn) {
				reflexionNext = { iteration: i, outcome: "until-not-met", output: lastOutput, until: phase.until };
			}
		}

		const aggUsage = usages.length ? aggregateUsage(usages) : emptyUsage();
		// Reflexion: an exhausted loop whose LAST iteration failed is a failure —
		// reflexion defers termination for feedback, it does not convert a failing
		// loop into a success.
		if (reflexionOn && stop === "maxIterations" && lastIterationFailed) {
			stop = "failed";
		}
		if (stop === "failed" || stop === "aborted") {
			return {
				id: phase.id,
				status: "failed",
				output: lastOutput || undefined,
				usage: aggUsage,
				timedOut: failedResult?.phaseTimeout || undefined,
				error: failedResult?.errorMessage || failedResult?.stderr || (stop === "aborted" ? "Aborted" : `loop '${phase.id}' iteration ${iterations} failed`),
				loop: { iterations, stop, ...(lastReflexion ? { reflexion: lastReflexion } : {}), ...(loopFailures.length ? { failures: [...loopFailures] } : {}) },
				warnings: loopWarnings.length ? loopWarnings : undefined,
				inputHash,
				reads: readRefsToReads(readRefs, state),
				endedAt: Date.now(),
			};
		}
		return {
			id: phase.id,
			status: "done",
			output: lastOutput,
			json: parseJson ? safeParse(lastOutput) : undefined,
			usage: aggUsage,
			loop: { iterations, stop, ...(lastReflexion ? { reflexion: lastReflexion } : {}), ...(loopFailures.length ? { failures: [...loopFailures] } : {}) },
			warnings: loopWarnings.length ? loopWarnings : undefined,
			inputHash,
			reads: readRefsToReads(readRefs, state),
			endedAt: Date.now(),
		};
	}

	// tournament: spawn N competing variants, then a judge picks the best (or
	// synthesizes an aggregate). Combines the parallel fan-out with a gate-style
	// verdict, expressed as a single declarative phase.
	if (type === "tournament") {
		const mode = (phase.mode ?? "best") as TournamentMode;
		// Competitors: explicit `branches` win; otherwise N copies of `task`.
		let competitors: Array<{ agent: string; task: string }>;
		if (phase.branches && phase.branches.length > 0) {
			competitors = phase.branches.map((b) => ({
				agent: resolveAgent(b.agent ?? phase.agent, deps, state),
				task: preRead + interpolate(b.task, ctx).text,
			}));
		} else {
			const n = Math.max(2, Math.min(TOURNAMENT_HARD_MAX_VARIANTS, Math.floor(phase.variants ?? TOURNAMENT_DEFAULT_VARIANTS)));
			const body = preRead + interpolate(phase.task ?? "", ctx).text;
			competitors = Array.from({ length: n }, () => ({ agent: resolveAgent(phase.agent, deps, state), task: body }));
		}

		// The inputHash must fold in the resolved competitors (which embed the
		// interpolated task/upstream refs) and the judge rubric, otherwise a changed
		// upstream produces the same key and recompute silently reuses a stale
		// tournament (critic finding: unsound for cross-run/recompute).
		const rubric = interpolate(phase.judge ?? "", ctx).text.trim();
		const inputHash = hashInput(
			phase.id,
			"tournament",
			mode,
			String(competitors.length),
			JSON.stringify(competitors.map((c) => ({ agent: c.agent, task: c.task }))),
			rubric,
		);

		const results = await runFanout(competitors);
		const ran = results.filter((r) => r.stopReason !== "budget-skipped");
		const ok = ran.filter((r) => !isFailed(r));
		const variantUsage = aggregateUsage(results.map((r) => r.usage));
		// Winner numbers are 1-based over `ran` (exactly what the judge is shown).
		// Using indexOf on the stable `ran` array is reference-based and correct even
		// when two variants produce byte-identical output.
		const ranIdx = (r: RunResult) => ran.indexOf(r) + 1;
		const budgetSkipCount = results.filter((r) => r.stopReason === "budget-skipped").length;

		// All competitors failed → the tournament fails (nothing to judge).
		if (ok.length === 0) {
			return {
				id: phase.id,
				status: "failed",
				usage: variantUsage,
				error: `tournament '${phase.id}': all ${competitors.length} variants failed`,
				timedOut: ran.some((r) => r.phaseTimeout) || undefined,
				budgetTruncated: budgetSkipCount > 0 || undefined,
				tournament: { variants: competitors.length, winner: 0, mode },
				inputHash,
				reads: readRefsToReads(readRefs, state),
				endedAt: Date.now(),
			};
		}
		// Only one competitor survived → no contest; it wins by default (skip judge).
		if (ok.length === 1) {
			const w = ranIdx(ok[0]);
			traceDecision(deps, state, phase.id, {
				type: "tournament-winner",
				value: w,
				reason: "only surviving variant",
			});
			return {
				id: phase.id,
				status: "done",
				output: ok[0].output,
				json: parseJson ? safeParse(ok[0].output) : undefined,
				usage: variantUsage,
				model: ok[0].model,
				budgetTruncated: budgetSkipCount > 0 || undefined,
				tournament: { variants: competitors.length, winner: w, mode, reason: "only surviving variant" },
				inputHash,
				reads: readRefsToReads(readRefs, state),
				endedAt: Date.now(),
			};
		}

		// Guard: skip the judge if the run is over budget or aborted.
		if (deps.signal?.aborted || overBudget(state).over) {
			return {
				id: phase.id,
				status: "done",
				output: ok[0].output,
				json: parseJson ? safeParse(ok[0].output) : undefined,
				usage: variantUsage,
				model: ok[0].model,
				budgetTruncated: budgetSkipCount > 0 || undefined,
				warnings: ["judge skipped: run aborted or budget exceeded"],
				tournament: { variants: competitors.length, winner: ranIdx(ok[0]), mode, reason: "judge skipped" },
				inputHash,
				reads: readRefsToReads(readRefs, state),
				endedAt: Date.now(),
			};
		}

		// Build the judge prompt: label every variant output, then the rubric.
		const labelled = ran
			.map((r, i) => `### Variant ${i + 1}${isFailed(r) ? " (failed — ineligible)" : ""}\n\n${r.output}`)
			.join("\n\n---\n\n");
		const finalRubric =
			rubric ||
			"You are judging competing answers to the same task. Pick the single best variant on correctness, completeness, and clarity.";
		const directive =
			mode === "best"
				? `End your reply with a line exactly: WINNER: <number> (1–${ran.length}), choosing the strongest eligible variant.`
				: `Synthesize the strongest possible answer by combining the best parts of the eligible variants. Then end with a line: WINNER: <number> indicating which variant contributed most.`;
		const judgeTask = `${finalRubric}\n\nThe candidate variants:\n\n${labelled}\n\n${directive}`;
		const judgeAgent = resolveAgent(phase.judgeAgent ?? phase.agent, deps, state);
		const judgeRes = await runOne(judgeAgent, judgeTask, liveSink(state, phase.id, emitProgress));
		const judgeUsage = aggregateUsage([variantUsage, judgeRes.usage]);

		if (isFailed(judgeRes)) {
			// Judge failed: fall back to the first eligible variant (fail-open, never
			// lose the work). Report the variant we actually used, not a hardcoded 1.
			return {
				id: phase.id,
				status: "done",
				output: ok[0].output,
				json: parseJson ? safeParse(ok[0].output) : undefined,
				usage: judgeUsage,
				model: ok[0].model,
				budgetTruncated: budgetSkipCount > 0 || undefined,
				warnings: [`judge failed (${judgeRes.errorMessage ?? "error"}); used variant ${ranIdx(ok[0])}`],
				tournament: { variants: competitors.length, winner: ranIdx(ok[0]), mode, reason: "judge failed" },
				inputHash,
				reads: readRefsToReads(readRefs, state),
				endedAt: Date.now(),
			};
		}

		const { winner, reason } = parseTournamentWinner(judgeRes.output, ran.length);
		const winnerResult = ran[winner - 1];
		const winnerIneligible = !winnerResult || isFailed(winnerResult);
		// In 'best' mode the output is the winning variant verbatim; in 'aggregate'
		// mode it is the judge's synthesized answer.
		const chosen = winnerIneligible ? ok[0] : winnerResult;
		const winnerIdx = ranIdx(chosen);
		const output = mode === "aggregate" ? judgeRes.output : chosen.output;
		traceDecision(deps, state, phase.id, {
			type: "tournament-winner",
			value: winnerIdx,
			reason,
		});
		return {
			id: phase.id,
			status: "done",
			output,
			json: parseJson ? safeParse(output) : undefined,
			usage: judgeUsage,
			model: mode === "aggregate" ? judgeRes.model : chosen.model,
			budgetTruncated: budgetSkipCount > 0 || undefined,
			warnings: winnerIneligible ? [`judge picked an ineligible variant; used variant ${winnerIdx}`] : undefined,
			tournament: { variants: competitors.length, winner: winnerIdx, mode, reason },
			inputHash,
			reads: readRefsToReads(readRefs, state),
			endedAt: Date.now(),
		};
	}

	return {
		id: phase.id,
		status: "failed",
		error: `Unknown phase type: ${type}`,
		endedAt: Date.now(),
		usage: emptyUsage(),
	};
}

/** Resolve a `{steps.x.json}`-style ref directly to its parsed value (bypassing stringify). */
function directRef(over: unknown, state: RunState): unknown {
	if (typeof over !== "string") return undefined;
	const m = over.match(/^\{steps\.([a-zA-Z0-9_-]+)\.(output|json)(?:\.([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*))?\}$/);
	if (!m) return undefined;
	const step = state.phases[m[1]];
	if (!step || step.status !== "done") return undefined;
	let value: unknown;
	if (m[2] === "json") value = step.json ?? safeParse(step.output ?? "");
	else value = safeParse(step.output ?? "");
	if (m[3]) {
		for (const key of m[3].split(".")) {
			if (value == null || typeof value !== "object") return undefined;
			value = (value as Record<string, unknown>)[key];
		}
	}
	return value;
}

function lastCompletedOutput(state: RunState, phase: Phase): string | undefined {
	const deps = dependenciesOf(phase);
	for (let i = deps.length - 1; i >= 0; i--) {
		const ps = state.phases[deps[i]];
		if (ps?.status === "done") return ps.output;
	}
	return undefined;
}

/** A conservative prompt-size warning threshold in estimated tokens. Crossed
 *  → the phase records a `warnings` entry so an author notices they may be
 *  approaching a model's context limit. Approximate (ceil(chars/4)), not a
 *  real tokenizer count. Chosen conservatively well below typical 128K context
 *  windows so the warning fires with ample headroom. */
export const PROMPT_SIZE_WARN_TOKENS = 32_000;

/** Compute durable prompt-size diagnostics for a resolved prompt string:
 *  exact UTF-8 byte count, character count, and a documented approximate token
 *  estimate (ceil(chars/4)). Never throws. */
export function promptSizeStats(text: string): { bytes: number; chars: number; estTokens: number } {
	let chars = 0;
	for (const _char of text) chars++; // Unicode code points, not UTF-16 code units
	const bytes = Buffer.byteLength(text, "utf8");
	const estTokens = Math.ceil(chars / 4);
	return { bytes, chars, estTokens };
}

/** Replace a phase's call diagnostics with the exact prompts captured by the
 * shared runner boundary. This covers single calls, retries, fan-out items,
 * loop/tournament/judge calls, and tree-reduce rounds without per-branch drift. */
function setPromptStats(ps: PhaseState, prompts: string[]): void {
	try {
		const calls = prompts.map((text) => promptSizeStats(text));
		const reduceInputs = ps.promptStats?.reduceInputs;
		ps.promptStats = { calls, ...(reduceInputs ? { reduceInputs } : {}) };
		ps.warnings = (ps.warnings ?? []).filter((warning) => !warning.startsWith("Prompt size ≈"));
		for (const call of calls) {
			if (call.estTokens >= PROMPT_SIZE_WARN_TOKENS) {
				ps.warnings.push(`Prompt size ≈${call.estTokens} tokens (${call.chars} chars, ${call.bytes} bytes) exceeds the conservative ${PROMPT_SIZE_WARN_TOKENS}-token warning threshold — the prompt may be approaching a model's context limit.`);
			}
		}
		if (ps.warnings.length === 0) delete ps.warnings;
	} catch {
		/* diagnostics must never sink the phase */
	}
}

/** Attach durable prompt-size diagnostics to a PhaseState. `prompts` is the list
 *  of resolved prompt strings actually sent to a subagent (one entry per call —
 *  one for an agent phase, multiple for a tree reduce). Each becomes a
 *  `{bytes, chars, estTokens}` record on `ps.promptStats.calls`. When any call
 *  crosses {@link PROMPT_SIZE_WARN_TOKENS}, a `warnings` entry is appended so an
 *  author notices they may be approaching a model's context limit (the estimate
 *  is conservative: ceil(chars/4), not a real tokenizer count). Never throws. */
function attachPromptStats(ps: PhaseState, prompts: string[]): void {
	try {
		const calls = prompts.map((t) => promptSizeStats(t));
		const existing = ps.promptStats;
		ps.promptStats = existing
			? { ...existing, calls: [...existing.calls, ...calls] }
			: { calls };
		for (const c of calls) {
			if (c.estTokens >= PROMPT_SIZE_WARN_TOKENS) {
				ps.warnings = [...(ps.warnings ?? []), `Prompt size ≈${c.estTokens} tokens (${c.chars} chars, ${c.bytes} bytes) exceeds the conservative ${PROMPT_SIZE_WARN_TOKENS}-token warning threshold — the prompt may be approaching a model's context limit.`];
			}
		}
	} catch {
		/* diagnostics must never sink the phase */
	}
}

/** Attach aggregate input stats for a reduce phase: count + total bytes/chars/
 *  estTokens over the completed `from[]` inputs being reduced. Stored on
 *  `ps.promptStats.reduceInputs` so post-hoc inspection can account for input
 *  size across reduce rounds. Never throws. */
function attachReduceInputStats(ps: PhaseState, state: RunState, phase: Phase): void {
	try {
		const s = reduceInputStats(state, phase);
		const existing = ps.promptStats;
		ps.promptStats = existing
			? { ...existing, reduceInputs: s }
			: { calls: [], reduceInputs: s };
	} catch {
		/* diagnostics must never sink the phase */
	}
}

/** Format a single reduce-from input as a labeled section. */
function formatReduceInput(id: string, output: string): string {
	return `### ${id}\n\n${output}`;
}

/** Aggregate completed `from[]` outputs for a reduce phase's {previous.output}.
 *
 *  BREAKING correction (dogfood issue 1): a reduce phase's {previous.output}
 *  resolves to ALL completed `from[]` outputs in from-array order — not just
 *  the last completed dependency. One completed input → its raw output.
 *  Multiple → `### <id>\n\n<output>` sections joined by `\n\n---\n\n`.
 *  `join:"any"` includes only completed branches (skipped/failed are omitted).
 *
 *  Returns `{ value, ids }` where `ids` are the from-ids actually aggregated
 *  (so the runtime can record them as observed reads). `value` is undefined
 *  when no `from[]` phase completed (e.g. all skipped under join:any). */
function aggregateReduceFrom(
	state: RunState,
	phase: Phase,
): { value: string | undefined; ids: string[] } {
	const fromIds = asArray<string>(phase.from);
	const completed: Array<{ id: string; output: string }> = [];
	for (const id of fromIds) {
		const ps = state.phases[id];
		if (ps?.status === "done" && ps.output !== undefined) {
			completed.push({ id, output: ps.output });
		}
	}
	if (completed.length === 0) return { value: undefined, ids: [] };
	if (completed.length === 1) return { value: completed[0].output, ids: [completed[0].id] };
	const value = completed.map((c) => formatReduceInput(c.id, c.output)).join("\n\n---\n\n");
	return { value, ids: completed.map((c) => c.id) };
}

/** Aggregate stats over the completed `from[]` inputs for reduce diagnostics. */
function reduceInputStats(state: RunState, phase: Phase): { count: number; totalBytes: number; totalChars: number; totalEstTokens: number } {
	const fromIds = asArray<string>(phase.from);
	let count = 0;
	let totalBytes = 0;
	let totalChars = 0;
	let totalEstTokens = 0;
	for (const id of fromIds) {
		const ps = state.phases[id];
		if (ps?.status === "done" && ps.output !== undefined) {
			count++;
			const s = promptSizeStats(ps.output);
			totalBytes += s.bytes;
			totalChars += s.chars;
			totalEstTokens += s.estTokens;
		}
	}
	return { count, totalBytes, totalChars, totalEstTokens };
}

/** Resolve the effective idle-watchdog ms for a phase: phase overrides flow;
 *  returns `undefined` when neither sets it (host default 300000 applies).
 *  `0` is passed through (disables the watchdog — validation already ensured a
 *  finite wall `timeout` exists in that case). */
export function resolveIdleTimeoutMs(phase: Phase, def: Taskflow): number | undefined {
	const p = (phase as { idleTimeout?: unknown }).idleTimeout;
	if (typeof p === "number" && Number.isFinite(p)) return p;
	const f = def.idleTimeout;
	if (typeof f === "number" && Number.isFinite(f)) return f;
	return undefined;
}

/**
 * Per-phase cache policy resolved once at the top of executePhase. Carries the
 * scope, optional TTL, and a pre-resolved fingerprint string so each phase-type
 * branch can fold it into its inputHash and consult the cross-run store uniformly.
 */
export interface PhaseCacheCtx {
	scope: CacheScope;
	ttlMs?: number;
	fingerprint: string;
	store: CacheStore;
	prior: PhaseState | undefined;
	phaseId: string;
	flowName: string;
	runId: string;
	/** Per-phase execution config that materially affects subagent output and
	 *  therefore must be part of the cache identity (else a config change could
	 *  silently serve a stale cross-run hit). */
	thinking?: string;
	tools?: string[];
	/** Resolved `context` pre-read content. Explicitly part of the cache identity
	 *  so a context-file change always invalidates the phase — independent of
	 *  whether a given branch happens to fold preRead into its task string
	 *  (previously this was only incidentally true via `fullTask`). */
	preRead?: string;
	/** Flow-level semantics retained even by per-item cache contexts, which
	 * deliberately omit phaseFp/flowDefHash for partial reuse. */
	agentScope?: Taskflow["agentScope"];
	contextSharing?: boolean;
	/** Resolved agent content/config. Same name+scope can still change prompt,
	 * model, tools, or thinking and must invalidate cached output. */
	agentDefinitions?: string;
	/** Canonical effective cwd. Required because a typed cwd arg can change the
	 * resource selected without appearing in the task text or phase definition. */
	executionCwd?: string;
	/** Content fingerprint of the desugared flow definition — folded into the
	 *  key so two structurally-different flows that share a name can never
	 *  collide, and a changed flow never serves a stale cross-run hit. */
	flowDefHash?: string | "failed";
	/** Per-phase structural sub-fingerprint (M6). When present, folds into the
	 *  key as `v3:phasefp:<subfp>` so editing phase B invalidates only B + its
	 *  transitive dependents. When absent (sub-flow inner states, or a phase
	 *  for which per-phase soundness couldn't be guaranteed), `cacheKeys`
	 *  falls back to `flowDefHash` — preserving pre-M6 whole-flow behavior. */
	phaseFp?: string;
	/** Force this phase to re-execute, ignoring the within-run prior AND the
	 *  cross-run store (M5 recompute seed). Downstream phases are NOT forced —
	 *  they re-evaluate naturally: if the seed's new output changed their
	 *  inputHash they miss and re-run, otherwise they hit (early cutoff). */
	forceRerun?: boolean;
}

/** Stable cache identity for the fully resolved agent pool. File paths are
 * excluded: content/config, not installation location, determines output. */
export function agentDefinitionsIdentity(agents: readonly AgentConfig[]): string {
	return JSON.stringify(
		agents
			.map((a) => ({
				name: a.name,
				description: a.description,
				systemPrompt: a.systemPrompt,
				model: a.model ?? "",
				thinking: a.thinking ?? "",
				tools: [...(a.tools ?? [])].sort(),
				source: a.source,
			}))
			.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source)),
	);
}

/** Fold the phase fingerprint into the base hash parts to form the final cache key. */
/** A computed cache identity: the new (versioned) key plus the read-only
 *  fallback keys used to honor entries written by older releases. The `key`
 *  is what we WRITE under and what `PhaseState.inputHash` carries; the
 *  `v2Key`/`bareKey` are consulted READ-ONLY on a miss. `legacyKey` is exposed
 *  only for tooling/tests and is never read because it lacks structural
 *  identity. See docs/internal/cache-migration.md. */
export interface CacheKeys {
	/** Current key: folds `v3:phasefp:<subfp>` (the per-phase structural
	 *  sub-fingerprint; degrades to the whole-flow hash when per-phase
	 *  soundness couldn't be guaranteed). */
	key: string;
	/** Pre-M6 key: `v2:flowdef:<flowDefHash>` (whole-flow fingerprint).
	 *  Read-only. */
	v2Key: string;
	/** Bare (unversioned) `flowdef:` key — written by pre-H1 code that folded
	 *  the hash without a `v2:` prefix. Read-only. Removed in v0.1.0. */
	bareKey: string;
	/** Pre-flowDefHash-era key: the flowdef line OMITTED entirely. Read-only. */
	legacyKey: string;
}

/** Fold the phase fingerprint into the base hash parts to form the cache keys.
 *
	 *  Four keys are derived for tooling/backward compatibility (see
 *  docs/internal/cache-migration.md):
 *    - `key`      : `v3:phasefp:<subfp>` — the current write key (per-phase
 *      structural sub-fingerprint; falls back to the whole-flow hash when
 *      `cc.phaseFp` is absent).
 *    - `v2Key`    : `v2:flowdef:<flowDefHash>` — pre-M6 whole-flow key.
 *    - `bareKey`  : bare `flowdef:<flowDefHash>` (unversioned) — pre-H1 entries.
 *    - `legacyKey`: the flowdef line omitted — pre-flowDefHash entries.
	 *  `cachedPhase` consults the first three safe tiers READ-ONLY on a miss;
	 *  `legacyKey` is never read because it has no structural identity.
	 *  `recordCache` writes only `key`. */
export function cacheKeys(cc: PhaseCacheCtx, baseParts: string[]): CacheKeys {
	// Fold the full cache identity into the hash: flow name (prevents collisions
	// across different flows that share a phase.id + task + model), the per-phase
	// thinking/tools config (changing either changes the subagent's output), the
	// resolved context pre-read content, and the world-state fingerprint.
	const tail = [
		...baseParts,
		`think:${cc.thinking ?? ""}`,
		`tools:${JSON.stringify(cc.tools ?? [])}`,
		`ctx:${cc.preRead ?? ""}`,
		`agent-scope:${cc.agentScope ?? "user"}`,
		`context-sharing:${cc.contextSharing === true ? "1" : "0"}`,
		`agents:${cc.agentDefinitions ?? ""}`,
		...(cc.executionCwd ? [`cwd:${cc.executionCwd}`] : []),
	];
	const fold = (parts: string[]): string =>
		cc.fingerprint ? hashInput(...parts, cc.fingerprint) : hashInput(...parts);
	// Per-phase sub-fingerprint; falls back to the whole-flow hash when absent
	// (sub-flow inner states, or soundness fallback) — preserving pre-M6 behavior.
	const fp = cc.phaseFp ?? cc.flowDefHash ?? "";
	const fdh = cc.flowDefHash ?? "";
	return {
		key: fold([`flow:${cc.flowName}`, `v3:phasefp:${fp}`, ...tail]),
		v2Key: fold([`flow:${cc.flowName}`, `v2:flowdef:${fdh}`, ...tail]),
		bareKey: fold([`flow:${cc.flowName}`, `flowdef:${fdh}`, ...tail]),
		legacyKey: fold([`flow:${cc.flowName}`, ...tail]),
	};
}

/**
 * Resume/memoization lookup. Honors scope:
 *   - "off":      never reuse (even within-run).
 *   - "run-only": within-run resume only (historical behavior).
 *   - "cross-run": within-run first, then the persistent cross-run store.
	 * On a cross-run hit, usage is zeroed and `cacheHit` records the source.
	 *
 * The cross-run read is three-tier and READ-ONLY for fallback keys: it tries
 * `keys.key` (current `v3:phasefp:` shape) first, then `keys.v2Key` (pre-M6
 * `v2:flowdef:`), then `keys.bareKey` (pre-H1 bare `flowdef:`). The older
 * no-flowdef key is deliberately unsafe and ignored.
 * A hit on any safe tier is restored as a cache hit; we do NOT write-through (no
 * re-store under the new key) so the cache size stays stable and the legacy
 * entry ages out naturally. See docs/internal/cache-migration.md.
 */
function cachedPhase(cc: PhaseCacheCtx, keys: CacheKeys): PhaseState | null {
	if (cc.scope === "off") return null;
	if (cc.forceRerun) return null;

	// 1. within-run resume (fastest; always allowed unless scope is off). Flag
	// it as a `run-only` cache hit so the run summary can count it as reused
	// work (it spent no new tokens). The prior usage is preserved verbatim so
	// the summary can report what the reuse would otherwise have cost.
	if (cc.prior && cc.prior.status === "done" && cc.prior.inputHash === keys.key) {
		return { ...cc.prior, status: "done", cacheHit: "run-only" };
	}

	// 2. cross-run memoization (opt-in) — three safe read-only tiers.
	if (cc.scope === "cross-run") {
		// The pre-flow-definition legacy key is intentionally NOT read: it omits
		// all structural identity and can return stale output after any semantic
		// flow change. v2/bare remain safe because they include today's definition
		// hash; old entries whose historical hash omitted new fields simply miss.
		for (const k of [keys.key, keys.v2Key, keys.bareKey]) {
			const e = cc.store.get(k, cc.ttlMs);
			if (!e) continue;
			// If we stored the full PhaseState, restore it (preserving gate,
			// approval, reads, loop/tournament metadata, warnings) and just mark
			// the cache hit + zero usage. Fallback to the legacy trimmed surface
			// for entries written before this change.
			if (e.state) {
				return { ...e.state, inputHash: keys.key, usage: emptyUsage(), cacheHit: "cross-run", endedAt: Date.now() };
			}
			return {
				id: cc.phaseId,
				status: "done",
				inputHash: keys.key,
				output: e.output,
				json: e.json,
				model: e.model,
				usage: emptyUsage(),
				cacheHit: "cross-run",
				endedAt: Date.now(),
			};
		}
	}
	return null;
}

/** Persist a freshly-computed phase result to the cross-run store (best-effort). */
function recordCache(cc: PhaseCacheCtx, ps: PhaseState): void {
	if (cc.scope !== "cross-run") return;
	if (ps.status !== "done" || !ps.inputHash) return;
	if (ps.cacheHit) return; // don't re-store a value we just read from cache
	cc.store.put({
		key: ps.inputHash,
		createdAt: Date.now(),
		output: ps.output,
		json: ps.json,
		model: ps.model,
		state: ps,
		flowName: cc.flowName,
		phaseId: cc.phaseId,
		runId: cc.runId,
	});
}

/**
 * Resolve an agent name against available agents. Falls back to the default
 * agent if the requested agent isn't found, logging a warning via safeEmit.
 */
function resolveAgent(name: string | undefined, deps: RuntimeDeps, state: RunState): string {
	const resolved = name ?? defaultAgent(deps);
	if (name && !deps.agents.some((a) => a.name === name)) {
		const fallback = defaultAgent(deps);
		// Log only once per run to avoid noise.
		if (!(state as any).__unknownAgentWarned) {
			(state as any).__unknownAgentWarned = new Set<string>();
		}
		if (!(state as any).__unknownAgentWarned.has(name)) {
			(state as any).__unknownAgentWarned.add(name);
			console.warn(`[taskflow] Unknown agent "${name}", falling back to "${fallback}". Use action=agents to list available agents.`);
		}
		return fallback;
	}
	return resolved;
}

function defaultAgent(deps: RuntimeDeps): string {
	return deps.agents[0]?.name ?? "default";
}

/**
 * Parse a gate phase's output into a verdict. Blocks the flow on an explicit
 * negative signal OR on ambiguous, unparseable model output. Accepts JSON
 * ({continue|pass: bool} or {verdict: "..."}) or a text marker
 * `VERDICT: PASS|BLOCK|FAIL|STOP|OK|REJECT|HALT` (last occurrence wins). The text
 * matcher tolerates common Markdown emphasis around the verdict word
 * (`VERDICT: **BLOCK**`, `### VERDICT: __BLOCK__`, `VERDICT: `BLOCK``) so a
 * genuine BLOCK is never silently downgraded to PASS (issue #54).
 *
 * **Fail-closed:** if the model produced output but no verdict could be parsed,
 * the gate BLOCKS. A gate that cannot reach a verdict cannot be trusted to pass;
 * halting is recoverable (prior phases persist, the run is resumable) whereas a
 * rubber-stamped PASS is silent and potentially ships broken work. Note that a
 * JSON verdict object whose value is non-blocking (e.g. `{"verdict":"No issues
 * found"}`) is an *explicit* pass, not ambiguity, and still resolves to pass.
 */
// `parseGateVerdict` / `parseTournamentWinner` live in `deterministic.ts`
// (pure seam for replay + event kernel). Re-exported via the barrel.

/**
 * If a gate phase relies on free-text verdict parsing (no `output:"json"` +
 * `expect` contract) and its task does not already demand a `VERDICT:` marker,
 * append a hard output-format suffix. This pushes the model toward the exact
 * machine-readable terminator the parser expects, so a genuine verdict is not
 * lost to an authoring slip or a model that "forgets" to emit one (issue #54).
 * When the phase already enforces a JSON contract, no suffix is needed — the
 * `expect` schema validates the output deterministically.
 */
function appendGateFormatSuffix(task: string, phase: Phase): string {
	// Only free-text GATE phases need the verdict terminator. Agent/map/reduce/loop
	// phases pass through untouched — they have no verdict to parse.
	if (phase.type !== "gate") return task;
	if (phase.output === "json" && phase.expect) return task;
	// Already asks for a verdict marker (any case) — don't duplicate.
	if (/VERDICT\s*[:=]/i.test(task)) return task;
	return (
		`${task}\n\n--- Required output format ---\n` +
		`End your response with exactly one line in this exact form (no Markdown, no bold, no extra words):\n` +
		`VERDICT: PASS\nor\nVERDICT: BLOCK`
	);
}

/* parseTournamentWinner lives in deterministic.ts (shared with event kernel). */

/**
 * Best-effort invocation of the user-provided `persist` + `onProgress` callbacks.
 *
 * A throw from a host-supplied callback must NEVER replace the runtime's
 * outcome — neither the original crash message in `executeTaskflow`'s catch
 * block, nor the final output of a successful run. Callbacks are observability
 * hooks; the run survives their failure.
 *
 * Used at every "checkpoint" call site (phase start, phase end, terminal state).
 * For high-frequency live updates inside a phase, see `safeProgress` below.
 */
function safeEmit(deps: RuntimeDeps, state: RunState): void {
	try {
		deps.persist?.(state);
	} catch {
		// user callback — must not break the run
	}
	try {
		deps.onProgress?.(state);
	} catch {
		// user callback — must not break the run
	}
}

/**
 * Like `safeEmit` but for the high-frequency live-update channel only.
 * Skips `persist` (which is intentionally checkpoint-only) and swallows any
 * throw from the user-supplied `onProgress` so a misbehaving TUI sink cannot
 * disrupt an in-flight phase.
 */
function safeProgress(deps: RuntimeDeps, state: RunState): void {
	try {
		deps.onProgress?.(state);
	} catch {
		// user callback — must not break the run
	}
}

/**
 * Execute a full taskflow. Mutates and persists `state` as it progresses.
 */
/** Result of a recompute: what was (or would be) re-executed vs reused.
 *  `cutoff` is the prize — phases in the stale frontier whose inputHash did
 *  NOT move, so they hit their cached result instead of re-running (early
 *  cutoff). That is what makes recompute cheaper than a full re-run. */
export interface RecomputeReport {
	readonly dryRun: boolean;
	readonly aborted: boolean;
	readonly seeds: readonly string[];
	/** Phases that were (dry-run: would be) re-executed, or whose result moved. */
	readonly rerun: readonly string[];
	/** Phases outside the frontier — untouched, reused verbatim. */
	readonly reused: readonly string[];
	/** Phases in the frontier whose inputHash did NOT move → cached result
	 *  reused, no re-execution (early cutoff). Empty in dry-run (unknowable). */
	readonly cutoff: readonly string[];
	/** Per-phase decision trace: WHY each phase was rerun / cut off / reused.
	 *  The "explainable reactivity" layer — like React DevTools telling you why
	 *  a component re-rendered. Additive; callers that ignore it are unaffected. */
	readonly decisions: readonly RecomputeDecision[];
}

/** Why a single phase landed in its recompute outcome. */
export interface RecomputeDecision {
	readonly phaseId: string;
	/** What happened (real run) or would happen (dry-run). */
	readonly outcome: "rerun" | "cutoff" | "reused" | "failed";
	/** Human-readable cause. */
	readonly reason: string;
	/** The upstream phase(s) that caused this outcome, when applicable
	 *  (e.g. the changed upstreams that forced a rerun). */
	readonly causedBy?: readonly string[];
}

/** Scan a flow for dependencies that cannot be observed through the readSet.
 *  These include Shared Context Tree, sub-flows, context: file pre-reads, and
 *  interpolation placeholders that do not resolve through `steps.*` (previous,
 *  args, item). Recomputing flows with such deps with dryRun:false risks
 *  silently reusing stale upstream state. */
function hasUnobservedDependencies(state: RunState): boolean {
	const scan = (text: string): boolean => /\{(previous\.output|args\.|item\b|item\.)/.test(text);
	for (const p of state.def.phases) {
		if (p.shareContext === true) return true;
		if (state.def.contextSharing === true) return true;
		if (p.type === "flow") return true;
		if (p.context && p.context.length > 0) return true;
		if (scan(p.task ?? "")) return true;
		if (p.when && scan(p.when)) return true;
		if (p.until && scan(p.until)) return true;
		if (Array.isArray(p.eval) && p.eval.some(scan)) return true;
	}
	return false;
}

/** Recompute a completed run minimally: force-rerun the `seeds`, then walk
 *  their stale frontier in topological order. The cache provides early cutoff
 *  for free — a downstream whose inputHash didn't move (because the seed's new
 *  output happened to equal the old) hits its prior and is reused rather than
 *  re-executed. `dryRun` computes the worst-case frontier without spending a
 *  token. Returns a fresh state + a report. Throws only when dryRun:false is
 *  requested for a flow with unobserved dependencies; callers should surface
 *  that as a user-facing error. */
export async function recomputeTaskflow(
	state: RunState,
	deps: RuntimeDeps,
	seeds: readonly string[],
	// Fail-safe default: a real recompute overwrites the run and spends tokens.
	// The tool/command wrappers can explicitly opt into dryRun:false.
	opts: { dryRun?: boolean } = { dryRun: true },
): Promise<{ report: RecomputeReport; state: RunState }> {
	deps = snapshotFlowLoader(deps);
	// Never mutate the caller's RunState in-place. Recompute is a speculative
	// replay; only the caller decides whether to persist the new state.
	const newState = structuredClone(state) as RunState;
	newState.args = resolveArgs(newState.def, newState.args);
	const invocationErrors = validateInvocationArgs(newState.def, newState.args);
	if (invocationErrors.length > 0) {
		throw new Error(`Taskflow '${newState.def.name}' invocation is invalid: ${invocationErrors.join("; ")}`);
	}
	const bridgeTree = flowTreeUsesCwdBridge(newState.def, deps.loadFlow);
	// Once a run has exercised the compatibility bridge, its persisted root
	// binding is permanent provenance. A later definition downgrade must not
	// silently turn cache/recompute back on for state produced with filesystem
	// authority.
	const bridgeTainted = bridgeTree || newState.cwdRootBinding !== undefined;
	if (bridgeTainted && opts.dryRun === false) {
		throw new Error(
			"recompute dryRun:false is unavailable for cwd-bridge flows until workspace state restoration exists; run the whole flow instead",
		);
	}
	if (!deps._disableCache && bridgeTainted) {
		deps = { ...deps, _disableCache: true };
	}
	const reads = readMapOf(newState.phases);
	// M2: derive the declared read-map fresh from the def so the frontier uses
	// the UNION (observed ∪ declared). Derived here (not read from the persisted
	// `RunState.declaredDeps`) so old runs — pre-H1, no persisted declaredDeps —
	// also get union semantics. The persisted field is audit/provenance only.
	const declared = declaredReadMapOfDef(newState.def);
	const frontier = computeStaleFrontier(reads, seeds, declared);
	const allIds = Object.keys(newState.phases);

	if (opts.dryRun) {
		// Explain each phase WITHOUT executing: a frontier phase "may rerun"
		// because it (transitively) reads a changed seed; everything else is
		// reused as unreachable. We name the in-frontier upstream(s) as the cause.
		const seedSet0 = new Set(seeds);
		const upstreamsOf = (id: string): string[] => {
			const observed = (newState.phases[id]?.reads ?? []).map((r) => r.stepId).filter((u) => u !== id);
			const decl = (declared.get(id) ?? []).filter((u) => u !== id);
			return [...new Set([...observed, ...decl])];
		};
		const decisions: RecomputeDecision[] = allIds.map((id) => {
			if (!frontier.has(id)) {
				return { phaseId: id, outcome: "reused", reason: "not reachable from any changed seed" };
			}
			if (seedSet0.has(id)) {
				return { phaseId: id, outcome: "rerun", reason: "forced by recompute request (seed)" };
			}
			const causes = upstreamsOf(id).filter((u) => frontier.has(u));
			return {
				phaseId: id,
				outcome: "rerun",
				reason: "reads a phase in the stale frontier; may re-run if that upstream's output moves",
				causedBy: causes.length ? causes : undefined,
			};
		});
		return {
			report: {
				dryRun: true,
				aborted: false,
				seeds,
				rerun: [...frontier],
				reused: allIds.filter((id) => !frontier.has(id)),
				cutoff: [],
				decisions,
			},
			state: newState,
		};
	}
	// Guard: observed readSet only tracks `{steps.X.*}` interpolation refs. It is
	// blind to Shared Context Tree (ctx_read/ctx_write), sub-flow internals,
	// context: file pre-reads, {previous.output}, and loop locals ({args.*},
	// {item.*}). Recomputing such a run with dryRun:false could silently skip
	// phases whose deps changed outside the observed frontier and then persist a
	// corrupted run over the original.
	if (hasUnobservedDependencies(newState)) {
		throw new Error(
			"recompute dryRun:false is unsafe for this run: it contains dependencies " +
				"(shareContext, flow/ctx_spawn, context: files, {previous.output}, {args.*}, or {item.*}) " +
				"that are not tracked by the observed readSet. Use dryRun:true to inspect " +
				"the frontier, or change the upstream phase and re-run the whole flow.",
		);
	}

	// Real recompute: topological order over the frontier so a downstream always
	// sees its (already-refreshed) upstreams when it re-evaluates its cache key.
	// The order must respect declared dependsOn, observed reads, AND declared
	// reads (M2 union): pi-taskflow allows interpolation refs without an
	// explicit dependsOn edge, and a declared-but-unobserved edge (e.g. a `when`
	// ref that never fired) must still order the reader after its upstream so
	// the reader evaluates its cache key against the refreshed upstream (no
	// false early-cutoff).
	const seedSet = new Set(seeds);
	function depsFor(phaseId: string): string[] {
		// A phase reading its own prior output (e.g. a loop `until` checking
		// `{steps.thisId.output}`) must not create a self-edge in the scheduling
		// graph — otherwise topoLayers would deadlock on the self-loop.
		const observed = (newState.phases[phaseId]?.reads ?? [])
			.map((r) => r.stepId)
			.filter((id) => id !== phaseId);
		const declared_ = (declared.get(phaseId) ?? []).filter((id) => id !== phaseId);
		return [...new Set([...observed, ...declared_])];
	}
	const augmentedPhases = newState.def.phases.map((p) => ({
		...p,
		dependsOn: [...new Set([...(p.dependsOn ?? []), ...depsFor(p.id)])],
	}));
	const order = topoLayers(augmentedPhases)
		.flat()
		.map((p) => p.id)
		.filter((id) => frontier.has(id));
	const rerun: string[] = [];
	const cutoff: string[] = [];
	const decisions: RecomputeDecision[] = [];
	// Phases whose OUTPUT actually moved this recompute (seed forced, or result
	// changed). Used to attribute a downstream rerun to the specific upstream(s)
	// that changed — the "why" of the decision trace.
	const outputMoved = new Set<string>();
	const noop = () => {};
	let aborted = false;
	for (const id of order) {
		// A partial recompute must NOT be persisted over the original run — the
		// caller discards `state` when `aborted` is set.
		if (deps.signal?.aborted) {
			aborted = true;
			break;
		}
		const phase = newState.def.phases.find((p) => p.id === id);
		if (!phase) continue;
		const before = newState.phases[id]?.inputHash;
		const isSeed = seedSet.has(id);
		const execOpts = isSeed ? { forceRerun: true } : undefined;
		// The upstream(s) of this phase whose output moved — the cause of a rerun.
		const changedUpstreams = depsFor(id).filter((u) => outputMoved.has(u));
		try {
			const ps = await executePhase(phase, newState, deps, newState.phases[id], noop, 0, execOpts);
			if (ps.status === "failed") {
				// Recompute is speculative. Preserve the last known-good row for the
				// failed phase and every downstream phase, then stop. Mark the report
				// aborted so callers cannot persist a partially refreshed graph.
				rerun.push(id);
				decisions.push({
					phaseId: id,
					outcome: "failed",
					reason: ps.error ?? "re-execution returned a failed phase",
				});
				aborted = true;
				break;
			}
			newState.phases[id] = ps;
			// A phase counts as "rerun" if it was a forced seed OR its result moved;
			// otherwise it hit its cache (inputHash unchanged) → early cutoff.
			if (isSeed || !ps.cacheHit || ps.inputHash !== before) {
				rerun.push(id);
				outputMoved.add(id);
				decisions.push(
					isSeed
						? { phaseId: id, outcome: "rerun", reason: "forced by recompute request (seed)" }
						: {
								phaseId: id,
								outcome: "rerun",
								reason: "input changed — an upstream's output moved",
								causedBy: changedUpstreams.length ? changedUpstreams : undefined,
							},
				);
			} else {
				cutoff.push(id);
				decisions.push({
					phaseId: id,
					outcome: "cutoff",
					reason: "input unchanged — upstream(s) re-ran but produced identical output (early cutoff)",
					causedBy: depsFor(id).filter((u) => frontier.has(u)).length
						? depsFor(id).filter((u) => frontier.has(u))
						: undefined,
				});
			}
		} catch (error) {
			// A failing recompute phase is recorded as rerun (it was attempted).
			rerun.push(id);
			decisions.push({
				phaseId: id,
				outcome: "failed",
				reason: `re-execution threw: ${error instanceof Error ? error.message : String(error)}`,
			});
			aborted = true;
			break;
		}
	}
	// Frontier-external phases were never touched — record them as reused.
	for (const id of allIds) {
		if (!frontier.has(id)) {
			decisions.push({ phaseId: id, outcome: "reused", reason: "not reachable from any changed seed" });
		}
	}
	return {
		report: {
			dryRun: false,
			aborted,
			seeds,
			rerun,
			reused: allIds.filter((id) => !frontier.has(id)),
			cutoff,
			decisions,
		},
		state: newState,
	};
}

export async function executeTaskflow(state: RunState, deps: RuntimeDeps): Promise<RuntimeResult> {
	deps = snapshotFlowLoader(deps);
	const def: Taskflow = state.def;
	const failBeforeExecution = (finalOutput: string): RuntimeResult => {
		state.status = "failed";
		state.finalOutput = finalOutput;
		state.outputSourcePhaseId = undefined;
		safeEmit(deps, state);
		return { state, finalOutput, ok: false, totalUsage: emptyUsage() };
	};
	// Normalize defaults at the engine boundary too. Adapters already do this,
	// but direct Core callers, resume, and detached execution must behave the same.
	state.args = resolveArgs(def, state.args);
	const invocationErrors = validateInvocationArgs(def, state.args);
	if (invocationErrors.length > 0) {
		return failBeforeExecution(`Taskflow '${def.name}' invocation is invalid: ${invocationErrors.join("; ")}`);
	}
	if (deps._dynamic === true) {
		const dynamicValidation = validateTaskflow(def, { dynamic: true, cwd: deps.cwd, args: state.args });
		if (!dynamicValidation.ok) {
			return failBeforeExecution(`Dynamic taskflow '${def.name}' is invalid: ${dynamicValidation.errors.join("; ")}`);
		}
	}
	// A cwd bridge carries compatibility read-write authority. Until workspace
	// state restoration exists, output-only cache hits could skip required file
	// mutations or let downstream phases observe stale files. Disable cache and
	// within-run resume reuse across the complete reachable flow tree.
	const bridgeTree = flowTreeUsesCwdBridge(def, deps.loadFlow);
	// Persisted binding is a permanent taint bit: saved-flow definitions can
	// change between resumes, but prior outputs may already depend on filesystem
	// mutations. Never regain cache/rebind privileges merely because the current
	// snapshot no longer declares the bridge.
	const bridgeTainted = bridgeTree || state.cwdRootBinding !== undefined;
	if (bridgeTainted) {
		const invocationRoot = directoryIdentity(deps.cwd);
		const statePathRoot = directoryIdentity(state.cwd);
		const launchRoot = state.invocationRootSnapshot;
		const recordedRoot = state.cwdRootBinding;
		const executablePhaseIds = new Set(def.phases.map((phase) => phase.id));
		const hasExecutablePriorState = Object.keys(state.phases).some((id) => executablePhaseIds.has(id));
		// Pre-seeded external dependencies are inputs, not evidence that a bridge
		// phase previously executed without a persisted root binding. Conversely,
		// a host's launch snapshot proves root continuity, not prior bridge
		// authorization: adding a bridge after ordinary phases ran still fails.
		const isLegacyResume = bridgeTree && recordedRoot === undefined && hasExecutablePriorState;
		if (
			isLegacyResume ||
			!sameDirectoryIdentity(statePathRoot, invocationRoot) ||
			(launchRoot !== undefined && !sameDirectoryIdentity(launchRoot, invocationRoot)) ||
			(recordedRoot !== undefined && !sameDirectoryIdentity(recordedRoot, invocationRoot))
		) {
			return failBeforeExecution(
				`Taskflow '${def.name}' cwd-bridge invocation root does not match the run's persisted root; start a new run instead of rebinding on resume`,
			);
		}
		state.cwdRootBinding ??= invocationRoot;
		// Freeze the invocation root to the canonical identity we just bound. In
		// particular, do not resolve phase cwd through a caller-provided symlink a
		// second time after the root-binding check.
		if (invocationRoot) deps = { ...deps, cwd: invocationRoot.canonicalPath };
	}
	if (!deps._disableCache && bridgeTainted) {
		deps = { ...deps, _disableCache: true };
	}
	// The explicit 0.2.1 resolve-only opt-in uses a W1a-compatible partial
	// control/durability scaffold. This does not upgrade its assurance: the
	// session is deliberately labelled resolve-only and no OS sandbox claim is
	// made. A native session must come from an exact approved host baseline cell.
	if (bridgeTree && deps.cwdBridgeMode === "resolve-only" && !deps.workspaceSession) {
		try {
			deps = {
				...deps,
				workspaceSession: await createResolveOnlyWorkspaceSession({
					invocationRoot: deps.cwd,
					controlDirectory: deps.workspaceControlDirectory,
					signal: deps.signal,
				}),
			};
		} catch (error) {
			return failBeforeExecution(
				`Taskflow '${def.name}' workspace capability initialization failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const runnerUsageAccounting = (deps.runTask as (RunTaskFn & { usageAccounting?: "available" | "tokens-only" | "unavailable" }) | undefined)
		?.usageAccounting;
	if (!deps.usageAccounting && runnerUsageAccounting) {
		// Preserve a runner-advertised capability across the wrapper functions used
		// by nested flow/context execution; those wrappers would otherwise erase a
		// property attached to the original runTask function.
		deps = { ...deps, usageAccounting: runnerUsageAccounting };
	}
	try {
		if (deps.usageAccounting === "unavailable" && def.budget) {
			throw new Error(
				`Usage accounting is unavailable for this host; refusing budgeted flow '${def.name}' because its token/USD ceiling cannot be enforced`,
			);
		}
		if (deps.usageAccounting === "tokens-only" && def.budget?.maxUSD !== undefined) {
			throw new Error(
				"This host reports tokens but not cost, so budget.maxUSD cannot be enforced. " +
					"Use budget.maxTokens or a host with cost accounting.",
			);
		}
		// Top-level structural preflight (zero-token). Built-in detector findings
		// (any severity) stay advisory at the top level — a flow may still run even
		// with structural errors, exactly as before this seam existed. We block ONLY
		// on error-severity issues from caller-supplied verifiers (deps.verifiers):
		// category "plugin" is the canonical discriminator (a nameless verifier's
		// fail-closed issue still carries it, whereas `source` would be undefined).
		// Existing flows are unaffected and a host's trusted verifiers can gate spend
		// before any agent is spawned. Plugin warnings never block here.
		if (deps.verifiers?.length) {
			const preflight = verifyTaskflow(
				{ name: def.name, phases: def.phases as Phase[], budget: def.budget, concurrency: def.concurrency },
				{ verifiers: deps.verifiers },
			);
			const pluginErrors = preflight.issues.filter(
				(i) => i.category === "plugin" && i.severity === "error",
			);
			if (pluginErrors.length) {
				throw new Error(
					`Taskflow '${def.name}' failed verifier preflight: ${pluginErrors.map((i) => i.message).join("; ")}`,
				);
			}
		}
		// S2 strangler (default OFF): all phase kinds may use the event kernel when enabled.
		const { eventKernelEnabled, canUseEventKernel, runEventKernel } = await import("./exec/driver.ts");
		// Existing phase state requires the imperative cache/inputHash machinery to
		// validate definition and idempotency before reuse. The event kernel does
		// not yet persist compatible input hashes, so it must never blindly trust a
		// prior `done` row.
		const hasPriorState = Object.keys(state.phases).length > 0;
		if (eventKernelEnabled(deps) && deps._cwdBoundary === undefined && !hasPriorState && canUseEventKernel(def, deps.loadFlow)) {
			if (!deps.runTask) {
				throw new Error("event kernel requires RuntimeDeps.runTask");
			}
			return await runEventKernel(state, {
				cwd: deps.cwd,
				agents: deps.agents,
				runTask: deps.runTask,
				signal: deps.signal,
				globalThinking: deps.globalThinking,
				usageAccounting: deps.usageAccounting,
				trace: deps.trace,
				persist: deps.persist,
				onProgress: deps.onProgress,
				eventKernel: deps.eventKernel,
				verifiers: deps.verifiers,
				requestApproval: deps.requestApproval,
				loadFlow: deps.loadFlow,
				_stack: deps._stack,
				_dynamic: deps._dynamic,
			});
		}
		return await runTaskflowLayers(state, deps);
	} catch (e) {
		// A thrown phase must not leave the run wedged in "running" (which breaks
		// resume). Mark any in-flight phase + the run as failed, persist, and return.
		const message = e instanceof Error ? e.message : String(e);
		for (const p of Object.values(state.phases)) {
			if (p.status === "running") {
				p.status = "failed";
				p.error = p.error ?? message;
				p.endedAt = Date.now();
			}
		}
		state.status = "failed";
		const finalOutput = `Taskflow '${def.name}' crashed: ${message}`;
		state.finalOutput = finalOutput;
		state.outputSourcePhaseId = undefined;
		safeEmit(deps, state);
		const totalUsage = aggregateUsage(Object.values(state.phases).map((p) => p.usage ?? emptyUsage()));
		return { state, finalOutput, ok: false, totalUsage };
	}
}

async function runTaskflowLayers(state: RunState, deps: RuntimeDeps): Promise<RuntimeResult> {
	const def: Taskflow = state.def;
	// Ownership migration must happen before ANY phase in the new definition is
	// scheduled. Definition evolution may remove/rename ordinary phases as well
	// as graft children; neither their terminal failure nor their usage may leak
	// into the new run. Dynamic promoted state is intentionally cleared here too
	// and is restored only by its owning expand phase (from its current result or
	// cache). An id newly promoted to a real authored phase is preserved because
	// it is present in `declaredPhaseIds` and the scheduler will validate/rerun it.
	// Cleaning inside the expand phase would be too late: an unrelated authored
	// phase may already have been scheduled and stale usage already counted.
	const declaredPhaseIds = new Set(def.phases.map((p) => p.id));
	// A pre-seeded state may intentionally supply an external dependency (for
	// example an embedding host injects `src` and the definition starts at a map
	// that depends on it). Those ids are part of the new definition's dependency
	// contract even though they have no executable Phase row, so preserve them.
	const externalDependencyIds = new Set(
		def.phases.flatMap((phase) => dependenciesOf(phase)).filter((id) => !declaredPhaseIds.has(id)),
	);
	for (const oldId of Object.keys(state.phases)) {
		if (!declaredPhaseIds.has(oldId) && !externalDependencyIds.has(oldId)) delete state.phases[oldId];
	}
	for (const previous of Object.values(state.phases)) {
		for (const oldId of Object.keys(previous.promotedPhases ?? {})) {
			if (!declaredPhaseIds.has(oldId)) delete state.phases[oldId];
		}
	}
	const layers = topoLayers(def.phases);
	// Content-fingerprint the desugared definition ONCE per run and fold it into
	// every phase's cache key (overstory hash algorithm; see ./flowir/hash.ts).
	// Reused by every phase, persisted on the RunState for audit/resume.
	// Never throws into the run — a hash failure leaves the field unset and the
	// cache key degrades to the legacy flowName-only shape.
	//
	// Routed through the FlowIR compile seam (M1): `compileTaskflowToIR`
	// produces the content-addressed IR whose `hash` (== flowDefHash in the
	// stub) folds into the cache key, and whose `meta.declaredDeps` (M2 declared
	// plane) is persisted for audit/provenance. The declared plane is also
	// derived fresh from `def` in recompute (so old runs get union semantics
	// too); the persisted copy is for display.
	try {
		const ir = await compileTaskflowToIR(def);
		const nextHash = ir.hash ?? "failed";
		if (state.flowDefHash !== nextHash) {
			state.flowDefHash = nextHash;
			state.phaseFingerprints = undefined;
		}
		state.declaredDeps = ir.meta.declaredDeps;
		if (ir.errors.length) {
			console.warn(
				`[taskflow] IR compile errors for '${def.name}': ${ir.errors.map((e) => e.message).join("; ")}`,
			);
		}
	} catch (e) {
		if (state.flowDefHash === undefined) {
			// Fail-safe: warn loudly rather than silently degrading to the legacy
			// flowName-only key, which would reopen the cross-flow collision hole.
			console.warn(
				`[taskflow] flowDefHash failed for '${def.name}': ${e instanceof Error ? e.message : String(e)}. ` +
				"Cross-run cache is disabled for this run to prevent stale cross-flow hits.",
			);
			state.flowDefHash = "failed";
		}
	}

	// M6: per-phase structural sub-fingerprints. Computed once per run (when
	// cross-run is potentially active) so editing phase B invalidates only B +
	// its transitive dependents, not independent siblings. Each value is either
	// a precise per-phase hash or the whole-flow `flowDefHash` (soundness
	// fallback for shareContext / `flow` phases). Skipped entirely when
	// `flowDefHash === "failed"` (cross-run is disabled for the run anyway).
	// Never throws into the run — a per-phase error degrades that phase to the
	// whole-flow hash (safe, = pre-M6 behavior).
	if (state.flowDefHash !== "failed" && state.phaseFingerprints === undefined) {
		const whole = state.flowDefHash ?? "";
		const map: Record<string, string> = {};
		for (const p of def.phases) {
			try {
				map[p.id] = (await phaseFingerprint(def, p.id)) ?? whole;
			} catch {
				map[p.id] = whole; // fail-open → whole-flow scope
			}
		}
		state.phaseFingerprints = map;
	}

	state.status = "running";
	safeEmit(deps, state);

	let aborted = false;
	let gateBlocked = false;
	let gateReason = "";
	let gateOutput = "";
	/** Id of the blocking gate/approval phase (source of `gateOutput`). */
	let gatePhaseId: string | undefined;
	// `budgetBlocked` gates the skipping of remaining phases once the cap is hit
	// and also drives the terminal "blocked" status — a maxUSD ceiling must never
	// silently do nothing.
	let budgetBlocked = false;
	let budgetReason = "";
	const byId = new Map(def.phases.map((p) => [p.id, p]));

	for (const layer of layers) {
		if (deps.signal?.aborted) {
			aborted = true;
			break;
		}
		// Phases within a layer have no inter-dependencies → run concurrently.
		// A usage report arrives only after a subagent call. With a declared hard
		// budget, concurrent layer admission would let every sibling observe the
		// same remaining allowance. Serialize admission so no additional call can
		// begin after a previous call has exhausted the cap.
		const layerConcurrency = def.budget ? 1 : Math.max(1, def.concurrency ?? 8);
		await mapWithConcurrencyLimit(layer, layerConcurrency, async (phase) => {
			// Snapshot prior state BEFORE marking running, so resume cache checks work.
			const prior = state.phases[phase.id];

			// Determine whether this phase should run, or be skipped (and why).
			const deps_ = dependenciesOf(phase);
			const join = phase.join ?? "all";
			// An `optional` dependency that failed still counts as satisfied.
			const depOk = (d: string): boolean => {
				const s = state.phases[d]?.status;
				if (s === "done") return true;
				if (s === "failed" && byId.get(d)?.optional) return true;
				return false;
			};
			const depsSatisfied =
				deps_.length === 0 ? true : join === "any" ? deps_.some(depOk) : deps_.every(depOk);

			let skipReason: string | undefined;
			if (gateBlocked) skipReason = `Gate blocked${gateReason ? `: ${gateReason}` : ""}`;
			else if (budgetBlocked) skipReason = `Budget exceeded${budgetReason ? `: ${budgetReason}` : ""}`;
			else if (!depsSatisfied)
				skipReason = join === "any" ? "All dependencies failed or were skipped" : "Upstream dependency not satisfied";

			if (skipReason) {
				if (skipReason.startsWith("Budget exceeded")) {
					budgetBlocked = true;
					// S1: budget-hit decision so fold/replay can re-tally under new caps.
					traceDecision(deps, state, phase.id, {
						type: "budget-hit",
						value: budgetReason || "budget",
						reason: skipReason,
					});
					// executePhase already flushed its phase-end batch. Flush this
					// post-completion decision too so FileTraceSink cannot strand it.
					traceFlush(deps, phase.id);
				}
				// Synthetic phase-start/end so fold sees a complete phase lifecycle.
				traceEmit(deps, {
					ts: Date.now(),
					runId: state.runId,
					phaseId: phase.id,
					kind: "phase-start",
					dependencies: dependenciesOf(phase),
					optional: phase.optional === true,
				});
				state.phases[phase.id] = {
					id: phase.id,
					status: "skipped",
					error: skipReason,
					endedAt: Date.now(),
					usage: emptyUsage(),
				};
				traceEmit(deps, {
					ts: Date.now(),
					runId: state.runId,
					phaseId: phase.id,
					kind: "phase-end",
					status: "skipped",
					error: skipReason,
				});
				traceFlush(deps, phase.id);
				safeEmit(deps, state);
				return;
			}

			const startedAt = Date.now();
			// Re-running a phase (resume after a previous failed/done attempt) must
			// start from a clean "running" state. Spreading the prior PhaseState
			// would carry over its terminal `endedAt` (and `error`/`gate`/`output`),
			// leaving a running phase with an old endedAt < new startedAt — which
			// renders as a frozen NEGATIVE elapsed time in the TUI. Keep only the
			// fields that are still meaningful across attempts (model, attempts).
			const priorPs = state.phases[phase.id];
			state.phases[phase.id] = {
				id: phase.id,
				status: "running",
				startedAt,
				...(priorPs?.model ? { model: priorPs.model } : {}),
				...(priorPs?.attempts ? { attempts: priorPs.attempts } : {}),
			};
			safeProgress(deps, state);

			const ps = await executePhase(phase, state, deps, prior, () => safeProgress(deps, state));
			// Preserve the phase start time: executePhase returns a fresh PhaseState
			// that omits startedAt (cached/resumed results carry their own).
			state.phases[phase.id] = ps.startedAt ? ps : { ...ps, startedAt };
			// A blocking verdict (gate phase OR a rejected approval) halts the flow.
			const ptype = phase.type ?? "agent";
			if (ps.gate?.verdict === "block" && (ptype === "gate" || ptype === "approval")) {
				gateBlocked = true;
				gateReason = ps.gate.reason ?? "";
				gateOutput = ps.output ?? "";
				gatePhaseId = phase.id;
			}
			// A fan-out cut short by the cap is itself a budget skip.
			if (ps.budgetTruncated) {
				budgetBlocked = true;
				if (!budgetReason) budgetReason = "fan-out truncated by budget";
			}
			// Budget ceiling: once exceeded, remaining phases are skipped.
			// For concurrent same-layer phases, the check runs after each phase
			// completes, so at most (concurrency - 1) extra phases may run before
			// the budget is detected as exceeded. This bounded overshoot is
			// acceptable: budgetBlocked prevents cascading into subsequent layers.
			const ob = overBudget(state);
			if (ob.over) {
				if (!budgetBlocked) {
					// First time we detect the ceiling after a phase completes.
					traceDecision(deps, state, phase.id, {
						type: "budget-hit",
						value: "budget",
						reason: ob.reason,
					});
					traceFlush(deps, phase.id);
				}
				budgetBlocked = true;
				budgetReason = ob.reason;
			}
			safeEmit(deps, state);
		});
		// The signal can flip while a layer is in flight. Checking only at the
		// beginning of the next layer lets an abort during the final layer fall
		// through to `completed` (notably when a non-cooperative race branch later
		// reports success). Cancellation is terminal for this invocation: preserve
		// the phase evidence gathered above, but classify the run as resumable.
		if (deps.signal?.aborted) {
			aborted = true;
			break;
		}
	}

	// A failed non-optional phase fails the run; optional failures are tolerated.
	const anyFailed = Object.entries(state.phases).some(
		([id, p]) => p.status === "failed" && !byId.get(id)?.optional && !p.optional,
	);

	state.status = aborted
		? "paused"
		: gateBlocked || budgetBlocked
			? "blocked"
			: anyFailed
				? "failed"
				: "completed";

	const { finalOutput, outputSourcePhaseId } = resolveFinalOutput(def.phases, state, {
		gate: gateBlocked,
		gateReason,
		gateOutput,
		gatePhaseId,
		budget: budgetBlocked,
		budgetReason,
	});
	// A terminal status and the result promised by status/wait are one durable
	// transaction. Publishing `completed` before these fields created a crash
	// window where a successful detached run permanently lost its final output.
	state.finalOutput = finalOutput;
	state.outputSourcePhaseId = outputSourcePhaseId;
	safeEmit(deps, state);

	const totalUsage = aggregateUsage(Object.values(state.phases).map((p) => p.usage ?? emptyUsage()));
	return {
		state,
		finalOutput,
		ok: state.status === "completed",
		totalUsage,
		reuse: summarizeReuse(state),
		outputSourcePhaseId,
	};
}
