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
 *   - output       = stdout answer text (session id is stderr-only metadata)
 *   - lastActivity = last non-empty stdout line
 *   - usage        = unavailable from quiet mode (emptyUsage); budgeted runs
 *                    still fail-closed at the engine when costs are required
 *   - failure      = non-zero exit, or empty output with non-zero semantics
 *
 * Permission mapping:
 *   - read-only + local-read tools → `-t taskflow_readonly_files`
 *     (ephemeral plugin: read_file + search_files only; write_file/patch blocked)
 *   - read-only without local tools → explicit empty model-only `-t`; network opt-in via
 *     PI_TASKFLOW_HERMES_READONLY_WEB=1 → web,search
 *   - mutating / default-capable → requires PI_TASKFLOW_HERMES_UNSAFE_YOLO=1 + `--yolo`
 *   - isolation: ephemeral HERMES_HOME (creds + minimal config + RO plugin) and
 *     `--ignore-rules` (not `--safe-mode`, so our config can disable reasoning UI)
 *
 * Quiet mode (`-Q`): answer on stdout; `session_id:` on stderr. Reasoning boxes
 * are suppressed via config and stripped from output as defense-in-depth.
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve as resolvePath, sep } from "node:path";
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
	"HERMES_REDACT_SECRETS",
	"HERMES_ENVIRONMENT_HINT",
	"HERMES_WRITE_SAFE_ROOT",
	"HERMES_PLATFORM",
	"PI_TASKFLOW_HERMES_UNSAFE_YOLO",
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
		// HERMES_HOME is replaced with the ephemeral child home below. Every
		// other HERMES_* value is host control-plane state, not provider auth.
		if (upper.startsWith("HERMES_") && upper !== "HERMES_HOME") {
			delete filtered[key];
			continue;
		}
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
 * Fold one stdout line from `hermes chat -Q`. Stdout is answer text; Hermes
 * session metadata is parsed from stderr after process exit. Empty lines are
 * ignored for activity but preserved inside the body once content has started.
 */
export function foldHermesQuietLine(acc: HermesAccumulator, line: string): LiveUpdate | null {
	// Keep trailing content fidelity: only strip the CR Hermes sometimes leaves.
	const raw = line.replace(/\r$/, "");
	if (!raw.trim()) {
		// Preserve blank lines inside the answer body once started.
		if (acc.finalText) acc.finalText += "\n";
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

/** Hermes toolset name registered by the ephemeral taskflow_readonly plugin. */
export const HERMES_READONLY_FILES_TOOLSET = "taskflow_readonly_files";
/** Empty toolset — always pass `-t` so Hermes does not fall back to hermes-cli defaults. */
export const HERMES_MODEL_ONLY_TOOLSET = "taskflow_model_only";

const LOCAL_READ_TOOLS = new Set([
	"read",
	"read_file",
	"grep",
	"glob",
	"search_files",
	"ls",
	"list",
	"list_dir",
]);

/**
 * Map a phase tool whitelist to Hermes `-t` toolsets. Best-effort:
 *   - read-only + local-read aliases → `taskflow_readonly_files` (plugin)
 *   - read-only + READONLY_WEB → adds web,search
 *   - read-only otherwise → `taskflow_model_only` (empty toolset; NEVER omit -t —
 *     Hermes defaults to full hermes-cli tools when -t is absent)
 *   - mutating with explicit tools → union of matching toolsets (narrow)
 *   - default / empty tools → file,terminal (network/control-plane denied)
 *   - unmapped non-empty tools list → throw (never fail-open to wide default)
 */
export function resolveHermesToolsets(
	tools: string[] | undefined,
	readOnly: boolean,
	opts: { readonlyWeb?: boolean } = {},
): string {
	if (readOnly) {
		const sets = new Set<string>();
		if (tools && tools.some((t) => LOCAL_READ_TOOLS.has(t))) {
			sets.add(HERMES_READONLY_FILES_TOOLSET);
		}
		if (opts.readonlyWeb) {
			sets.add("web");
			sets.add("search");
		}
		// Critical: omitting -t loads full hermes-cli defaults (terminal/write/…).
		if (sets.size === 0) sets.add(HERMES_MODEL_ONLY_TOOLSET);
		return [...sets].sort().join(",");
	}
	if (!tools || tools.length === 0) return "file,terminal";

	const sets = new Set<string>();
	const unmapped: string[] = [];
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
			default:
				unmapped.push(t);
				break;
		}
	}
	if (unmapped.length > 0 || sets.size === 0) {
		throw new Error(
			`Hermes tool whitelist [${tools.join(", ")}] did not map safely to supported Hermes toolsets. ` +
				`0.2.9 permits only local file, terminal, and explicit web aliases; ` +
				`delegation/skills/memory/browser/cron/control-plane tools are denied.`,
		);
	}
	return [...sets].sort().join(",");
}

