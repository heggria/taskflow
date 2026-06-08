/**
 * `/tf init` — single source of truth for model-role configuration.
 *
 * Exports:
 *   INIT_ROLES, RECOMMENDED_DEFAULTS          – role catalog & recommended defaults
 *   readSettings, writeSettings                – settings.json I/O (atomic writes)
 *   formatModelOption, buildRoleOptions        – picker UI helpers
 *   parseCustomModel                           – custom model string validator
 *   modelExists                                – registry membership check (guards typos)
 *   diffRoles                                  – diff engine for preview screen
 *   formatRolesReport, formatDiffReport        – read-only report formatters
 *   runInteractiveInit                         – full interactive UX flow
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { writeFileAtomic } from "./store.ts";

// ---------------------------------------------------------------------------
// Role catalog
// ---------------------------------------------------------------------------

export interface InitRole {
	role: string;
	description: string;
	defaultModel: string;
	/** Filter the model registry to models usable for this role. */
	filter?: (m: Model<Api>) => boolean;
	/** Sort tiebreaker after recommended-first. */
	sort?: (a: Model<Api>, b: Model<Api>) => number;
	/** Prefer `reasoning: true` models in display order. */
	preferReasoning?: boolean;
}

export const INIT_ROLES: readonly InitRole[] = [
	{
		role: "fast",
		description:
			"Cheap & quick — high-volume, low-stakes tasks (executor, scout, recover, verifier, doc-writer, test-engineer)",
		defaultModel: "openrouter/deepseek/deepseek-v4-flash",
	},
	{
		role: "strong",
		description:
			"Balanced — planning, review, moderate complexity (planner, reviewer, executor-code)",
		defaultModel: "openrouter/xiaomi/mimo-v2.5-pro",
	},
	{
		role: "thinker",
		description:
			"Deep analysis — requirements, ambiguity detection, critique (analyst, critic)",
		defaultModel: "openrouter/deepseek/deepseek-v4-pro",
		preferReasoning: true,
		sort: (a, b) => (a.reasoning === b.reasoning ? 0 : a.reasoning ? -1 : 1),
	},
	{
		role: "arbiter",
		description:
			"Final judgment — tiebreak, plan quality gates (plan-arbiter, final-arbiter)",
		defaultModel: "openrouter/qwen/qwen3.7-max",
		preferReasoning: true,
		sort: (a, b) => (a.reasoning === b.reasoning ? 0 : a.reasoning ? -1 : 1),
	},
	{
		role: "vision",
		description:
			"Multimodal — UI work, design reading, Figma analysis (executor-ui, visual-explorer)",
		defaultModel: "minimax/MiniMax-M3",
		filter: (m) => m.input.includes("image"),
	},
	{
		role: "reasoner",
		description:
			"Cautious reasoning — security, risk review, sensitive changes (risk-reviewer, security-reviewer)",
		defaultModel: "z-ai/glm-5.1",
		preferReasoning: true,
		sort: (a, b) => (a.reasoning === b.reasoning ? 0 : a.reasoning ? -1 : 1),
	},
];

/** Derived from INIT_ROLES — the catalog is the single source of truth. */
export const RECOMMENDED_DEFAULTS: Readonly<Record<string, string>> = Object.fromEntries(
	INIT_ROLES.map((r) => [r.role, r.defaultModel]),
);

// ---------------------------------------------------------------------------
// Settings path
// ---------------------------------------------------------------------------

/** Returns the current settings.json path (respects PI_CODING_AGENT_DIR). */
export function getSettingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

// ---------------------------------------------------------------------------
// Settings I/O
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function readSettings(): Record<string, unknown> {
	const sp = getSettingsPath();
	if (!fs.existsSync(sp)) return {};
	const raw: unknown = JSON.parse(fs.readFileSync(sp, "utf-8"));
	if (!isPlainObject(raw)) return {};
	if ("modelRoles" in raw) {
		if (!isPlainObject(raw.modelRoles)) {
			console.warn("[taskflow] settings.json: modelRoles had unexpected shape, treating as empty.");
			raw.modelRoles = {};
		}
	}
	return raw as Record<string, unknown>;
}

