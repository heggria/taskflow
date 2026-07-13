/**
 * Genuine Taskflow → FlowIR compiler (RFC §5.2, S0).
 *
 * This graduates the stub `translateTaskflow` into a **canonical** IR emitter:
 * 1:1 phase→node projection (native multi-node lowering deferred per §12),
 * declared inject/emits, explicit edges, normalized `when` via {@link normalizeCond},
 * and richer optional node fields (`task`, `deps`, `join`, `timeout`, `condRef`).
 *
 * Pure, synchronous, never throws — diagnostics live in the return value so
 * `/tf ir` on a broken flow still yields a structured report.
 *
 * @see docs/rfc-0.2.0-architecture.md §5
 * @see ./translate.ts (stub; still used for sidecar field list parity)
 */

import { collectRefs, PHASE_TYPES, type Phase, type PhaseType, type Taskflow } from "../schema.ts";
import { cwdArgName } from "../cwd-bridge.ts";
import { normalizeCond } from "./cond.ts";
import type {
	FlowIR as CanonicalFlowIR,
	FlowIREdge,
	FlowIRNode as CanonicalFlowIRNode,
	FlowIRNodeKind,
} from "./schema.ts";
import type {
	CompileError,
	CompileWarning,
	DeclaredDeps,
	FlowIR,
	FlowIRNode,
	TaskflowIRMeta,
} from "./meta.ts";

// Keep in sync with translate.ts SIDECAR_PHASE_FIELDS (round-trip lossless).
const SIDECAR_PHASE_FIELDS = [
	"agent",
	"task",
	"over",
	"as",
	"branches",
	"from",
	"use",
	"def",
	"with",
	"run",
	"input",
	"timeout",
	"until",
	"maxIterations",
	"convergence",
	"reflexion",
	"variants",
	"judge",
	"judgeAgent",
	"mode",
	"dependsOn",
	"join",
	"when",
	"retry",
	"output",
	"expect",
	"model",
	"thinking",
	"tools",
	"cwd",
	"final",
	"optional",
	"idempotent",
	"concurrency",
	"context",
	"contextLimit",
	"onBlock",
	"eval",
	"score",
	"cache",
	"shareContext",
	"cancelLosers",
	"expandMode",
	"maxNodes",
] as const;

const NODE_FIELD_KEYS = new Set<string>(["task", "dependsOn", "join", "when", "timeout"]);

const VALID_KINDS = new Set<string>(PHASE_TYPES);

function sidecarForPhase(phase: Phase): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const rec = phase as Record<string, unknown>;
	for (const k of SIDECAR_PHASE_FIELDS) {
		if (k in rec && rec[k] !== undefined) out[k] = rec[k];
	}
	return out;
}

function payloadForPhase(phase: Phase): Record<string, unknown> | undefined {
	const sidecar = sidecarForPhase(phase);
	for (const key of NODE_FIELD_KEYS) delete sidecar[key];
	const argName = cwdArgName(phase.cwd);
	if (argName !== undefined) {
		// Canonical IR records logical resource semantics only. The authored raw
		// placeholder remains in meta.sidecar for lossless decompilation.
		delete sidecar.cwd;
		sidecar.cwdUse = {
			kind: "invocation-relative-arg",
			arg: argName,
			access: "read-write",
			intent: "existing-directory",
		};
	}
	return Object.keys(sidecar).length > 0 ? sidecar : undefined;
}

function asKind(type: string | undefined): FlowIRNodeKind {
	const k = (type ?? "agent") as PhaseType;
	if (VALID_KINDS.has(k)) return k as FlowIRNodeKind;
	// Unknown kinds still project as agent for IR shape; validation is source of truth.
	return "agent";
}

/**
 * Result of {@link compileTaskflowToFlowIR}: canonical IR + declared meta + diagnostics.
 * `usedFallbackHash` is **false** when the IR is well-formed enough to content-address
 * (always, unless hard errors prevent IR emission).
 *
 * Named separately from Mermaid `compileTaskflow` in `../compile.ts` (diagram).
 */
export interface CompileTaskflowToFlowIRResult {
	/** Canonical FlowIR (superset of the stub projection). */
	canonical: CanonicalFlowIR;
	/** Stub-compatible IR projection (same nodes without requiring consumers to import schema.ts). */
	ir: FlowIR;
	meta: TaskflowIRMeta;
	warnings: CompileWarning[];
	errors: CompileError[];
	/** False once the genuine compiler owns the hash (S0). */
	usedFallbackHash: boolean;
}

/**
 * Compile a (desugared) Taskflow into canonical FlowIR.
 *
 * - One node per phase (1:1).
 * - `inject` = `{steps.*}` refs ∪ `dependsOn` (minus self).
 * - `emits` = `[phase.id]`.
 * - `edges` synthesized from inject for graph consumers.
 * - `when` kept as source text; `condRef` = normalizeCond(canonical) when present.
 * - Optional fields: task, deps, join, timeout copied when set.
 *
 * Never throws.
 */
