/**
 * Render a taskflow DAG for the Codex hosts, in two forms:
 *
 *   - `renderFlowSvg`     — a self-contained SVG "card" for the Codex **desktop
 *                           app**, which renders an MCP `image` content block
 *                           as `<img src="data:…">` in Chromium (an inline SVG
 *                           data URI shows as an actual diagram).
 *   - `renderFlowOutline` — a compact monospace ASCII outline for the Codex
 *                           **CLI/TUI**, which cannot render images: the Rust
 *                           binary substitutes a bare `<image content>`
 *                           placeholder for image blocks, so a picture is
 *                           useless there (and a vision-less model would see
 *                           only that placeholder). The outline is plain text
 *                           that reads in the terminal AND feeds the model.
 *
 * We can't tell the two hosts apart from inside the server (every Codex
 * frontend connects with the same MCP client id, `codex-mcp-client`), so
 * `taskflow_compile` returns BOTH blocks: the desktop app shows the image and
 * ignores the trailing text, while the CLI/TUI shows the text and renders the
 * image as a harmless placeholder. One payload, correct on every host.
 *
 * This is host presentation, so it lives in the codex adapter — core keeps its
 * portable Mermaid/markdown artifact (`compileTaskflow`) and its zero-runtime
 * -deps guarantee. Both renderers reuse core's exported `topoLayers` (layout)
 * and `dependenciesOf` (edges) so they share the engine's exact DAG semantics.
 * Pure functions, no I/O.
 */

import {
	dependenciesOf,
	topoLayers,
	LOOP_DEFAULT_MAX_ITERATIONS,
	TOURNAMENT_DEFAULT_VARIANTS,
	type Phase,
	type Taskflow,
	type VerificationResult,
	type VerificationIssue,
} from "taskflow-core";

// ---------------------------------------------------------------------------
// Layout constants (px). Tuned so a small flow (3–8 phases) is legible even
// after Codex scales the card down to its ~192px image height cap.
// ---------------------------------------------------------------------------

const FONT = 12;
const SUB_FONT = 10.5;
const CHAR_W = 6.6; // ~0.55em at 12px in the monospace stack below
const LINE_H = 15;
const PAD_X = 12;
const PAD_Y = 9;
const H_GAP = 26; // horizontal gap between sibling nodes in a layer
const V_GAP = 38; // vertical gap between layers
const MARGIN = 18;
const MIN_NODE_W = 96;
const MAX_LABEL = 26; // truncate long ids/agents so nodes stay compact

/** Above this phase count the card stops being legible once scaled — the caller
 *  should fall back to the text report instead of embedding a postage stamp. */
export const SVG_PHASE_LIMIT = 60;

// ---------------------------------------------------------------------------
// Palette — baked in (an <img> data URI is fully isolated from host CSS, so we
// can't read Codex theme tokens). A dark card reads well against Codex's dark
// chat surface; colors mirror the Mermaid overlay in core's compile.ts.
// ---------------------------------------------------------------------------

const C = {
	panel: "#16181d",
	panelStroke: "#2a2d34",
	node: "#21242c",
	nodeStroke: "#3a3f4b",
	text: "#e6e8ec",
	sub: "#9aa0ab",
	edge: "#4b5563",
	errFill: "#3b0d0d",
	errStroke: "#ef4444",
	errText: "#fecaca",
	warnFill: "#3a2e05",
	warnStroke: "#f59e0b",
	warnText: "#fde68a",
	finalStroke: "#43d9ad",
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function xml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function truncate(text: string, max = MAX_LABEL): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Compact one-glyph-plus-count type tag (a small-render echo of compile.ts). */
function typeTag(p: Phase): string {
	switch (p.type) {
		case "parallel":
			return `▦ parallel ×${p.branches?.length ?? 0}`;
		case "map":
			return `⇉ map · ${truncate(p.over ?? "?", 14)}`;
		case "gate":
			return p.eval?.length ? `◇ gate +${p.eval.length}` : "◇ gate";
		case "reduce":
			return `▽ reduce ←${p.from?.length ?? 0}`;
		case "approval":
			return "⏸ approval";
		case "flow":
			return p.use ? `⊞ ${truncate(p.use, 16)}` : "⊞ flow";
		case "loop":
			return `↻ loop ≤${p.maxIterations ?? LOOP_DEFAULT_MAX_ITERATIONS}`;
		case "tournament":
			return `🏆 ×${p.variants ?? (p.branches?.length || TOURNAMENT_DEFAULT_VARIANTS)}`;
		default:
			return "▸ agent";
	}
}

interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
	cx: number;
}

