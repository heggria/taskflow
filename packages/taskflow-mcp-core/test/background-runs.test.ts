import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	DETACHED_CONTROL_VERSION,
	loadRun,
	newRunId,
	probeProcess,
	saveRun,
	type RunState,
	type SubagentRunner,
	type Taskflow,
} from "taskflow-core";
import { makeToolHandlers } from "taskflow-mcp-core/server";

interface TextResult {
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}

const unusedForegroundRunner: SubagentRunner = {
	runTask: async () => {
		throw new Error("foreground runner should not be called");
	},
};

function fixtureModule(): string {
	return pathToFileURL(path.join(import.meta.dirname, "fixtures", "background-runner.mjs")).href;
}

function runIdFrom(result: TextResult): string {
	const match = /\brun ([A-Za-z0-9._-]+)/.exec(result.content[0]?.text ?? "");
	assert.ok(match, `expected run id in:\n${result.content[0]?.text}`);
	return match[1]!;
}

function usePrivateAgentDir(cwd: string): () => void {
	const previous = process.env.TASKFLOW_AGENT_DIR;
	process.env.TASKFLOW_AGENT_DIR = path.join(cwd, ".agent");
	return () => {
		if (previous === undefined) delete process.env.TASKFLOW_AGENT_DIR;
		else process.env.TASKFLOW_AGENT_DIR = previous;
	};
}

function inlineAgentFlow(name: string): Taskflow {
	return {
		name,
		phases: [{ id: "work", type: "agent", agent: "executor", task: "work", final: true }],
	};
}

function runningBackgroundState(cwd: string, name: string): RunState {
	const now = Date.now();
	return {
		runId: newRunId(name),
		flowName: name,
		def: inlineAgentFlow(name),
		args: {},
		status: "running",
		phases: {},
		createdAt: now,
		updatedAt: now,
		cwd,
		detached: true,
		detachedStartedAt: now,
		pid: process.pid,
	};
}

