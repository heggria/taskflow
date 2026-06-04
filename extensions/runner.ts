/**
 * Subagent runner — spawns an isolated `pi --mode json -p` process for a single
 * task and collects its structured output and usage. Adapted from the pi
 * subagent extension's runSingleAgent.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { emptyUsage, type UsageStats } from "./usage.ts";

export interface RunResult {
	agent: string;
	task: string;
	exitCode: number;
	output: string;
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	/** Total subagent attempts incl. retries (set by the runtime's retry wrapper). */
	attempts?: number;
}

export interface LiveUpdate {
	/** Latest assistant text or tool activity (single-line, truncated upstream). */
	text: string;
	usage: UsageStats;
	model?: string;
}

export interface RunOptions {
	model?: string;
	thinking?: string;
	tools?: string[];
	cwd?: string;
	signal?: AbortSignal;
	/** Fires on each assistant turn with the latest activity + accumulated usage. */
	onLive?: (live: LiveUpdate) => void;
}

export function isFailed(r: RunResult): boolean {
	return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

/** Accumulated state folded from a subagent's NDJSON event stream. */
export interface EventAccumulator {
	messages: Message[];
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	lastActivity: string;
}

export function newAccumulator(model?: string): EventAccumulator {
	return { messages: [], usage: emptyUsage(), model, lastActivity: "" };
}

/**
 * Fold one NDJSON line into the accumulator. Returns a LiveUpdate when an
 * assistant message ended (for streaming), else null. Empty, malformed, and
 * non-`message_end` lines are ignored — making the parser robust to partial
 * buffers/noise and unit-testable without spawning a process.
 */
export function foldEventLine(acc: EventAccumulator, line: string): LiveUpdate | null {
	if (!line.trim()) return null;
	let event: any;
	try {
		event = JSON.parse(line);
	} catch {
		return null;
	}
	if (event.type !== "message_end" || !event.message) return null;
	const msg = event.message as Message;
	acc.messages.push(msg);
	if (msg.role !== "assistant") return null;
	acc.usage.turns++;
	const u = (msg as any).usage;
	if (u) {
		acc.usage.input += u.input || 0;
		acc.usage.output += u.output || 0;
		acc.usage.cacheRead += u.cacheRead || 0;
		acc.usage.cacheWrite += u.cacheWrite || 0;
		acc.usage.cost += u.cost?.total || 0;
		acc.usage.contextTokens = u.totalTokens || 0;
	}
	if (!acc.model && (msg as any).model) acc.model = (msg as any).model;
	if ((msg as any).stopReason) acc.stopReason = (msg as any).stopReason;
	if ((msg as any).errorMessage) acc.errorMessage = (msg as any).errorMessage;
	const activity = describeActivity(msg);
	if (activity) acc.lastActivity = activity;
	return { text: acc.lastActivity, usage: { ...acc.usage }, model: acc.model };
}

/** One-line description of the most recent assistant activity (text or tool call). */
function describeActivity(msg: Message): string {
	if (msg.role !== "assistant") return "";
	let lastText = "";
	let lastTool = "";
	for (const part of (msg as any).content ?? []) {
		if (part.type === "text" && part.text?.trim()) lastText = part.text.trim();
		else if (part.type === "toolCall") lastTool = summarizeToolCall(part.name, part.arguments ?? {});
	}
	const chosen = lastText || lastTool;
	return chosen.replace(/\s+/g, " ").trim();
}

function summarizeToolCall(name: string, args: Record<string, unknown>): string {
	const short = (p: unknown) => {
		const s = String(p ?? "");
		return s.length > 48 ? `${s.slice(0, 48)}…` : s;
	};
	switch (name) {
		case "bash":
			return `$ ${short(args.command)}`;
		case "read":
			return `read ${short(args.path ?? args.file_path)}`;
		case "write":
			return `write ${short(args.path ?? args.file_path)}`;
		case "edit":
			return `edit ${short(args.path ?? args.file_path)}`;
		case "grep":
			return `grep ${short(args.pattern)}`;
		case "find":
			return `find ${short(args.pattern)}`;
		case "ls":
			return `ls ${short(args.path)}`;
		default:
			return `${name}`;
	}
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-taskflow-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	// Explicit override (used by tests and unusual launch setups).
	const override = process.env.PI_TASKFLOW_PI_BIN;
	if (override) return { command: override, args };

	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	// Only re-exec the current script if it actually looks like the pi CLI entry.
	const looksLikePi = currentScript ? /(?:^|[\\/])(?:cli|pi)\.(?:js|mjs|cjs)$/.test(currentScript) : false;
	if (currentScript && !isBunVirtualScript && looksLikePi && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

/**
 * Run a single subagent task. Resolves the agent from `agents` by name and
 * spawns an isolated pi process, returning structured output + usage.
 */
export async function runAgentTask(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	opts: RunOptions,
	globalThinking?: string,
): Promise<RunResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			task,
			exitCode: 1,
			output: "",
			stderr: `Unknown agent: "${agentName}". Available: ${available}.`,
			usage: emptyUsage(),
			errorMessage: `Unknown agent: ${agentName}`,
			stopReason: "error",
		};
	}

	const model = opts.model ?? agent.model;
	const thinking = opts.thinking ?? agent.thinking ?? globalThinking;
	const tools = opts.tools ?? agent.tools;

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (model) args.push("--model", model);
	if (thinking) args.push("--thinking", thinking);
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const acc = newAccumulator(model);
	const result: RunResult = {
		agent: agentName,
		task,
		exitCode: 0,
		output: "",
		stderr: "",
		usage: emptyUsage(),
		model,
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}
		args.push(`Task: ${task}`);

		let wasAborted = false;
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: opts.cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				const live = foldEventLine(acc, line);
				if (live && opts.onLive) opts.onLive(live);
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});
			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});
			proc.on("error", () => resolve(1));

			if (opts.signal) {
				const kill = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (opts.signal.aborted) kill();
				else opts.signal.addEventListener("abort", kill, { once: true });
			}
		});

		result.exitCode = exitCode;
		result.usage = acc.usage;
		result.model = acc.model;
		result.stopReason = acc.stopReason;
		result.errorMessage = acc.errorMessage;
		result.output = getFinalOutput(acc.messages);
		if (wasAborted) {
			result.stopReason = "aborted";
			result.errorMessage = "Subagent was aborted";
		}
		if (isFailed(result) && !result.output) {
			result.output = result.errorMessage || result.stderr || "(no output)";
		}
		return result;
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		}
		if (tmpPromptDir) {
			try {
				fs.rmSync(tmpPromptDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}
}

/** Run an array of items through `fn` with a bounded concurrency pool. */
export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}
