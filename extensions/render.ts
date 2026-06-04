/**
 * TUI rendering for the taskflow tool and commands.
 *
 * Design goals: high information density, column alignment, and width-safe
 * single-cell status glyphs (no double-width emoji that break alignment).
 */

import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { formatTokens, type UsageStats } from "./runner.ts";
import type { PhaseState, RunState } from "./store.ts";
import type { Phase } from "./schema.ts";

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

// Braille spinner; advances with wall-clock time so it animates on every render.
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function spinnerFrame(): string {
	return SPINNER[Math.floor(Date.now() / 120) % SPINNER.length];
}

function elapsed(ms: number): string {
	if (ms < 1000) return "0s";
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
	return `${(ms / 3_600_000).toFixed(1)}h`;
}

function phaseElapsed(ps: PhaseState): number {
	if (!ps.startedAt) return 0;
	return (ps.endedAt ?? Date.now()) - ps.startedAt;
}

function miniBar(done: number, total: number, theme: Theme, width = 8): string {
	if (total <= 0) return "";
	const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
	return theme.fg("accent", "━".repeat(filled)) + theme.fg("dim", "─".repeat(width - filled));
}

function compactUsage(usage: UsageStats | undefined, theme: Theme): string {
	if (!usage) return "";
	const parts: string[] = [];
	if (usage.turns) parts.push(theme.fg("dim", `${usage.turns}t`));
	if (usage.input) parts.push(theme.fg("dim", `↑${formatTokens(usage.input)}`));
	if (usage.output) parts.push(theme.fg("dim", `↓${formatTokens(usage.output)}`));
	if (usage.cost) parts.push(theme.fg("muted", `$${usage.cost.toFixed(3)}`));
	return parts.join(" ");
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
	return max - min;
}

export function summarizeRun(state: RunState): string {
	const phases = Object.values(state.phases);
	const done = phases.filter((p) => p.status === "done").length;
	const failed = phases.filter((p) => p.status === "failed").length;
	const running = phases.filter((p) => p.status === "running").length;
	const total = state.def.phases.length;
	const bits = [`${done}/${total} done`];
	if (running) bits.push(`${running} running`);
	if (failed) bits.push(`${failed} failed`);
	return bits.join(", ");
}

/** Build the detail column for a phase (the right-hand info). */
function phaseDetail(phase: Phase, ps: PhaseState | undefined, theme: Theme): string {
	const type = phase.type ?? "agent";
	if (!ps || ps.status === "pending") return theme.fg("dim", "—");

	if (ps.status === "skipped") return theme.fg("muted", "skipped · upstream failed");

	if (ps.status === "failed") {
		const e = (ps.error ?? "failed").replace(/\s+/g, " ");
		const snip = e.length > 64 ? `${e.slice(0, 64)}…` : e;
		return theme.fg("error", snip);
	}

	const isFanout = type === "map" || type === "parallel";
	const t = phaseElapsed(ps);
	const time = t ? theme.fg("dim", elapsed(t)) : "";

	if (ps.status === "running") {
		if (isFanout && ps.subProgress) {
			const { done, total, running, failed } = ps.subProgress;
			let s = `${miniBar(done, total, theme)} ${theme.fg("toolOutput", `${done}/${total}`)}`;
			if (running) s += theme.fg("dim", ` · ${running} run`);
			if (failed) s += theme.fg("error", ` · ${failed}✗`);
			if (time) s += `  ${time}`;
			return s;
		}
		return theme.fg("warning", "running…") + (time ? `  ${time}` : "");
	}

	// done
	if (isFanout) {
		const { done = 0, total = 0, failed = 0 } = ps.subProgress ?? {};
		let s = theme.fg("success", `${total}✓`);
		if (failed) s = theme.fg("toolOutput", `${done - failed}/${total}`) + theme.fg("error", ` ${failed}✗`);
		const u = compactUsage(ps.usage, theme);
		if (u) s += `  ${u}`;
		if (time) s += `  ${time}`;
		return s;
	}
	// single-agent done
	const model = shortModel(ps.model);
	const u = compactUsage(ps.usage, theme);
	let s = "";
	if (model) s += theme.fg("accent", model);
	if (u) s += (s ? "  " : "") + u;
	if (time) s += `  ${time}`;
	return s || theme.fg("dim", "done");
}

/** Header line: status glyph + name + compact totals. */
function headerLine(state: RunState, theme: Theme): string {
	const phases = Object.values(state.phases);
	const done = phases.filter((p) => p.status === "done").length;
	const failed = phases.filter((p) => p.status === "failed").length;
	const running = phases.filter((p) => p.status === "running").length;
	const total = state.def.phases.length;

	const head =
		state.status === "completed"
			? theme.fg("success", "✓")
			: state.status === "failed"
				? theme.fg("error", "✗")
				: state.status === "paused"
					? theme.fg("warning", "‖")
					: theme.fg("warning", spinnerFrame());

	let line =
		`${head} ${theme.fg("toolTitle", theme.bold("taskflow"))} ` +
		theme.fg("accent", state.flowName) +
		theme.fg("muted", `  ${done}/${total}`);
	if (running) line += theme.fg("warning", ` · ${running}▸`);
	if (failed) line += theme.fg("error", ` · ${failed}✗`);
	const cost = aggregateCost(state);
	if (cost) line += theme.fg("muted", ` · $${cost.toFixed(3)}`);
	const el = runElapsed(state);
	if (el) line += theme.fg("dim", ` · ${elapsed(el)}`);
	return line;
}

/** The full dense progress block (header + aligned phase rows). */
export function renderProgress(state: RunState, theme: Theme): string {
	const phases = state.def.phases;
	const idW = Math.max(...phases.map((p) => p.id.length), 2);
	const typeW = Math.max(...phases.map((p) => (p.type ?? "agent").length), 4);

	let text = headerLine(state, theme);
	for (const phase of phases) {
		const ps = state.phases[phase.id];
		const status = ps?.status ?? "pending";
		const id = phase.id.padEnd(idW);
		const type = (phase.type ?? "agent").padEnd(typeW);
		const detail = phaseDetail(phase, ps, theme);
		text +=
			`\n  ${icon(status, theme)} ` +
			theme.fg(status === "pending" ? "dim" : "text", id) +
			"  " +
			theme.fg("dim", type) +
			"  " +
			detail;
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
