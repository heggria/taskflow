/**
 * Hermes Agent subagent runner — the Hermes host's `SubagentRunner`.
 *
 * Spawns an isolated one-shot:
 *   hermes chat -q <prompt> -Q --source tool [--in cwd] [-m model] [-t toolsets]
 *     [--reasoning level] [--max-turns N] [--yolo]
 *
 * Quiet mode (`-Q`) emits plain text on stdout (final answer).
 * Session id is printed on stderr by Hermes so piped stdout stays clean.
 * Mapping to the host-neutral contract:
 *   - output       = stdout with the leading `session_id:` line stripped
 *   - lastActivity = last non-empty stdout line
 *   - usage        = unavailable from quiet mode (emptyUsage); budgeted runs
 *                    still fail-closed at the engine when costs are required
 *   - failure      = non-zero exit, or empty output with non-zero semantics
 *
 * Permission mapping:
 *   - read-only phase → `-t file` (no --yolo; network opt-in via
 *     PI_TASKFLOW_HERMES_READONLY_WEB=1 → adds web,search)
 *   - mutating / default-capable → requires explicit
 *     `PI_TASKFLOW_HERMES_UNSAFE_YOLO=1` and passes `--yolo`
 *   - children always get `--ignore-user-config --ignore-rules`
 *
 * Quiet mode (`-Q`): answer on stdout; `session_id:` on stderr.
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

/** Mirrors taskflow-core TRANSPORT_ERROR_PLACEHOLDER (not always re-exported). */
const UPSTREAM_ERROR_PLACEHOLDER = "(upstream error: subagent failed; see error)";
/** Explicit operator acknowledgement required before Hermes may use `--yolo`
 * (bypass dangerous-command approvals) for mutating/default-capable phases. */
export const HERMES_UNSAFE_YOLO_ENV = "PI_TASKFLOW_HERMES_UNSAFE_YOLO";

/** Optional max-turns override for child Hermes runs (default 64). */
export const HERMES_MAX_TURNS_ENV = "PI_TASKFLOW_HERMES_MAX_TURNS";

export function hermesUnsafeYoloEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[HERMES_UNSAFE_YOLO_ENV] === "1";
}

/** Parent Hermes env keys that must never leak into taskflow children. */
const HERMES_CHILD_DENY = new Set([
	"HERMES_YOLO_MODE",
	"HERMES_ACCEPT_HOOKS",
	// Avoid inheriting gateway/session routing that is irrelevant to one-shot children.
	"HERMES_GATEWAY_TOKEN",
	"HERMES_API_SERVER_KEY",
]);

/**
 * Build a least-privilege env for a Hermes child.
 * Keeps provider credentials + HERMES_HOME (for .env auth), but strips YOLO and
 * other process-scoped bypass flags so parent gateway yolo cannot silently arm
 * a read-only phase.
 */
export function hermesChildEnv(
	source: NodeJS.ProcessEnv = process.env,
	opts: { allowUnsafeYolo?: boolean } = {},
): NodeJS.ProcessEnv {
	const filtered = filteredChildEnv(
		source,
		["HERMES_HOME", "OPENROUTER_API_KEY", "NOUS_API_KEY"],
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
	for (const key of Object.keys(filtered)) {
		if (HERMES_CHILD_DENY.has(key.toUpperCase()) || HERMES_CHILD_DENY.has(key)) {
			delete filtered[key];
		}
	}
	// Explicit deny even if casing differs.
	delete filtered.HERMES_YOLO_MODE;
	delete filtered.HERMES_ACCEPT_HOOKS;
	if (opts.allowUnsafeYolo) {
		// Prefer argv --yolo; do not also freeze HERMES_YOLO_MODE unless needed.
	}
	return filtered;
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
 *   - read-only → `file` when the whitelist is local-read shaped (Hermes cannot
 *     express write-less file tools; children run WITHOUT --yolo so mutating
 *     file ops stay approval-gated / non-interactive fail-closed). Network is
 *     opt-in via PI_TASKFLOW_HERMES_READONLY_WEB=1 → adds web,search.
 *   - mutating with explicit tools → union of matching toolsets
 *   - default / empty → file,terminal,web,search (NOT full `coding`)
 *   - unknown aliases are ignored (never fail-open to `coding`)
 */
export function resolveHermesToolsets(
	tools: string[] | undefined,
	readOnly: boolean,
	opts: { readonlyWeb?: boolean } = {},
): string {
	if (readOnly) {
		const localRead = new Set(["read", "read_file", "grep", "glob", "search_files", "ls", "list", "list_dir"]);
		const wantsLocal = !tools || tools.length === 0 || tools.some((t) => localRead.has(t));
		const sets = new Set<string>();
		if (wantsLocal) sets.add("file");
		if (opts.readonlyWeb) {
			sets.add("web");
			sets.add("search");
		}
		// Pure web RO whitelist with no local tools and no web opt-in → search only.
		if (sets.size === 0) sets.add("search");
		return [...sets].sort().join(",");
	}
	if (!tools || tools.length === 0) return "file,terminal,web,search";

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
				// Unknown aliases: ignore. Never expand to full `coding`.
				break;
		}
	}
	if (sets.size === 0) return "file,terminal,web,search";
	return [...sets].sort().join(",");
}

