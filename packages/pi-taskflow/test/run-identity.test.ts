import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "taskflow-core";
import { createPiSubagentRunner, runAgentTask } from "../src/runner.ts";

test("Pi run identity: owning run overrides ambient identity and omitted identity preserves direct-call behavior", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-pi-run-id-"));
	const capture = path.join(dir, "capture.json");
	const probe = path.join(dir, "probe.mjs");
	fs.writeFileSync(probe, `#!${process.execPath}\n` +
		`import { writeFileSync } from "node:fs";\n` +
		`writeFileSync(${JSON.stringify(capture)}, JSON.stringify({\n` +
		`  runId: process.env.PI_SUBAGENT_RUN_ID ?? null,\n` +
		`  devloopsRunId: process.env.DEVLOOPS_RUN_ID ?? null,\n` +
		`  ctxDir: process.env.PI_TASKFLOW_CTX_DIR ?? null,\n` +
		`  nodeId: process.env.PI_TASKFLOW_NODE_ID ?? null,\n` +
		`  argv: process.argv.slice(2),\n` +
		`}));\n` +
		`const emit = x => process.stdout.write(JSON.stringify(x) + "\\n");\n` +
		`emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" } });\n` +
		`emit({ type: "agent_end", willRetry: false });\n` +
		`emit({ type: "agent_settled" });\n`, { mode: 0o755 });
	const envKeys = ["PI_TASKFLOW_PI_BIN", "PI_SUBAGENT_RUN_ID", "DEVLOOPS_RUN_ID", "PI_TASKFLOW_CTX_DIR", "PI_TASKFLOW_NODE_ID"];
	const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
	const agents: AgentConfig[] = [{ name: "probe", description: "probe", systemPrompt: "", source: "user", filePath: "" }];
	const readCapture = () => JSON.parse(fs.readFileSync(capture, "utf8")) as {
		runId: string | null; devloopsRunId: string | null; ctxDir: string | null; nodeId: string | null; argv: string[];
	};
	try {
		for (const key of envKeys) delete process.env[key];
		process.env.PI_TASKFLOW_PI_BIN = probe;
		assert.equal((await runAgentTask(dir, agents, "probe", "direct", {})).exitCode, 0);
		assert.equal(readCapture().runId, null, "No identity is fabricated for direct callers");

		assert.equal((await runAgentTask(dir, agents, "probe", "owned", { runId: "taskflow-owned" })).exitCode, 0);
		assert.equal(readCapture().runId, "taskflow-owned");
		assert.equal(process.env.PI_SUBAGENT_RUN_ID, undefined, "Parent environment must not be mutated");
		assert.equal(readCapture().devloopsRunId, null, "No downstream-specific marker is fabricated");
		assert.ok(readCapture().argv.includes("--no-extensions"), "Run identity does not weaken child isolation");

		process.env.PI_SUBAGENT_RUN_ID = "parent-run";
		process.env.DEVLOOPS_RUN_ID = "downstream-owned";
		assert.equal((await runAgentTask(dir, agents, "probe", "inherited", {})).exitCode, 0);
		assert.equal(readCapture().runId, "parent-run", "Omitted identity preserves ambient behavior");

		const result = await createPiSubagentRunner().runTask(dir, agents, "probe", "owned-with-context", {
			runId: "current-taskflow-run", ctxDir: dir, nodeId: "work",
		});
		assert.equal(result.exitCode, 0);
		const child = readCapture();
		assert.equal(child.runId, "current-taskflow-run", "Owning identity replaces stale inherited Pi marker");
		assert.equal(child.devloopsRunId, "downstream-owned", "Dev-loops retains ownership and precedence of its neutral marker");
		assert.equal(child.ctxDir, dir);
		assert.equal(child.nodeId, "work");
		assert.ok(child.argv.includes("--extension"));
		assert.equal(process.env.PI_SUBAGENT_RUN_ID, "parent-run");
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
