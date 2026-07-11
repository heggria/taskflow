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
 *   - usage        = zeros today because Grok 0.2.93 streaming-json does not
 *                    emit token/cost fields. The runner advertises that fact
 *                    so budgeted MCP runs are rejected instead of silently
 *                    running without a ceiling.
 *   - failure      = an `error` event, or a non-zero process exit
 *
 * Permission mapping (codex `sandboxForTools` analogue):
 *   - read-only whitelist → an operator-configured custom profile extending
 *     `read-only`, a known-good `--tools` allowlist, and mutator deny rules
 *   - mutating / no whitelist → an operator-configured custom sandbox plus
 *     `--always-approve`. Grok's built-in profiles can warn and continue
 *     unsandboxed on unsupported hosts; explicit custom profiles fail closed.
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
	sanitizeErrorMessage,
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
 * Grok built-in tool ids a read-only phase may use. Web ids are deliberately
 * omitted because Grok 0.2.93's allowlist parser fails open on them.
 */
const READ_ONLY_TOOL_MAP: Readonly<Record<string, string>> = {
	read: "read_file",
	read_file: "read_file",
	grep: "grep",
	glob: "list_dir",
	ls: "list_dir",
	list: "list_dir",
	list_dir: "list_dir",
};

/**
 * Defence in depth for Grok 0.2.93. That version warns that web_search /
 * web_fetch are "unmappable" in `--tools` and then restores its full toolset.
 * We therefore never put those ids in the allowlist, and also remove every
 * known mutator after allowlist processing. `--deny` is a second, independent
 * enforcement layer in case a future CLI regresses allowlist handling again.
 */
const MUTATING_GROK_TOOLS = ["run_terminal_cmd", "search_replace", "write", "write_file", "Agent"];

/** Custom sandbox profile required for mutating Grok phases. Built-in profiles
 * may warn and continue without enforcement when the host cannot apply them;
 * Grok documents explicitly requested custom profiles as fail-closed. */
export const GROK_MUTATING_SANDBOX_PROFILE_ENV = "PI_TASKFLOW_GROK_MUTATING_SANDBOX_PROFILE";
export const GROK_READONLY_SANDBOX_PROFILE_ENV = "PI_TASKFLOW_GROK_READONLY_SANDBOX_PROFILE";
const BUILTIN_GROK_SANDBOX_PROFILES = new Set(["off", "workspace", "devbox", "read-only", "strict"]);

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
		case "max_turns_reached": {
			const msg =
				(typeof event.message === "string" && event.message.trim()) ||
				(typeof event.data === "string" && event.data.trim()) ||
				"grok reached its maximum turn limit before completing the task";
			acc.fatalError = msg;
			acc.stopReason = "max_turns_reached";
			activity = `error: ${msg}`;
			break;
		}
		default:
			// auto_compact_* / unknown — ignore for forward compatibility.
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
 * - no whitelist / mutating tools → an operator-configured fail-closed custom
 *   sandbox plus `--always-approve`
 * - read-only whitelist → a fail-closed custom read-only sandbox plus a narrow
 *   allowlist and independent deny rules (still pairs with `--always-approve`
 *   so the remaining safe tools never block on confirm)
 */
export function resolveGrokMutatingSandboxProfile(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const profile = env[GROK_MUTATING_SANDBOX_PROFILE_ENV]?.trim();
	return profile || undefined;
}

export function resolveGrokReadOnlySandboxProfile(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const profile = env[GROK_READONLY_SANDBOX_PROFILE_ENV]?.trim();
	return profile || undefined;
}

function requireCustomSandbox(profile: string | undefined, envName: string, phaseKind: string): string {
	if (!profile) {
		throw new Error(
			`${phaseKind} Grok phases require a fail-closed custom sandbox profile. ` +
				`Define one in ~/.grok/sandbox.toml and set ${envName}=<profile>.`,
		);
	}
	if (BUILTIN_GROK_SANDBOX_PROFILES.has(profile)) {
		throw new Error(
			`Grok sandbox '${profile}' is built in and may continue unsandboxed when enforcement is unavailable. ` +
				`${envName} must name a custom profile from ~/.grok/sandbox.toml.`,
		);
	}
	return profile;
}

