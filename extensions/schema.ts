/**
 * Taskflow DSL — schema, types, and validation.
 *
 * A taskflow is a declarative, multi-phase workflow. Each phase delegates work
 * to a subagent (an isolated `pi` process). Phases form a DAG via `dependsOn`.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

// ---------------------------------------------------------------------------
// Phase types
// ---------------------------------------------------------------------------

export const PHASE_TYPES = ["agent", "parallel", "map", "gate", "reduce"] as const;
export type PhaseType = (typeof PHASE_TYPES)[number];

export const OUTPUT_FORMATS = ["text", "json"] as const;

const ParallelTaskSchema = Type.Object(
	{
		task: Type.String({ description: "Task for this parallel branch (supports interpolation)" }),
		agent: Type.Optional(Type.String({ description: "Override the phase agent for this branch" })),
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

		dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Phase ids this phase depends on" })),
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
		agentScope: Type.Optional(
			StringEnum(["user", "project", "both"] as const, { description: "Agent discovery scope", default: "user" }),
		),
		phases: Type.Array(PhaseSchema, { minItems: 1, description: "Ordered phase definitions (DAG via dependsOn)" }),
	},
	{ additionalProperties: false },
);

export type ParallelTask = Static<typeof ParallelTaskSchema>;
export type Phase = Static<typeof PhaseSchema>;
export type Taskflow = Static<typeof TaskflowSchema>;
export type ArgSpec = Static<typeof ArgSpecSchema>;

// ---------------------------------------------------------------------------
// Validation (beyond schema: DAG integrity, phase-type requirements)
// ---------------------------------------------------------------------------

export interface ValidationResult {
	ok: boolean;
	errors: string[];
}

export function validateTaskflow(def: unknown): ValidationResult {
	const errors: string[] = [];

	if (typeof def !== "object" || def === null) {
		return { ok: false, errors: ["Taskflow must be an object"] };
	}
	const flow = def as Partial<Taskflow>;

	if (!flow.name || typeof flow.name !== "string") errors.push("Missing or invalid 'name'");
	if (!Array.isArray(flow.phases) || flow.phases.length === 0) {
		errors.push("Taskflow must have at least one phase");
		return { ok: false, errors };
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
	const finals = (flow.phases as Phase[]).filter((p) => p.final);
	if (finals.length > 1) errors.push(`Only one phase may be marked 'final' (found ${finals.length})`);

	return { ok: errors.length === 0, errors };
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
