/**
 * # Canonical FlowIR type contract
 *
 * This module formalizes the **canonical FlowIR** (Flow Intermediate
 * Representation) type contract for the overstory-convergence roadmap. It is a
 * **superset** of the implicit shape that `./translate.ts` already produces
 * (mirrored structurally in `./meta.ts`): every `FlowIR`/`FlowIRNode` emitted
 * by `translateTaskflow` satisfies the types defined here, and these types add
 * the missing formalization — a closed `FlowIRNodeKind` literal union, an
 * explicit `FlowIREdge` model, structural `FlowIRBudget`/`FlowIRMeta`, and
 * optional lightweight TypeBox guards.
 *
 * **Provenance & ownership (Q2=B, Q5=own):** this is pi-taskflow's *own* type
 * contract — not vendored from overstory. `flowir/compile.ts` (batch 2 of the
 * roadmap) will emit this canonical shape; the event-sourced kernel executes
 * it. `translate.ts`'s 1:1 projection is a *read-only stub* that already
 * conforms to this contract today, so formalizing here is purely additive —
 * it must not break `translate.ts`, `meta.ts`, `hash.ts`, or any barrel.
 *
 * **Compatibility note:** the canonical `FlowIRNode.kind` is the closed
 * `FlowIRNodeKind` literal union (the closed set of native phase kinds = `PHASE_TYPES`), whereas
 * `meta.ts`'s `FlowIRNode.kind` is `string` (a 1:1 projection). Every value
 * `translate.ts` produces for `kind` (`phase.type ?? "agent"`) is a member of
 * `FlowIRNodeKind`, so the canonical type is a strict refinement that
 * subsumes the stub output. Code that needs the looser projection can keep
 * using `meta.ts`; code that wants the closed contract imports from here.
 *
 * **Purity:** zero runtime deps beyond `typebox`. No IO, no Date, no
 * randomness. Guards are pure functions over plain JSON values.
 *
 * @see docs/internal/overstory-convergence-roadmap.md §3 (M1), §6 (compile seam)
 * @see docs/internal/rfc-flowir-compilation.md
 */

import { Type } from "typebox";
import { StringEnum } from "../typebox-helpers.ts";
import { PHASE_TYPES, type PhaseType } from "../schema.ts";

// ---------------------------------------------------------------------------
// FlowIRNodeKind — closed literal union = PHASE_TYPES (currently 12 kinds)
// ---------------------------------------------------------------------------

/**
 * The closed set of pi-taskflow phase kinds, derived 1:1 from the exported
 * {@link PHASE_TYPES} in `../schema.ts` (single source of truth). This is the
 * canonical `FlowIRNode.kind` vocabulary. `translate.ts` sets
 * `kind = phase.type ?? "agent"`, so every node it emits is a member of this
 * union. Adding a phase kind requires updating `PHASE_TYPES` only — FlowIR
 * follows automatically.
 *
 * | kind        | purpose                                                  |
 * |-------------|----------------------------------------------------------|
 * | `agent`     | single subagent call                                     |
 * | `parallel`  | static concurrent branches                               |
 * | `map`       | dynamic fan-out over an array (one subagent per item)   |
 * | `gate`      | quality gate — can halt the flow on VERDICT: BLOCK      |
 * | `reduce`    | aggregate multiple upstream outputs into one            |
 * | `approval`  | human-in-the-loop pause (approve/reject/edit)           |
 * | `flow`      | run a saved sub-taskflow as a single phase              |
 * | `loop`      | repeat body until condition, convergence, or max iters  |
 * | `tournament`| N competing variants + judge picks best / aggregates    |
 * | `script`    | run a shell command (no LLM, zero tokens)               |
 */
export const FlowIRNodeKind = StringEnum(PHASE_TYPES, {
	description: "Native phase kinds — 1:1 projection of PHASE_TYPES (agent…script, race, expand, …)",
});
/** @see PHASE_TYPES — same closed set as the DSL. */
export type FlowIRNodeKind = PhaseType;

// ---------------------------------------------------------------------------
// FlowIRNode — canonical node contract
// ---------------------------------------------------------------------------

