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
import { coerceArray, evaluateCondition, interpolate, type InterpolationContext, safeParse, tryEvaluateCondition } from "./interpolate.ts";
import { isFailed, isTransientError, type LiveUpdate, mapWithConcurrencyLimit, runAgentTask, type RunResult } from "./runner.ts";
import { aggregateUsage, emptyUsage, type UsageStats } from "./usage.ts";
import { type Budget, type CacheScope, dependenciesOf, finalPhase, LOOP_DEFAULT_MAX_ITERATIONS, LOOP_HARD_MAX_ITERATIONS, MAX_DYNAMIC_MAP_ITEMS, MAX_DYNAMIC_NESTING, parseTtlMs, type Phase, resolveArgs, type Taskflow, topoLayers, TOURNAMENT_DEFAULT_VARIANTS, TOURNAMENT_HARD_MAX_VARIANTS, type TournamentMode, validateTaskflow } from "./schema.ts";
import { verifyTaskflow } from "./verify.ts";
import { hashInput, newRunId, type PhaseState, type RunState, runsDir } from "./store.ts";
import { CacheStore, resolveFingerprint } from "./cache.ts";
import { flowDefHash } from "./flowir/hash.ts";
import { computeStaleFrontier, readMapOf } from "./stale.ts";
import { ctxDirFor, drainPendingSpawns, initCtxDir, registerNode, setNodeStatus, type SpawnAssignment } from "./context-store.ts";
import { allocateWorkspace, isWorkspaceKeyword, type Workspace } from "./workspace.ts";

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
	signal?: AbortSignal;
	/** Persist run state after each phase (for resume). */
	persist?: (state: RunState) => void;
	/** Live progress callback for TUI streaming. */
	onProgress?: (state: RunState) => void;
	/** Injectable task runner (defaults to spawning a real subagent). Enables testing. */
	runTask?: typeof runAgentTask;
	/** Resolve an `approval` phase. Omit for non-interactive runs (auto-reject). */
	requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
	/** Resolve a saved taskflow by name for `flow` (sub-workflow) phases. */
	loadFlow?: (name: string) => Taskflow | undefined;
	/** Cross-run memoization store. Omit to construct a default one for `deps.cwd`. */
	cacheStore?: CacheStore;
	/** Default cache scope for phases that don't specify one. */
	cacheScopeDefault?: CacheScope;
	/** Internal: sub-flow call stack, for recursion detection. */
	_stack?: string[];
	/** Internal: pre-resolved Shared Context Tree dir for this run (sub-flows inherit the parent's). */
	_ctxDir?: string;
	/** Internal: an isolated workspace dir override for the current phase (worktree isolation). */
	_cwdOverride?: string;
}

export interface RuntimeResult {
	state: RunState;
	finalOutput: string;
	ok: boolean;
	totalUsage: UsageStats;
}

