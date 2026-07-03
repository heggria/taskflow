/**
 * OpenCode subagent runner — the OpenCode host's `SubagentRunner` implementation.
 *
 * Spawns an isolated `opencode run --format json` process per task and folds its
 * JSON event stream into the same host-neutral `RunResult` the pi, codex, and
 * claude runners produce, so the engine (runtime.ts) treats an OpenCode subagent
 * identically.
 *
 * Real opencode `run --format json` schema (opencode ≥ 1.17), observed
 * empirically — one JSON object per line:
 *   {"type":"step_start", "part":{"type":"step-start",…}}
 *   {"type":"text",       "part":{"type":"text","text":"…"}}          ← assistant text
 *   {"type":"tool_use",   "part":{"type":"tool","tool":"bash",
 *       "state":{"status":"completed","input":{"command":"…"},"title":"…"}}}
 *   {"type":"step_finish","part":{"type":"step-finish","reason":"stop"|"tool-calls",
 *       "tokens":{"total","input","output","reasoning","cache":{"read","write"}},"cost":0}}
 *   {"type":"error",      "error":{"name":"…","data":{"message":"…"}}}  ← fatal
 *
 * Mapping to the host-neutral contract:
 *   - output       = accumulated `text` parts of the LAST step (text before a
 *                    tool call is intermediate reasoning → reset on tool_use)
 *   - usage.input  = Σ step tokens.input; usage.output = Σ (output + reasoning);
 *     cacheRead/cacheWrite from tokens.cache; cost = Σ part.cost;
 *     turns = number of step_finish events; contextTokens = latest tokens.total
 *   - failure      = an `error` event, or a non-zero exit
 *
 * Permission mapping (the codex `sandboxForTools` analogue): OpenCode has no
 * per-run tool-whitelist flag, but it honours a per-process config injected via
 * the `OPENCODE_CONFIG_CONTENT` env var. A read-only phase (no write/edit/bash
 * in its whitelist) is launched with a permission policy that DENIES
 * bash/write/edit — genuinely enforced (a denied tool call is rejected, not
 * merely un-approved). A mutating phase (or no whitelist) runs with `--auto`
 * (auto-approve every permission), the workspace-write analogue.
 *
 * Process handling (idle watchdog, abort, signal-kill detection, stderr cap,
 * error sanitization) mirrors the other runners so behavior is uniform.
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

/** Same idle window as the other runners: a child silent this long is wedged. */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

/** The permission policy injected (via OPENCODE_CONFIG_CONTENT) for a read-only
 *  phase: deny every mutating capability so a listed-tools phase without
 *  write/edit/bash cannot change the workspace. */
const READ_ONLY_CONFIG = JSON.stringify({ permission: { bash: "deny", write: "deny", edit: "deny" } });

/** Accumulated state folded from an opencode JSON event stream. */
export interface OpencodeAccumulator {
	usage: UsageStats;
	model?: string;
	/** Final answer = text parts of the last step (reset when a tool runs). */
	finalText: string;
	lastActivity: string;
	/** Set when the stream reported a fatal `error` event. */
	fatalError?: string;
}

export function newOpencodeAccumulator(model?: string): OpencodeAccumulator {
	return { usage: emptyUsage(), model, finalText: "", lastActivity: "" };
}

function shortTool(part: any): string {
	const tool = String(part?.tool ?? "tool");
	const cmd = part?.state?.input?.command;
	if (tool === "bash" && typeof cmd === "string" && cmd.trim()) {
		const s = cmd.replace(/\s+/g, " ").trim();
		return `$ ${s.length > 64 ? `${s.slice(0, 64)}…` : s}`;
	}
	const title = part?.state?.title;
	if (typeof title === "string" && title.trim()) return `${tool}: ${title.trim()}`;
	return tool;
}

/**
 * Fold one opencode JSON line into the accumulator. Returns a LiveUpdate when
 * the stream produced new activity (for streaming), else null. Empty/malformed
 * lines are ignored — robust to partial buffers and noise, unit-testable
 * without spawning a process.
 */