interface NodeLines {
	title: string;
	tag: string;
	agent?: string;
}

function nodeLines(p: Phase): NodeLines {
	return {
		title: `${truncate(p.id)}${p.final ? " ★" : ""}`,
		tag: typeTag(p),
		agent: p.agent ? `@${truncate(p.agent, 20)}` : undefined,
	};
}

function nodeWidth(l: NodeLines): number {
	const longest = Math.max(l.title.length, l.tag.length, l.agent?.length ?? 0);
	return Math.max(MIN_NODE_W, Math.round(longest * CHAR_W) + PAD_X * 2);
}

function nodeHeight(l: NodeLines): number {
	const rows = 2 + (l.agent ? 1 : 0);
	return rows * LINE_H + PAD_Y * 2;
}

/** Worst severity per phase, so a node paints red (error) over amber (warning). */
function severityByPhase(issues: VerificationIssue[]): Map<string, "error" | "warning"> {
	const m = new Map<string, "error" | "warning">();
	for (const i of issues) {
		if (!i.phaseId) continue;
		if (i.severity === "error" || !m.has(i.phaseId)) m.set(i.phaseId, i.severity);
	}
	return m;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render `flow` (annotated with `verification`) as an SVG string. Layered
 * top-down using core's `topoLayers`; edges follow `dependenciesOf`. Returns a
 * complete `<svg …>…</svg>` document (no XML prolog — it's inlined as a data
 * URI). Returns `null` when the flow is too large to render legibly.
 */
export function renderFlowSvg(flow: Taskflow, verification: VerificationResult): string | null {
	const phases = flow.phases ?? [];
	if (phases.length === 0 || phases.length > SVG_PHASE_LIMIT) return null;

	const layers = topoLayers(phases);
	// Any phase not placed by topoLayers (e.g. trapped in a cycle) gets its own
	// trailing layer so the picture never silently drops a node.
	const placed = new Set(layers.flat().map((p) => p.id));
	const orphans = phases.filter((p) => !placed.has(p.id));
	if (orphans.length) layers.push(orphans);

	const sev = severityByPhase(verification.issues);
	const rects = new Map<string, Rect>();

	// First pass: size every node and measure each layer's total width.
	const linesById = new Map<string, NodeLines>();
	const sizeById = new Map<string, { w: number; h: number }>();
	const layerWidths: number[] = [];
	const layerHeights: number[] = [];
	for (const layer of layers) {
		let w = 0;
		let h = 0;
		layer.forEach((p, i) => {
			const l = nodeLines(p);
			linesById.set(p.id, l);
			const nw = nodeWidth(l);
			const nh = nodeHeight(l);
			sizeById.set(p.id, { w: nw, h: nh });
			w += nw + (i > 0 ? H_GAP : 0);
			h = Math.max(h, nh);
		});
		layerWidths.push(w);
		layerHeights.push(h);
	}

	const contentW = Math.max(...layerWidths, MIN_NODE_W);
	const canvasW = contentW + MARGIN * 2;

	// Second pass: assign positions (each layer centered within contentW).
	let y = MARGIN;
	layers.forEach((layer, li) => {
		let x = MARGIN + (contentW - layerWidths[li]) / 2;
		for (const p of layer) {
			const s = sizeById.get(p.id)!;
			rects.set(p.id, { x, y, w: s.w, h: s.h, cx: x + s.w / 2 });
			x += s.w + H_GAP;
		}
		y += layerHeights[li] + V_GAP;
	});
	const canvasH = y - V_GAP + MARGIN;

	// Edges — draw first so nodes paint on top.
	const edgeSvg: string[] = [];
	const known = new Set(phases.map((p) => p.id));
	for (const p of phases) {
		const to = rects.get(p.id);
		if (!to) continue;
		for (const d of dependenciesOf(p)) {
			if (!known.has(d)) continue;
			const from = rects.get(d);
			if (!from) continue;
			const x1 = from.cx;
			const y1 = from.y + from.h;
			const x2 = to.cx;
			const y2 = to.y;
			const my = (y1 + y2) / 2;
			const dotted = p.join === "any" ? ' stroke-dasharray="4 3"' : "";
			edgeSvg.push(
				`<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} C ${x1.toFixed(1)} ${my.toFixed(1)}, ${x2.toFixed(1)} ${my.toFixed(1)}, ${x2.toFixed(1)} ${(y2 - 6).toFixed(1)}" fill="none" stroke="${C.edge}" stroke-width="1.4"${dotted} marker-end="url(#tf-arrow)"/>`,
			);
		}
	}

	// Nodes.
	const nodeSvg: string[] = [];
	for (const p of phases) {
		const r = rects.get(p.id);
		if (!r) continue;
		const l = linesById.get(p.id)!;
		const s = sev.get(p.id);
		let fill: string = C.node;
		let stroke: string = C.nodeStroke;
		let strokeW = 1.2;
		let titleColor: string = C.text;
		if (s === "error") {
			fill = C.errFill;
			stroke = C.errStroke;
			strokeW = 2;
			titleColor = C.errText;
		} else if (s === "warning") {
			fill = C.warnFill;
			stroke = C.warnStroke;
			strokeW = 2;
			titleColor = C.warnText;
		} else if (p.final) {
			stroke = C.finalStroke;
			strokeW = 2;
		}
		const tx = r.x + PAD_X;
		let ty = r.y + PAD_Y + FONT;
		const parts = [`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}"/>`];
		parts.push(`<text x="${tx}" y="${ty.toFixed(1)}" font-size="${FONT}" font-weight="600" fill="${titleColor}">${xml(l.title)}</text>`);
		ty += LINE_H;
		parts.push(`<text x="${tx}" y="${ty.toFixed(1)}" font-size="${SUB_FONT}" fill="${C.sub}">${xml(l.tag)}</text>`);
		if (l.agent) {
			ty += LINE_H;
			parts.push(`<text x="${tx}" y="${ty.toFixed(1)}" font-size="${SUB_FONT}" fill="${C.sub}">${xml(l.agent)}</text>`);
		}
		nodeSvg.push(parts.join(""));
	}

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}" viewBox="0 0 ${canvasW} ${canvasH}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">`,
		`<defs><marker id="tf-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" fill="${C.edge}"/></marker></defs>`,
		`<rect x="0.5" y="0.5" width="${canvasW - 1}" height="${canvasH - 1}" rx="12" fill="${C.panel}" stroke="${C.panelStroke}"/>`,
		...edgeSvg,
		...nodeSvg,
		`</svg>`,
	].join("");
}

