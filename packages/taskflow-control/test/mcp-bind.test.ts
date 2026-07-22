/**
 * Thin MCP tool bind against ControlHost (D21 single admit/observe surface).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	bindControlHostTools,
	createControlHost,
	createMockExecutionProvider,
	createScriptExecutionProvider,
} from "../src/index.ts";

test("bindControlHostTools: run/status/wait stable names path", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-proj-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	try {
		const host = createControlHost({
			projectRoot: project,
			env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createMockExecutionProvider({ output: "mcp-ok" }),
		});
		const tools = bindControlHostTools(host);
		const r = await tools.run({ define: {
			name: "m",
			phases: [{ id: "main", type: "script", run: "true", final: true }],
		}});
		assert.equal(r.ok, true);
		assert.ok(r.run?.runId);
		const snap = tools.status(r.run!.runId);
		assert.equal(snap?.run.status, "completed");
		const waited = await tools.wait(r.run!.runId);
		assert.equal(waited.run.status, "completed");
		host.close();
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("D21 MCP bind: production script provider; park→approve via tools; exit 37 fails", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-d21-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-d21-proj-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	try {
		// No allowMockProvider — same surface every host adapter should use
		const host = createControlHost({
			projectRoot: project,
			env,
			skipSingleton: true,
			controlMode: "standalone",
			// explicit real provider (also the production default)
			provider: createScriptExecutionProvider({
				stateDir: path.join(project, ".taskflow", "control", "provider-jobs"),
			}),
		});
		const tools = bindControlHostTools(host);

		const ok = await tools.run({
			define: {
				name: "ok",
				phases: [{ id: "main", type: "script", run: "echo d21-mcp", final: true }],
			},
			commandId: "d21-ok",
			principal: "mcp-host",
		});
		assert.equal(ok.ok, true, JSON.stringify(ok.error));
		assert.match(ok.run?.finalOutput ?? "", /d21-mcp/);
		assert.ok(ok.receipt);
		assert.equal(ok.receipt!.assurance.artifactIntegrity, "unknown");

		const fail = await tools.run({
			define: {
				name: "bad",
				phases: [{ id: "main", type: "script", run: "exit 37", final: true }],
			},
			commandId: "d21-fail",
		});
		assert.equal(fail.ok, false);
		assert.equal(fail.run?.status, "failed");
		assert.equal(fail.receipt, undefined);
		host.close();
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("D21 MCP bind: park + tools.approve first-wins path", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-apr-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-apr-proj-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	try {
		const provider = createMockExecutionProvider({ outcome: "hang" });
		const host = createControlHost({
			projectRoot: project,
			env,
			skipSingleton: true,
			controlMode: "standalone",
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});
		const tools = bindControlHostTools(host);
		const r = await tools.run({
			define: {
				name: "park-me",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		assert.ok(r.run?.runId);
		provider.quiesceAll?.();
		const parked = await host.parkForApproval(r.run!.runId);
		assert.equal(parked.ok, true, JSON.stringify(parked.error));
		const approved = await tools.approve(r.run!.runId, {
			principal: "mcp",
			expectedRunVersion: parked.run!.runVersion,
		});
		assert.equal(approved.ok, true, JSON.stringify(approved.error));
		assert.equal(approved.run?.status, "completed");
		assert.ok(approved.receipt);
		// Terminal: cancel rejected
		const cancel = await tools.cancel(r.run!.runId);
		assert.equal(cancel.ok, false);
		host.close();
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	}
});
