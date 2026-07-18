/**
 * Manual live-Pi regression for #73.
 *
 * Runs two real model turns with an explicitly allowlisted extension that keeps
 * a referenced interval alive. Each Pi CLI therefore emits its genuine NDJSON
 * lifecycle but cannot exit on its own; Taskflow must validate the terminal
 * candidate, reap it, and proceed to phase two. Set PI_TASKFLOW_E2E_MODEL to
 * select an authenticated model instead of Pi's current default.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	executeTaskflow,
	type AgentConfig,
	type RunResult,
	type RunState,
	type Taskflow,
} from "taskflow-core";
import { createPiSubagentRunner } from "../src/runner.ts";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-real-pi-terminal-"));
const extension = path.join(cwd, "leaky-extension.mjs");
const e2eModel = process.env.PI_TASKFLOW_E2E_MODEL?.trim();
fs.writeFileSync(extension, `export default function leakyExtension() { setInterval(() => {}, 1000); }\n`);

try {
	const def: Taskflow = {
		name: "real-pi-terminal-reap",
		phases: [
			{ id: "one", type: "agent", agent: "executor", task: "Reply with exactly PHASE_ONE_DONE and nothing else." },
			{ id: "two", type: "agent", agent: "executor", task: "Reply with exactly PHASE_TWO_DONE and nothing else.", dependsOn: ["one"], final: true },
		],
	};
	const state: RunState = {
		runId: `real-pi-terminal-${Date.now()}`,
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
	};
	const agents: AgentConfig[] = [
		{
			name: "executor",
			description: "live smoke",
			systemPrompt: "Follow the requested output format exactly.",
			source: "user",
			filePath: "",
			...(e2eModel ? { model: e2eModel } : {}),
		},
	];
	const runner = createPiSubagentRunner({
		resourceProfile: "allowlist",
		extensions: [extension],
		terminalGraceMs: 250,
	});
	const calls: RunResult[] = [];
	const result = await executeTaskflow(state, {
		cwd,
		agents,
		runTask: async (...args) => {
			const call = await runner.runTask(...args);
			calls.push(call);
			return call;
		},
	});

	assert.equal(result.ok, true, JSON.stringify({
		finalOutput: result.finalOutput,
		status: result.state.status,
		phases: result.state.phases,
		calls,
	}, null, 2));
	assert.equal(calls.length, 2);
	assert.match(calls[0].output, /PHASE_ONE_DONE/);
	assert.match(calls[1].output, /PHASE_TWO_DONE/);
	assert.equal(calls[0].completionSource, "terminal-reap");
	assert.equal(calls[1].completionSource, "terminal-reap");
	console.log(JSON.stringify({ ok: true, calls: calls.map((call) => ({
		output: call.output,
		completionSource: call.completionSource,
		reapedAfterTerminal: call.reapedAfterTerminal,
	})) }, null, 2));
} finally {
	fs.rmSync(cwd, { recursive: true, force: true });
}
