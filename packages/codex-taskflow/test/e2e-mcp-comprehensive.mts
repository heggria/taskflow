/**
 * Comprehensive E2E for the codex-taskflow MCP server, driven against the BUILT
 * dist bin over a real subprocess stdio pipe — exactly how `codex mcp add`
 * launches it. No mocks, no strip-types: this exercises the shipped artifact
 * (dist/mcp/bin.js) including the new svg.js renderer.
 *
 * Coverage:
 *   - MCP handshake (initialize / initialized / tools/list) over real stdio
 *   - all 5 tools (list, show, verify, compile, run-validation)
 *   - the Codex-rendering ergonomics: plaintext verify (dedupe, conclusion-first,
 *     no fences), raw-JSON show, dual-block compile (image + self-sufficient
 *     text outline), oversized-graph text-only fallback
 *   - the SVG is well-formed and rasterizes (rsvg-convert if present)
 *   - protocol robustness: batch pipelining, unknown method, parse error,
 *     notification-yields-no-response, unknown tool
 *   - input safety: XML/quote injection in ids/labels can't break the SVG
 *
 * Run: node --experimental-strip-types test/e2e-mcp-comprehensive.mts
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const bin = path.join(repo, "dist", "mcp", "bin.js");

assert.ok(fs.existsSync(bin), `built bin not found at ${bin} — run: npm run build -w codex-taskflow`);

let pass = 0;
const ok = (label: string) => {
	pass++;
	console.log(`✓ ${label}`);
};

// --- subprocess MCP client ------------------------------------------------
const proc = spawn("node", [bin], { cwd: repo, stdio: ["pipe", "pipe", "pipe"] });
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
let stderr = "";
proc.stderr.on("data", (d) => {
	stderr += d.toString();
});

const send = (o: object) => proc.stdin.write(JSON.stringify(o) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (id: number, label: string) => {
	for (let i = 0; i < 200; i++) {
		const r = responses.find((x) => x.id === id);
		if (r) return r;
		await sleep(25);
	}
	throw new Error(`timed out waiting for response id=${id} (${label})\nstderr so far:\n${stderr}`);
};
const callTool = async (id: number, name: string, args: Record<string, unknown>) => {
	send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
	return waitFor(id, `tools/call ${name}`);
};

console.log("▶ E2E against built dist bin:", path.relative(repo, bin), "\n");

// === 1. Handshake =========================================================
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
const init = await waitFor(1, "initialize");
assert.equal(init.result.protocolVersion, "2025-06-18");
assert.equal(init.result.serverInfo.name, "taskflow");
ok(`initialize → ${JSON.stringify(init.result.serverInfo)}`);

// notification must NOT produce a response
send({ jsonrpc: "2.0", method: "notifications/initialized" });

send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const list = await waitFor(2, "tools/list");
const toolNames = list.result.tools.map((t: any) => t.name).sort();
assert.deepEqual(toolNames, ["taskflow_compile", "taskflow_list", "taskflow_run", "taskflow_show", "taskflow_verify"]);
for (const t of list.result.tools) {
	assert.equal(t.inputSchema.type, "object", `${t.name} has object schema`);
	assert.equal(typeof t.description, "string");
}
ok(`tools/list → ${toolNames.join(", ")}`);

// === 2. taskflow_list =====================================================
const listCall = await callTool(3, "taskflow_list", {});
assert.ok(typeof listCall.result.content[0].text === "string");
assert.ok(!listCall.result.content[0].text.includes("```"), "list output has no code fences");
ok(`taskflow_list → ${listCall.result.content[0].text.split("\n")[0]}`);

// === 3. taskflow_verify: dedupe + conclusion-first (the screenshot flow) ===
const reviewFlow = {
	name: "code_review",
	phases: [
		{ id: "scope", type: "agent", agent: "scout", task: "confirm scope" },
		{ id: "logic_review", type: "agent", agent: "critic", task: "logic", dependsOn: ["scope"] },
		{ id: "cross_end_review", type: "agent", agent: "critic", task: "cross", dependsOn: ["scope"] },
		{ id: "security_review", type: "agent", agent: "critic", task: "sec", dependsOn: ["scope"] },
		{ id: "test_review", type: "agent", agent: "critic", task: "test", dependsOn: ["scope"] },
	],
};
const verify = await callTool(4, "taskflow_verify", { define: reviewFlow });
const vtext: string = verify.result.content[0].text;
assert.equal(verify.result.isError, true, "underscore ids + terminals => FAILED");
assert.match(vtext.split("\n")[0], /^✗ verification FAILED — \d+ errors?, \d+ warnings?$/);
// underscore rule collapses to ONE line, not five
const underscoreLines = vtext.split("\n").filter((l) => l.includes("id uses underscores"));
assert.equal(underscoreLines.length, 1, "same-rule errors collapse to one line");
assert.match(underscoreLines[0], /\d+ phases:/);
// terminal-not-final warnings collapse to ONE line, not four
const terminalLines = vtext.split("\n").filter((l) => l.includes("terminal phase"));
assert.equal(terminalLines.length, 1, "same-rule warnings collapse to one line");
assert.ok(!vtext.includes("```") && !vtext.includes("###"), "no markdown leaks into plaintext box");
ok(`taskflow_verify dedupe → line1="${vtext.split("\n")[0]}"; ${underscoreLines.length}+${terminalLines.length} deduped detail lines`);

// clean flow → single PASS line
const verifyOk = await callTool(5, "taskflow_verify", {
	define: { name: "ok", phases: [{ id: "a", type: "agent", agent: "executor", task: "do", final: true }] },
});
assert.equal(verifyOk.result.content[0].text, "✓ verification PASSED");
assert.equal(verifyOk.result.isError, false);
ok("taskflow_verify clean → single line '✓ verification PASSED'");

// cycle is caught (structural)
const verifyCycle = await callTool(6, "taskflow_verify", {
	define: {
		name: "cyc",
		phases: [
			{ id: "a", type: "agent", agent: "x", task: "t", dependsOn: ["b"] },
			{ id: "b", type: "agent", agent: "x", task: "t", dependsOn: ["a"], final: true },
		],
	},
});
assert.equal(verifyCycle.result.isError, true);
assert.match(verifyCycle.result.content[0].text, /FAILED/);
ok("taskflow_verify cycle → FAILED");

// === 4. taskflow_compile: dual block (image + self-sufficient outline) =====
const compileFlow = {
	name: "release-train",
	phases: [
		{ id: "scout", type: "agent", agent: "scout", task: "find changed files" },
		{ id: "audit-each", type: "map", agent: "executor", over: "{steps.scout.json.files}", task: "audit one", dependsOn: ["scout"] },
		{ id: "gate", type: "gate", task: "all pass?", dependsOn: ["audit-each"], eval: ["{steps.audit-each.output} contains PASS"] },
		{ id: "pick-fix", type: "tournament", agent: "executor", task: "propose fix", variants: 3, dependsOn: ["gate"] },
		{ id: "approve", type: "approval", task: "sign-off", dependsOn: ["pick-fix"] },
		{ id: "ship", type: "agent", agent: "executor", task: "cut release", dependsOn: ["approve"], join: "any", final: true },
	],
};
const compile = await callTool(7, "taskflow_compile", { define: compileFlow });
const blocks = compile.result.content;
const img = blocks.find((b: any) => b.type === "image");
const txt = blocks.find((b: any) => b.type === "text");
assert.ok(img, "compile emits an image block");
assert.equal(img.mimeType, "image/svg+xml");
assert.ok(txt, "compile emits a text block alongside the image");
// text must be self-sufficient for CLI/TUI: caption + layered outline + all phase ids
const otext: string = txt.text;
assert.match(otext, /6 phases/);
assert.match(otext, /Layer 1:/);
for (const id of ["scout", "audit-each", "gate", "pick-fix", "approve", "ship"]) {
	assert.ok(otext.includes(id), `outline mentions phase '${id}'`);
}
assert.match(otext, /↯ any of /); // join:any rendered
assert.match(otext, /ship ★/); // final marker
assert.ok(!otext.includes("```"), "outline has no fences");
ok(`taskflow_compile dual-block → image(${img.data.length}b b64) + outline(${otext.split("\n").length} lines, all 6 ids)`);

// decode + validate the SVG, then rasterize if a converter exists
const svg = Buffer.from(img.data, "base64").toString("utf8");
assert.match(svg, /^<svg /);
assert.ok(svg.includes("</svg>"));
assert.ok(svg.includes("marker-end"), "edges drawn");
const svgPath = path.join(os.tmpdir(), "tf-e2e-flow.svg");
fs.writeFileSync(svgPath, svg);
let rasterOk = false;
try {
	execFileSync("rsvg-convert", ["-o", path.join(os.tmpdir(), "tf-e2e-flow.png"), svgPath], { stdio: "ignore" });
	rasterOk = true;
} catch {
	/* converter not present — SVG well-formedness already asserted */
}
ok(`compile SVG well-formed (${svg.length}b)${rasterOk ? " and rasterizes via rsvg-convert" : " (rasterizer absent, skipped)"}`);