/**
 * A single canonical FlowIR node — one per pi-taskflow phase.
 *
 * This is a **superset** of the node shape `translate.ts` emits. The stub
 * attaches exactly `{ id, kind, inject, emits, when? }`; this contract
 * additionally formalizes the optional fields a genuine compiler (batch 2,
 * `flowir/compile.ts`) and the event-sourced kernel will populate:
 *
 * - `task`     — the resolved (interpolated) task prompt, when materialized.
 * - `condRef`  — a reference to a compiled condition descriptor (the lowered
 *                form of `when`; see `flowir/cond.ts`). Absent on the stub,
 *                which passes `when` through verbatim.
 * - `deps`     — explicit `dependsOn` edges carried onto the node (the stub
 *                folds these into `inject`; a compiler may keep them
 *                separate for the edge model).
 * - `join`     — join mode (`"all"` default, or `"any"` for OR-join).
 * - `timeout`  — per-call ms cap (agent-running phases).
 * - `payload`  — stable, hash-addressed DSL payload fields not otherwise
 *                represented above (for example branch bodies, script command,
 *                map source, flow/expand definitions, output contracts).
 *
 * All added fields are **optional** so the stub's minimal output remains valid.
 */
export interface FlowIRNode {
	/** Unique phase identifier (referenced via `{steps.<id>.output}`). */
	id: string;
	/** The native phase kind — a member of {@link FlowIRNodeKind}. */
	kind: FlowIRNodeKind;
	/**
	 * Synthesized declared reads: the upstream step ids whose outputs this
	 * node injects. In the stub this is `{steps.X}` refs ∪ `dependsOn`
	 * (minus self); a genuine compiler lowers this to overstory's inject
	 * model.
	 */
	inject: string[];
	/** What this node emits — currently `[id]` (1:1 projection). */
	emits: string[];
	/** Raw `when` guard passthrough (stub: not rewritten to IR conditions). */
	when?: string;
	/** Resolved (interpolated) task prompt, when materialized by a compiler. */
	task?: string;
	/** Reference to a compiled condition descriptor (lowered `when`). */
	condRef?: string;
	/** Explicit `dependsOn` edges carried onto the node (optional). */
	deps?: string[];
	/** Join mode: `"all"` (default AND-join) or `"any"` (OR-join). */
	join?: "all" | "any";
	/** Per-subagent-call ms cap (agent-running phases). */
	timeout?: number;
	/** Runtime-affecting DSL payload not otherwise modeled by the core node fields. */
	payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// FlowIREdge — explicit edge model (optional; the stub uses `inject` only)
// ---------------------------------------------------------------------------

/**
 * A directed edge in the FlowIR DAG. `from` is the upstream (producer) node
 * id; `to` is the downstream (consumer) node id. The stub projection encodes
 * edges implicitly via `FlowIRNode.inject` (and `dependsOn`); a genuine
 * compiler may emit an explicit `edges` list for graph consumers (renderers,
 * topo sorters). When present, `edges` must be consistent with `inject`.
 */
export interface FlowIREdge {
	/** Upstream (producer) node id. */
	from: string;
	/** Downstream (consumer) node id. */
	to: string;
}

// ---------------------------------------------------------------------------
// FlowIRBudget — run-wide cost / token ceiling
// ---------------------------------------------------------------------------

/**
 * Run-wide budget ceiling. Exceeding it halts the run (remaining phases are
 * skipped). Structurally identical to the DSL `Budget` (schema.ts); mirrored
 * here so the FlowIR contract is self-contained and doesn't leak DSL types to
 * pure IR consumers (the event-sourced kernel).
 */
export interface FlowIRBudget {
	/** Halt once accumulated cost exceeds this many USD. */
	maxUSD?: number;
	/** Halt once accumulated input+output tokens exceed this. */
	maxTokens?: number;
}

// ---------------------------------------------------------------------------
// FlowIRMeta — flow-level metadata (optional, compiler-populated)
// ---------------------------------------------------------------------------

/**
 * Optional flow-level metadata attached to a compiled FlowIR. Populated by a
 * genuine compiler; absent on the stub (which carries metadata in
 * `TaskflowIRMeta`, not on the IR itself). Kept loose (`Record<string,
 * unknown>`) so the contract is forward-compatible without churn.
 */
export interface FlowIRMeta {
	/** Origin tool/host (e.g. `"pi"`, `"codex"`). */
	source?: string;
	/** Schema version of the IR emitter. */
	irVersion?: number;
	/** Free-form compiler diagnostics / annotations. */
	annotations?: Record<string, unknown>;
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// FlowIR — the canonical compiled IR
// ---------------------------------------------------------------------------

/**
 * The canonical compiled FlowIR. A **superset** of `meta.ts`'s `FlowIR`:
 * - `version` is formalized (maps to the DSL `Taskflow.version`).
 * - `edges` is the optional explicit edge model (absent on the stub).
 * - `meta` is the optional flow-level metadata (absent on the stub).
 *
 * Every `FlowIR` produced by `translateTaskflow` — `{ name, nodes, args?,
 * budget?, concurrency? }` — satisfies this contract (the added fields are all
 * optional). `compile.ts` (batch 2) emits the full canonical form.
 */
export interface FlowIR {
	/** Workflow name (the DSL `Taskflow.name`). */
	name: string;
	/** DSL schema version (maps to `Taskflow.version`, default 1). */
	version?: number;
	/** The flat list of IR nodes (one per phase). */
	nodes: FlowIRNode[];
	/** Optional explicit edge list (consistent with `inject`). */
	edges?: FlowIREdge[];
	/** Declared invocation arguments (DSL `Taskflow.args`). */
	args?: Record<string, unknown>;
	/** Run-wide cost / token ceiling. */
	budget?: FlowIRBudget;
	/** Default max concurrent subagents. */
	concurrency?: number;
	/** Optional flow-level metadata (compiler-populated). */
	meta?: FlowIRMeta;
}

// ---------------------------------------------------------------------------
// TypeBox schemas (for runtime validation / structural guards)
// ---------------------------------------------------------------------------

/**
 * TypeBox schema mirroring {@link FlowIRNode}. Used by the structural guards
 * below. Kept in sync by construction (the `Static` of this schema *is*
 * `FlowIRNode`); if the interface above drifts, this schema must be updated to
 * match.
 */
export const FlowIRNodeSchema = Type.Object(
	{
		id: Type.String({ description: "Unique phase identifier" }),
		kind: FlowIRNodeKind,
		inject: Type.Array(Type.String(), { description: "Declared reads (upstream step ids)" }),
		emits: Type.Array(Type.String(), { description: "What this node emits (currently [id])" }),
		when: Type.Optional(Type.String({ description: "Raw when guard passthrough" })),
		task: Type.Optional(Type.String({ description: "Resolved task prompt" })),
		condRef: Type.Optional(Type.String({ description: "Reference to a compiled condition descriptor" })),
		deps: Type.Optional(Type.Array(Type.String(), { description: "Explicit dependsOn edges" })),
		join: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("any")], { description: "Join mode" })),
		timeout: Type.Optional(Type.Number({ description: "Per-call ms cap" })),
		payload: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description: "Runtime-affecting DSL payload not otherwise modeled by the core node fields",
			}),
		),
	},
	{ additionalProperties: false },
);