export function foldOpencodeEventLine(acc: OpencodeAccumulator, line: string): LiveUpdate | null {
	if (!line.trim()) return null;
	let event: any;
	try {
		event = JSON.parse(line);
	} catch {
		return null;
	}
	let activity = "";
	const part = event.part;

	switch (event.type) {
		case "text":
			if (part && typeof part.text === "string" && part.text) {
				// Text parts stream; concatenate within the current step. A tool call
				// (below) resets this, so only the LAST step's text is the answer.
				acc.finalText += part.text;
				activity = acc.finalText.trim();
			}
			break;
		case "tool_use":
			// A tool call means any text so far was intermediate reasoning, not the
			// final answer — drop it and keep only text that follows the last tool.
			acc.finalText = "";
			if (part) activity = shortTool(part);
			break;
		case "step_finish": {
			acc.usage.turns++;
			const tk = part?.tokens;
			if (tk) {
				acc.usage.input += tk.input || 0;
				acc.usage.output += (tk.output || 0) + (tk.reasoning || 0);
				acc.usage.cacheRead += tk.cache?.read || 0;
				acc.usage.cacheWrite += tk.cache?.write || 0;
				acc.usage.contextTokens = tk.total || acc.usage.contextTokens;
			}
			if (typeof part?.cost === "number") acc.usage.cost += part.cost;
			break;
		}
		case "error": {
			const msg =
				(event.error?.data?.message && String(event.error.data.message)) ||
				(event.error?.name && String(event.error.name)) ||
				"opencode run failed";
			acc.fatalError = msg;
			activity = `error: ${msg}`;
			break;
		}
		default:
			return null; // step_start / other — nothing to fold.
	}

	if (activity) acc.lastActivity = activity.replace(/\s+/g, " ").trim();
	return { text: acc.lastActivity, usage: { ...acc.usage }, model: acc.model };
}

/** Override the opencode binary (tests / unusual installs). */
function opencodeBin(): string {
	return process.env.PI_TASKFLOW_OPENCODE_BIN || "opencode";
}

/**
 * Decide whether a phase is read-only from its tool whitelist — the codex
 * `sandboxForTools` analogue. No whitelist → not read-only (default-capable).
 */
export function isReadOnlyPhase(tools: string[] | undefined): boolean {
	if (!tools || tools.length === 0) return false;
	const mutating = new Set(["write", "edit", "bash", "apply_patch"]);
	return !tools.some((t) => mutating.has(t));
}

/**
 * Resolve a taskflow/pi model id to something `opencode run -m` accepts, or
 * `undefined` to let opencode use its configured default.
 *
 * Unlike codex/claude (whose model ids are flat, so "contains `/`" ⇒ a pi
 * provider path to drop), a *valid* opencode model IS `provider/model` (one
 * slash). So we only drop ids that clearly aren't opencode models:
 *   - an unresolved role placeholder `{{fast}}`
 *   - a pi thinking suffix (`…:xhigh`)
 *   - a multi-segment openrouter path (`openrouter/vendor/model`, ≥ 2 slashes)
 * A clean `provider/model` passes straight through.
 */
export function resolveOpencodeModel(model: string | undefined): string | undefined {
	if (!model) return undefined;
	if (/^\{\{.*\}\}$/.test(model)) return undefined; // unresolved role placeholder
	if (model.includes(":")) return undefined; // pi thinking suffix
	if ((model.match(/\//g)?.length ?? 0) >= 2) return undefined; // openrouter path
	return model;
}

/**
 * Run a single subagent task via `opencode run --format json`. Resolves the
 * agent from `agents` by name; returns the same structured `RunResult` the pi,
 * codex, and claude runners do.
 */
export async function runOpencodeAgentTask(
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
	void globalThinking; // opencode's --variant is provider-specific; reserved.

	const opencodeModel = resolveOpencodeModel(model);
	const readOnly = isReadOnlyPhase(tools);

	// opencode run has no --append-system-prompt, so (like codex) the agent's
	// system prompt is prepended to the task as guidance.
	const fullPrompt = agent.systemPrompt.trim()
		? `${agent.systemPrompt.trim()}\n\n---\n\nTask: ${task}`
		: `Task: ${task}`;

	const cwd = opts.cwd ?? defaultCwd;
	// opencode run [message] --format json --dir <cwd> [-m model] [--auto]
	// A read-only phase omits --auto and instead injects a deny-mutations policy
	// via OPENCODE_CONFIG_CONTENT; a mutating phase auto-approves with --auto.
	const args: string[] = ["run", fullPrompt, "--format", "json"];
	if (cwd) args.push("--dir", cwd);
	if (opencodeModel) args.push("-m", opencodeModel);
	if (!readOnly) args.push("--auto");

	const env: NodeJS.ProcessEnv = { ...process.env };
	if (readOnly) env.OPENCODE_CONFIG_CONTENT = READ_ONLY_CONFIG;

	const acc = newOpencodeAccumulator(model);
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
		const proc = spawn(opencodeBin(), args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env,
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
			const live = foldOpencodeEventLine(acc, line);
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
 * The OpenCode host's `SubagentRunner`. Drops into `RuntimeDeps.runTask` exactly
 * like the pi/codex/claude runners, so the engine runs unchanged on OpenCode.
 */
export const opencodeSubagentRunner: SubagentRunner<AgentConfig> = {
	runTask: runOpencodeAgentTask,
};
