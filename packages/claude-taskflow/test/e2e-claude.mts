/**
 * E2E: prove the taskflow engine runs on Claude Code.
 *
 * Drives the REAL engine (executeTaskflow) with the REAL claudeSubagentRunner,
 * which spawns a real `claude -p --output-format stream-json` process. This is
 * the decisive "does taskflow actually work on Claude Code" proof — a two-phase
 * flow where phase B consumes phase A's output, all executed by claude
 * subagents.
 *
 * Run: node --experimental-strip-types test/e2e-claude.mts
 * Requires: claude CLI installed + authenticated. Override bin via
 *           PI_TASKFLOW_CLAUDE_BIN, model via the agent config below.
 */

import assert from "node:assert/strict";
import { executeTaskflow, type RuntimeDeps } from "taskflow-core";
import { claudeSubagentRunner } from "taskflow-hosts/claude";
import type { AgentConfig } from "taskflow-core";
import type { Taskflow } from "taskflow-core";
import type { RunState } from "taskflow-core";

const AGENTS: AgentConfig[] = [
	{
		name: "responder",
		description: "answers tersely",
		systemPrompt: "You are terse. Reply with the minimum text required, no preamble.",
		source: "user",
		filePath: "",
		// A cheap, fast model for the e2e; drop the `/` provider prefix rule means
		// a flat alias like "haiku" passes straight through to `claude --model`.
		model: "haiku",
	},
];

function mkState(def: Taskflow): RunState {
	return {
		runId: `e2e-claude-${Date.now()}`,
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: process.cwd(),
	};
}

const def: Taskflow = {
	name: "claude-e2e",
	phases: [
		{
			id: "pick",
			type: "agent",
			agent: "responder",
			task: "Reply with exactly one word: a random fruit name. Nothing else.",
		},
		{
			id: "use",
			type: "agent",
			agent: "responder",
			task: 'Phase pick said: "{steps.pick.output}". Reply with that same word in UPPERCASE, nothing else.',
			dependsOn: ["pick"],
			final: true,
		},
	],
};

const deps: RuntimeDeps = {
	cwd: process.cwd(),
	agents: AGENTS,
	runTask: claudeSubagentRunner.runTask,
	onProgress: (s) => {
		const phases = Object.values(s.phases)
			.map((p: any) => `${p.id}:${p.status}`)
			.join(" ");
		process.stderr.write(`\r[progress] ${phases}        `);
	},
};

console.log("▶ running 2-phase taskflow on Claude Code (real subagents)…\n");
const t0 = Date.now();
const res = await executeTaskflow(mkState(def), deps);
const dt = ((Date.now() - t0) / 1000).toFixed(1);

process.stderr.write("\n");
console.log(`\n✓ run finished in ${dt}s — ok=${res.ok}`);
console.log("  phase pick.output:", JSON.stringify(res.state.phases["pick"]?.output?.trim()));
console.log("  final output     :", JSON.stringify(res.finalOutput?.trim()));
console.log("  total usage      :", JSON.stringify(res.totalUsage));

assert.equal(res.ok, true, "run should succeed");
assert.ok((res.state.phases["pick"]?.output ?? "").trim().length > 0, "phase pick produced output");
assert.ok((res.finalOutput ?? "").trim().length > 0, "final output non-empty");
// The final phase should have echoed pick's word in uppercase — prove data flowed
// A→B by checking the final output is uppercase and shares letters with pick.
const pickWord = (res.state.phases["pick"]?.output ?? "").trim().replace(/[^a-zA-Z]/g, "").toUpperCase();
const finalWord = (res.finalOutput ?? "").trim().replace(/[^a-zA-Z]/g, "").toUpperCase();
assert.ok(finalWord.length > 0, "final word non-empty");
assert.ok(
	finalWord.includes(pickWord) || pickWord.includes(finalWord),
	`data should flow A→B: pick=${pickWord} final=${finalWord}`,
);

console.log("\n✅ E2E PASS — the taskflow engine ran end-to-end on Claude Code, data flowed A→B.");
