/**
 * Pure decision functions a deterministic replay can call **without importing
 * `runtime.ts`** (which drags in the process-spawning runner). These are the
 * only runtime decisions that are (a) deterministic and (b) re-evaluable against
 * recorded data: a gate verdict parsed from text, and a budget check tallied
 * against recorded usage.
 *
 * Extracted from `runtime.ts` as a preparatory seam for 0.2.0 replay. The
 * originals are re-exported from `runtime.ts` for backward compatibility; new
 * pure consumers (replay) import from here.
 *
 * 0.2.8 budget: soft vs hard ceilings with critical-path reserve so fan-out
 * cannot starve `final` / `budgetClass:"critical"` phases.
 */

import { safeParse } from "./interpolate.ts";
import { VERDICT_TOKEN_RE, WINNER_TOKEN_RE } from "./scorers.ts";
import { aggregateUsage, emptyUsage, type UsageStats } from "./usage.ts";

/** A gate verdict parsed from a (possibly JSON, possibly free-text) output. */
export function parseGateVerdict(output: string): { verdict: "pass" | "block"; reason?: string } {
	const json = safeParse(output);
	if (json && typeof json === "object") {
		const o = json as Record<string, unknown>;
		if (typeof o.continue === "boolean")
			return { verdict: o.continue ? "pass" : "block", reason: asReason(o.reason) };
		if (typeof o.pass === "boolean")
			return { verdict: o.pass ? "pass" : "block", reason: asReason(o.reason) };
		if (typeof o.verdict === "string") {
			// Note: do NOT include standalone "no" — natural-language verdicts like
			// "No issues found" / "no errors" would otherwise be false-positive BLOCK.
			// An explicit non-blocking verdict word is a semantic PASS, not ambiguity:
			// fail-closed below only applies when NO verdict could be parsed at all.
			const block = /block|fail|stop|reject|halt/i.test(o.verdict);
			return { verdict: block ? "block" : "pass", reason: asReason(o.reason) };
		}
	}
	const matches = [...output.matchAll(VERDICT_TOKEN_RE)];
	if (matches.length) {
		const v = matches[matches.length - 1][1].toUpperCase();
		const pass = v === "PASS" || v === "OK";
		return { verdict: pass ? "pass" : "block" };
	}
	return { verdict: "block", reason: "unparseable gate verdict (fail-closed)" };
}

