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
 *   - read-only phase → no tools by default (no file/terminal/network).
 *     Opt-in network: PI_TASKFLOW_HERMES_READONLY_WEB=1 → `-t web,search`.
 *     Hermes cannot express write-less local file tools — do not attach `file`.
 *   - mutating / default-capable → requires explicit
 *     `PI_TASKFLOW_HERMES_UNSAFE_YOLO=1` and passes `--yolo`
 *   - children always get `--safe-mode` + ephemeral HERMES_HOME (credentials only)
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
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	// Prompt/control-plane injection — never let parent gateway steer children.
	"HERMES_PREFILL_MESSAGES_FILE",
	"HERMES_EPHEMERAL_SYSTEM_PROMPT",
	"HERMES_EXTRA_SYSTEM_PROMPT",
	"HERMES_SYSTEM_PROMPT",
	"HERMES_SAFE_MODE",
	"HERMES_MAX_ITERATIONS",
]);

/**
 * Build a least-privilege env for a Hermes child.
 * Keeps provider credentials + HERMES_HOME (for .env auth), but strips YOLO and
 * other process-scoped bypass flags so parent gateway yolo cannot silently arm
 * a read-only phase. Also strips prompt-injection HERMES_* control vars.
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
			"DEEPSEEK_",
			// Intentionally omit AWS_/AZURE_ — cloud control-plane keys are too
			// broad for YOLO children; operators can PI_TASKFLOW_CHILD_ENV_ALLOW.
		],
	);
	for (const key of Object.keys(filtered)) {
		const upper = key.toUpperCase();
		if (HERMES_CHILD_DENY.has(upper) || HERMES_CHILD_DENY.has(key)) {
			delete filtered[key];
		}
		// Strip any HERMES_* prompt/prefill control surface by substring.
		if (
			upper.startsWith("HERMES_") &&
			/(PREFILL|EPHEMERAL|SYSTEM_PROMPT|YOLO|ACCEPT_HOOKS|GATEWAY|API_SERVER)/.test(upper)
		) {
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
		"code_execution",
		"delegate_task",
		"computer_use",
		"skill_manage",
		"memory",
		"browser",
		"browser_navigate",
		"cronjob",
		"send_message",
		"text_to_speech",
	]);
	return !tools.some((t) => mutating.has(t));
}

/**
 * Map a phase tool whitelist to Hermes `-t` toolsets. Best-effort:
 *   - read-only → NEVER attach Hermes `file`. Default RO is **no tools**
 *     (empty string → omit network egress). Opt-in: PI_TASKFLOW_HERMES_READONLY_WEB=1
 *     → `web,search`. Local disk read is unavailable under true RO on Hermes.
 *   - mutating with explicit tools → union of matching toolsets (narrow)
 *   - default / empty tools → file,terminal,web,search (NOT full `coding`)
 *   - unknown / unmapped aliases: ignored if something else mapped; if NOTHING
 *     mapped from a non-empty tools list → throw (never fail-open to wide default)
 */
export function resolveHermesToolsets(
	tools: string[] | undefined,
	readOnly: boolean,
	opts: { readonlyWeb?: boolean } = {},
): string {
	if (readOnly) {
		// Empty = no -t tools (model-only). Never attach file (writable).
		return opts.readonlyWeb ? "web,search" : "";
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
			case "skill_manage":
			case "skills":
				sets.add("skills");
				break;
			case "delegate_task":
			case "delegation":
				sets.add("delegation");
				break;
			case "memory":
				sets.add("memory");
				break;
			case "cronjob":
				sets.add("cronjob");
				break;
			case "text_to_speech":
			case "tts":
				sets.add("tts");
				break;
			case "computer_use":
				sets.add("computer_use");
				break;
			case "session_search":
				sets.add("session_search");
				break;
			default:
				// Unknown aliases: ignore. Never expand to full `coding`.
				break;
		}
	}
	if (sets.size === 0) {
		// Explicit tools that mapped to nothing must not silently widen to the
		// default mutating surface (file+terminal+web).
		throw new Error(
			`Hermes tool whitelist [${tools.join(", ")}] did not map to any Hermes toolset. ` +
				`Use known aliases (read/write/bash/web/…) or omit tools for the default coding surface.`,
		);
	}
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
 *     --safe-mode
 *     [--in cwd] [-m model] [-t toolsets] [--reasoning level]
 *     [--max-turns N] [--yolo]
 *
 * Isolation: `--safe-mode` disables user config, rules, plugins, and MCP
 * (implies --ignore-user-config and --ignore-rules) so a child cannot recurse
 * into taskflow MCP or inherit gateway tool policy.
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
		"--safe-mode",
		"--max-turns",
		String(maxTurns),
	];
	// Empty toolsets = model-only (RO default). Omit -t rather than pass "".
	if (toolsets) {
		args.push("-t", toolsets);
	}
	if (ctx.cwd) args.push("--in", ctx.cwd);
	if (hermesModel) args.push("-m", hermesModel);
	const reasoning = resolveHermesReasoning(ctx.thinking);
	if (reasoning) args.push("--reasoning", reasoning);
	if (!readOnly) args.push("--yolo");
	return { args, readOnly, toolsets };
}