/** Base64 of an SVG string, for an MCP `image` content block (`image/svg+xml`). */
export function svgToBase64(svg: string): string {
	return Buffer.from(svg, "utf8").toString("base64");
}

// ---------------------------------------------------------------------------
// Text outline (Codex CLI/TUI + vision-less models)
// ---------------------------------------------------------------------------

/** Worst severity marker for a phase, as a leading glyph in the outline. */
function sevMark(sev: Map<string, "error" | "warning">, id: string): string {
	const s = sev.get(id);
	return s === "error" ? "✗ " : s === "warning" ? "! " : "";
}

/**
 * Render the DAG as a compact monospace outline: one line per phase, grouped by
 * topological layer (phases in the same layer run concurrently), each showing
 * its id, type tag, agent, and upstream deps. This is the CLI/TUI counterpart
 * to `renderFlowSvg` — it degrades to readable text where images can't render,
 * and (unlike an image placeholder) still tells a vision-less model the shape
 * of the graph. Deterministic; issue markers mirror the SVG overlay.
 */
export function renderFlowOutline(flow: Taskflow, verification: VerificationResult): string {
	const phases = flow.phases ?? [];
	if (phases.length === 0) return "(empty flow — no phases)";

	const sev = severityByPhase(verification.issues);
	const layers = topoLayers(phases);
	const placed = new Set(layers.flat().map((p) => p.id));
	const orphans = phases.filter((p) => !placed.has(p.id));
	if (orphans.length) layers.push(orphans); // cycle-trapped nodes still listed

	const lines: string[] = [];
	layers.forEach((layer, i) => {
		const tag = layer.length > 1 ? ` (${layer.length} in parallel)` : "";
		lines.push(`Layer ${i + 1}${tag}:`);
		for (const p of layer) {
			const deps = dependenciesOf(p).filter((d) => d !== p.id);
			const arrow = p.join === "any" ? " ↯ any of " : " ← ";
			const depStr = deps.length ? `${arrow}${deps.join(", ")}` : "";
			const agent = p.agent ? ` @${p.agent}` : "";
			const star = p.final ? " ★" : "";
			lines.push(`  ${sevMark(sev, p.id)}${p.id}${star}  [${typeTag(p)}]${agent}${depStr}`);
		}
	});
	return lines.join("\n");
}
