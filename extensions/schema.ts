/**
 * Taskflow DSL — schema, types, and validation.
 *
 * A taskflow is a declarative, multi-phase workflow. Each phase delegates work
 * to a subagent (an isolated `pi` process). Phases form a DAG via `dependsOn`.
 */

import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

// ---------------------------------------------------------------------------
// Phase types
// ---------------------------------------------------------------------------

export const PHASE_TYPES = ["agent", "parallel", "map", "gate", "reduce", "approval", "flow"] as const;
export type PhaseType = (typeof PHASE_TYPES)[number];

export const OUTPUT_FORMATS = ["text", "json"] as const;
export const JOIN_MODES = ["all", "any"] as const;

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

		// parallel static branches
		branches: Type.Optional(Type.Array(ParallelTaskSchema, { description: "[parallel] Static task branches" })),

		// reduce
		from: Type.Optional(
			Type.Array(Type.String(), { description: "[reduce] Phase ids whose outputs are aggregated" }),
		),

		// sub-workflow (flow)
		use: Type.Optional(Type.String({ description: "[flow] Name of a saved taskflow to run as this phase" })),
		with: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description: "[flow] Args passed to the sub-flow (string values support interpolation)",
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
		model: Type.Optional(Type.String({ description: "Model override for this phase" })),
		thinking: Type.Optional(Type.String({ description: "Thinking level override for this phase" })),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Restrict tools for this phase's agent" })),
		cwd: Type.Optional(Type.String({ description: "Working directory for this phase's subagent" })),
		final: Type.Optional(Type.Boolean({ description: "Mark this phase's output as the workflow result" })),
		optional: Type.Optional(
			Type.Boolean({ description: "If true, a failure does not abort the run", default: false }),
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
		name: Type.String({ description: "Workflow name (becomes /tf:<name> command when saved)" }),
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
		phases: Type.Array(PhaseSchema, { minItems: 1, description: "Ordered phase definitions (DAG via dependsOn)" }),
		implicitGate: Type.Optional(
			Type.Boolean({
				description: "When true (default), a reviewer gate is auto-injected after all phases if no explicit gate or approval exists",
				default: true,
			}),
		),
	},
	{ additionalProperties: false },
);

export type ParallelTask = Static<typeof ParallelTaskSchema>;
export type Phase = Static<typeof PhaseSchema>;
export type Taskflow = Static<typeof TaskflowSchema>;
export type ArgSpec = Static<typeof ArgSpecSchema>;
export type RetryPolicy = Static<typeof RetrySchema>;
export type Budget = Static<typeof BudgetSchema>;
export type JoinMode = (typeof JOIN_MODES)[number];

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

function readStep(s: unknown): ShorthandStep {
	if (typeof s === "string") return { task: s };
	if (s && typeof s === "object") {
		const o = s as Record<string, unknown>;
		return { agent: typeof o.agent === "string" ? o.agent : undefined, task: String(o.task ?? "") };
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
		const steps = d.chain.map(readStep);
		const phases: Phase[] = steps.map((s, i) => {
			const phase: Phase = { id: `step${i + 1}`, type: "agent", task: s.task };
			if (s.agent) phase.agent = s.agent;
			if (i > 0) phase.dependsOn = [`step${i}`];
			if (i === steps.length - 1) phase.final = true;
			return phase;
		});
		return { name: nameOf("chain"), ...meta, phases };
	}

	// tasks → one parallel phase (fan-out + merge), no extra aggregation agent
	if (Array.isArray(d.tasks) && d.tasks.length > 0) {
		const branches: ParallelTask[] = d.tasks.map(readStep).map((s) => (s.agent ? { task: s.task, agent: s.agent } : { task: s.task }));
		return { name: nameOf("parallel"), ...meta, phases: [{ id: "parallel", type: "parallel", branches, final: true }] };
	}

	// single task → one agent phase
	if (typeof d.task === "string") {
		const phase: Phase = { id: "main", type: "agent", task: d.task, final: true };
		if (typeof d.agent === "string") phase.agent = d.agent;
		return { name: nameOf("task"), ...meta, phases: [phase] };
	}

	throw new Error("Shorthand spec needs one of: 'task' (single), 'tasks' (parallel), or 'chain' (sequential)");
}

