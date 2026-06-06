/**
 * Interactive run-history view for `/tf runs` (ctx.ui.custom).
 * List view: navigate runs; Enter → detail; r → resume; Esc/q → close.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { renderProgress, summarizeRun } from "./render.ts";
import type { RunState } from "./store.ts";

export interface RunHistoryResult {
	action: "resume";
	runId: string;
}

function statusBadge(status: RunState["status"], theme: Theme): string {
	switch (status) {
		case "completed":
			return theme.fg("success", "✓ done");
		case "failed":
			return theme.fg("error", "✗ failed");
		case "blocked":
			return theme.fg("error", "⊗ blocked");
		case "paused":
			return theme.fg("warning", "‖ paused");
		default:
			return theme.fg("warning", "◐ running");
	}
}

function timeAgo(ts: number): string {
	const s = Math.floor((Date.now() - ts) / 1000);
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

function isResumable(r: RunState): boolean {
	return r.status === "paused" || r.status === "failed" || r.status === "blocked";
}

export class RunHistoryComponent {
	private runs: RunState[];
	private theme: Theme;
	private onDone: (result?: RunHistoryResult) => void;
	private selected = 0;
	private mode: "list" | "detail" = "list";
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(runs: RunState[], theme: Theme, onDone: (result?: RunHistoryResult) => void) {
		if (!runs.length) {
			throw new Error("RunHistoryComponent requires at least one run");
		}
		this.runs = runs;
		this.theme = theme;
		this.onDone = onDone;
	}

	handleInput(data: string): void {
		this.invalidate();
		if (this.mode === "detail") {
			if (matchesKey(data, "escape")) {
				this.mode = "list";
				return;
			}
			if (data === "r" && isResumable(this.runs[this.selected])) {
				this.onDone({ action: "resume", runId: this.runs[this.selected].runId });
			}
			return;
		}
		// list mode
		if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+c")) {
			this.onDone();
			return;
		}
		if (matchesKey(data, "up")) {
			this.selected = (this.selected - 1 + this.runs.length) % this.runs.length;
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = (this.selected + 1) % this.runs.length;
			return;
		}
		if (matchesKey(data, "return")) {
			this.mode = "detail";
			return;
		}
		if (data === "r" && isResumable(this.runs[this.selected])) {
			this.onDone({ action: "resume", runId: this.runs[this.selected].runId });
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const lines: string[] = [""];

		if (this.mode === "detail") {
			const run = this.runs[this.selected];
			lines.push(truncateToWidth(`  ${th.fg("accent", "Run ")}${th.fg("muted", run.runId)}`, width));
			lines.push("");
			for (const l of renderProgress(run, th).split("\n")) lines.push(truncateToWidth(l, width));
			lines.push("");
			const hint = isResumable(run) ? "Esc back · r resume" : "Esc back";
			lines.push(truncateToWidth(`  ${th.fg("dim", hint)}`, width));
			lines.push("");
			this.cachedWidth = width;
			this.cachedLines = lines;
			return lines;
		}

		// list mode
		const header =
			th.fg("borderMuted", "─".repeat(3)) +
			th.fg("accent", " Taskflow runs ") +
			th.fg("borderMuted", "─".repeat(Math.max(0, width - 18)));
		lines.push(truncateToWidth(header, width));
		lines.push("");

		this.runs.forEach((run, i) => {
			const sel = i === this.selected;
			const marker = sel ? th.fg("accent", "❯ ") : "  ";
			const badge = statusBadge(run.status, th);
			const name = sel ? th.fg("text", run.flowName) : th.fg("muted", run.flowName);
			const meta = th.fg("dim", `${summarizeRun(run)} · ${timeAgo(run.updatedAt)}`);
			lines.push(truncateToWidth(`  ${marker}${badge}  ${name}  ${meta}`, width));
		});

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "↑↓ select · Enter details · r resume · q close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
