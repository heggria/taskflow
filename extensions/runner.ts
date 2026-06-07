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
	/**
	 * Idle watchdog: if the subagent produces no stdout for this many ms, it is
	 * considered stalled (hung stream / provider stall / tool deadlock) and is
	 * killed (SIGTERM → SIGKILL). Resets on every stdout chunk. 0/undefined keeps
	 * the prior behaviour (no idle timeout). Defaults to DEFAULT_IDLE_TIMEOUT_MS.
	 */
	idleTimeoutMs?: number;
}

/**
 * Default idle-watchdog window. A subagent that emits nothing on stdout for this
 * long is treated as wedged and killed so a single stalled child cannot hang the
 * entire taskflow forever (the only previous escape was a manual user abort).
 * 5 minutes is generous enough for slow reasoning/long tool calls while still
 * bounding a true hang.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

export function isFailed(r: RunResult): boolean {
	return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
}

/**
 * Heuristic: did this failure look like a transient/retryable provider error
 * (rate limit, overload, timeout, 5xx)? Such errors should be retried inside
 * the taskflow run with backoff rather than bubbled up — otherwise the calling
 * agent tends to re-invoke the whole tool, producing duplicate progress blocks.
 */
const TRANSIENT_ERROR_RE =
	/rate[_\s-]?limit|too\s+many\s+requests|overloaded|\b429\b|\b503\b|\b502\b|\b504\b|service\s+unavailable|temporarily\s+unavailable|timeout|timed?\s+out|econnreset|etimedout|socket\s+hang\s*up/i;
export function isTransientError(r: RunResult): boolean {
	if (r.stopReason === "aborted") return false;
	const hay = `${r.errorMessage ?? ""} ${r.stderr ?? ""} ${r.output ?? ""}`;
	return TRANSIENT_ERROR_RE.test(hay);
}

/** Placeholder written to a failed phase's `output` so downstream interpolation
 *  can detect "upstream failed" without being polluted by raw HTML/JSON. */
export const TRANSPORT_ERROR_PLACEHOLDER = "(upstream error: subagent failed; see error)";

/** Hard cap on the errorMessage field stored in PhaseState (≈ 4 KB). */
export const ERROR_MESSAGE_MAX_LEN = 4096;

/** Cheap HTML/JSON detector so we can summarize upstream garbage. */
export function looksLikeHtmlOrJson(s: string): boolean {
	const t = s.trimStart();
	if (!t) return false;
	if (t.startsWith("<")) {
		// HTML/XML/Cloudflare challenge pages
		return /^<(?:!doctype\s+html|html|head|body|script|svg|div|iframe|span|p)\b/i.test(t);
	}
	if (t.startsWith("{")) {
		// Truncated JSON. A genuine JSON envelope is fine to keep; an unwrapped
		// {error: "..."} from an SDK is short. We only treat it as "garbage" if
		// it parses and is huge — but that's caught by the size cap below.
		return false;
	}
	return false;
}

/**
 * Truncate and (when obviously HTML) summarize an errorMessage before it is
 * persisted. Returns the cleaned string. Empty input returns empty.
 */
export function sanitizeErrorMessage(raw: string | undefined): string {
	if (!raw) return "";
	const cleaned = raw.replace(/\s+/g, " ").trim();
	if (!cleaned) return "";
	// Decide the sanitization branch on the RAW length, not the whitespace-
	// collapsed length — otherwise an HTML page padded with spaces would slip
	// through the "looks like HTML" branch and be persisted as-is.
	const rawLen = raw.length;
	if (rawLen > ERROR_MESSAGE_MAX_LEN) {
		const head = cleaned.slice(0, 200);
		const tail = cleaned.slice(-200);
		return `${head} ... [truncated ${rawLen - 400} chars] ... ${tail}`;
	}
	if (looksLikeHtmlOrJson(cleaned)) {
		// Any document-like HTML (Cloudflare challenge pages, proxy error pages,
		// gateway error pages) is a strong signal the upstream returned a page
		// instead of JSON. Summarize it instead of letting HTML pollute the
		// phase's error and downstream interpolation contexts.
		const title = cleaned.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
		const stripped = cleaned.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
		const m = stripped.match(/(?:Unable to load site|Ray ID[: ]+([A-Za-z0-9]+)|[A-Z][a-z]+Error[: ]+(.{0,200}))/i);
		const hint = title || (m ? (m[1] || m[0]).trim() : stripped.slice(0, 200));
		return `Upstream returned non-JSON response (${rawLen} chars). Hint: ${hint}`;
	}
	return cleaned;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text.trim()) return part.text;
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

