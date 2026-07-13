/**
 * Subagent runner — spawns an isolated `pi --mode json -p` process for a single
 * task and collects its structured output and usage. Adapted from the pi
 * subagent extension's runSingleAgent.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	newAccumulator,
	foldEventLine,
	runSubagentProcess,
	unknownAgentResult,
	normalizePiChildSettings,
	DEFAULT_PI_CHILD_SETTINGS,
	type AgentConfig,
	type CompletionPolicy,
	type EventAccumulator,
	type PiChildSettings,
	type RunOptions,
	type RunResult,
	type SubagentRunner,
	CWD_BRIDGE_MODE_ENV,
	WORKSPACE_RECONCILE_MODE_ENV,
} from "taskflow-core";

// Re-export the host-neutral execution contract + pure helpers so every existing
// `import { RunResult, isFailed, foldEventLine, … } from "./runner.ts"` keeps
// working. The canonical definitions live in taskflow-core (the seam that lets
// pi-taskflow run on pi, Codex, …).
export {
	emptyUsage,
	isFailed,
	isTransientError,
	looksLikeHtmlOrJson,
	newAccumulator,
	foldEventLine,
	sanitizeErrorMessage,
	mapWithConcurrencyLimit,
	TRANSPORT_ERROR_PLACEHOLDER,
	ERROR_MESSAGE_MAX_LEN,
} from "taskflow-core";
export type { LiveUpdate, RunOptions, RunResult, SubagentRunner, EventAccumulator } from "taskflow-core";

// `RunResult`, `LiveUpdate`, and `RunOptions` are defined in the host-neutral
// contract (./host/runner-types.ts) and re-exported above. Their JSDoc and the
// pi-specific notes (PI_TASKFLOW_CTX_DIR / --extension for ctx_* tools) live
// with the pi implementation below.

/** The Shared Context Tree tool names a subagent may call when sharing is on. */
export const CTX_TOOL_NAMES = ["ctx_read", "ctx_write", "ctx_report", "ctx_spawn"] as const;

/**
 * Guidance appended to a subagent's system prompt when the Shared Context Tree
 * is enabled for its phase. Registering the ctx_* tools makes them AVAILABLE;
 * this block is what makes the model actually USE them with the right discipline
 * (read-before-you-explore; publish reusable findings; report up; delegate when
 * work fans out). Kept short and imperative on purpose.
 */
export const CTX_TOOLS_GUIDANCE = [
	"## Shared Context Tree (you are part of a coordinated team of agents)",
	"",
	"You are one agent in a tree working a shared goal, with a shared blackboard",
	"and an upward report channel. Use these tools deliberately \u2014 they save tokens",
	"and prevent the team from duplicating work:",
	"",
	"- ctx_read(key?): BEFORE exploring the codebase or re-reading files, call",
	"  ctx_read with no arguments to see what teammates already discovered. If a",
	"  finding you need already exists, REUSE it instead of re-deriving it.",
	"- ctx_write(key, value): when you discover something other agents will likely",
	"  need (a file map, an endpoint list, an interface, a config value), publish it",
	"  under a short key (e.g. 'endpoints', 'db.schema'). Keep values concise and",
	"  structured (JSON) so others can consume them directly.",
	"- ctx_report(summary, structured?): when you finish, report your result upward",
	"  so the parent task and downstream steps can see it. Lead with the outcome.",
	"- ctx_spawn(assignments[]): if you discover the work should fan out into",
	"  independent sub-tasks, delegate them as child agents. They run after you",
	"  finish and their reports are folded back into your output. Only spawn when it",
	"  genuinely parallelizes \u2014 otherwise just do the work yourself.",
	"",
	"Default habit: ctx_read first, do the work (reusing shared findings), ctx_write",
	"anything reusable, then ctx_report your result.",
].join("\n");

