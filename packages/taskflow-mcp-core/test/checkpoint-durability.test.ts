import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { directoryIdentity, emptyUsage, listRuns, probeProcess, runsDir, saveRun, type RunState, type SubagentRunner, type AgentConfig, type Taskflow } from "taskflow-core";
import { makeToolHandlers } from "../src/mcp/server.ts";

for (const mode of ["run", "resume"] as const) {
	test(`MCP ${mode} persists consecutive completed phases before the next runner starts`, async (t) => {
		const cwd = await mkdtemp(join(tmpdir(), "tf-mcp-checkpoint-"));
		t.after(() => rm(cwd, { recursive: true, force: true }));
		const agentsDir = join(cwd, ".pi", "agents");
		await mkdir(agentsDir, { recursive: true });
		await writeFile(join(agentsDir, "checkpoint-agent.md"), "---\nname: checkpoint-agent\ndescription: checkpoint test\n---\nTest agent.\n");
		// Deterministically exercise multiple checkpoints inside the former 1s
		// throttle window; the runtime result is observed separately from disk.
		const now = Date.now();
		t.mock.method(Date, "now", () => now);
		const def: Taskflow = {
			name: "durable-burst",
			phases: [
				{ id: "first", type: "agent", agent: "checkpoint-agent", task: "first" },
				{ id: "second", type: "agent", agent: "checkpoint-agent", task: "second", dependsOn: ["first"] },
				{ id: "inspect", type: "agent", agent: "checkpoint-agent", task: "inspect", dependsOn: ["second"], final: true },
			],
		};
		const parent: RunState = {
			runId: "checkpoint-parent", flowName: def.name, def, args: {}, status: "failed",
			phases: {}, createdAt: now, updatedAt: now, cwd,
		};
		if (mode === "resume") saveRun(parent);
		let checkpoint: RunState | undefined;
		const calls: string[] = [];
		const runner: SubagentRunner<AgentConfig> = {
			runTask: async (_cwd, _agents, agent, task) => {
				calls.push(task);
				if (task === "inspect") checkpoint = listRuns(cwd).find((run) => run.runId !== parent.runId);
				return { agent, task, output: `${task}-output`, stderr: "", exitCode: 0, usage: emptyUsage() };
			},
		};
		const tools = makeToolHandlers(cwd, runner);
		const result = await (mode === "run"
			? tools.taskflow_run!({ define: def })
			: tools.taskflow_resume!({ runId: parent.runId })) as { isError?: boolean; content: Array<{ text: string }> };
		assert.equal(result.isError, false, result.content[0]?.text);
		assert.deepEqual(calls, ["first", "second", "inspect"]);
		assert.equal(checkpoint?.status, "running");
		for (const id of ["first", "second"]) {
			assert.equal(checkpoint?.phases[id]?.status, "done", `${id} must already be durable before further execution`);
			assert.equal(checkpoint?.phases[id]?.output, `${id}-output`);
		}
	});
}

for (const owner of ["alive", "dead-approval", "dead-inflight"] as const) {
	test(`MCP resume applies shared foreground owner admission: ${owner}`, async (t) => {
		const cwd = await mkdtemp(join(tmpdir(), "tf-mcp-owner-"));
		t.after(() => rm(cwd, { recursive: true, force: true }));
		let pid = process.pid;
		if (owner !== "alive") {
			const child = spawnSync(process.execPath, ["-e", ""], { timeout: 5_000 });
			assert.equal(child.status, 0);
			pid = child.pid;
			assert.equal(probeProcess(pid), "dead", "test child must be confirmed exited");
		}
		const now = Date.now();
		const parent: RunState = {
			runId: "owner-parent", flowName: "owner-flow",
			def: { name: "owner-flow", phases: [{ id: "review", type: "approval", task: "Review?", final: true }] },
			args: {}, status: "running", phases: { review: { id: "review", status: "running" } },
			createdAt: now, updatedAt: now, cwd, invocationRootSnapshot: directoryIdentity(cwd),
			foregroundOwner: { version: 1, pid, instanceId: "original-pi-host", startedAt: now,
				...(owner !== "dead-inflight" ? { approvalWait: ["review"] } : {}) },
		};
		saveRun(parent);
		const parentPath = join(runsDir(cwd), parent.flowName, `${parent.runId}.json`);
		const original = await readFile(parentPath, "utf8");
		const runner: SubagentRunner<AgentConfig> = { runTask: async () => { throw new Error("approval recovery must not spawn an agent"); } };
		const result = await makeToolHandlers(cwd, runner).taskflow_resume!({ runId: parent.runId }) as {
			isError?: boolean; content: Array<{ text: string }>;
		};
		assert.equal(result.isError, true, "headless approval must still reject");
		const runs = listRuns(cwd);
		const fork = runs.find((run) => run.parentRunId === parent.runId);
		if (owner === "dead-approval") {
			assert.ok(fork, result.content[0]?.text);
			assert.equal(fork.status, "blocked");
			assert.equal(fork.foregroundInterruption?.ownerInstanceId, "original-pi-host");
			assert.equal(fork.foregroundOwner?.pid, process.pid);
			assert.notEqual(fork.foregroundOwner?.instanceId, "original-pi-host");
			assert.equal(fork.foregroundOwner?.approvalWait, undefined);
		} else {
			assert.equal(fork, undefined);
			assert.equal(runs.length, 1);
			assert.match(result.content[0]?.text ?? "", owner === "alive" ? /alive or unobservable/ : /quiescent approval/);
		}
		assert.equal(await readFile(parentPath, "utf8"), original, "historical parent must remain byte-identical");
	});
}
