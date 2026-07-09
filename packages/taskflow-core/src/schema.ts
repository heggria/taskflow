/**
 * Taskflow DSL — schema, types, and validation.
 *
 * A taskflow is a declarative, multi-phase workflow. Each phase delegates work
 * to a subagent (an isolated `pi` process). Phases form a DAG via `dependsOn`.
 */

import * as path from "node:path";
import { StringEnum } from "./typebox-helpers.ts";
import { contractShapeErrors } from "./contract.ts";
import { scorerShapeErrors } from "./scorers.ts";
import { Type, type Static } from "typebox";
import { WORKSPACE_KEYWORDS } from "./workspace.ts";

// ---------------------------------------------------------------------------
// Phase types
// ---------------------------------------------------------------------------

/** Closed set of native phase kinds — single source of truth for DSL + FlowIR. */
export const PHASE_TYPES = [
	"agent",
	"parallel",
	"map",
	"gate",
	"reduce",
	"approval",
	"flow",
	"loop",
	"tournament",
	"script",
	/** First completed branch wins (Horizon B). */
	"race",
	/** Dynamic sub-DAG: nested sub-flow or graft-promote into parent (Horizon B). */
	"expand",
] as const;
export type PhaseType = (typeof PHASE_TYPES)[number];

/** Loop iteration bounds. Authors may lower the max; the hard cap is a runaway guard. */
export const LOOP_DEFAULT_MAX_ITERATIONS = 10;
export const LOOP_HARD_MAX_ITERATIONS = 100;

/** Max depth of runtime `flow { def }` sub-flow nesting (runaway guard for
 *  LLM-generated sub-flows that themselves spawn more sub-flows). The existing
 *  `_stack` recursion check guards saved-flow cycles; this bounds inline depth. */
export const MAX_DYNAMIC_NESTING = 5;

/** Breadth caps applied ONLY to runtime-generated (`flow { def }`) sub-flows,
 *  whose content is LLM-authored and therefore untrusted. Authored/saved flows
 *  are not subject to these (a human reviewed them). They bound DoS blast radius
 *  from a model emitting a graph with thousands of phases / a giant fan-out. */
export const MAX_DYNAMIC_PHASES = 100;
export const MAX_DYNAMIC_MAP_ITEMS = 200;
export const MAX_DYNAMIC_CONCURRENCY = 16;

/** Tournament competitor bounds. */
export const TOURNAMENT_DEFAULT_VARIANTS = 3;
export const TOURNAMENT_HARD_MAX_VARIANTS = 20;
const TOURNAMENT_MODES = ["best", "aggregate"] as const;
/** @internal */
export type TournamentMode = (typeof TOURNAMENT_MODES)[number];

const OUTPUT_FORMATS = ["text", "json"] as const;
const JOIN_MODES = ["all", "any"] as const;
const CACHE_SCOPES = ["run-only", "cross-run", "off"] as const;
export type CacheScope = (typeof CACHE_SCOPES)[number];
/** Allowed fingerprint entry prefixes. `glob!:` = content-hash variant of `glob:`. */
const CACHE_FINGERPRINT_PREFIXES = ["git:", "glob:", "glob!:", "file:", "env:"] as const;
/** Phase types that must NOT be cached across runs (a fresh result is required each run). */
const CACHE_CROSS_RUN_BLOCKED_TYPES = ["gate", "approval", "loop", "tournament", "script", "race", "expand"] as const;

const ParallelTaskSchema = Type.Object(
	{
		task: Type.String({ description: "Task for this parallel branch (supports interpolation)" }),
		agent: Type.Optional(Type.String({ description: "Override the phase agent for this branch" })),
	},
	{ additionalProperties: false },
);

/** Declarative retry policy for a phase's subagent call(s). */
const RetrySchema = Type.Object(
	{
		max: Type.Number({ description: "Max retry attempts after the first try (>= 0)" }),
		backoffMs: Type.Optional(Type.Number({ description: "Base delay between attempts, in ms", default: 0 })),
		factor: Type.Optional(
			Type.Number({ description: "Backoff multiplier per attempt (1 = fixed, 2 = exponential)", default: 1 }),
		),
	},
	{ additionalProperties: false },
);

/**
 * Per-phase cache policy. Defaults to `run-only` which is exactly the historical
 * behavior (within-run resume only). `cross-run` opts a phase into the persistent
 * cross-run memoization store; see docs/rfc-cross-run-memoization.md.
 */
const CacheSchema = Type.Object(
	{
		scope: Type.Optional(
			StringEnum(CACHE_SCOPES, {
				description:
					"Cache reuse scope. 'run-only' (default) = within-run resume only (historical behavior); 'cross-run' = reuse identical-input results from any prior run; 'off' = never reuse (even within-run).",
				default: "run-only",
			}),
		),
		ttl: Type.Optional(
			Type.String({
				description:
					"Max cache age before a cross-run hit is treated as a miss, e.g. '30m', '6h', '7d'. Omit for no time bound.",
			}),
		),
		fingerprint: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Extra freshness inputs folded into the cache key so 'the world changed' becomes a cache miss. Each entry: 'git:HEAD' | 'glob:<pattern>' | 'glob!:<pattern>' (content-hash) | 'file:<path>' | 'env:<NAME>'.",
			}),
		),
	},
	{ additionalProperties: false },
);

/** Run-wide cost / token ceiling. Exceeding it halts the run (remaining phases skipped). */
const BudgetSchema = Type.Object(
	{
		maxUSD: Type.Optional(Type.Number({ description: "Halt the run once accumulated cost exceeds this many USD" })),
		maxTokens: Type.Optional(
			Type.Number({ description: "Halt the run once accumulated input+output tokens exceed this" }),
		),
	},
	{ additionalProperties: false },
);