function buildInterpolationContext(
	state: RunState,
	previousOutput: string | undefined,
	locals?: Record<string, unknown>,
	onRead?: (ref: string) => void,
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
	return { args: state.args, steps, previousOutput, locals, onRead };
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
		error: failed ? r.errorMessage || r.stderr || r.output : undefined,
		inputHash,
		endedAt: Date.now(),
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
function clampSubFlowBudget(sub: Taskflow, parentBudget: Budget | undefined): Taskflow {
	if (!parentBudget) return sub;
	const child = sub.budget;
	const clamped: Budget = {
		maxUSD: Math.min(child?.maxUSD ?? Infinity, parentBudget.maxUSD ?? Infinity),
		maxTokens: Math.min(child?.maxTokens ?? Infinity, parentBudget.maxTokens ?? Infinity),
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
	const u = aggregateUsage(Object.values(state.phases).map((p) => p.usage ?? emptyUsage()));
	if (budget.maxUSD !== undefined && u.cost > budget.maxUSD) {
		return { over: true, reason: `cost $${u.cost.toFixed(3)} exceeded cap $${budget.maxUSD}` };
	}
	if (budget.maxTokens !== undefined && u.input + u.output > budget.maxTokens) {
		return { over: true, reason: `tokens ${u.input + u.output} exceeded cap ${budget.maxTokens}` };
	}
	return { over: false, reason: "" };
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
	const combinedText = ran
		.map((r, i) => {
			const label = `### [${i + 1}/${ran.length}] ${r.agent}${isFailed(r) ? " (failed)" : ""}`;
			const content = isFailed(r) ? (r.errorMessage || r.stderr || r.output) : r.output;
			return `${label}\n\n${content}`;
		})
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
			const abs = path.resolve(p);
			const stat = fs.statSync(abs);
			if (!stat.isFile()) continue;
			if (stat.size > CONTEXT_MAX_FILE_BYTES) continue;
			const content = fs.readFileSync(abs, "utf-8");
			const truncated =
				content.length > limit
					? content.slice(0, limit) + `\n... [truncated ${content.length - limit} chars]`
					: content;
			const ext = path.extname(p).slice(1) || "txt";
			blocks.push(`## File: ${p}\n\n\`\`\`${ext}\n${truncated}\n\`\`\``);
		} catch {
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
	return deps._cwdOverride ?? (isWorkspaceKeyword(phase.cwd) ? deps.cwd : phase.cwd ?? deps.cwd);
}

async function runInlineSubflow(
	subflowSpec: unknown,
	defaultAgent: string | undefined,
	childNodeId: string,
	phase: Phase,
	deps: RuntimeDeps,
	state: RunState,
): Promise<{ output: string; usage: UsageStats }> {
	const stack = deps._stack ?? [];
	const inlineDepth = stack.filter((s) => s.startsWith("def:")).length;
	if (inlineDepth >= MAX_DYNAMIC_NESTING) {
		return { output: `(spawned subflow rejected: nesting exceeded MAX_DYNAMIC_NESTING (${MAX_DYNAMIC_NESTING}))`, usage: emptyUsage() };
	}
	const wrapped = normalizeInlineDef(subflowSpec, childNodeId);
	if (!wrapped) return { output: "(spawned subflow is not a Taskflow / phases array)", usage: emptyUsage() };
	if (wrapped.phases.length === 0) return { output: "(spawned subflow had zero phases — no-op)", usage: emptyUsage() };
	// Inner phases without their own agent inherit the assignment's defaultAgent.
	if (defaultAgent) {
		for (const p of wrapped.phases as Phase[]) if (!p.agent) p.agent = defaultAgent;
	}
	const spawnCwd = resolveEffCwd(deps, phase);
	const dynCwd = spawnCwd;
	const v = validateTaskflow(wrapped, { dynamic: true, cwd: dynCwd });
	if (!v.ok) return { output: `(spawned subflow failed validation: ${v.errors.join("; ")})`, usage: emptyUsage() };
	const ver = verifyTaskflow({ name: wrapped.name, phases: wrapped.phases as Phase[], budget: wrapped.budget, concurrency: wrapped.concurrency });
	if (!ver.ok) {
		const errs = ver.issues.filter((i) => i.severity === "error").map((i) => i.message);
		return { output: `(spawned subflow failed verification: ${errs.join("; ")})`, usage: emptyUsage() };
	}
	const subDef = clampSubFlowBudget(wrapped, state.def.budget);
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
		return { output: subResult.finalOutput ?? "", usage };
	} catch (e) {
		return { output: `(spawned subflow failed: ${e instanceof Error ? e.message : String(e)})`, usage: emptyUsage() };
	}
}

async function runSpawnedChildren(
	assignments: SpawnAssignment[],
	ctxDir: string,
	parentNodeId: string,
	phase: Phase,
	deps: RuntimeDeps,
	state: RunState,
	run: typeof runAgentTask,
): Promise<SpawnedResult> {
	const capped = assignments.slice(0, MAX_DYNAMIC_MAP_ITEMS);
	const lines: string[] = [];
	const usages: UsageStats[] = [];
	// Effective cwd for flat spawned tasks: honour a workspace override and never
	// pass a reserved keyword through to the runner.
	const spawnCwd = resolveEffCwd(deps, phase);
	let idx = 0;
	for (const a of capped) {
		if (deps.signal?.aborted || overBudget(state).over) break;
		idx++;
		const childNodeId = `${parentNodeId}--c${idx}`.replace(/[^A-Za-z0-9._-]+/g, "_");
		const isSubflow = a.subflow !== undefined && a.subflow !== null;
		const agentName = isSubflow ? "(subflow)" : resolveAgent(a.agent ?? phase.agent, deps, state);
		registerNode(ctxDir, childNodeId, `${phase.id}:spawn`, parentNodeId, "running");
		let out = "";
		try {
			if (isSubflow) {
				const sub = await runInlineSubflow(a.subflow, a.defaultAgent ?? phase.agent, childNodeId, phase, deps, state);
				out = sub.output;
				usages.push(sub.usage);
				setNodeStatus(ctxDir, childNodeId, "done");
			} else {
				const r = await run(
					spawnCwd,
					deps.agents,
					agentName,
					a.task ?? "",
					{ model: phase.model, thinking: phase.thinking, tools: phase.tools, cwd: spawnCwd, signal: deps.signal, ctxDir, nodeId: childNodeId },
					deps.globalThinking,
				);
				out = r.output ?? "";
				if (r.usage) usages.push(r.usage);
				setNodeStatus(ctxDir, childNodeId, isFailed(r) ? "failed" : "done");
				// A child may itself have queued spawns — recurse (depth-capped by the tool).
				const grand = drainPendingSpawns(ctxDir, childNodeId);
				if (grand.length > 0 && !deps.signal?.aborted && !overBudget(state).over) {
					const rec = await runSpawnedChildren(grand, ctxDir, childNodeId, phase, deps, state, run);
					if (rec.reports) out += rec.reports;
					usages.push(rec.usage);
				}
			}
		} catch (e) {
			setNodeStatus(ctxDir, childNodeId, "failed");
			out = `(spawned child failed: ${e instanceof Error ? e.message : String(e)})`;
		}
		lines.push(`### spawned child ${idx} (${agentName})\n${out}`);
	}
	const usage = aggregateUsage(usages);
	if (lines.length === 0) return { reports: undefined, usage };
	return { reports: `\n\n<!-- ctx_spawn: ${lines.length} child report(s) -->\n${lines.join("\n\n")}`, usage };
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
	// Non-keyword cwd (or none): no workspace lifecycle — run directly.
	if (!isWorkspaceKeyword(phase.cwd)) {
		return executePhaseInner(phase, state, deps, prior, emitProgress, _retryDepth, opts);
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
	const innerDeps: RuntimeDeps = ws ? { ...deps, _cwdOverride: ws.dir } : deps;
	try {
		const ps = await executePhaseInner(phase, state, innerDeps, prior, emitProgress, _retryDepth, opts);
		if (ws && (ws.kind !== "inherited" || ws.note)) {
			const tag = ws.kind === "inherited" ? "workspace" : `workspace:${ws.kind}`;
			const msg = ws.note ? `${tag} — ${ws.note}` : `${tag} at ${ws.dir}`;
			ps.warnings = [...(ps.warnings ?? []), msg];
		}
		return ps;
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
	const previousOutput = lastCompletedOutput(state, phase);
	const run = deps.runTask ?? runAgentTask;
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
	const readRefs: string[] = [];
	const onRead = (ref: string): void => {
		readRefs.push(ref);
	};
	const ctx = buildInterpolationContext(state, previousOutput, undefined, onRead);
	const preRead = await resolvePhaseContext(phase, ctx);

	// Resolve this phase's cache policy once. Default scope is "run-only" (the
	// historical within-run resume behavior). Only "cross-run" phases resolve a
	// fingerprint and consult the persistent store. If flowDefHash failed we
	// force run-only: using a degraded flowName-only key would reopen the
	// cross-flow collision hole.
	let cacheScope: CacheScope = (phase.cache?.scope ?? deps.cacheScopeDefault ?? "run-only") as CacheScope;
	if (state.flowDefHash === "failed" && cacheScope === "cross-run") {
		cacheScope = "run-only";
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
		forceRerun: opts?.forceRerun,
		thinking: phase.thinking,
		tools: phase.tools,
		preRead,
	};

	const baseRun = (agentName: string, task: string, onLive?: (l: LiveUpdate) => void, ctxNodeId?: string) =>
		run(
			effCwd,
			deps.agents,
			agentName,
			task,
			{
				model: phase.model,
				thinking: phase.thinking,
				tools: phase.tools,
				cwd: effCwd,
				signal: deps.signal,
				onLive,
				ctxDir: ctxDir,
				nodeId: ctxDir ? ctxNodeId : undefined,
			},
			deps.globalThinking,
		);

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
	const runOne = async (agentName: string, task: string, onLive?: (l: LiveUpdate) => void, ctxNodeId?: string): Promise<RunResult> => {
		const explicitMax = Math.max(1, 1 + Math.max(0, Math.floor(retry?.max ?? 0)));
		// Allow enough attempts to cover whichever policy applies on a given attempt.
		const maxAttempts = Math.max(explicitMax, 1 + DEFAULT_TRANSIENT_RETRIES);
		const usages: UsageStats[] = [];
		let last: RunResult | undefined;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (deps.signal?.aborted) break;
			last = await baseRun(agentName, task, onLive, ctxNodeId);
			usages.push(last.usage);
			// B6: aggregate and surface cumulative usage before the retry decision,
			// so the TUI / budget guard see the in-flight spend on every attempt.
			const liveRetry = state.phases[phase.id];
			if (liveRetry) liveRetry.usage = aggregateUsage(usages);
			if (!isFailed(last)) break;
			// Stop retrying on abort or once the run is over budget.
			if (deps.signal?.aborted || overBudget(state).over) break;
			// Decide whether THIS failure warrants another attempt. Explicit retry
			// policy covers all failures up to its cap; the transient fallback covers
			// only retryable provider errors. A non-transient failure with no explicit
			// policy stops immediately (no point burning attempts on a hard error).
			const withinExplicit = attempt < explicitMax - 1;
			const transient = isTransientError(last);
			const withinTransient = transient && attempt < DEFAULT_TRANSIENT_RETRIES;
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
			if (wait > 0) await delay(wait, deps.signal);
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
		if (usages.length > 1) last.usage = aggregateUsage(usages);
		last.attempts = usages.length;
		return last;
	};

	const parseJson = phase.output === "json";

	// Runs a list of sub-tasks with live fan-out progress + aggregate live usage/activity.
	const runFanout = async (items: Array<{ agent: string; task: string }>): Promise<RunResult[]> => {
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
		return mapWithConcurrencyLimit(items, concurrency, async (it, idx) => {
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
			}, ctxDir ? nodeIdFor(String(idx)) : undefined);
			running--;
			done++;
			if (isFailed(r)) failed++;
			liveUsages[idx] = r.usage;
			if (ctxDir) {
				try {
					const itemNid = nodeIdFor(String(idx));
					setNodeStatus(ctxDir, itemNid, isFailed(r) ? "failed" : "done");
					// A fan-out item may itself ctx_spawn children. Without this drain a
					// map/parallel item's spawn intents are silently orphaned (the
					// post-run drain below only covers single-agent phases).
					const spawned = drainPendingSpawns(ctxDir, itemNid);
					if (spawned.length > 0 && !deps.signal?.aborted && !overBudget(state).over) {
						const child = await runSpawnedChildren(spawned, ctxDir, itemNid, phase, deps, state, run);
						if (child.reports) r.output = `${r.output ?? ""}${child.reports}`;
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
	if (type === "agent" || type === "gate" || type === "reduce") {
		// Eval gate: zero-token machine checks before the LLM gate.
		if (type === "gate" && Array.isArray(phase.eval) && phase.eval.length > 0) {
			const evalCtx = buildInterpolationContext(state, previousOutput);
			let allPassed = true;
			for (const check of phase.eval) {
				let expr = check;
				// Pre-process `contains` expressions: "{steps.x.output} contains PASS"
				// Convert to: interpolate LHS, check RHS substring inclusion.
				const containsIdx = expr.indexOf(" contains ");
				if (containsIdx > 0) {
					const lhs = expr.slice(0, containsIdx).trim();
					const rhs = expr.slice(containsIdx + " contains ".length).trim();
					const lhsVal = interpolate(lhs, evalCtx);
					const lhsStr = lhsVal.text;
					if (!lhsStr.includes(rhs)) {
						allPassed = false;
						break;
					}
					continue;
				}
				if (!evaluateCondition(expr, evalCtx)) {
					allPassed = false;
					break;
				}
			}
			if (allPassed) {
				// All evals passed — skip the LLM gate, return an auto-pass.
				const inputHash = cacheKey(cc, [phase.id, "eval-skip"]);
				const ps: PhaseState = {
					id: phase.id,
					status: "done",
					output: "PASS (eval checks passed — no LLM call)",
					gate: { verdict: "pass" },
					usage: emptyUsage(),
					inputHash,
					endedAt: Date.now(),
				};
				recordCache(cc, ps);
				return ps;
			}
		}
		const interp = interpolate(phase.task ?? "", ctx);
		const text = interp.text;
		const refWarning = warnUnresolvedRefs(phase.id, interp.missing);
		const fullTask = preRead + text;
		const agentName = resolveAgent(phase.agent, deps, state);
		const inputHash = cacheKey(cc, [phase.id, agentName, phase.model ?? "", fullTask]);
		const cached = cachedPhase(cc, inputHash);
		if (cached) return cached;

		const r = await runOne(agentName, fullTask, liveSink(state, phase.id, emitProgress), nodeIdFor());
		const ps = resultToPhaseState(phase.id, r, inputHash, parseJson);
		if (readRefs.length) ps.reads = readRefsToReads(readRefs, state);
		if (refWarning) ps.warnings = [...(ps.warnings ?? []), refWarning];
		if (type === "gate" && ps.status === "done") ps.gate = parseGateVerdict(r.output);

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
					const child = await runSpawnedChildren(spawned, ctxDir, nid, phase, deps, state, run);
					if (child.reports) ps.output = `${ps.output ?? ""}${child.reports}`;
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
					const { _cwdOverride: _dropGateWs, ...depsForUpstream } = deps;
					for (const depId of phase.dependsOn ?? []) {
						const d = state.def.phases.find((p) => p.id === depId);
						if (!d) continue;
						const dPs = await executePhase(d, state, depsForUpstream, prior, emitProgress, _retryDepth + 1, undefined);
						state.phases[depId] = dPs;
					}
				}
				const retryCtx = buildInterpolationContext(state, lastCompletedOutput(state, phase));
				const retryText = interpolate(phase.task ?? "", retryCtx).text;
				const retryTask = preRead + retryText;
				const retryIH = cacheKey(cc, [phase.id, agentName, phase.model ?? "", retryTask]);
				const retryR = await runOne(agentName, retryTask, liveSink(state, phase.id, emitProgress));
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

	if (type === "parallel") {
		const branches = (phase.branches ?? []).map((b) => {
			const r = interpolate(b.task, ctx);
			return {
				agent: resolveAgent(b.agent ?? phase.agent, deps, state),
				task: preRead + r.text,
			};
		});
		const inputHash = cacheKey(cc, [phase.id, phase.model ?? "", JSON.stringify(branches)]);
		const cached = cachedPhase(cc, inputHash);
		if (cached) return cached;

		const results = await runFanout(branches);
		const ps = mergePhaseState(phase.id, results, inputHash, parseJson);
		if (readRefs.length) ps.reads = readRefsToReads(readRefs, state);
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
		const inputHash = cacheKey(cc, [phase.id, phase.model ?? "", JSON.stringify(tasks)]);
		const cached = cachedPhase(cc, inputHash);
		if (cached) return cached;

		const results = await runFanout(tasks);
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

	if (type === "approval") {
		const readRefs: string[] = [];
		const ctx = buildInterpolationContext(state, previousOutput, undefined, (ref) => readRefs.push(ref));
		const message = interpolate(phase.task ?? "Approve to continue?", ctx).text;
		const inputHash = cacheKey(cc, [phase.id, phase.model ?? "", "approval", message]);
		const cached = cachedPhase(cc, inputHash);
		if (cached) return cached;

		// Non-interactive (headless/CI/detached): auto-REJECT, fail-open, but record it.
		// Approval gates are safety boundaries — bypassing them silently in CI would
		// let unreviewed work ship. Detached/CI runs must not bypass approval gates.
		if (!deps.requestApproval) {
			return {
				id: phase.id,
				status: "done",
				output: "(auto-rejected: no interactive approver available)",
				approval: { decision: "reject", auto: true },
				gate: { verdict: "block", reason: "(auto-rejected: no interactive approver available)" },
				usage: emptyUsage(),
				inputHash,
				reads: readRefsToReads(readRefs, state),
				endedAt: Date.now(),
			};
		}
		const decision = await deps.requestApproval({ phaseId: phase.id, message, upstream: previousOutput });
		const note = decision.note?.trim();
		const ps: PhaseState = {
			id: phase.id,
			status: "done",
			output: note || `(${decision.decision})`,
			approval: { decision: decision.decision, note },
			usage: emptyUsage(),
			inputHash,
			reads: readRefsToReads(readRefs, state),
			endedAt: Date.now(),
		};
		// A rejection halts the flow via the same mechanism as a blocking gate.
		if (decision.decision === "reject") {
			ps.gate = { verdict: "block", reason: note || "Rejected by user" };
		}
		return ps;
	}

	if (type === "flow") {
		const readRefs: string[] = [];
		const ctx = buildInterpolationContext(state, previousOutput, undefined, (ref) => readRefs.push(ref));
		const hasDef = (phase as { def?: unknown }).def !== undefined;
		const stack = deps._stack ?? [];

		let subDef: Taskflow | undefined;
		let name: string;
		let recursionKey: string; // identity used for cache key + recursion guard

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
			const wrapped = normalizeInlineDef(parsed, phase.id);
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
					inputHash: hashInput(phase.id, "flow-def-empty"),
					reads: readRefsToReads(readRefs, state),
					endedAt: Date.now(),
				};
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
			const ver = verifyTaskflow({ name: wrapped.name, phases: wrapped.phases as Phase[], budget: wrapped.budget, concurrency: wrapped.concurrency });
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
			provided[k] = typeof v === "string" ? interpolate(v, ctx).text : v;
		}
		const subArgs = resolveArgs(subDef, provided);
		// For inline defs the cache identity must include the resolved def content so
		// that a different generated plan yields a different key (and an identical plan
		// hits cache). For saved flows the name is the identity (historical behavior).
		const flowIdentity = hasDef ? `def:${JSON.stringify(subDef)}` : `flow:${name}`;
		const inputHash = cacheKey(cc, [phase.id, flowIdentity, preRead, JSON.stringify(subArgs)]);
		const cached = cachedPhase(cc, inputHash);
		if (cached) return cached;

		const live = state.phases[phase.id];
		// Sub-flows enforce their own budget; if they declare none, inherit the
		// parent cap as a soft per-flow ceiling (best-effort — spend does not cross
		// flow boundaries, so the parent's already-spent total is not subtracted).
		const subDefEffective = subDef.budget || !state.def.budget ? subDef : { ...subDef, budget: state.def.budget };
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
		const baseRunTask = deps.runTask ?? runAgentTask;
		const subRunTask: typeof runAgentTask = (cwd, agents, agentName, subTask, opts, globalThinking) =>
			baseRunTask(cwd, agents, agentName, preRead + subTask, opts, globalThinking);
		const subResult = await executeTaskflow(subState, {
			...deps,
			// Override deps.cwd with the flow phase's own cwd so that sub-flow
			// phases without an explicit cwd derive their subagents from the
			// flow's cwd (not the caller's cwd).
			cwd: effCwd,
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
		const flowPs: PhaseState = {
			id: phase.id,
			status: subResult.ok ? "done" : "failed",
			output: subResult.finalOutput,
			json: parseJson ? safeParse(subResult.finalOutput) : undefined,
			usage: subResult.totalUsage,
			// B-F015: include failed in `done` so the renderer's
			// `done - failed` formula gives the success count (matches the
			// map/parallel runner's overlapping-counter convention).
			subProgress: {
				done: sp.filter((p) => p.status === "done" || p.status === "failed").length,
				total: subDef.phases.length,
				running: 0,
				failed: sp.filter((p) => p.status === "failed").length,
			},
			error: subResult.ok ? undefined : `sub-flow '${name}' ${subResult.state.status}`,
			inputHash,
			reads: readRefsToReads(readRefs, state),
			endedAt: Date.now(),
		};
		recordCache(cc, flowPs);
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

		// Canonical first-iteration body for the cache key. It must fold in the
		// interpolated task/upstream refs so that a changed upstream changes the
		// key and recompute no longer silently reuses a stale loop (critic finding).
		const firstBodyCtx = buildInterpolationContext(state, previousOutput, {
			loop: { iteration: 1, lastOutput: "", maxIterations: maxIters },
		}, (ref) => readRefs.push(ref));
		const firstBody = preRead + interpolate(phase.task ?? "", firstBodyCtx).text;
		const inputHash = hashInput(phase.id, "loop", phase.until ?? "", firstBody, String(maxIters));

		const usages: UsageStats[] = [];
		const loopWarnings: string[] = [];
		let lastOutput = "";
		let prevOutput: string | undefined;
		let iterations = 0;
		let stop: NonNullable<PhaseState["loop"]>["stop"] = "maxIterations";
		let failedResult: RunResult | undefined;

		for (let i = 1; i <= maxIters; i++) {
			if (deps.signal?.aborted) {
				stop = "aborted";
				break;
			}
			iterations = i;
			// The body sees its iteration number and the prior iteration's output.
			const bodyCtx = buildInterpolationContext(state, previousOutput, {
				loop: { iteration: i, lastOutput, maxIterations: maxIters },
			}, (ref) => readRefs.push(ref));
			const body = preRead + interpolate(phase.task ?? "", bodyCtx).text;
			const r = await runOne(agentName, body, liveSink(state, phase.id, emitProgress));
			usages.push(r.usage);
			if (isFailed(r)) {
				failedResult = r;
				stop = "failed";
				break;
			}
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
		}

		const aggUsage = usages.length ? aggregateUsage(usages) : emptyUsage();
		if (failedResult || stop === "failed" || stop === "aborted") {
			return {
				id: phase.id,
				status: "failed",
				output: lastOutput || undefined,
				usage: aggUsage,
				error: failedResult?.errorMessage || failedResult?.stderr || (stop === "aborted" ? "Aborted" : `loop '${phase.id}' iteration ${iterations} failed`),
				loop: { iterations, stop },
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
			loop: { iterations, stop },
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
				budgetTruncated: budgetSkipCount > 0 || undefined,
				tournament: { variants: competitors.length, winner: 0, mode },
				inputHash,
				reads: readRefsToReads(readRefs, state),
				endedAt: Date.now(),
			};
		}
		// Only one competitor survived → no contest; it wins by default (skip judge).
		if (ok.length === 1) {
			return {
				id: phase.id,
				status: "done",
				output: ok[0].output,
				json: parseJson ? safeParse(ok[0].output) : undefined,
				usage: variantUsage,
				model: ok[0].model,
				budgetTruncated: budgetSkipCount > 0 || undefined,
				tournament: { variants: competitors.length, winner: ranIdx(ok[0]), mode, reason: "only surviving variant" },
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
function directRef(over: string, state: RunState): unknown {
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

/**
 * Per-phase cache policy resolved once at the top of executePhase. Carries the
 * scope, optional TTL, and a pre-resolved fingerprint string so each phase-type
 * branch can fold it into its inputHash and consult the cross-run store uniformly.
 */
interface PhaseCacheCtx {
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
	/** Content fingerprint of the desugared flow definition — folded into the
	 *  key so two structurally-different flows that share a name can never
	 *  collide, and a changed flow never serves a stale cross-run hit. */
	flowDefHash?: string | "failed";
	/** Force this phase to re-execute, ignoring the within-run prior AND the
	 *  cross-run store (M5 recompute seed). Downstream phases are NOT forced —
	 *  they re-evaluate naturally: if the seed's new output changed their
	 *  inputHash they miss and re-run, otherwise they hit (early cutoff). */
	forceRerun?: boolean;
}

/** Fold the phase fingerprint into the base hash parts to form the final cache key. */
function cacheKey(cc: PhaseCacheCtx, baseParts: string[]): string {
	// Fold the full cache identity into the hash: flow name (prevents collisions
	// across different flows that share a phase.id + task + model), the per-phase
	// thinking/tools config (changing either changes the subagent's output), the
	// resolved context pre-read content, and the world-state fingerprint.
	const parts = [
		`flow:${cc.flowName}`,
		`flowdef:${cc.flowDefHash ?? ""}`,
		...baseParts,
		`think:${cc.thinking ?? ""}`,
		`tools:${JSON.stringify(cc.tools ?? [])}`,
		`ctx:${cc.preRead ?? ""}`,
	];
	return cc.fingerprint ? hashInput(...parts, cc.fingerprint) : hashInput(...parts);
}

/**
 * Resume/memoization lookup. Honors scope:
 *   - "off":      never reuse (even within-run).
 *   - "run-only": within-run resume only (historical behavior).
 *   - "cross-run": within-run first, then the persistent cross-run store.
 * On a cross-run hit, usage is zeroed and `cacheHit` records the source.
 */
function cachedPhase(cc: PhaseCacheCtx, inputHash: string): PhaseState | null {
	if (cc.scope === "off") return null;
	if (cc.forceRerun) return null;

	// 1. within-run resume (fastest; always allowed unless scope is off)
	if (cc.prior && cc.prior.status === "done" && cc.prior.inputHash === inputHash) {
		return { ...cc.prior, status: "done" };
	}

	// 2. cross-run memoization (opt-in)
	if (cc.scope === "cross-run") {
		const e = cc.store.get(inputHash, cc.ttlMs);
		if (e) {
			return {
				id: cc.phaseId,
				status: "done",
				inputHash,
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
 * Parse a gate phase's output into a verdict. Blocks the flow only on an
 * explicit negative signal; ambiguous output passes (fail-open).
 * Accepts JSON ({continue|pass: bool} or {verdict: "..."}) or a text marker
 * `VERDICT: PASS|BLOCK|FAIL|STOP|OK|REJECT|HALT` (last occurrence wins).
 */
export function parseGateVerdict(output: string): { verdict: "pass" | "block"; reason?: string } {
	const json = safeParse(output);
	if (json && typeof json === "object") {
		const o = json as Record<string, unknown>;
		if (typeof o.continue === "boolean") return { verdict: o.continue ? "pass" : "block", reason: asReason(o.reason) };
		if (typeof o.pass === "boolean") return { verdict: o.pass ? "pass" : "block", reason: asReason(o.reason) };
		if (typeof o.verdict === "string") {
			// Note: do NOT include standalone "no" — natural-language verdicts like
			// "No issues found" / "no errors" would otherwise be false-positive BLOCK.
			// Fail-open covers any ambiguous text.
			const block = /block|fail|stop|reject|halt/i.test(o.verdict);
			return { verdict: block ? "block" : "pass", reason: asReason(o.reason) };
		}
	}
	const matches = [...output.matchAll(/VERDICT\s*[:=]\s*(PASS|BLOCK|FAIL|STOP|OK|REJECT|HALT)/gi)];
	if (matches.length) {
		const v = matches[matches.length - 1][1].toUpperCase();
		const pass = v === "PASS" || v === "OK";
		return { verdict: pass ? "pass" : "block" };
	}
	return { verdict: "pass" };
}

function asReason(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Parse a judge's pick of the winning variant. Accepts JSON ({"winner":n} or
 * {"best":n}) or a `WINNER: n` line (last match wins). Clamps to [1, count].
 * Fail-open: an unreadable verdict defaults to variant 1 so the work is never
 * lost. Returns the 1-based index plus an optional reason.
 */
export function parseTournamentWinner(output: string, count: number): { winner: number; reason?: string } {
	const clamp = (n: number) => Math.min(Math.max(1, Math.floor(n)), Math.max(1, count));
	const json = safeParse(output);
	if (json && typeof json === "object") {
		const o = json as Record<string, unknown>;
		const raw = o.winner ?? o.best ?? o.choice;
		const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
		if (Number.isFinite(n)) return { winner: clamp(n), reason: asReason(o.reason) };
	}
	const matches = [...output.matchAll(/WINNER\s*[:=]\s*#?\s*(\d+)/gi)];
	if (matches.length) {
		const n = Number(matches[matches.length - 1][1]);
		if (Number.isFinite(n)) return { winner: clamp(n) };
	}
	return { winner: 1, reason: "no parseable winner; defaulted to variant 1" };
}

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
}

/** Recompute a completed run minimally: force-rerun the `seeds`, then walk
 *  their stale frontier in topological order. The cache provides early cutoff
 *  for free — a downstream whose inputHash didn't move (because the seed's new
 *  output happened to equal the old) hits its prior and is reused rather than
 *  re-executed. `dryRun` computes the worst-case frontier without spending a
 *  token. Returns the (possibly updated) state + a report. Never throws into
 *  the caller — a failing phase is recorded as re-run-but-failed. */
export async function recomputeTaskflow(
	state: RunState,
	deps: RuntimeDeps,
	seeds: readonly string[],
	opts: { dryRun?: boolean } = {},
): Promise<{ report: RecomputeReport; state: RunState }> {
	const reads = readMapOf(state.phases);
	const frontier = computeStaleFrontier(reads, seeds);
	const allIds = Object.keys(state.phases);

	if (opts.dryRun) {
		return {
			report: {
				dryRun: true,
				aborted: false,
				seeds,
				rerun: [...frontier],
				reused: allIds.filter((id) => !frontier.has(id)),
				cutoff: [],
			},
			state,
		};
	}

	// Real recompute: topological order over the frontier so a downstream always
	// sees its (already-refreshed) upstreams when it re-evaluates its cache key.
	const seedSet = new Set(seeds);
	const order = topoLayers(state.def.phases)
		.flat()
		.map((p) => p.id)
		.filter((id) => frontier.has(id));
	const rerun: string[] = [];
	const cutoff: string[] = [];
	const noop = () => {};
	let aborted = false;
	for (const id of order) {
		// H2: honor abort. A partial recompute must NOT be persisted over the
		// original run — the caller discards `state` when `aborted` is set.
		if (deps.signal?.aborted) {
			aborted = true;
			break;
		}
		const phase = state.def.phases.find((p) => p.id === id);
		if (!phase) continue;
		const before = state.phases[id]?.inputHash;
		const execOpts = seedSet.has(id) ? { forceRerun: true } : undefined;
		try {
			const ps = await executePhase(phase, state, deps, state.phases[id], noop, 0, execOpts);
			state.phases[id] = ps;
			// A phase counts as "rerun" if it was a forced seed OR its result moved;
			// otherwise it hit its cache (inputHash unchanged) → early cutoff.
			if (seedSet.has(id) || ps.inputHash !== before) rerun.push(id);
			else cutoff.push(id);
		} catch {
			// A failing recompute phase is recorded as rerun (it was attempted).
			rerun.push(id);
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
		},
		state,
	};
}

export async function executeTaskflow(state: RunState, deps: RuntimeDeps): Promise<RuntimeResult> {
	const def: Taskflow = state.def;
	try {
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
		safeEmit(deps, state);
		const totalUsage = aggregateUsage(Object.values(state.phases).map((p) => p.usage ?? emptyUsage()));
		return { state, finalOutput: `Taskflow '${def.name}' crashed: ${message}`, ok: false, totalUsage };
	}
}

async function runTaskflowLayers(state: RunState, deps: RuntimeDeps): Promise<RuntimeResult> {
	const def: Taskflow = state.def;
	const layers = topoLayers(def.phases);
	// Content-fingerprint the desugared definition ONCE per run and fold it into
	// every phase's cache key (overstory hash algorithm; see ./flowir/hash.ts).
	// Reused by every phase, persisted on the RunState for audit/resume.
	// Never throws into the run — a hash failure leaves the field unset and the
	// cache key degrades to the legacy flowName-only shape.
	if (state.flowDefHash === undefined) {
		try {
			state.flowDefHash = await flowDefHash(def);
		} catch (e) {
			// Fail-safe: warn loudly rather than silently degrading to the legacy
			// flowName-only key, which would reopen the cross-flow collision hole.
			console.warn(
				`[taskflow] flowDefHash failed for '${def.name}': ${e instanceof Error ? e.message : String(e)}. ` +
				"Cross-run cache is disabled for this run to prevent stale cross-flow hits.",
			);
			state.flowDefHash = "failed";
		}
	}

	state.status = "running";
	safeEmit(deps, state);

	let aborted = false;
	let gateBlocked = false;
	let gateReason = "";
	let gateOutput = "";
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
		const layerConcurrency = Math.max(1, def.concurrency ?? 8);
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
			else if (phase.when !== undefined) {
				const condCtx = buildInterpolationContext(state, lastCompletedOutput(state, phase));
				if (!evaluateCondition(phase.when, condCtx)) skipReason = `Condition not met: ${phase.when}`;
			}

			if (skipReason) {
				if (skipReason.startsWith("Budget exceeded")) budgetBlocked = true;
				state.phases[phase.id] = {
					id: phase.id,
					status: "skipped",
					error: skipReason,
					endedAt: Date.now(),
					usage: emptyUsage(),
				};
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
				budgetBlocked = true;
				budgetReason = ob.reason;
			}
			safeEmit(deps, state);
		});
	}

	const fp = finalPhase(def.phases);
	let finalState = state.phases[fp.id];
	// If the designated final phase produced no output (skipped/blocked), fall
	// back to the last phase (in definition order) that actually completed.
	if (!finalState || finalState.status !== "done") {
		const doneInOrder = def.phases.map((p) => state.phases[p.id]).filter((p) => p?.status === "done");
		if (doneInOrder.length) finalState = doneInOrder[doneInOrder.length - 1];
	}
	// A failed non-optional phase fails the run; optional failures are tolerated.
	const anyFailed = Object.entries(state.phases).some(
		([id, p]) => p.status === "failed" && !byId.get(id)?.optional,
	);

	state.status = aborted
		? "paused"
		: gateBlocked || budgetBlocked
			? "blocked"
			: anyFailed
				? "failed"
				: "completed";
	safeEmit(deps, state);

	let finalOutput = finalState?.output ?? "(no output)";
	if (gateBlocked) {
		finalOutput = `Gate blocked the workflow.${gateReason ? `\nReason: ${gateReason}` : ""}${gateOutput ? `\n\n${gateOutput}` : ""}`;
	} else if (budgetBlocked) {
		finalOutput = `Budget exceeded — run halted.${budgetReason ? `\nReason: ${budgetReason}` : ""}${finalState?.output ? `\n\n${finalState.output}` : ""}`;
	}

	const totalUsage = aggregateUsage(Object.values(state.phases).map((p) => p.usage ?? emptyUsage()));
	return {
		state,
		finalOutput,
		ok: state.status === "completed",
		totalUsage,
	};
}
