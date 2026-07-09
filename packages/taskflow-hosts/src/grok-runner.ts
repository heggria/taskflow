/**
 * Grok Build subagent runner — the Grok host's `SubagentRunner` implementation.
 *
 * Spawns an isolated `grok -p --output-format streaming-json` process per task
 * and folds its NDJSON event stream into the same host-neutral `RunResult` the
 * pi/codex/claude/opencode runners produce, so the engine (runtime.ts) treats a
 * Grok subagent identically.
 *
 * Official headless streaming-json schema (docs.x.ai / ~/.grok/docs/user-guide/14-headless-mode.md):
 *   {"type":"text","data":"…"}                         ← response text chunk
 *   {"type":"thought","data":"…"}                      ← reasoning (not answer)
 *   {"type":"end","stopReason":"EndTurn","sessionId":"…","requestId":"…"}
 *   {"type":"error","message":"…"}                     ← fatal
 *   (also non-exhaustive: max_turns_reached, auto_compact_*, …)
 *
 * Mapping to the host-neutral contract:
 *   - output       = concatenated `text` event data (final answer)
 *   - lastActivity = latest text/thought chunk or end/error summary
 *   - usage        = zeros today (streaming-json does not emit token/cost fields;
 *                    fill via rates.ts post-hoc when wiring batch 2 budgets)
 *   - failure      = an `error` event, or a non-zero process exit
 *
 * Permission mapping (codex `sandboxForTools` analogue):
 *   - read-only whitelist → `--tools read_file,grep,list_dir,web_search,web_fetch`
 *     (mutating tools removed from the available set)
 *   - mutating / no whitelist → `--always-approve` so non-interactive -p never
 *     hangs on a permission prompt
 *
 * Process handling (idle watchdog, abort, signal-kill, stderr cap, sanitize)
 * is delegated to shared `runSubagentProcess` in taskflow-core.
 *
 * @see https://docs.x.ai/build/overview
 * @see ~/.grok/docs/user-guide/14-headless-mode.md
 * @see ~/.grok/docs/user-guide/07-mcp-servers.md
 * @see ~/.grok/docs/user-guide/09-plugins.md
 */

import {
	runSubagentProcess,
	unknownAgentResult,
	type AgentConfig,
	type LiveUpdate,
	type RunOptions,
	type RunResult,
	type SubagentRunner,
	type UsageStats,
} from "taskflow-core";
import { emptyUsage } from "taskflow-core";

/**
 * Grok built-in tool ids a read-only phase may use (from headless docs:
 * `read_file`, `grep`, `list_dir`, `web_search`, `web_fetch`). Shell and edit
 * tools are excluded so a listed-tools phase without write/edit/bash cannot
 * mutate the workspace.
 */
const READ_ONLY_TOOLS = ["read_file", "grep", "list_dir", "web_search", "web_fetch"];

/** Accumulated state folded from a Grok streaming-json event stream. */
export interface GrokAccumulator {
	usage: UsageStats;
	model?: string;
	/** Final answer = concatenation of all `text` event `data` chunks. */
	finalText: string;
	lastActivity: string;
	/** Set when the stream reported a fatal `error` event. */
	fatalError?: string;
	/** stopReason from the terminal `end` event, if any. */
	stopReason?: string;
	/** sessionId from the terminal `end` event (useful for resume diagnostics). */
	sessionId?: string;
}

export function newGrokAccumulator(model?: string): GrokAccumulator {
	return { usage: emptyUsage(), model, finalText: "", lastActivity: "" };
}

/**
 * Fold one Grok streaming-json NDJSON line into the accumulator. Returns a
 * LiveUpdate when the stream produced new activity, else null. Empty/malformed
 * lines are ignored — robust to partial buffers and noise, unit-testable
 * without spawning a process.
 */
export function foldGrokEventLine(acc: GrokAccumulator, line: string): LiveUpdate | null {
	if (!line.trim()) return null;
	let event: Record<string, unknown>;
	try {
		event = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return null;
	}
	let activity = "";
	const type = typeof event.type === "string" ? event.type : "";

	switch (type) {
		case "text": {
			const data = typeof event.data === "string" ? event.data : "";
			if (data) {
				acc.finalText += data;
				activity = data.trim() || acc.finalText.trim();
			}
			break;
		}
		case "thought": {
			const data = typeof event.data === "string" ? event.data : "";
			if (data.trim()) activity = data.trim();
			break;
		}
		case "end": {
			if (typeof event.stopReason === "string") acc.stopReason = event.stopReason;
			if (typeof event.sessionId === "string") acc.sessionId = event.sessionId;
			// Some builds may put the full text on the end event as a convenience.
			if (typeof event.text === "string" && event.text.trim() && !acc.finalText.trim()) {
				acc.finalText = event.text;
			}
			activity = acc.finalText.trim() || `end:${acc.stopReason ?? "unknown"}`;
			break;
		}
		case "error": {
			const msg =
				(typeof event.message === "string" && event.message.trim()) ||
				(typeof event.data === "string" && event.data.trim()) ||
				"grok run failed";
			acc.fatalError = msg;
			activity = `error: ${msg}`;
			break;
		}
		default:
			// max_turns_reached / auto_compact_* / unknown — ignore for fold.
			return null;
	}

	if (activity) acc.lastActivity = activity.replace(/\s+/g, " ").trim();
	return { text: acc.lastActivity, usage: { ...acc.usage }, model: acc.model };
}

