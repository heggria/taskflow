/**
 * Modal approval dialog for `approval` phases (ctx.ui.custom with overlay).
 *
 * Rendered as a centered bordered popup with a sticky decision footer. Short
 * upstream output is shown immediately; content larger than the viewport is
 * collapsed by default and can be toggled independently. Every line is padded
 * to the full dialog width so the overlay composites cleanly (no see-through,
 * no ghosting in scrollback).
 *
 * Mouse tracking is intentionally NOT used here. Enabling terminal-level
 * SGR mouse reporting (DECSET 1000h/1006h) to capture wheel events would
 * interfere with the terminal's native scrollback after the dialog closes,
 * because the restore sequence depends on the overlay framework reliably
 * calling dispose — which is not guaranteed across all lifecycle paths.
 * Keyboard scrolling (↑↓/PgUp/PgDn/Home/End/j/k/g/G) covers the same
 * ground without risking a stuck mouse-tracking mode.
 *
 * Keys: A/E/R select a decision · Enter confirms · V toggles preview ·
 *       ↑↓ scroll · PgUp/PgDn page · Home/End jump · Esc rejects.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	parseKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

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
const DECISIONS: ApprovalChoice[] = ["reject", "edit", "approve"];
const DECISION_LABELS: Record<ApprovalChoice, string> = {
	reject: "Reject",
	edit: "Edit guidance",
	approve: "Approve",
};

export class ApprovalViewComponent {
	private theme: Theme;
	private opts: ApprovalViewOptions;
	private onDone: (choice: ApprovalChoice) => void;
	private getRows: () => number;
	private scrollOffset = 0;
	private cachedWidth?: number;
	private cachedBody?: string[];
	private previewExpanded?: boolean;
	private selectedChoice: ApprovalChoice = "reject";
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
		// Chrome: border, message, preview summary, scroll info, decision, hints, separators.
		const chrome = msgRows + 8;
		return Math.max(3, Math.min(avail - chrome, 60));
	}

	private upstreamLineCount(): number {
		const upstream = (this.opts.upstream ?? "").replace(/\r\n/g, "\n").trimEnd();
		return upstream ? upstream.split("\n").length : 0;
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
		if (!this.previewExpanded) return;
		const total = this.cachedBody?.length ?? 0;
		const visible = this.maxVisible(1);
		const cap = this.maxOffset(total, visible);
		this.scrollOffset = Math.max(0, Math.min(cap, this.scrollOffset + delta));
	}

	handleInput(data: string): void {
		if (this.decided) return;
		if (isKeyRelease(data)) return;
		const printable = (decodeKittyPrintable(data) ?? parseKey(data))?.toLowerCase();
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.decide("reject");
			return;
		}
		if (printable === "v" && !isKeyRepeat(data) && this.upstreamLineCount() > 0) {
			this.previewExpanded = !(this.previewExpanded ?? false);
			return;
		}
		if (matchesKey(data, "return")) {
			this.decide(this.selectedChoice);
			return;
		}

		if (printable === "r") this.selectedChoice = "reject";
		else if (printable === "e") this.selectedChoice = "edit";
		else if (printable === "a") this.selectedChoice = "approve";
		else if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) {
			const current = DECISIONS.indexOf(this.selectedChoice);
			this.selectedChoice = DECISIONS[(current - 1 + DECISIONS.length) % DECISIONS.length]!;
		} else if (matchesKey(data, "right") || matchesKey(data, "tab")) {
			const current = DECISIONS.indexOf(this.selectedChoice);
			this.selectedChoice = DECISIONS[(current + 1) % DECISIONS.length]!;
		}

		// Scrolling is independent of the selected decision and only acts while expanded.
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

	private decisionLine(): string {
		const th = this.theme;
		const choices = DECISIONS.map((choice) => {
			const label = DECISION_LABELS[choice];
			return choice === this.selectedChoice
				? th.fg("accent", `[${label}]`)
				: th.fg("dim", ` ${label} `);
		});
		return `Decision: ${choices.join("   ")}`;
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

		// Independently collapsible upstream body. Only overflowing previews start collapsed.
		const body = this.bodyLines(innerW);
		const visible = this.maxVisible(msg.length);
		const cap = this.maxOffset(body.length, visible);
		if (this.previewExpanded === undefined) this.previewExpanded = body.length > 0 && cap === 0;
		this.scrollOffset = Math.min(this.scrollOffset, cap);
		if (body.length > 0) {
			lines.push(this.hrule(width, "├", "┤"));
			const state = this.previewExpanded ? "expanded" : "collapsed";
			const action = this.previewExpanded ? "Hide" : "View";
			lines.push(
				this.row(
					th.fg("dim", `Proposal: ${this.upstreamLineCount()} lines · ${state} · [V] ${action} proposal`),
					width,
				),
			);
			if (this.previewExpanded) {
				const slice = body.slice(this.scrollOffset, this.scrollOffset + visible);
				while (slice.length < Math.min(visible, body.length)) slice.push("");
				for (const l of slice) lines.push(this.row(l, width));
				if (cap > 0) {
					const above = this.scrollOffset;
					const below = Math.max(0, body.length - visible - this.scrollOffset);
					lines.push(
						this.row(th.fg("dim", `↑${above} more · ↓${below} more (${body.length} wrapped lines)`), width),
					);
				}
			}
		}

		// Sticky decision footer: selecting never decides; Enter is always required.
		lines.push(this.hrule(width, "├", "┤"));
		lines.push(this.row(this.decisionLine(), width));
		const scrollHint = this.previewExpanded && cap > 0 ? "↑↓/PgUp/PgDn scroll · " : "";
		lines.push(
			this.row(th.fg("dim", `${scrollHint}←/→ or R/E/A select · Enter confirm · V preview · Esc reject`), width),
		);
		lines.push(this.hrule(width, "╰", "╯"));
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedBody = undefined;
	}
}
