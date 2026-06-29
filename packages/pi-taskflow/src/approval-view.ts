/**
 * Modal approval dialog for `approval` phases (ctx.ui.custom with overlay).
 *
 * Rendered as a centered bordered popup: the full upstream output (e.g. a
 * plan) is shown in a scrollable viewport so long content can be reviewed
 * before deciding. Every line is padded to the full dialog width so the
 * overlay composites cleanly (no see-through, no ghosting in scrollback).
 *
 * Mouse tracking is intentionally NOT used here. Enabling terminal-level
 * SGR mouse reporting (DECSET 1000h/1006h) to capture wheel events would
 * interfere with the terminal's native scrollback after the dialog closes,
 * because the restore sequence depends on the overlay framework reliably
 * calling dispose — which is not guaranteed across all lifecycle paths.
 * Keyboard scrolling (↑↓/PgUp/PgDn/Home/End/j/k/g/G) covers the same
 * ground without risking a stuck mouse-tracking mode.
 *
 * Keys: ↑↓ scroll · PgUp/PgDn page · Home/End jump ·
 *       a/Enter approve · e edit (guidance) · r/Esc reject.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type ApprovalChoice = "approve" | "reject" | "edit";

export interface ApprovalViewOptions {
	/** Header title, e.g. "Taskflow approval — flow/phase". */
	title: string;
	/** Interpolated approval prompt. */
	message: string;
	/** Full upstream phase output (the content being approved). */
	upstream?: string;
}

const FALLBACK_ROWS = 24;

export class ApprovalViewComponent {
	private theme: Theme;
	private opts: ApprovalViewOptions;
	private onDone: (choice: ApprovalChoice) => void;
	private getRows: () => number;
	private scrollOffset = 0;
	private cachedWidth?: number;
	private cachedBody?: string[];
	private decided = false;

	constructor(
		theme: Theme,
		opts: ApprovalViewOptions,
		onDone: (choice: ApprovalChoice) => void,
		getRows?: () => number,
	) {
		this.theme = theme;
		this.opts = opts;
		this.onDone = onDone;
		this.getRows = getRows ?? (() => FALLBACK_ROWS);
	}

	/** No-op — kept for compatibility with Pi TUI overlay dispose contract. */
	dispose(): void {}

	private decide(choice: ApprovalChoice): void {
		if (this.decided) return;
		this.decided = true;
		this.onDone(choice);
	}

	private rows(): number {
		try {
			return this.getRows() || FALLBACK_ROWS;
		} catch {
			return FALLBACK_ROWS;
		}
	}

	/** Visible body height given the message height — dialog targets ~80% of the terminal. */
	private maxVisible(msgRows: number): number {
		const avail = Math.max(10, Math.floor(this.rows() * 0.8));
		// Chrome: top border, message rows, separator, scroll info, separator, hints, bottom border.
		const chrome = 1 + msgRows + 1 + 1 + 1 + 1 + 1;
		return Math.max(3, Math.min(avail - chrome, 60));
	}

	/** Wrap the upstream text to the viewport width (cached per width). */
	private bodyLines(innerW: number): string[] {
		if (this.cachedBody && this.cachedWidth === innerW) return this.cachedBody;
		const out: string[] = [];
		const upstream = (this.opts.upstream ?? "").replace(/\r\n/g, "\n").trimEnd();
		if (upstream) {
			for (const raw of upstream.split("\n")) {
				if (!raw.trim()) {
					out.push("");
					continue;
				}
				for (const l of wrapTextWithAnsi(raw, innerW)) out.push(l);
			}
		}
		this.cachedWidth = innerW;
		this.cachedBody = out;
		return out;
	}

	private msgLines(innerW: number): string[] {
		const out: string[] = [];
		for (const raw of this.opts.message.split("\n")) {
			for (const l of wrapTextWithAnsi(raw, innerW)) out.push(l);
		}
		return out.length ? out : [""];
	}

	private maxOffset(totalLines: number, visible: number): number {
		return Math.max(0, totalLines - visible);
	}

	private clampScroll(delta: number): void {
		const total = this.cachedBody?.length ?? 0;
		const visible = this.maxVisible(1);
		const cap = this.maxOffset(total, visible);
		this.scrollOffset = Math.max(0, Math.min(cap, this.scrollOffset + delta));
	}

	handleInput(data: string): void {
		// Decisions
		if (matchesKey(data, "return") || data === "a" || data === "y") {
			this.decide("approve");
			return;
		}
		if (data === "e") {
			this.decide("edit");
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "r" || data === "n") {
			this.decide("reject");
			return;
		}
		// Scrolling (only meaningful when a body exists)
		const page = this.maxVisible(1);
		if (matchesKey(data, "up") || data === "k") {
			this.clampScroll(-1);
		} else if (matchesKey(data, "down") || data === "j") {
			this.clampScroll(1);
		} else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
			this.clampScroll(-page);
		} else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d") || matchesKey(data, "space")) {
			this.clampScroll(page);
		} else if (matchesKey(data, "home") || data === "g") {
			this.scrollOffset = 0;
		} else if (matchesKey(data, "end") || data === "G") {
			this.clampScroll(Number.MAX_SAFE_INTEGER);
		}
	}

	/** Pad `content` with spaces to exactly `w` visible columns (ANSI-aware). */
	private pad(content: string, w: number): string {
		const t = truncateToWidth(content, w);
		return t + " ".repeat(Math.max(0, w - visibleWidth(t)));
	}

	/** A full-width dialog row: │ <content padded> │ */
	private row(content: string, width: number): string {
		const th = this.theme;
		const inner = this.pad(content, Math.max(1, width - 4));
		return th.fg("border", "│") + " " + inner + " " + th.fg("border", "│");
	}

	private hrule(width: number, left: string, right: string): string {
		const th = this.theme;
		return th.fg("border", left + "─".repeat(Math.max(0, width - 2)) + right);
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(20, width - 4);
		const lines: string[] = [];

		// Top border with embedded title
		const title = truncateToWidth(` ${this.opts.title} `, Math.max(0, width - 6));
		const fill = Math.max(0, width - 4 - visibleWidth(title));
		lines.push(
			th.fg("border", "╭─") + th.fg("accent", title) + th.fg("border", "─".repeat(fill) + "─╮"),
		);

		// Approval prompt
		const msg = this.msgLines(innerW);
		for (const l of msg) lines.push(this.row(th.fg("text", l), width));

		// Scrollable upstream body
		const body = this.bodyLines(innerW);
		const visible = this.maxVisible(msg.length);
		const cap = this.maxOffset(body.length, visible);
		this.scrollOffset = Math.min(this.scrollOffset, cap);
		if (body.length > 0) {
			lines.push(this.hrule(width, "├", "┤"));
			const slice = body.slice(this.scrollOffset, this.scrollOffset + visible);
			while (slice.length < Math.min(visible, body.length)) slice.push("");
			for (const l of slice) lines.push(this.row(l, width));
			if (cap > 0) {
				const above = this.scrollOffset;
				const below = Math.max(0, body.length - visible - this.scrollOffset);
				lines.push(
					this.row(th.fg("dim", `↑${above} more · ↓${below} more (${body.length} lines)`), width),
				);
			}
		}

		// Key hints
		lines.push(this.hrule(width, "├", "┤"));
		const scrollHint = cap > 0 ? "↑↓/PgUp/PgDn scroll · " : "";
		lines.push(this.row(th.fg("dim", `${scrollHint}a/Enter approve · e edit · r/Esc reject`), width));
		lines.push(this.hrule(width, "╰", "╯"));
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedBody = undefined;
	}
}