/**
 * TypeBox schema mirroring {@link FlowIREdge}.
 */
export const FlowIREdgeSchema = Type.Object(
	{
		from: Type.String({ description: "Upstream (producer) node id" }),
		to: Type.String({ description: "Downstream (consumer) node id" }),
	},
	{ additionalProperties: false },
);

/**
 * TypeBox schema mirroring {@link FlowIR}.
 */
export const FlowIRSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, description: "Workflow name" }),
		version: Type.Optional(Type.Number({ description: "DSL schema version" })),
		nodes: Type.Array(FlowIRNodeSchema, { minItems: 1, description: "IR nodes (one per phase)" }),
		edges: Type.Optional(Type.Array(FlowIREdgeSchema, { description: "Explicit edge list" })),
		args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Declared invocation arguments" })),
		budget: Type.Optional(
			Type.Object(
				{
					maxUSD: Type.Optional(Type.Number()),
					maxTokens: Type.Optional(Type.Number()),
				},
				{ additionalProperties: false },
			),
		),
		concurrency: Type.Optional(Type.Number({ description: "Default max concurrent subagents" })),
		meta: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Flow-level metadata" })),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Structural guards — pure, zero-dep (beyond typebox), fail-closed
// ---------------------------------------------------------------------------

/** The 10 valid phase kinds, for O(1) membership checks without TypeBox. */
const VALID_KINDS: ReadonlySet<string> = new Set<string>(PHASE_TYPES);

/**
 * Narrow an `unknown` value to a {@link FlowIRNode}. Pure, synchronous,
 * fail-closed: returns `false` for anything that is not a plain object with
 * a string `id`, a valid `kind`, and string-array `inject`/`emits`. Does not
 * throw. This is a *structural* check (not a deep TypeBox decode) so it stays
 * cheap and dependency-light; use {@link assertFlowIR} for full validation.
 */
