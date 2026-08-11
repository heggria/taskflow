/**
 * Hermes Agent subagent runner — the Hermes host's `SubagentRunner`.
 *
 * Spawns an isolated one-shot:
 *   hermes chat -q <prompt> -Q --source tool [--in cwd] [-m model] [-t toolsets]
 *     [--reasoning level] [--max-turns N] [--yolo]
 *
 * Quiet mode (`-Q`) emits plain text on stdout:
 *   session_id: 20260811_121111_f093bf
 *   <final answer>
 *
 * Mapping to the host-neutral contract:
 *   - output       = stdout with the leading `session_id:` line stripped
 *   - lastActivity = last non-empty stdout line
 *   - usage        = unavailable from quiet mode (emptyUsage); budgeted runs
 *                    still fail-closed at the engine when costs are required
 *   - failure      = non-zero exit, or empty output with non-zero semantics
 *
 * Permission mapping:
 *   - read-only phase (whitelist with no mutating tools) → `-t web,search`
 *     (no terminal/file — Hermes' `file` toolset includes write/patch)
 *   - mutating / default-capable → requires explicit
 *     `PI_TASKFLOW_HERMES_UNSAFE_YOLO=1` and passes `--yolo`
 *
 * Process handling (idle watchdog, abort, signal-kill, stderr cap, sanitize)
 * is delegated to shared `runSubagentProcess` in taskflow-core.
 *
 * @see https://hermes-agent.nousresearch.com/docs/
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
import { filteredChildEnv } from "./child-env.ts";

/** Explicit operator acknowledgement required before Hermes may use `--yolo`
 * (bypass dangerous-command approvals) for mutating/default-capable phases. */
export const HERMES_UNSAFE_YOLO_ENV = "PI_TASKFLOW_HERMES_UNSAFE_YOLO";

/** Optional max-turns override for child Hermes runs (default 64). */
export const HERMES_MAX_TURNS_ENV = "PI_TASKFLOW_HERMES_MAX_TURNS";

export function hermesUnsafeYoloEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[HERMES_UNSAFE_YOLO_ENV] === "1";
}

export function hermesChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return filteredChildEnv(
		source,
		[
			"HERMES_HOME",
			"HERMES_ACCEPT_HOOKS",
			"OPENROUTER_API_KEY",
			"NOUS_API_KEY",
		],
		[
			"HERMES_",
			"OPENAI_",
			"ANTHROPIC_",
			"GOOGLE_",
			"GEMINI_",
			"XAI_",
			"GROQ_",
			"MISTRAL_",
			"COHERE_",
			"AWS_",
			"AZURE_",
			"DEEPSEEK_",
		],
	);
}

/** Accumulated state folded from Hermes quiet-mode plain-text stdout. */
export interface HermesAccumulator {
	usage: UsageStats;
	model?: string;
	finalText: string;
	lastActivity: string;
	fatalError?: string;
	/** Quiet mode has no structured terminal event; set true once we have seen
	 *  any non-meta stdout (or on process end via the runner when empty is OK). */
	terminalSeen?: boolean;
	sessionId?: string;
}

export function newHermesAccumulator(model?: string): HermesAccumulator {
	return { usage: emptyUsage(), model, finalText: "", lastActivity: "" };
}

/**
 * Fold one stdout line from `hermes chat -Q`. Strips the leading
 * `session_id: …` meta line Hermes quiet mode prints; everything else is the
 * answer. Empty/whitespace-only lines are ignored for activity but preserved
 * inside the body once content has started.
 */
export function foldHermesQuietLine(acc: HermesAccumulator, line: string): LiveUpdate | null {
	// Keep trailing content fidelity: only strip the CR Hermes sometimes leaves.
	const raw = line.replace(/\r$/, "");
	if (!raw.trim()) {
		// Preserve blank lines inside the answer body once started.
		if (acc.finalText) acc.finalText += "\n";
		return null;
	}

	const sessionMatch = raw.match(/^session_id:\s*(\S+)\s*$/i);
	if (sessionMatch) {
		acc.sessionId = sessionMatch[1];
		return null;
	}

	// Quiet mode can occasionally print a warning line to stdout; treat obvious
	// fatal markers as errors rather than answer text.
	if (/^error:\s+/i.test(raw) && !acc.finalText.trim()) {
		acc.fatalError = raw.replace(/^error:\s+/i, "").trim() || "hermes run failed";
		acc.lastActivity = `error: ${acc.fatalError}`;
		return { text: acc.lastActivity, usage: { ...acc.usage }, model: acc.model };
	}

	if (acc.finalText) acc.finalText += "\n";
	acc.finalText += raw;
	acc.terminalSeen = true;
	acc.lastActivity = raw.trim();
	return { text: acc.lastActivity, usage: { ...acc.usage }, model: acc.model };
}