const PhaseSchema = Type.Object(
	{
		id: Type.String({ description: "Unique phase identifier (referenced via {steps.<id>.output})" }),
		type: Type.Optional(StringEnum(PHASE_TYPES, { description: "Phase kind", default: "agent" })),
		agent: Type.Optional(Type.String({ description: "Agent name to run this phase" })),
		task: Type.Optional(Type.String({ description: "Task prompt (supports interpolation placeholders)" })),

		// map fan-out
		over: Type.Optional(
			Type.String({ description: "[map] Interpolation ref resolving to an array to fan out over" }),
		),
		as: Type.Optional(Type.String({ description: "[map] Loop variable name (default: item)", default: "item" })),

		// parallel / race static branches
		branches: Type.Optional(
			Type.Array(ParallelTaskSchema, {
				description: "[parallel|race|tournament] Static task branches",
			}),
		),
		/**
		 * [race] When true (default), abort in-flight loser branches after the first branch
		 * **succeeds** (best-effort `AbortSignal`). Race semantics are first-**success**
		 * (failed settles do not win). Set `false` to let losers run to natural completion.
		 */
		cancelLosers: Type.Optional(Type.Boolean({ default: true })),

		// reduce
		from: Type.Optional(
			Type.Array(Type.String(), { description: "[reduce] Phase ids whose outputs are aggregated" }),
		),

		// sub-workflow (flow) + expand fragment
		use: Type.Optional(Type.String({ description: "[flow] Name of a saved taskflow to run as this phase" })),
		/** [expand] Fragment source — string interpolation or inline Taskflow / phases (same as flow.def). */
		// reuses `def` below for expand as well
		def: Type.Optional(
			Type.Unknown({
				description:
					"[flow|expand] Inline sub-flow / fragment definition, resolved at runtime. Mutually exclusive with 'use' on flow. A string is interpolated (e.g. '{steps.plan.json}') then JSON-parsed; an object is used directly. The result must be a Taskflow ({name,phases}) or a bare phases array / {phases:[...]} (auto-wrapped). Validated + verified before execution; on any failure the phase fails-open (defError) without aborting the run.",
			}),
		),
		/** [expand] nested (default) = isolated sub-flow; graft = run fragment then promote phase states onto the parent under prefixed ids. */
		expandMode: Type.Optional(
			StringEnum(["nested", "graft"] as const, {
				description: "[expand] nested (default) | graft (promote child phase states onto parent)",
				default: "nested",
			}),
		),
		/** [expand] Max nodes accepted from a dynamic fragment (default 50, hard 100). */
		maxNodes: Type.Optional(Type.Number({ default: 50 })),
		with: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description: "[flow] Args passed to the sub-flow (string values support interpolation)",
			}),
		),

		// script — zero-token shell command
		run: Type.Optional(
			Type.Union([Type.String(), Type.Array(Type.String())], {
				description:
					"[script] Shell command. String form is passed to shell (no interpolation — use array form or 'input' for dynamic values). Array form is execvp-style direct spawn (supports {steps.X}/{args.X} interpolation, safe from injection).",
			}),
		),
		input: Type.Optional(
			Type.String({
				description:
					"[script] Text piped to the command's stdin. Supports interpolation. If omitted, stdin is closed.",
			}),
		),
		timeout: Type.Optional(
			Type.Number({
				description:
					"Max execution time in milliseconds. For script phases: caps the shell command (default 60000, max 300000). For agent-running phases (agent/gate/reduce/map/parallel/loop/tournament): caps EACH subagent call — on expiry the subagent is aborted and the phase fails with a 'timedOut' marker (never retried). Not supported for approval/flow phases. Must be >= 1000.",
			}),
		),

		// loop-until-done
		until: Type.Optional(
			Type.String({
				description:
					"[loop] Stop condition evaluated after each iteration. The iteration's output is exposed as {steps.<thisId>.output}/.json. Supports the same operators as `when`. The loop stops when this is truthy, on convergence, or at maxIterations. A parse error stops the loop (fail-safe).",
			}),
		),
		maxIterations: Type.Optional(
			Type.Number({
				description: `[loop] Hard cap on iterations (default ${LOOP_DEFAULT_MAX_ITERATIONS}, max ${LOOP_HARD_MAX_ITERATIONS}). The loop always terminates within this bound even if 'until' never becomes truthy.`,
				default: LOOP_DEFAULT_MAX_ITERATIONS,
			}),
		),
		convergence: Type.Optional(
			Type.Boolean({
				description:
					"[loop] When true (default), stop early if an iteration's output is identical to the previous one (a fixed point — further iterations would not change anything).",
				default: true,
			}),
		),
		reflexion: Type.Optional(
			Type.Boolean({
				description:
					"[loop] When true, each iteration after the first receives a {reflexion} placeholder (auto-appended if the task lacks it) carrying a structured failure summary of the prior iteration — output snippet, expect-contract diagnostics, error, or the unmet 'until' condition. Body failures become feedback for the next iteration instead of terminating the loop (timeout/abort still hard-stop; if maxIterations exhausts with the last iteration failed, the phase fails). Default false — existing loops are unchanged.",
				default: false,
			}),
		),

		// tournament: N variants compete, a judge picks the best (or aggregates)
		variants: Type.Optional(
			Type.Number({
				description: `[tournament] Number of competing variants to spawn from 'task' (default ${TOURNAMENT_DEFAULT_VARIANTS}, max ${TOURNAMENT_HARD_MAX_VARIANTS}). Ignored when 'branches' is provided (those become the variants instead).`,
				default: TOURNAMENT_DEFAULT_VARIANTS,
			}),
		),
		judge: Type.Optional(
			Type.String({
				description:
					"[tournament] Judge prompt. The numbered variant outputs are injected before it. To pick a winner, end with a line like 'WINNER: <n>' or return JSON {\"winner\": <n>}. Defaults to a sensible built-in rubric.",
			}),
		),
		judgeAgent: Type.Optional(
			Type.String({ description: "[tournament] Agent that runs the judge step (defaults to the phase 'agent')." }),
		),
		mode: Type.Optional(
			StringEnum(TOURNAMENT_MODES, {
				description:
					"[tournament] 'best' (default): output is the winning variant verbatim. 'aggregate': output is the judge's synthesized answer combining the variants.",
				default: "best",
			}),
		),

		dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Phase ids this phase depends on" })),
		join: Type.Optional(
			StringEnum(JOIN_MODES, {
				description: "Dependency join: 'all' (default) waits for every dep; 'any' runs as soon as one dep completes",
				default: "all",
			}),
		),
		when: Type.Optional(
			Type.String({
				description:
					"Conditional guard: skip this phase unless the expression is truthy. Supports {refs} and == != < > <= >= && || ! ()",
			}),
		),
		retry: Type.Optional(RetrySchema),
		output: Type.Optional(StringEnum(OUTPUT_FORMATS, { description: "Parse output as text or json", default: "text" })),
		expect: Type.Optional(
			Type.Unknown({
				description:
					"Output contract for this phase's JSON output (requires output:'json'). A small JSON-Schema-like shape: {type, properties, required, items, enum}. Validated the moment the subagent finishes; a violation fails the phase with a precise diagnostic (eligible for the phase's explicit 'retry'). Valid for agent/gate/reduce/loop phases.",
			}),
		),
		model: Type.Optional(Type.String({ description: "Model override for this phase" })),
		thinking: Type.Optional(Type.String({ description: "Thinking level override for this phase" })),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Restrict tools for this phase's agent" })),
		cwd: Type.Optional(Type.String({ description: "Working directory for this phase's subagent. A literal path, or a reserved keyword: 'temp' (ephemeral dir, removed after the phase), 'dedicated' (persistent dir under the run state, kept), or 'worktree' (a git worktree on a throwaway branch, removed after the phase)." })),
		final: Type.Optional(Type.Boolean({ description: "Mark this phase's output as the workflow result" })),
		optional: Type.Optional(
			Type.Boolean({ description: "If true, a failure does not abort the run", default: false }),
		),
		idempotent: Type.Optional(
			Type.Boolean({
				description:
					"Marks whether this phase is safe to auto-retry and cache. Defaults to true (safe). Set to false for phases with irreversible side effects (webhook POSTs, deploys, DB writes): transient provider errors are NOT auto-retried, and the result is never served from or written to any cache (within-run resume or cross-run — including under a flow-level 'incremental'). Explicit 'retry{}' is still honored — it is the author's declaration that a repeat is acceptable. The phase state records sideEffect: true for audit.",
				default: true,
			}),
		),
		concurrency: Type.Optional(Type.Number({ description: "Override max concurrency for map/parallel" })),
		context: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"File paths or {steps.X} refs to pre-read and inject before the task. Resolves interpolated refs first, then reads each file (capped per-file). Eliminates O(N²) turn-cost exploration.",
			}),
		),
		contextLimit: Type.Optional(
			Type.Number({
				description: "Max characters to read per file referenced in context (default 8000).",
				default: 8000,
			}),
		),
		onBlock: Type.Optional(
			StringEnum(["halt", "retry"] as const, {
				description:
					"[gate] What to do when the gate blocks: 'halt' (default, stop the flow) or 'retry' (re-run upstream phases then re-evaluate the gate). Limited by 'retry.max'.",
				default: "halt",
			}),
		),
		eval: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"[gate] Zero-token machine checks that run BEFORE the LLM gate. If ALL pass, the gate is skipped (PASS). If ANY fail, the LLM gate runs as normal. Each entry is a condition expression like '{steps.x.output} contains PASS' or '{steps.x.json.score} >= 0.8'. Supports same operators as 'when' plus 'contains' for substring checks.",
			}),
		),
		score: Type.Optional(
			Type.Unknown({
				description:
					'[gate] Deterministic output scorers with optional LLM-judge fallback: {target?, scorers: [{type: "exact-match"|"contains"|"regex"|"json-schema"|"length-range"|"code-compiles", ...}], combine?: "all"|"any"|"weighted", weights?, threshold?, judge?: {agent?, task}}. Scorers run against \'target\' (default {previous.output}) at zero tokens; if the combination passes, the gate auto-passes with NO LLM call. If it fails, the judge (when present) or the gate \'task\' decides. The structured result is this phase\'s .json ({steps.<id>.json.combined}, .json.results). With combine:"weighted" and a judge, \'weights\' has one trailing entry for the judge.',
			}),
		),
		cache: Type.Optional(CacheSchema),
		shareContext: Type.Optional(
			Type.Boolean({
				description:
					"Opt into the Shared Context Tree for this phase: the subagent gets ctx_read/ctx_write (a blackboard shared with siblings/ancestors, to avoid re-reading files) and ctx_report/ctx_spawn (report upward + queue child tasks the runtime picks up). Default false — existing flows are unaffected.",
			}),
		),
	},
	{ additionalProperties: false },
);

