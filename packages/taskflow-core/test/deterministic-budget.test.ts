/**
 * Pure budget math (0.2.8 soft/hard + critical-path reserve).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	budgetCheckFrom,
	budgetModeForPhase,
	DEFAULT_BUDGET_RESERVE_RATIO,
	flowHasCriticalPath,
	isCriticalPhase,
	overBudget,
	resolveBudgetCeilings,
	spentBudgetTokens,
} from "../src/deterministic.ts";
import { emptyUsage, type UsageStats } from "../src/usage.ts";

function u(partial: Partial<UsageStats>): UsageStats {
	return { ...emptyUsage(), ...partial };
}

test("isCriticalPhase: final and budgetClass critical", () => {
	assert.equal(isCriticalPhase({ final: true }), true);
	assert.equal(isCriticalPhase({ budgetClass: "critical" }), true);
	assert.equal(isCriticalPhase({ final: true, budgetClass: "normal" }), false);
	assert.equal(isCriticalPhase({ budgetClass: "normal" }), false);
	assert.equal(isCriticalPhase({}), false);
	assert.equal(isCriticalPhase(undefined), false);
});

test("budgetModeForPhase: critical → hard, else soft", () => {
	assert.equal(budgetModeForPhase({ final: true }), "hard");
	assert.equal(budgetModeForPhase({ budgetClass: "critical" }), "hard");
	assert.equal(budgetModeForPhase({ id: "x" } as never), "soft");
	assert.equal(budgetModeForPhase({}), "soft");
});

test("flowHasCriticalPath", () => {
	assert.equal(flowHasCriticalPath([{ final: true }]), true);
	assert.equal(flowHasCriticalPath([{ budgetClass: "critical" }]), true);
	assert.equal(flowHasCriticalPath([{}, {}]), false);
	assert.equal(flowHasCriticalPath([]), false);
});

test("resolveBudgetCeilings: default 20% reserve when critical path exists", () => {
	const c = resolveBudgetCeilings({ maxTokens: 1000 }, { hasCriticalPath: true });
	assert.equal(c.hardTokens, 1000);
	assert.equal(c.reserveTokens, Math.floor(1000 * DEFAULT_BUDGET_RESERVE_RATIO));
	assert.equal(c.softTokens, 1000 - c.reserveTokens);
	assert.equal(c.softTokens, 800);
});

test("resolveBudgetCeilings: no auto-reserve without critical path", () => {
	const c = resolveBudgetCeilings({ maxTokens: 1000 }, { hasCriticalPath: false });
	assert.equal(c.reserveTokens, 0);
	assert.equal(c.softTokens, 1000);
	assert.equal(c.hardTokens, 1000);
});

test("resolveBudgetCeilings: explicit reserveRatio 0 disables auto-reserve", () => {
	const c = resolveBudgetCeilings({ maxTokens: 1000, reserveRatio: 0 }, { hasCriticalPath: true });
	assert.equal(c.reserveTokens, 0);
	assert.equal(c.softTokens, 1000);
});

test("resolveBudgetCeilings: absolute reserve wins over ratio", () => {
	const c = resolveBudgetCeilings(
		{ maxTokens: 1000, reserveTokens: 50, reserveRatio: 0.4 },
		{ hasCriticalPath: true },
	);
	assert.equal(c.reserveTokens, 50);
	assert.equal(c.softTokens, 950);
});

test("resolveBudgetCeilings: absolute reserve clamped to maxTokens", () => {
	const c = resolveBudgetCeilings({ maxTokens: 100, reserveTokens: 500 }, { hasCriticalPath: true });
	assert.equal(c.reserveTokens, 100);
	assert.equal(c.softTokens, 0);
});

test("resolveBudgetCeilings: USD axis", () => {
	const c = resolveBudgetCeilings({ maxUSD: 1.0 }, { hasCriticalPath: true });
	assert.equal(c.hardUSD, 1.0);
	assert.equal(c.reserveUSD, 0.2);
	assert.equal(c.softUSD, 0.8);
});

test("overBudget hard: unchanged semantics (strictly greater)", () => {
	const usages = [u({ input: 50, output: 50 })];
	assert.equal(overBudget({ maxTokens: 100, usages }).over, false);
	assert.equal(overBudget({ maxTokens: 99, usages }).over, true);
	assert.match(overBudget({ maxTokens: 99, usages }).reason, /tokens 100 exceeded cap 99/);
});

test("overBudget soft: uses softMax when mode is soft", () => {
	const usages = [u({ input: 85, output: 0 })];
	const hard = overBudget({ maxTokens: 100, softMaxTokens: 80, usages, mode: "hard" });
	assert.equal(hard.over, false);
	const soft = overBudget({ maxTokens: 100, softMaxTokens: 80, usages, mode: "soft" });
	assert.equal(soft.over, true);
	assert.match(soft.reason, /soft-cap/);
});

test("budgetCheckFrom wires soft ceilings from reserve", () => {
	const input = budgetCheckFrom(
		{ maxTokens: 100 },
		[u({ input: 85 })],
		{ hasCriticalPath: true, mode: "soft" },
	);
	assert.equal(input.maxTokens, 100);
	assert.equal(input.softMaxTokens, 80);
	assert.equal(input.mode, "soft");
	assert.equal(overBudget(input).over, true);
});

test("spentBudgetTokens sums input+output", () => {
	assert.equal(spentBudgetTokens([u({ input: 10, output: 5 }), u({ input: 3 })]), 18);
});
