/**
 * E2E: a pi user can reach the taskflow LIBRARY through the real
 * pi-taskflow extension — without spawning a full pi session and without
 * spending model tokens.
 *
 * Loads the real packages/pi-taskflow/src/index.ts default export with a
 * minimal headless ExtensionAPI mock, then drives the registered taskflow
 * tool's execute() method for the library branches:
 *
 *   action=save (with purpose+tags) → action=search (CJK paraphrase)
 *   → action=show → action=list → verify sidecar on disk
 *
 * This tests the PI ADAPTER path (index.ts registerTool/execute), not just
 * the host-neutral MCP server path that codex uses. No mocks of library code:
 * the same saveFlowWithMeta / searchLibrary / readMeta functions run against a
 * real temp project directory.
 *
 * Run: node --conditions=development --experimental-strip-types test/e2e-library.mts
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");

// Load the actual pi extension under dev conditions so imports resolve to src.
const extModule = await import("../src/index.ts");
const extension = extModule.default;

// Isolated temp project.
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-pi-lib-e2e-"));
fs.mkdirSync(path.join(cwd, ".pi", "taskflows"), { recursive: true });

// Capture the registered tool so we can call execute directly.
let registeredTool: any = null;
const capturedCommands = new Map<string, any>();

const mockPi = {
	registerTool: (tool: any) => {
		registeredTool = tool;
	},
	registerCommand: (name: string, def: any) => {
		capturedCommands.set(name, def);
	},
	on: (_event: string, _handler: any) => {},
	sendUserMessage: (_text: string) => {},
};

// Must NOT set PI_TASKFLOW_CTX_DIR/PI_TASKFLOW_NODE_ID, or the extension
// registers ctx_* tools instead of the host taskflow tool.
assert.equal(process.env.PI_TASKFLOW_CTX_DIR, undefined);
assert.equal(process.env.PI_TASKFLOW_NODE_ID, undefined);

// Load the extension.
extension(mockPi as any);
assert.ok(registeredTool, "extension should register a taskflow tool");
assert.equal(registeredTool.name, "taskflow");

const mockCtx = {
	cwd,
	hasUI: false,
	ui: {
		notify: (_text: string, _kind?: string) => {},
		input: async () => "",
		custom: async () => ({} as any),
	},
	modelRegistry: {
		find: () => undefined,
		getAvailable: () => [],
	},
};

const FLOW = {
	name: "audit-endpoints",
	args: { dir: { default: "src/routes" } },
	phases: [
		{ id: "d", type: "agent", agent: "executor", task: "List endpoints under {args.dir}.", output: "json" },
		{ id: "m", type: "map", over: "{steps.d.json}", as: "item", agent: "executor", task: "Audit {item}.", dependsOn: ["d"] },
		{ id: "r", type: "reduce", from: ["m"], agent: "executor", task: "Report:\n{steps.m.output}", dependsOn: ["m"], final: true },
	],
};

const execute = async (params: any) => {
	const res = await registeredTool.execute("id", params, new AbortController().signal, () => {}, mockCtx as any);
	assert.ok(res?.content?.[0]?.type === "text", `expected text content, got: ${JSON.stringify(res)}`);
	const text = res.content[0].text as string;
	if (text.startsWith("Error:")) throw new Error(`tool returned error: ${text}`);
	return text;
};

console.log("▶ loading pi-taskflow extension and driving library actions …\n");

// 1. save
const saveText = await execute({
	action: "save",
	define: FLOW,
	purpose: "审计一组 API endpoint 是否缺少鉴权检查",
	tags: ["audit", "security", "auth", "fan-out"],
});
assert.match(saveText, /Saved taskflow 'audit-endpoints'/);
assert.match(saveText, /Run it with \/tf:audit-endpoints/);
console.log("✓ action=save → wrote flow + sidecar (shortcut command registered)");

// 2. search (CJK paraphrase)
const searchText = await execute({
	action: "search",
	query: "检查接口安全性 鉴权 缺失",
});
assert.match(searchText, /structural mode/);
assert.ok(searchText.includes("audit-endpoints"), `search should surface audit-endpoints:\n${searchText}`);
console.log("✓ action=search (CJK paraphrase) → found audit-endpoints");
console.log("   " + searchText.split("\n").filter((l) => l.includes("audit-endpoints") || l.includes("why:") || l.includes("→")).slice(0, 3).join("\n   "));

// 3. /tf show command (pi exposes show as a user command, not a tool action)
let showNotifiedText = "";
const tfCommand = capturedCommands.get("tf");
assert.ok(tfCommand, "tf command should be registered");
await tfCommand.handler("show audit-endpoints", {
	cwd,
	isIdle: () => true,
	ui: {
		notify: (text: string, _kind?: string) => {
			showNotifiedText = text;
		},
		input: async () => "",
		custom: async () => ({} as any),
	},
} as any);
const showObj = JSON.parse(showNotifiedText);
assert.ok(showObj.definition && showObj.library, "show should return {definition, library}");
assert.equal(showObj.library.purpose, "审计一组 API endpoint 是否缺少鉴权检查");
assert.equal(showObj.library.reuseCount, 0);
console.log("✓ /tf show → returned {definition, library{purpose,generality,reuseCount,…}}");

// 4. list
const listText = await execute({ action: "list" });
assert.match(listText, /audit-endpoints.*审计.*g=.*used 0×/);
console.log("✓ action=list → audit-endpoints shows purpose · g= · used ×");

// 5. Verify the sidecar file actually exists on disk.
const sidecar = path.join(cwd, ".pi", "taskflows", "audit-endpoints.meta.json");
assert.ok(fs.existsSync(sidecar), "sidecar .meta.json should exist on disk");
const sidecarObj = JSON.parse(fs.readFileSync(sidecar, "utf-8"));
assert.equal(sidecarObj.purpose, "审计一组 API endpoint 是否缺少鉴权检查");
assert.equal(sidecarObj.phaseSignature, "agent→map→reduce");
assert.equal(sidecarObj.reuseCount, 0);
console.log("✓ sidecar persisted to disk:", path.relative(cwd, sidecar));

// 6. save also registered a shortcut command — assert it works.
const shortcut = capturedCommands.get("tf:audit-endpoints");
assert.ok(shortcut, "save should register tf:<name> shortcut command");
await shortcut.handler("", {
	isIdle: () => true,
	ui: { notify: () => {} },
} as any);
console.log("✓ action=save registered tf:audit-endpoints shortcut command");

fs.rmSync(cwd, { recursive: true, force: true });

console.log("\n✅ PI E2E PASS — the reuse flywheel works end-to-end through the real pi extension.");
console.log("   (save with purpose+tags → CJK-paraphrase search finds it → show/list expose metadata → sidecar on disk)");
process.exit(0);