const ArgSpecSchema = Type.Object(
	{
		default: Type.Optional(Type.Unknown()),
		description: Type.Optional(Type.String()),
		required: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const TaskflowSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, description: "Workflow name (becomes /tf:<name> command when saved)" }),
		description: Type.Optional(Type.String()),
		version: Type.Optional(Type.Number({ default: 1 })),
		args: Type.Optional(Type.Record(Type.String(), ArgSpecSchema, { description: "Declared invocation arguments" })),
		concurrency: Type.Optional(Type.Number({ description: "Default max concurrent subagents", default: 8 })),
		budget: Type.Optional(BudgetSchema),
		agentScope: Type.Optional(
			StringEnum(["user", "project", "both"] as const, { description: "Agent discovery scope", default: "user" }),
		),
		strictInterpolation: Type.Optional(
			Type.Boolean({
				description:
					"When true, unresolved interpolation placeholders and validation warnings about missing deps/args become hard errors",
				default: false,
			}),
		),
		contextSharing: Type.Optional(
			Type.Boolean({
				description:
					"Enable the Shared Context Tree for ALL phases in this flow (shorthand for setting shareContext on every phase). Default false.",
			}),
		),
		incremental: Type.Optional(
			Type.Boolean({
				description:
					"Default every phase to cross-run caching (scope:'cross-run') so re-running this flow reuses unchanged phases across runs/sessions. Equivalent to setting cache:{scope:'cross-run'} on every phase; per-phase cache settings and the cross-run-blocked types (gate/approval/loop/tournament) still take precedence. Default false (run-only — each run starts fresh unless a phase opts in). A run-time `incremental` argument overrides this.",
			}),
		),
		phases: Type.Array(PhaseSchema, { minItems: 1, description: "Ordered phase definitions (DAG via dependsOn)" }),
	},
	{ additionalProperties: false },
);

export type ParallelTask = Static<typeof ParallelTaskSchema>;
export type Phase = Static<typeof PhaseSchema>;
export type Taskflow = Static<typeof TaskflowSchema>;
export type ArgSpec = Static<typeof ArgSpecSchema>;
export type RetryPolicy = Static<typeof RetrySchema>;
export type Budget = Static<typeof BudgetSchema>;
export type CachePolicy = Static<typeof CacheSchema>;
type JoinMode = (typeof JOIN_MODES)[number];

// ---------------------------------------------------------------------------
// Shorthand (non-DAG) specs — subagent-style ergonomics
// ---------------------------------------------------------------------------
//
// For simple delegations you should not have to author a phases DAG. A
// shorthand spec mirrors the subagent tool's modes and is desugared into a
// full Taskflow before validation/execution:
//
//   { task, agent? }                  → one `agent` phase           (single)
//   { tasks: [{task, agent?}, ...] }  → one `parallel` phase        (parallel)
//   { chain: [{task, agent?}, ...] }  → sequential `agent` phases   (chain)
//
// Chain steps reference the prior step's output with {previous.output}, exactly
// like the subagent tool's {previous} placeholder.

export interface ShorthandStep {
	agent?: string;
	task: string;
	/** Files to pre-read and inject before the task (pass-through to Phase.context). */
	context?: string[];
	/** Max characters per context file (pass-through to Phase.contextLimit). */
	contextLimit?: number;
}

/** True when `def` is a shorthand spec (no `phases`, but a task/tasks/chain field). */
export function isShorthand(def: unknown): boolean {
	if (typeof def !== "object" || def === null) return false;
	const d = def as Record<string, unknown>;
	if (Array.isArray(d.phases)) return false;
	return (
		(Array.isArray(d.chain) && d.chain.length > 0) ||
		(Array.isArray(d.tasks) && d.tasks.length > 0) ||
		typeof d.task === "string"
	);
}

/** Coerce an unknown value into a non-empty list of non-empty strings (or undefined). */
function readContextList(v: unknown): string[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const list = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
	return list.length ? list : undefined;
}

function readStep(s: unknown): ShorthandStep {
	if (typeof s === "string") return { task: s };
	if (s && typeof s === "object") {
		const o = s as Record<string, unknown>;
		const step: ShorthandStep = { agent: typeof o.agent === "string" ? o.agent : undefined, task: String(o.task ?? "") };
		const ctx = readContextList(o.context);
		if (ctx) step.context = ctx;
		if (typeof o.contextLimit === "number") step.contextLimit = o.contextLimit;
		return step;
	}
	return { task: "" };
}

/**
 * Desugar a shorthand spec into a full Taskflow DAG. Throws if no recognizable
 * shorthand field is present. Carries through optional name/description/
 * concurrency/agentScope/args.
 */
export function desugar(def: unknown): Taskflow {
	if (typeof def !== "object" || def === null) throw new Error("Shorthand spec must be an object");
	const d = def as Record<string, unknown>;

	const meta: Partial<Taskflow> = {};
	if (typeof d.description === "string") meta.description = d.description;
	if (typeof d.concurrency === "number") meta.concurrency = d.concurrency;
	if (d.agentScope === "user" || d.agentScope === "project" || d.agentScope === "both") meta.agentScope = d.agentScope;
	if (d.args && typeof d.args === "object") meta.args = d.args as Taskflow["args"];
	if (d.budget) meta.budget = d.budget;
	if (typeof d.strictInterpolation === "boolean") meta.strictInterpolation = d.strictInterpolation;
	const nameOf = (fallback: string) => (typeof d.name === "string" && d.name.trim() ? d.name.trim() : fallback);

	// chain → sequential agent phases
	if (Array.isArray(d.chain) && d.chain.length > 0) {
		// Spec-level context in chain mode would be a flow-level default (every
		// step), which is deliberately NOT supported — declare it per step instead.
		if (d.context !== undefined || d.contextLimit !== undefined) {
			console.warn(
				"[taskflow] Shorthand chain ignores top-level 'context'/'contextLimit' — put them on individual steps instead.",
			);
		}
		const steps = d.chain.map(readStep);
		const phases: Phase[] = steps.map((s, i) => {
			const phase: Phase = { id: `step${i + 1}`, type: "agent", task: s.task };
			if (s.agent) phase.agent = s.agent;
			if (s.context) phase.context = s.context;
			if (s.contextLimit !== undefined) phase.contextLimit = s.contextLimit;
			if (i > 0) phase.dependsOn = [`step${i}`];
			if (i === steps.length - 1) phase.final = true;
			return phase;
		});
		return { name: nameOf("chain"), ...meta, phases };
	}

	// tasks → one parallel phase (fan-out + merge), no extra aggregation agent.
	// Context is SHARED across all branches (the runtime pre-reads per phase, not
	// per branch): spec-level context plus the union of step-level contexts.
	if (Array.isArray(d.tasks) && d.tasks.length > 0) {
		const steps = d.tasks.map(readStep);
		const branches: ParallelTask[] = steps.map((s) => (s.agent ? { task: s.task, agent: s.agent } : { task: s.task }));
		const phase: Phase = { id: "parallel", type: "parallel", branches, final: true };
		const shared = [...(readContextList(d.context) ?? []), ...steps.flatMap((s) => s.context ?? [])];
		if (shared.length) phase.context = Array.from(new Set(shared));
		const limits = [
			typeof d.contextLimit === "number" ? d.contextLimit : undefined,
			...steps.map((s) => s.contextLimit),
		].filter((n): n is number => typeof n === "number");
		if (limits.length) phase.contextLimit = Math.max(...limits);
		return { name: nameOf("parallel"), ...meta, phases: [phase] };
	}

	// single task → one agent phase (the spec itself is the step)
	if (typeof d.task === "string") {
		const phase: Phase = { id: "main", type: "agent", task: d.task, final: true };
		if (typeof d.agent === "string") phase.agent = d.agent;
		const ctx = readContextList(d.context);
		if (ctx) phase.context = ctx;
		if (typeof d.contextLimit === "number") phase.contextLimit = d.contextLimit;
		return { name: nameOf("task"), ...meta, phases: [phase] };
	}

	throw new Error("Shorthand spec needs one of: 'task' (single), 'tasks' (parallel), or 'chain' (sequential)");
}

