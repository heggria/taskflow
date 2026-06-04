import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateUsage, emptyUsage, formatTokens, type UsageStats } from "../extensions/usage.ts";

// ── emptyUsage ──────────────────────────────────────────────────────

test("emptyUsage: returns all fields zeroed", () => {
	assert.deepEqual(emptyUsage(), {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	});
});

test("emptyUsage: returns a fresh object each call (no shared reference)", () => {
	const a = emptyUsage();
	const b = emptyUsage();
	assert.notEqual(a, b);
	a.input = 42;
	assert.equal(b.input, 0);
});

// ── aggregateUsage ──────────────────────────────────────────────────

test("aggregateUsage: sums all numeric fields from multiple usages", () => {
	const a: UsageStats = { input: 10, output: 20, cacheRead: 5, cacheWrite: 3, cost: 0.01, contextTokens: 100, turns: 1 };
	const b: UsageStats = { input: 30, output: 40, cacheRead: 10, cacheWrite: 7, cost: 0.02, contextTokens: 200, turns: 2 };
	const total = aggregateUsage([a, b]);
	assert.equal(total.input, 40);
	assert.equal(total.output, 60);
	assert.equal(total.cacheRead, 15);
	assert.equal(total.cacheWrite, 10);
	assert.equal(total.cost, 0.03);
	assert.equal(total.turns, 3);
});

test("aggregateUsage: empty array returns zeroed usage", () => {
	assert.deepEqual(aggregateUsage([]), emptyUsage());
});

test("aggregateUsage: single usage returns a copy (not the same reference)", () => {
	const u: UsageStats = { input: 5, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 0, turns: 1 };
	const total = aggregateUsage([u]);
	assert.equal(total.input, 5);
	assert.equal(total.output, 10);
	assert.notEqual(total, u);
});

test("aggregateUsage: does not include contextTokens in sum (point-in-time gauge)", () => {
	const a: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 500, turns: 0 };
	const b: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 300, turns: 0 };
	assert.equal(aggregateUsage([a, b]).contextTokens, 0);
});

// ── formatTokens ────────────────────────────────────────────────────

test("formatTokens: below 1000 returns plain number", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(1), "1");
	assert.equal(formatTokens(999), "999");
});

test("formatTokens: 1000–9999 returns one-decimal k", () => {
	assert.equal(formatTokens(1000), "1.0k");
	assert.equal(formatTokens(1500), "1.5k");
	assert.equal(formatTokens(9999), "10.0k");
});

test("formatTokens: 10000–999999 returns rounded k", () => {
	assert.equal(formatTokens(10000), "10k");
	assert.equal(formatTokens(50000), "50k");
	assert.equal(formatTokens(999999), "1000k");
});

test("formatTokens: 1M+ returns one-decimal M", () => {
	assert.equal(formatTokens(1000000), "1.0M");
	assert.equal(formatTokens(2500000), "2.5M");
	assert.equal(formatTokens(10000000), "10.0M");
});
