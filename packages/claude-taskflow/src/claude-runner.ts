/**
 * Claude Code subagent runner — the Claude host's `SubagentRunner` implementation.
 *
 * Spawns an isolated `claude -p --output-format stream-json` process per task
 * and folds its JSONL event stream into the same host-neutral `RunResult` the
 * pi and codex runners produce, so the engine (runtime.ts) treats a Claude
 * subagent identically to a pi or codex one.
 *
 * Real claude stream-json schema (claude-code ≥ 2.1), observed empirically:
 *   {"type":"system","subtype":"init","model":"claude-…","tools":[…],…}
 *   {"type":"assistant","message":{"model":"…","content":[{"type":"text","text":"…"},
 *       {"type":"tool_use","name":"Bash","input":{…}}],"usage":{"input_tokens":…,
 *       "output_tokens":…,"cache_read_input_tokens":…,"cache_creation_input_tokens":…}},…}
 *   {"type":"user","message":{…tool_result…}}
 *   {"type":"result","subtype":"success"|"error_max_turns"|…,"is_error":bool,
 *       "num_turns":N,"result":"…","total_cost_usd":X,"usage":{…}}   ← authoritative
 *
 * Mapping to the host-neutral contract:
 *   - output       = `result` field of the result event (fallback: last assistant text)
 *   - usage        = the result event's cumulative usage + num_turns + total_cost_usd
 *                    (assistant events accumulate per-turn usage for live streaming;
 *                    the result event overwrites with the authoritative totals)
 *   - lastActivity = latest assistant text or a one-line tool summary
 *   - failure      = result.is_error, a stream-level error, or a non-zero exit
 *
 * Permission mapping (the codex `sandboxForTools` analogue): Claude Code has no
 * OS-level sandbox in -p mode — a tool call is either whitelisted or denied. A
 * phase whose tool whitelist is read-only gets `--allowedTools <read-only set>`
 * (mutating tools are denied outright); anything else gets
 * `--permission-mode bypassPermissions`, which behaves like codex's
 * workspace-write but WITHOUT an OS sandbox backstop — document accordingly.
 *
 * Process handling (idle watchdog, abort, signal-kill detection, stderr cap,
 * error sanitization) mirrors the pi/codex runners so behavior is uniform.
 */

import { spawn } from "node:child_process";
import {
	emptyUsage,
	isFailed,
	sanitizeErrorMessage,
	TRANSPORT_ERROR_PLACEHOLDER,
	type AgentConfig,
	type LiveUpdate,
	type RunOptions,
	type RunResult,
	type SubagentRunner,
	type UsageStats,
} from "taskflow-core";

const activeChildren = new Set<number>();
const killAll = () => {
	for (const pid of activeChildren) {
		try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
	}
};
process.on("exit", killAll);

/** Same idle window as the pi/codex runners: a child silent this long is wedged. */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

/** The Claude tools a read-only phase may use. `Bash` is excluded — Claude has
 *  no read-only shell (unlike codex's read-only OS sandbox, which still allows
 *  read-only commands), so a listed-tools phase without write/edit/bash gets
 *  file reads + search + web only. */
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "WebFetch", "WebSearch"];

/** Accumulated state folded from a claude stream-json event stream. */
export interface ClaudeAccumulator {
	usage: UsageStats;
	model?: string;
	/** Final answer = the result event's `result`, else the last assistant text. */
	finalText: string;
	lastActivity: string;
	/** Set when the stream reported a fatal error (result.is_error / stream error). */
	fatalError?: string;
	/** True once the authoritative `result` event has been folded. */
	sawResult: boolean;
}

export function newClaudeAccumulator(model?: string): ClaudeAccumulator {
	return { usage: emptyUsage(), model, finalText: "", lastActivity: "", sawResult: false };
}

function shortTool(name: unknown, input: unknown): string {
	const n = String(name ?? "tool");
	if (n === "Bash" && input && typeof input === "object") {
		const cmd = String((input as { command?: unknown }).command ?? "").replace(/\s+/g, " ").trim();
		return `$ ${cmd.length > 64 ? `${cmd.slice(0, 64)}…` : cmd}`;
	}
	return n;
}

/**
 * Fold one claude stream-json line into the accumulator. Returns a LiveUpdate
 * when the stream produced new activity (for streaming), else null. Empty or
 * malformed lines are ignored — robust to partial buffers and noise,
 * unit-testable without spawning a process.
 */