export function permissionArgsForGrokTools(
	tools: string[] | undefined,
	mutatingSandboxProfile?: string,
	readOnlySandboxProfile?: string,
): string[] {
	if (!tools || tools.length === 0) {
		return ["--sandbox", requireCustomSandbox(mutatingSandboxProfile, GROK_MUTATING_SANDBOX_PROFILE_ENV, "Mutating/default"), "--always-approve"];
	}
	const mutating = new Set([
		"write",
		"write_file",
		"edit",
		"bash",
		"apply_patch",
		"run_terminal_cmd",
		"run_terminal_command",
		"search_replace",
	]);
	const canMutate = tools.some((t) => mutating.has(t));
	if (canMutate) {
		return ["--sandbox", requireCustomSandbox(mutatingSandboxProfile, GROK_MUTATING_SANDBOX_PROFILE_ENV, "Mutating"), "--always-approve"];
	}
	const allowed = [...new Set(tools.map((t) => READ_ONLY_TOOL_MAP[t]).filter((t): t is string => Boolean(t)))];
	// Keep the allowlist non-empty: an empty --tools value is treated as if the
	// flag were absent by some Grok builds, which would fail open to all tools.
	if (allowed.length === 0) allowed.push("read_file");
	return [
		"--sandbox",
		requireCustomSandbox(readOnlySandboxProfile, GROK_READONLY_SANDBOX_PROFILE_ENV, "Read-only"),
		"--tools",
		allowed.join(","),
		"--disallowed-tools",
		MUTATING_GROK_TOOLS.join(","),
		"--deny",
		"Bash",
		"--deny",
		"Edit",
		"--deny",
		"Write",
		"--deny",
		"MCPTool",
		"--no-subagents",
		"--always-approve",
	];
}

/** Map Taskflow/Pi thinking levels to Grok's --reasoning-effort contract. */
export function resolveGrokThinking(thinking: string | undefined): string | undefined {
	if (!thinking) return undefined;
	const normalized = thinking.trim().toLowerCase();
	if (normalized === "off") return "none";
	if (normalized === "ultra") return "max";
	if (["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(normalized)) return normalized;
	throw new Error(
		`Unsupported Grok thinking level '${thinking}'. Use off, none, minimal, low, medium, high, xhigh, max, or ultra.`,
	);
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
	thinking?: string;
	tools?: string[];
	cwd?: string;
	/** Explicit custom sandbox profile used for mutating/default-capable phases. */
	mutatingSandboxProfile?: string;
	/** Explicit custom sandbox profile used for read-only phases. */
	readOnlySandboxProfile?: string;
}

/**
 * Build the full `grok -p` argv from a phase's resolved context — PURE
 * (no process.env, no spawn). Extracted so the host's CLI flag contract is
 * unit-testable in CI without a live Grok session.
 *
 *   grok -p <task> --output-format streaming-json
 *        [--sandbox <custom-mutating> --always-approve |
 *         --sandbox <custom-read-only> --tools … --always-approve]
 *        [--model m] [--reasoning-effort level] [--cwd dir] [--rules systemPrompt]
 */
export function buildGrokArgs(ctx: GrokArgsCtx): string[] {
	const grokModel = resolveGrokModel(ctx.model);
	const grokThinking = resolveGrokThinking(ctx.thinking);
	const args: string[] = ["-p", ctx.task, "--output-format", "streaming-json"];
	args.push(...permissionArgsForGrokTools(ctx.tools, ctx.mutatingSandboxProfile, ctx.readOnlySandboxProfile));
	if (grokModel) args.push("-m", grokModel);
	if (grokThinking) args.push("--reasoning-effort", grokThinking);
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
	const thinking = opts.thinking ?? agent.thinking ?? globalThinking;

	const cwd = opts.cwd ?? defaultCwd;
	let args: string[];
	try {
		args = buildGrokArgs({
			systemPrompt: agent.systemPrompt,
			task,
			model,
			thinking,
			tools,
			cwd,
			mutatingSandboxProfile: resolveGrokMutatingSandboxProfile(),
			readOnlySandboxProfile: resolveGrokReadOnlySandboxProfile(),
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

// Preserve the capability when consumers inject the bare function into
// RuntimeDeps instead of passing the SubagentRunner object through an adapter.
(runGrokAgentTask as typeof runGrokAgentTask & { usageAccounting: "unavailable" }).usageAccounting = "unavailable";

/**
 * The Grok host's `SubagentRunner`. Drops into `RuntimeDeps.runTask` exactly
 * like the other host runners, so the engine runs unchanged on Grok Build.
 */
export const grokSubagentRunner: SubagentRunner<AgentConfig> = {
	runTask: runGrokAgentTask,
	usageAccounting: "unavailable",
};
