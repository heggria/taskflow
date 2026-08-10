/**
 * Integration test: executeTaskflow -> FileTraceSink -> readTrace -> replayRun.
 *
 * Proves the real imperative runtime emits the decision events replayRun
 * depends on (gate-score, when-guard, budget-hit), and that replay correctly
 * re-adjudicates them under overridden knobs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunResult } from "../src/host/runner-types.ts";
import { executeTaskflow } from "../src/runtime.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { FileTraceSink, readTrace } from "../src/trace.ts";
import { upgradeTraceEvent } from "../src/exec/events.ts";
import { replayRun } from "../src/replay.ts";
import { emptyUsage } from "../src/usage.ts";

const AGENT: AgentConfig = {
	name: "a",
	description: "test",
	systemPrompt: "",
	source: "user",
	filePath: "",
};

function ok(agent: string, task: string, output = "ok", cost = 0.01): RunResult {
	return {
		agent,
		task,
		exitCode: 0,
		output,
		stderr: "",
		usage: { ...emptyUsage(), cost, turns: 1 },
		stopReason: "end",
	};
}

function state(def: Taskflow, cwd: string, args: Record<string, unknown> = {}): RunState {
	return {
		runId: `replay-e2e-${Math.random().toString(36).slice(2, 8)}`,
		flowName: def.name,
		def,
		args,
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
	};
}

function toEvents(tracePath: string) {
	return readTrace(tracePath).map((e) => upgradeTraceEvent(e as unknown as Record<string, unknown>));
}

test("e2e replay: scoring gate auto-passes and threshold replay flips verdict", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-replay-e2e-"));
	const tracePath = path.join(cwd, "trace.jsonl");
	try {
		let calls = 0;
		const def: Taskflow = {
			name: "gate-flow",
			phases: [
				{ id: "gen", task: "generate", output: "json" },
				{
					id: "review",
					type: "gate",
					dependsOn: ["gen"],
					task: "This fallback must not run. End with VERDICT: PASS or VERDICT: BLOCK.",
					score: {
						target: "{steps.gen.output}",
						scorers: [
							{ type: "contains", value: "good output", name: "has-good-output" },
							{ type: "contains", value: "REQUIRED-MARKER", name: "has-required-marker" },
						],
						combine: "weighted",
						weights: [0.8, 0.2],
						threshold: 0.7,
					},
					final: true,
				},
			],
		};
		const result = await executeTaskflow(state(def, cwd), {
			cwd,
			agents: [AGENT],
			runTask: async (_c, _a, agent, task) => {
				calls++;
				if (task.includes("generate")) return ok(agent, task, '{"result": "good output"}', 0.02);
				return ok(agent, task, "Fallback unexpectedly ran. VERDICT: BLOCK", 0.01);
			},
			trace: new FileTraceSink(tracePath),
			persist: () => {},
		});
		assert.equal(result.state.phases.review.status, "done", "gate should pass");
		assert.equal(result.state.phases.review.gate?.verdict, "pass");
		assert.equal(result.state.phases.review.gate?.scores?.combined, 0.8);
		assert.equal(result.state.phases.review.output, "PASS (scorers passed — no LLM call)");
		assert.equal(calls, 1, "auto-pass must not invoke the gate task");

		const raw = readTrace(tracePath);
		assert.ok(raw.length > 0, "trace should not be empty");
		const gateDecisions = raw.filter(
			(e) => e.phaseId === "review" && e.kind === "decision" && e.decision?.type === "gate-score",
		);
		assert.equal(gateDecisions.length, 1, "runtime must emit exactly one gate-score decision");
		const gateDecision = gateDecisions[0]?.decision;
		assert.equal(gateDecision?.type, "gate-score");
		if (gateDecision?.type !== "gate-score") assert.fail("expected gate-score decision");
		assert.equal(gateDecision.target, '{"result": "good output"}');
		assert.equal(gateDecision.combined, 0.8);
		assert.equal(gateDecision.threshold, 0.7);

		// Replay with no overrides → reused
		const events = toEvents(tracePath);
		const report = replayRun(events, {});
		const rd = report.decisions.find((d) => d.phaseId === "review");
		assert.ok(rd, "replay should produce a decision for review phase");
		assert.equal(rd.outcome, "reused", "no overrides → gate score reused");
		assert.equal(report.needsLiveRerun, false);

		// Tightening the threshold re-adjudicates the recorded score offline.
		const tightened = replayRun(events, { thresholds: { review: 0.9 } });
		const tightenedDecision = tightened.decisions.find((d) => d.phaseId === "review");
		assert.equal(tightenedDecision?.outcome, "would-block");
		assert.equal(tightened.replayed.phases.review.status, "blocked");
		assert.equal(tightened.needsLiveRerun, false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("e2e replay: scoring task fallback emits a replayable gate-score", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-replay-score-fallback-"));
	const tracePath = path.join(cwd, "trace.jsonl");
	try {
		const def: Taskflow = {
			name: "score-fallback-flow",
			phases: [
				{ id: "gen", task: "generate" },
				{
					id: "review",
					type: "gate",
					dependsOn: ["gen"],
					task: "Review fallback",
					score: {
						target: "{steps.gen.output}",
						scorers: [{ type: "contains", value: "GOOD" }],
					},
				},
			],
		};
		const result = await executeTaskflow(state(def, cwd), {
			cwd,
			agents: [AGENT],
			runTask: async (_c, _a, agent, task) =>
				task.includes("generate")
					? ok(agent, task, "bad output", 0.02)
					: ok(agent, task, "Fallback accepts it. VERDICT: PASS", 0.01),
			trace: new FileTraceSink(tracePath),
			persist: () => {},
		});
		assert.equal(result.state.phases.review.gate?.verdict, "pass");
		assert.equal(result.state.phases.review.gate?.scores?.combined, 0);

		const decisions = readTrace(tracePath).filter(
			(e) => e.phaseId === "review" && e.kind === "decision" && e.decision?.type === "gate-score",
		);
		assert.equal(decisions.length, 1);
		const decision = decisions[0]?.decision;
		if (decision?.type !== "gate-score") assert.fail("expected gate-score decision");
		assert.equal(decision.target, "bad output");
		assert.equal(decision.combined, 0);
		assert.equal(decision.verdict, "pass");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("e2e replay: deterministic scoring block emits a replayable gate-score", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-replay-score-block-"));
	const tracePath = path.join(cwd, "trace.jsonl");
	try {
		const def: Taskflow = {
			name: "score-block-flow",
			phases: [
				{ id: "gen", task: "generate" },
				{
					id: "review",
					type: "gate",
					dependsOn: ["gen"],
					score: {
						target: "{steps.gen.output}",
						scorers: [{ type: "contains", value: "GOOD" }],
					},
				},
			],
		};
		const result = await executeTaskflow(state(def, cwd), {
			cwd,
			agents: [AGENT],
			runTask: async (_c, _a, agent, task) => ok(agent, task, "bad output", 0.02),
			trace: new FileTraceSink(tracePath),
			persist: () => {},
		});
		assert.equal(result.ok, false);
		assert.equal(result.state.phases.review.gate?.verdict, "block");

		const events = toEvents(tracePath);
		const scoreEvents = events.filter(
			(e) => e.phaseId === "review" && e.kind === "decision" && e.decision?.type === "gate-score",
		);
		assert.equal(scoreEvents.length, 1);
		const score = scoreEvents[0]?.decision;
		if (score?.type !== "gate-score") assert.fail("expected gate-score decision");
		assert.equal(score.target, "bad output");
		assert.equal(score.combined, 0);
		assert.equal(score.verdict, "block");

		const relaxed = replayRun(events, { thresholds: { review: 0 } });
		assert.equal(relaxed.decisions.find((d) => d.phaseId === "review")?.outcome, "verdict-flipped");
		assert.equal(relaxed.replayed.phases.review.status, "done");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("e2e replay: when-guard emits event and args override marks needs-live-rerun", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-replay-when-"));
	const tracePath = path.join(cwd, "trace.jsonl");
	try {
		const def: Taskflow = {
			name: "when-guard-flow",
			args: { mode: { default: "full" } },
			phases: [
				{ id: "setup", task: "setup" },
				{ id: "deep", task: "deep analysis", when: "{args.mode} == full", dependsOn: ["setup"], final: true },
			],
		};
		const result = await executeTaskflow(state(def, cwd, { mode: "full" }), {
			cwd,
			agents: [AGENT],
			runTask: async (_c, _a, agent, task) => ok(agent, task, "done", 0.01),
			trace: new FileTraceSink(tracePath),
			persist: () => {},
		});
		assert.equal(result.state.phases.deep.status, "done");

		const raw = readTrace(tracePath);
		const whenEvents = raw.filter(
			(e) => e.phaseId === "deep" && e.kind === "decision" && e.decision?.type === "when-guard",
		);
		assert.ok(whenEvents.length > 0, "runtime must emit when-guard decision");

		const events = toEvents(tracePath);
		const report = replayRun(events, { args: { mode: "quick" } });
		assert.ok(report.needsLiveRerun, "args override should trigger needs-live-rerun");
		const dd = report.decisions.find((d) => d.phaseId === "deep");
		assert.ok(dd);
		assert.equal(dd.outcome, "needs-live-rerun");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("e2e replay: budget replay with tighter cap marks crossing phase", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-replay-budget-"));
	const tracePath = path.join(cwd, "trace.jsonl");
	try {
		const def: Taskflow = {
			name: "budget-flow",
			budget: { maxUSD: 1.0 },
			phases: [
				{ id: "a", task: "cheap" },
				{ id: "b", task: "expensive", dependsOn: ["a"] },
				{ id: "c", task: "after", dependsOn: ["b"], final: true },
			],
		};
		await executeTaskflow(state(def, cwd), {
			cwd,
			agents: [AGENT],
			runTask: async (_c, _a, agent, task) => {
				if (task === "cheap") return ok(agent, task, "a-done", 0.1);
				if (task === "expensive") return ok(agent, task, "b-done", 0.8);
				return ok(agent, task, "c-done", 0.2);
			},
			trace: new FileTraceSink(tracePath),
			persist: () => {},
		});

		const raw = readTrace(tracePath);
		assert.ok(raw.length > 0);

		const events = toEvents(tracePath);
		const report = replayRun(events, { budgetMaxUSD: 0.5 });
		const bd = report.decisions.find((d) => d.phaseId === "b");
		assert.ok(bd, "replay should produce a decision for phase b");
		assert.equal(bd.outcome, "would-exceed-budget", `b cumulative $0.90 > $0.50 cap, got: ${bd.outcome}`);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("e2e replay: no overrides means all reused (consistency oracle)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-replay-noop-"));
	const tracePath = path.join(cwd, "trace.jsonl");
	try {
		const def: Taskflow = {
			name: "simple-chain",
			phases: [
				{ id: "first", task: "do first" },
				{ id: "second", task: "do second", dependsOn: ["first"], final: true },
			],
		};
		await executeTaskflow(state(def, cwd), {
			cwd,
			agents: [AGENT],
			runTask: async (_c, _a, agent, task) => ok(agent, task, "result", 0.01),
			trace: new FileTraceSink(tracePath),
			persist: () => {},
		});

		const raw = readTrace(tracePath);
		assert.ok(raw.length > 0);
		const events = toEvents(tracePath);
		const report = replayRun(events, {});
		assert.equal(report.needsLiveRerun, false);
		for (const d of report.decisions) {
			assert.equal(d.outcome, "reused", `phase ${d.phaseId} should be reused, got: ${d.outcome}`);
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