function asReason(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Budget (0.2.8 soft / hard + critical-path reserve)
// ---------------------------------------------------------------------------

/** Admission mode: soft leaves headroom for critical phases; hard is the true ceiling. */
export type BudgetMode = "soft" | "hard";

/** Minimal budget shape for pure helpers (avoids importing schema). */
export interface BudgetLike {
	maxUSD?: number;
	maxTokens?: number;
	/** Absolute tokens reserved for critical phases (wins over ratio when set). */
	reserveTokens?: number;
	/** Absolute USD reserved for critical phases (wins over ratio when set). */
	reserveUSD?: number;
	/**
	 * Fraction of maxTokens/maxUSD reserved when the matching absolute field is
	 * omitted. Clamped to [0, 0.5]. Default 0.2 when a critical path exists and
	 * the field is omitted; explicit 0 disables auto-reserve.
	 */
	reserveRatio?: number;
}

/** Minimal phase shape for critical-path detection. */
export interface BudgetPhaseLike {
	final?: boolean;
	budgetClass?: "normal" | "critical";
}

/** Default auto-reserve ratio when a critical path exists and reserveRatio is omitted. */
export const DEFAULT_BUDGET_RESERVE_RATIO = 0.2;

/** Maximum allowed reserveRatio (schema + resolve clamp). */
export const MAX_BUDGET_RESERVE_RATIO = 0.5;

/**
 * True when the phase may spend into the reserve (hard ceiling).
 * `final: true` or explicit `budgetClass: "critical"`.
 */
export function isCriticalPhase(phase: BudgetPhaseLike | undefined | null): boolean {
	if (!phase) return false;
	if (phase.budgetClass === "critical") return true;
	if (phase.budgetClass === "normal") return false;
	return phase.final === true;
}

/** True when the flow declares any critical / final phase. */
export function flowHasCriticalPath(phases: readonly BudgetPhaseLike[] | undefined | null): boolean {
	if (!phases?.length) return false;
	return phases.some((p) => isCriticalPhase(p));
}

/** Admission mode for a phase (critical → hard, else soft). */
export function budgetModeForPhase(phase: BudgetPhaseLike | undefined | null): BudgetMode {
	return isCriticalPhase(phase) ? "hard" : "soft";
}

/** Resolved hard/soft ceilings for a budget declaration. */
export interface ResolvedBudgetCeilings {
	hardTokens?: number;
	softTokens?: number;
	hardUSD?: number;
	softUSD?: number;
	/** Tokens held back for critical work (0 when none). */
	reserveTokens: number;
	/** USD held back for critical work (0 when none). */
	reserveUSD: number;
}

/**
 * Resolve soft/hard ceilings from a budget declaration.
 *
 * - Hard = declared maxTokens / maxUSD.
 * - Soft = hard − reserve (never below 0).
 * - Reserve: absolute field wins; else ratio × hard; default ratio is
 *   {@link DEFAULT_BUDGET_RESERVE_RATIO} when `hasCriticalPath` and ratio omitted;
 *   explicit `reserveRatio: 0` disables auto-reserve.
 */
export function resolveBudgetCeilings(
	budget: BudgetLike | undefined,
	opts?: { hasCriticalPath?: boolean },
): ResolvedBudgetCeilings {
	if (!budget) {
		return { reserveTokens: 0, reserveUSD: 0 };
	}
	const hasCritical = opts?.hasCriticalPath === true;
	const ratioRaw = budget.reserveRatio;
	const ratio =
		ratioRaw !== undefined && Number.isFinite(ratioRaw)
			? Math.min(MAX_BUDGET_RESERVE_RATIO, Math.max(0, ratioRaw))
			: hasCritical
				? DEFAULT_BUDGET_RESERVE_RATIO
				: 0;

	const hardTokens = budget.maxTokens;
	const hardUSD = budget.maxUSD;

	let reserveTokens = 0;
	if (budget.reserveTokens !== undefined && Number.isFinite(budget.reserveTokens)) {
		reserveTokens = Math.max(0, budget.reserveTokens);
	} else if (hardTokens !== undefined && Number.isFinite(hardTokens) && ratio > 0) {
		reserveTokens = Math.floor(hardTokens * ratio);
	}
	if (hardTokens !== undefined && Number.isFinite(hardTokens)) {
		reserveTokens = Math.min(reserveTokens, Math.max(0, hardTokens));
	}

	let reserveUSD = 0;
	if (budget.reserveUSD !== undefined && Number.isFinite(budget.reserveUSD)) {
		reserveUSD = Math.max(0, budget.reserveUSD);
	} else if (hardUSD !== undefined && Number.isFinite(hardUSD) && ratio > 0) {
		reserveUSD = hardUSD * ratio;
	}
	if (hardUSD !== undefined && Number.isFinite(hardUSD)) {
		reserveUSD = Math.min(reserveUSD, Math.max(0, hardUSD));
	}

	const softTokens =
		hardTokens === undefined ? undefined : Math.max(0, hardTokens - reserveTokens);
	const softUSD = hardUSD === undefined ? undefined : Math.max(0, hardUSD - reserveUSD);

	return {
		hardTokens,
		softTokens,
		hardUSD,
		softUSD,
		reserveTokens,
		reserveUSD,
	};
}

/**
 * Budget check against accumulated usage. Decoupled from `RunState`: takes the
 * minimal structural input replay can assemble from a trace, so this module
 * never imports `runtime.ts`.
 *
 * Mode:
 * - `"hard"` (default): compare against maxUSD/maxTokens (true ceiling).
 * - `"soft"`: compare against softMax* when provided, else max* (headroom for critical).
 */
export interface BudgetCheckInput {
	maxUSD?: number;
	maxTokens?: number;
	/** Soft cost ceiling (hard − reserveUSD). Used when mode is `"soft"`. */
	softMaxUSD?: number;
	/** Soft token ceiling (hard − reserveTokens). Used when mode is `"soft"`. */
	softMaxTokens?: number;
	/** Per-phase recorded usage; summed with `aggregateUsage`. */
	usages: (UsageStats | undefined)[];
	/** Default `"hard"` for backward compatibility. */
	mode?: BudgetMode;
}

/** Sum input+output tokens across usages (budget token unit). */
export function spentBudgetTokens(usages: (UsageStats | undefined)[]): number {
	const u = aggregateUsage(usages.map((x) => x ?? emptyUsage()));
	return u.input + u.output;
}

export function overBudget(input: BudgetCheckInput): { over: boolean; reason: string } {
	const mode: BudgetMode = input.mode === "soft" ? "soft" : "hard";
	const capUSD = mode === "soft" ? (input.softMaxUSD ?? input.maxUSD) : input.maxUSD;
	const capTokens = mode === "soft" ? (input.softMaxTokens ?? input.maxTokens) : input.maxTokens;
	if (capUSD === undefined && capTokens === undefined) return { over: false, reason: "" };
	const u = aggregateUsage(input.usages.map((x) => x ?? emptyUsage()));
	const prefix = mode === "soft" ? "soft-cap " : "";
	if (capUSD !== undefined && u.cost > capUSD) {
		return {
			over: true,
			reason: `${prefix}cost $${u.cost.toFixed(3)} exceeded cap $${capUSD}`,
		};
	}
	if (capTokens !== undefined && u.input + u.output > capTokens) {
		return {
			over: true,
			reason: `${prefix}tokens ${u.input + u.output} exceeded cap ${capTokens}`,
		};
	}
	return { over: false, reason: "" };
}

/**
 * Build a {@link BudgetCheckInput} from a flow budget + phase usages.
 * Pure convenience for runtime / kernel / tests.
 */
export function budgetCheckFrom(
	budget: BudgetLike | undefined,
	usages: (UsageStats | undefined)[],
	opts?: { hasCriticalPath?: boolean; mode?: BudgetMode },
): BudgetCheckInput {
	const ceilings = resolveBudgetCeilings(budget, { hasCriticalPath: opts?.hasCriticalPath });
	return {
		maxUSD: ceilings.hardUSD,
		maxTokens: ceilings.hardTokens,
		softMaxUSD: ceilings.softUSD,
		softMaxTokens: ceilings.softTokens,
		usages,
		mode: opts?.mode ?? "hard",
	};
}

/**
 * Parse a tournament judge's pick. Fail-open: unreadable → variant 1.
 * Shared by imperative runtime and the event kernel (must stay pure).
 */
export function parseTournamentWinner(output: string, count: number): { winner: number; reason?: string } {
	const clamp = (n: number) => Math.min(Math.max(1, Math.floor(n)), Math.max(1, count));
	const json = safeParse(output);
	if (json && typeof json === "object") {
		const o = json as Record<string, unknown>;
		const raw = o.winner ?? o.best ?? o.choice;
		const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
		if (Number.isFinite(n)) return { winner: clamp(n), reason: asReason(o.reason) };
	}
	const matches = [...output.matchAll(WINNER_TOKEN_RE)];
	if (matches.length) {
		const n = Number(matches[matches.length - 1][1]);
		if (Number.isFinite(n)) return { winner: clamp(n) };
	}
	return { winner: 1, reason: "no parseable winner; defaulted to variant 1" };
}
