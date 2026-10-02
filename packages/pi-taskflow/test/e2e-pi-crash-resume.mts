/** Built adapter + real Pi CLI: hard kill at approval, then immutable recovery. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultResolveInstalledPiCli } from "../dist/runner.js";

type Event = { type: string; method?: string; id?: string; options?: string[]; toolName?: string; result?: { details?: { state?: { runId: string; status: string; parentRunId?: string; phases: Record<string, { output?: string }> } }; content?: unknown }; isError?: boolean };
const cli = defaultResolveInstalledPiCli();
assert.ok(cli);
const provider = fileURLToPath(new URL("fixtures/pi1-provider.ts", import.meta.url));
const extension = fileURLToPath(new URL("../dist/index.js", import.meta.url));
for (const slow of [false, true]) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crash-resume-"));
	const cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
	const env = { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, TASKFLOW_AGENT_DIR: agentDir, TASKFLOW_E2E_TOKEN: randomUUID(), TASKFLOW_E2E_CRASH_SLOW: slow ? "1" : "0" };
	delete env.PI_TASKFLOW_PI_BIN; delete env.PI_TASKFLOW_PI_ENTRY;
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProvider: "taskflow-e2e", defaultModel: "fixture", modelRoles: { executor: "taskflow-e2e/fixture" },
		taskflow: { piChild: { resourceProfile: "allowlist", extensions: [provider], terminalGraceMs: 200 } },
	}));
	const children: ReturnType<typeof spawn>[] = [];
	const closed = new Set<ReturnType<typeof spawn>>();
	function start(prompt: string, hold = false) {
		const child = spawn(process.execPath, [cli!, "--offline", "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions", "-e", provider, "-e", extension, "--model", "taskflow-e2e/fixture", "--mode", "rpc"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		children.push(child);
		let onApproval!: () => void;
		const approval = new Promise<void>((resolve) => { onApproval = resolve; });
		const events: Event[] = [];
		let buffer = "", stderr = "";
		const done = new Promise<{ events: Event[]; code: number | null; signal: string | null }>((resolve, reject) => {
			const timer = setTimeout(() => { clearTimeout(timer); child.kill("SIGKILL"); reject(new Error(`Pi timeout: ${prompt}\n${stderr}`)); }, 25_000);
			child.stderr!.on("data", (data) => { stderr += String(data); });
			child.stdout!.on("data", (data) => {
				buffer += String(data);
				let index: number;
				while ((index = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
					if (!line.trim()) continue;
					let event: Event;
					try { event = JSON.parse(line); } catch { clearTimeout(timer); child.kill("SIGKILL"); reject(new Error(`non-JSON Pi frame ${line}`)); return; }
					events.push(event);
					if (event.type === "extension_ui_request" && event.method === "select") {
						onApproval();
						if (!hold) child.stdin!.write(JSON.stringify({ type: "extension_ui_response", id: event.id, value: event.options?.find((option) => option === "Approve") }) + "\n");
					}
					if (event.type === "agent_settled") { child.stdin!.end(); child.kill("SIGTERM"); }
				}
			});
			child.once("error", (error) => { clearTimeout(timer); reject(error); });
			child.stdin!.on("error", (error) => { clearTimeout(timer); child.kill("SIGKILL"); reject(error); });
			child.once("close", (code, signal) => { closed.add(child); clearTimeout(timer); resolve({ events, code, signal }); });
		});
		// Observe failures immediately even while the caller waits for approval;
		// the original promise still rejects when awaited by the acceptance flow.
		void done.catch(() => {});
		child.stdin!.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");
		return { child, done, approval };
	}
	function result(events: Event[]) {
		const event = events.find((frame) => frame.type === "tool_execution_end" && frame.toolName === "taskflow");
		assert.ok(event, JSON.stringify(events));
		return event;
	}
	try {
		const seed = start("HOST:crash-seed", true);
		await Promise.race([seed.approval, seed.done.then(() => { throw new Error("seed exited before approval"); })]);
		const runDir = path.join(cwd, ".pi", "taskflows", "runs", "real-crash");
		const parentPath = path.join(runDir, fs.readdirSync(runDir).find((name) => name.endsWith(".json"))!);
		const parentBytes = fs.readFileSync(parentPath, "utf8");
		const parent = JSON.parse(parentBytes);
		assert.equal(parent.phases.once.status, "done");
		assert.equal(parent.phases.second.status, "done");
		assert.equal(parent.foregroundOwner.pid, seed.child.pid);
		assert.deepEqual(parent.foregroundOwner.approvalWait, ["review"]);
		const living = result((await start(`HOST:crash-resume:${parent.runId}`).done).events);
		assert.equal(living.isError, true, "a second Pi must not recover the live owner");
		assert.match(JSON.stringify(living.result), /alive or unobservable/);
		seed.child.kill("SIGKILL");
		assert.equal((await seed.done).signal, "SIGKILL");
		const resumed = result((await start(`HOST:crash-resume:${parent.runId}`).done).events);
		assert.equal(resumed.isError, false, JSON.stringify(resumed));
		const child = resumed.result!.details!.state!;
		assert.equal(child.status, "completed");
		assert.equal(child.parentRunId, parent.runId);
		assert.notEqual(child.runId, parent.runId);
		assert.equal(child.phases.recover.output, child.runId);
		assert.equal(fs.readFileSync(path.join(cwd, "crash-once.txt"), "utf8"), "once");
		assert.equal(fs.readFileSync(path.join(cwd, "crash-second.txt"), "utf8"), "twice");
		assert.equal(fs.readFileSync(parentPath, "utf8"), parentBytes);
		console.log(`PASS ${slow ? "slow" : "rapid"} checkpoint -> live-owner rejection -> SIGKILL -> fresh Pi recovery; completed effects once, child identity current, parent bytes unchanged`);
	} finally {
		await Promise.all(children.filter((child) => !closed.has(child)).map((child) => new Promise<void>((resolve) => {
			child.once("close", () => resolve());
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		})));
		fs.rmSync(root, { recursive: true, force: true });
	}
}
