/** Real installed Pi CLI + built extension + spawned children. Only model responses are local fixtures. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runAgentTask, defaultResolveInstalledPiCli } from "../dist/runner.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-pi-compat-"));
const cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
const provider = fileURLToPath(new URL("fixtures/compat-provider.mjs", import.meta.url));
const extension = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const sdkVersion = JSON.parse(fs.readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8")).version as string;
const modern = Number(sdkVersion.split(".")[0]) >= 1;
console.log(`Actual Pi SDK/CLI: ${sdkVersion}`);
const cli = defaultResolveInstalledPiCli();
assert.ok(cli, "resolve the adapter-local Pi CLI");
assert.equal(execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim(), sdkVersion);
const env = { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, TASKFLOW_AGENT_DIR: agentDir, TASKFLOW_COMPAT_FIXTURE: randomUUID() };
delete env.PI_TASKFLOW_PI_BIN; delete env.PI_TASKFLOW_PI_ENTRY; delete env.PI_TASKFLOW_BUILTIN_AGENTS_DIR;
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
	defaultProvider: "taskflow-compat", defaultModel: "fixture", modelRoles: { executor: "taskflow-compat/fixture" },
	retry: { enabled: true, maxRetries: 2, baseDelayMs: 20 },
	taskflow: { piChild: { resourceProfile: "allowlist", extensions: [provider], terminalGraceMs: 200 } },
}));
// Dynamic protocol assertions intentionally inspect arbitrary JSON event payloads.
type Event = { type: string; [key: string]: any };
const baseArgs = ["--offline", "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions", "-e", provider, "-e", extension, "--model", "taskflow-compat/fixture"];
let passed = 0;
function pass(name: string) { passed++; console.log(`PASS ${name}`); }

async function cliRun(prompt: string, rpcDecision?: string) {
	return await new Promise<{ events: Event[]; code: number | null; stderr: string }>((resolve, reject) => {
		const rpc = rpcDecision !== undefined;
		const args = [...baseArgs, "--mode", rpc ? "rpc" : "json", ...(rpc ? [] : ["-p", prompt])];
		const child = spawn(process.execPath, [cli!, ...args], { cwd, env, stdio: [rpc ? "pipe" : "ignore", "pipe", "pipe"] });
		const events: Event[] = []; let pending = "", stderr = "", settled = false;
		let failure: Error | undefined, forcedKill: ReturnType<typeof setTimeout> | undefined;
		const stop = (error?: Error) => {
			failure ??= error;
			if (forcedKill) return;
			// Allow the Pi supervisor to terminate its detached Taskflow children.
			child.kill("SIGTERM");
			forcedKill = setTimeout(() => child.kill("SIGKILL"), 5000);
		};
		const timer = setTimeout(() => stop(new Error(`Pi timed out: ${prompt} ${rpcDecision}\n${stderr}`)), 30000);
		child.stderr!.on("data", (data) => { stderr += String(data); });
		child.stdout!.on("data", (data) => {
			pending += String(data); const lines = pending.split("\n"); pending = lines.pop()!;
			for (const line of lines) {
				if (!line.trim()) continue;
				let event: Event; try { event = JSON.parse(line); } catch { stop(new Error(`Non-JSON Pi output: ${line}`)); return; }
				events.push(event);
				if (rpc && event.type === "extension_ui_request" && ["select", "input", "confirm"].includes(event.method)) {
					if (rpcDecision === "abort") child.stdin!.write(JSON.stringify({ id: "abort", type: "abort" }) + "\n");
					else {
						const cancelled = rpcDecision === "cancel" || (rpcDecision === "edit-cancel" && event.method === "input");
						const wanted = rpcDecision!.startsWith("edit") ? "edit" : rpcDecision!;
						const value = event.method === "input" ? "Reviewed guidance" : (event.options as string[] | undefined)?.find((s) => s.toLowerCase().startsWith(wanted)) ?? wanted;
						child.stdin!.write(JSON.stringify({ type: "extension_ui_response", id: event.id, ...(cancelled ? { cancelled: true } : event.method === "confirm" ? { confirmed: wanted === "approve" } : { value }) }) + "\n");
					}
				}
				if (rpc && (event.type === "agent_settled" || (!modern && event.type === "agent_end" && event.willRetry === false)) && !settled) { settled = true; child.stdin!.end(); stop(); }
			}
		});
		child.on("error", (error) => { failure = error; });
		child.on("close", (code) => { clearTimeout(timer); clearTimeout(forcedKill); if (failure) reject(failure); else resolve({ events, code, stderr }); });
		if (rpc) child.stdin!.write(JSON.stringify({ id: "prompt", type: "prompt", message: prompt }) + "\n");
	});
}
function taskflowResult(events: Event[]) {
	const event = events.find((e) => e.type === "tool_execution_end" && e.toolName === "taskflow");
	assert.ok(event, "Taskflow tool must actually execute"); return event;
}

const savedEnv = new Map<string, string | undefined>();
try {
	for (const key of ["PI_OFFLINE", "PI_CODING_AGENT_DIR", "TASKFLOW_AGENT_DIR", "TASKFLOW_COMPAT_FIXTURE", "PI_TASKFLOW_PI_BIN", "PI_TASKFLOW_PI_ENTRY", "PI_TASKFLOW_BUILTIN_AGENTS_DIR"]) {
		savedEnv.set(key, process.env[key]); if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
	}
	const version = await cliRun("HOST:version");
	assert.equal(version.code, 0, version.stderr);
	assert.equal(taskflowResult(version.events).isError, false);
	pass("built extension loads and executes taskflow");
	const identity = await cliRun("HOST:identity");
	const identityResult = taskflowResult(identity.events).result;
	assert.equal(identityResult.details.state.status, "completed", JSON.stringify(identityResult));
	assert.equal(identityResult.details.state.phases.child.output, identityResult.details.state.runId);
	pass("persisted Taskflow run ID reaches actual Pi JSON child");
	const agents = [{ name: "fixture", description: "local fixture", systemPrompt: "", source: "user" as const, filePath: "", model: "taskflow-compat/fixture" }];
	const profile = { resourceProfile: "allowlist" as const, extensions: [provider], terminalGraceMs: 200 };
	if (modern) {
		fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
			compat: { command: process.execPath, args: [fileURLToPath(new URL("fixtures/compat-mcp.mjs", import.meta.url))], exposure: "codemode" },
		} }));
		const mcpProfile = { ...profile, extensions: [...profile.extensions,
			fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/index.js", import.meta.url)),
			fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/index.js", import.meta.url)),
		] };
		const mcp = await runAgentTask(cwd, agents, "fixture", "CHILD_MCP", { signal: AbortSignal.timeout(20000) }, undefined, mcpProfile);
		assert.equal(mcp.exitCode, 0, JSON.stringify(mcp));
		assert.match(mcp.output, /MCP_OK/, "Positive control: real MCP tool must be callable through codemode");
		const denied = await runAgentTask(cwd, agents, "fixture", "CHILD_MCP", { tools: ["codemode"], signal: AbortSignal.timeout(20000) }, undefined, mcpProfile);
		assert.equal(denied.exitCode, 0, JSON.stringify(denied));
		assert.doesNotMatch(denied.output, /MCP_OK/, "Whitelisted codemode must not gain unlisted MCP tools");
		const allowed = await runAgentTask(cwd, agents, "fixture", "CHILD_MCP", {
			tools: ["codemode", "mcp__compat__*"], signal: AbortSignal.timeout(20000),
		}, undefined, mcpProfile);
		assert.equal(allowed.exitCode, 0, JSON.stringify(allowed));
		assert.match(allowed.output, /MCP_OK/, "Explicit MCP wildcard remains usable");
		pass("MCP positive control and codemode whitelist boundary");
		const filtered = await runAgentTask(cwd, agents, "fixture", "TOOL_NAMES", { tools: ["read"], signal: AbortSignal.timeout(20000) }, undefined, mcpProfile);
		assert.equal(filtered.exitCode, 0, JSON.stringify(filtered));
		assert.deepEqual(JSON.parse(filtered.output), ["read"], "Taskflow's explicit whitelist must not retain ambient MCP tools");
		pass("read whitelist excludes ambient MCP tools");
	}
	for (const decision of ["approve", "reject", "cancel", "edit", "edit-cancel", "abort"]) {
		const result = await cliRun("HOST:approval", decision);
		assert.ok(result.events.some((e) => e.type === "extension_ui_request" && ["select", "confirm"].includes(e.method)), "RPC must ask the human");
		const tool = taskflowResult(result.events);
		const state = tool.result.details.state;
		assert.ok(state, JSON.stringify(tool.result));
		const mayProceed = decision === "approve" || decision === "edit";
		assert.equal(state.phases.after?.status === "done", mayProceed, JSON.stringify(tool.result));
		if (mayProceed) {
			assert.equal(state.status, "completed");
			assert.equal(state.phases.review.approval.decision, decision);
			assert.ok(JSON.stringify(tool.result).includes("AFTER_APPROVAL"));
			if (decision === "edit") assert.equal(state.phases.review.output, "Reviewed guidance");
		} else {
			assert.ok(["blocked", "paused"].includes(state.status), JSON.stringify(state));
			assert.equal(state.phases.review.approval?.decision, "reject", JSON.stringify(state));
		}
		pass(`RPC approval ${decision}`);
	}
	const shared = await runAgentTask(cwd, agents, "fixture", "TOOL_NAMES", {
		tools: ["read"], ctxDir: root, nodeId: "compat", signal: AbortSignal.timeout(20000),
	}, undefined, profile);
	assert.equal(shared.exitCode, 0, JSON.stringify(shared));
	assert.deepEqual(JSON.parse(shared.output), ["ctx_read", "ctx_report", "ctx_spawn", "ctx_write", "read"]);
	pass("shared context extension loads and preserves ctx tool whitelist");
	for (const task of ["CHILD_RETRY", "CHILD_IDENTITY"]) {
		const result = await runAgentTask(cwd, agents, "fixture", task, { signal: AbortSignal.timeout(20000), runId: "compat-owned-run" }, undefined, profile);
		assert.equal(result.exitCode, 0, JSON.stringify(result));
		assert.equal(result.errorMessage, undefined, JSON.stringify(result));
		assert.equal(result.output, task === "CHILD_IDENTITY" ? "compat-owned-run" : "CHILD_OK");
		pass(task);
	}
	const printApproval = await cliRun("HOST:approval");
	const printResult = taskflowResult(printApproval.events);
	assert.ok(printResult.result.details.state);
	assert.equal(printResult.result.details.state.phases.review.approval.decision, "reject");
	assert.notEqual(printResult.result.details.state.phases.after?.status, "done"); pass("print approval does not execute downstream");
	console.log(`Pi compatibility real-process E2E: ${passed} passed; no live provider calls.`);
} finally {
	for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	fs.rmSync(root, { recursive: true, force: true });
}
