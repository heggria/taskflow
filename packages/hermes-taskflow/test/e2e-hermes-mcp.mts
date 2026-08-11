/**
 * E2E: prove a Hermes user can reach taskflow through MCP.
 *
 * Spawns the real bin.ts as a stdio MCP server (exactly as Hermes launches an
 * mcp_servers entry of type stdio) and drives the full MCP handshake + a tool
 * call over a real subprocess pipe — no mocks, no live model.
 *
 * Run: node --conditions=development --experimental-strip-types test/e2e-hermes-mcp.mts
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const bin = path.join(here, "..", "src", "mcp", "bin.ts");

const proc = spawn("node", ["--conditions=development", "--experimental-strip-types", bin], {
	cwd: repo,
	stdio: ["pipe", "pipe", "pipe"],
});

const responses: any[] = [];
let buf = "";
proc.stdout.on("data", (d) => {
	buf += d.toString();
	let i: number;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (line.trim()) responses.push(JSON.parse(line));
	}
});

const errChunks: string[] = [];
proc.stderr.on("data", (d) => errChunks.push(d.toString()));

function send(msg: object) {
	proc.stdin!.write(JSON.stringify(msg) + "\n");
}

function waitFor(id: number, ms = 5000): Promise<any> {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const tick = () => {
			const hit = responses.find((r) => r.id === id);
			if (hit) return resolve(hit);
			if (Date.now() - start > ms) return reject(new Error(`timeout waiting for id=${id}; stderr=${errChunks.join("")}`));
			setTimeout(tick, 20);
		};
		tick();
	});
}

console.log("▶ hermes-taskflow MCP e2e (stdio handshake + verify) …\n");

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
const init = await waitFor(1);
assert.equal(init.result.serverInfo.name, "taskflow-hermes");
console.log("✓ initialize → taskflow-hermes", init.result.serverInfo.version);

send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const list = await waitFor(2);
const names = list.result.tools.map((t: any) => t.name);
assert.ok(names.includes("taskflow_verify"));
assert.ok(names.includes("taskflow_run"));
console.log(`✓ tools/list → ${names.length} tools`);

send({
	jsonrpc: "2.0",
	id: 3,
	method: "tools/call",
	params: {
		name: "taskflow_verify",
		arguments: {
			define: { name: "ping", phases: [{ id: "a", type: "script", run: "true", final: true }] },
		},
	},
});
const verify = await waitFor(3);
assert.equal(verify.result.isError, false);
assert.match(verify.result.content[0].text, /PASS|No issues|✓/i);
console.log("✓ taskflow_verify →", verify.result.content[0].text.split("\n")[0]);

proc.stdin!.end();
await new Promise<void>((resolve) => proc.on("close", () => resolve()));

console.log("\n✅ HERMES MCP E2E PASS");
process.exit(0);