/**
 * Credential-only files copied into an ephemeral HERMES_HOME. Never copy
 * config.yaml, skills/, memory, plugins, sessions, or gateway state — those are
 * the isolation surface `--safe-mode` + temp home close.
 */
const HERMES_EPHEMERAL_CREDENTIAL_FILES = [".env", "auth.json"] as const;

export interface EphemeralHermesHome {
	/** Temp directory used as HERMES_HOME for one child. */
	home: string;
	/** Remove the temp home (best-effort). */
	cleanup: () => void;
}

/**
 * Build a throwaway HERMES_HOME with only credential files from the parent
 * profile. Children still authenticate via .env/auth.json but cannot write
 * skills/memory into the operator profile.
 */
export function prepareEphemeralHermesHome(
	parentHome: string,
	opts: { tmpRoot?: string } = {},
): EphemeralHermesHome {
	const root = opts.tmpRoot ?? tmpdir();
	const home = mkdtempSync(join(root, "taskflow-hermes-"));
	for (const name of HERMES_EPHEMERAL_CREDENTIAL_FILES) {
		const src = join(parentHome, name);
		if (existsSync(src)) {
			try {
				copyFileSync(src, join(home, name));
			} catch {
				// Best-effort: missing/unreadable credentials surface as auth
				// failures from hermes itself, not a host crash.
			}
		}
	}
	return {
		home,
		cleanup: () => {
			try {
				rmSync(home, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		},
	};
}

/** Resolve parent HERMES_HOME the way Hermes CLI does (env or ~/.hermes). */
export function resolveParentHermesHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.HERMES_HOME?.trim() || join(env.HOME || tmpdir(), ".hermes");
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
	const ephemeral = prepareEphemeralHermesHome(resolveParentHermesHome(process.env));
	childEnv.HERMES_HOME = ephemeral.home;

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
		ephemeral.cleanup();
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
	let result: RunResult;
	try {
		result = await runSubagentProcess({
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
	} finally {
		ephemeral.cleanup();
	}
	// Hermes quiet mode prints `session_id: …` on stderr (stdout stays clean).
	if (!acc.sessionId && result.stderr) {
		const m = result.stderr.match(/session_id:\s*(\S+)/i);
		if (m) acc.sessionId = m[1];
	}

	// Prefer provider Error: lines from stderr over core's generic empty-output
	// message. Core may have already flipped exitCode 0→1 with a placeholder.
	// Never rewrite abort / idle-timeout diagnostics.
	if (!acc.finalText.trim()) {
		const stderr = result.stderr ?? "";
		const errLine = stderr.match(/^\s*Error:\s*(.+)$/im)?.[1]?.trim();
		const sessionNote = acc.sessionId ? ` (session_id=${acc.sessionId})` : "";
		const preservedStop =
			result.stopReason === "aborted" ||
			result.completionSource === "abort" ||
			result.completionSource === "idle-timeout" ||
			result.idleTimeout === true;
		const genericEmpty =
			!result.errorMessage ||
			/without a final output/i.test(result.errorMessage) ||
			result.errorMessage === UPSTREAM_ERROR_PLACEHOLDER;
		const mayUpgradeProviderError = genericEmpty && !preservedStop;
		if (preservedStop) {
			// Keep core stopReason / errorMessage; optionally annotate session id.
			if (acc.sessionId && result.errorMessage && !result.errorMessage.includes("session_id=")) {
				result.errorMessage = sanitizeErrorMessage(`${result.errorMessage}${sessionNote}`);
			}
		} else if (errLine && mayUpgradeProviderError) {
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
