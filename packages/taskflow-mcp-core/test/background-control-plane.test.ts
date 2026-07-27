import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { emptyUsage, newRunId, saveRun, type RunState, type SubagentRunner, type Taskflow } from "taskflow-core";
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

const legacyForegroundRunner: SubagentRunner = {
	runTask: async (_cwd, _agents, agent, task) => ({
		agent,
		task,
		exitCode: 0,
		output: "legacy foreground completed",
		stderr: "",
		usage: emptyUsage(),
	}),
};

function inlineAgentFlow(): Taskflow {
	return {
		name: "background-control-plane",
		phases: [{ id: "work", type: "agent", agent: "executor", task: "work", final: true }],
	};
}

function usePrivateAgentDir(cwd: string): () => void {
	const previous = process.env.TASKFLOW_AGENT_DIR;
	process.env.TASKFLOW_AGENT_DIR = path.join(cwd, ".agent");
	return () => {
		if (previous === undefined) delete process.env.TASKFLOW_AGENT_DIR;
		else process.env.TASKFLOW_AGENT_DIR = previous;
	};
}

function legacyRunningState(cwd: string): RunState {
	const now = Date.now();
	return {
		runId: newRunId("legacy-background"),
		flowName: "legacy-background",
		def: inlineAgentFlow(),
		args: {},
		status: "running",
		phases: {},
		createdAt: now,
		updatedAt: now,
		cwd,
		detached: true,
		detachedStartedAt: now,
		pid: 999_999,
	};
}

function snapshotTree(root: string): Record<string, string> {
	const files: Record<string, string> = {};
	const visit = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const absolute = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(absolute);
			else if (entry.isFile()) files[path.relative(root, absolute)] = fs.readFileSync(absolute).toString("base64");
		}
	};
	visit(root);
	return files;
}

/** A detached child can close its final handles just after wait observes the
 * persisted terminal state. Do not let that OS cleanup race make this
 * lifecycle-contract test flaky; the private temp directory is otherwise
 * disposable. */
function cleanupTemp(cwd: string): void {
	try {
		fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
	} catch {
		/* The OS will reclaim a test-private temp directory after a late child exit. */
	}
}

function backgroundRunId(result: TextResult): string {
	const match = /\brun ([A-Za-z0-9._-]+)/.exec(result.content[0]?.text ?? "");
	assert.ok(match, `expected background run id in:\n${result.content[0]?.text}`);
	return match[1]!;
}

test(
	"mcp background: default control-plane mode rejects legacy detached execution before .pi state exists",
	{ concurrency: false },
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-background-control-plane-"));
		const restoreAgentDir = usePrivateAgentDir(cwd);
		const previous = process.env.TASKFLOW_CONTROL_PLANE;
		delete process.env.TASKFLOW_CONTROL_PLANE;
		try {
			const tools = makeToolHandlers(cwd, unusedForegroundRunner, {
				host: "test",
				detachedRunner: {
					module: "file:///must-not-load.mjs",
					exportName: "mustNotRun",
				},
			});
			const result = await tools.taskflow_run({ define: inlineAgentFlow(), mode: "background" }) as TextResult;

			assert.equal(result.isError, true, result.content[0]?.text);
			assert.match(result.content[0]?.text ?? "", /background.*control.?plane|control.?plane.*background/i);
			assert.equal(fs.existsSync(path.join(cwd, ".pi")), false, "rejection must precede legacy run-state writes");
		} finally {
			if (previous === undefined) delete process.env.TASKFLOW_CONTROL_PLANE;
			else process.env.TASKFLOW_CONTROL_PLANE = previous;
			restoreAgentDir();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	},
);

test(
	"mcp background: default control-plane mode does not invoke or mutate an existing legacy .pi lifecycle",
	{ concurrency: false },
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-background-control-plane-existing-"));
		const restoreAgentDir = usePrivateAgentDir(cwd);
		const previous = process.env.TASKFLOW_CONTROL_PLANE;
		delete process.env.TASKFLOW_CONTROL_PLANE;
		try {
			const legacy = legacyRunningState(cwd);
			saveRun(legacy);
			const legacyRoot = path.join(cwd, ".pi");
			const tools = makeToolHandlers(cwd, unusedForegroundRunner, {
				host: "test",
				detachedRunner: {
					module: "file:///must-not-load.mjs",
					exportName: "mustNotRun",
				},
			});
			for (const args of [
				{ action: "list" },
				{ action: "status", runId: legacy.runId },
				{ action: "wait", runId: legacy.runId, timeoutMs: 0 },
				{ action: "cancel", runId: legacy.runId, reason: "must-not-write" },
			]) {
				const before = snapshotTree(legacyRoot);
				const result = await tools.taskflow_runs(args) as TextResult;
				assert.equal(result.isError, true, `${args.action}: ${result.content[0]?.text}`);
				assert.match(result.content[0]?.text ?? "", /no legacy fallthrough/i);
				assert.deepEqual(snapshotTree(legacyRoot), before, `${args.action} must not change legacy .pi state`);
			}
			const beforeResume = snapshotTree(legacyRoot);
			const resumed = await tools.taskflow_resume({ runId: legacy.runId }) as TextResult;
			assert.equal(resumed.isError, true, resumed.content[0]?.text);
			assert.match(resumed.content[0]?.text ?? "", /no legacy fallthrough/i);
			assert.deepEqual(snapshotTree(legacyRoot), beforeResume, "resume must not change legacy .pi state");
		} finally {
			if (previous === undefined) delete process.env.TASKFLOW_CONTROL_PLANE;
			else process.env.TASKFLOW_CONTROL_PLANE = previous;
			restoreAgentDir();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	},
);

