/**
 * TUI rendering for the taskflow tool and commands.
 *
 * Design goals: high information density, column alignment, and width-safe
 * single-cell status glyphs (no double-width emoji that break alignment).
 */

import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { type UsageStats } from "taskflow-core";
import type { PhaseState, RunState } from "taskflow-core";
import { dependenciesOf, type Phase, topoLayers } from "taskflow-core";

// Single-width glyphs (Geometric Shapes / check marks) — keep columns aligned.
const ICON: Record<PhaseState["status"], { ch: string; color: string }> = {
	done: { ch: "✓", color: "success" },
	running: { ch: "◐", color: "warning" },
	failed: { ch: "✗", color: "error" },
	skipped: { ch: "⊘", color: "muted" },
	pending: { ch: "○", color: "dim" },
};

function icon(status: PhaseState["status"], theme: Theme): string {
	if (status === "running") return theme.fg("warning", spinnerFrame());
	const i = ICON[status] ?? ICON.pending;
	return theme.fg(i.color as any, i.ch);
}

function shortModel(model?: string): string {
	if (!model) return "";
	return model.split("/").pop() ?? model;
}

// Braille dots spinner (ora classic) — smooth, clockwise, single-width.
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function spinnerFrame(): string {
	return SPINNER[Math.floor(Date.now() / 120) % SPINNER.length];
}

// Elapsed as 5s / 3m30s / 1h05m
function elapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) {
		const m = Math.floor(s / 60);
		const ss = s % 60;
		return `${m}m${ss.toString().padStart(2, "0")}s`;
	}
	const h = Math.floor(s / 3600);
	const mm = Math.floor((s % 3600) / 60);
	return `${h}h${mm.toString().padStart(2, "0")}m`;
}

function phaseElapsed(ps: PhaseState): number {
	if (!ps.startedAt) return 0;
	// Guard against a stale/clock-skewed endedAt that precedes startedAt (e.g. a
	// resumed phase that still carries a previous attempt's endedAt): treat such
	// an end time as absent and fall back to now. Finally clamp to >= 0 so the
	// TUI never shows a negative (and frozen) elapsed time.
	const end = ps.endedAt && ps.endedAt >= ps.startedAt ? ps.endedAt : Date.now();
	return Math.max(0, end - ps.startedAt);
}

function miniBar(done: number, total: number, theme: Theme, width = 8): string {
	if (total <= 0) return "";
	const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
	return theme.fg("accent", "━".repeat(filled)) + theme.fg("dim", "─".repeat(width - filled));
}

function agentRole(phase: Phase, ps: PhaseState | undefined, theme: Theme): string {
	const role = phase.agent ?? phase.type ?? "agent";
	const model = ps?.model ? shortModel(ps.model) : "";
	if (!model) return theme.fg("accent", role);
	return theme.fg("accent", role) + theme.fg("dim", `（${model}）`);
}

function costStr(usage: UsageStats | undefined, theme: Theme): string {
	if (!usage?.cost) return "";
	const c = usage.cost;
	return c >= 0.01
		? theme.fg("muted", `$${c.toFixed(2)}`)
		: theme.fg("muted", `$${c.toFixed(4)}`);
}

function aggregateCost(state: RunState): number {
	let c = 0;
	for (const p of Object.values(state.phases)) c += p.usage?.cost ?? 0;
	return c;
}

function runElapsed(state: RunState): number {
	const starts = Object.values(state.phases)
		.map((p) => p.startedAt)
		.filter((x): x is number => !!x);
	if (starts.length === 0) return 0;
	const min = Math.min(...starts);
	const ends = Object.values(state.phases).map((p) => p.endedAt ?? Date.now());
	const max = ends.length ? Math.max(...ends) : Date.now();
	return Math.max(0, max - min);
}

export function summarizeRun(state: RunState): string {
	const phases = Object.values(state.phases);
	const done = phases.filter((p) => p.status === "done").length;
	const failed = phases.filter((p) => p.status === "failed").length;
	const running = phases.filter((p) => p.status === "running").length;
	const total = Object.keys(state.phases).length;
	const bits = [`${done}/${total} done`];
	if (running) bits.push(`${running} running`);
	if (failed) bits.push(`${failed} failed`);
	return bits.join(", ");
}

