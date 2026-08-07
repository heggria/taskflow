/**
 * E2E: prove the taskflow engine runs on Codex.
 *
 * Drives the REAL engine (executeTaskflow) with the REAL codexSubagentRunner,
 * which spawns a real `codex exec --json` process. This is the decisive
 * "does pi-taskflow actually work on codex" proof — a two-phase flow where
 * phase B consumes phase A's output, all executed by codex subagents.
 *
 * Run: node --experimental-strip-types test/e2e-codex.mts
 * Requires: codex CLI installed + authenticated. Override bin via
 *           PI_TASKFLOW_CODEX_BIN.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	executeTaskflow,
	whyEffectFromDurableJournal,
	type RuntimeDeps,
} from "taskflow-core";
import { codexSubagentRunner } from "taskflow-hosts/codex";
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
	},
];

function mkState(def: Taskflow, cwd: string): RunState {
	return {
		runId: `e2e-codex-${Date.now()}`,
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
	};
}

const def: Taskflow = {
	name: "codex-e2e",
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
		},
		{
			id: "persist",
			type: "agent",
			agent: "responder",
			task: 'Reply with exactly "{steps.use.output}" and nothing else.',
			dependsOn: ["use"],
			tools: ["read"],
			effects: [{
				id: "result",
				kind: "fs.write",
				purpose: "persist the live Codex result through resource authority",
				confidentiality: "internal",
				integrity: "project",
				target: {
					kind: "path",
					path: {
						workspace: "project",
						subpath: { literalPath: "out/result.txt" },
						intent: "create-file",
					},
				},
			}],
			final: true,
		},
	],
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-codex-e2e-"));
const controlDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-codex-control-"));
const deps: RuntimeDeps = {
	cwd: root,
	workspaceControlDirectory: controlDirectory,
	agents: AGENTS,
	runTask: codexSubagentRunner.runTask,
	onProgress: (s) => {
		const phases = Object.values(s.phases)
			.map((p: any) => `${p.id}:${p.status}`)
			.join(" ");
		process.stderr.write(`\r[progress] ${phases}        `);
	},
};

try {
	console.log("▶ running 3-phase taskflow on codex (real subagents + Trusted Effects)…\n");
	const t0 = Date.now();
	const state = mkState(def, root);
	const res = await executeTaskflow(state, deps);
	const dt = ((Date.now() - t0) / 1000).toFixed(1);

	process.stderr.write("\n");
	console.log(`\n✓ run finished in ${dt}s — ok=${res.ok}`);
	console.log("  phase pick.output:", JSON.stringify(res.state.phases["pick"]?.output?.trim()));
	console.log("  final output     :", JSON.stringify(res.finalOutput?.trim()));
	console.log("  total usage      :", JSON.stringify(res.totalUsage));

	assert.equal(res.ok, true, "run should succeed");
	assert.ok((res.state.phases["pick"]?.output ?? "").trim().length > 0, "phase pick produced output");
	assert.ok((res.finalOutput ?? "").trim().length > 0, "final output non-empty");
	// Phase use uppercases pick; persist echoes that content from a read-only Codex
	// sandbox and the resource transaction alone promotes it to the final path.
	const pickWord = (res.state.phases["pick"]?.output ?? "").trim().replace(/[^a-zA-Z]/g, "").toUpperCase();
	const finalWord = (res.finalOutput ?? "").trim().replace(/[^a-zA-Z]/g, "").toUpperCase();
	assert.ok(finalWord.length > 0, "final word non-empty");
	assert.equal(finalWord, pickWord, `data should flow A→B→C: pick=${pickWord} final=${finalWord}`);
	assert.equal(fs.readFileSync(path.join(root, "out/result.txt"), "utf8").trim(), finalWord);

	const why = await whyEffectFromDurableJournal({
		flow: def,
		runId: state.runId,
		phaseId: "persist",
		effectId: "result",
		workspaceRoot: root,
		controlDirectory,
	});
	assert.equal(why.ok, true);
	if (!why.ok) throw new Error(why.error);
	assert.equal(why.why.status, "committed");
	assert.equal(why.why.authorized.allowed, true);
	assert.equal(why.why.authorized.principalId, "local-host-invocation");

	console.log("\n✅ E2E PASS — live Codex data flowed A→B→C; fs.write committed with ledger-backed authority.");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(controlDirectory, { recursive: true, force: true });
}