export function foldClaudeEventLine(acc: ClaudeAccumulator, line: string): LiveUpdate | null {
	if (!line.trim()) return null;
	let event: any;
	try {
		event = JSON.parse(line);
	} catch {
		return null;
	}
	let activity = "";

	if (event.type === "system" && event.subtype === "init") {
		if (typeof event.model === "string" && event.model) acc.model = event.model;
		return null;
	} else if (event.type === "assistant" && event.message) {
		const msg = event.message;
		// Claude injects synthetic assistant messages (model "<synthetic>") for
		// harness-level errors (auth failures, aborts) — their text is diagnostic,
		// not an answer. Surface it as activity but never as the final answer.
		const synthetic = msg.model === "<synthetic>";
		if (!synthetic && typeof msg.model === "string" && msg.model) acc.model = msg.model;
		for (const part of Array.isArray(msg.content) ? msg.content : []) {
			if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
				if (!synthetic) acc.finalText = part.text;
				activity = part.text.trim();
			} else if (part?.type === "tool_use") {
				activity = shortTool(part.name, part.input);
			}
		}
		if (typeof event.error === "string" && event.error) {
			acc.fatalError = activity || event.error;
		}
		// Per-turn usage for live progress; the result event overwrites with the
		// run's authoritative totals (never double-counted).
		const u = msg.usage;
		if (!acc.sawResult && u && !synthetic) {
			acc.usage.turns++;
			acc.usage.input += u.input_tokens || 0;
			acc.usage.output += u.output_tokens || 0;
			acc.usage.cacheRead += u.cache_read_input_tokens || 0;
			acc.usage.cacheWrite += u.cache_creation_input_tokens || 0;
			acc.usage.contextTokens =
				(u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
		}
	} else if (event.type === "result") {
		acc.sawResult = true;
		const u = event.usage;
		if (u) {
			const prev = acc.usage.contextTokens;
			acc.usage = emptyUsage();
			acc.usage.input = u.input_tokens || 0;
			acc.usage.output = u.output_tokens || 0;
			acc.usage.cacheRead = u.cache_read_input_tokens || 0;
			acc.usage.cacheWrite = u.cache_creation_input_tokens || 0;
			acc.usage.contextTokens = prev;
		}
		acc.usage.turns = typeof event.num_turns === "number" ? event.num_turns : acc.usage.turns;
		acc.usage.cost = typeof event.total_cost_usd === "number" ? event.total_cost_usd : 0;
		if (event.is_error) {
			acc.fatalError =
				(typeof event.result === "string" && event.result.trim()) ||
				`claude run failed (${event.subtype ?? "unknown"})`;
			activity = `error: ${acc.fatalError}`;
		} else if (typeof event.result === "string" && event.result.trim()) {
			acc.finalText = event.result;
		}
	} else {
		return null; // user (tool results) / stream_event — nothing to fold.
	}

	if (activity) acc.lastActivity = activity.replace(/\s+/g, " ").trim();
	return { text: acc.lastActivity, usage: { ...acc.usage }, model: acc.model };
}

/** Override the claude binary (tests / unusual installs). */
function claudeBin(): string {
	return process.env.PI_TASKFLOW_CLAUDE_BIN || "claude";
}

/**
 * Map a phase's tool whitelist to claude permission flags — the codex
 * `sandboxForTools` analogue. A phase that only reads (no write/edit/bash in
 * its whitelist) gets a read-only `--allowedTools` set; anything else gets
 * `--permission-mode bypassPermissions` (non-interactive -p runs cannot answer
 * permission prompts, so the codex workspace-write equivalent is bypass —
 * WITHOUT an OS sandbox backstop). No whitelist → bypass (the engine's
 * default-capable agent).
 */
export function permissionArgsForTools(tools: string[] | undefined): string[] {
	if (!tools || tools.length === 0) return ["--permission-mode", "bypassPermissions"];
	const mutating = new Set(["write", "edit", "bash", "apply_patch"]);
	const canMutate = tools.some((t) => mutating.has(t));
	if (canMutate) return ["--permission-mode", "bypassPermissions"];
	return ["--allowedTools", READ_ONLY_TOOLS.join(",")];
}

/**
 * Run a single subagent task via `claude -p --output-format stream-json`.
 * Resolves the agent from `agents` by name; returns the same structured
 * `RunResult` the pi and codex runners do.
 */
