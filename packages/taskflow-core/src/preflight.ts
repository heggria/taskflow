/**
 * Preflight dry-run — zero-token plan before spend.
 *
 * Binds typed args, runs structural verify, projects a phase plan with
 * static/dynamic binding status, and computes a worst-case agent-call bound.
 */

import {
	asArray,
	collectRefs,
	desugar,
	isShorthand,
	LOOP_DEFAULT_MAX_ITERATIONS,
	LOOP_HARD_MAX_ITERATIONS,
	resolveArgs,
	topoLayers,
	type Phase,
	type Taskflow,
	validateInvocationArgs,
	validateTaskflow,
} from "./schema.ts";
import {
	type VerificationIssue,
	type VerificationResult,
	verifyTaskflow,
	type TaskflowVerifier,
} from "./verify.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreflightOptions {
	/** Invocation arguments (same shape as taskflow_run.args). */
	args?: Record<string, unknown>;
	/** When true (default), missing required typed args → ok:false. */
	strictArgs?: boolean;
	/** Optional plugin verifiers (same as verify/lint). */
	verifiers?: TaskflowVerifier[];
	/** Working directory for validateTaskflow cwd checks. */
	cwd?: string;
}

export type PreflightWhenKind = "always" | "static-true" | "static-false" | "dynamic";

export interface PreflightBinding {
	path: string;
	status: "bound" | "unresolved" | "dynamic";
	value?: string;
}

export interface PreflightPhasePlan {
	id: string;
	type: string;
	order: number;
	when: PreflightWhenKind;
	bindings: PreflightBinding[];
	agent?: string;
	modelHint?: string;
	notes?: string[];
}

export interface PreflightBudgetBound {
	maxAgentCalls: number | "unbounded";
	maxMapFanout?: number | "unbounded";
	phasesCounted: number;
	assumptions: string[];
}

export interface PreflightResult {
	ok: boolean;
	issues: VerificationIssue[];
	flowName: string;
	args: Record<string, unknown>;
	phases: PreflightPhasePlan[];
	budget: PreflightBudgetBound;
	summary: string;
	/** Structural verify result (may be empty if flow failed validation). */
	verify?: VerificationResult;
}

// ---------------------------------------------------------------------------
// when / binding helpers
// ---------------------------------------------------------------------------