/** Override the hermes binary (tests / unusual installs). */
export function hermesBin(): string {
	return process.env.PI_TASKFLOW_HERMES_BIN || "hermes";
}

/**
 * Decide whether a phase is read-only from its tool whitelist. No whitelist →
 * not read-only (default-capable, needs --yolo opt-in).
 *
 * Hermes-mutating tool aliases (taskflow DSL style + hermes native names).
 */
export function isHermesReadOnlyPhase(tools: string[] | undefined): boolean {
	if (!tools || tools.length === 0) return false;
	const mutating = new Set([
		"write",
		"edit",
		"bash",
		"terminal",
		"process",
		"apply_patch",
		"write_file",
		"patch",
		"execute_code",
		"delegate_task",
		"computer_use",
		"skill_manage",
	]);
	return !tools.some((t) => mutating.has(t));
}

/**
 * Map a phase tool whitelist to Hermes `-t` toolsets. Best-effort:
 *   - read-only → web,search (no terminal/file — file toolset includes writes)
 *   - mutating with explicit tools → union of matching toolsets
 *   - default / empty → coding
 */
export function resolveHermesToolsets(tools: string[] | undefined, readOnly: boolean): string {
	if (readOnly) return "web,search";
	if (!tools || tools.length === 0) return "coding";

	const sets = new Set<string>();
	for (const t of tools) {
		switch (t) {
			case "read":
			case "read_file":
			case "grep":
			case "glob":
			case "search_files":
			case "write":
			case "edit":
			case "write_file":
			case "patch":
			case "apply_patch":
				sets.add("file");
				break;
			case "bash":
			case "terminal":
			case "process":
				sets.add("terminal");
				break;
			case "web_search":
			case "web_extract":
			case "web":
				sets.add("web");
				break;
			case "vision":
			case "vision_analyze":
				sets.add("vision");
				break;
			case "execute_code":
			case "code_execution":
				sets.add("code_execution");
				break;
			case "browser":
			case "browser_navigate":
				sets.add("browser");
				break;
			default:
				// Unknown aliases fall back to coding so the child still has a
				// sensible coding surface rather than an empty toolset.
				sets.add("coding");
				break;
		}
	}
	if (sets.size === 0) return "coding";
	// If coding already covers everything, just use it.
	if (sets.has("coding")) return "coding";
	return [...sets].sort().join(",");
}

/** Resolve a taskflow model id to something `hermes chat -m` accepts. */
export function resolveHermesModel(model: string | undefined): string | undefined {
	if (!model) return undefined;
	if (/^\{\{.*\}\}$/.test(model)) return undefined; // unresolved role placeholder
	// Drop pi thinking suffixes: `provider/model:xhigh`
	if (/:\s*(?:xhigh|high|medium|low|off|none|minimal|max|ultra)$/i.test(model)) {
		const bare = model.replace(/:\s*(?:xhigh|high|medium|low|off|none|minimal|max|ultra)$/i, "");
		return bare || undefined;
	}
	return model;
}

