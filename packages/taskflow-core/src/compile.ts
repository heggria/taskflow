/**
 * Compile a taskflow DAG to portable artifacts — zero-token, no LLM.
 *
 * `compileTaskflow` turns the declarative graph into:
 *   - a **Mermaid `flowchart`** that GitHub / GitLab / many markdown viewers
 *     render natively, so the DAG you declared can be screenshotted, pasted
 *     into a PR/issue/README, and diffed as text;
 *   - a **verification report** (the existing `verifyTaskflow` passes) whose
 *     issues are *overlaid onto the diagram* — a phase with an error is painted
 *     red, a warning amber — so the picture and the problems are one artifact.
 *
 * This is the visualization leg of the project thesis ("the plan is data, so it
 * can be verified, visualized, and replayed"): the same JSON renders a graph and
 * a structural audit without spending a token. It is a pure function — no I/O.
 */

import type { Phase, Taskflow } from "./schema.ts";
import {
	asArray,
	LOOP_DEFAULT_MAX_ITERATIONS,
	TOURNAMENT_DEFAULT_VARIANTS,
} from "./schema.ts";
import { verifyTaskflow, type VerificationIssue, type VerificationResult } from "./verify.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompileResult {
	/** A Mermaid `flowchart` source block (no fences). */
	mermaid: string;
	/** The static verification result the diagram is annotated with. */
	verification: VerificationResult;
	/** A self-contained markdown document: diagram (fenced) + verification report. */
	markdown: string;
}

export interface CompileOptions {
	/** Diagram direction. Default "TD" (top-down). "LR" for wide fan-outs. */
	direction?: "TD" | "LR";
	/** Document title (defaults to the flow name). */
	title?: string;
}

// ---------------------------------------------------------------------------
// Label / id sanitization
// ---------------------------------------------------------------------------

/** Mermaid node ids must be free of spaces and syntax chars. Phase ids are
 *  already `[A-Za-z0-9_-]`-ish, but we defensively map anything else to `_`. */
function nodeId(phaseId: unknown): string {
	const s = typeof phaseId === "string" ? phaseId : String(phaseId);
	const cleaned = s.replace(/[^A-Za-z0-9_]/g, "_");
	// A leading digit is legal in Mermaid ids, but prefix to avoid edge-case
	// parsers and keep ids stable/unique.
	return /^[A-Za-z_]/.test(cleaned) ? cleaned : `p_${cleaned}`;
}

/** Build a stable, collision-free mapping from raw phase ids to Mermaid node
 *  ids. Two distinct raw ids can sanitize to the same node id (e.g.
 *  `audit-each` and `audit_each` both collapse to `audit_each`); we
 *  disambiguate by appending `_<n>` so every phase renders as its own node and
 *  edges never form accidental self-loops. The map covers every phase id plus
 *  every id referenced in `dependsOn`, so an edge resolves to the same node as
 *  the definition. Deterministic — input order is preserved. */
function buildNodeIds(phases: Phase[]): Map<string, string> {
	const idMap = new Map<string, string>();
	const used = new Set<string>();
	const ordered: string[] = [];
	const seen = new Set<string>();
	for (const p of phases) {
		if (seen.has(p.id)) continue;
		seen.add(p.id);
		ordered.push(p.id);
	}
	for (const p of phases) {
		for (const d of asArray<string>(p.dependsOn)) {
			if (!seen.has(d)) {
				seen.add(d);
				ordered.push(d);
			}
		}
	}
	for (const raw of ordered) {
		const base = nodeId(raw);
		let safe = base;
		let n = 2;
		while (used.has(safe)) {
			safe = `${base}_${n}`;
			n++;
		}
		used.add(safe);
		idMap.set(raw, safe);
	}
	return idMap;
}

/** Escape text for use inside a Mermaid double-quoted label. Mermaid uses HTML
 *  entities inside quoted strings; quotes and angle brackets must be encoded,
 *  and newlines become `<br/>`. */
function label(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\\/g, "&#92;")
		.replace(/\r?\n/g, "<br/>");
}

/** Truncate a task prompt to a single readable line for the node body. */
function summarize(text: unknown, max = 48): string {
	// Defensive: a malformed non-string field (validateTaskflow reports it) must
	// not crash the renderer via `.replace`.
	if (text == null || text === "") return "";
	const s = typeof text === "string" ? text : String(text);
	const firstLine = s.replace(/\s+/g, " ").trim();
	return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
}

/** Escape a free-form string for use as inline markdown text (titles,
 *  descriptions, report fields). Collapses whitespace to a single space so a
 *  multi-line name/description can't break out of a heading or blockquote, and
 *  neutralizes characters that start markdown constructs: backticks (code
 *  spans), brackets (links/images), angle brackets (raw HTML), and backslashes
 *  (escape sequences). */