// ---------------------------------------------------------------------------
// Validation (beyond schema: DAG integrity, phase-type requirements)
// ---------------------------------------------------------------------------

/** @internal */
export interface ValidationResult {
	ok: boolean;
	errors: string[];
	/** Non-fatal issues the user should fix; e.g. `{steps.X}` references that
	 *  aren't declared in `dependsOn` (the phase will run in parallel with its
	 *  producer and see the literal placeholder). */
	warnings: string[];
}

/**
 * Parse a TTL string like '30m', '6h', '7d', '500ms', '90s' into milliseconds.
 * Returns null for malformed or non-positive values. Plain integers = ms.
 */
export function parseTtlMs(ttl: string): number | null {
	if (typeof ttl !== "string") return null;
	const m = ttl.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
	if (!m) return null;
	const n = Number(m[1]);
	if (!Number.isFinite(n) || n <= 0) return null;
	const unit = (m[2] ?? "ms").toLowerCase();
	const mult: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
	return n * mult[unit];
}

export interface ValidationOptions {
	/** Resolved invocation args, used for runtime checks like missing `{args.X}`. */
	args?: Record<string, unknown>;
	/** Runtime working directory, used for mismatch warnings (e.g. cwd vs args.codebase). */
	cwd?: string;
	/** Override the flow's own `strictInterpolation` flag for this validation call. */
	strict?: boolean;
	/** When true, this flow is a runtime-generated (`flow { def }`) sub-flow whose
	 *  content is LLM-authored / untrusted. Enables hardening checks: breadth caps
	 *  (phase count, map items, concurrency) and cwd containment under `cwd`. */
	dynamic?: boolean;
}

