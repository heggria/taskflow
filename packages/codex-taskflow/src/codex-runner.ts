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
		acc.usage.input += num(u.input_tokens);
		acc.usage.output += num(u.output_tokens) + num(u.reasoning_output_tokens);
		acc.usage.cacheRead += num(u.cached_input_tokens);
		// contextTokens is a host-specific point-in-time gauge (NOT additive — excluded from aggregateUsage):
		// each host's formula differs because each accounts for cache differently. Codex's input_tokens
		// already includes cached tokens, so input+output = full last-turn context.
		acc.usage.contextTokens = num(u.input_tokens) + num(u.output_tokens);
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
	if (!agent) return unknownAgentResult(agentName, task, agents);

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

	return runSubagentProcess({
		agent: agentName,
		task,
		model,
		bin: codexBin(),
		args,
		cwd,
		idleTimeoutMs: opts.idleTimeoutMs,
		signal: opts.signal,
		onLive: opts.onLive,
		acc: newCodexAccumulator(model),
		foldLine: foldCodexEventLine,
	});
}

/**
 * The Codex host's `SubagentRunner`. Drops into `RuntimeDeps.runTask` exactly
 * like the pi/codex/claude/opencode runners, so the engine runs unchanged on Codex.
 */
export const codexSubagentRunner: SubagentRunner<AgentConfig> = {
	runTask: runCodexAgentTask,
};