export function writeSettings(settings: Record<string, unknown>): string {
	const sp = getSettingsPath();
	writeFileAtomic(sp, JSON.stringify(settings, null, 2) + "\n");
	return sp;
}

// ---------------------------------------------------------------------------
// Picker helpers (pure, fully testable)
// ---------------------------------------------------------------------------

/** Build a display label for a model in the picker. */
export function formatModelOption(m: Model<Api>): string {
	const tags: string[] = [];
	if (m.input.includes("image")) tags.push("image ✓");
	if (m.reasoning) tags.push("reasoning ✓");
	const tagStr = tags.length > 0 ? ` · ${tags.join(" · ")}` : "";
	return `${m.name} (${m.provider}/${m.id})${tagStr}`;
}

/** Build picker options for a single role. */
export function buildRoleOptions(
	role: InitRole,
	available: ReadonlyArray<Model<Api>>,
	ctx: { current?: string; recommended?: string },
): string[] {
	const recommendedId = ctx.recommended;
	const pool = role.filter ? available.filter(role.filter) : [...available];
	if (role.sort) pool.sort(role.sort);
	else if (role.preferReasoning) pool.sort((a, b) => (a.reasoning === b.reasoning ? 0 : a.reasoning ? -1 : 1));

	const seen = new Set<string>();
	const options: string[] = [];
	for (const m of pool) {
		const key = `${m.provider}/${m.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const isCurrent = key === ctx.current;
		const isRecommended = key === recommendedId;
		const suffix = isCurrent
			? " · (current)"
			: isRecommended
				? " · (recommended)"
				: "";
		options.push(`${formatModelOption(m)}${suffix}`);
	}
	options.push("───────────────");
	options.push("Custom (type your own)");
	if (ctx.current !== undefined) options.push("Keep current");
	options.push("Back to action menu");
	return options;
}

/** Parse a custom model string like "provider/model-id" or "provider/a/b/c". */
export function parseCustomModel(input: string): { provider: string; id: string } | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	const slashIdx = trimmed.indexOf("/");
	if (slashIdx < 0) return null;
	const provider = trimmed.slice(0, slashIdx).trim();
	const id = trimmed.slice(slashIdx + 1).trim();
	if (!provider || !id) return null;
	return { provider, id };
}

/**
 * Returns true if `provider/id` exists in the available model registry.
 * Used to warn before persisting a hand-typed model that would never resolve
 * at runtime (e.g. a typo or a copy-pasted example string).
 */
export function modelExists(
	provider: string,
	id: string,
	available: ReadonlyArray<Model<Api>>,
): boolean {
	return available.some((m) => m.provider === provider && m.id === id);
}

// ---------------------------------------------------------------------------
// Diff engine for preview screen
// ---------------------------------------------------------------------------

export type RoleDiffStatus = "unchanged" | "changed" | "new" | "stale-preserved";

export interface RoleDiffEntry {
	role: string;
	status: RoleDiffStatus;
	before?: string;
	after?: string;
}

export function diffRoles(
	before: Record<string, string>,
	after: Record<string, string>,
	catalog: ReadonlyArray<{ role: string }>,
): RoleDiffEntry[] {
	const seen = new Set<string>();
	const diffs: RoleDiffEntry[] = [];
	for (const c of catalog) {
		seen.add(c.role);
		const b = before[c.role];
		const a = after[c.role];
		if (b === undefined) {
			diffs.push({ role: c.role, status: "new", after: a });
		} else if (b === a) {
			diffs.push({ role: c.role, status: "unchanged", before: b, after: a });
		} else {
			diffs.push({ role: c.role, status: "changed", before: b, after: a });
		}
	}
	// Append stale keys from `before` that are not in catalog
	for (const key of Object.keys(before)) {
		if (!seen.has(key)) {
			diffs.push({ role: key, status: "stale-preserved", before: before[key], after: before[key] });
		}
	}
	return diffs;
}

// ---------------------------------------------------------------------------
// Read-only report formatters
// ---------------------------------------------------------------------------

function formatSettingsPath(sp: string): string {
	const home = process.env.HOME ?? "";
	if (home && sp.startsWith(home)) return `~${sp.slice(home.length)}`;
	return sp;
}

export function formatRolesReport(current: Record<string, string>): string {
	const sp = formatSettingsPath(getSettingsPath());
	if (Object.keys(current).length === 0) {
		return `No modelRoles configured in ${sp}. Use /tf init interactively to select models.`;
	}
	const lines = [`Model roles configured in ${sp}:`, ""];
	for (const role of INIT_ROLES) {
		const val = current[role.role];
		if (val) lines.push(`  ${role.role.padEnd(10)} → ${val}  (${role.description})`);
	}
	// Append stale keys
	for (const key of Object.keys(current)) {
		if (!INIT_ROLES.some((r) => r.role === key)) {
			lines.push(`  ${key.padEnd(10)} → ${current[key]}  (stale — not in current role catalog)`);
		}
	}
	lines.push("", "To reconfigure, run /tf init interactively.");
	return lines.join("\n");
}

const STATUS_SYMBOL: Record<RoleDiffStatus, string> = {
	unchanged: "  ",
	changed: "↔ ",
	new: "+ ",
	"stale-preserved": "⚠ ",
};

export function formatDiffReport(
	before: Record<string, string>,
	after: Record<string, string>,
): string {
	const diffs = diffRoles(before, after, INIT_ROLES);
	const sp = formatSettingsPath(getSettingsPath());
	const lines = [`Wrote model roles to ${sp}:`, ""];
	for (const d of diffs) {
		const sym = STATUS_SYMBOL[d.status];
		if (d.status === "unchanged") {
			lines.push(`  ${sym}${d.role.padEnd(10)} → ${d.after}  (unchanged)`);
		} else if (d.status === "changed") {
			lines.push(`  ${sym}${d.role.padEnd(10)} → ${d.after}  (was: ${d.before})`);
		} else if (d.status === "new") {
			lines.push(`  ${sym}${d.role.padEnd(10)} → ${d.after}  (new)`);
		} else if (d.status === "stale-preserved") {
			lines.push(`  ${sym}${d.role.padEnd(10)} → ${d.before}  (stale — preserved but not in catalog)`);
		}
	}
	return lines.join("\n");
}

export function formatFlowResult(result: InitFlowResult): string {
	if (result.kind === "cancelled") return "Init cancelled.";
	if (result.kind === "no-change") {
		return (
			"No changes.\n" +
			Object.entries(result.chosen)
				.map(([k, v]) => `  ${k.padEnd(10)} → ${v}`)
				.join("\n")
		);
	}
	// kind === "saved"
	const savedPath = formatSettingsPath(result.savedPath);
	return (
		`Saved model roles to ${savedPath}:\n` +
		Object.entries(result.chosen)
			.map(([k, v]) => `  ${k.padEnd(10)} → ${v}`)
			.join("\n")
	);
}

// ---------------------------------------------------------------------------
// Main interactive flow
// ---------------------------------------------------------------------------

export type InitFlowResult =
	| { kind: "saved"; chosen: Record<string, string>; savedPath: string }
	| { kind: "no-change"; chosen: Record<string, string> }
	| { kind: "cancelled" };

export async function runInteractiveInit(ctx: {
	hasUI: boolean;
	signal: AbortSignal;
	ui: ExtensionUIContext;
	modelRegistry: ExtensionContext["modelRegistry"];
	modelList: Model<Api>[];
	currentRoles: Record<string, string>;
}): Promise<InitFlowResult> {
	if (!ctx.hasUI) {
		throw new Error("runInteractiveInit requires an interactive session (hasUI=true).");
	}

	const recommended = RECOMMENDED_DEFAULTS;
	const current = ctx.currentRoles;
	const hasCurrent = Object.keys(current).length > 0;

	// ---- Action menu ----
	const actionOptions = hasCurrent
		? [
				"Use recommended defaults",
				"Configure each role",
				"Edit one role",
				"Show current roles",
				"Cancel",
			]
		: ["Use recommended defaults", "Configure each role"];

	const action = await ctx.ui.select(
		"What do you want to do with model roles?",
		actionOptions,
		{ signal: ctx.signal },
	);

	if (action === undefined) return { kind: "cancelled" };

	// ---- Use recommended defaults ----
	if (action === "Use recommended defaults") {
		const merged: Record<string, string> = { ...recommended };
		for (const key of Object.keys(current)) {
			if (!(key in merged)) merged[key] = current[key];
		}
		const diff = diffRoles(current, merged, INIT_ROLES);
		const noChange = diff.every((d) => d.status === "unchanged" || d.status === "stale-preserved");
		if (noChange) return { kind: "no-change", chosen: merged };
		const savedPath = writeSettings({ ...readSettings(), modelRoles: merged });
		return { kind: "saved", chosen: merged, savedPath };
	}

	// ---- Show current roles ----
	if (action === "Show current roles") {
		ctx.ui.notify(formatRolesReport(current), "info");
		return { kind: "cancelled" };
	}

	// ---- Cancel ----
	if (action === "Cancel") return { kind: "cancelled" };

	// ---- Configure each role ----
	if (action === "Configure each role") {
		const chosen = await collectRolePicks(ctx, current, recommended, undefined);
		if (chosen === undefined) return { kind: "cancelled" };
		return finalizeOrPreview(ctx, current, chosen, recommended);
	}

	// ---- Edit one role ----
	if (action === "Edit one role") {
		const chosen = await collectSingleRoleEdit(ctx, current, recommended);
		if (chosen === undefined) return { kind: "cancelled" };
		return finalizeOrPreview(ctx, current, chosen, recommended);
	}

	return { kind: "cancelled" };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Collect picks for all roles. Returns undefined if user escapes to action menu. */
async function collectRolePicks(
	ctx: { signal: AbortSignal; ui: ExtensionUIContext; modelList: Model<Api>[] },
	current: Record<string, string>,
	recommended: Record<string, string>,
	startAtRole: string | undefined,
): Promise<Record<string, string> | undefined> {
	const chosen: Record<string, string> = { ...current };
	let startIdx = 0;
	if (startAtRole) {
		const idx = INIT_ROLES.findIndex((r) => r.role === startAtRole);
		if (idx >= 0) startIdx = idx;
	}
	for (let i = startIdx; i < INIT_ROLES.length; i++) {
		const role = INIT_ROLES[i];
		const val = await pickOneRole(ctx, role, current, recommended, chosen);
		if (val === "back") return undefined; // back to action menu
		if (val !== undefined) chosen[role.role] = val;
		// val === undefined → keep existing (selected "Keep current")
	}
	return chosen;
}

/** Collect a single-role edit. Returns undefined if user escapes. */
async function collectSingleRoleEdit(
	ctx: { signal: AbortSignal; ui: ExtensionUIContext; modelList: Model<Api>[] },
	current: Record<string, string>,
	recommended: Record<string, string>,
): Promise<Record<string, string> | undefined> {
	const chosen: Record<string, string> = { ...current };
	const roleOptions = INIT_ROLES.map((r) => {
		const cur = current[r.role];
		const suffix = cur ? ` (current: ${cur})` : "";
		return `${r.role} — ${r.description}${suffix}`;
	});
	roleOptions.push("───────────────");
	roleOptions.push("Back to action menu");
	const picked = await ctx.ui.select("Which role to edit?", roleOptions, {
		signal: ctx.signal,
	});
	if (picked === undefined || picked === "Back to action menu") return undefined;
	const roleName = picked.split(" — ")[0];
	const role = INIT_ROLES.find((r) => r.role === roleName);
	if (!role) return undefined;
	const val = await pickOneRole(ctx, role, current, recommended, chosen);
	if (val === "back") return undefined;
	if (val !== undefined) chosen[role.role] = val;
	return chosen;
}

/** Pick a model for one role. Returns "back" to signal exit, undefined for "keep current". */
async function pickOneRole(
	ctx: { signal: AbortSignal; ui: ExtensionUIContext; modelList: Model<Api>[] },
	role: InitRole,
	current: Record<string, string>,
	recommended: Record<string, string>,
	_partialChosen: Record<string, string>,
): Promise<string | "back" | undefined> {
	const cur = current[role.role];
	const options = buildRoleOptions(role, ctx.modelList, {
		current: cur,
		recommended: recommended[role.role],
	});
	const title =
		`Model for '${role.role}' — ${role.description}` +
		(cur !== undefined ? `\nCurrent: ${cur}` : "");
	const pick = await ctx.ui.select(title, options, { signal: ctx.signal });

	if (pick === undefined) return "back"; // Esc = back to action menu
	if (pick === "Back to action menu") return "back";
	if (pick === "───────────────") return cur ?? recommended[role.role];
	if (pick === "Custom (type your own)") {
		const custom = await ctx.ui.input(
			`Enter model identifier for '${role.role}'`,
			"provider/model-id",
			{ signal: ctx.signal },
		);
		if (custom === undefined) return cur ?? recommended[role.role];
		const parsed = parseCustomModel(custom);
		if (!parsed) return cur ?? recommended[role.role];
		const full = `${parsed.provider}/${parsed.id}`;
		// Guard: a hand-typed model that isn't in the registry will fail at
		// runtime with "Model not found" and silently break every flow that
		// uses this role. Require explicit confirmation before accepting it.
		if (!modelExists(parsed.provider, parsed.id, ctx.modelList)) {
			const keep = await ctx.ui.confirm(
				`'${full}' is not in the model registry`,
				`This model was not found and may fail at runtime with "Model not found".\n` +
					`Use it anyway?`,
				{ signal: ctx.signal },
			);
			if (!keep) return cur ?? recommended[role.role];
		}
		return full;
	}
	if (pick === "Keep current") return undefined;
	// Parse model from display label: "Name (provider/id) · tags..."
	const match = pick.match(/\(([^)]+)\)/);
	return match ? match[1] : pick;
}

/** Check if two role maps are semantically identical. */
function rolesIdentical(
	a: Record<string, string>,
	b: Record<string, string>,
): boolean {
	const keysA = Object.keys(a).sort();
	const keysB = Object.keys(b).sort();
	if (keysA.length !== keysB.length) return false;
	return keysA.every((k) => a[k] === b[k]);
}

/** Run the preview/save flow. Returns the InitFlowResult. */
async function finalizeOrPreview(
	ctx: { signal: AbortSignal; ui: ExtensionUIContext; modelList: Model<Api>[] },
	current: Record<string, string>,
	chosen: Record<string, string>,
	recommended: Record<string, string>,
): Promise<InitFlowResult> {
	// Short-circuit: no change
	if (rolesIdentical(current, chosen)) return { kind: "no-change", chosen };

	// Preview screen
	const diffs = diffRoles(current, chosen, INIT_ROLES);
	const previewLines = ["Review changes:", ""];
	for (const d of diffs) {
		if (d.status === "unchanged") {
			previewLines.push(`  ${d.role.padEnd(10)} ${d.after ?? ""}   (unchanged)`);
		} else if (d.status === "changed") {
			previewLines.push(`  ${d.role.padEnd(10)} ${d.after ?? ""}   (changed ← was: ${d.before})`);
		} else if (d.status === "new") {
			previewLines.push(`  ${d.role.padEnd(10)} ${d.after ?? ""}   (new)`);
		} else if (d.status === "stale-preserved") {
			previewLines.push(`  ${d.role.padEnd(10)} ${d.before ?? ""}   (stale — preserved)`);
		}
	}
	const previewTitle = previewLines.join("\n");
	const previewAction = await ctx.ui.select(
		previewTitle,
		["Save these changes", "Edit a role", "Cancel"],
		{ signal: ctx.signal },
	);

	if (previewAction === "Save these changes") {
		const settings = readSettings();
		const merged = { ...settings, modelRoles: chosen };
		const savedPath = writeSettings(merged);
		return { kind: "saved", chosen, savedPath };
	}
	if (previewAction === "Cancel" || previewAction === undefined) {
		return { kind: "cancelled" };
	}
	// "Edit a role" — jump back into per-role loop
	const changedRole = diffs.find((d) => d.status === "changed")?.role ?? INIT_ROLES[0].role;
	const reChosen = await collectRolePicks(ctx, current, recommended, changedRole);
	if (reChosen === undefined) return { kind: "cancelled" };
	return finalizeOrPreview(ctx, current, reChosen, recommended);
}
