/**
 * Pi is a delivery adapter, not a ControlStore client. These tests pin the
 * fail-closed boundary so enabling the control plane cannot silently revive
 * the old direct `.pi/runs` lifecycle.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { newRunId, saveRun, type RunState, type Taskflow } from "taskflow-core";
import registerTaskflow, { controlPlaneExplicitlyDisabled } from "../src/index.ts";

interface TextResult {
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}

interface RegisteredTool {
	name: string;
	execute: (...args: unknown[]) => Promise<unknown>;
}

interface RegisteredCommand {
	name: string;
	handler: (...args: unknown[]) => unknown;
}

interface CapturedPi {
	taskflow: RegisteredTool;
	commands: Map<string, RegisteredCommand>;
	sentUserMessages: string[];
}

function capturePi(): CapturedPi {
	let taskflow: RegisteredTool | undefined;
	const commands = new Map<string, RegisteredCommand>();
	const sentUserMessages: string[] = [];
	const pi = {
		registerTool: (tool: unknown) => {
			const registered = tool as RegisteredTool;
			if (registered.name === "taskflow") taskflow = registered;
		},
		registerCommand: (name: unknown, command: unknown) => {
			const registered = command as Omit<RegisteredCommand, "name">;
			commands.set(String(name), { name: String(name), ...registered });
		},
		on: () => undefined,
		sendUserMessage: (message: string) => sentUserMessages.push(message),
	} as unknown as ExtensionAPI;
	registerTaskflow(pi);
	assert.ok(taskflow, "the Pi host must register the taskflow tool");
	return { taskflow, commands, sentUserMessages };
}

function captureTaskflowTool(): RegisteredTool {
	return capturePi().taskflow;
}

function toolContext(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		isIdle: () => true,
		ui: { notify: () => undefined },
	} as unknown as ExtensionContext;
}

function commandContext(cwd: string, notifications: string[]): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		isIdle: () => true,
		ui: { notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionContext;
}

function interactiveCommandContext(
	cwd: string,
	notifications: string[],
	selection: { action: "resume"; runId: string },
): ExtensionContext {
	return {
		cwd,
		hasUI: true,
		isIdle: () => true,
		ui: {
			notify: (message: string) => notifications.push(message),
			custom: async () => selection,
		},
	} as unknown as ExtensionContext;
}

function asTextResult(value: unknown): TextResult {
	assert.ok(value && typeof value === "object", "tool must return an object");
	const result = value as Partial<TextResult>;
	assert.ok(Array.isArray(result.content), "tool result must include content");
	assert.equal(result.content[0]?.type, "text");
	assert.equal(typeof result.content[0]?.text, "string");
	return result as TextResult;
}

async function execute(
	tool: RegisteredTool,
	params: Record<string, unknown>,
	cwd: string,
): Promise<TextResult> {
	return asTextResult(await tool.execute("test", params, undefined, undefined, toolContext(cwd)));
}

function scriptFlow(name: string): Taskflow {
	return {
		name,
		phases: [{ id: "main", type: "script", run: "printf pi-legacy-control", final: true }],
	};
}

function legacyState(cwd: string): RunState {
	const now = Date.now();
	return {
		runId: newRunId("pi-legacy"),
		flowName: "pi-legacy",
		def: scriptFlow("pi-legacy"),
		args: {},
		status: "failed",
		phases: {},
		createdAt: now,
		updatedAt: now,
		cwd,
	};
}

function snapshotTree(root: string): Record<string, string> {
	const files: Record<string, string> = {};
	const visit = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const absolute = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(absolute);
			else if (entry.isFile()) files[path.relative(root, absolute)] = fs.readFileSync(absolute).toString("base64");
		}
	};
	visit(root);
	return files;
}

async function withControlPlane<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
	const previous = process.env.TASKFLOW_CONTROL_PLANE;
	if (value === undefined) delete process.env.TASKFLOW_CONTROL_PLANE;
	else process.env.TASKFLOW_CONTROL_PLANE = value;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env.TASKFLOW_CONTROL_PLANE;
		else process.env.TASKFLOW_CONTROL_PLANE = previous;
	}
}

test("Pi control gate: only documented case-insensitive emergency values disable the default", () => {
	for (const value of ["0", "false", "off", "no", "FALSE", "Off", "NO"]) {
		assert.equal(controlPlaneExplicitlyDisabled({ TASKFLOW_CONTROL_PLANE: value }), true, value);
	}
	for (const value of [undefined, "", "1", "true", "unexpected"]) {
		const env = value === undefined ? {} : { TASKFLOW_CONTROL_PLANE: value };
		assert.equal(controlPlaneExplicitlyDisabled(env), false, String(value));
	}
});

test(
	"Pi control gate: default execution rejects every enabled value before creating .pi state",
	{ concurrency: false },
	async () => {
		const tool = captureTaskflowTool();
		for (const value of [undefined, "", "1", "true", "unexpected"]) {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-pi-control-default-"));
			try {
				await withControlPlane(value, async () => {
					const result = await execute(tool, { action: "run", define: scriptFlow(`default-${String(value)}`) }, cwd);
					assert.equal(result.isError, true, `${String(value)}: ${result.content[0]?.text}`);
					assert.match(result.content[0]?.text ?? "", /no legacy fallthrough/i);
					assert.equal(fs.existsSync(path.join(cwd, ".pi")), false, `${String(value)} must not create a legacy run store`);
				});
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		}
	},
);

test(
	"Pi control gate: default resume and live recompute leave an existing legacy lifecycle byte-identical",
	{ concurrency: false },
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-pi-control-existing-"));
		try {
			const state = legacyState(cwd);
			saveRun(state);
			const legacyRoot = path.join(cwd, ".pi");
			const tool = captureTaskflowTool();
			await withControlPlane(undefined, async () => {
				for (const params of [
					{ action: "resume", runId: state.runId },
					{ action: "recompute", runId: state.runId, phaseId: "main", dryRun: false },
				]) {
					const before = snapshotTree(legacyRoot);
					const result = await execute(tool, params, cwd);
					assert.equal(result.isError, true, result.content[0]?.text);
					assert.match(result.content[0]?.text ?? "", /no legacy fallthrough/i);
					assert.deepEqual(snapshotTree(legacyRoot), before, `${params.action} must not mutate legacy state`);
				}
			});
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	},
);

test(
	"Pi control gate: explicit legacy opt-out remains a tested emergency compatibility path",
	{ concurrency: false },
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-pi-control-opt-out-"));
		try {
			const tool = captureTaskflowTool();
			await withControlPlane("0", async () => {
				const result = await execute(tool, { action: "run", define: scriptFlow("opted-out") }, cwd);
				assert.notEqual(result.isError, true, result.content[0]?.text);
				assert.match(result.content[0]?.text ?? "", /pi-legacy-control/);
				assert.equal(fs.existsSync(path.join(cwd, ".pi")), true, "explicit opt-out may use the legacy run store");
			});
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	},
);

test(
	"Pi control gate: direct slash execution commands fail before legacy reads or prompting the model",
	{ concurrency: false },
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-pi-control-command-"));
		try {
			const captured = capturePi();
			const command = captured.commands.get("tf");
			assert.ok(command, "the Pi host must register /tf");
			await withControlPlane(undefined, async () => {
				for (const args of ["run missing-flow", "resume missing-run", "recompute missing-run main --apply"]) {
					const notifications: string[] = [];
					await command.handler(args, commandContext(cwd, notifications));
					assert.match(notifications[0] ?? "", /no legacy fallthrough/i, args);
					assert.equal(captured.sentUserMessages.length, 0, `${args} must not prompt the model to invoke a rejected tool`);
					assert.equal(fs.existsSync(path.join(cwd, ".pi")), false, `${args} must not read or create legacy state`);
				}
			});
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	},
);

test(
	"Pi control gate: saved-flow shortcuts and the run-history resume affordance cannot bypass the default",
	{ concurrency: false },
	async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-pi-control-shortcut-"));
		try {
			const captured = capturePi();
			const command = captured.commands.get("tf");
			assert.ok(command, "the Pi host must register /tf");
			await withControlPlane(undefined, async () => {
				const saved = await execute(captured.taskflow, { action: "save", define: scriptFlow("saved-shortcut") }, cwd);
				assert.notEqual(saved.isError, true, saved.content[0]?.text);
				const shortcut = captured.commands.get("tf:saved-shortcut");
				assert.ok(shortcut, "saving a flow must register its shortcut");
				const shortcutBefore = snapshotTree(path.join(cwd, ".pi"));
				const shortcutNotifications: string[] = [];
				await shortcut.handler("", commandContext(cwd, shortcutNotifications));
				assert.match(shortcutNotifications[0] ?? "", /no legacy fallthrough/i);
				assert.deepEqual(snapshotTree(path.join(cwd, ".pi")), shortcutBefore, "default shortcut must not mutate legacy state");

				const state = legacyState(cwd);
				saveRun(state);
				const historyBefore = snapshotTree(path.join(cwd, ".pi"));
				const historyNotifications: string[] = [];
				await command.handler("runs", interactiveCommandContext(cwd, historyNotifications, { action: "resume", runId: state.runId }));
				assert.match(historyNotifications[0] ?? "", /no legacy fallthrough/i);
				assert.deepEqual(snapshotTree(path.join(cwd, ".pi")), historyBefore, "history resume must not mutate legacy state");
				assert.equal(captured.sentUserMessages.length, 0, "no default Pi affordance may prompt a rejected legacy execution");
			});
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	},
);
