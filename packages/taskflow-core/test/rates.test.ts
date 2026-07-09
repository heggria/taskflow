/**
 * Tests for the model rate registry (rates.ts).
 *
 * Covers: resolveRate hit/miss/prefix/case-insensitive, estimateCost with a
 * known rate, estimateCost fallback when model unknown, cache-token contribution,
 * pluggable table override.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_RATES,
	FLAT_FALLBACK_PER_TOKEN,
	type ModelRate,
	resolveRate,
	estimateCost,
} from "../src/rates.ts";
import type { UsageStats } from "../src/usage.ts";

// ---------------------------------------------------------------------------
// resolveRate
// ---------------------------------------------------------------------------

test("resolveRate: exact match returns the correct rate", () => {
	const rate = resolveRate("gpt-4o");
	assert.ok(rate);
	assert.equal(rate.inputPer1M, 2.50);
	assert.equal(rate.outputPer1M, 10.00);
	assert.equal(rate.cacheReadPer1M, 1.25);
});

test("resolveRate: prefix match works (model version suffix)", () => {
	// "gpt-4o-2024-08-06" should match the "gpt-4o" prefix
	const rate = resolveRate("gpt-4o-2024-08-06");
	assert.ok(rate);
	assert.equal(rate.inputPer1M, 2.50);
});

test("resolveRate: case-insensitive match (exact)", () => {
	const rate = resolveRate("GPT-4O");
	assert.ok(rate);
	assert.equal(rate.inputPer1M, 2.50);
});

test("resolveRate: case-insensitive prefix match", () => {
	const rate = resolveRate("CLAUDE-SONNET-4-20241022");
	assert.ok(rate);
	assert.equal(rate.inputPer1M, 3.00);
});

test("resolveRate: miss returns undefined", () => {
	const rate = resolveRate("nonexistent-model-v99");
	assert.equal(rate, undefined);
});

test("resolveRate: empty string returns undefined", () => {
	const rate = resolveRate("");
	assert.equal(rate, undefined);
});

test("resolveRate: longest prefix wins", () => {
	// "gpt-4o-mini" is a longer prefix than "gpt-4o" — should get the mini rates
	const rate = resolveRate("gpt-4o-mini-2024-07-18");
	assert.ok(rate);
	assert.equal(rate.inputPer1M, 0.15); // mini rate, not full gpt-4o
});

// ---------------------------------------------------------------------------
// estimateCost — known rate
// ---------------------------------------------------------------------------

test("estimateCost: computes cost from known rate", () => {
	const usage: UsageStats = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 };
	// gpt-4o: $2.50/1M input, $10/1M output
	// input cost = 1000/1e6 * 2.50 = 0.0025
	// output cost = 500/1e6 * 10.00 = 0.005
	// total = 0.0075
	const cost = estimateCost(usage, "gpt-4o");
	assert.equal(cost, 0.0075);
});

test("estimateCost: zero tokens yields zero cost", () => {
	const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	const cost = estimateCost(usage, "gpt-4o");
	assert.equal(cost, 0);
});

// ---------------------------------------------------------------------------
// estimateCost — fallback
// ---------------------------------------------------------------------------

test("estimateCost: unknown model falls back to FLAT_FALLBACK_PER_TOKEN", () => {
	const usage: UsageStats = { input: 2000, output: 8000, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 };
	const cost = estimateCost(usage, "ultra-unknown-314");
	// Fallback: FLAT_FALLBACK_PER_TOKEN * (2000 + 8000) = 0.000001 * 10000 = 0.01
	assert.equal(cost, FLAT_FALLBACK_PER_TOKEN * 10000);
});

test("estimateCost: fallback uses only input+output (no cache double-count)", () => {
	const usage: UsageStats = { input: 1000, output: 1000, cacheRead: 9000, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 };
	const cost = estimateCost(usage, "unknown-model");
	// Fallback: FLAT_FALLBACK_PER_TOKEN * (1000 + 1000) — cacheRead is excluded
	assert.equal(cost, FLAT_FALLBACK_PER_TOKEN * 2000);
});

// ---------------------------------------------------------------------------
// estimateCost — cache contribution
// ---------------------------------------------------------------------------

test("estimateCost: cacheRead tokens reduce cost (cached input cheaper)", () => {
	const usage: UsageStats = { input: 1000, output: 500, cacheRead: 4000, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 };
	// claude-sonnet-4: $3/1M input, $15/1M output, $0.30/1M cacheRead
	// input cost = 1000/1e6 * 3.00 = 0.003
	// cache cost = 4000/1e6 * 0.30 = 0.0012
	// output cost = 500/1e6 * 15.00 = 0.0075
	// total ≈ 0.0117
	const cost = estimateCost(usage, "claude-sonnet-4");
	assert.ok(Math.abs(cost - 0.0117) < 1e-10, `expected ~0.0117, got ${cost}`);
});

test("estimateCost: cacheWrite tokens contribute when rate has cacheWritePer1M", () => {
	const usage: UsageStats = { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 3000, cost: 0, contextTokens: 0, turns: 1 };
	// claude-sonnet-4: $3/1M input, $15/1M output, $0.30/1M cacheRead, $3.75/1M cacheWrite
	// input cost = 1000/1e6 * 3.00 = 0.003
	// cacheRead = 2000/1e6 * 0.30 = 0.0006
	// cacheWrite = 3000/1e6 * 3.75 = 0.01125
	// output cost = 500/1e6 * 15.00 = 0.0075
	// total = 0.02235
	const cost = estimateCost(usage, "claude-sonnet-4");
	assert.equal(cost, 0.02235);
});

test("estimateCost: rate with no cache fields ignores cache tokens", () => {
	const usage: UsageStats = { input: 1000, output: 500, cacheRead: 5000, cacheWrite: 5000, cost: 0, contextTokens: 0, turns: 1 };
	// llama-3 has no cacheReadPer1M or cacheWritePer1M — cache tokens ignored
	// input cost = 1000/1e6 * 0.25 = 0.00025
	// output cost = 500/1e6 * 0.25 = 0.000125
	// total = 0.000375
	const cost = estimateCost(usage, "llama-3");
	assert.equal(cost, 0.000375);
});

// ---------------------------------------------------------------------------
// estimateCost — pluggable table override
// ---------------------------------------------------------------------------

test("estimateCost: pluggable table override is used instead of DEFAULT_RATES", () => {
	const customTable: Record<string, ModelRate> = {
		"my-custom-model": { inputPer1M: 10, outputPer1M: 20 },
	};
	const usage: UsageStats = { input: 100_000, output: 50_000, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 };
	// input cost = 100000/1e6 * 10 = 1.00
	// output cost = 50000/1e6 * 20 = 1.00
	// total = 2.00
	const cost = estimateCost(usage, "my-custom-model", customTable);
	assert.equal(cost, 2.00);
});

test("estimateCost: table override with prefix match works", () => {
	const customTable: Record<string, ModelRate> = {
		"custom-fast": { inputPer1M: 0.50, outputPer1M: 2.00 },
	};
	const usage: UsageStats = { input: 2000, output: 1000, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 };
	// input cost = 2000/1e6 * 0.50 = 0.001
	// output cost = 1000/1e6 * 2.00 = 0.002
	// total = 0.003
	const cost = estimateCost(usage, "custom-fast-v2", customTable);
	assert.equal(cost, 0.003);
});

test("estimateCost: table override miss falls back", () => {
	const customTable: Record<string, ModelRate> = {
		"custom-fast": { inputPer1M: 0.50, outputPer1M: 2.00 },
	};
	const usage: UsageStats = { input: 500, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 };
	// "gpt-4o" is not in customTable — should fall back
	const cost = estimateCost(usage, "gpt-4o", customTable);
	assert.equal(cost, FLAT_FALLBACK_PER_TOKEN * 1000);
});

// ---------------------------------------------------------------------------
// resolveRate — pluggable table
// ---------------------------------------------------------------------------

test("resolveRate: pluggable table override", () => {
	const customTable: Record<string, ModelRate> = {
		"my-model": { inputPer1M: 5, outputPer1M: 15 },
	};
	const rate = resolveRate("my-model", customTable);
	assert.ok(rate);
	assert.equal(rate.inputPer1M, 5);
	assert.equal(rate.outputPer1M, 15);
	// Should NOT fall back to DEFAULT_RATES
	assert.equal(resolveRate("gpt-4o", customTable), undefined);
});

// ---------------------------------------------------------------------------
// Type-level: ensure DEFAULT_RATES entries conform to ModelRate
// ---------------------------------------------------------------------------

test("DEFAULT_RATES: all entries have required fields", () => {
	for (const [key, rate] of Object.entries(DEFAULT_RATES)) {
		assert.ok(typeof rate.inputPer1M === "number", `${key}.inputPer1M must be a number`);
		assert.ok(typeof rate.outputPer1M === "number", `${key}.outputPer1M must be a number`);
		assert.ok(rate.inputPer1M >= 0, `${key}.inputPer1M must be non-negative`);
		assert.ok(rate.outputPer1M >= 0, `${key}.outputPer1M must be non-negative`);
	}
});

test("FLAT_FALLBACK_PER_TOKEN: is a positive number", () => {
	assert.ok(typeof FLAT_FALLBACK_PER_TOKEN === "number");
	assert.ok(FLAT_FALLBACK_PER_TOKEN > 0);
});