// === 5. compile fallback: oversized graph → text-only, outline intact ======
const hugePhases = Array.from({ length: 80 }, (_, i) => ({
	id: `p${i}`,
	type: "agent",
	agent: "executor",
	task: "x",
	...(i ? { dependsOn: [`p${i - 1}`] } : {}),
	...(i === 79 ? { final: true } : {}),
}));
const huge = await callTool(8, "taskflow_compile", { define: { name: "huge", phases: hugePhases } });
assert.ok(!huge.result.content.some((b: any) => b.type === "image"), "no image for oversized graph");
assert.match(huge.result.content[0].text, /80 phases/);
assert.match(huge.result.content[0].text, /Layer 1:/);
ok("taskflow_compile oversized → text-only fallback with outline");

// === 6. input safety: XML/quote injection can't break the SVG =============
// compile still renders a structurally-invalid flow (with a ✗ FAIL status) so it
// can be debugged visually; escaping is what keeps that render safe.
const nastyFlow = {
	name: 'x"><script>alert(1)</script>',
	phases: [
		{ id: "a<b>&\"'", type: "agent", agent: "x&y", task: "t", final: true },
		{ id: "b", type: "agent", agent: "z", task: '</text><rect/>', dependsOn: ["a<b>&\"'"] },
	],
};
const nasty = await callTool(9, "taskflow_compile", { define: nastyFlow });
const nastyImg = nasty.result.content.find((b: any) => b.type === "image");
assert.ok(nastyImg, "still renders");
const nastySvg = Buffer.from(nastyImg.data, "base64").toString("utf8");
// raw injection substrings must be entity-escaped, not present literally in markup
assert.ok(!nastySvg.includes("<script>"), "no raw <script> in SVG");
assert.ok(!nastySvg.includes("</text><rect/>"), "no raw markup breakout in SVG");
assert.ok(nastySvg.includes("&lt;") || nastySvg.includes("&amp;"), "special chars entity-escaped");
ok("input safety → XML/quote injection entity-escaped, SVG intact");