/**
 * Strip Hermes quiet-mode reasoning chrome and model think-tags from text.
 * Primary suppression is `display.show_reasoning: false` in the ephemeral
 * config; this is defense-in-depth when a model still leaks boxes/tags.
 */
export function stripHermesReasoningNoise(text: string): string {
	if (!text) return text;
	let t = text;
	// Full reasoning box (open + body until blank line before final answer is hard;
	// remove the box-drawing header line and matching footer if present).
	t = t.replace(/^\s*┌─\s*Reasoning[^\n]*\n?/gim, "");
	t = t.replace(/^\s*└[─\s]*┘\s*\n?/gim, "");
	// XML-ish think blocks (also stripped by Hermes CLI when displayed; belt-and-suspenders).
	t = t.replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, "");
	t = t.replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi, "");
	t = t.replace(/<REASONING_SCRATCHPAD\b[^>]*>[\s\S]*?<\/REASONING_SCRATCHPAD>/gi, "");
	// Hermes CLI transport chrome: fallback selection is diagnostic metadata,
	// not part of the model's answer body.
	t = t.replace(/^\s*⚠️\s+Primary auth failed\s+—\s+switching to fallback:[^\n]*\n?/gim, "");
	// Collapse leading blank lines left by stripped headers.
	t = t.replace(/^\s*\n+/, "");
	return t.trimEnd();
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
 *     --ignore-rules
 *     [--in cwd] [-m model] [-t toolsets] [--reasoning level]
 *     [--max-turns N] [--yolo]
 *
 * Isolation: ephemeral HERMES_HOME (credentials + show_reasoning:false + RO
 * plugin). `--ignore-rules` skips AGENTS.md injection. Do not use --safe-mode
 * (it would ignore our ephemeral config/plugin).
 * Credentials still load from the ephemeral home's .env/auth.json. */
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
		// Isolate from parent rules injection. Ephemeral HERMES_HOME supplies
		// config (show_reasoning:false, no mcp) + RO plugin — do NOT use
		// --safe-mode (it would ignore that config).
		"--ignore-rules",
		"--max-turns",
		String(maxTurns),
	];
	// Empty toolsets must never happen for RO (Critical fail-open). Always pass -t.
	if (toolsets) {
		args.push("-t", toolsets);
	} else {
		args.push("-t", HERMES_MODEL_ONLY_TOOLSET);
	}
	if (ctx.cwd) args.push("--in", ctx.cwd);
	if (hermesModel) args.push("-m", hermesModel);
	const reasoning = resolveHermesReasoning(ctx.thinking);
	if (reasoning) args.push("--reasoning", reasoning);
	if (!readOnly) args.push("--yolo");
	return { args, readOnly, toolsets };
}

/** Inference-provider ids whose auth-store entries may enter a child profile. */
const HERMES_INFERENCE_AUTH_PROVIDERS = new Set([
	"alibaba-coding-plan", "anthropic", "arcee", "azure-foundry", "cohere",
	"copilot", "dashscope", "deepinfra", "deepseek", "fireworks", "gemini",
	"gmi", "google", "groq", "hf", "huggingface", "kimi", "kimi-coding",
	"minimax", "minimax-oauth", "mistral", "nous", "novita", "nvidia",
	"ollama", "openai", "openai-codex", "opencode", "opencode-go",
	"opencode-zen", "openrouter", "stepfun", "together", "tokenhub", "upstage",
	"xai", "xai-oauth", "xiaomi", "zai", "zhipu", "glm",
]);

