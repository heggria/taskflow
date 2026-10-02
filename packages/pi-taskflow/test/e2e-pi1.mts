/** Real Pi 1.0 CLI + built extension + spawned children. Only model responses are local fixtures. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runAgentTask, defaultResolveInstalledPiCli } from "../dist/runner.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-pi1-e2e-"));
const cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
const provider = fileURLToPath(new URL("fixtures/pi1-provider.ts", import.meta.url));
const extension = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const cli = defaultResolveInstalledPiCli();
assert.ok(cli, "resolve the adapter-local Pi CLI");
const token = randomUUID();
const waitFile = path.join(root, "provider-waiting");
const env = { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, TASKFLOW_AGENT_DIR: agentDir, TASKFLOW_E2E_TOKEN: token, TASKFLOW_E2E_WAIT_FILE: waitFile };
delete env.PI_TASKFLOW_PI_BIN; delete env.PI_TASKFLOW_PI_ENTRY; delete env.PI_TASKFLOW_BUILTIN_AGENTS_DIR;
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
	defaultProvider: "taskflow-e2e", defaultModel: "fixture", modelRoles: { executor: "taskflow-e2e/fixture" },
	retry: { enabled: true, maxRetries: 2, baseDelayMs: 20 },
	taskflow: { piChild: { resourceProfile: "allowlist", extensions: [provider], terminalGraceMs: 200 } },
}));
type Event = { type: string; [key: string]: any };
const baseArgs = ["--offline", "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions", "-e", provider, "-e", extension, "--model", "taskflow-e2e/fixture"];
let passed = 0;
function pass(name: string) { passed++; console.log(`PASS ${name}`); }

async function cliRun(prompt: string, rpcDecision?: string, codemode = false) {
	return await new Promise<{ events: Event[]; code: number | null; stderr: string }>((resolve, reject) => {
		const rpc = rpcDecision !== undefined;
		const args = [...baseArgs, ...(codemode ? ["-e", "builtin:codemode", "--tools", "taskflow,codemode"] : []), "--mode", rpc ? "rpc" : "json", ...(rpc ? [] : ["-p", prompt])];
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
				if (rpc && event.type === "agent_settled" && !settled) { settled = true; child.stdin!.end(); stop(); }
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
	for (const key of ["PI_OFFLINE", "PI_CODING_AGENT_DIR", "TASKFLOW_AGENT_DIR", "TASKFLOW_E2E_TOKEN", "TASKFLOW_E2E_WAIT_FILE", "PI_TASKFLOW_PI_BIN", "PI_TASKFLOW_PI_ENTRY", "PI_TASKFLOW_BUILTIN_AGENTS_DIR"]) {
		savedEnv.set(key, process.env[key]); if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
	}
	for (const [name, expected] of [["version", "1.0.0"], ["shorthand", "CHILD_OK"], ["dag", "ONE"], ["context", token], ["codemode", "1.0.0"]]) {
		const result = await cliRun(`HOST:${name}`, undefined, name === "codemode");
		assert.equal(result.code, 0, result.stderr); const tool = taskflowResult(result.events);
		assert.equal(tool.isError, false, JSON.stringify(tool.result)); assert.ok(JSON.stringify(tool.result).includes(expected), JSON.stringify(tool.result));
		if (name === "dag") assert.ok(JSON.stringify(tool.result).includes("TWO"));
		pass(`built extension ${name}`);
	}
	const agents = [{ name: "fixture", description: "local fixture", systemPrompt: "", source: "user" as const, filePath: "", model: "taskflow-e2e/fixture" }];
	const profile = { resourceProfile: "allowlist" as const, extensions: [provider], terminalGraceMs: 200 };
	for (const task of ["CHILD_RETRY", "CHILD_FAIL", "CHILD_USAGE", "CHILD_LEAK"]) {
		const result = await runAgentTask(cwd, agents, "fixture", task, { signal: AbortSignal.timeout(20000) }, undefined, profile);
		if (task === "CHILD_FAIL") { assert.notEqual(result.exitCode, 0); assert.match(result.errorMessage ?? "", /429/); }
		else {
			assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.errorMessage, undefined, JSON.stringify(result));
			if (task === "CHILD_USAGE") { assert.equal(result.usage.cost, 0.3); assert.ok(result.usage.input >= 100); assert.ok(result.usage.output >= 200); }
			else assert.equal(result.output, "CHILD_OK");
			if (task === "CHILD_LEAK") assert.equal(result.completionSource, "terminal-reap");
		}
		pass(task);
	}
	const controller = new AbortController();
	let reachedProvider = false;
	const watcher = fs.watch(root, (_event, filename) => {
		if (String(filename) === path.basename(waitFile) && fs.existsSync(waitFile)) { reachedProvider = true; controller.abort(); }
	});
	const cancelDeadline = setTimeout(() => controller.abort(), 15000);
	let aborted;
	try { aborted = await runAgentTask(cwd, agents, "fixture", "CHILD_SLOW", { signal: controller.signal }, undefined, profile); }
	finally { watcher.close(); clearTimeout(cancelDeadline); }
	assert.equal(reachedProvider, true, "Cancellation must occur after the real provider begins waiting");
	assert.notEqual(aborted.exitCode, 0); assert.equal(aborted.stopReason, "aborted");
	assert.match(aborted.errorMessage ?? "", /aborted/i); pass("child cancellation after provider handshake");
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
	const printApproval = await cliRun("HOST:approval");
	const printResult = taskflowResult(printApproval.events);
	assert.ok(printResult.result.details.state);
	assert.equal(printResult.result.details.state.phases.review.approval.decision, "reject");
	assert.notEqual(printResult.result.details.state.phases.after?.status, "done"); pass("print approval does not execute downstream");
	console.log(`Pi 1.0 real-process E2E: ${passed} passed; no live provider calls.`);
} finally {
	for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	fs.rmSync(root, { recursive: true, force: true });
}
