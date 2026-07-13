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
 * error sanitization) is delegated to the shared `runSubagentProcess` in
 * taskflow-core, so behavior is uniform across hosts.
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
import { filteredChildEnv } from "./child-env.ts";

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
	terminalSeen?: boolean;
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

	if (event.type === "turn.completed") {
		acc.terminalSeen = true;
		const u = event.usage;
		if (u) {
			acc.usage.turns++;
			acc.usage.input += num(u.input_tokens);
			acc.usage.output += num(u.output_tokens) + num(u.reasoning_output_tokens);
			acc.usage.cacheRead += num(u.cached_input_tokens);
			// contextTokens is a host-specific point-in-time gauge (NOT additive — excluded from aggregateUsage):
			// each host's formula differs because each accounts for cache differently. Codex's input_tokens
			// already includes cached tokens, so input+output = full last-turn context.
			acc.usage.contextTokens = num(u.input_tokens) + num(u.output_tokens);
		}
	} else if (event.type === "turn.failed" || event.type === "error") {
		const message =
			(typeof event.error?.message === "string" && event.error.message) ||
			(typeof event.message === "string" && event.message) ||
			"codex turn failed";
		acc.fatalError = message;
		activity = `error: ${message}`;
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
export function codexBin(): string {
	return process.env.PI_TASKFLOW_CODEX_BIN || "codex";
}

export function codexChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return filteredChildEnv(source, ["CODEX_HOME"], ["CODEX_", "OPENAI_", "AZURE_OPENAI_"]);
}

/**
 * Map a phase's tool whitelist to a codex sandbox mode. Codex has no per-tool
 * whitelist; it has sandbox policies. The conservative mapping: a phase that
 * only reads (no write/edit/bash in its whitelist) gets `read-only`; anything
 * else gets `workspace-write`. No whitelist → workspace-write (the engine's
 * default-capable agent). `danger-full-access` is never selected automatically.
 */
export function sandboxForTools(tools: string[] | undefined): "read-only" | "workspace-write" {
	if (!tools || tools.length === 0) return "workspace-write";
	const mutating = new Set(["write", "edit", "bash", "apply_patch"]);
	const canMutate = tools.some((t) => mutating.has(t));
	return canMutate ? "workspace-write" : "read-only";
}

/** Resolve a modelRoles/pi model id for `codex exec -m`, or `undefined` to let
 *  codex fall back to its own default. Codex model ids are FLAT (e.g.
 *  "gpt-5.5"), so a pi-provider path (contains "/") or an unresolved role
 *  placeholder ({{...}}) is dropped. Exported so the model-id contract is
 *  unit-testable without a live codex session. */
export function resolveCodexModel(model: string | undefined): string | undefined {
	if (!model) return undefined;
	if (model.includes("/")) return undefined;
	if (/^\{\{.*\}\}$/.test(model)) return undefined;
	return model;
}

/** Map Taskflow/Pi thinking levels to Codex's model_reasoning_effort config. */
export function resolveCodexThinking(thinking: string | undefined): string | undefined {
	if (!thinking) return undefined;
	const normalized = thinking.trim().toLowerCase();
	if (normalized === "off" || normalized === "none" || normalized === "minimal") return "none";
	if (normalized === "max" || normalized === "ultra") return "xhigh";
	if (["low", "medium", "high", "xhigh"].includes(normalized)) return normalized;
	throw new Error(
		`Unsupported Codex thinking level '${thinking}'. Use off, none, minimal, low, medium, high, xhigh, max, or ultra.`,
	);
}

/** Context for {@link buildCodexArgs} — the pure inputs to argv construction. */
export interface CodexArgsCtx {
	systemPrompt: string;
	task: string;
	/** Already-resolved model (opts.model ?? agent.model). */
	model?: string;
	/** Already-resolved thinking level (opts.thinking ?? agent.thinking ?? global). */
	thinking?: string;
	tools?: string[];
	cwd?: string;
}

/**
 * Build the full `codex exec` argv from a phase's resolved context — PURE
 * (no process.env, no spawn). Extracted from `runCodexAgentTask` so the host's
 * CLI flag contract is unit-testable in CI without a live codex session.
 *
 *   codex exec --json --skip-git-repo-check -s <sandbox>
 *        [-m model] [-c model_reasoning_effort=level] [-C cwd] <prompt>
 */
export function buildCodexArgs(ctx: CodexArgsCtx): string[] {
	const sandbox = sandboxForTools(ctx.tools);
	const codexModel = resolveCodexModel(ctx.model);
	const codexThinking = resolveCodexThinking(ctx.thinking);
	const fullPrompt = ctx.systemPrompt.trim()
		? `${ctx.systemPrompt.trim()}\n\n---\n\nTask: ${ctx.task}`
		: `Task: ${ctx.task}`;
	const args: string[] = [
		"exec",
		"--json",
		"--ephemeral",
		"--ignore-user-config",
		"--ignore-rules",
		"--skip-git-repo-check",
		"-c",
		"mcp_servers={}",
		"-s",
		sandbox,
	];
	if (codexModel) args.push("-m", codexModel);
	if (codexThinking) args.push("-c", `model_reasoning_effort=${codexThinking}`);
	if (ctx.cwd) args.push("-C", ctx.cwd);
	args.push(fullPrompt);
	return args;
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
	if (!agent) return unknownAgentResult(agentName, task, agents);

	const model = opts.model ?? agent.model;
	const tools = opts.tools ?? agent.tools;
	const thinking = opts.thinking ?? agent.thinking ?? globalThinking;

	const cwd = opts.cwd ?? defaultCwd;
	let args: string[];
	try {
		args = buildCodexArgs({
			systemPrompt: agent.systemPrompt,
			task,
			model,
			thinking,
			tools,
			cwd,
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
			stopReason: "error",
			errorMessage: message,
		};
	}

	return runSubagentProcess({
		agent: agentName,
		task,
		model,
		bin: codexBin(),
		args,
		env: codexChildEnv(),
		cwd,
		idleTimeoutMs: opts.idleTimeoutMs,
		signal: opts.signal,
		onLive: opts.onLive,
		acc: newCodexAccumulator(model),
		foldLine: foldCodexEventLine,
		requireTerminalEvent: true,
		terminalEventLabel: "Codex turn.completed",
	});
}

/**
 * The Codex host's `SubagentRunner`. Drops into `RuntimeDeps.runTask` exactly
 * like the pi/codex/claude/opencode runners, so the engine runs unchanged on Codex.
 */
export const codexSubagentRunner: SubagentRunner<AgentConfig> = {
	runTask: runCodexAgentTask,
	usageAccounting: "tokens-only",
};

(runCodexAgentTask as typeof runCodexAgentTask & { usageAccounting: "tokens-only" }).usageAccounting = "tokens-only";