/** Exact inference-provider dotenv keys allowed into an ephemeral child home. */
const HERMES_PROVIDER_DOTENV_KEYS = new Set([
	"OPENROUTER_API_KEY",
	"NOUS_API_KEY",
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"GEMINI_BASE_URL",
	"XAI_API_KEY",
	"XAI_BASE_URL",
	"GROQ_API_KEY",
	"GROQ_BASE_URL",
	"MISTRAL_API_KEY",
	"MISTRAL_BASE_URL",
	"COHERE_API_KEY",
	"COHERE_BASE_URL",
	"DEEPSEEK_API_KEY",
	"DEEPSEEK_BASE_URL",
	"TOGETHER_API_KEY",
	"TOGETHER_BASE_URL",
	"DASHSCOPE_API_KEY",
	"FIREWORKS_API_KEY",
	"HF_TOKEN",
	"HUGGINGFACEHUB_API_TOKEN",
	"MINIMAX_API_KEY",
	"MINIMAX_BASE_URL",
	"NVIDIA_API_KEY",
	"OLLAMA_BASE_URL",
	"OPENCODE_GO_API_KEY",
	"ZAI_API_KEY",
	"ZHIPU_API_KEY",
	"GLM_API_KEY",
]);

/** Keep only explicitly supported inference-provider assignments from dotenv. */
export function filterHermesProviderDotenv(source: string): string {
	const kept: string[] = [];
	for (const line of source.split(/\r?\n/)) {
		const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
		if (match && HERMES_PROVIDER_DOTENV_KEYS.has(match[1])) kept.push(line);
	}
	return kept.length > 0 ? `${kept.join("\n")}\n` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Filter Hermes auth.json to known inference-provider credential entries. */
export function filterHermesAuthJson(
	source: string,
	routedProviders: ReadonlySet<string> = new Set(),
): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		return "";
	}
	if (!isRecord(parsed)) return "";
	const out: Record<string, unknown> = {};
	if (typeof parsed.version === "number") out.version = parsed.version;
	if (typeof parsed.updated_at === "string") out.updated_at = parsed.updated_at;
	let activeProvider: string | undefined;
	if (
		typeof parsed.active_provider === "string" &&
		HERMES_INFERENCE_AUTH_PROVIDERS.has(parsed.active_provider)
	) {
		activeProvider = parsed.active_provider;
	}
	const allowed = new Set(
		[...routedProviders].filter((provider) => HERMES_INFERENCE_AUTH_PROVIDERS.has(provider)),
	);
	if (allowed.size === 0 && activeProvider) allowed.add(activeProvider);
	if (activeProvider && allowed.has(activeProvider)) out.active_provider = activeProvider;
	for (const key of ["providers", "credential_pool"] as const) {
		const sourceMap = parsed[key];
		if (!isRecord(sourceMap)) continue;
		const kept: Record<string, unknown> = {};
		for (const [provider, value] of Object.entries(sourceMap)) {
			if (allowed.has(provider)) kept[provider] = value;
		}
		if (Object.keys(kept).length > 0) out[key] = kept;
	}
	return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * Pull a top-level YAML mapping block (e.g. `model:`) from parent config text.
 * Indentation-based; no full YAML parser dependency.
 */