export async function runClaudeAgentTask(
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
	const tools = opts.tools ?? agent.tools;
	void globalThinking; // claude -p has no thinking-level flag; reserved.

	// The agent.model comes from the shared modelRoles table, which is written in
	// the pi provider format (e.g. "openrouter/deepseek/...", "anthropic/claude-…:xhigh"
	// — note the `/` provider prefix). Claude model ids are flat (aliases like
	// "sonnet"/"opus"/"haiku" or full ids like "claude-sonnet-4-6"), so — same
	// rule as the codex runner — a resolved model that still looks like a
	// pi-provider path (contains "/") or an unresolved {{placeholder}} is dropped
	// and `claude` falls back to its own configured default model.
	const claudeModel = model && !model.includes("/") && !/^\{\{.*\}\}$/.test(model) ? model : undefined;

	// claude -p [PROMPT] --output-format stream-json --verbose (required for
	// stream-json with -p) --strict-mcp-config (don't load the user's MCP servers
	// into every subagent — flows needing them can add tools explicitly).
	// Unlike codex, claude has a real --append-system-prompt flag, so the agent's
	// system prompt rides there instead of being pasted into the task prompt.
	const args: string[] = ["-p", "--output-format", "stream-json", "--verbose", "--strict-mcp-config"];
	args.push(...permissionArgsForTools(tools));
	if (claudeModel) args.push("--model", claudeModel);
	if (agent.systemPrompt.trim()) args.push("--append-system-prompt", agent.systemPrompt.trim());
	args.push(task);

	const acc = newClaudeAccumulator(model);
	const result: RunResult = {
		agent: agentName,
		task,
		exitCode: 0,
		output: "",
		stderr: "",
		usage: emptyUsage(),
		model,
	};

	let wasAborted = false;
	let idleTimedOut = false;
	let killedBySignal: string | undefined;

	const cwd = opts.cwd ?? defaultCwd;
	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(claudeBin(), args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
		});
		if (proc.pid) activeChildren.add(proc.pid);

		let buffer = "";
		let idleTimer: NodeJS.Timeout | undefined;
		let forceTimer: NodeJS.Timeout | undefined;
		const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		const clearTimers = () => {
			if (idleTimer) clearTimeout(idleTimer);
			if (forceTimer) clearTimeout(forceTimer);
		};
		const hardKill = () => {
			idleTimedOut = true;
			proc.kill("SIGTERM");
			forceTimer = setTimeout(() => proc.kill("SIGKILL"), 5000);
			forceTimer.unref();
		};
		const armIdle = () => {
			if (idleTimer) clearTimeout(idleTimer);
			if (idleMs <= 0) return;
			idleTimer = setTimeout(hardKill, idleMs);
			idleTimer.unref();
		};
		armIdle();

		const processLine = (line: string) => {
			const live = foldClaudeEventLine(acc, line);
			if (live && opts.onLive) opts.onLive(live);
		};

		proc.stdout.on("data", (data) => {
			armIdle();
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		const STDERR_MAX_LEN = 64 * 1024;
		let stderrCapped = false;
		proc.stderr.on("data", (data) => {
			if (!stderrCapped) {
				result.stderr += data.toString();
				if (result.stderr.length >= STDERR_MAX_LEN) {
					result.stderr = result.stderr.slice(0, STDERR_MAX_LEN) + "\n[...stderr truncated at 64KB]";
					stderrCapped = true;
				}
			}
		});

		proc.on("close", (code, signal) => {
			if (proc.pid) activeChildren.delete(proc.pid);
			clearTimers();
			if (buffer.trim()) processLine(buffer);
			if (code === null && signal) killedBySignal = signal;
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
	result.output = acc.finalText;

	if (acc.fatalError) {
		result.exitCode = result.exitCode || 1;
		result.stopReason = "error";
		result.errorMessage = acc.fatalError;
	} else {
		result.stopReason = exitCode === 0 ? "end" : "error";
	}

	if (exitCode === 0 && killedBySignal && !idleTimedOut && !wasAborted) {
		result.exitCode = 1;
		result.stopReason = "error";
		result.errorMessage = `Subagent killed by signal ${killedBySignal}`;
	}
	if (idleTimedOut) {
		result.stopReason = "error";
		result.idleTimeout = true;
		result.errorMessage = `Subagent stalled: no output for ${Math.round(
			(opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS) / 1000,
		)}s (idle timeout) — killed`;
	} else if (wasAborted) {
		result.stopReason = "aborted";
		result.errorMessage = "Subagent was aborted";
	}

	if (isFailed(result)) {
		if (!result.output) {
			result.output = TRANSPORT_ERROR_PLACEHOLDER;
			if (!result.errorMessage) {
				result.errorMessage =
					result.stderr || `Subagent exited with code ${result.exitCode} (stopReason: ${result.stopReason ?? "unknown"})`;
			}
		}
		if (result.errorMessage) result.errorMessage = sanitizeErrorMessage(result.errorMessage);
	}

	return result;
}

/**
 * The Claude host's `SubagentRunner`. Drops into `RuntimeDeps.runTask` exactly
 * like `piSubagentRunner` / `codexSubagentRunner`, so the engine runs unchanged
 * on Claude Code.
 */
export const claudeSubagentRunner: SubagentRunner<AgentConfig> = {
	runTask: runClaudeAgentTask,
};
