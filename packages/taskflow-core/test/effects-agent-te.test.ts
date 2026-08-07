/**
 * G5 agent-path Trusted Effects: mock runner must not promote finals by
 * writing declared paths; content is resource-transaction promoted from output.
 * Illegal EffectIR (label-flow) fails closed before authority admission.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunResult } from "../src/host/runner-types.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

const AGENTS: AgentConfig[] = [
	{ name: "executor", description: "test", systemPrompt: "", source: "user", filePath: "" },
];

function mkState(def: Taskflow, cwd: string): RunState {
	return {
		runId: "test-run",
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

function okResult(agentName: string, task: string, output: string): RunResult {
	return {
		agent: agentName,
		task,
		exitCode: 0,
		output,
		stderr: "",
		usage: { ...emptyUsage(), output: 5, turns: 1 },
		stopReason: "end",
		completionSource: "process-exit",
	};
}

const writeEffect = {
	id: "report",
	kind: "fs.write" as const,
	target: {
		kind: "path" as const,
		path: {
			workspace: "project",
			subpath: { literalPath: "out/report.md" },
			intent: "create-file" as const,
		},
	},
	confidentiality: "internal" as const,
	integrity: "project" as const,
};

test("agent path: mock runner writing declared final fails closed (bypass)", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-agent-bypass-"));
	try {
		const def: Taskflow = {
			name: "te-agent-bypass",
			phases: [
				{
					id: "write",
					type: "agent",
					agent: "executor",
					task: "write the report",
					effects: [writeEffect],
					final: true,
				},
			],
		};
		const deps: RuntimeDeps = {
			cwd: root,
			agents: AGENTS,
			runTask: async (_cwd, _agents, agentName, task) => {
				fs.mkdirSync(path.join(root, "out"), { recursive: true });
				fs.writeFileSync(path.join(root, "out/report.md"), "BYPASS\n");
				return okResult(agentName, task, "should-not-promote\n");
			},
		};
		const res = await executeTaskflow(mkState(def, root), deps);
		assert.equal(res.ok, false, "bypass must fail the run/phase");
		const ps = res.state.phases["write"];
		assert.equal(ps?.status, "failed");
		assert.match(ps?.error ?? "", /declared-path-bypass|trusted-effects/i);
		assert.equal(
			fs.existsSync(path.join(root, "out/report.md")),
			false,
			"failed phase must restore the pre-phase state instead of retaining the bypass write",
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("gate eval fast path: declared write is finalized through the same authority path", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-gate-eval-"));
	try {
		const def: Taskflow = {
			name: "te-gate-eval-write",
			phases: [
				{
					id: "gate",
					type: "gate",
					eval: ["true"],
					effects: [writeEffect],
					final: true,
				},
			],
		};
		const deps: RuntimeDeps = {
			cwd: root,
			agents: AGENTS,
			runTask: async () => {
				throw new Error("eval auto-pass must not call an LLM");
			},
		};
		const res = await executeTaskflow(mkState(def, root), deps);
		assert.equal(res.ok, true, res.state.finalOutput ?? JSON.stringify(res.state.phases));
		assert.equal(
			fs.readFileSync(path.join(root, "out/report.md"), "utf8"),
			"PASS (eval checks passed — no LLM call)",
		);
		assert.ok((res.state.phases["gate"]?.warnings ?? []).some((w) => /trusted-effects|resource intent/i.test(w)));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("agent path: mock runner content is promoted only via the resource transaction", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-agent-ok-"));
	try {
		const def: Taskflow = {
			name: "te-agent-ok",
			phases: [
				{
					id: "write",
					type: "agent",
					agent: "executor",
					task: "produce report body",
					effects: [writeEffect],
					final: true,
				},
			],
		};
		const deps: RuntimeDeps = {
			cwd: root,
			agents: AGENTS,
			runTask: async (_c, _a, agentName, task) => okResult(agentName, task, "FROM_AGENT_VIA_RESOURCE_INTENT\n"),
		};
		const res = await executeTaskflow(mkState(def, root), deps);
		assert.equal(res.ok, true, res.state.finalOutput ?? JSON.stringify(res.state.phases));
		assert.equal(fs.readFileSync(path.join(root, "out/report.md"), "utf8"), "FROM_AGENT_VIA_RESOURCE_INTENT\n");
		const ps = res.state.phases["write"];
		assert.equal(ps?.status, "done");
		assert.ok((ps?.warnings ?? []).some((w) => /trusted-effects|resource intent/i.test(w)));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("agent path: illegal label-flow fails phase via executeTaskflow", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-agent-label-"));
	try {
		const def: Taskflow = {
			name: "te-agent-label",
			phases: [
				{
					id: "write",
					type: "agent",
					agent: "executor",
					task: "x",
					effects: [
						{
							id: "secret-input",
							kind: "secret.read",
							target: { kind: "secret", secret: { secretId: "api-key" } },
						},
						{
							id: "bad-output",
							kind: "fs.write",
							confidentiality: "public",
							target: {
								kind: "path",
								path: {
									workspace: "p",
									subpath: { literalPath: "leak.txt" },
									intent: "create-file",
								},
							},
						},
					],
					final: true,
				},
			],
		};
		const deps: RuntimeDeps = {
			cwd: root,
			agents: AGENTS,
			runTask: async (_c, _a, agentName, task) => okResult(agentName, task, "nope\n"),
		};
		const res = await executeTaskflow(mkState(def, root), deps);
		assert.equal(res.ok, false);
		assert.match(res.state.phases["write"]?.error ?? "", /effectir-invalid|trusted-effects|label/i);
		assert.equal(fs.existsSync(path.join(root, "leak.txt")), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("runtime: cross-phase label violation fails before any phase body", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-cross-label-"));
	let calls = 0;
	try {
		const def: Taskflow = {
			name: "te-cross-label",
			phases: [
				{
					id: "read-secret",
					type: "agent",
					agent: "executor",
					task: "read",
					effects: [{
						id: "secret-input",
						kind: "secret.read",
						target: { kind: "secret", secret: { secretId: "api-key" } },
					}],
				},
				{
					id: "publish",
					type: "agent",
					agent: "executor",
					task: "publish",
					dependsOn: ["read-secret"],
					effects: [{
						id: "public-output",
						kind: "fs.write",
						confidentiality: "public",
						target: {
							kind: "path",
							path: { workspace: "project", subpath: { literalPath: "leak.txt" }, intent: "create-file" },
						},
					}],
					final: true,
				},
			],
		};
		const deps: RuntimeDeps = {
			cwd: root,
			agents: AGENTS,
			runTask: async (_c, _a, agentName, task) => {
				calls++;
				return okResult(agentName, task, "nope\n");
			},
		};
		const res = await executeTaskflow(mkState(def, root), deps);
		assert.equal(res.ok, false);
		assert.equal(calls, 0, "whole-flow validation must run before the first phase body");
		assert.match(res.finalOutput, /EffectIR label flow is invalid.*read-secret\/secret-input.*publish\/public-output/);
		assert.equal(fs.existsSync(path.join(root, "leak.txt")), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("runtime: unbound effect kind fails before the phase body", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-unbound-effect-"));
	let calls = 0;
	try {
		const def: Taskflow = {
			name: "te-unbound-effect",
			phases: [{
				id: "read-secret",
				type: "agent",
				agent: "executor",
				task: "read",
				effects: [{
					id: "secret-input",
					kind: "secret.read",
					target: { kind: "secret", secret: { secretId: "api-key" } },
				}],
				final: true,
			}],
		};
		const deps: RuntimeDeps = {
			cwd: root,
			agents: AGENTS,
			runTask: async (_c, _a, agentName, task) => {
				calls++;
				return okResult(agentName, task, "nope\n");
			},
		};
		const res = await executeTaskflow(mkState(def, root), deps);
		assert.equal(res.ok, false);
		assert.equal(calls, 0);
		assert.match(res.state.phases["read-secret"]?.error ?? "", /unsupported-effect-kind.*secret\.read/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