// ---------------------------------------------------------------------------
// Validation (beyond schema: DAG integrity, phase-type requirements)
// ---------------------------------------------------------------------------

export interface ValidationResult {
	ok: boolean;
	errors: string[];
	/** Non-fatal issues the user should fix; e.g. `{steps.X}` references that
	 *  aren't declared in `dependsOn` (the phase will run in parallel with its
	 *  producer and see the literal placeholder). */
	warnings: string[];
}

export interface ValidationOptions {
	/** Resolved invocation args, used for runtime checks like missing `{args.X}`. */
	args?: Record<string, unknown>;
	/** Runtime working directory, used for mismatch warnings (e.g. cwd vs args.codebase). */
	cwd?: string;
	/** Override the flow's own `strictInterpolation` flag for this validation call. */
	strict?: boolean;
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
		if (ids.has(p.id)) errors.push(`Duplicate phase id: ${p.id}`);
		ids.add(p.id);

		const type = (p.type ?? "agent") as PhaseType;
		if (!PHASE_TYPES.includes(type)) errors.push(`Phase '${p.id}': unknown type '${type}'`);

		// Per-type requirements
		if (type === "agent" || type === "gate") {
			if (!p.task) errors.push(`Phase '${p.id}' (${type}) requires 'task'`);
		}
		if (type === "map") {
			if (!p.over) errors.push(`Phase '${p.id}' (map) requires 'over'`);
			if (!p.task) errors.push(`Phase '${p.id}' (map) requires 'task'`);
		}
		if (type === "parallel") {
			if (!p.branches || p.branches.length === 0)
				errors.push(`Phase '${p.id}' (parallel) requires non-empty 'branches'`);
		}
		if (type === "reduce") {
			if (!p.from || p.from.length === 0) errors.push(`Phase '${p.id}' (reduce) requires 'from'`);
			if (!p.task) errors.push(`Phase '${p.id}' (reduce) requires 'task'`);
		}
		if (type === "flow") {
			if (!p.use) errors.push(`Phase '${p.id}' (flow) requires 'use' (a saved flow name)`);
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
	}

	// dependsOn / from references must exist
	for (const p of flow.phases) {
		if (!p?.id) continue;
		for (const dep of p.dependsOn ?? []) {
			if (!ids.has(dep)) errors.push(`Phase '${p.id}': dependsOn unknown phase '${dep}'`);
		}
		for (const f of p.from ?? []) {
			if (!ids.has(f)) errors.push(`Phase '${p.id}': from unknown phase '${f}'`);
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
	// Phases with `join: "any"` are exempt: by design they only need ONE of
	// their declared deps to complete, and may reference other phases as
	// informational context (not as true dependencies).
	if (errors.length === 0) {
		const idToPhase = new Map((flow.phases as Phase[]).map((p) => [p.id, p]));
		for (const p of flow.phases as Phase[]) {
			if (!p?.id) continue;
			const isJoinAny = p.join === "any";
			if (isJoinAny) continue;
			const deps = new Set(dependenciesOf(p));
			const refs = collectRefs(p);
			for (const ref of refs.steps) {
				if (ref === p.id) {
					errors.push(`Phase '${p.id}': references its own output via {steps.${ref}.*}; this is almost always a bug.`);
					continue;
				}
				if (!idToPhase.has(ref)) {
					// Unknown ref is already an error from the dependsOn check, but
					// {steps.X.*} can appear in a task without dependsOn. Don't
					// double-warn — the dependsOn loop above already flags it.
					continue;
				}
				if (!deps.has(ref)) {
					errors.push(
						`Phase '${p.id}': task references {steps.${ref}.*} but '${ref}' is not in dependsOn. ` +
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

function collectRefs(phase: Phase): { steps: string[]; args: string[] } {
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
	for (const b of phase.branches ?? []) scan(b.task);
	for (const v of Object.values(phase.with ?? {})) if (typeof v === "string") scan(v);
	for (const c of phase.context ?? []) scan(c);
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

/** Effective dependency ids of a phase (dependsOn ∪ from). */
export function dependenciesOf(phase: Phase): string[] {
	const set = new Set<string>([...(phase.dependsOn ?? []), ...(phase.from ?? [])]);
	return Array.from(set);
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