const STEPS_PLACEHOLDER = /\{steps\.[a-zA-Z0-9_-]+/;
const PREVIOUS_PLACEHOLDER = /\{previous\.|\{item\b|\{reflexion\b/;
const ARGS_PLACEHOLDER = /\{args\.([a-zA-Z0-9_-]+)(?:\.[a-zA-Z0-9_-]+)*\}/g;

function templateIsDynamic(s: string | undefined): boolean {
	if (!s) return false;
	return STEPS_PLACEHOLDER.test(s) || PREVIOUS_PLACEHOLDER.test(s);
}

/** Classify a `when` guard for preflight (args-only static evaluation). */
export function classifyWhen(when: string | undefined, args: Record<string, unknown>): PreflightWhenKind {
	if (!when || !when.trim()) return "always";
	if (templateIsDynamic(when)) return "dynamic";
	// Only args — try a tiny static truthiness check for simple forms.
	const onlyArgs = when.replace(ARGS_PLACEHOLDER, (_, name: string) => {
		const v = args[name];
		if (v === undefined) return "{missing}";
		return String(v);
	});
	if (onlyArgs.includes("{")) return "dynamic";
	// Simple literals after arg substitution
	const t = onlyArgs.trim().toLowerCase();
	if (t === "true" || t === "1" || t === "yes") return "static-true";
	if (t === "false" || t === "0" || t === "no" || t === "") return "static-false";
	// Equality on args: `{args.x}==foo` already substituted above if exact
	if (/^(true|false)$/i.test(t)) return t.toLowerCase() === "true" ? "static-true" : "static-false";
	// Conservative: treat non-trivial static expressions as dynamic (fail-open at plan)
	if (!STEPS_PLACEHOLDER.test(when) && !PREVIOUS_PLACEHOLDER.test(when)) {
		// If no missing args placeholders left, we still may not eval full condition language —
		// mark dynamic so we never skip a phase that should run.
		return "dynamic";
	}
	return "dynamic";
}

function collectTemplates(phase: Phase): string[] {
	const out: string[] = [];
	const push = (s: unknown) => {
		if (typeof s === "string" && s.includes("{")) out.push(s);
	};
	push(phase.task);
	push(phase.over);
	push(phase.when);
	push(phase.until);
	push(phase.cwd);
	if (Array.isArray(phase.run)) for (const r of phase.run) push(r);
	push(phase.input);
	if (typeof phase.def === "string") push(phase.def);
	for (const e of asArray<string>(phase.eval)) push(e);
	const score = (phase as { score?: { target?: unknown; judge?: { task?: unknown } } }).score;
	if (score && typeof score === "object") {
		push(score.target);
		if (score.judge && typeof score.judge === "object") push(score.judge.task);
	}
	return out;
}

function bindingsForPhase(phase: Phase, args: Record<string, unknown>): PreflightBinding[] {
	const refs = collectRefs(phase);
	const bindings: PreflightBinding[] = [];
	for (const a of refs.args) {
		if (a in args && args[a] !== undefined) {
			bindings.push({ path: `args.${a}`, status: "bound", value: stringifyBound(args[a]) });
		} else {
			bindings.push({ path: `args.${a}`, status: "unresolved" });
		}
	}
	for (const s of refs.steps) {
		bindings.push({ path: `steps.${s}`, status: "dynamic" });
	}
	// Also flag previous/item style dynamics from templates
	for (const t of collectTemplates(phase)) {
		if (PREVIOUS_PLACEHOLDER.test(t) && !bindings.some((b) => b.path.startsWith("previous") || b.path === "item")) {
			if (/\{previous\./.test(t)) bindings.push({ path: "previous.output", status: "dynamic" });
			if (/\{item\b/.test(t)) bindings.push({ path: "item", status: "dynamic" });
		}
	}
	return bindings;
}

function stringifyBound(v: unknown): string {
	if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 77)}…` : v;
	try {
		const s = JSON.stringify(v);
		return s.length > 80 ? `${s.slice(0, 77)}…` : s;
	} catch {
		return String(v);
	}
}

// ---------------------------------------------------------------------------
// Budget bound
// ---------------------------------------------------------------------------

const LLM_TYPES = new Set([
	"agent",
	"gate",
	"reduce",
	"map",
	"parallel",
	"loop",
	"tournament",
	"race",
]);

export function computeBudgetBound(phases: Phase[], args: Record<string, unknown> = {}): PreflightBudgetBound {
	const assumptions: string[] = [];
	let unbounded = false;
	let maxMapFanout: number | "unbounded" | undefined;
	let total = 0;

	const byId = new Map(phases.map((p) => [p.id, p]));

	const boundPhase = (p: Phase, stack: Set<string>): number | "unbounded" => {
		if (stack.has(p.id)) {
			assumptions.push(`cycle involving '${p.id}' treated as unbounded`);
			return "unbounded";
		}
		const when = classifyWhen(p.when, args);
		if (when === "static-false") return 0;

		const type = p.type ?? "agent";
		const next = new Set(stack);
		next.add(p.id);

		if (type === "script" || type === "approval") return 0;

		if (type === "agent" || type === "gate" || type === "reduce") {
			if (type === "reduce" && (p as { reduceStrategy?: string }).reduceStrategy === "tree") {
				assumptions.push(`phase '${p.id}': tree-reduce worst-case uses TREE cap (bounded as 256)`);
				return 256;
			}
			return 1;
		}

		if (type === "parallel" || type === "race") {
			const branches = asArray<{ task?: string; agent?: string }>(p.branches);
			// Each branch is one agent call in the common case
			const n = Math.max(branches.length, 1);
			return n;
		}

		if (type === "tournament") {
			const variants =
				typeof p.variants === "number" && Number.isFinite(p.variants)
					? Math.max(1, Math.floor(p.variants))
					: asArray(p.branches).length || 3;
			return variants + 1; // variants + judge
		}

		if (type === "map") {
			const over = p.over ?? "";
			if (templateIsDynamic(over) || STEPS_PLACEHOLDER.test(over)) {
				assumptions.push(`phase '${p.id}': map.over is dynamic → agent-call bound unbounded`);
				maxMapFanout = "unbounded";
				unbounded = true;
				return "unbounded";
			}
			// args-only array refs are still dynamic without evaluating over JSON
			if (/\{args\./.test(over)) {
				assumptions.push(`phase '${p.id}': map.over depends on args (length unknown) → unbounded`);
				maxMapFanout = "unbounded";
				unbounded = true;
				return "unbounded";
			}
			assumptions.push(`phase '${p.id}': map.over not a static array → treated as unbounded`);
			maxMapFanout = "unbounded";
			unbounded = true;
			return "unbounded";
		}

		if (type === "loop") {
			const maxIter =
				typeof p.maxIterations === "number" && Number.isFinite(p.maxIterations)
					? Math.min(Math.max(1, Math.floor(p.maxIterations)), LOOP_HARD_MAX_ITERATIONS)
					: LOOP_DEFAULT_MAX_ITERATIONS;
			// Body is one agent call per iteration (loop body is the phase task)
			return maxIter;
		}

		if (type === "flow" || type === "expand") {
			const def = (p as { def?: unknown }).def;
			if (def && typeof def === "object" && def !== null) {
				const child = def as { phases?: Phase[] };
				const childPhases = asArray<Phase>(child.phases);
				if (childPhases.length) {
					let sum = 0;
					for (const cp of childPhases) {
						const b = boundPhase(cp, next);
						if (b === "unbounded") return "unbounded";
						sum += b;
					}
					return sum;
				}
			}
			assumptions.push(`phase '${p.id}': ${type} child def not statically available → unbounded`);
			unbounded = true;
			return "unbounded";
		}

		if (LLM_TYPES.has(type)) return 1;
		return 0;
	};

	for (const p of phases) {
		const b = boundPhase(p, new Set());
		if (b === "unbounded") {
			unbounded = true;
		} else {
			total += b;
		}
	}

	// Silence unused byId (reserved for future dep-aware pruning)
	void byId;

	return {
		maxAgentCalls: unbounded ? "unbounded" : total,
		maxMapFanout,
		phasesCounted: phases.length,
		assumptions,
	};
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Plan a flow without executing any agent. Pure w.r.t. model spend.
 */
export function preflightTaskflow(raw: unknown, opts: PreflightOptions = {}): PreflightResult {
	const strictArgs = opts.strictArgs !== false;
	const issues: VerificationIssue[] = [];

	let flow: Taskflow;
	try {
		if (isShorthand(raw)) {
			flow = desugar(raw);
		} else if (raw && typeof raw === "object" && Array.isArray((raw as { phases?: unknown }).phases)) {
			flow = raw as Taskflow;
		} else {
			// Last chance: treat as shorthand or invalid
			flow = desugar(raw);
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			ok: false,
			issues: [{ message: `desugar failed: ${msg}`, severity: "error", category: "ref-integrity" }],
			flowName: "(invalid)",
			args: {},
			phases: [],
			budget: { maxAgentCalls: 0, phasesCounted: 0, assumptions: [] },
			summary: `Preflight failed: ${msg}`,
		};
	}

	const validation = validateTaskflow(flow, {
		args: opts.args,
		cwd: opts.cwd,
	});
	for (const e of validation.errors) {
		issues.push({ message: e, severity: "error", category: "ref-integrity" });
	}
	for (const w of validation.warnings) {
		issues.push({ message: w, severity: "warning", category: "ref-integrity" });
	}

	const args = resolveArgs(flow, opts.args);
	const invErrs = validateInvocationArgs(flow, args);
	for (const e of invErrs) {
		issues.push({
			message: e,
			severity: strictArgs ? "error" : "warning",
			category: "ref-integrity",
		});
	}

	const verify = verifyTaskflow(flow, { verifiers: opts.verifiers });
	issues.push(...verify.issues);

	const phases = asArray<Phase>(flow.phases).filter((p): p is Phase => !!p && typeof p === "object" && typeof p.id === "string");
	const layers = topoLayers(phases);
	const orderMap = new Map<string, number>();
	let order = 0;
	for (const layer of layers) {
		for (const p of layer) orderMap.set(p.id, order++);
	}

	const plan: PreflightPhasePlan[] = phases.map((p) => {
		const when = classifyWhen(p.when, args);
		const bindings = bindingsForPhase(p, args);
		const notes: string[] = [];
		if (when === "static-false") notes.push("statically skipped by when");
		if (bindings.some((b) => b.status === "unresolved")) notes.push("has unresolved args");
		return {
			id: p.id,
			type: p.type ?? "agent",
			order: orderMap.get(p.id) ?? 0,
			when,
			bindings,
			agent: typeof p.agent === "string" ? p.agent : undefined,
			modelHint: typeof p.model === "string" ? p.model : undefined,
			notes: notes.length ? notes : undefined,
		};
	});

	const budget = computeBudgetBound(phases, args);
	if (budget.maxAgentCalls === "unbounded" && flow.budget) {
		issues.push({
			message:
				"Worst-case agent-call bound is unbounded (dynamic map/flow) while a flow budget is declared — cost ceiling still enforced at runtime but cannot be proven statically.",
			severity: "warning",
			category: "budget-overflow",
		});
	}

	const ok = !issues.some((i) => i.severity === "error");
	const summary = formatPreflightSummary({
		ok,
		flowName: flow.name,
		phases: plan,
		budget,
		issueCount: issues.length,
		errorCount: issues.filter((i) => i.severity === "error").length,
	});

	return {
		ok,
		issues,
		flowName: flow.name,
		args,
		phases: plan,
		budget,
		summary,
		verify,
	};
}

export function formatPreflightSummary(p: {
	ok: boolean;
	flowName: string;
	phases: PreflightPhasePlan[];
	budget: PreflightBudgetBound;
	issueCount: number;
	errorCount: number;
}): string {
	const runnable = p.phases.filter((x) => x.when !== "static-false").length;
	const dyn = p.phases.filter((x) => x.when === "dynamic" || x.bindings.some((b) => b.status === "dynamic")).length;
	const calls = p.budget.maxAgentCalls;
	const lines = [
		`plan — flow "${p.flowName}" · ${p.ok ? "OK" : "BLOCKED"}`,
		`phases: ${p.phases.length} total · ${runnable} may run · ${dyn} with dynamic refs`,
		`budget bound: maxAgentCalls=${calls === "unbounded" ? "unbounded" : calls} · phasesCounted=${p.budget.phasesCounted}`,
		`issues: ${p.errorCount} error(s), ${p.issueCount - p.errorCount} warning(s)`,
	];
	if (p.budget.assumptions.length) {
		lines.push(`assumptions: ${p.budget.assumptions.slice(0, 5).join("; ")}${p.budget.assumptions.length > 5 ? "…" : ""}`);
	}
	return lines.join("\n");
}

/** Full human report for MCP/CLI. */
export function formatPreflightReport(r: PreflightResult, json = false): string {
	if (json) return JSON.stringify(r, null, 2);
	const lines: string[] = [r.summary, ""];
	lines.push("Phase plan (topo order):");
	const sorted = [...r.phases].sort((a, b) => a.order - b.order);
	for (const p of sorted) {
		const when = p.when === "always" ? "" : ` when=${p.when}`;
		const agent = p.agent ? ` agent=${p.agent}` : "";
		const notes = p.notes?.length ? ` (${p.notes.join("; ")})` : "";
		lines.push(`  ${p.order + 1}. ${p.id} [${p.type}]${when}${agent}${notes}`);
		for (const b of p.bindings) {
			const val = b.status === "bound" && b.value !== undefined ? `=${b.value}` : "";
			lines.push(`      · {${b.path}} → ${b.status}${val}`);
		}
	}
	if (r.issues.length) {
		lines.push("");
		lines.push("Issues:");
		for (const i of r.issues) {
			const where = i.phaseId ? ` [${i.phaseId}]` : "";
			lines.push(`  ${i.severity === "error" ? "✗" : "!"} ${i.severity}${where}: ${i.message}`);
		}
	}
	lines.push("");
	lines.push("Zero tokens. Run with taskflow_run when ready.");
	return lines.join("\n");
}