/** Build the detail column for a phase (the right-hand info). */
function phaseDetail(phase: Phase, ps: PhaseState | undefined, theme: Theme): string {
	const type = phase.type ?? "agent";
	if (!ps || ps.status === "pending") return theme.fg("dim", "—");

	if (ps.status === "skipped") {
		const reason = (ps.error ?? "upstream failed").replace(/\s+/g, " ");
		const snip = reason.length > 52 ? `${reason.slice(0, 52)}…` : reason;
		return theme.fg("muted", `skipped · ${snip}`) + (ps.warnings?.length ? theme.fg("warning", `  ⚠${ps.warnings.length}`) : "");
	}

	const isFanout = type === "map" || type === "parallel" || type === "flow";

	if (ps.status === "failed") {
		const e = (ps.error ?? "failed").replace(/\s+/g, " ");
		const snip = e.length > 56 ? `${e.slice(0, 56)}…` : e;
		if (isFanout && ps.subProgress) {
			const { done, total, failed } = ps.subProgress;
			return (
				theme.fg("toolOutput", `${done - failed}/${total}`) +
				theme.fg("error", ` ${failed}✗`) +
				(snip ? theme.fg("error", `  ${snip}`) : "") +
				(ps.warnings?.length ? theme.fg("warning", `  ⚠${ps.warnings.length}`) : "")
			);
		}
		return theme.fg("error", snip) + (ps.warnings?.length ? theme.fg("warning", `  ⚠${ps.warnings.length}`) : "");
	}

	const t = phaseElapsed(ps);
	const time = t ? theme.fg("dim", elapsed(t)) : "";

	if (ps.status === "running") {
		const roleLabel = agentRole(phase, ps, theme);
		const cost = costStr(ps.usage, theme);
		if (isFanout && ps.subProgress) {
			const { done, total, running, failed } = ps.subProgress;
			let s = `${miniBar(done, total, theme)} ${theme.fg("toolOutput", `${done}/${total}`)}`;
			if (running) s += theme.fg("dim", ` · ${running} run`);
			if (failed) s += theme.fg("error", ` · ${failed}✗`);
			s += `  ${roleLabel}`;
			if (cost) s += `  ${cost}`;
			if (time) s += `  ${time}`;
			if (ps.warnings?.length) s += theme.fg("warning", `  ⚠${ps.warnings.length}`);
			return s;
		}
		let s = roleLabel;
		if (cost) s += `  ${cost}`;
		if (time) s += `  ${time}`;
		if (ps.warnings?.length) s += theme.fg("warning", `  ⚠${ps.warnings.length}`);
		return s;
	}

	// done
	// Cross-run cache hit: show a compact badge with age and the $0 cost.
	if (ps.cacheHit === "cross-run") {
		const ageMs = ps.endedAt ? Date.now() - ps.endedAt : 0;
		let c = theme.fg("success", "✓") + " " + theme.fg("toolOutput", theme.bold("CACHED")) + theme.fg("dim", " cross-run");
		if (ageMs > 1500) c += theme.fg("dim", ` · ${elapsed(ageMs)} ago`);
		if (ps.warnings?.length) c += theme.fg("warning", `  ⚠${ps.warnings.length}`);
		return c;
	}
	if (isFanout) {
		const { done = 0, total = 0, failed = 0 } = ps.subProgress ?? {};
		let s = theme.fg("success", `${total}✓`);
		if (failed) s = theme.fg("toolOutput", `${done - failed}/${total}`) + theme.fg("error", ` ${failed}✗`);
		const cost = costStr(ps.usage, theme);
		if (cost) s += `  ${cost}`;
		if (time) s += `  ${time}`;
		if (ps.warnings?.length) s += theme.fg("warning", `  ⚠${ps.warnings.length}`);
		return s;
	}
	// single-agent done
	const roleLabel = agentRole(phase, ps, theme);
	const cost = costStr(ps.usage, theme);
	if (ps.approval) {
		const d = ps.approval.decision;
		const color = d === "reject" ? "error" : d === "edit" ? "warning" : "success";
		let a = theme.fg("warning", "⚠") + " " + theme.fg(color as Parameters<typeof theme.fg>[0], theme.bold(d.toUpperCase()));
		if (ps.approval.auto) a += theme.fg("dim", " auto");
		if (cost) a += `  ${cost}`;
		if (time) a += `  ${time}`;
		if (ps.warnings?.length) a += theme.fg("warning", `  ⚠${ps.warnings.length}`);
		return a;
	}
	if (ps.gate) {
		const badge =
			ps.gate.verdict === "block" ? theme.fg("error", theme.bold("BLOCK")) : theme.fg("success", "PASS");
		let g = badge;
		if (ps.gate.reason) {
			const r = ps.gate.reason.replace(/\s+/g, " ");
			g += theme.fg("dim", ` ${r.length > 44 ? `${r.slice(0, 44)}…` : r}`);
		}
		const cost = costStr(ps.usage, theme);
		if (cost) g += `  ${cost}`;
		if (time) g += `  ${time}`;
		if (ps.warnings?.length) g += theme.fg("warning", `  ⚠${ps.warnings.length}`);
		return g;
	}
	if (ps.loop) {
		const stopLabel =
			ps.loop.stop === "until"
				? theme.fg("success", "done")
				: ps.loop.stop === "converged"
					? theme.fg("toolOutput", "converged")
					: ps.loop.stop === "maxIterations"
						? theme.fg("warning", "max")
						: theme.fg("error", "failed");
		let l = theme.fg("toolTitle", `↻${ps.loop.iterations}`) + " " + stopLabel;
		const cost = costStr(ps.usage, theme);
		if (cost) l += `  ${cost}`;
		if (time) l += `  ${time}`;
		if (ps.warnings?.length) l += theme.fg("warning", `  ⚠${ps.warnings.length}`);
		return l;
	}
	if (ps.tournament) {
		const { variants, winner, mode } = ps.tournament;
		let w =
			theme.fg("toolTitle", `⚑ ${variants}→`) +
			theme.fg("success", mode === "aggregate" ? "aggregate" : `#${winner}`);
		if (ps.tournament.reason) {
			const r = ps.tournament.reason.replace(/\s+/g, " ");
			w += theme.fg("dim", ` ${r.length > 36 ? `${r.slice(0, 36)}…` : r}`);
		}
		const cost = costStr(ps.usage, theme);
		if (cost) w += `  ${cost}`;
		if (time) w += `  ${time}`;
		if (ps.warnings?.length) w += theme.fg("warning", `  ⚠${ps.warnings.length}`);
		return w;
	}
	let s = roleLabel;
	if (cost) s += `  ${cost}`;
	if (ps.attempts && ps.attempts > 1) s += theme.fg("warning", `  ↻${ps.attempts - 1}`);
	if (time) s += `  ${time}`;
	if (ps.warnings?.length) s += theme.fg("warning", `  ⚠${ps.warnings.length}`);
	return s;
}