export function compileTaskflowToFlowIR(def: Taskflow): CompileTaskflowToFlowIRResult {
	const warnings: CompileWarning[] = [];
	const errors: CompileError[] = [];
	const declaredDeps: Record<string, DeclaredDeps> = {};
	const sidecarPhases: Record<string, unknown> = {};
	const knownIds = new Set((def.phases ?? []).map((p) => p.id));

	if (!def.name || typeof def.name !== "string") {
		errors.push({ code: "missing-name", message: "Taskflow.name is required" });
	}
	if (!Array.isArray(def.phases) || def.phases.length === 0) {
		errors.push({ code: "empty-phases", message: "Taskflow.phases must be a non-empty array" });
	}

	const nodes: CanonicalFlowIRNode[] = [];
	const edges: FlowIREdge[] = [];

	for (const phase of def.phases ?? []) {
		if (!phase?.id) {
			errors.push({ code: "missing-phase-id", message: "Phase missing id" });
			continue;
		}
			const refs = collectRefs(phase);
			const reads = new Set<string>(refs.steps.filter((id) => id !== phase.id));
			for (const d of phase.dependsOn ?? []) {
				if (d !== phase.id) reads.add(d);
			}
			for (const d of phase.from ?? []) {
				if (d !== phase.id) reads.add(d);
			}
			const inject = Array.from(reads);
		declaredDeps[phase.id] = { reads: inject, writes: [phase.id] };

		for (const r of refs.steps) {
			if (r !== phase.id && !knownIds.has(r)) {
				warnings.push({
					phaseId: phase.id,
					message: `references {steps.${r}.*} but no phase '${r}' exists`,
				});
			}
		}

		const kind = asKind(phase.type);
		if (phase.type && !VALID_KINDS.has(phase.type)) {
			warnings.push({
				phaseId: phase.id,
				message: `unknown phase type '${phase.type}' — projected as kind 'agent'`,
			});
		}

		const node: CanonicalFlowIRNode = {
			id: phase.id,
			kind,
			inject,
			emits: [phase.id],
		};

		if (phase.when !== undefined) {
			node.when = phase.when;
			const n = normalizeCond(phase.when);
			// condRef is a stable, hashable form of the guard (not a storage key).
			node.condRef = n.canonical || undefined;
		}
		if (typeof phase.task === "string") node.task = phase.task;
			if (phase.dependsOn && phase.dependsOn.length > 0) node.deps = [...phase.dependsOn];
			if (phase.join === "all" || phase.join === "any") node.join = phase.join;
			if (typeof phase.timeout === "number") node.timeout = phase.timeout;
			const payload = payloadForPhase(phase);
			if (payload) node.payload = payload;

		for (const from of inject) {
			edges.push({ from, to: phase.id });
		}

		sidecarPhases[phase.id] = sidecarForPhase(phase);
		nodes.push(node);
	}

	const canonical: CanonicalFlowIR = {
		name: def.name || "unnamed",
		version: typeof def.version === "number" ? def.version : 1,
		nodes,
		edges: edges.length > 0 ? edges : undefined,
		args: def.args as Record<string, unknown> | undefined,
		budget: def.budget,
		concurrency: def.concurrency,
		meta: {
			source: "taskflow-core",
			irVersion: 1,
			// These flow-level switches change agent discovery / runtime inputs and
			// therefore MUST participate in the content-addressed cache identity.
			// Keeping them in canonical meta preserves the 1:1 node projection while
			// preventing two semantically different flows from sharing an IR hash.
			annotations: {
				agentScope: def.agentScope ?? "user",
				contextSharing: def.contextSharing ?? false,
			},
		},
	};

	// Stub-compatible projection: strip fields meta.FlowIR doesn't declare but keep inject/emits/when/kind.
	const ir: FlowIR = {
		name: canonical.name,
		nodes: nodes.map(
			(n): FlowIRNode => ({
				id: n.id,
				kind: n.kind,
				inject: n.inject,
				emits: n.emits,
				when: n.when,
			}),
		),
		args: def.args,
		budget: def.budget,
		concurrency: def.concurrency,
	};

	const meta: TaskflowIRMeta = {
		sourceFlowName: def.name || "unnamed",
		declaredDeps,
		sidecar: { phases: sidecarPhases },
	};

	// Genuine compiler owns the IR hash when we produced nodes.
	const usedFallbackHash = nodes.length === 0 || errors.some((e) => e.code === "empty-phases");

	return { canonical, ir, meta, warnings, errors, usedFallbackHash };
}
