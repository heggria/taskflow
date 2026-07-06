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
			acc.usage.input += num(tk.input);
				acc.usage.output += num(tk.output) + num(tk.reasoning);
				acc.usage.cacheRead += num(tk.cache?.read);
				acc.usage.cacheWrite += num(tk.cache?.write);
				// contextTokens is a host-specific gauge (NOT additive): opencode's tokens.total is
				// the full last-turn context (input+output+reasoning), already cache-accounted.
				acc.usage.contextTokens = num(tk.total) || acc.usage.contextTokens;
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
export function opencodeBin(): string {
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
	// pi thinking suffix: `<model>:<level>` (e.g. "anthropic/glm-5.2:xhigh"). Only the
	// colon-delimited form is dropped — a real `:tag` (no level keyword) passes
	// through so opencode itself can reject it with a clear error if invalid.
	if (/:\s*(?:xhigh|high|medium|low|off)$/.test(model)) return undefined;
	if ((model.match(/\//g)?.length ?? 0) >= 2) return undefined; // openrouter path (openrouter/vendor/model)
	return model;
}

/** Context for {@link buildOpencodeArgs} — the pure inputs to argv construction. */
export interface OpencodeArgsCtx {
	systemPrompt: string;
	task: string;
	/** Already-resolved model (opts.model ?? agent.model). */
	model?: string;
	tools?: string[];
	cwd?: string;
}

/** Result of {@link buildOpencodeArgs}: the argv plus whether a read-only
 *  permission policy should be injected via OPENCODE_CONFIG_CONTENT (the env
 *  side-effect is left to the caller, which owns `process.env`). */
export interface OpencodeArgs {
	args: string[];
	/** True for a read-only phase — the caller injects the deny-mutations config. */
	readOnly: boolean;
}

/**
 * Build the full `opencode run` argv from a phase's resolved context — PURE
 * (no process.env, no spawn). Extracted from `runOpencodeAgentTask` so the
 * host's CLI flag contract is unit-testable in CI without a live opencode
 * session. Returns whether the phase is read-only so the caller can inject the
 * matching OPENCODE_CONFIG_CONTENT env without re-deriving it.
 *
 *   opencode run <prompt> --format json [--dir cwd] [-m model] [--auto]
 */
export function buildOpencodeArgs(ctx: OpencodeArgsCtx): OpencodeArgs {
	const opencodeModel = resolveOpencodeModel(ctx.model);
	const readOnly = isReadOnlyPhase(ctx.tools);
	const fullPrompt = ctx.systemPrompt.trim()
		? `${ctx.systemPrompt.trim()}\n\n---\n\nTask: ${ctx.task}`
		: `Task: ${ctx.task}`;
	const args: string[] = ["run", fullPrompt, "--format", "json"];
	if (ctx.cwd) args.push("--dir", ctx.cwd);
	if (opencodeModel) args.push("-m", opencodeModel);
	if (!readOnly) args.push("--auto");
	return { args, readOnly };
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
	if (!agent) return unknownAgentResult(agentName, task, agents);

	const model = opts.model ?? agent.model;
	const tools = opts.tools ?? agent.tools;
	void globalThinking; // opencode's --variant is provider-specific; reserved.

	const cwd = opts.cwd ?? defaultCwd;
	const { args, readOnly } = buildOpencodeArgs({
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
		bin: opencodeBin(),
		args,
		// A read-only phase injects the deny-mutations permission policy; the
		// shared runner merges this over the parent env.
		env: readOnly ? { ...process.env, OPENCODE_CONFIG_CONTENT: READ_ONLY_CONFIG } : undefined,
		cwd,
		idleTimeoutMs: opts.idleTimeoutMs,
		signal: opts.signal,
		onLive: opts.onLive,
		acc: newOpencodeAccumulator(model),
		foldLine: foldOpencodeEventLine,
	});
}

/**
 * The OpenCode host's `SubagentRunner`. Drops into `RuntimeDeps.runTask` exactly
 * like the pi/codex/claude runners, so the engine runs unchanged on OpenCode.
 */
export const opencodeSubagentRunner: SubagentRunner<AgentConfig> = {
	runTask: runOpencodeAgentTask,
};
