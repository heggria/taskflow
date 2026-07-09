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

/**
 * Budget check against accumulated usage. Decoupled from `RunState`: takes the
 * minimal structural input replay can assemble from a trace, so this module
 * never imports `runtime.ts`.
 */
export interface BudgetCheckInput {
	maxUSD?: number;
	maxTokens?: number;
	/** Per-phase recorded usage; summed with `aggregateUsage`. */
	usages: (UsageStats | undefined)[];
}

export function overBudget(input: BudgetCheckInput): { over: boolean; reason: string } {
	if (input.maxUSD === undefined && input.maxTokens === undefined) return { over: false, reason: "" };
	const u = aggregateUsage(input.usages.map((u) => u ?? emptyUsage()));
	if (input.maxUSD !== undefined && u.cost > input.maxUSD) {
		return { over: true, reason: `cost $${u.cost.toFixed(3)} exceeded cap $${input.maxUSD}` };
	}
	if (input.maxTokens !== undefined && u.input + u.output > input.maxTokens) {
		return { over: true, reason: `tokens ${u.input + u.output} exceeded cap ${input.maxTokens}` };
	}
	return { over: false, reason: "" };
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
