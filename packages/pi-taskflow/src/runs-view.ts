/**
 * Interactive run-history view for `/tf runs` (ctx.ui.custom).
 * List view: navigate runs; Enter → detail; r → resume; Esc/q → close.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { renderProgress, summarizeRun } from "./render.ts";
import type { RunState } from "taskflow-core";

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
	const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

function isResumable(r: RunState): boolean {
	return r.status === "paused" || r.status === "failed";
}

/** Detect whether a refreshed run list differs from the current one in any way
 * the panel renders (status, updatedAt, phase progress, membership). */
function hasChanged(prev: RunState[], next: RunState[]): boolean {
	if (prev.length !== next.length) return true;
	const byId = new Map(prev.map((r) => [r.runId, r]));
	for (const n of next) {
		const p = byId.get(n.runId);
		if (!p) return true;
		if (p.status !== n.status || p.updatedAt !== n.updatedAt) return true;
	}
	return false;
}

export class RunHistoryComponent {
	private runs: RunState[];
	private theme: Theme;
	private onDone: (result?: RunHistoryResult) => void;
	private selected = 0;
	private mode: "list" | "detail" = "list";
	private cachedWidth?: number;
	private cachedLines?: string[];
	/** Live-refresh wiring: re-read run state from disk while the panel is open
	 * so background (detached) runs show live progress without reopening. */
	private timer?: ReturnType<typeof setInterval>;
	private refresh?: () => RunState[];
	private requestRender?: () => void;

	constructor(
		runs: RunState[],
		theme: Theme,
		onDone: (result?: RunHistoryResult) => void,
		/** Optional live-refresh hooks. When both are provided the panel polls
		 * `refresh()` on an interval and calls `requestRender()` if anything changed. */
		live?: { refresh: () => RunState[]; requestRender: () => void; intervalMs?: number },
	) {
		if (!runs.length) {
			throw new Error("RunHistoryComponent requires at least one run");
		}
		this.runs = runs;
		this.theme = theme;
		this.onDone = onDone;
		if (live) {
			this.refresh = live.refresh;
			this.requestRender = live.requestRender;
			const intervalMs = Math.max(250, live.intervalMs ?? 1000);
			this.timer = setInterval(() => this.poll(), intervalMs);
			// Don't keep the event loop alive just for the panel refresh.
			(this.timer as { unref?: () => void }).unref?.();
		}
	}

	/** Re-read run state; if anything changed, refresh the cached render. */
	private poll(): void {
		if (!this.refresh) return;
		let next: RunState[];
		try {
			next = this.refresh();
		} catch {
			return; // transient read/lock error — try again next tick
		}
		if (!next.length) return;
		if (!hasChanged(this.runs, next)) return;
		// Preserve the user's selection by runId across refreshes.
		const selectedId = this.runs[this.selected]?.runId;
		this.runs = next;
		const idx = next.findIndex((r) => r.runId === selectedId);
		this.selected = idx >= 0 ? idx : Math.min(this.selected, next.length - 1);
		this.invalidate();
		this.requestRender?.();
	}

	/** Stop the refresh timer when the panel closes. */
	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
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
			const liveTag = this.timer && run.status === "running" ? th.fg("success", " ● live") : "";
			lines.push(truncateToWidth(`  ${th.fg("dim", hint)}${liveTag}`, width));
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
		const anyRunning = this.runs.some((r) => r.status === "running");
		const liveHint = this.timer && anyRunning ? th.fg("success", " ● live") : "";
		lines.push(
			truncateToWidth(`  ${th.fg("dim", "↑↓ select · Enter details · r resume · q close")}${liveHint}`, width),
		);
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