async function writePromptToTempFile(filePath: string, prompt: string): Promise<void> {
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	// Explicit override (used by tests and unusual launch setups).
	const override = process.env.PI_TASKFLOW_PI_BIN;
	if (override) return { command: override, args };

	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	// Only re-exec the current script if it actually looks like the pi CLI entry.
	const looksLikePi = currentScript ? /(?:^|[\\/])(?:cli|pi)\.(?:js|mjs|cjs)$/.test(currentScript) : false;
	if (currentScript && !isBunVirtualScript && looksLikePi && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

/**
 * Resolve the path to this extension's entry file, so a spawned subagent can be
 * launched with `--extension <path>` and register the ctx_* tools. Returns
 * undefined if it cannot be resolved (the subagent then simply runs without the
 * ctx tools — fail-open: context sharing degrades to "no sharing").
 */
export function ctxExtensionPath(): string | undefined {
	const override = process.env.PI_TASKFLOW_EXT_PATH;
	if (override) return override;
	try {
		const here = path.dirname(new URL(import.meta.url).pathname);
		const entry = path.join(here, "index.ts");
		if (fs.existsSync(entry)) return entry;
	} catch {
		/* fall through */
	}
	return undefined;
}

interface PiEventAccumulator extends EventAccumulator {
	generation: number;
	finalGeneration?: number;
	terminalGeneration?: number;
}

function newPiAccumulator(model?: string): PiEventAccumulator {
	return { ...newAccumulator(model), generation: 0 };
}

function eventType(event: unknown): string {
	return typeof event === "object" && event !== null && typeof (event as { type?: unknown }).type === "string"
		? (event as { type: string }).type
		: "";
}

function resetPiFinal(acc: PiEventAccumulator): void {
	acc.finalText = "";
	acc.finalGeneration = undefined;
	acc.terminalGeneration = undefined;
	acc.terminalSeen = false;
	acc.stopReason = undefined;
}

function foldPiEventLine(acc: PiEventAccumulator, line: string) {
	const event = JSON.parse(line) as Record<string, unknown>;
	const type = eventType(event);
	if (type === "agent_start" || type === "turn_start") {
		acc.generation++;
		resetPiFinal(acc);
	} else if (
		type === "message_start" || type === "message_update" ||
		type.startsWith("tool_execution_") || type.startsWith("tool_")
	) {
		resetPiFinal(acc);
	}

	const live = foldEventLine(acc, line);
	if (type === "message_end") {
		const message = event.message as Record<string, unknown> | undefined;
		if (message?.role === "assistant") {
			const reason = typeof message.stopReason === "string" ? message.stopReason : undefined;
			if (reason === "error" || reason === "aborted") {
				acc.fatalError =
					typeof message.errorMessage === "string" && message.errorMessage
						? message.errorMessage
						: `Pi assistant stopped with ${reason}`;
				acc.finalGeneration = undefined;
			} else if (reason !== "toolUse" && acc.finalText.trim()) {
				acc.finalGeneration = acc.generation;
			}
		}
	} else if (type === "error") {
		acc.fatalError =
			typeof event.message === "string" && event.message
				? event.message
				: "Pi emitted an error event";
	} else if (type === "agent_end") {
		// Older Pi versions stop at agent_end. Preserve that event as sufficient
		// evidence for a normal process exit, but do not reap on it: newer Pi may
		// still run retry/compaction/session settlement work after agent_end.
		acc.terminalSeen = true;
	} else if (type === "agent_settled") {
		acc.terminalSeen = true;
		acc.terminalGeneration = acc.generation;
	}
	return live;
}

function piCompletionPolicy(terminalGraceMs: number): CompletionPolicy<PiEventAccumulator> {
	return {
		terminalGraceMs,
		classifyEvent(acc, event) {
			const type = eventType(event);
			if (acc.fatalError || type === "error") return "fatal";
			if (type === "agent_settled") return "terminal-candidate";
			if (type === "agent_end") return "activity";
			if (
				type === "agent_start" || type === "turn_start" ||
				type.startsWith("message_") || type.startsWith("tool_execution_") || type.startsWith("tool_")
			) return "activity";
			return "ignore";
		},
		canCommitTerminal(acc) {
			return Boolean(
				acc.terminalSeen && acc.finalText.trim() && acc.finalGeneration !== undefined &&
				acc.finalGeneration === acc.terminalGeneration && !acc.fatalError &&
				acc.stopReason !== "error" && acc.stopReason !== "aborted" && acc.stopReason !== "toolUse",
			);
		},
	};
}

function canonicalAllowlistedExtensions(settings: PiChildSettings): string[] {
	if (settings.resourceProfile !== "allowlist") return [];
	const canonical: string[] = [];
	const seen = new Set<string>();
	for (const configured of settings.extensions) {
		if (!configured.trim() || /[\0-\x1f\x7f]/.test(configured)) {
			throw new Error("taskflow.piChild.extensions entries must be non-empty paths without control characters");
		}
		if (!path.isAbsolute(configured)) {
			throw new Error(`taskflow.piChild extension must be an absolute path: ${configured}`);
		}
		let resolved: string;
		try {
			resolved = fs.realpathSync(configured);
		} catch {
			throw new Error(`taskflow.piChild extension does not exist: ${configured}`);
		}
		if (!fs.statSync(resolved).isFile()) {
			throw new Error(`taskflow.piChild extension is not a file: ${configured}`);
		}
		if (!seen.has(resolved)) {
			seen.add(resolved);
			canonical.push(resolved);
		}
	}
	return canonical;
}

/**
 * Run a single subagent task. Resolves the agent from `agents` by name and
 * spawns an isolated pi process, returning structured output + usage.
 */
export async function runAgentTask(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	opts: RunOptions,
	globalThinking?: string,
	piChildRaw: PiChildSettings = DEFAULT_PI_CHILD_SETTINGS,
): Promise<RunResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) return unknownAgentResult(agentName, task, agents);
	const piChild = normalizePiChildSettings(piChildRaw);
	let configuredExtensions: string[];
	try {
		configuredExtensions = canonicalAllowlistedExtensions(piChild);
	} catch (error) {
		return {
			...unknownAgentResult(agentName, task, agents),
			stderr: error instanceof Error ? error.message : String(error),
			errorMessage: error instanceof Error ? error.message : String(error),
		};
	}

	const model = opts.model ?? agent.model;
	const thinking = opts.thinking ?? agent.thinking ?? globalThinking;
	const ctxEnabledEarly = Boolean(opts.ctxDir && opts.nodeId);
	let tools = opts.tools ?? agent.tools;
	// If the agent restricts tools to a whitelist, the ctx_* tools we register
	// would be filtered out by `--tools` even though they're registered. When
	// context sharing is on, extend the whitelist so the subagent can actually
	// call them. (No whitelist = all tools available = nothing to do.)
	if (ctxEnabledEarly && tools && tools.length > 0) {
		tools = [...new Set([...tools, ...CTX_TOOL_NAMES])];
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (piChild.resourceProfile !== "inherit") args.push("--no-extensions");
	if (model) args.push("--model", model);
	if (thinking) args.push("--thinking", thinking);
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const acc = newPiAccumulator(model);

	try {
		const ctxEnabled = Boolean(opts.ctxDir && opts.nodeId);
		// Build the appended system prompt = the agent's own prompt PLUS, when the
		// Shared Context Tree is enabled for this phase, a guidance block that tells
		// the subagent the ctx_* tools exist and the discipline for using them.
		// Without this the model only sees terse tool descriptions and rarely uses
		// them proactively (capability != usage).
		const appendedPrompt = [agent.systemPrompt.trim(), ctxEnabled ? CTX_TOOLS_GUIDANCE : ""]
			.filter(Boolean)
			.join("\n\n");
		if (appendedPrompt) {
			// Allocate the temp dir + path BEFORE any fallible I/O so that if
			// writeFile throws, tmpPromptDir/tmpPromptPath are already set and
			// the finally block can clean up the directory (F-004).
			tmpPromptDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-taskflow-"));
			const safeName = agent.name.replace(/[^\w.-]+/g, "_");
			tmpPromptPath = path.join(tmpPromptDir, `prompt-${safeName}.md`);
			await writePromptToTempFile(tmpPromptPath, appendedPrompt);
			args.push("--append-system-prompt", tmpPromptPath);
		}
		// Shared Context Tree opt-in: load THIS extension into the subagent so it
		// can register the ctx_* tools, and pass the blackboard dir + node id via
		// env. `--extension` is the explicit, self-documenting fallback that does
		// not rely on the subagent auto-discovering user/project extensions in
		// `-p` mode. The env vars drive the dual-identity branch in index.ts.
		const ctxEnv: Record<string, string> = {};
		const extensionPaths = [...configuredExtensions];
		if (opts.ctxDir && opts.nodeId) {
			const selfPath = ctxExtensionPath();
			if (selfPath) extensionPaths.push(selfPath);
			ctxEnv.PI_TASKFLOW_CTX_DIR = opts.ctxDir;
			ctxEnv.PI_TASKFLOW_NODE_ID = opts.nodeId;
		}
		for (const extensionPath of [...new Set(extensionPaths)]) args.push("--extension", extensionPath);
		// Pi treats the prompt as a positional argument; all flags must precede it.
		args.push(`Task: ${task}`);
		const invocation = getPiInvocation(args);
		const childEnv = { ...process.env, ...ctxEnv };
		// A child agent is not a host principal. Never let it inherit the
		// operator's resolve-only bridge opt-in and mint equivalent authority.
		delete childEnv[CWD_BRIDGE_MODE_ENV];
		delete childEnv[WORKSPACE_RECONCILE_MODE_ENV];
		const result = await runSubagentProcess({
			agent: agentName,
			task,
			model,
			bin: invocation.command,
			args: invocation.args,
			env: childEnv,
			cwd: opts.cwd ?? defaultCwd,
			idleTimeoutMs: opts.idleTimeoutMs,
			signal: opts.signal,
			onLive: opts.onLive,
			acc,
			foldLine: foldPiEventLine,
			completionPolicy: piCompletionPolicy(piChild.terminalGraceMs),
			onTerminalCommit: opts.onTerminalCommit,
			requireTerminalEvent: true,
			terminalEventLabel: "Pi agent_end/agent_settled",
		});
		// M-6: surface truncation when the message cap was hit so downstream
		// phases and the user know output was cut short.
		if (acc.truncated) {
			result.output += "\n\n[...output truncated after 500 messages]";
		}
		return result;
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		}
		if (tmpPromptDir) {
			try {
				fs.rmSync(tmpPromptDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}
}

/**
 * The pi host's `SubagentRunner` implementation: spawns an isolated
 * `pi --mode json -p` process per task via `runAgentTask`. This is the object
 * the engine receives when running under pi; a Codex host ships its own
 * `codexSubagentRunner` against the same `SubagentRunner` contract.
 */
export const piSubagentRunner: SubagentRunner<AgentConfig> = {
	runTask: runAgentTask,
};

/** Create a host-authorized Pi runner. The normalized configuration is copied
 * into the closure so nested/dynamic flows can only inherit the same authority. */
export function createPiSubagentRunner(raw: unknown = DEFAULT_PI_CHILD_SETTINGS): SubagentRunner<AgentConfig> {
	const normalized = normalizePiChildSettings(raw);
	const snapshot: PiChildSettings = {
		...normalized,
		extensions: [...normalized.extensions],
	};
	return {
		runTask: (cwd, agents, agentName, task, opts, globalThinking) =>
			runAgentTask(cwd, agents, agentName, task, opts, globalThinking, snapshot),
	};
}

/**
 * Absolute filesystem path of THIS module — what the host serializes into the
 * detached-run context file as `runnerModule` so the detached-runner child can
 * dynamically import `piSubagentRunner`.
 *
 * Why self-reporting instead of `import.meta.resolve("./runner.ts")` from the
 * caller: `rewriteRelativeImportExtensions` rewrites STATIC import specifiers
 * at compile time but does NOT touch string arguments of
 * `import.meta.resolve()`, so a compiled caller would resolve `dist/runner.ts`
 * — a file that does not exist (the build emits `dist/runner.js`) — and every
 * detached phase would fail with "No subagent runner injected".
 * `import.meta.url` is always the executing file's real path (src/runner.ts in
 * dev, dist/runner.js in prod), so this is correct under both conditions with
 * no extension guessing.
 */
export function runnerModulePath(): string {
	return fileURLToPath(import.meta.url);
}
