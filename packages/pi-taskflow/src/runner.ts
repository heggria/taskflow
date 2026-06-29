/**
 * Subagent runner — spawns an isolated `pi --mode json -p` process for a single
 * task and collects its structured output and usage. Adapted from the pi
 * subagent extension's runSingleAgent.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	emptyUsage,
	isFailed,
	newAccumulator,
	foldEventLine,
	sanitizeErrorMessage,
	TRANSPORT_ERROR_PLACEHOLDER,
	getFinalOutput,
	type AgentConfig,
	type RunOptions,
	type RunResult,
	type SubagentRunner,
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

const activeChildren = new Set<number>();
const killAll = () => {
	for (const pid of activeChildren) {
		try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
	}
};
process.on("exit", killAll);
process.on("SIGTERM", () => { killAll(); process.exit(143); });

// `RunResult`, `LiveUpdate`, and `RunOptions` are defined in the host-neutral
// contract (./host/runner-types.ts) and re-exported above. Their JSDoc and the
// pi-specific notes (PI_TASKFLOW_CTX_DIR / --extension for ctx_* tools) live
// with the pi implementation below.

/**
 * Default idle-watchdog window. A subagent that emits nothing on stdout for this
 * long is treated as wedged and killed so a single stalled child cannot hang the
 * entire taskflow forever (the only previous escape was a manual user abort).
 * 5 minutes is generous enough for slow reasoning/long tool calls while still
 * bounding a true hang.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

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
): Promise<RunResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			task,
			exitCode: 1,
			output: "",
			stderr: `Unknown agent: "${agentName}". Available: ${available}.`,
			usage: emptyUsage(),
			errorMessage: `Unknown agent: ${agentName}`,
			stopReason: "error",
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
	if (model) args.push("--model", model);
	if (thinking) args.push("--thinking", thinking);
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const acc = newAccumulator(model);
	const result: RunResult = {
		agent: agentName,
		task,
		exitCode: 0,
		output: "",
		stderr: "",
		usage: emptyUsage(),
		model,
	};

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
		args.push(`Task: ${task}`);

		// Shared Context Tree opt-in: load THIS extension into the subagent so it
		// can register the ctx_* tools, and pass the blackboard dir + node id via
		// env. `--extension` is the explicit, self-documenting fallback that does
		// not rely on the subagent auto-discovering user/project extensions in
		// `-p` mode. The env vars drive the dual-identity branch in index.ts.
		const ctxEnv: Record<string, string> = {};
		if (opts.ctxDir && opts.nodeId) {
			const selfPath = ctxExtensionPath();
			if (selfPath) args.push("--extension", selfPath);
			ctxEnv.PI_TASKFLOW_CTX_DIR = opts.ctxDir;
			ctxEnv.PI_TASKFLOW_NODE_ID = opts.nodeId;
		}

		let wasAborted = false;
		let idleTimedOut = false;
		let killedBySignal: string | undefined;
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: opts.cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, ...ctxEnv },
			});
			if (proc.pid) activeChildren.add(proc.pid);
			let buffer = "";

			// Idle watchdog: a subagent that goes silent on stdout for too long is
			// treated as wedged and killed, so one stalled child cannot hang the
			// whole taskflow forever. The timer is reset on every stdout chunk and
			// torn down on close/error.
			const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
			const clearTimers = () => {
				if (idleTimer) clearTimeout(idleTimer);
				if (forceKillTimer) clearTimeout(forceKillTimer);
			};
			const hardKill = () => {
				proc.kill("SIGTERM");
				forceKillTimer = setTimeout(() => proc.kill("SIGKILL"), 5000);
				forceKillTimer.unref();
			};
			const armIdle = () => {
				if (idleTimer) clearTimeout(idleTimer);
				if (idleMs <= 0) return; // disabled
				idleTimer = setTimeout(() => {
					idleTimedOut = true;
					hardKill();
				}, idleMs);
				idleTimer.unref();
			};
			armIdle();

			const processLine = (line: string) => {
				const live = foldEventLine(acc, line);
				if (live && opts.onLive) opts.onLive(live);
			};

			proc.stdout.on("data", (data) => {
				armIdle(); // progress observed — reset the idle watchdog
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			// Cap prevents OOM from verbose tool output (e.g., npm install). 64 KB is
			// generous for error diagnosis while preventing memory exhaustion.
			const STDERR_MAX_LEN = 64 * 1024;
			let stderrCapped = false;
			proc.stderr.on("data", (data) => {
				if (!stderrCapped) {
					result.stderr += data.toString();
					if (result.stderr.length >= STDERR_MAX_LEN) {
						result.stderr = result.stderr.slice(0, STDERR_MAX_LEN) + "\n[...stderr truncated at 64KB]";
						stderrCapped = true;
					}
				}
			});
			proc.on("close", (code, signal) => {
				if (proc.pid) activeChildren.delete(proc.pid);
				clearTimers();
				if (buffer.trim()) processLine(buffer);
				if (code === null && signal) killedBySignal = signal;
				resolve(code ?? 0);
			});
			proc.on("error", (err) => {
				clearTimers();
				if (!result.stderr) result.stderr = err.message;
				if (!result.errorMessage) result.errorMessage = err.message;
				resolve(1);
			});

			if (opts.signal) {
				const kill = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					// Force-kill fallback. proc.kill("SIGKILL") is idempotent if
					// the process already exited, and `proc.killed` is set true
					// synchronously by the SIGTERM above — so the previous
					// `if (!proc.killed)` guard would skip SIGKILL entirely,
					// hanging forever on a child that ignores SIGTERM.
					// .unref() keeps the timer from holding the event loop open
					// after the process is gone.
					const forceKill = setTimeout(() => proc.kill("SIGKILL"), 5000);
					forceKill.unref();
				};
				if (opts.signal.aborted) kill();
				else opts.signal.addEventListener("abort", kill, { once: true });
			}
		});

		result.exitCode = exitCode;
		result.usage = acc.usage;
		result.model = acc.model;
		result.stopReason = acc.stopReason;
		result.errorMessage = acc.errorMessage;
		result.output = getFinalOutput(acc.messages);
		// M-6: surface truncation when the message cap was hit so downstream
		// phases and the user know output was cut short.
		if (acc.truncated) {
			result.output += "\n\n[...output truncated after 500 messages]";
		}
		// Signal kill detection: process exited 0 but was killed by a signal
		// (e.g. OOM killer, cgroup limit). Treat as failure so the runtime's
		// retry/fail handling doesn't silently accept a truncated result.
		if (exitCode === 0 && killedBySignal && !idleTimedOut && !wasAborted) {
			result.exitCode = 1;
			result.stopReason = "error";
			result.errorMessage = `Subagent killed by signal ${killedBySignal}`;
		}
		if (idleTimedOut) {
			// Distinct, actionable signal: the child was killed for being idle, not
			// a user abort. stopReason "error" keeps it in the failed bucket so the
			// runtime's retry/fail handling treats it as a real failure.
			result.stopReason = "error";
			result.idleTimeout = true;
			result.errorMessage = `Subagent stalled: no output for ${Math.round((opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS) / 1000)}s (idle timeout) — killed`;
		} else if (wasAborted) {
			result.stopReason = "aborted";
			result.errorMessage = "Subagent was aborted";
		}
		// On failure, build a short, structured errorMessage + a placeholder
		// output. We deliberately do NOT copy the raw errorMessage into
		// `output`: upstream providers (e.g. a Cloudflare challenge page) can
		// surface huge HTML/JSON in errorMessage, and that garbage would
		// otherwise flow into downstream phase interpolations.
		// Sanitization must run whenever the run failed, even if some output
		// was already emitted (e.g. crash mid-stream with a partial result):
		// an unsanitized errorMessage would still leak into PhaseState and
		// downstream interpolation contexts. (F-013)
		if (isFailed(result)) {
			if (!result.output) {
				result.output = TRANSPORT_ERROR_PLACEHOLDER;
				if (!result.errorMessage) {
					result.errorMessage = result.stderr || `Subagent exited with code ${result.exitCode} (stopReason: ${result.stopReason ?? "unknown"})`;
				}
			}
			if (result.errorMessage) {
				result.errorMessage = sanitizeErrorMessage(result.errorMessage);
			}
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
