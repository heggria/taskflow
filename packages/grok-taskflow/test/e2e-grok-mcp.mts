/**
 * Lightweight e2e: spawn the grok-bound MCP server over stdio and exercise
 * initialize + tools/list + taskflow_verify. No live Grok CLI required.
 *
 *   node --conditions=development --experimental-strip-types packages/grok-taskflow/test/e2e-grok-mcp.mts
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "src", "mcp", "bin.ts");

function rpc(child: ReturnType<typeof spawn>, msg: object): Promise<any> {
	return new Promise((resolve, reject) => {
		let buf = "";
		const onData = (d: Buffer) => {
			buf += d.toString();
			const i = buf.indexOf("\n");
			if (i < 0) return;
			child.stdout?.off("data", onData);
			try {
				resolve(JSON.parse(buf.slice(0, i)));
			} catch (e) {
				reject(e);
			}
		};
		child.stdout?.on("data", onData);
		child.stdin?.write(JSON.stringify(msg) + "\n");
	});
}

const child = spawn(
	process.execPath,
	["--conditions=development", "--experimental-strip-types", bin],
	{ stdio: ["pipe", "pipe", "inherit"], cwd: path.join(here, "..", "..", "..") },
);

try {
	const init = await rpc(child, {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: "2025-06-18", capabilities: {} },
	});
	assert.equal(init.result.serverInfo.name, "taskflow-grok");

	const list = await rpc(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
	const names = list.result.tools.map((t: any) => t.name);
	assert.ok(names.includes("taskflow_verify"));

	const verify = await rpc(child, {
		jsonrpc: "2.0",
		id: 3,
		method: "tools/call",
		params: {
			name: "taskflow_verify",
			arguments: {
				define: {
					name: "e2e",
					phases: [{ id: "a", type: "agent", agent: "executor", task: "hi", final: true }],
				},
			},
		},
	});
	assert.match(verify.result.content[0].text, /PASSED/);
	console.log("e2e-grok-mcp: ok");
} finally {
	child.kill();
}
