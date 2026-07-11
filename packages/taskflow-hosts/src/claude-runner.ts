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
 * OS-level sandbox in -p mode — a tool call is either whitelisted or denied.
 * Read-only and unspecified tool sets get an explicit read-only allowlist.
 * Mutating or unknown tools fail closed unless the user explicitly opts into
 * unsandboxed execution with PI_TASKFLOW_CLAUDE_UNSAFE_BYPASS=1.
 *
 * Process handling (idle watchdog, abort, signal-kill detection, stderr cap,
 * error sanitization) mirrors the pi/codex runners so behavior is uniform.
 */

import {
	runSubagentProcess,
	sanitizeErrorMessage,
	num,
	unknownAgentResult,
	type AgentConfig,
	type LiveUpdate,
	type RunOptions,
	type RunResult,
	type SubagentRunner,
	type UsageStats,
} from "taskflow-core";
import { emptyUsage } from "taskflow-core";

/** The Claude tools a read-only phase may use. `Bash` is excluded — Claude has
 *  no read-only shell (unlike codex's read-only OS sandbox, which still allows
 *  read-only commands), so a listed-tools phase without write/edit/bash gets
 *  file reads + search + web only. */
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "WebFetch", "WebSearch"];
const READ_ONLY_TOOL_REQUESTS = new Set([
	"read",
	"grep",
	"glob",
	"find",
	"ls",
	"webfetch",
	"websearch",
]);

/** Environment inherited by the Claude process. Keep platform/runtime settings,
 * proxy/CA configuration, and credentials for Claude's supported providers;
 * drop unrelated application secrets (for example OPENAI_API_KEY, npm tokens,
 * database passwords) from the default child boundary. */
const CLAUDE_ENV_KEYS = new Set([
	"ALL_PROXY",
	"APPDATA",
	"COLORTERM",
	"COMSPEC",
	"FORCE_COLOR",
	"HOME",
	"HOMEDRIVE",
	"HOMEPATH",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LOCALAPPDATA",
	"LOGNAME",
	"NODE_EXTRA_CA_CERTS",
	"NO_COLOR",
	"NO_PROXY",
	"PATH",
	"PATHEXT",
	"SHELL",
	"SSL_CERT_DIR",
	"SSL_CERT_FILE",
	"SYSTEMROOT",
	"TEMP",
	"TERM",
	"TMP",
	"TMPDIR",
	"USER",
	"USERPROFILE",
	"WINDIR",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
]);
const CLAUDE_ENV_PREFIXES = [
	"ANTHROPIC_",
	"AWS_",
	"AZURE_",
	"CLAUDE_CODE_",
	"CLOUD_ML_",
	"GCLOUD_",
	"GOOGLE_",
	"VERTEX_",
];

/** Explicit user-level acknowledgement required before Claude may run tools
 * without an OS sandbox or interactive permission prompts. */
export const CLAUDE_UNSAFE_BYPASS_ENV = "PI_TASKFLOW_CLAUDE_UNSAFE_BYPASS";

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

/** Summarize a claude tool_use for the live activity stream — parity with the
 *  pi runner's summarizeToolCall and codex's shortCmd (which cover all tools,
 *  not just Bash). Without this a Write/Edit/Read shows as just the bare tool
 *  name, a UX regression vs the other hosts. */
function shortTool(name: unknown, input: unknown): string {
	const n = String(name ?? "tool");
	if (!input || typeof input !== "object") return n;
	const obj = input as Record<string, unknown>;
	const trim = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
	const brief = (v: unknown) => {
		const s = trim(v);
		return s.length > 64 ? `${s.slice(0, 64)}…` : s;
	};
	switch (n) {
		case "Bash":
			return `$ ${brief(obj.command)}`;
		case "Read":
		case "Write":
		case "Edit":
		case "NotebookEdit":
			return `${n}: ${brief(obj.file_path ?? obj.path)}`;
		case "Grep":
		case "Glob":
			return `${n}: ${brief(obj.pattern)}`;
		default:
			return n;
	}
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
			acc.usage.input += num(u.input_tokens);
			acc.usage.output += num(u.output_tokens);
			acc.usage.cacheRead += num(u.cache_read_input_tokens);
			acc.usage.cacheWrite += num(u.cache_creation_input_tokens);
			// contextTokens is a host-specific gauge (NOT additive): claude reports input_tokens
			// EXCLUDING cache read, so input+cache_read+output = full last-turn context.
			acc.usage.contextTokens =
				num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.output_tokens);
		}
	} else if (event.type === "result") {
		acc.sawResult = true;
		const u = event.usage;
		if (u) {
			const prev = acc.usage.contextTokens;
			acc.usage = emptyUsage();
			acc.usage.input = num(u.input_tokens);
			acc.usage.output = num(u.output_tokens);
			acc.usage.cacheRead = num(u.cache_read_input_tokens);
			acc.usage.cacheWrite = num(u.cache_creation_input_tokens);
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
export function claudeBin(): string {
	return process.env.PI_TASKFLOW_CLAUDE_BIN || "claude";
}

/**
 * Map a phase's tool whitelist to Claude permission flags. Unspecified and
 * known read-only tool sets are always restricted to the read-only allowlist.
 * Mutating and unknown tools need an explicit caller acknowledgement; this
 * function never reads process.env so argv construction remains pure.
 */
export function permissionArgsForTools(
	tools: string[] | undefined,
	allowUnsafeBypass = false,
): string[] {
	const requestsUnsafeAccess = tools?.some(
		(t) => !READ_ONLY_TOOL_REQUESTS.has(t.trim().toLowerCase()),
	) ?? false;
	if (requestsUnsafeAccess) {
		if (allowUnsafeBypass) return ["--permission-mode", "bypassPermissions"];
		throw new Error(
			`Claude tools [${tools!.join(", ")}] require unsandboxed permissions. ` +
				`Claude Code has no OS sandbox in non-interactive mode. ` +
				`Set ${CLAUDE_UNSAFE_BYPASS_ENV}=1 to explicitly allow this execution.`,
		);
	}
	return ["--allowedTools", READ_ONLY_TOOLS.join(",")];
}

/** Resolve the explicit process-level opt-in. Only the exact value `1` is
 * accepted so an inherited or accidentally truthy value cannot enable it. */
export function claudeUnsafeBypassEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[CLAUDE_UNSAFE_BYPASS_ENV] === "1";
}

/** Resolve a least-privilege environment for the Claude child process.
 * Provider-specific credentials are retained so API-key, Bedrock, Vertex, and
 * Foundry authentication continue to work; unrelated secrets are omitted. */
export function claudeChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const filtered: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		const normalized = key.toUpperCase();
		if (
			CLAUDE_ENV_KEYS.has(normalized) ||
			CLAUDE_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix))
		) {
			filtered[key] = value;
		}
	}
	return filtered;
}