async function writePromptToTempFile(filePath: string, prompt: string): Promise<void> {
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
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
			// Allocate the temp dir + path BEFORE any fallible I/O so that if
			// writeFile throws, tmpPromptDir/tmpPromptPath are already set and
			// the finally block can clean up the directory (F-004).
			tmpPromptDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-taskflow-"));
			const safeName = agent.name.replace(/[^\w.-]+/g, "_");
			tmpPromptPath = path.join(tmpPromptDir, `prompt-${safeName}.md`);
			await writePromptToTempFile(tmpPromptPath, agent.systemPrompt);
			args.push("--append-system-prompt", tmpPromptPath);
		}
		args.push(`Task: ${task}`);

		let wasAborted = false;
		let idleTimedOut = false;
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: opts.cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			// Idle watchdog: a subagent that goes silent on stdout for too long is
			// treated as wedged and killed, so one stalled child cannot hang the
			// whole taskflow forever. The timer is reset on every stdout chunk and
			// torn down on close/error.
			const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
			const clearTimers = () => {
				if (idleTimer) clearTimeout(idleTimer);
				if (forceKillTimer) clearTimeout(forceKillTimer);
			};
			const hardKill = () => {
				proc.kill("SIGTERM");
				forceKillTimer = setTimeout(() => proc.kill("SIGKILL"), 5000);
				forceKillTimer.unref();
			};
			const armIdle = () => {
				if (idleTimer) clearTimeout(idleTimer);
				if (idleMs <= 0) return; // disabled
				idleTimer = setTimeout(() => {
					idleTimedOut = true;
					hardKill();
				}, idleMs);
				idleTimer.unref();
			};
			armIdle();

			const processLine = (line: string) => {
				const live = foldEventLine(acc, line);
				if (live && opts.onLive) opts.onLive(live);
			};

			proc.stdout.on("data", (data) => {
				armIdle(); // progress observed — reset the idle watchdog
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});
			proc.on("close", (code) => {
				clearTimers();
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});
			proc.on("error", (err) => {
				clearTimers();
				if (!result.stderr) result.stderr = err.message;
				if (!result.errorMessage) result.errorMessage = err.message;
				resolve(1);
			});

			if (opts.signal) {
				const kill = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					// Force-kill fallback. proc.kill("SIGKILL") is idempotent if
					// the process already exited, and `proc.killed` is set true
					// synchronously by the SIGTERM above — so the previous
					// `if (!proc.killed)` guard would skip SIGKILL entirely,
					// hanging forever on a child that ignores SIGTERM.
					// .unref() keeps the timer from holding the event loop open
					// after the process is gone.
					const forceKill = setTimeout(() => proc.kill("SIGKILL"), 5000);
					forceKill.unref();
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
		if (idleTimedOut) {
			// Distinct, actionable signal: the child was killed for being idle, not
			// a user abort. stopReason "error" keeps it in the failed bucket so the
			// runtime's retry/fail handling treats it as a real failure.
			result.stopReason = "error";
			result.errorMessage = `Subagent stalled: no output for ${Math.round((opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS) / 1000)}s (idle timeout) — killed`;
		} else if (wasAborted) {
			result.stopReason = "aborted";
			result.errorMessage = "Subagent was aborted";
		}
		// On failure, build a short, structured errorMessage + a placeholder
		// output. We deliberately do NOT copy the raw errorMessage into
		// `output`: upstream providers (e.g. a Cloudflare challenge page) can
		// surface huge HTML/JSON in errorMessage, and that garbage would
		// otherwise flow into downstream phase interpolations.
		// Sanitization must run whenever the run failed, even if some output
		// was already emitted (e.g. crash mid-stream with a partial result):
		// an unsanitized errorMessage would still leak into PhaseState and
		// downstream interpolation contexts. (F-013)
		if (isFailed(result)) {
			if (!result.output) {
				result.output = TRANSPORT_ERROR_PLACEHOLDER;
				if (!result.errorMessage) {
					result.errorMessage = result.stderr || `Subagent exited with code ${result.exitCode} (stopReason: ${result.stopReason ?? "unknown"})`;
				}
			}
			if (result.errorMessage) {
				result.errorMessage = sanitizeErrorMessage(result.errorMessage);
			}
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