/** Override the grok binary (tests / unusual installs). */
export function grokBin(): string {
	return process.env.PI_TASKFLOW_GROK_BIN || "grok";
}

/**
 * Map a phase's tool whitelist to Grok headless permission flags.
 *
 * - no whitelist / mutating tools → `--always-approve` (non-interactive cannot
 *   answer permission prompts; equivalent to codex workspace-write / claude
 *   bypassPermissions — WITHOUT an OS sandbox backstop)
 * - read-only whitelist → `--tools <read-only set>` so write/shell tools are
 *   not available at all (still pairs with `--always-approve` so remaining
 *   tools never block on confirm)
 */
export function permissionArgsForGrokTools(tools: string[] | undefined): string[] {
	if (!tools || tools.length === 0) return ["--always-approve"];
	const mutating = new Set(["write", "edit", "bash", "apply_patch", "run_terminal_cmd", "search_replace"]);
	const canMutate = tools.some((t) => mutating.has(t));
	if (canMutate) return ["--always-approve"];
	return ["--tools", READ_ONLY_TOOLS.join(","), "--always-approve"];
}

/**
 * Resolve a modelRoles/pi model id for `grok -m`, or `undefined` to let Grok
 * use its configured default. Drop pi-provider paths (contain `/` with more
 * than one segment is rare for grok; a single slash may be a custom model id
 * from config.toml `[model.x]`) and unresolved `{{placeholder}}`s.
 *
 * Grok custom models are flat keys in `~/.grok/config.toml` (e.g. `my-model`,
 * `grok-build`); pi-style `provider/model` paths are not valid Grok model ids
 * unless the user defined them literally.
 */
export function resolveGrokModel(model: string | undefined): string | undefined {
	if (!model) return undefined;
	if (/^\{\{.*\}\}$/.test(model)) return undefined;
	// Drop openrouter multi-segment paths (openrouter/vendor/model).
	if ((model.match(/\//g)?.length ?? 0) >= 2) return undefined;
	// Drop pi thinking suffixes.
	if (/:\s*(?:xhigh|high|medium|low|off)$/.test(model)) return undefined;
	return model;
}

/** Context for {@link buildGrokArgs} — pure inputs to argv construction. */
export interface GrokArgsCtx {
	systemPrompt: string;
	task: string;
	/** Already-resolved model (opts.model ?? agent.model). */
	model?: string;
	tools?: string[];
	cwd?: string;
}

/**
 * Build the full `grok -p` argv from a phase's resolved context — PURE
 * (no process.env, no spawn). Extracted so the host's CLI flag contract is
 * unit-testable in CI without a live Grok session.
 *
 *   grok -p <task> --output-format streaming-json
 *        [--always-approve | --tools … --always-approve]
 *        [--model m] [--cwd dir] [--rules systemPrompt]
 */
export function buildGrokArgs(ctx: GrokArgsCtx): string[] {
	const grokModel = resolveGrokModel(ctx.model);
	const args: string[] = ["-p", ctx.task, "--output-format", "streaming-json"];
	args.push(...permissionArgsForGrokTools(ctx.tools));
	if (grokModel) args.push("-m", grokModel);
	if (ctx.cwd) args.push("--cwd", ctx.cwd);
	if (ctx.systemPrompt.trim()) args.push("--rules", ctx.systemPrompt.trim());
	return args;
}

/**
 * Run a single subagent task via `grok -p --output-format streaming-json`.
 * Resolves the agent from `agents` by name; returns the same structured
 * `RunResult` the other host runners do.
 */
export async function runGrokAgentTask(
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
	void globalThinking; // grok -p has no thinking-level flag; reserved.

	const cwd = opts.cwd ?? defaultCwd;
	const args = buildGrokArgs({
		systemPrompt: agent.systemPrompt,
		task,
		model,
		tools,
		cwd,
	});

	return runSubagentProcess({
		agent: agentName,
		task,
		model,
		bin: grokBin(),
		args,
		cwd,
		idleTimeoutMs: opts.idleTimeoutMs,
		signal: opts.signal,
		onLive: opts.onLive,
		acc: newGrokAccumulator(model),
		foldLine: foldGrokEventLine,
	});
}

/**
 * The Grok host's `SubagentRunner`. Drops into `RuntimeDeps.runTask` exactly
 * like the other host runners, so the engine runs unchanged on Grok Build.
 */
export const grokSubagentRunner: SubagentRunner<AgentConfig> = {
	runTask: runGrokAgentTask,
};