function mdInline(text: unknown): string {
	if (text == null || text === "") return "";
	const s = typeof text === "string" ? text : String(text);
	return s
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\\/g, "\\\\")
		.replace(/`/g, "\\`")
		.replace(/\[/g, "\\[")
		.replace(/\]/g, "\\]")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Per-type node rendering
// ---------------------------------------------------------------------------

/** A short type tag shown above the task summary so the shape is unambiguous
 *  even in monochrome renders. */
function typeTag(p: Phase): string {
	switch (p.type) {
		case "parallel":
			return `▦ parallel ×${p.branches?.length ?? 0}`;
		case "map":
			return `⇉ map over ${p.over ?? "?"}`;
		case "gate":
			return p.eval?.length ? `◇ gate (+${p.eval.length} eval)` : "◇ gate";
		case "reduce":
			return `▽ reduce ←${p.from?.length ?? 0}`;
		case "approval":
			return "⏸ approval";
		case "flow":
			return p.use ? `⊞ flow: ${p.use}` : "⊞ flow (inline)";
		case "loop":
			return `↻ loop ≤${p.maxIterations ?? LOOP_DEFAULT_MAX_ITERATIONS}`;
		case "tournament":
			return `🏆 tournament ×${p.variants ?? (p.branches?.length || TOURNAMENT_DEFAULT_VARIANTS)}`;
		default:
			return "▸ agent";
	}
}

/** The body text inside a node: id, type tag, a task summary, agent. */
function nodeBody(p: Phase): string {
	const lines: string[] = [];
	lines.push(`<b>${label(p.id)}</b>${p.final ? " ★" : ""}`);
	lines.push(label(typeTag(p)));
	const summary =
		p.type === "reduce" || p.type === "parallel"
			? summarize(p.task) // may be empty for these
			: summarize(p.task ?? p.judge);
	if (summary) lines.push(label(summary));
	if (p.agent) lines.push(label(`@${p.agent}`));
	return lines.join("<br/>");
}

/** Wrap the body in the Mermaid shape that matches the phase kind. Distinct
 *  shapes make the control-flow role readable at a glance:
 *   - agent      → rectangle
 *   - parallel   → subroutine (parallel fan-out)
 *   - map        → subroutine (dynamic fan-out)
 *   - flow       → subroutine (nested DAG)
 *   - reduce     → trapezoid (many → one)
 *   - gate       → rhombus (decision)
 *   - approval   → double-circle (human stop)
 *   - loop       → stadium (cyclic)
 *   - tournament → hexagon (compete)
 */
function nodeShape(p: Phase, idMap: Map<string, string>): string {
	const id = idMap.get(p.id) ?? p.id;
	const body = `"${nodeBody(p)}"`;
	switch (p.type) {
		case "parallel":
		case "map":
		case "flow":
			return `${id}[[${body}]]`;
		case "reduce":
			return `${id}[/${body}\\]`;
		case "gate":
			return `${id}{${body}}`;
		case "approval":
			return `${id}(((${body})))`;
		case "loop":
			return `${id}([${body}])`;
		case "tournament":
			return `${id}{{${body}}}`;
		default:
			return `${id}[${body}]`;
	}
}

// ---------------------------------------------------------------------------
// Edge rendering
// ---------------------------------------------------------------------------

/** Build the directed edges. `dependsOn` edges carry `when`-guard labels and
 *  dotted `join: "any"` races; `reduce.from` edges are plain aggregation edges
 *  (same set the runtime + verifier use via dependenciesOf = dependsOn ∪ from). */
function edges(phases: Phase[], idMap: Map<string, string>): string[] {
	const known = new Set(phases.map((p) => p.id));
	const out: string[] = [];
	for (const p of phases) {
		const deps = asArray<string>(p.dependsOn);
		for (const d of deps) {
			if (!known.has(d)) continue; // dangling ref — schema/verify reports it
			const from = idMap.get(d) ?? d;
			const to = idMap.get(p.id) ?? p.id;
			const guard = p.when ? `|"${label(summarize(p.when, 40))}"|` : "";
			// 'any' join: this phase fires on the FIRST dep — draw dotted so the
			// race semantics are visible.
			const arrow = p.join === "any" ? "-.->" : "-->";
			out.push(`${from} ${arrow}${guard} ${to}`);
		}
		// reduce `from`: real dependency edges the runtime waits on. Skip any that
		// are also in dependsOn (already drawn above) to avoid a double edge.
		const dependsSet = new Set(deps);
		for (const d of asArray<string>(p.from)) {
			if (!known.has(d) || dependsSet.has(d)) continue;
			const from = idMap.get(d) ?? d;
			const to = idMap.get(p.id) ?? p.id;
			out.push(`${from} --> ${to}`);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Issue overlay
// ---------------------------------------------------------------------------

const CLASS_ERROR = "tfError";
const CLASS_WARN = "tfWarn";
const CLASS_FINAL = "tfFinal";

/** Map each phase id to its worst severity so the node can be painted. */
function severityByPhase(issues: VerificationIssue[]): Map<string, "error" | "warning"> {
	const m = new Map<string, "error" | "warning">();
	for (const i of issues) {
		if (!i.phaseId) continue;
		const prev = m.get(i.phaseId);
		if (i.severity === "error" || prev === undefined) m.set(i.phaseId, i.severity);
	}
	return m;
}

// ---------------------------------------------------------------------------
// Mermaid assembly
// ---------------------------------------------------------------------------

function buildMermaid(flow: Taskflow, verification: VerificationResult, opts: CompileOptions): string {
	const phases = (Array.isArray(flow.phases) ? flow.phases : []).filter(
		(p): p is (typeof flow.phases)[number] => !!p && typeof p === "object",
	);
	const dir = opts.direction ?? "TD";
	const idMap = buildNodeIds(phases);
	const sev = severityByPhase(verification.issues);

	const lines: string[] = [];
	lines.push(`flowchart ${dir}`);

	// Nodes
	for (const p of phases) lines.push(`\t${nodeShape(p, idMap)}`);

	// Edges
	const e = edges(phases, idMap);
	if (e.length) {
		lines.push("");
		for (const edge of e) lines.push(`\t${edge}`);
	}

	// Class definitions (issue overlay + final marker). Colors are chosen to
	// read on both light and dark GitHub themes.
	lines.push("");
	lines.push(`\tclassDef ${CLASS_ERROR} fill:#3b0d0d,stroke:#ef4444,stroke-width:2px,color:#fecaca;`);
	lines.push(`\tclassDef ${CLASS_WARN} fill:#3a2e05,stroke:#f59e0b,stroke-width:2px,color:#fde68a;`);
	lines.push(`\tclassDef ${CLASS_FINAL} stroke:#43d9ad,stroke-width:3px;`);

	// Final phases get a distinct border (unless they already carry an issue,
	// where the issue color wins — a final node that's broken should read red).
	const finals = phases.filter((p) => p.final && !sev.has(p.id)).map((p) => idMap.get(p.id) ?? p.id);
	if (finals.length) lines.push(`\tclass ${finals.join(",")} ${CLASS_FINAL};`);

	const errNodes = [...sev].filter(([, s]) => s === "error").map(([id]) => idMap.get(id) ?? id);
	const warnNodes = [...sev].filter(([, s]) => s === "warning").map(([id]) => idMap.get(id) ?? id);
	if (errNodes.length) lines.push(`\tclass ${errNodes.join(",")} ${CLASS_ERROR};`);
	if (warnNodes.length) lines.push(`\tclass ${warnNodes.join(",")} ${CLASS_WARN};`);

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Verification report (markdown)
// ---------------------------------------------------------------------------

function buildReport(flow: Taskflow, verification: VerificationResult): string {
	const lines: string[] = [];
	const errors = verification.issues.filter((i) => i.severity === "error");
	const warnings = verification.issues.filter((i) => i.severity === "warning");
	const phaseCount = flow.phases?.length ?? 0;

	lines.push(`**Phases:** ${phaseCount}  ·  **Errors:** ${errors.length}  ·  **Warnings:** ${warnings.length}  ·  **Status:** ${verification.ok ? "✅ PASS" : "❌ FAIL"}`);

	if (verification.issues.length === 0) {
		lines.push("");
		lines.push("✅ No structural issues found — the DAG is well-formed (no cycles, dead-ends, gate exhaustion, ref or budget problems).");
		return lines.join("\n");
	}

	if (errors.length) {
		lines.push("");
		lines.push(`### ❌ Errors (${errors.length})`);
		for (const e of errors)
			lines.push(`- **${e.category}**${e.phaseId ? ` \`${mdInline(e.phaseId)}\`` : ""}: ${mdInline(e.message)}`);
	}
	if (warnings.length) {
		lines.push("");
		lines.push(`### ⚠️ Warnings (${warnings.length})`);
		for (const w of warnings)
			lines.push(`- **${w.category}**${w.phaseId ? ` \`${mdInline(w.phaseId)}\`` : ""}: ${mdInline(w.message)}`);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Compile a (already schema-valid) taskflow into a Mermaid diagram + verification
 * report. Pure function — zero tokens, no LLM, no I/O.
 */
export function compileTaskflow(flow: Taskflow, opts: CompileOptions = {}): CompileResult {
	const verification = verifyTaskflow({
		name: flow.name ?? "taskflow",
		phases: flow.phases ?? [],
		budget: flow.budget,
		concurrency: flow.concurrency,
	});

	const mermaid = buildMermaid(flow, verification, opts);
	const report = buildReport(flow, verification);
	const title = opts.title ?? flow.name ?? "taskflow";

	const mdLines: string[] = [];
	mdLines.push(`# Taskflow: ${mdInline(title)}`);
	mdLines.push("");
	if (flow.description) mdLines.push(`> ${mdInline(flow.description)}`);
	mdLines.push("```mermaid");
	mdLines.push(mermaid);
	mdLines.push("```");
	mdLines.push("");
	mdLines.push("## Verification");
	mdLines.push("");
	mdLines.push(report);
	mdLines.push("");
	mdLines.push(
		"> Legend: ▸ agent · ▦ parallel · ⇉ map · ◇ gate · ▽ reduce · ⏸ approval · ⊞ flow · ↻ loop · 🏆 tournament · ★ final. Red = error, amber = warning, green border = final. Dotted edge = `join:any`. Generated by `pi-taskflow compile` — 0 tokens.",
	);
	const markdown = mdLines.join("\n");

	return { mermaid, verification, markdown };
}