/** Header line: status glyph + name + compact totals. */
function headerLine(state: RunState, theme: Theme): string {
	const phases = Object.values(state.phases);
	const done = phases.filter((p) => p.status === "done").length;
	const failed = phases.filter((p) => p.status === "failed").length;
	const running = phases.filter((p) => p.status === "running").length;
	const total = Object.keys(state.phases).length;

	const head =
		state.status === "completed"
			? theme.fg("success", "✓")
			: state.status === "failed"
				? theme.fg("error", "✗")
				: state.status === "blocked"
					? theme.fg("error", "⊗")
					: state.status === "paused"
						? theme.fg("warning", "‖")
						: theme.fg("warning", spinnerFrame());

	let line =
		`${head} ${theme.fg("toolTitle", theme.bold("taskflow"))} ` +
		theme.fg("accent", state.flowName) +
		theme.fg("muted", `  ${done}/${total}`);
	if (running) line += theme.fg("warning", ` · ${running}▸`);
	if (failed) line += theme.fg("error", ` · ${failed}✗`);
	if (state.status === "blocked") line += theme.fg("error", " · blocked");
	const cost = aggregateCost(state);
	const budget = state.def.budget;
	if (budget?.maxUSD !== undefined) line += theme.fg("muted", ` · $${cost >= 0.01 ? cost.toFixed(2) : cost.toFixed(4)}/$${budget.maxUSD}`);
	else if (cost) line += theme.fg("muted", ` · $${cost >= 0.01 ? cost.toFixed(2) : cost.toFixed(4)}`);
	const el = runElapsed(state);
	if (el) line += theme.fg("dim", ` · ${elapsed(el)}`);
	return line;
}

