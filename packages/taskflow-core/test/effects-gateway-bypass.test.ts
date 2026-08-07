/** Adversarial runtime coverage for resource-controlled Trusted Effects. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createResolveOnlyWorkspaceSession } from "../src/resources/execution.ts";
import { WriteIntentJournal } from "../src/resources/journal.ts";
import { executeTaskflow } from "../src/runtime.ts";
import { emptyUsage } from "../src/usage.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";

function mkState(def: Taskflow, cwd: string, runId = "te-runtime"): RunState {
	return {
		runId,
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
	};
}

function writeEffect(relativePath: string, id = "report") {
	return {
		id,
		kind: "fs.write" as const,
		target: {
			kind: "path" as const,
			path: {
				workspace: "project",
				subpath: { literalPath: relativePath },
				intent: "create-file" as const,
			},
		},
	};
}

test("runtime script: declared write commits through a resource intent", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-script-"));
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-control-"));
	try {
		const flow: Taskflow = {
			name: "te-script-write",
			phases: [{
				id: "write",
				type: "script",
				run: ["node", "-e", "process.stdout.write('HELLO_FROM_RESOURCE')"],
				effects: [writeEffect("out/report.md")],
				final: true,
			}],
		};
		const result = await executeTaskflow(mkState(flow, root), {
			cwd: root,
			workspaceControlDirectory: control,
			agents: [],
			runTask: async () => { throw new Error("script flow must not call an LLM"); },
		});
		assert.equal(result.ok, true, result.finalOutput);
		assert.equal(fs.readFileSync(path.join(root, "out/report.md"), "utf8"), "HELLO_FROM_RESOURCE");
		assert.ok((result.state.phases.write?.warnings ?? []).some((warning) => /resource intent/.test(warning)));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("runtime script: direct final write fails and restores the exact pre-state", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-script-bypass-"));
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-control-"));
	try {
		const flow: Taskflow = {
			name: "te-script-bypass",
			phases: [{
				id: "write",
				type: "script",
				run: [
					"node",
					"-e",
					"const fs=require('fs');fs.mkdirSync('out',{recursive:true});fs.writeFileSync('out/report.md','BYPASS');process.stdout.write('DECLARED')",
				],
				effects: [writeEffect("out/report.md")],
				final: true,
			}],
		};
		const result = await executeTaskflow(mkState(flow, root, "script-bypass"), {
			cwd: root,
			workspaceControlDirectory: control,
			agents: [],
			runTask: async () => { throw new Error("script flow must not call an LLM"); },
		});
		assert.equal(result.ok, false);
		assert.match(result.state.phases.write?.error ?? "", /declared-path-bypass|changed outside/i);
		assert.equal(fs.existsSync(path.join(root, "out")), false, "failed phase must leave no declared-path residue");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("runtime admission: workspace parent symlink escape is rejected before body execution", async (t) => {
	if (process.platform === "win32") return t.skip("symlink privileges are platform-specific");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-symlink-root-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-symlink-outside-"));
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-control-"));
	let invoked = 0;
	try {
		fs.symlinkSync(outside, path.join(root, "linked"), "dir");
		const flow: Taskflow = {
			name: "te-symlink-escape",
			phases: [{
				id: "write",
				type: "agent",
				agent: "executor",
				task: "produce content",
				effects: [writeEffect("linked/escape.txt")],
				final: true,
			}],
		};
		const result = await executeTaskflow(mkState(flow, root, "symlink-escape"), {
			cwd: root,
			workspaceControlDirectory: control,
			agents: [{ name: "executor", description: "test", systemPrompt: "", source: "user", filePath: "" }],
			runTask: async () => {
				invoked++;
				throw new Error("must not run");
			},
		});
		assert.equal(result.ok, false);
		assert.equal(invoked, 0);
		assert.match(result.state.phases.write?.error ?? "", /TFWS_PATH_ESCAPE/);
		assert.equal(fs.existsSync(path.join(outside, "escape.txt")), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("runtime multi-write: incomplete content map rejects without final files", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-multi-map-"));
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-control-"));
	try {
		const flow: Taskflow = {
			name: "te-multi-map",
			phases: [{
				id: "write",
				type: "script",
				run: ["node", "-e", "process.stdout.write(JSON.stringify({a:'A'}))"],
				effects: [writeEffect("a.txt", "a"), writeEffect("b.txt", "b")],
				final: true,
			}],
		};
		const result = await executeTaskflow(mkState(flow, root, "multi-map"), {
			cwd: root,
			workspaceControlDirectory: control,
			agents: [],
			runTask: async () => { throw new Error("script flow must not call an LLM"); },
		});
		assert.equal(result.ok, false);
		assert.match(result.state.phases.write?.error ?? "", /content-resolution-failed|missing string content/);
		assert.equal(fs.existsSync(path.join(root, "a.txt")), false);
		assert.equal(fs.existsSync(path.join(root, "b.txt")), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("runtime event-kernel flag: declared effects use the same resource transaction semantics", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-kernel-fallback-"));
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-control-"));
	try {
		const flow: Taskflow = {
			name: "te-kernel-fallback",
			phases: [{
				id: "write",
				type: "script",
				run: ["node", "-e", "process.stdout.write('SAME_AUTHORITY')"],
				effects: [writeEffect("kernel.txt")],
				final: true,
			}],
		};
		const result = await executeTaskflow(mkState(flow, root, "kernel-fallback"), {
			cwd: root,
			workspaceControlDirectory: control,
			eventKernel: true,
			agents: [],
			runTask: async () => { throw new Error("script flow must not call an LLM"); },
		});
		assert.equal(result.ok, true, result.finalOutput);
		assert.equal(fs.readFileSync(path.join(root, "kernel.txt"), "utf8"), "SAME_AUTHORITY");
		assert.equal((await new WriteIntentJournal({ directory: control, journalEpoch: 1 }).listIntents())[0]?.status, "committed-content");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("runtime PathRef: typed dynamic output path resolves once at resource admission", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-dynamic-path-"));
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-control-"));
	try {
		const flow: Taskflow = {
			name: "te-dynamic-path",
			args: { outputPath: { type: "relative-path", required: true } },
			phases: [{
				id: "write",
				type: "script",
				run: ["node", "-e", "process.stdout.write('DYNAMIC')"],
				effects: [{
					id: "report",
					kind: "fs.write",
					target: {
						kind: "path",
						path: {
							workspace: "project",
							subpath: { argPath: "outputPath" },
							intent: "create-file",
						},
					},
				}],
				final: true,
			}],
		};
		const state = mkState(flow, root, "dynamic-path");
		state.args = { outputPath: "generated/report.txt" };
		const result = await executeTaskflow(state, {
			cwd: root,
			workspaceControlDirectory: control,
			agents: [],
			runTask: async () => { throw new Error("script flow must not call an LLM"); },
		});
		assert.equal(result.ok, true, result.finalOutput);
		assert.equal(fs.readFileSync(path.join(root, "generated/report.txt"), "utf8"), "DYNAMIC");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("runtime authority: an isolated cwd outside the invocation grant fails before its body", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-isolated-cwd-"));
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-control-"));
	const marker = path.join(root, "body-ran");
	try {
		const flow: Taskflow = {
			name: "te-isolated-cwd",
			phases: [{
				id: "write",
				type: "script",
				cwd: "temp",
				run: ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'yes')`],
				effects: [writeEffect("report.txt")],
				final: true,
			}],
		};
		const result = await executeTaskflow(mkState(flow, root, "isolated-cwd"), {
			cwd: root,
			workspaceControlDirectory: control,
			agents: [],
			runTask: async () => { throw new Error("script flow must not call an LLM"); },
		});
		assert.equal(result.ok, false);
		assert.match(result.state.phases.write?.error ?? "", /TFWS_PATH_ESCAPE/);
		assert.equal(fs.existsSync(marker), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("runtime admission: overlapping cross-run effects reject before the second body", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-cross-run-"));
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-control-"));
	let releaseFirst!: () => void;
	let firstEntered!: () => void;
	const firstBodyEntered = new Promise<void>((resolve) => { firstEntered = resolve; });
	const firstBodyRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
	let secondInvoked = 0;
	try {
		const flow: Taskflow = {
			name: "te-cross-run-overlap",
			phases: [{
				id: "write",
				type: "agent",
				agent: "executor",
				task: "produce content",
				effects: [writeEffect("shared.txt")],
				final: true,
			}],
		};
		const agents = [{ name: "executor", description: "test", systemPrompt: "", source: "user" as const, filePath: "" }];
		const firstSession = await createResolveOnlyWorkspaceSession({
			invocationRoot: root,
			controlDirectory: control,
			leaseTimeoutMs: 500,
		});
		const secondSession = await createResolveOnlyWorkspaceSession({
			invocationRoot: root,
			controlDirectory: control,
			leaseTimeoutMs: 30,
		});
		const first = executeTaskflow(mkState(flow, root, "run-first"), {
			cwd: root,
			workspaceSession: firstSession,
			agents,
			runTask: async (cwd, _agents, agent, task) => {
				firstEntered();
				await firstBodyRelease;
				return { agent, task, exitCode: 0, output: "FIRST", stderr: "", usage: emptyUsage(), stopReason: "end" };
			},
		});
		await firstBodyEntered;
		const second = await executeTaskflow(mkState(flow, root, "run-second"), {
			cwd: root,
			workspaceSession: secondSession,
			agents,
			runTask: async () => {
				secondInvoked++;
				throw new Error("overlapping body must not run");
			},
		});
		assert.equal(second.ok, false);
		assert.equal(secondInvoked, 0);
		assert.match(second.state.phases.write?.error ?? "", /Lease timeout/);
		releaseFirst();
		const firstResult = await first;
		assert.equal(firstResult.ok, true, firstResult.finalOutput);
		assert.equal(fs.readFileSync(path.join(root, "shared.txt"), "utf8"), "FIRST");
		assert.equal((await new WriteIntentJournal({ directory: control, journalEpoch: 1 }).listIntents()).length, 1);
	} finally {
		releaseFirst?.();
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});