export function isFlowIRNode(value: unknown): value is FlowIRNode {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const n = value as Record<string, unknown>;
	if (typeof n.id !== "string" || n.id.length === 0) return false;
	if (typeof n.kind !== "string" || !VALID_KINDS.has(n.kind)) return false;
	if (!isStringArray(n.inject)) return false;
	if (!isStringArray(n.emits)) return false;
	if (n.when !== undefined && typeof n.when !== "string") return false;
	if (n.task !== undefined && typeof n.task !== "string") return false;
	if (n.condRef !== undefined && typeof n.condRef !== "string") return false;
	if (n.deps !== undefined && !isStringArray(n.deps)) return false;
	if (n.join !== undefined && n.join !== "all" && n.join !== "any") return false;
	if (n.timeout !== undefined && typeof n.timeout !== "number") return false;
	if (n.payload !== undefined && (typeof n.payload !== "object" || n.payload === null || Array.isArray(n.payload))) {
		return false;
	}
	return true;
}

/** Type guard for a `string[]`. */
function isStringArray(v: unknown): v is string[] {
	if (!Array.isArray(v)) return false;
	return v.every((x) => typeof x === "string");
}

/**
 * Assert that a value is a well-formed {@link FlowIR}. Throws a descriptive
 * `Error` (not an `AssertionError`) on the first structural violation —
 * fail-closed, so a malformed IR can never silently reach the kernel. Uses
 * the lightweight structural checks (no external validator); for full schema
 * decoding, decode `FlowIRSchema` with a TypeBox-compatible checker.
 *
 * @throws {Error} if `value` is not a valid `FlowIR`.
 */
export function assertFlowIR(value: unknown): asserts value is FlowIR {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`FlowIR: expected an object, got ${typeof value}`);
	}
	const ir = value as Record<string, unknown>;
	if (typeof ir.name !== "string" || ir.name.length === 0) {
		throw new Error(`FlowIR: 'name' must be a non-empty string`);
	}
	if (ir.version !== undefined && typeof ir.version !== "number") {
		throw new Error(`FlowIR: 'version' must be a number if present`);
	}
	if (!Array.isArray(ir.nodes) || ir.nodes.length === 0) {
		throw new Error(`FlowIR: 'nodes' must be a non-empty array`);
	}
	const seenIds = new Set<string>();
	for (let i = 0; i < ir.nodes.length; i++) {
		const node = ir.nodes[i];
		if (!isFlowIRNode(node)) {
			throw new Error(`FlowIR: nodes[${i}] is not a valid FlowIRNode (id=${String((node as { id?: unknown })?.id)})`);
		}
		if (seenIds.has(node.id)) {
			throw new Error(`FlowIR: duplicate node id '${node.id}'`);
		}
		seenIds.add(node.id);
	}
	if (ir.edges !== undefined) {
		if (!Array.isArray(ir.edges)) {
			throw new Error(`FlowIR: 'edges' must be an array if present`);
		}
		for (let i = 0; i < ir.edges.length; i++) {
			const e = ir.edges[i] as Record<string, unknown> | null;
			if (
				typeof e !== "object" ||
				e === null ||
				typeof e.from !== "string" ||
				typeof e.to !== "string"
			) {
				throw new Error(`FlowIR: edges[${i}] must be { from: string, to: string }`);
			}
			if (!seenIds.has(e.from)) {
				throw new Error(`FlowIR: edges[${i}].from references unknown node '${e.from}'`);
			}
			if (!seenIds.has(e.to)) {
				throw new Error(`FlowIR: edges[${i}].to references unknown node '${e.to}'`);
			}
		}
	}
	if (ir.budget !== undefined) {
		if (typeof ir.budget !== "object" || ir.budget === null || Array.isArray(ir.budget)) {
			throw new Error(`FlowIR: 'budget' must be an object if present`);
		}
		const b = ir.budget as Record<string, unknown>;
		if (b.maxUSD !== undefined && typeof b.maxUSD !== "number") {
			throw new Error(`FlowIR: 'budget.maxUSD' must be a number if present`);
		}
		if (b.maxTokens !== undefined && typeof b.maxTokens !== "number") {
			throw new Error(`FlowIR: 'budget.maxTokens' must be a number if present`);
		}
	}
	if (ir.concurrency !== undefined && typeof ir.concurrency !== "number") {
		throw new Error(`FlowIR: 'concurrency' must be a number if present`);
	}
	if (ir.args !== undefined && (typeof ir.args !== "object" || ir.args === null || Array.isArray(ir.args))) {
		throw new Error(`FlowIR: 'args' must be an object if present`);
	}
	if (ir.meta !== undefined && (typeof ir.meta !== "object" || ir.meta === null || Array.isArray(ir.meta))) {
		throw new Error(`FlowIR: 'meta' must be an object if present`);
	}
}
