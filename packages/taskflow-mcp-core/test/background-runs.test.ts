import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { loadRun, newRunId, saveRun, type RunState, type SubagentRunner, type Taskflow } from "taskflow-core";
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
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("mcp background: cancel survives request boundaries and pauses the run", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-cancel-"));
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
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("mcp background: roster filters active runs and warns about uncoordinated contention", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-roster-"));
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
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
