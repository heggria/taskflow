/**
 * Codex subagent runner — the Codex host's `SubagentRunner` implementation.
 *
 * Spawns an isolated `codex exec --json` process per task and folds its JSONL
 * event stream into the same host-neutral `RunResult` the pi runner produces,
 * so the engine (runtime.ts) treats a Codex subagent identically to a pi one.
 *
 * Real codex JSONL schema (codex-cli ≥ 0.142), observed empirically:
 *   {"type":"thread.started","thread_id":"…"}
 *   {"type":"turn.started"}
 *   {"type":"item.started",  "item":{"id","type":"command_execution","command","status":"in_progress",…}}
 *   {"type":"item.completed","item":{"id","type":"command_execution","command","exit_code","status":"completed",…}}
 *   {"type":"item.completed","item":{"id","type":"agent_message","text":"…"}}   ← final answer
 *   {"type":"item.completed","item":{"id","type":"error","message":"…"}}        ← warning OR fatal
 *   {"type":"turn.completed","usage":{"input_tokens","cached_input_tokens","output_tokens","reasoning_output_tokens"}}
 *
 * Mapping to the pi contract:
 *   - output      = text of the LAST `agent_message` item
 *   - usage.input = input_tokens; usage.output = output_tokens + reasoning_output_tokens;
 *     usage.cacheRead = cached_input_tokens; turns = number of `turn.completed`
 *   - lastActivity for streaming = latest agent_message text or a one-line
 *     command summary
 *   - benign warnings (the "Under-development features" / "Skill descriptions"
 *     notices) are NOT treated as failures — only a fatal error item or a
 *     non-zero exit is.
 *
 * Process handling (idle watchdog, abort, signal-kill detection, stderr cap,
 * error sanitization) mirrors the pi runner so behavior is uniform across hosts.
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

/** Same idle window as the pi runner: a child silent this long is wedged. */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

/** Benign codex `error` items that are warnings, not failures. Matched as a
 *  prefix/substring so version drift in the message tail still classifies. */
const BENIGN_ERROR_MARKERS = [
	"Under-development features",
	"Skill descriptions were shortened",
];

function isBenignCodexError(message: string): boolean {
	return BENIGN_ERROR_MARKERS.some((m) => message.includes(m));
}

/** Accumulated state folded from a codex JSONL event stream. */
export interface CodexAccumulator {
	usage: UsageStats;
	model?: string;
	/** Final answer = text of the last agent_message item seen. */
	finalText: string;
	lastActivity: string;
	/** Set when a fatal (non-benign) error item is seen. */
	fatalError?: string;
}

export function newCodexAccumulator(model?: string): CodexAccumulator {
	return { usage: emptyUsage(), model, finalText: "", lastActivity: "" };
}

function shortCmd(cmd: unknown): string {
	const s = String(cmd ?? "").replace(/\s+/g, " ").trim();
	return s.length > 64 ? `${s.slice(0, 64)}…` : s;
}

/**
 * Fold one codex JSONL line into the accumulator. Returns a LiveUpdate when the
 * stream produced new activity (for streaming), else null. Empty/malformed
 * lines are ignored — robust to partial buffers and noise, unit-testable
 * without spawning a process.
 */
export function foldCodexEventLine(acc: CodexAccumulator, line: string): LiveUpdate | null {
	if (!line.trim()) return null;
	let event: any;
	try {
		event = JSON.parse(line);
	} catch {
		return null;
	}
	let activity = "";

	if (event.type === "turn.completed" && event.usage) {
		const u = event.usage;
		acc.usage.turns++;
		acc.usage.input += u.input_tokens || 0;
		acc.usage.output += (u.output_tokens || 0) + (u.reasoning_output_tokens || 0);
		acc.usage.cacheRead += u.cached_input_tokens || 0;
		// contextTokens is a host-specific point-in-time gauge (NOT additive — excluded from aggregateUsage):
		// each host's formula differs because each accounts for cache differently. Codex's input_tokens
		// already includes cached tokens, so input+output = full last-turn context.
		acc.usage.contextTokens = (u.input_tokens || 0) + (u.output_tokens || 0);
	} else if (event.type === "item.completed" || event.type === "item.started") {
		const item = event.item;
		if (!item) return null;
		switch (item.type) {
			case "agent_message":
				if (typeof item.text === "string" && item.text.trim()) {
					// Final answer is the LAST agent_message; keep overwriting.
					if (event.type === "item.completed") acc.finalText = item.text;
					activity = item.text.trim();
				}
				break;
			case "command_execution":
				activity = `$ ${shortCmd(item.command)}`;
				break;
			case "error":
				if (typeof item.message === "string" && !isBenignCodexError(item.message)) {
					acc.fatalError = item.message;
					activity = `error: ${item.message}`;
				}
				break;
			default:
				// file_change / reasoning / mcp_tool_call / etc. — note generically.
				if (typeof item.type === "string") activity = item.type;
		}
	} else {
		return null; // thread.started / turn.started — nothing to fold.
	}

	if (activity) acc.lastActivity = activity.replace(/\s+/g, " ").trim();
	return { text: acc.lastActivity, usage: { ...acc.usage }, model: acc.model };
}