export function extractYamlTopLevelBlock(source: string, key: string): string | undefined {
	const lines = source.split(/\r?\n/);
	const start = lines.findIndex(
		(l) => new RegExp(`^${key}:\\s*(?:#.*)?$`).test(l) || new RegExp(`^${key}:\\s+\\S`).test(l),
	);
	if (start < 0) return undefined;
	const first = lines[start];
	// Inline scalar: `model: foo`
	if (/^[\w-]+:\s+\S/.test(first) && !first.trimEnd().endsWith(":")) {
		return first;
	}
	const out = [first];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (
			line.trim() === "" ||
			line.startsWith(" ") ||
			line.startsWith("	") ||
			line.trimStart().startsWith("#")
		) {
			out.push(line);
			continue;
		}
		// next top-level key
		if (/^[\w-]+:/.test(line)) break;
		out.push(line);
	}
	// trim trailing blank lines
	while (out.length && out[out.length - 1].trim() === "") out.pop();
	return out.join("\n");
}

function safeHermesRoutingScalar(field: string, value: string): string | undefined {
	if (!/^[A-Za-z0-9_./:@+\-]+$/.test(value)) return undefined;
	if (field === "api_mode") return value;
	if (field !== "base_url") return value;
	try {
		const url = new URL(value);
		if (!["http:", "https:"].includes(url.protocol)) return undefined;
		if (url.username || url.password || url.search || url.hash) return undefined;
		return value;
	} catch {
		return undefined;
	}
}

/**
 * Carry only non-secret scalar routing fields from the parent config.
 * This deliberately omits `providers:` and all nested mappings (MCP/plugins/
 * api_key/token) rather than treating indentation as a security boundary.
 */
export function sanitizeHermesRoutingConfig(source: string): string {
	const parts: string[] = [];
	const model = extractYamlTopLevelBlock(source, "model");
	if (model) {
		const firstLine = model.split(/\r?\n/, 1)[0];
		if (/^model:\s+[A-Za-z0-9_./:@+\-]+\s*$/.test(firstLine)) {
			parts.push(firstLine.trimEnd());
		} else {
			const fields = model.split(/\r?\n/).flatMap((line) => {
				const match = line.match(/^  (default|provider|base_url|api_mode):\s+([A-Za-z0-9_./:@+\-]+)\s*$/);
				const value = match ? safeHermesRoutingScalar(match[1], match[2]) : undefined;
				return match && value ? [`  ${match[1]}: ${value}`] : [];
			});
			if (fields.length > 0) parts.push(["model:", ...fields].join("\n"));
		}
	}
	const fallback = extractYamlTopLevelBlock(source, "fallback_providers");
	if (fallback) {
		const rows: string[] = [];
		for (const line of fallback.split(/\r?\n/).slice(1)) {
			const first = line.match(/^  - (provider|model|base_url|api_mode):\s+([A-Za-z0-9_./:@+\-]+)\s*$/);
			const firstValue = first ? safeHermesRoutingScalar(first[1], first[2]) : undefined;
			if (first && firstValue) {
				rows.push(`  - ${first[1]}: ${firstValue}`);
				continue;
			}
			const next = line.match(/^    (provider|model|base_url|api_mode):\s+([A-Za-z0-9_./:@+\-]+)\s*$/);
			const nextValue = next ? safeHermesRoutingScalar(next[1], next[2]) : undefined;
			if (next && nextValue && rows.length > 0) rows.push(`    ${next[1]}: ${nextValue}`);
		}
		if (rows.length > 0) parts.push(["fallback_providers:", ...rows].join("\n"));
	}
	return parts.join("\n\n");
}