export function validateTaskflow(def: unknown, opts: ValidationOptions = {}): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (typeof def !== "object" || def === null) {
		return { ok: false, errors: ["Taskflow must be an object"], warnings };
	}
	const flow = def as Partial<Taskflow>;
	const strict = opts.strict ?? flow.strictInterpolation === true;

	if (!flow.name || typeof flow.name !== "string") errors.push("Missing or invalid 'name'");
	if (!Array.isArray(flow.phases) || flow.phases.length === 0) {
		errors.push("Taskflow must have at least one phase");
		return { ok: false, errors, warnings };
	}

	// Hardening for runtime-generated (untrusted) sub-flows: bound breadth and
	// contain filesystem access. These do NOT apply to authored/saved flows.
	if (opts.dynamic) {
		if (flow.phases.length > MAX_DYNAMIC_PHASES) {
			errors.push(`Dynamic sub-flow has too many phases (${flow.phases.length}, max ${MAX_DYNAMIC_PHASES})`);
		}
		if (typeof flow.concurrency === "number" && flow.concurrency > MAX_DYNAMIC_CONCURRENCY) {
			errors.push(`Dynamic sub-flow concurrency too high (${flow.concurrency}, max ${MAX_DYNAMIC_CONCURRENCY})`);
		}
		const root = opts.cwd ? path.resolve(opts.cwd) : undefined;
		for (const p of flow.phases) {
			if (!p || typeof p !== "object") continue;
			// A generated phase may not execute shell commands. `script` runs an
			// arbitrary command — a strictly larger capability than the reserved
			// cwd keywords blocked below — so an LLM-authored plan (flow{def} /
			// ctx_spawn) that emits a script phase is rejected. Only author-written
			// flows may use `script`.
			if (p.type === "script") {
				errors.push(`Dynamic sub-flow phase '${p.id}': 'script' phases (shell execution) are not allowed in generated flows`);
			}
			// Scoring-gate hardening for generated flows. Two scorer types are
			// blocked when the flow is LLM-authored:
			//  - code-compiles: the typescript path runs `npx --no-install tsc`,
			//    which resolves node_modules/.bin from the working directory — a
			//    repo-planted fake `tsc` becomes arbitrary code execution (same
			//    capability class as `script`, blocked above).
			//  - regex: `new RegExp(pattern).test(target)` runs synchronously with
			//    no timeout — an LLM-authored catastrophic-backtracking pattern
			//    (ReDoS) hangs the event loop. Author-written flows keep both
			//    (a human reviewed the pattern / trusts the toolchain).
			const dynScore = (p as { score?: { scorers?: unknown[] } }).score;
			if (dynScore && typeof dynScore === "object" && Array.isArray(dynScore.scorers)) {
				for (const s of dynScore.scorers) {
					const st = s && typeof s === "object" ? (s as { type?: unknown }).type : undefined;
					if (st === "code-compiles") {
						errors.push(`Dynamic sub-flow phase '${p.id}': 'code-compiles' scorers (compiler execution) are not allowed in generated flows`);
					} else if (st === "regex") {
						errors.push(`Dynamic sub-flow phase '${p.id}': 'regex' scorers (ReDoS risk) are not allowed in generated flows — use contains/exact-match/json-schema/length-range`);
					}
				}
			}
			// Per-phase concurrency override is also capped.
			if (typeof p.concurrency === "number" && p.concurrency > MAX_DYNAMIC_CONCURRENCY) {
				errors.push(`Dynamic sub-flow phase '${p.id}': concurrency too high (${p.concurrency}, max ${MAX_DYNAMIC_CONCURRENCY})`);
			}
			// cwd containment: a generated phase may not escape the run's cwd, and
			// may not request a reserved workspace keyword (temp/dedicated/worktree)
			// — LLM-authored sub-flows must not allocate isolated dirs or git
			// worktrees that mutate the repo. Only author-written flows may.
			if (typeof p.cwd === "string") {
				if (WORKSPACE_KEYWORDS.includes(p.cwd as (typeof WORKSPACE_KEYWORDS)[number])) {
					errors.push(`Dynamic sub-flow phase '${p.id}': cwd '${p.cwd}' is a reserved workspace keyword not allowed in generated flows`);
				} else if (root) {
					const resolved = path.resolve(root, p.cwd);
					if (resolved !== root && !resolved.startsWith(root + path.sep)) {
						errors.push(`Dynamic sub-flow phase '${p.id}': cwd '${p.cwd}' escapes the run directory`);
					}
				}
			}
		}
	}

	const ids = new Set<string>();
	for (const p of flow.phases) {
		if (!p || typeof p !== "object") {
			errors.push("Each phase must be an object");
			continue;
		}
		if (!p.id) {
			errors.push("Each phase requires an 'id'");
			continue;
		}
		if (typeof p.id !== "string") {
			errors.push(`Phase id must be a string, got ${typeof p.id}`);
			continue;
		}
		if (ids.has(p.id)) errors.push(`Duplicate phase id: ${p.id}`);
		ids.add(p.id);

		// Array-shaped fields must actually be arrays. Several passes below (and
		// verify/compile/collectRefs downstream) iterate these; a non-array is
		// reported as a structured error here. The iteration sites use asArray() so
		// a bad value degrades to [] instead of throwing "not iterable".
		for (const key of ["dependsOn", "from", "branches", "eval", "context", "tools"] as const) {
			const v = (p as Record<string, unknown>)[key];
			if (v !== undefined && !Array.isArray(v)) {
				errors.push(`Phase '${p.id}': '${key}' must be an array, got ${typeof v}`);
			}
		}
		// String-shaped scalar fields must be strings when present. They flow into
		// renderers (label/summarize/nodeId call `.replace`) and the runtime
		// (cwd -> spawn, model/thinking -> agent config); a non-string would throw
		// or be silently misused. This is the COMPLETE set of string scalars in
		// PhaseSchema except `id`/`type`/`over`, which have dedicated checks above.
		for (const key of [
			"task",
			"agent",
			"use",
			"when",
			"until",
			"as",
			"model",
			"thinking",
			"cwd",
			"judge",
			"judgeAgent",
			"output",
		] as const) {
			const v = (p as Record<string, unknown>)[key];
			if (v !== undefined && typeof v !== "string") {
				errors.push(`Phase '${p.id}': '${key}' must be a string, got ${typeof v}`);
			}
		}
		// dependsOn / from entries are string phase-id refs that flow into the graph
		// helpers and nodeId(); a non-string entry would crash the renderer.
		for (const key of ["dependsOn", "from"] as const) {
			const v = (p as Record<string, unknown>)[key];
			if (Array.isArray(v))
				v.forEach((e, i) => {
					if (typeof e !== "string")
						errors.push(`Phase '${p.id}': ${key}[${i}] must be a string phase id, got ${typeof e}`);
				});
		}
		// Branch entries become competitors at runtime (b.task is interpolated); a
		// non-object / non-string-task entry would crash the runtime, so reject it.
		if (Array.isArray(p.branches)) {
			p.branches.forEach((b, i) => {
				if (!b || typeof b !== "object" || Array.isArray(b))
					errors.push(`Phase '${p.id}': branches[${i}] must be an object with a 'task', got ${b === null ? "null" : typeof b}`);
				else if (typeof (b as { task?: unknown }).task !== "string")
					errors.push(`Phase '${p.id}': branches[${i}].task must be a string`);
			});
		}
		// tools entries are matched against a Set by the adapters (t => set.has(t));
		// a non-string entry would be silently ignored or misused, so reject it.
		if (Array.isArray(p.tools)) {
			p.tools.forEach((t, i) => {
				if (typeof t !== "string")
					errors.push(`Phase '${p.id}': tools[${i}] must be a string, got ${typeof t}`);
			});
		}

		// When a phase opts into the Shared Context Tree, its id becomes a filesystem
		// node id; restrict the charset so two ids can't sanitize to the same node
		// (which would silently merge their blackboards). Non-sharing phases are
		// unaffected (full backward compat).
		if ((p.shareContext === true || flow.contextSharing === true) && !/^[A-Za-z0-9._-]+$/.test(p.id)) {
			errors.push(`Phase '${p.id}': ids used with context sharing must match [A-Za-z0-9._-]+`);
		}

		const type = (p.type ?? "agent") as PhaseType;
		if (!PHASE_TYPES.includes(type)) errors.push(`Phase '${p.id}': unknown type '${type}'`);

		// Per-type requirements
		if (type === "agent") {
			if (!p.task) errors.push(`Phase '${p.id}' (agent) requires 'task'`);
		}
		if (type === "gate") {
			// A scoring gate can decide without an LLM task: deterministic pass →
			// auto-pass; deterministic fail → judge (when present) or explicit BLOCK.
			const hasScore = (p as { score?: unknown }).score !== undefined;
			if (!p.task && !hasScore) errors.push(`Phase '${p.id}' (gate) requires 'task' (or 'score')`);
		}
		if (type === "gate" && Array.isArray(p.eval)) {
			// eval entries are interpolated + parsed at runtime (expr.indexOf/.slice);
			// a non-string entry would crash the gate, so reject it up front.
			p.eval.forEach((e, i) => {
				if (typeof e !== "string")
					errors.push(`Phase '${p.id}' (gate): eval[${i}] must be a string condition, got ${typeof e}`);
			});
		}
		// Scoring gates (`score`) — deterministic scorers + optional LLM judge.
		const scoreVal = (p as { score?: unknown }).score;
		if (scoreVal !== undefined) {
			if (type !== "gate") {
				errors.push(`Phase '${p.id}' (${type}): 'score' is only valid for gate phases`);
			} else {
				for (const e of scorerShapeErrors(scoreVal)) errors.push(`Phase '${p.id}': ${e}`);
				if (Array.isArray(p.eval) && p.eval.length > 0) {
					warnings.push(
						`Phase '${p.id}' (gate): both 'eval' and 'score' are set — eval runs first (all-pass skips the gate entirely), then score. This is valid but usually one of the two suffices.`,
					);
				}
				// Judge agent naming convention (mirrors the phase-agent check below).
				const judgeAgent = (scoreVal as { judge?: { agent?: unknown } }).judge?.agent;
				if (typeof judgeAgent === "string" && judgeAgent.includes("_")) {
					errors.push(`Phase '${p.id}': score.judge.agent '${judgeAgent}' uses underscores — use hyphens`);
				}
			}
		}
		// Reflexion memory — loop-only.
		if ((p as { reflexion?: unknown }).reflexion !== undefined) {
			const r = (p as { reflexion?: unknown }).reflexion;
			if (typeof r !== "boolean") {
				errors.push(`Phase '${p.id}': 'reflexion' must be a boolean, got ${typeof r}`);
			} else if (r === true && type !== "loop") {
				errors.push(`Phase '${p.id}' (${type}): 'reflexion' is only valid for loop phases`);
			}
		}
		// Other loop-only fields on non-loop phases are silently ignored by the
		// runtime — warn so the author learns the field does nothing (a warning,
		// not an error, to avoid breaking pre-existing flows that carry them).
		if (type !== "loop") {
			for (const key of ["until", "maxIterations", "convergence"] as const) {
				if ((p as Record<string, unknown>)[key] !== undefined) {
					warnings.push(`Phase '${p.id}' (${type}): '${key}' is only meaningful on loop phases and is ignored here`);
				}
			}
		}
		// Side-effect classification (`idempotent: false`).
		if ((p as { idempotent?: unknown }).idempotent !== undefined) {
			const v = (p as { idempotent?: unknown }).idempotent;
			if (typeof v !== "boolean") {
				errors.push(`Phase '${p.id}': 'idempotent' must be a boolean, got ${typeof v}`);
			} else if (v === false) {
				if (type === "approval" || type === "flow") {
					warnings.push(
						`Phase '${p.id}' (${type}): 'idempotent: false' is a no-op here — ${type} phases run no subagent (no transient retry) and are already excluded from cross-run cache. The flag has no effect.`,
					);
				}
				if (p.cache?.scope === "cross-run") {
					warnings.push(
						`Phase '${p.id}': idempotent:false overrides cache.scope 'cross-run' — a side-effecting phase is never cached (it will re-run every time).`,
					);
				} else if (flow.incremental === true && p.cache?.scope === undefined) {
					warnings.push(
						`Phase '${p.id}': idempotent:false under an incremental flow — this phase is excluded from caching and will re-run every invocation (this is the safe behavior for side effects).`,
					);
				}
			}
		}
		if (type === "map") {
			if (!p.over) errors.push(`Phase '${p.id}' (map) requires 'over'`);
			else if (typeof p.over !== "string")
				errors.push(
					`Phase '${p.id}' (map): 'over' must be a string interpolation ref (e.g. "{steps.scan.json}"), not a ${Array.isArray(p.over) ? "literal array" : typeof p.over}. To fan out over a fixed list, emit it from an upstream phase and reference that phase's .json.`,
				);
			if (!p.task) errors.push(`Phase '${p.id}' (map) requires 'task'`);
		}
		if (type === "parallel") {
			if (!p.branches || p.branches.length === 0)
				errors.push(`Phase '${p.id}' (parallel) requires non-empty 'branches'`);
		}
			if (type === "race") {
				if (!p.branches || p.branches.length === 0)
					errors.push(`Phase '${p.id}' (race) requires non-empty 'branches'`);
				else if (p.branches.length < 2)
					errors.push(`Phase '${p.id}' (race): needs at least 2 branches`);
				if ((p as { cancelLosers?: unknown }).cancelLosers !== undefined && typeof (p as { cancelLosers?: unknown }).cancelLosers !== "boolean") {
					errors.push(`Phase '${p.id}' (race): cancelLosers must be a boolean`);
				}
			}
		if (type === "expand") {
			if ((p as { def?: unknown }).def === undefined)
				errors.push(`Phase '${p.id}' (expand) requires 'def' (fragment Taskflow or {steps.X.json})`);
			const em = (p as { expandMode?: string }).expandMode;
			if (em !== undefined && em !== "nested" && em !== "graft") {
				errors.push(`Phase '${p.id}' (expand): expandMode must be 'nested' or 'graft'`);
			}
			const maxN = (p as { maxNodes?: number }).maxNodes;
			if (maxN !== undefined && (typeof maxN !== "number" || maxN < 1 || maxN > MAX_DYNAMIC_PHASES)) {
				errors.push(`Phase '${p.id}' (expand): maxNodes must be 1..${MAX_DYNAMIC_PHASES}`);
			}
		}
		if (type === "reduce") {
			if (!p.from || p.from.length === 0) errors.push(`Phase '${p.id}' (reduce) requires 'from'`);
			if (!p.task) errors.push(`Phase '${p.id}' (reduce) requires 'task'`);
		}
		if (type === "flow") {
			const hasUse = typeof p.use === "string" && p.use.length > 0;
			const hasDef = (p as { def?: unknown }).def !== undefined;
			if (!hasUse && !hasDef) {
				errors.push(`Phase '${p.id}' (flow) requires 'use' (a saved flow name) or 'def' (an inline definition)`);
			} else if (hasUse && hasDef) {
				errors.push(`Phase '${p.id}' (flow): 'use' and 'def' are mutually exclusive — provide exactly one`);
			}
		}
		if (type === "loop") {
			if (!p.task) errors.push(`Phase '${p.id}' (loop) requires 'task' (the iteration body)`);
			if (!p.until) errors.push(`Phase '${p.id}' (loop) requires 'until' (the stop condition)`);
			if (p.maxIterations !== undefined) {
				if (typeof p.maxIterations !== "number" || !Number.isFinite(p.maxIterations) || p.maxIterations < 1) {
					errors.push(`Phase '${p.id}' (loop): maxIterations must be a number >= 1`);
				} else if (p.maxIterations > LOOP_HARD_MAX_ITERATIONS) {
					errors.push(`Phase '${p.id}' (loop): maxIterations must be <= ${LOOP_HARD_MAX_ITERATIONS}`);
				}
			}
		}
		if (type === "tournament") {
			const hasBranches = Array.isArray(p.branches) && p.branches.length > 0;
			if (!hasBranches && !p.task) {
				errors.push(`Phase '${p.id}' (tournament) requires 'task' (the competitor prompt) or non-empty 'branches'`);
			}
			if (p.variants !== undefined) {
				if (typeof p.variants !== "number" || !Number.isFinite(p.variants) || p.variants < 2) {
					errors.push(`Phase '${p.id}' (tournament): variants must be a number >= 2`);
				} else if (p.variants > TOURNAMENT_HARD_MAX_VARIANTS) {
					errors.push(`Phase '${p.id}' (tournament): variants must be <= ${TOURNAMENT_HARD_MAX_VARIANTS}`);
				}
			}
			if (hasBranches && p.branches!.length < 2) {
				errors.push(`Phase '${p.id}' (tournament): 'branches' needs at least 2 competitors`);
			}
			if (p.mode && !TOURNAMENT_MODES.includes(p.mode as TournamentMode)) {
				errors.push(`Phase '${p.id}' (tournament): unknown mode '${p.mode}'`);
			}
		}
		if (type === "script") {
			if (!p.run) errors.push(`Phase '${p.id}' (script) requires 'run' (the shell command)`);
			if (Array.isArray(p.run) && (p.run.length === 0 || !p.run[0]))
				errors.push(`Phase '${p.id}' (script): 'run' array must be non-empty with a valid first element`);
			if (typeof p.run === "string" && /\{[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\}/.test(p.run))
				errors.push(`Phase '${p.id}' (script): string 'run' must not contain interpolation placeholders (use array form or pipe through 'input')`);
			if (p.retry) errors.push(`Phase '${p.id}' (script): 'retry' is not supported for script phases`);
			if (p.output === "json")
				errors.push(`Phase '${p.id}' (script): 'output:"json"' is not supported for script phases`);
			if (p.timeout !== undefined && (typeof p.timeout !== "number" || p.timeout < 1000 || p.timeout > 300000))
				errors.push(`Phase '${p.id}' (script): 'timeout' must be a number between 1000 and 300000 ms`);
		}
		if (type !== "script") {
			if (p.run !== undefined) errors.push(`Phase '${p.id}' (${type}): 'run' is only valid for script phases`);
			if (p.input !== undefined) errors.push(`Phase '${p.id}' (${type}): 'input' is only valid for script phases`);
			if (p.timeout !== undefined) {
				if (type === "approval" || type === "flow")
					errors.push(`Phase '${p.id}' (${type}): 'timeout' is not supported for ${type} phases`);
				else if (typeof p.timeout !== "number" || !Number.isFinite(p.timeout) || p.timeout < 1000)
					errors.push(`Phase '${p.id}' (${type}): 'timeout' must be a number >= 1000 ms`);
			}
		}
		if (p.retry) {
			if (typeof p.retry.max !== "number" || p.retry.max < 0) {
				errors.push(`Phase '${p.id}': retry.max must be a number >= 0`);
			} else if (p.retry.max > 20) {
				errors.push(`Phase '${p.id}': retry.max must be <= 20`);
			}
			if (p.retry.backoffMs !== undefined && (p.retry.backoffMs < 0 || p.retry.backoffMs > 60000)) {
				errors.push(`Phase '${p.id}': retry.backoffMs must be between 0 and 60000`);
			}
			if (p.retry.factor !== undefined && (p.retry.factor < 1 || p.retry.factor > 10)) {
				errors.push(`Phase '${p.id}': retry.factor must be between 1 and 10`);
			}
		}
		if (p.join && !JOIN_MODES.includes(p.join as JoinMode)) {
			errors.push(`Phase '${p.id}': unknown join mode '${p.join}'`);
		}

		// Output contract (`expect`) validation.
		if (p.expect !== undefined) {
			const EXPECT_TYPES = new Set(["agent", "gate", "reduce", "loop"]);
			if (!EXPECT_TYPES.has(type)) {
				errors.push(`Phase '${p.id}' (${type}): 'expect' is only valid for agent/gate/reduce/loop phases`);
			} else if (p.output !== "json") {
				errors.push(`Phase '${p.id}': 'expect' requires 'output': "json" (the contract validates the parsed JSON output)`);
			} else {
				for (const e of contractShapeErrors(p.expect)) errors.push(`Phase '${p.id}': ${e}`);
			}
		}

		// Cache policy validation (cross-run memoization).
		if (p.cache) {
			if (typeof p.cache !== "object" || Array.isArray(p.cache)) {
				errors.push(`Phase '${p.id}': 'cache' must be an object`);
			} else {
			const scope = p.cache.scope ?? "run-only";
			if (!CACHE_SCOPES.includes(scope as CacheScope)) {
				errors.push(`Phase '${p.id}': unknown cache.scope '${scope}' (expected one of ${CACHE_SCOPES.join(", ")})`);
			}
			// Gate B: gate/approval phases must produce a fresh result every run.
			if (scope === "cross-run" && (CACHE_CROSS_RUN_BLOCKED_TYPES as readonly string[]).includes(type)) {
				errors.push(
					`Phase '${p.id}' (${type}): cache.scope 'cross-run' is not allowed for ${CACHE_CROSS_RUN_BLOCKED_TYPES.join("/")} phases — they must produce a fresh result each run. Use 'run-only'.`,
				);
			}
			// Gate C: every fingerprint entry must use a known prefix (fail closed).
			if (p.cache.fingerprint !== undefined && !Array.isArray(p.cache.fingerprint)) {
				errors.push(`Phase '${p.id}': 'cache.fingerprint' must be an array of strings`);
			} else
				for (const fp of p.cache.fingerprint ?? []) {
					if (typeof fp !== "string") {
						errors.push(`Phase '${p.id}': cache.fingerprint entries must be strings, got ${typeof fp}`);
						continue;
					}
					const ok = CACHE_FINGERPRINT_PREFIXES.some((pre) => fp.startsWith(pre) && fp.length > pre.length);
					if (!ok) {
						errors.push(
							`Phase '${p.id}': invalid cache.fingerprint entry '${fp}' (expected '<prefix><value>' with prefix one of ${CACHE_FINGERPRINT_PREFIXES.join(", ")})`,
						);
					}
				}
			// Gate D: TTL must parse to a positive duration when present.
			if (p.cache.ttl !== undefined && parseTtlMs(p.cache.ttl) === null) {
				errors.push(`Phase '${p.id}': invalid cache.ttl '${p.cache.ttl}' (expected e.g. '30m', '6h', '7d')`);
			}
			}
		}

		// Agent name convention: hyphens only (per AGENTS.md naming convention)
		if (p.agent && typeof p.agent === "string" && p.agent.includes("_")) {
			errors.push(`Phase '${p.id}': agent name '${p.agent}' uses underscores — use hyphens (e.g. 'executor-code' not 'executor_code')`);
		}

		// Phase id convention: hyphens only (consistent with interpolation placeholders like {steps.audit-each.output})
		if (typeof p.id === "string" && p.id.includes("_")) {
			errors.push(`Phase '${p.id}': id uses underscores — use hyphens for consistency with interpolation placeholders (e.g. {steps.audit-each.output})`);
		}
	}

	// dependsOn / from references must exist
	for (const p of flow.phases) {
		if (!p?.id) continue;
		for (const dep of asArray<string>(p.dependsOn)) {
			if (!ids.has(dep)) errors.push(`Phase '${p.id}': dependsOn unknown phase '${dep}'`);
		}
		for (const f of asArray<string>(p.from)) {
			if (!ids.has(f)) errors.push(`Phase '${p.id}': from unknown phase '${f}'`);
		}
	}

	// Agent name format validation (AGENTS.md naming convention: hyphens only, no underscores)
	const VALID_AGENT_RE = /^[a-z][a-z0-9-]*$/;
	for (const p of flow.phases) {
		if (!p?.id) continue;
		if (typeof p.agent === "string" && !p.agent.includes("_") && !VALID_AGENT_RE.test(p.agent)) {
			errors.push(`Phase '${p.id}': agent '${p.agent}' has invalid name format (expected lowercase alphanumeric with hyphens)`);
		}
	}

	// Cycle detection (Kahn)
	if (errors.length === 0) {
		const cycle = detectCycle(flow.phases as Phase[]);
		if (cycle) errors.push(`Dependency cycle detected: ${cycle.join(" -> ")}`);
	}

	// Exactly handle final-phase resolution lazily (0 finals => last phase is final)
	const finals = (flow.phases as Phase[]).filter((p) => p?.final);
	if (finals.length > 1) errors.push(`Only one phase may be marked 'final' (found ${finals.length})`);

	// --- Hard errors: {steps.X.*} references that aren't declared deps ------
	// Catches the most common authoring mistake: the task talks about
	// `{steps.review.output}` but `dependsOn: ["review"]` is missing, so the
	// phase runs in parallel with `review` and the model sees the literal
	// placeholder string. The runtime can't infer the intent — fail fast at
	// validation time so the mistake is caught before the run starts.
	//
	// The check uses TRANSITIVE ancestors: if phase B depends on A, and C depends
	// on B, then C may reference {steps.A.*} transitively. Only truly unreachable
	// refs are errors.
	//
	// Phases with `join: "any"` are exempt: by design they only need ONE of
	// their declared deps to complete, and may reference other phases as
	// informational context (not as true dependencies).
	if (errors.length === 0) {
		const idToPhase = new Map((flow.phases as Phase[]).map((p) => [p.id, p]));
		// Precompute transitive ancestors for every phase via BFS over dependsOn.
		const transitiveCache = new Map<string, Set<string>>();
		const transitiveAncestors = (phaseId: string): Set<string> => {
			const cached = transitiveCache.get(phaseId);
			if (cached) return cached;
			const result = new Set<string>();
			const queue = [...(idToPhase.get(phaseId)?.dependsOn ?? []), ...(idToPhase.get(phaseId)?.from ?? [])];
			while (queue.length) {
				const id = queue.shift()!;
				if (result.has(id)) continue;
				result.add(id);
				const dep = idToPhase.get(id);
				if (dep) {
					for (const d of [...asArray<string>(dep.dependsOn), ...asArray<string>(dep.from)]) {
						if (!result.has(d)) queue.push(d);
					}
				}
			}
			transitiveCache.set(phaseId, result);
			return result;
		};
		for (const p of flow.phases as Phase[]) {
			if (!p?.id) continue;
			const isJoinAny = p.join === "any";
			if (isJoinAny) continue;
			const transitive = transitiveAncestors(p.id);
			const refs = collectRefs(p);
			for (const ref of refs.steps) {
				if (ref === p.id) {
					// Loop phases legitimately reference their own output: `until` (and
					// the body) inspect the current iteration via {steps.<thisId>.output|json}
					// — that is the documented stop-condition pattern, not a bug.
					if ((p.type ?? "agent") === "loop") continue;
					errors.push(`Phase '${p.id}': references its own output via {steps.${ref}.*}; this is almost always a bug.`);
					continue;
				}
				if (!idToPhase.has(ref)) {
					// Unknown ref is already an error from the dependsOn check, but
					// {steps.X.*} can appear in a task without dependsOn. Don't
					// double-warn — the dependsOn loop above already flags it.
					continue;
				}
				if (!transitive.has(ref)) {
					errors.push(
						`Phase '${p.id}': task references {steps.${ref}.*} but '${ref}' is not reachable via dependsOn. ` +
							`The phase will run in parallel with '${ref}' and see the literal placeholder. ` +
							`Add "dependsOn": ["${ref}"] (or include '${ref}' transitively).`,
					);
				}
			}
		}
	}

	// --- Runtime/invocation warnings: missing args + cwd/codebase mismatch -----
	if (errors.length === 0 && opts.args) {
		const argRefs = new Set<string>();
		for (const p of flow.phases as Phase[]) {
			if (!p?.id) continue;
			for (const ref of collectRefs(p).args) argRefs.add(ref);
		}
		for (const ref of argRefs) {
			if (!(ref in opts.args)) {
				warnings.push(
					`Taskflow references {args.${ref}} but the invocation did not provide '${ref}'. ` +
						`The placeholder will remain literal unless a default or runtime arg is supplied.`,
				);
			}
		}
		if (opts.cwd && typeof opts.args.codebase === "string" && opts.args.codebase.trim()) {
			const cwd = path.resolve(opts.cwd);
			const codebase = path.resolve(cwd, opts.args.codebase);
			// Safe case: cwd is the codebase root or a subdirectory within it.
			// Warn when cwd is a sibling, unrelated path, or a parent of the
			// codebase (agents that rely on cwd would inspect too broad a tree).
			if (!pathContains(codebase, cwd)) {
				warnings.push(
					`Invocation cwd '${cwd}' does not match args.codebase '${codebase}'. ` +
						`Some agents may inspect the wrong repo if they rely on cwd. Prefer running from the codebase root or set phase.cwd explicitly.`,
				);
			}
		}
	}

	if (strict && warnings.length) {
		errors.push(...warnings.map((w) => `Strict interpolation: ${w}`));
	}

	return { ok: errors.length === 0, errors, warnings };
}