/** Override the codex binary (tests / unusual installs). */
function codexBin(): string {
	return process.env.PI_TASKFLOW_CODEX_BIN || "codex";
}

/**
 * Map a phase's tool whitelist to a codex sandbox mode. Codex has no per-tool
 * whitelist; it has sandbox policies. The conservative mapping: a phase that
 * only reads (no write/edit/bash in its whitelist) gets `read-only`; anything
 * else gets `workspace-write`. No whitelist → workspace-write (the engine's
 * default-capable agent). `danger-full-access` is never selected automatically.
 */
function sandboxForTools(tools: string[] | undefined): "read-only" | "workspace-write" {
	if (!tools || tools.length === 0) return "workspace-write";
	const mutating = new Set(["write", "edit", "bash", "apply_patch"]);
	const canMutate = tools.some((t) => mutating.has(t));
	return canMutate ? "workspace-write" : "read-only";
}

/**
 * Run a single subagent task via `codex exec --json`. Resolves the agent from
 * `agents` by name; returns the same structured `RunResult` the pi runner does.
 */
export async function runCodexAgentTask(
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
	const sandbox = sandboxForTools(tools);
	void globalThinking; // codex has no thinking-level flag on exec; reserved.

	// The agent.model comes from the shared modelRoles table, which is written in
	// the pi provider format (e.g. "openrouter/deepseek/...", "anthropic/glm-5.2:xhigh"
	// — note the `/` provider prefix and `:thinking` suffix). Those ids are pi's
	// namespacing and Codex does not recognise them ("Model metadata for ... not
	// found"). Codex model ids are flat (e.g. "gpt-5.5", "claude-sonnet-4-6"). So:
	// if the resolved model still looks like a pi-provider path (contains "/"),
	// drop it and let `codex exec` fall back to its own configured default model.
	// A user who wants a specific Codex model can set it directly (no "/") and it
	// will be passed through. Likewise an unresolved {{placeholder}} is dropped.
	const codexModel = model && !model.includes("/") && !/^\{\{.*\}\}$/.test(model) ? model : undefined;

	// codex exec [PROMPT] --json --skip-git-repo-check -s <sandbox> [-m model] [-C cwd]
	// The agent's system prompt is prepended to the task as guidance, since
	// `codex exec` has no separate append-system-prompt flag. We keep it compact.
	const fullPrompt = agent.systemPrompt.trim()
		? `${agent.systemPrompt.trim()}\n\n---\n\nTask: ${task}`
		: `Task: ${task}`;

	const args: string[] = ["exec", "--json", "--skip-git-repo-check", "-s", sandbox];
	if (codexModel) args.push("-m", codexModel);
	const cwd = opts.cwd ?? defaultCwd;
	if (cwd) args.push("-C", cwd);
	args.push(fullPrompt);

	const acc = newCodexAccumulator(model);
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

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(codexBin(), args, {
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
			const live = foldCodexEventLine(acc, line);
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
 * The Codex host's `SubagentRunner`. Drops into `RuntimeDeps.runTask` exactly
 * like `piSubagentRunner`, so the engine runs unchanged on Codex.
 */
export const codexSubagentRunner: SubagentRunner<AgentConfig> = {
	runTask: runCodexAgentTask,
};
