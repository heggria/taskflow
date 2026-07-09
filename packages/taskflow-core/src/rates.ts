/**
 * Model rate registry — pure token-to-USD cost estimation.
 *
 * ## CODEX COST GAP
 *
 * The `codex-runner` (packages/codex-taskflow) emits NO cost field in its usage
 * response, so `usage.cost` stays 0 on Codex even when tokens are accurately
 * reported. This makes `budget.maxUSD` silently non-functional for Codex-hosted
 * flows. This module fills the gap: batch 2 of the runner layer (or a post-hoc
 * cost fill) can call `estimateCost()` to compute USD from the known model +
 * token counts, making Codex cost-aware without changing the runner protocol.
 *
 * ## Link to verify.ts
 *
 * `verify.ts` defines `ESTIMATED_COST_PER_PHASE = 0.001` as a crude lower-bound
 * budget guard. `FLAT_FALLBACK_PER_TOKEN` serves the same role for unknown models
 * — a rough-order-of-magnitude per-token default (~$1/1M tokens, consistent with
 * $0.001/1000-tokens at verify's granularity).
 *
 * @module
 */

import type { UsageStats } from "./usage.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-model pricing in USD per 1,000,000 tokens.
 *
 * Rates mirror the provider's published API pricing (input, output, cached
 * input read, cached input write). Missing fields default to zero.
 */
export interface ModelRate {
	/** USD per 1,000,000 input (prompt) tokens. */
	inputPer1M: number;
	/** USD per 1,000,000 output (completion) tokens. */
	outputPer1M: number;
	/** USD per 1,000,000 cached input tokens read (if applicable). */
	cacheReadPer1M?: number;
	/** USD per 1,000,000 cached input tokens written (if applicable). */
	cacheWritePer1M?: number;
}

// ---------------------------------------------------------------------------
// Default rate table
// ---------------------------------------------------------------------------

/**
 * Built-in rate table keyed by **model-family prefix** (case-sensitive lookup
 * key — matching in `resolveRate` is case-insensitive).
 *
 * This is a small, illustrative, SPARSE table. Hosts can inject a richer table
 * at runtime via the optional `table` parameter to `resolveRate`/`estimateCost`.
 *
 * Prices are approximate and may drift from provider publishing. For production
 * billing, always use the provider's official cost API.
 *
 * ```ts
 * // Example override from a host adapter:
 * const myRates = { ...DEFAULT_RATES, "my-model": { inputPer1M: 1, outputPer1M: 4 } };
 * const cost = estimateCost(usage, "my-model", myRates);
 * ```
 */
export const DEFAULT_RATES: Record<string, ModelRate> = {
	// ── OpenAI ──────────────────────────────────────────────────────────
	/** gpt-4o family (including gpt-4o-*, gpt-4o-mini) */
	"gpt-4o": { inputPer1M: 2.50, outputPer1M: 10.00, cacheReadPer1M: 1.25 },
	/** gpt-4o-mini (cheap, fast) */
	"gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.60, cacheReadPer1M: 0.075 },
	/** o3-mini reasoning model */
	"o3-mini": { inputPer1M: 1.10, outputPer1M: 4.40, cacheReadPer1M: 0.55 },
	/** o1 reasoning model */
	o1: { inputPer1M: 15.00, outputPer1M: 60.00, cacheReadPer1M: 7.50 },

	// ── Anthropic ───────────────────────────────────────────────────────
	/** claude-sonnet-4 (and sonnet-4-*) */
	"claude-sonnet-4": { inputPer1M: 3.00, outputPer1M: 15.00, cacheReadPer1M: 0.30, cacheWritePer1M: 3.75 },
	/** claude-haiku-3.5 (and haiku-3.5-*) */
	"claude-haiku-3.5": { inputPer1M: 0.80, outputPer1M: 4.00, cacheReadPer1M: 0.08, cacheWritePer1M: 1.00 },
	/** claude-opus-4 (and opus-4-*) */
	"claude-opus-4": { inputPer1M: 15.00, outputPer1M: 75.00, cacheReadPer1M: 1.50, cacheWritePer1M: 18.75 },

	// ── DeepSeek ────────────────────────────────────────────────────────
	/** deepseek-chat (V3) */
	"deepseek-chat": { inputPer1M: 0.27, outputPer1M: 1.10, cacheReadPer1M: 0.07 },
	/** deepseek-reasoner (R1) */
	"deepseek-reasoner": { inputPer1M: 0.55, outputPer1M: 2.19, cacheReadPer1M: 0.14 },

	// ── Google Gemini ───────────────────────────────────────────────────
	/** gemini-2.5-flash-* */
	"gemini-2.5-flash": { inputPer1M: 0.15, outputPer1M: 0.60, cacheReadPer1M: 0.075 },
	/** gemini-2.5-pro-* */
	"gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10.00, cacheReadPer1M: 0.3125 },

	// ── Meta ────────────────────────────────────────────────────────────
	/** llama-3.x (generic — actual pricing depends on host) */
	"llama-3": { inputPer1M: 0.25, outputPer1M: 0.25 },
} as const;

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