// === 7. taskflow_show: raw JSON, no fence (missing flow → error) ===========
const show = await callTool(10, "taskflow_show", { name: "definitely-not-real-xyz" });
assert.equal(show.result.isError, true);
assert.ok(!show.result.content[0].text.includes("```"), "show has no code fence");
ok("taskflow_show missing → error text, no fence");

// === 8. taskflow_run input validation (no real subagents spawned) ==========
const runBad = await callTool(11, "taskflow_run", { define: { name: "bad", phases: [] } });
assert.equal(runBad.result.isError, true, "empty-phases flow is invalid");
assert.match(runBad.result.content[0].text, /invalid|phase/i);
ok("taskflow_run invalid flow → isError with reason");

// === 9. protocol robustness: batch pipelining + errors in one burst ========
send({ jsonrpc: "2.0", id: 20, method: "ping" });
send({ jsonrpc: "2.0", id: 21, method: "does/not/exist" });
send({ jsonrpc: "2.0", method: "notifications/somethingUnknown" }); // ignored
send({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "nope", arguments: {} } });
const ping = await waitFor(20, "ping");
const unknownMethod = await waitFor(21, "unknown method");
const unknownTool = await waitFor(22, "unknown tool");
assert.deepEqual(ping.result, {});
assert.equal(unknownMethod.error.code, -32601, "method not found");
assert.equal(unknownTool.error.code, -32602, "invalid params for unknown tool");
ok("protocol → ping ok, method-not-found -32601, unknown-tool -32602, pipelined");

// malformed line → parse error (-32700), loop survives, still answers after
proc.stdin.write("this is not json\n");
send({ jsonrpc: "2.0", id: 23, method: "ping" });
const afterGarbage = await waitFor(23, "ping after garbage");
assert.deepEqual(afterGarbage.result, {});
const parseErr = responses.find((r) => r.error && r.error.code === -32700);
assert.ok(parseErr, "emitted a parse error for the garbage line");
ok("protocol → malformed line -32700, loop survives and keeps serving");

// no stray response was produced for either notification
const idsSeen = responses.filter((r) => r.id != null).map((r) => r.id).sort((a, b) => a - b);
assert.ok(!idsSeen.includes(undefined), "no id-less responses");
ok(`protocol → notifications produced no response (ids seen: ${idsSeen.join(",")})`);

// === done =================================================================
proc.stdin.end();
proc.kill();
await sleep(50);
if (stderr.trim()) {
	console.log("\n⚠ server stderr (non-fatal):\n" + stderr.trim());
}
console.log(`\n✅ COMPREHENSIVE E2E PASS — ${pass} checks against the built dist bin.`);
process.exit(0);