/** Normalize Taskflow thinking aliases to Hermes `--reasoning` levels. */
export function resolveHermesReasoning(thinking: string | undefined): string | undefined {
	if (!thinking) return undefined;
	const normalized = thinking.trim().toLowerCase();
	if (normalized === "off") return "none";
	if (["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(normalized)) {
		return normalized;
	}
	throw new Error(
		`Unsupported Hermes reasoning level '${thinking}'. Use off, none, minimal, low, medium, high, xhigh, max, or ultra.`,
	);
}

export interface HermesArgsCtx {
	systemPrompt: string;
	task: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	cwd?: string;
	/** Explicit acknowledgement for Hermes `--yolo`. */
	allowUnsafeYolo?: boolean;
	/** Max tool-calling iterations (default 64). */
	maxTurns?: number;
}

export interface HermesArgs {
	args: string[];
	readOnly: boolean;
	toolsets: string;
}

/**
 * Build the full `hermes chat` argv — PURE (no process.env, no spawn).
 *
 *   hermes chat -q <prompt> -Q --source tool [--in cwd] [-m model]
 *     [-t toolsets] [--reasoning level] [--max-turns N] [--yolo]
 */
export function buildHermesArgs(ctx: HermesArgsCtx): HermesArgs {
	const hermesModel = resolveHermesModel(ctx.model);
	const readOnly = isHermesReadOnlyPhase(ctx.tools);
	const toolsets = resolveHermesToolsets(ctx.tools, readOnly);
	const fullPrompt = ctx.systemPrompt.trim()
		? `${ctx.systemPrompt.trim()}\n\n---\n\nTask: ${ctx.task}`
		: `Task: ${ctx.task}`;

	if (!readOnly && !ctx.allowUnsafeYolo) {
		throw new Error(
			`Hermes mutating/default-capable phases require unsandboxed --yolo permissions. ` +
				`Set ${HERMES_UNSAFE_YOLO_ENV}=1 to explicitly allow this execution.`,
		);
	}

	const maxTurns = ctx.maxTurns && ctx.maxTurns > 0 ? Math.floor(ctx.maxTurns) : 64;

	const args: string[] = [
		"chat",
		"-q",
		fullPrompt,
		"-Q", // quiet: final answer + session_id only
		"--source",
		"tool", // third-party integrations — hide from user session lists
		"-t",
		toolsets,
		"--max-turns",
		String(maxTurns),
	];
	if (ctx.cwd) args.push("--in", ctx.cwd);
	if (hermesModel) args.push("-m", hermesModel);
	const reasoning = resolveHermesReasoning(ctx.thinking);
	if (reasoning) args.push("--reasoning", reasoning);
	if (!readOnly) args.push("--yolo");
	return { args, readOnly, toolsets };
}

function hermesMaxTurnsFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env[HERMES_MAX_TURNS_ENV];
	if (!raw) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

/**
 * Run a single subagent task via `hermes chat -q -Q`. Resolves the agent from
 * `agents` by name; returns the same structured `RunResult` the other host
 * runners produce.
 */
export async function runHermesAgentTask(
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
	const thinking = opts.thinking ?? agent.thinking ?? globalThinking;
	const tools = opts.tools ?? agent.tools;
	const cwd = opts.cwd ?? defaultCwd;
	const childEnv = hermesChildEnv();

	let args: string[];
	try {
		({ args } = buildHermesArgs({
			systemPrompt: agent.systemPrompt,
			task,
			model,
			thinking,
			tools,
			cwd,
			allowUnsafeYolo: hermesUnsafeYoloEnabled(),
			maxTurns: hermesMaxTurnsFromEnv(),
		}));
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

	const acc = newHermesAccumulator(model);
	const result = await runSubagentProcess({
		agent: agentName,
		task,
		model,
		bin: hermesBin(),
		args,
		env: childEnv,
		cwd,
		idleTimeoutMs: opts.idleTimeoutMs,
		signal: opts.signal,
		onLive: opts.onLive,
		acc,
		foldLine: foldHermesQuietLine,
		// Quiet mode has no structured end event — process exit is the terminal.
		requireTerminalEvent: false,
	});

	// If Hermes exited 0 with only a session_id line and no body, surface that.
	if (result.exitCode === 0 && !acc.finalText.trim()) {
		result.exitCode = 1;
		result.stopReason = "error";
		result.errorMessage = acc.sessionId
			? `Hermes quiet run produced no answer (session_id=${acc.sessionId})`
			: "Hermes quiet run produced no answer";
	}

	return result;
}

/** The Hermes host's `SubagentRunner`. Drops into `RuntimeDeps.runTask`. */
export const hermesSubagentRunner: SubagentRunner<AgentConfig> = {
	runTask: runHermesAgentTask,
	usageAccounting: "unavailable",
};

(runHermesAgentTask as typeof runHermesAgentTask & { usageAccounting: "unavailable" }).usageAccounting =
	"unavailable";