/**
 * Flat per-token USD fallback used when no model rate can be resolved.
 *
 * Currently set to $1 per 1,000,000 tokens (~$0.001 per 1K tokens), consistent
 * with `verify.ts`'s `ESTIMATED_COST_PER_PHASE = 0.001` rough-order-of-magnitude
 * estimate. This avoids silent zero-cost for unknown models while staying in the
 * right ballpark for most hosted LLM APIs.
 */
export const FLAT_FALLBACK_PER_TOKEN = 0.000001; // $1/1M tokens

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a model identifier to a `ModelRate` via case-insensitive prefix match
 * against the provided table (defaults to `DEFAULT_RATES`).
 *
 * Matching strategy:
 * 1. Exact case-insensitive key match.
 * 2. Longest prefix match (case-insensitive), e.g. "gpt-4o-2024-08-06" matches
 *    the "gpt-4o" key.
 * 3. Falls back to single-word prefix: "claude-sonnet-4-20241022" matches
 *    "claude-sonnet-4" (best prefix).
 *
 * Returns `undefined` if no match is found. Never throws.
 *
 * @param model      - The model identifier to look up (e.g. "gpt-4o-2024-08-06")
 * @param table      - Optional rate table (defaults to DEFAULT_RATES)
 * @returns The matching ModelRate, or undefined on miss
 */
export function resolveRate(
	model: string,
	table?: Record<string, ModelRate>,
): ModelRate | undefined {
	if (!model) return undefined;

	const tbl = table ?? DEFAULT_RATES;
	const lowerModel = model.toLowerCase();

	// 1. Exact case-insensitive match
	const exact = Object.keys(tbl).find((k) => k.toLowerCase() === lowerModel);
	if (exact) return tbl[exact];

	// 2. Longest prefix match — iterate to find the key that is a prefix of the
	//    model (case-insensitive) with the greatest length.
	let best: { key: string; length: number } | undefined;
	for (const key of Object.keys(tbl)) {
		const lowerKey = key.toLowerCase();
		if (lowerModel.startsWith(lowerKey) && lowerKey.length > (best?.length ?? 0)) {
			best = { key, length: lowerKey.length };
		}
	}
	if (best) return tbl[best.key];

	return undefined;
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/**
 * Compute estimated USD cost from token usage.
 *
 * ## Cache accounting contract
 *
 * Hosts disagree on whether `usage.input` already includes cached tokens:
 * - **Codex**: `input_tokens` includes `cached_input_tokens` (overlap).
 * - **Claude / OpenCode (typical)**: `input` is non-cached; `cacheRead` is
 *   disjoint and additional.
 *
 * Heuristic (never double-bill, never under-bill the common cases):
 * - If `0 < cacheRead <= input`, treat cache as a **subset** of input
 *   (Codex-style): bill `(input - cacheRead)` at the input rate and
 *   `cacheRead` at the cache-read rate.
 * - Otherwise treat input and cacheRead as **disjoint**: bill full `input`
 *   at the input rate plus `cacheRead` at the cache-read rate.
 *
 * Cache-write tokens are always billed separately when a write rate exists
 * (they are never part of `input`).
 *
 * Formula (known rate):
 *   nonCachedInput = (cacheRead > 0 && cacheRead <= input)
 *                    ? input - cacheRead : input
 *   cost = (nonCachedInput * inputRate + output * outputRate +
 *           cacheRead * cacheReadRate + cacheWrite * cacheWriteRate) / 1_000_000
 *
 * If the model cannot be resolved, falls back to
 * `FLAT_FALLBACK_PER_TOKEN * (input + output)`. Cache tokens are *not* counted
 * in the fallback (avoids double-count when input already includes them).
 *
 * Pure function — no I/O, no side effects. Never throws.
 *
 * @param usage  - Token counts (input, output, cacheRead, cacheWrite)
 * @param model  - Model identifier used to resolve the rate
 * @param table  - Optional rate table override (passed through to resolveRate)
 * @returns Estimated cost in USD
 */
export function estimateCost(
	usage: UsageStats,
	model: string,
	table?: Record<string, ModelRate>,
): number {
	const rate = resolveRate(model, table);
	if (!rate) {
		return FLAT_FALLBACK_PER_TOKEN * (usage.input + usage.output);
	}

	// Overlap heuristic: when cacheRead is a positive subset of input, peel it
	// out so it is not billed at the full input rate (Codex-style hosts).
	const nonCachedInput =
		usage.cacheRead > 0 && usage.cacheRead <= usage.input
			? usage.input - usage.cacheRead
			: usage.input;

	const inputCost = (nonCachedInput / 1_000_000) * rate.inputPer1M;
	const outputCost = (usage.output / 1_000_000) * rate.outputPer1M;
	let cacheCost = 0;
	if (rate.cacheReadPer1M !== undefined && usage.cacheRead > 0) {
		cacheCost += (usage.cacheRead / 1_000_000) * rate.cacheReadPer1M;
	}
	if (rate.cacheWritePer1M !== undefined && usage.cacheWrite > 0) {
		cacheCost += (usage.cacheWrite / 1_000_000) * rate.cacheWritePer1M;
	}

	return inputCost + outputCost + cacheCost;
}