test(
	"mcp background: every non-opt-out control-plane value fails closed before detached launch",
	{ concurrency: false },
	async () => {
		const previous = process.env.TASKFLOW_CONTROL_PLANE;
		try {
			for (const value of ["", "1", "true", "unexpected"]) {
				const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-background-control-plane-value-"));
				const restoreAgentDir = usePrivateAgentDir(cwd);
				process.env.TASKFLOW_CONTROL_PLANE = value;
				try {
					const tools = makeToolHandlers(cwd, unusedForegroundRunner, {
						host: "test",
						detachedRunner: { module: "file:///must-not-load.mjs", exportName: "mustNotRun" },
					});
					const result = await tools.taskflow_run({ define: inlineAgentFlow(), mode: "background" }) as TextResult;
					assert.equal(result.isError, true, `${JSON.stringify(value)}: ${result.content[0]?.text}`);
					assert.match(result.content[0]?.text ?? "", /no legacy fallthrough/i);
					assert.equal(fs.existsSync(path.join(cwd, ".pi")), false, `${JSON.stringify(value)} must not create .pi state`);
				} finally {
					restoreAgentDir();
					fs.rmSync(cwd, { recursive: true, force: true });
				}
			}
		} finally {
			if (previous === undefined) delete process.env.TASKFLOW_CONTROL_PLANE;
			else process.env.TASKFLOW_CONTROL_PLANE = previous;
		}
	},
);

test(
	"mcp background: every documented explicit opt-out enables only the legacy lifecycle",
	{ concurrency: false },
	async () => {
		const previous = process.env.TASKFLOW_CONTROL_PLANE;
		try {
			for (const optOut of ["0", "false", "off", "no"]) {
				const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `tf-mcp-background-opt-out-${optOut}-`));
				const restoreAgentDir = usePrivateAgentDir(cwd);
				process.env.TASKFLOW_CONTROL_PLANE = optOut;
				try {
					const tools = makeToolHandlers(cwd, unusedForegroundRunner, {
						host: "test",
						detachedRunner: {
							module: pathToFileURL(path.join(import.meta.dirname, "fixtures", "background-runner.mjs")).href,
							exportName: "instantRunner",
						},
					});
					const started = await tools.taskflow_run({ define: inlineAgentFlow(), mode: "background" }) as TextResult;
					assert.equal(started.isError, false, `${optOut}: ${started.content[0]?.text}`);
					const runId = backgroundRunId(started);
					const waited = await tools.taskflow_runs({ action: "wait", runId, timeoutMs: 5_000 }) as TextResult;
					assert.equal(waited.isError, false, `${optOut}: ${waited.content[0]?.text}`);
					assert.match(waited.content[0]?.text ?? "", /✓ completed/);
				} finally {
					restoreAgentDir();
					cleanupTemp(cwd);
				}
			}
		} finally {
			if (previous === undefined) delete process.env.TASKFLOW_CONTROL_PLANE;
			else process.env.TASKFLOW_CONTROL_PLANE = previous;
		}
	},
);

test(
	"mcp foreground: explicit control-plane opt-out takes the 0.2 engine path",
	{ concurrency: false },
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-foreground-opt-out-"));
		const restoreAgentDir = usePrivateAgentDir(cwd);
		const previous = process.env.TASKFLOW_CONTROL_PLANE;
		process.env.TASKFLOW_CONTROL_PLANE = "no";
		try {
			const tools = makeToolHandlers(cwd, legacyForegroundRunner, { host: "test" });
			const result = await tools.taskflow_run({ define: inlineAgentFlow() }) as TextResult;

			assert.equal(result.isError, false, result.content[0]?.text);
			assert.match(result.content[0]?.text ?? "", /legacy foreground completed/);
			assert.doesNotMatch(result.content[0]?.text ?? "", /control-plane run completed/i);
		} finally {
			if (previous === undefined) delete process.env.TASKFLOW_CONTROL_PLANE;
			else process.env.TASKFLOW_CONTROL_PLANE = previous;
			restoreAgentDir();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	},
);