/**
 * Left-gutter rail glyph for a phase at `i` within a parallel group of `size`.
 * A group is a topological layer with >1 phase (they run concurrently); the
 * bracket (┌ ├ └) visually fans them out from the preceding layer. Single-phase
 * layers get a blank gutter so the column stays quiet.
 */
function railGlyph(i: number, size: number): string {
	if (size <= 1) return " ";
	if (i === 0) return "┌";
	if (i === size - 1) return "└";
	return "├";
}

/** The full dense progress block (header + DAG-ordered phase rows). */
export function renderProgress(state: RunState, theme: Theme): string {
	const phases = state.def.phases;
	const idW = Math.max(...phases.map((p) => p.id.length), 2);
	const typeW = Math.max(...phases.map((p) => (p.type ?? "agent").length), 4);
	const defIndex = new Map(phases.map((p, i) => [p.id, i]));

	// Render in topological order: each layer is a set of phases that can run
	// concurrently; later layers depend on earlier ones. This makes the DAG's
	// flow legible top-to-bottom without drawing a full graph.
	const layers = topoLayers(phases);
	const rendered = new Set<string>();

	let text = headerLine(state, theme);

	const renderRow = (phase: Phase, rail: string, prevLayerIds: Set<string>) => {
		const ps = state.phases[phase.id];
		const status = ps?.status ?? "pending";
		const id = phase.id.padEnd(idW);
		const type = (phase.type ?? "agent").padEnd(typeW);
		const detail = phaseDetail(phase, ps, theme);

		// Annotate only "long" edges — dependencies that skip past the adjacent
		// layer. Edges into the immediately-preceding layer are implied by position
		// (and the rail), so showing them would just add noise.
		const longEdges = dependenciesOf(phase).filter((d) => !prevLayerIds.has(d));
		const dep = longEdges.length
			? theme.fg("dim", `  ↳ ${longEdges.join(", ")}`)
			: "";

		const gutter = rail === " " ? " " : theme.fg("borderMuted", rail);
		text +=
			`\n  ${gutter} ${icon(status, theme)} ` +
			theme.fg(status === "pending" ? "dim" : "text", id) +
			"  " +
			theme.fg("dim", type) +
			"  " +
			detail +
			dep;

		// Live activity sub-line (only while running, only if we have a message).
		if (status === "running" && ps?.liveText) {
			const indent = " ".repeat(2 + 2 + 2 + idW + 2);
			const msg = ps.liveText.replace(/\s+/g, " ").trim();
			const snip = msg.length > 88 ? `${msg.slice(0, 88)}…` : msg;
			text += `\n${indent}${theme.fg("dim", "› ")}${theme.fg("muted", snip)}`;
		}
		rendered.add(phase.id);
	};

	let prevLayerIds = new Set<string>();
	for (const layer of layers) {
		const ordered = [...layer].sort((a, b) => (defIndex.get(a.id) ?? 0) - (defIndex.get(b.id) ?? 0));
		ordered.forEach((phase, i) => renderRow(phase, railGlyph(i, ordered.length), prevLayerIds));
		prevLayerIds = new Set(ordered.map((p) => p.id));
	}

	// Safety net: render any phase a malformed DAG left out of the layering.
	for (const phase of phases) {
		if (!rendered.has(phase.id)) renderRow(phase, " ", prevLayerIds);
	}

	return text;
}

export function renderRunResult(
	state: RunState,
	finalOutput: string,
	theme: Theme,
	expanded: boolean,
): Container | Text {
	if (!expanded) {
		let text = renderProgress(state, theme);
		text += `\n  ${theme.fg("dim", "Ctrl+O to expand")}`;
		return new Text(text, 0, 0);
	}

	const mdTheme = getMarkdownTheme();
	const container = new Container();
	container.addChild(new Text(renderProgress(state, theme), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Result ───"), 0, 0));
	if (finalOutput.trim()) {
		container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
	} else {
		container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
	}
	return container;
}