/** Opt-in network for read-only Hermes phases (default off). */
export const HERMES_READONLY_WEB_ENV = "PI_TASKFLOW_HERMES_READONLY_WEB";

export function hermesReadonlyWebEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[HERMES_READONLY_WEB_ENV] === "1";
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
	/** Opt-in network for read-only phases (PI_TASKFLOW_HERMES_READONLY_WEB=1). */
	readonlyWeb?: boolean;
}

export interface HermesArgs {
	args: string[];
	readOnly: boolean;
	toolsets: string;
}

/**
 * Build the full `hermes chat` argv — PURE (no process.env, no spawn).
 *
 *   hermes chat -q <prompt> -Q --source tool
 *     --ignore-user-config --ignore-rules
 *     [--in cwd] [-m model] [-t toolsets] [--reasoning level]
 *     [--max-turns N] [--yolo]
 *
 * Isolation: --ignore-user-config skips parent mcp_servers / config.yaml so a
 * child cannot recurse into taskflow MCP or inherit gateway tool policy.
 * Credentials still load from HERMES_HOME/.env (Hermes CLI contract).
 */
export function buildHermesArgs(ctx: HermesArgsCtx): HermesArgs {
	const hermesModel = resolveHermesModel(ctx.model);
	const readOnly = isHermesReadOnlyPhase(ctx.tools);
	const toolsets = resolveHermesToolsets(ctx.tools, readOnly, { readonlyWeb: ctx.readonlyWeb });
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
		"-Q", // quiet: final answer on stdout; session_id on stderr
		"--source",
		"tool", // third-party integrations — hide from user session lists
		// Isolate from parent Hermes profile policy / MCP / memory injection.
		"--ignore-user-config",
		"--ignore-rules",
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
	const allowUnsafeYolo = hermesUnsafeYoloEnabled();
	const childEnv = hermesChildEnv(process.env, { allowUnsafeYolo });

	let args: string[];
	try {
		({ args } = buildHermesArgs({
			systemPrompt: agent.systemPrompt,
			task,
			model,
			thinking,
			tools,
			cwd,
			allowUnsafeYolo,
			maxTurns: hermesMaxTurnsFromEnv(),
			readonlyWeb: hermesReadonlyWebEnabled(),
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
		// Quiet mode is plain text (not NDJSON); process exit is the terminal.
		stdoutFormat: "text",
		requireTerminalEvent: false,
	});

	// Hermes quiet mode prints `session_id: …` on stderr (stdout stays clean).
	if (!acc.sessionId && result.stderr) {
		const m = result.stderr.match(/session_id:\s*(\S+)/i);
		if (m) acc.sessionId = m[1];
	}

	// Prefer provider Error: lines from stderr over core's generic empty-output
	// message. Core may have already flipped exitCode 0→1 with a placeholder.
	if (!acc.finalText.trim()) {
		const stderr = result.stderr ?? "";
		const errLine =
			stderr.match(/^\s*Error:\s*(.+)$/im)?.[1]?.trim() ||
			stderr.match(/error:\s*(.+)/i)?.[1]?.trim();
		const sessionNote = acc.sessionId ? ` (session_id=${acc.sessionId})` : "";
		const genericEmpty =
			!result.errorMessage ||
			/without a final output/i.test(result.errorMessage) ||
			result.errorMessage === UPSTREAM_ERROR_PLACEHOLDER;
		if (errLine) {
			result.exitCode = result.exitCode || 1;
			result.stopReason = result.stopReason === "end" ? "error" : (result.stopReason ?? "error");
			result.errorMessage = sanitizeErrorMessage(`${errLine}${sessionNote}`);
		} else if (result.exitCode === 0 || genericEmpty) {
			result.exitCode = 1;
			result.stopReason = "error";
			result.errorMessage = sanitizeErrorMessage(
				acc.sessionId
					? `Hermes quiet run produced no answer (session_id=${acc.sessionId})`
					: "Hermes quiet run produced no answer",
			);
		}
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
