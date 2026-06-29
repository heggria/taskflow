/**
 * E2E: prove a Codex user can reach pi-taskflow through MCP.
 *
 * Spawns the real bin.ts as a stdio MCP server (exactly as `codex mcp add`
 * launches it) and drives the full MCP handshake + a tool call over a real
 * subprocess pipe — no mocks. This is the automated, network-free half of the
 * proof. The fully-manual half (codex itself invoking the tool) is documented
 * in docs and was verified by hand:
 *
 *   codex mcp add taskflow -- node --experimental-strip-types <pkg>/src/mcp/bin.ts
 *   codex exec --dangerously-bypass-approvals-and-sandbox \
 *     'Call the taskflow_list MCP tool and report what it returns.'
 *   → codex emits mcp_tool_call server:"taskflow" tool:"taskflow_list" and
 *     relays the saved-flow list. (then: codex mcp remove taskflow)
 *
 * Run: node --experimental-strip-types test/e2e-codex-mcp.mts
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const bin = path.join(here, "..", "src", "mcp", "bin.ts");

const proc = spawn("node", ["--experimental-strip-types", bin], {
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
proc.stderr.on("data", (d) => process.stderr.write("[server stderr] " + d.toString()));

const send = (o: object) => proc.stdin.write(JSON.stringify(o) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (id: number, label: string) => {
	for (let i = 0; i < 100; i++) {
		const r = responses.find((x) => x.id === id);
		if (r) return r;
		await sleep(50);
	}
	throw new Error(`timed out waiting for response id=${id} (${label})`);
};

console.log("▶ launching pi-taskflow MCP server (as codex would) …\n");

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
const init = await waitFor(1, "initialize");
assert.equal(init.result.protocolVersion, "2025-06-18");
assert.equal(init.result.serverInfo.name, "pi-taskflow");
console.log("✓ initialize:", JSON.stringify(init.result.serverInfo));

send({ jsonrpc: "2.0", method: "notifications/initialized" });

send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const list = await waitFor(2, "tools/list");
const toolNames = list.result.tools.map((t: any) => t.name);
assert.ok(toolNames.includes("taskflow_list"));
assert.ok(toolNames.includes("taskflow_run"));
console.log("✓ tools/list:", toolNames.join(", "));

send({
	jsonrpc: "2.0",
	id: 3,
	method: "tools/call",
	params: { name: "taskflow_list", arguments: {} },
});
const call = await waitFor(3, "tools/call taskflow_list");
const text = call.result.content[0].text;
assert.ok(typeof text === "string" && text.length > 0);
console.log("✓ tools/call taskflow_list →\n   " + text.split("\n").slice(0, 3).join("\n   "));

send({
	jsonrpc: "2.0",
	id: 4,
	method: "tools/call",
	params: {
		name: "taskflow_verify",
		arguments: {
			define: { name: "e2e", phases: [{ id: "a", type: "agent", agent: "x", task: "do", final: true }] },
		},
	},
});
const verify = await waitFor(4, "tools/call taskflow_verify");
assert.match(verify.result.content[0].text, /verification/);
console.log("✓ tools/call taskflow_verify →", verify.result.content[0].text.split("\n")[0]);

proc.stdin.end();
proc.kill();

console.log("\n✅ E2E PASS — pi-taskflow serves MCP over stdio; codex can discover and call its tools.");
process.exit(0);