test("mcp background: run returns immediately and wait returns durable final output", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-background-"));
	const restoreAgentDir = usePrivateAgentDir(cwd);
	try {
		const tools = makeToolHandlers(cwd, unusedForegroundRunner, {
			host: "test",
			detachedRunner: { module: fixtureModule(), exportName: "instantRunner" },
		});
		const started = await tools.taskflow_run({ define: inlineAgentFlow("background-complete"), mode: "background" }) as TextResult;
		assert.equal(started.isError, false);
		assert.match(started.content[0]!.text, /started in background/);
		const runId = runIdFrom(started);

		const waited = await tools.taskflow_runs({ action: "wait", runId, timeoutMs: 5_000 }) as TextResult;
		assert.equal(waited.isError, false, waited.content[0]?.text);
		assert.match(waited.content[0]!.text, /✓ completed/);
		assert.match(waited.content[0]!.text, /detached output/);

		const stored = loadRun(cwd, runId);
		assert.equal(stored?.status, "completed");
		assert.equal(stored?.finalOutput, "detached output");
		assert.equal(stored?.outputSourcePhaseId, "work");

		const listed = await tools.taskflow_runs({ action: "list" }) as TextResult;
		assert.match(listed.content[0]!.text, new RegExp(runId));
	} finally {
		restoreAgentDir();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("mcp background: cancel survives request boundaries and pauses the run", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-cancel-"));
	const restoreAgentDir = usePrivateAgentDir(cwd);
	try {
		const tools = makeToolHandlers(cwd, unusedForegroundRunner, {
			host: "test",
			detachedRunner: { module: fixtureModule(), exportName: "cancellableRunner" },
		});
		const started = await tools.taskflow_run({ define: inlineAgentFlow("background-cancel"), mode: "background" }) as TextResult;
		const runId = runIdFrom(started);

		const cancelled = await tools.taskflow_runs({ action: "cancel", runId, reason: "test cancellation" }) as TextResult;
		assert.equal(cancelled.isError, false);
		assert.match(cancelled.content[0]!.text, /Cancellation requested/);

		const waited = await tools.taskflow_runs({ action: "wait", runId, timeoutMs: 5_000 }) as TextResult;
		assert.equal(waited.isError, true);
		assert.match(waited.content[0]!.text, /Ⅱ paused/);
		assert.equal(loadRun(cwd, runId)?.status, "paused");
	} finally {
		restoreAgentDir();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("mcp background: roster filters active runs and warns about uncoordinated contention", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-roster-"));
	const restoreAgentDir = usePrivateAgentDir(cwd);
	try {
		for (let index = 0; index < 5; index++) {
			saveRun(runningBackgroundState(cwd, `already-running-${index}`));
		}

		const tools = makeToolHandlers(cwd, unusedForegroundRunner, {
			host: "test",
			detachedRunner: { module: fixtureModule(), exportName: "cancellableRunner" },
		});
		const started = await tools.taskflow_run({ define: inlineAgentFlow("contention-warning"), mode: "background" }) as TextResult;
		assert.equal(started.isError, false);
		assert.match(started.content[0]!.text, /Warning: 6 background runs are active/);
		const runId = runIdFrom(started);

		const active = await tools.taskflow_runs({ action: "list", status: "running", limit: 3 }) as TextResult;
		assert.match(active.content[0]!.text, /6 active · 6 total · running/);
		assert.doesNotMatch(active.content[0]!.text, /completed/);

		await tools.taskflow_runs({ action: "cancel", runId, reason: "test cleanup" });
		await tools.taskflow_runs({ action: "wait", runId, timeoutMs: 5_000 });
	} finally {
		restoreAgentDir();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("mcp background: malformed historical state cannot turn a successful launch into start failed", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-corrupt-roster-"));
	const restoreAgentDir = usePrivateAgentDir(cwd);
	try {
		const malformed = runningBackgroundState(cwd, "malformed-old-run");
		malformed.def = {} as Taskflow;
		saveRun(malformed);

		const tools = makeToolHandlers(cwd, unusedForegroundRunner, {
			host: "test",
			detachedRunner: { module: fixtureModule(), exportName: "instantRunner" },
		});
		const started = await tools.taskflow_run({ define: inlineAgentFlow("survives-roster"), mode: "background" }) as TextResult;
		assert.equal(started.isError, false, started.content[0]?.text);
		assert.match(started.content[0]!.text, /started in background/);
		const runId = runIdFrom(started);
		const waited = await tools.taskflow_runs({ action: "wait", runId, timeoutMs: 5_000 }) as TextResult;
		assert.match(waited.content[0]!.text, /✓ completed/);
	} finally {
		restoreAgentDir();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("mcp background: legacy detached workers fail closed for cancel", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-legacy-cancel-"));
	const restoreAgentDir = usePrivateAgentDir(cwd);
	try {
		const legacy = runningBackgroundState(cwd, "legacy-running");
		saveRun(legacy);
		const tools = makeToolHandlers(cwd, unusedForegroundRunner);
		const cancelled = await tools.taskflow_runs({ action: "cancel", runId: legacy.runId }) as TextResult;
		assert.equal(cancelled.isError, true);
		assert.match(cancelled.content[0]!.text, /legacy detached worker/);
	} finally {
		restoreAgentDir();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("mcp background: current worker without a heartbeat leaves running after startup grace", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-missing-heartbeat-"));
	const restoreAgentDir = usePrivateAgentDir(cwd);
	try {
		const state = runningBackgroundState(cwd, "missing-heartbeat");
		state.detachedControlVersion = DETACHED_CONTROL_VERSION;
		state.detachedInstanceId = "missing-heartbeat-instance";
		state.detachedStartedAt = Date.now() - 10_000;
		state.pid = 2_147_483_647;
		saveRun(state);

		const tools = makeToolHandlers(cwd, unusedForegroundRunner);
		const status = await tools.taskflow_runs({ action: "status", runId: state.runId }) as TextResult;
		assert.equal(status.isError, false);
		assert.match(status.content[0]!.text, /failed/);
		assert.equal(loadRun(cwd, state.runId)?.status, "failed");
	} finally {
		restoreAgentDir();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("mcp background: sibling worktrees sharing an ancestor .pi remain isolated", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-worktrees-"));
	const cwdA = path.join(root, "worktree-a");
	const cwdB = path.join(root, "worktree-b");
	fs.mkdirSync(path.join(root, ".pi"));
	fs.mkdirSync(cwdA);
	fs.mkdirSync(cwdB);
	const restoreAgentDir = usePrivateAgentDir(root);
	try {
		const ownedByA = runningBackgroundState(cwdA, "owned-by-a");
		saveRun(ownedByA);
		const toolsA = makeToolHandlers(cwdA, unusedForegroundRunner);
		const toolsB = makeToolHandlers(cwdB, unusedForegroundRunner);
		const listA = await toolsA.taskflow_runs({ action: "list" }) as TextResult;
		assert.match(listA.content[0]!.text, new RegExp(ownedByA.runId));
		const listB = await toolsB.taskflow_runs({ action: "list" }) as TextResult;
		assert.doesNotMatch(listB.content[0]!.text, new RegExp(ownedByA.runId));
		const statusB = await toolsB.taskflow_runs({ action: "status", runId: ownedByA.runId }) as TextResult;
		assert.equal(statusB.isError, true);
		assert.match(statusB.content[0]!.text, /not found/);
	} finally {
		restoreAgentDir();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("mcp background: foreground and background share agent scope and thinking", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-parity-"));
	const restoreAgentDir = usePrivateAgentDir(cwd);
	try {
		fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".pi", "agents", "project-only.md"),
			"---\nname: project-only\ndescription: parity fixture\n---\nPROJECT AGENT MARKER\n",
		);
		fs.mkdirSync(path.join(cwd, ".agent"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".agent", "settings.json"),
			JSON.stringify({ subagents: { globalThinking: "high" }, taskflow: { builtInAgents: false } }),
		);
		const foregroundRunner: SubagentRunner = {
			usageAccounting: "available",
			runTask: async (_cwd, agents, agent, _task, _options, globalThinking) => {
				const agentList = agents as Array<{ name: string; systemPrompt: string }>;
				return {
					agent,
					task: "snapshot",
					exitCode: 0,
					output: `${agentList.find((candidate) => candidate.name === agent)?.systemPrompt ?? "missing-agent"}|${globalThinking ?? "no-thinking"}`,
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
					stopReason: "end",
				};
			},
		};
		const flow: Taskflow = {
			name: "mode-parity",
			agentScope: "project",
			phases: [{ id: "work", type: "agent", agent: "project-only", task: "snapshot", final: true }],
		};
		const tools = makeToolHandlers(cwd, foregroundRunner, {
			host: "test",
			detachedRunner: { module: fixtureModule(), exportName: "snapshotRunner" },
		});
		const foreground = await tools.taskflow_run({ define: flow }) as TextResult;
		assert.match(foreground.content[0]!.text, /PROJECT AGENT MARKER\|high/);
		const started = await tools.taskflow_run({ define: flow, mode: "background" }) as TextResult;
		const waited = await tools.taskflow_runs({ action: "wait", runId: runIdFrom(started), timeoutMs: 5_000 }) as TextResult;
		assert.match(waited.content[0]!.text, /PROJECT AGENT MARKER\|high/);
	} finally {
		restoreAgentDir();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("mcp background: hard-killed worker reaps its registered Host CLI tree", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-hard-kill-"));
	const restoreAgentDir = usePrivateAgentDir(cwd);
	const heartbeat = path.join(cwd, "host-heartbeat");
	try {
		const tools = makeToolHandlers(cwd, unusedForegroundRunner, {
			host: "test",
			detachedRunner: { module: fixtureModule(), exportName: "orphaningRunner" },
		});
		const flow: Taskflow = {
			name: "hard-kill",
			phases: [{ id: "work", type: "agent", agent: "executor", task: heartbeat, final: true }],
		};
		const started = await tools.taskflow_run({ define: flow, mode: "background" }) as TextResult;
		const runId = runIdFrom(started);
		const deadline = Date.now() + 5_000;
		while ((!fs.existsSync(`${heartbeat}.pid`) || !fs.existsSync(heartbeat)) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.equal(fs.existsSync(`${heartbeat}.pid`), true, "fixture Host CLI started");
		assert.equal(fs.existsSync(heartbeat), true, "fixture Host CLI mutated before worker death");
		const hostPid = Number(fs.readFileSync(`${heartbeat}.pid`, "utf8"));
		const workerPid = loadRun(cwd, runId)?.pid;
		assert.ok(workerPid);
		process.kill(workerPid, "SIGKILL");

		while (loadRun(cwd, runId)?.status === "running" && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.equal(loadRun(cwd, runId)?.status, "failed");
		while (probeProcess(hostPid) !== "dead" && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.equal(probeProcess(hostPid), "dead", "registered Host CLI process tree was reaped");
		const sizeAfterReap = fs.statSync(heartbeat).size;
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(fs.statSync(heartbeat).size, sizeAfterReap, "workspace mutation stopped after terminal failure");
	} finally {
		restoreAgentDir();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
