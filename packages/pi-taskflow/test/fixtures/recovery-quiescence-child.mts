import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { runsDir } from "../../../taskflow-core/src/store.ts";
import registerTaskflow from "../../src/index.ts";

const [cwd, scenario, nonce] = process.argv.slice(2);
if (!cwd || !nonce || !["parallel", "linear", "timeout"].includes(scenario!)) throw new Error("invalid owned fixture arguments");
let tool: ToolDefinition | undefined;
registerTaskflow({ on() {}, registerCommand() {}, registerTool(value: ToolDefinition) { if (value.name === "taskflow") tool = value; } } as unknown as ExtensionAPI);
if (!tool) throw new Error("taskflow tool not registered");
let failures = 0;
const originalRename = fs.renameSync;
fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
	if (scenario !== "linear" && String(to).startsWith(runsDir(cwd)) && String(to).endsWith(".json")) {
		const state = JSON.parse(fs.readFileSync(from, "utf8"));
		if (state.phases?.effectC?.status === "running" || (scenario === "timeout" && state.phases?.approvalA?.status === "done")) {
			failures++;
			throw Object.assign(new Error("injected checkpoint rename failure"), { code: "EACCES" });
		}
	}
	return originalRename(from, to);
}) as typeof fs.renameSync;
syncBuiltinESMExports();

const flowName = "quiescence-fixture";
const effect = `const fs = require('node:fs');
const nonce = ${JSON.stringify(nonce)};
fs.writeFileSync('child-owner.json', JSON.stringify({pid:process.pid,nonce}));
fs.writeFileSync('child-active', 'active');
setInterval(() => {
  try {
    const stop = JSON.parse(fs.readFileSync('child-stop.json', 'utf8'));
    if (stop.nonce === nonce && stop.pid === process.pid) {
      fs.writeFileSync('child-stopped', nonce);
      process.exit(0);
    }
  } catch {}
}, 15);
setTimeout(() => process.exit(0), 15000);`;
const phases = scenario === "parallel" ? [
	{ id: "approvalA", type: "approval", task: "Hold approval" },
	{ id: "quickB", type: "script", run: [process.execPath, "-e", "setTimeout(() => process.stdout.write('ready'), 400)"] },
	{ id: "effectC", type: "script", run: [process.execPath, "-e", effect], final: true },
] : [
	{ id: "upstream", type: "script", run: [process.execPath, "-e", "require('node:fs').writeFileSync('upstream-done', 'once'); process.stdout.write('reusable')"] },
	{ id: "approvalA", type: "approval", task: "Hold approval", dependsOn: ["upstream"], ...(scenario === "timeout" ? { timeoutMs: 1000, onExpire: "approve" } : {}) },
	{ id: "effectC", type: "script", run: [process.execPath, "-e", scenario === "timeout" ? effect : "require('node:fs').writeFileSync('downstream-ran', 'unsafe')"], dependsOn: ["approvalA"], final: true },
];
const args = validateToolArguments(tool, { type: "toolCall", id: "fixture", name: "taskflow", arguments: { define: { name: flowName, concurrency: 2, phases } } });
const timer = setInterval(() => {
	const flowDir = path.join(runsDir(cwd), flowName);
	if (!fs.existsSync(flowDir)) return;
	const file = fs.readdirSync(flowDir).find((name) => name.endsWith(".json"));
	if (!file) return;
	const saved = JSON.parse(fs.readFileSync(path.join(flowDir, file), "utf8"));
	if (scenario !== "linear" ? !fs.existsSync(path.join(cwd, "child-active")) : !saved.foregroundOwner?.approvalWait) return;
	clearInterval(timer);
	console.log(JSON.stringify({ ready: true, runId: saved.runId, failures, nonce, filePath: path.join(flowDir, file) }));
}, 15);
await tool.execute("fixture", args, undefined, undefined, {
	mode: "rpc", hasUI: true, cwd, ui: { select: async () => new Promise(() => {}) },
} as never);