function hermesRoutingProviders(source: string): Set<string> {
	const routing = sanitizeHermesRoutingConfig(source);
	const providers = new Set<string>();
	for (const line of routing.split(/\r?\n/)) {
		const mapped = line.match(/^\s*(?:-\s+)?provider:\s+([A-Za-z0-9_.+\-]+)\s*$/);
		if (mapped) providers.add(mapped[1]);
	}
	const scalarModel = routing.match(/^model:\s+([A-Za-z0-9_.+\-]+)\//m);
	if (scalarModel) providers.add(scalarModel[1]);
	return providers;
}

/** Build ephemeral config.yaml text: isolation defaults + parent model routing. */
export function buildEphemeralHermesConfigYaml(
	parentHome: string,
	opts: { readOnly?: boolean } = {},
): string {
	const readOnly = opts.readOnly !== false;
	const parts: string[] = [
		"display:",
		"  show_reasoning: false",
		"mcp_servers: {}",
	];
	if (readOnly) {
		parts.push(
			"plugins:",
			"  enabled:",
			"    - taskflow_readonly",
			"  entries:",
			"    taskflow_readonly:",
			"      enabled: true",
		);
	}
	const parentCfgPath = join(parentHome, "config.yaml");
	if (existsSync(parentCfgPath)) {
		try {
			const raw = readFileSync(parentCfgPath, "utf8");
			const routing = sanitizeHermesRoutingConfig(raw);
			if (routing) parts.push("", routing);
		} catch {
			/* parent model optional — .env may still auth */
		}
	}
	return `${parts.join("\n")}\n`;
}

const EPHEMERAL_RO_PLUGIN_YAML = `name: taskflow_readonly
version: 0.1.0
description: Taskflow read-only file toolset (read_file + search_files only)
`;

const EPHEMERAL_RO_PLUGIN_INIT = `from __future__ import annotations

import os
from pathlib import Path


def register(ctx) -> None:
    """Register RO + model-only toolsets; block writes and out-of-cwd reads."""
    from toolsets import create_custom_toolset

    create_custom_toolset(
        name="taskflow_readonly_files",
        description="Read-only local files for taskflow RO phases",
        tools=["read_file", "search_files"],
    )
    create_custom_toolset(
        name="taskflow_model_only",
        description="No tools (taskflow RO model-only; prevents hermes-cli default toolset)",
        tools=[],
    )

    _BLOCK = frozenset({
        "write_file", "patch", "terminal", "process", "execute_code",
        "delegate_task", "skill_manage", "computer_use", "cronjob",
        "send_message", "text_to_speech", "browser_navigate", "browser",
    })

    def _deny(message: str):
        return {
            "action": "block",
            "message": f"taskflow read-only phase: {message}",
        }

    def _pre_tool(tool_name: str = "", args=None, **kwargs):
        name = tool_name or kwargs.get("name") or ""
        if name in _BLOCK:
            return _deny(f"{name} denied")
        # Constrain every path-bearing local read to the child cwd.
        if name in {"read_file", "search_files"}:
            if not isinstance(args, dict):
                return _deny(f"{name} requires path arguments")
            if name == "search_files":
                value = args.get("path", ".")
                raw = "." if value is None or value == "" else value
            else:
                raw = args.get("path") or args.get("file")
                if raw is None or raw == "":
                    return _deny("read_file requires a path")
            if not isinstance(raw, str):
                return _deny("path must be a string")
            try:
                cwd = Path(os.environ.get("PI_TASKFLOW_HERMES_PHASE_CWD", os.getcwd())).resolve(strict=True)
                target = Path(raw).expanduser()
                if not target.is_absolute():
                    target = cwd / target
                # Resolve existing symlink ancestors while allowing an
                # in-cwd nonexistent final component to be searched safely.
                target = target.resolve(strict=False)
                target.relative_to(cwd)
            except (OSError, RuntimeError, ValueError):
                return _deny(
                    "path escapes phase cwd "
                    f"({raw!r}); only paths under the working directory are allowed"
                )
        return None

    ctx.register_hook("pre_tool_call", _pre_tool)
`;

export interface EphemeralHermesHome {
	/** Temp directory used as HERMES_HOME for one child. */
	home: string;
	/** Remove the temp home (best-effort). */
	cleanup: () => void;
}

/**
 * Build a throwaway HERMES_HOME with credentials + minimal config + RO plugin.
 * Children authenticate via .env/auth.json, cannot see parent skills/MCP, and
 * get display.show_reasoning=false so quiet stdout stays clean.
 */
export function prepareEphemeralHermesHome(
	parentHome: string,
	opts: { tmpRoot?: string; readOnly?: boolean } = {},
): EphemeralHermesHome {
	const root = opts.tmpRoot ?? tmpdir();
	const readOnly = opts.readOnly !== false;
	const home = mkdtempSync(join(root, "taskflow-hermes-"));
	let routedProviders = new Set<string>();
	const parentConfig = join(parentHome, "config.yaml");
	if (existsSync(parentConfig)) {
		try {
			routedProviders = hermesRoutingProviders(readFileSync(parentConfig, "utf8"));
		} catch {
			// Missing routing falls back to the auth store's active provider below.
		}
	}
	const parentAuth = join(parentHome, "auth.json");
	if (existsSync(parentAuth)) {
		try {
			const filteredAuth = filterHermesAuthJson(readFileSync(parentAuth, "utf8"), routedProviders);
			if (filteredAuth) writeFileSync(join(home, "auth.json"), filteredAuth, "utf8");
		} catch {
			// Missing/unreadable auth surfaces as an authentication failure; never
			// fall back to copying the operator's unfiltered credential store.
		}
	}
	const parentDotenv = join(parentHome, ".env");
	if (existsSync(parentDotenv)) {
		try {
			const providerDotenv = filterHermesProviderDotenv(readFileSync(parentDotenv, "utf8"));
			if (providerDotenv) writeFileSync(join(home, ".env"), providerDotenv, "utf8");
		} catch {
			// Process environment and auth.json remain available for provider auth.
		}
	}
	try {
		writeFileSync(
			join(home, "config.yaml"),
			buildEphemeralHermesConfigYaml(parentHome, { readOnly }),
			"utf8",
		);
		if (readOnly) {
			const plugDir = join(home, "plugins", "taskflow_readonly");
			mkdirSync(plugDir, { recursive: true });
			writeFileSync(join(plugDir, "plugin.yaml"), EPHEMERAL_RO_PLUGIN_YAML, "utf8");
			writeFileSync(join(plugDir, "__init__.py"), EPHEMERAL_RO_PLUGIN_INIT, "utf8");
		}
	} catch (error) {
		// Fail closed: without config/plugin, RO toolsets and show_reasoning are wrong.
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		throw new Error(
			`Failed to materialize ephemeral Hermes home: ${error instanceof Error ? error.message : String(error)}`,
		);
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

/**
 * Resolve the operator Hermes profile to clone credentials/model routing from.
 * Prefer `PI_TASKFLOW_HERMES_PARENT_HOME`, then a usable `HERMES_HOME`, then `~/.hermes`.
 * Skips ephemeral taskflow temps and empty tmp HERMES_HOME leftovers.
 */
export function resolveParentHermesHome(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_TASKFLOW_HERMES_PARENT_HOME?.trim();
	if (override) return override;

	const fallback = join(env.HOME || env.USERPROFILE || homedir(), ".hermes");
	const candidates = [env.HERMES_HOME?.trim(), fallback].filter(Boolean) as string[];

	const tempRoot = resolvePath(tmpdir());
	for (const candidate of candidates) {
		if (candidate.includes("taskflow-hermes-")) continue;
		const hasAuth =
			existsSync(join(candidate, "auth.json")) || existsSync(join(candidate, ".env"));
		const absolute = resolvePath(candidate);
		const underTemp = absolute === tempRoot || absolute.startsWith(`${tempRoot}${sep}`);
		// Test/probe profiles frequently leave HERMES_HOME pointing at a temp
		// config-only directory. It cannot authenticate and must not shadow the
		// operator profile. A non-temp config-only profile remains a valid custom
		// routing home when credentials arrive through process env.
		const hasCreds = hasAuth || (!underTemp && existsSync(join(candidate, "config.yaml")));
		if (hasCreds) return candidate;
	}
	return fallback;
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
	let readOnly: boolean;
	try {
		({ args, readOnly } = buildHermesArgs({
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

	let ephemeral: EphemeralHermesHome;
	try {
		ephemeral = prepareEphemeralHermesHome(resolveParentHermesHome(process.env), { readOnly });
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
			stopReason: "error",
		};
	}
	childEnv.HERMES_HOME = ephemeral.home;
	childEnv.PI_TASKFLOW_HERMES_PHASE_CWD = cwd;

	const acc = newHermesAccumulator(model);
	// Hermes writes its canonical session footer at process exit. Keep only the
	// final complete stderr line before runner-core's retained-diagnostic cap.
	// A bounded raw tail is unsafe: slicing can start mid-line immediately before
	// an embedded `session_id:` substring and make it look canonical.
	let stderrFragment = "";
	let stderrFragmentTruncated = false;
	let lastCompleteStderrLine: string | undefined;
	const observeStderr = (data: Buffer) => {
		const pieces = data.toString("utf8").split("\n");
		if (pieces.length === 1) {
			stderrFragment += pieces[0];
			if (stderrFragment.length > 8192) {
				stderrFragment = stderrFragment.slice(-8192);
				stderrFragmentTruncated = true;
			}
			return;
		}
		const firstComplete = `${stderrFragment}${pieces[0]}`.replace(/\r$/, "");
		if (!stderrFragmentTruncated && firstComplete.trim()) lastCompleteStderrLine = firstComplete;
		for (const complete of pieces.slice(1, -1)) {
			const line = complete.replace(/\r$/, "");
			if (line.trim()) lastCompleteStderrLine = line;
		}
		stderrFragment = pieces.at(-1) ?? "";
		stderrFragmentTruncated = false;
		if (stderrFragment.length > 8192) {
			stderrFragment = stderrFragment.slice(-8192);
			stderrFragmentTruncated = true;
		}
	};
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
			observeStderr,
		});
	} finally {
		ephemeral.cleanup();
	}
	// Hermes quiet mode prints a complete canonical `session_id: …` stderr line.
	// Embedded diagnostic prose is not metadata. The complete-line observer also
	// recovers a legitimate footer emitted after runner-core's 64KB diagnostic cap.
	const canonicalSessionId = (text: string): string | undefined => {
		const lines = text.split(/\r?\n/);
		for (let i = lines.length - 1; i >= 0; i--) {
			if (!lines[i].trim()) continue;
			return lines[i].match(/^\s*session_id:\s*(\S+)\s*$/i)?.[1];
		}
		return undefined;
	};
	if (!acc.sessionId) {
		acc.sessionId = canonicalSessionId(lastCompleteStderrLine ?? "") ?? canonicalSessionId(result.stderr ?? "");
	}
	if (result.stderr) {
		result.stderr = result.stderr
			.split(/\r?\n/)
			.filter((line) => !/^\s*session_id:\s*\S+\s*$/i.test(line))
			.join("\n")
			.trimEnd();
	}

	// Suppress reasoning chrome (config + defense-in-depth strip).
	acc.finalText = stripHermesReasoningNoise(acc.finalText);
	if (typeof result.output === "string") {
		result.output = stripHermesReasoningNoise(result.output);
	}
	// Keep output aligned with cleaned answer body.
	if (acc.finalText && result.output !== acc.finalText) {
		result.output = acc.finalText;
	}
	const preservedStop =
		result.stopReason === "aborted" ||
		result.completionSource === "abort" ||
		result.completionSource === "idle-timeout" ||
		result.idleTimeout === true;
	if (result.exitCode !== 0 && acc.finalText.trim() && !preservedStop && !result.errorMessage) {
		const sessionNote = acc.sessionId ? ` (session_id=${acc.sessionId})` : "";
		result.stopReason = result.stopReason === "end" ? "error" : (result.stopReason ?? "error");
		result.errorMessage = sanitizeErrorMessage(
			`Hermes quiet run failed with exit code ${result.exitCode}${sessionNote} after producing partial output.`,
		);
	}

	// Prefer provider Error: lines from stderr over core's generic empty-output
	// message. Core may have already flipped exitCode 0→1 with a placeholder.
	// Never rewrite abort / idle-timeout diagnostics.
	if (!acc.finalText.trim()) {
		const stderr = result.stderr ?? "";
		const errLine = stderr.match(/^\s*Error:\s*(.+)$/im)?.[1]?.trim();
		const sessionNote = acc.sessionId ? ` (session_id=${acc.sessionId})` : "";
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