export function collectRefs(phase: Phase): { steps: string[]; args: string[] } {
	const steps = new Set<string>();
	const args = new Set<string>();
	const scan = (s: string | undefined) => {
		if (!s) return;
		let m: RegExpExecArray | null;
		const stepRe = /\{steps\.([a-zA-Z0-9_-]+)/g;
		while ((m = stepRe.exec(s)) !== null) steps.add(m[1]);
		const argRe = /\{args\.([a-zA-Z0-9_-]+)/g;
		while ((m = argRe.exec(s)) !== null) args.add(m[1]);
	};
	scan(phase.task);
	scan(phase.over);
	scan(phase.when);
	scan(phase.until);
	// Script phases: the array form of `run` supports {steps.X}/{args.X}
	// interpolation (the string form does NOT — it's a raw shell command,
	// validation rejects placeholders in it), and `input` (stdin) does too.
	if (Array.isArray(phase.run)) for (const r of phase.run) if (typeof r === "string") scan(r);
	if (typeof phase.input === "string") scan(phase.input);
	// Inline sub-flow: a *string* `def` is interpolated then JSON-parsed, so its
	// {steps.X} refs are real dependencies. An object `def` is used verbatim.
	if (typeof phase.def === "string") scan(phase.def);
	for (const e of asArray<string>(phase.eval)) if (typeof e === "string") scan(e);
	// Scoring gates: the target ref and judge prompt are interpolated at runtime.
	const score = (phase as { score?: { target?: unknown; judge?: { task?: unknown } } }).score;
	if (score && typeof score === "object") {
		if (typeof score.target === "string") scan(score.target);
		if (score.judge && typeof score.judge === "object" && typeof score.judge.task === "string") scan(score.judge.task);
	}
	for (const b of asArray<{ task?: string }>(phase.branches)) if (b && typeof b === "object") scan(b.task);
	for (const v of Object.values(phase.with ?? {})) if (typeof v === "string") scan(v);
	for (const c of asArray<string>(phase.context)) if (typeof c === "string") scan(c);
	return { steps: Array.from(steps), args: Array.from(args) };
}

function pathContains(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Returns a cycle path if the DAG has one, else null. */
function detectCycle(phases: Phase[]): string[] | null {
	const deps = new Map<string, string[]>();
	for (const p of phases) deps.set(p.id, dependenciesOf(p));

	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map<string, number>();
	for (const p of phases) color.set(p.id, WHITE);
	const stack: string[] = [];

	const visit = (id: string): string[] | null => {
		color.set(id, GRAY);
		stack.push(id);
		for (const d of deps.get(id) ?? []) {
			if (!deps.has(d)) continue;
			const c = color.get(d);
			if (c === GRAY) {
				const start = stack.indexOf(d);
				return [...stack.slice(start), d];
			}
			if (c === WHITE) {
				const found = visit(d);
				if (found) return found;
			}
		}
		color.set(id, BLACK);
		stack.pop();
		return null;
	};

	for (const p of phases) {
		if (color.get(p.id) === WHITE) {
			const found = visit(p.id);
			if (found) return found;
		}
	}
	return null;
}

/** Coerce a possibly-non-array field to an array so iteration never throws
 *  "not iterable". validateTaskflow reports the non-array as a structured error;
 *  every for..of over an array-shaped phase field routes through here. */
export function asArray<T>(v: unknown): T[] {
	return Array.isArray(v) ? (v as T[]) : [];
}

/** Effective dependency ids of a phase (dependsOn ∪ from). */
export function dependenciesOf(phase: Phase): string[] {
	const set = new Set<string>([...asArray<string>(phase.dependsOn), ...asArray<string>(phase.from)]);
	return Array.from(set);
}

/**
 * Transitive upstream dependency closure of a phase: every id reachable via
 * `dependsOn ∪ from`, including indirect ancestors. Cycle-safe (visited set).
 * Returns the closure EXCLUDING `phaseId` itself. Sorted for deterministic
 * hashing. Shares the exact edge semantics with `topoLayers`/`detectCycle` so
 * the closure is complete for every valid flow (validation already rejects
 * `{steps.X}` refs that aren't reachable via these edges, except for
 * `join: "any"` phases — handled by callers as needed).
 *
 * Hoisted out of `validateTaskflow` so `phaseFingerprint` (M6) and validation
 * share one source of truth for "what does this phase structurally depend on".
 */
export function transitiveDependencies(phases: Phase[], phaseId: string): string[] {
	const byId = new Map(phases.map((p) => [p.id, p]));
	const seen = new Set<string>();
	const queue: string[] = [];
	const seed = byId.get(phaseId);
	if (seed) for (const d of dependenciesOf(seed)) queue.push(d);
	while (queue.length) {
		const id = queue.shift()!;
		if (seen.has(id)) continue;
		if (!byId.has(id)) continue; // unknown dep — validation reports elsewhere
		seen.add(id);
		const dep = byId.get(id)!;
		for (const d of dependenciesOf(dep)) {
			if (!seen.has(d)) queue.push(d);
		}
	}
	return Array.from(seen).sort();
}

/** Topologically ordered layers; phases in the same layer can run concurrently. */
export function topoLayers(phases: Phase[]): Phase[][] {
	const byId = new Map(phases.map((p) => [p.id, p]));
	const indeg = new Map<string, number>();
	const dependents = new Map<string, string[]>();

	for (const p of phases) {
		indeg.set(p.id, 0);
		dependents.set(p.id, []);
	}
	for (const p of phases) {
		for (const d of dependenciesOf(p)) {
			if (!byId.has(d)) continue;
			indeg.set(p.id, (indeg.get(p.id) ?? 0) + 1);
			dependents.get(d)!.push(p.id);
		}
	}

	const layers: Phase[][] = [];
	let frontier = phases.filter((p) => (indeg.get(p.id) ?? 0) === 0);
	const seen = new Set<string>();

	while (frontier.length > 0) {
		layers.push(frontier);
		const next: Phase[] = [];
		for (const p of frontier) {
			seen.add(p.id);
			for (const dep of dependents.get(p.id) ?? []) {
				indeg.set(dep, (indeg.get(dep) ?? 0) - 1);
				if ((indeg.get(dep) ?? 0) === 0 && !seen.has(dep)) next.push(byId.get(dep)!);
			}
		}
		frontier = next;
	}
	return layers;
}

/** Resolve which phase is the result-bearing phase. */
export function finalPhase(phases: Phase[]): Phase {
	return phases.find((p) => p.final) ?? phases[phases.length - 1];
}

/**
 * Apply a flow's declared arg defaults over the provided values, then pass
 * through any extra provided keys. Shared by the tool entrypoint (index) and the
 * sub-flow (`flow`) phase (runtime).
 */
export function resolveArgs(def: Taskflow, provided?: Record<string, unknown>): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	for (const [key, spec] of Object.entries(def.args ?? {})) {
		if (provided && key in provided) args[key] = provided[key];
		else if (spec.default !== undefined) args[key] = spec.default;
	}
	if (provided) for (const [k, v] of Object.entries(provided)) if (!(k in args)) args[k] = v;
	return args;
}
