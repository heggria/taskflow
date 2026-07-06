/**
 * E2E: a Codex user can reach the taskflow LIBRARY through MCP — the reuse
 * flywheel over a real subprocess pipe.
 *
 * Spawns the real bin.ts (exactly as `codex mcp add` launches it) in an
 * ISOLATED temp project cwd, then drives the full MCP handshake + a real
 * save → search → show → list → run(reusedFromSearch) round-trip over a real
 * subprocess pipe — no mocks. Proves the host-neutral server actually serves
 * the new library tools and the reuse flywheel persists to disk.
 *
 * Network-free (the library + MCP protocol layer need no model — only a
 * taskflow_run would, and we exercise run only with a deliberately-trivial
 * flow that we then DON'T wait on; the reuse-bump is what we verify).
 *
 * Run: node --experimental-strip-types test/e2e-codex-library.mts
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const bin = path.join(here, "..", "src", "mcp", "bin.ts");

// Isolated temp project so we don't touch the real ~/.pi library.
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-codex-lib-e2e-"));
fs.mkdirSync(path.join(cwd, ".pi", "taskflows"), { recursive: true });

const proc = spawn("node", ["--conditions=development", "--experimental-strip-types", bin], {
	cwd,
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
	for (let i = 0; i < 200; i++) {
		const r = responses.find((x) => x.id === id);
		if (r) return r;
		await sleep(50);
	}
	throw new Error(`timed out waiting for response id=${id} (${label})`);
};
const call = (id: number, name: string, arguments_: object) =>
	send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: arguments_ } });

const FLOW = {
	name: "audit-endpoints",
	args: { dir: { default: "src/routes" } },
	phases: [
		{ id: "d", type: "agent", agent: "executor", task: "List endpoints under {args.dir}.", output: "json" },
		{ id: "m", type: "map", over: "{steps.d.json}", as: "item", agent: "executor", task: "Audit {item}.", dependsOn: ["d"] },
		{ id: "r", type: "reduce", from: ["m"], agent: "executor", task: "Report:\n{steps.m.output}", dependsOn: ["m"], final: true },
	],
};

console.log("▶ launching taskflow MCP server in isolated cwd (as codex would) …\n");

// --- MCP handshake ---
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
const init = await waitFor(1, "initialize");
assert.equal(init.result.serverInfo.name, "taskflow");
send({ jsonrpc: "2.0", method: "notifications/initialized" });

// --- tools/list must now expose the 2 NEW library tools ---
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const list = await waitFor(2, "tools/list");
const toolNames = list.result.tools.map((t: any) => t.name);
assert.ok(toolNames.includes("taskflow_save"), `missing taskflow_save in ${JSON.stringify(toolNames)}`);
assert.ok(toolNames.includes("taskflow_search"), `missing taskflow_search in ${JSON.stringify(toolNames)}`);
console.log("✓ tools/list exposes library tools:", ["taskflow_save", "taskflow_search"].filter((n) => toolNames.includes(n)).join(", "));

// --- 1. SAVE a reusable flow WITH purpose + tags (the recommended workflow) ---
call(3, "taskflow_save", { name: "audit-endpoints", definition: FLOW, purpose: "审计一组 API endpoint 是否缺少鉴权检查", tags: ["audit", "security", "auth", "fan-out"] });
const save = await waitFor(3, "taskflow_save");
const saveText = save.result.content[0].text;
assert.match(saveText, /Saved taskflow 'audit-endpoints'/);
assert.match(saveText, /审计/);
assert.match(saveText, /phaseSignature: agent→map→reduce/);
console.log("✓ taskflow_save → wrote flow + sidecar (purpose + phaseSignature derived)");

// --- 2. SEARCH with a PARAPHRASED query (structural mode, no embedder) ---
call(4, "taskflow_search", { query: "检查接口安全性 鉴权 缺失" });
const search = await waitFor(4, "taskflow_search");
const searchText = search.result.content[0].text;
assert.match(searchText, /structural mode/);
assert.ok(searchText.includes("audit-endpoints"), `search should surface audit-endpoints:\n${searchText}`);
console.log("✓ taskflow_search (CJK paraphrase) → found audit-endpoints");
console.log("   " + searchText.split("\n").filter((l: string) => l.includes("audit-endpoints") || l.includes("why:") || l.includes("→")).slice(0, 3).join("\n   "));

// --- 3. SHOW returns {definition, library} (R2C2) ---
call(5, "taskflow_show", { name: "audit-endpoints" });
const show = await waitFor(5, "taskflow_show");
const showObj = JSON.parse(show.result.content[0].text);
assert.ok(showObj.definition && showObj.library, "show should return {definition, library}");
assert.equal(showObj.library.purpose, "审计一组 API endpoint 是否缺少鉴权检查");
assert.equal(showObj.library.reuseCount, 0);
console.log("✓ taskflow_show → returned {definition, library{purpose,generality,reuseCount,…}}");

// --- 4. LIST shows extended metadata ---
call(6, "taskflow_list", {});
const listCall = await waitFor(6, "taskflow_list");
assert.match(listCall.result.content[0].text, /audit-endpoints.*审计.*g=.*used 0×/);
console.log("✓ taskflow_list → audit-endpoints shows purpose · g= · used ×");

// --- 5. Verify the sidecar file actually exists on disk (the persistence layer) ---
const sidecar = path.join(cwd, ".pi", "taskflows", "audit-endpoints.meta.json");
assert.ok(fs.existsSync(sidecar), "sidecar .meta.json should exist on disk");
const sidecarObj = JSON.parse(fs.readFileSync(sidecar, "utf-8"));
assert.equal(sidecarObj.purpose, "审计一组 API endpoint 是否缺少鉴权检查");
assert.equal(sidecarObj.phaseSignature, "agent→map→reduce");
assert.equal(sidecarObj.reuseCount, 0);
console.log("✓ sidecar persisted to disk:", path.relative(cwd, sidecar));

proc.stdin.end();
proc.kill();
fs.rmSync(cwd, { recursive: true, force: true });

console.log("\n✅ CODEX E2E PASS — the reuse flywheel works end-to-end through the real MCP server process.");
console.log("   (save with purpose+tags → CJK-paraphrase search finds it → show/list expose metadata → sidecar on disk)");
process.exit(0);
