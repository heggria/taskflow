/**
 * TUI rendering for the taskflow tool and commands.
 */

import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { formatUsage } from "./runner.ts";
import type { PhaseState, RunState } from "./store.ts";

const STATUS_ICON: Record<PhaseState["status"], (t: Theme) => string> = {
	pending: (t) => t.fg("dim", "○"),
	running: (t) => t.fg("warning", "⏳"),
	done: (t) => t.fg("success", "✓"),
	failed: (t) => t.fg("error", "✗"),
	skipped: (t) => t.fg("muted", "⊘"),
};

export function phaseIcon(status: PhaseState["status"], theme: Theme): string {
	return (STATUS_ICON[status] ?? STATUS_ICON.pending)(theme);
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

/** Compact one-line-per-phase progress block. */
export function renderProgress(state: RunState, theme: Theme): string {
	let text =
		theme.fg("toolTitle", theme.bold("taskflow ")) +
		theme.fg("accent", state.flowName) +
		theme.fg("muted", `  ${summarizeRun(state)}`);

	for (const phase of state.def.phases) {
		const ps = state.phases[phase.id] ?? { id: phase.id, status: "pending" as const };
		const icon = phaseIcon(ps.status, theme);
		const type = theme.fg("dim", `[${phase.type ?? "agent"}]`);
		let line = `\n  ${icon} ${theme.fg("accent", phase.id)} ${type}`;
		if (ps.status === "running") line += theme.fg("warning", " …");
		if (ps.usage?.cost) line += theme.fg("dim", `  ${formatUsage(ps.usage, ps.model)}`);
		if (ps.status === "failed" && ps.error) {
			const e = ps.error.length > 60 ? `${ps.error.slice(0, 60)}…` : ps.error;
			line += theme.fg("error", `  ${e}`);
		}
		text += line;
	}
	return text;
}

export function renderRunResult(state: RunState, finalOutput: string, theme: Theme, expanded: boolean): Container | Text {
	if (!expanded) {
		const icon =
			state.status === "completed"
				? theme.fg("success", "✓")
				: state.status === "failed"
					? theme.fg("error", "✗")
					: theme.fg("warning", "⏸");
		let text = `${icon} ${renderProgress(state, theme)}`;
		text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
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