/** Resolve a modelRoles/pi model id for `claude --model`, or `undefined` to let
 *  claude fall back to its own default. Claude model ids are FLAT (aliases like
 *  "sonnet"/"haiku" or full ids like "claude-sonnet-4-6"), so — same rule as
 *  codex — a pi-provider path (contains "/") or an unresolved {{placeholder}}
 *  is dropped. Exported for unit-testing the contract. */
export function resolveClaudeModel(model: string | undefined): string | undefined {
	if (!model) return undefined;
	if (model.includes("/")) return undefined;
	if (/^\{\{.*\}\}$/.test(model)) return undefined;
	return model;
}

/** Context for {@link buildClaudeArgs} — the pure inputs to argv construction. */
export interface ClaudeArgsCtx {
	systemPrompt: string;
	task: string;
	/** Already-resolved model (opts.model ?? agent.model). */
	model?: string;
	tools?: string[];
	/** Explicit acknowledgement for unsandboxed mutating/unknown tools. */
	allowUnsafeBypass?: boolean;
}

/**
 * Build the full `claude -p` argv from a phase's resolved context — PURE
 * (no process.env, no spawn). Extracted from `runClaudeAgentTask` so the host's
 * CLI flag contract is unit-testable in CI without a live claude session.
 *
 *   claude -p --output-format stream-json --verbose --strict-mcp-config
 *          [--permission-mode bypassPermissions | --allowedTools ...]
 *          [--model m] [--append-system-prompt ...] <task>
 */
export function buildClaudeArgs(ctx: ClaudeArgsCtx): string[] {
	const claudeModel = resolveClaudeModel(ctx.model);
	const args: string[] = ["-p", "--output-format", "stream-json", "--verbose", "--strict-mcp-config"];
	args.push(...permissionArgsForTools(ctx.tools, ctx.allowUnsafeBypass));
	if (claudeModel) args.push("--model", claudeModel);
	if (ctx.systemPrompt.trim()) args.push("--append-system-prompt", ctx.systemPrompt.trim());
	args.push(ctx.task);
	return args;
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
	if (!agent) return unknownAgentResult(agentName, task, agents);

	const model = opts.model ?? agent.model;
	const tools = opts.tools ?? agent.tools;
	void globalThinking; // claude -p has no thinking-level flag; reserved.

	let args: string[];
	try {
		args = buildClaudeArgs({
			systemPrompt: agent.systemPrompt,
			task,
			model,
			tools,
			allowUnsafeBypass: claudeUnsafeBypassEnabled(),
		});
	} catch (error) {
		const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
		return {
			agent: agentName,
			task,
			exitCode: 1,
			output: "",
			stderr: message,
			usage: emptyUsage(),
			model,
			errorMessage: message,
			stopReason: "permission_denied",
		};
	}

	return runSubagentProcess({
		agent: agentName,
		task,
		model,
		bin: claudeBin(),
		args,
		cwd: opts.cwd ?? defaultCwd,
		idleTimeoutMs: opts.idleTimeoutMs,
		signal: opts.signal,
		onLive: opts.onLive,
		env: claudeChildEnv(),
		acc: newClaudeAccumulator(model),
		foldLine: foldClaudeEventLine,
	});
}

/**
 * The Claude host's `SubagentRunner`. Drops into `RuntimeDeps.runTask` exactly
 * like the pi/codex/opencode runners, so the engine runs unchanged on Claude Code.
 */
export const claudeSubagentRunner: SubagentRunner<AgentConfig> = {
	runTask: runClaudeAgentTask,
};
