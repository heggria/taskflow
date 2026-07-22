/**
 * Thin MCP tool bind against ControlHost.
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
