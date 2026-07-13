/**
 * Host-neutral subagent-result helpers: failure classification, transient-error
 * detection, error sanitization, and the NDJSON event accumulator/parser, PLUS
 * the shared `runSubagentProcess` that the codex/claude/opencode runners delegate
 * to for the identical spawn / idle-watchdog / abort / signal-kill / stderr-cap /
 * post-exit classification block.
 *
 * This is the pure, host-SDK-free half of the original runner. The pi spawn
 * machinery lives in the pi adapter (`pi-taskflow`); the codex/claude/opencode
 * spawn machinery in their adapters. All of them reuse everything here so
 * failure semantics, retry heuristics, and usage folding are identical across
 * hosts.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { emptyUsage, type UsageStats } from "./usage.ts";
import type { AgentConfig } from "./agents.ts";
import type { CoreMessage, LiveUpdate, RunResult } from "./host/runner-types.ts";

// Re-export the host-neutral execution contract types so importers of the
// runner surface get them from one place.
export type { CoreMessage, LiveUpdate, RunOptions, RunResult, SubagentRunner } from "./host/runner-types.ts";

export function isFailed(r: RunResult): boolean {
	return r.exitCode !== 0 || Boolean(r.errorMessage) || r.stopReason === "error" || r.stopReason === "aborted";
}

/**
 * Heuristic: did this failure look like a transient/retryable provider error
 * (rate limit, overload, timeout, 5xx)? Such errors should be retried inside
 * the taskflow run with backoff rather than bubbled up — otherwise the calling
 * agent tends to re-invoke the whole tool, producing duplicate progress blocks.
 */
const TRANSIENT_ERROR_RE =
	/rate[_\s-]?limit|too[ \t\n\r]+many[ \t\n\r]+requests|overloaded|\b429\b|\b503\b|\b502\b|\b504\b|service[ \t\n\r]+unavailable|temporarily[ \t\n\r]+unavailable|timeout|timed?[ \t\n\r]+out|econnreset|etimedout|socket[ \t\n\r]+hang[ \t\n\r]*up/i;
export function isTransientError(r: RunResult): boolean {
	if (r.stopReason === "aborted") return false;
	// Idle timeout is a deterministic stall — retrying won't help.
	if (r.stopReason === "error" && r.idleTimeout) return false;
	// A phase-timeout abort is deterministic: retrying would double-spend the cap.
	if (r.phaseTimeout) return false;
	const hay = `${r.errorMessage ?? ""} ${r.stderr ?? ""} ${r.output ?? ""}`;
	return TRANSIENT_ERROR_RE.test(hay);
}

/** Wait for a retry backoff, but release immediately when the run is aborted.
 * Resolves (rather than rejects) on abort so callers can leave their retry loop
 * through the normal `signal.aborted` branch and preserve paused semantics. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0 || signal?.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});
}

/** Placeholder written to a failed phase's `output` so downstream interpolation
 *  can detect "upstream failed" without being polluted by raw HTML/JSON. */
export const TRANSPORT_ERROR_PLACEHOLDER = "(upstream error: subagent failed; see error)";

/** Hard cap on the errorMessage field stored in PhaseState (≈ 4 KB). */
export const ERROR_MESSAGE_MAX_LEN = 4096;

/** Cheap HTML/JSON detector so we can summarize upstream garbage. */
export function looksLikeHtmlOrJson(s: string): boolean {
	const t = s.trimStart();
	if (!t) return false;
	if (t.startsWith("<")) {
		// HTML/XML/Cloudflare challenge pages
		return /^<(?:!doctype[ \t\n\r]+html|html|head|body|script|svg|div|iframe|span|p)\b/i.test(t);
	}
	if (t.startsWith("{")) {
		// Truncated JSON. A genuine JSON envelope is fine to keep; an unwrapped
		// {error: "..."} from an SDK is short. We only treat it as "garbage" if
		// it parses and is huge — but that's caught by the size cap below.
		return false;
	}
	return false;
}

/**
 * Truncate and (when obviously HTML) summarize an errorMessage before it is
 * persisted. Returns the cleaned string. Empty input returns empty.
 */
export function sanitizeErrorMessage(raw: string | undefined): string {
	if (!raw) return "";
	const cleaned = raw.replace(/[ \t\n\r]+/g, " ").trim();
	if (!cleaned) return "";
	// Decide the sanitization branch on the RAW length, not the whitespace-
	// collapsed length — otherwise an HTML page padded with spaces would slip
	// through the "looks like HTML" branch and be persisted as-is.
	const rawLen = raw.length;
	if (rawLen > ERROR_MESSAGE_MAX_LEN) {
		const head = cleaned.slice(0, 200);
		const tail = cleaned.slice(-200);
		return `${head} ... [truncated ${rawLen - 400} chars] ... ${tail}`;
	}
	if (looksLikeHtmlOrJson(cleaned)) {
		// Any document-like HTML (Cloudflare challenge pages, proxy error pages,
		// gateway error pages) is a strong signal the upstream returned a page
		// instead of JSON. Summarize it instead of letting HTML pollute the
		// phase's error and downstream interpolation contexts.
		const title = cleaned.match(/<title\b[^>]*>([^<]{0,500})<\/title>/i)?.[1]?.trim();
		const stripped = cleaned.replace(/<[^>]{1,2000}>/g, " ").replace(/[ \t\n\r]+/g, " ").trim();
		const m = stripped.match(/(?:Unable to load site|Ray ID[: ]+([A-Za-z0-9]+)|[A-Z][a-z]+Error[: ]+(.{0,200}))/i);
		const hint = title || (m ? (m[1] || m[0]).trim() : stripped.slice(0, 200));
		return `Upstream returned non-JSON response (${rawLen} chars). Hint: ${hint}`;
	}
	return cleaned;
}

export function getFinalOutput(messages: CoreMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text?.trim()) return part.text;
			}
		}
	}
	return "";
}

/** Accumulated state folded from a subagent's NDJSON event stream. */
export interface EventAccumulator {
	messages: CoreMessage[];
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	lastActivity: string;
	/** Set when message cap was hit — output gets a truncation notice. */
	truncated?: boolean;
}

export function newAccumulator(model?: string): EventAccumulator {
	return { messages: [], usage: emptyUsage(), model, lastActivity: "" };
}

/**
 * Fold one NDJSON line into the accumulator. Returns a LiveUpdate when an
 * assistant message ended (for streaming), else null. Empty, malformed, and
 * non-`message_end` lines are ignored — making the parser robust to partial
 * buffers/noise and unit-testable without spawning a process.
 */
export function foldEventLine(acc: EventAccumulator, line: string): LiveUpdate | null {
	if (!line.trim()) return null;
	let event: any;
	try {
		event = JSON.parse(line);
	} catch {
		return null;
	}
	if (event.type !== "message_end" || !event.message) return null;
	const msg = event.message as CoreMessage;
	// Cap prevents OOM from misconfigured loops. 500 messages is generous for
	// normal subagent tasks (50 turns × 10 messages each). Messages beyond the
	// cap are still parsed for usage/model/stopReason extraction.
	const MAX_MESSAGES = 500;
	if (acc.messages.length < MAX_MESSAGES) {
		acc.messages.push(msg);
	} else {
		acc.truncated = true;
	}
	if (msg.role !== "assistant") return null;
	acc.usage.turns++;
	const u = (msg as any).usage;
	if (u) {
		acc.usage.input += u.input || 0;
		acc.usage.output += u.output || 0;
		acc.usage.cacheRead += u.cacheRead || 0;
		acc.usage.cacheWrite += u.cacheWrite || 0;
		acc.usage.cost += u.cost?.total || 0;
		acc.usage.contextTokens = u.totalTokens || 0;
	}
	if (!acc.model && (msg as any).model) acc.model = (msg as any).model;
	if ((msg as any).stopReason) acc.stopReason = (msg as any).stopReason;
	if ((msg as any).errorMessage) acc.errorMessage = (msg as any).errorMessage;
	const activity = describeActivity(msg);
	if (activity) acc.lastActivity = activity;
	return { text: acc.lastActivity, usage: { ...acc.usage }, model: acc.model };
}

/** One-line description of the most recent assistant activity (text or tool call). */
function describeActivity(msg: CoreMessage): string {
	if (msg.role !== "assistant") return "";
	let lastText = "";
	let lastTool = "";
	for (const part of (msg as any).content ?? []) {
		if (part.type === "text" && part.text?.trim()) lastText = part.text.trim();
		else if (part.type === "toolCall") lastTool = summarizeToolCall(part.name, part.arguments ?? {});
	}
	const chosen = lastText || lastTool;
	return chosen.replace(/[ \t\n\r]+/g, " ").trim();
}

function summarizeToolCall(name: string, args: Record<string, unknown>): string {
	const short = (p: unknown) => {
		const s = String(p ?? "");
		return s.length > 48 ? `${s.slice(0, 48)}…` : s;
	};
	switch (name) {
		case "bash":
			return `$ ${short(args.command)}`;
		case "read":
			return `read ${short(args.path ?? args.file_path)}`;
		case "write":
			return `write ${short(args.path ?? args.file_path)}`;
		case "edit":
			return `edit ${short(args.path ?? args.file_path)}`;
		case "grep":
			return `grep ${short(args.pattern)}`;
		case "find":
			return `find ${short(args.pattern)}`;
		case "ls":
			return `ls ${short(args.path)}`;
		default:
			return `${name}`;
	}
}

/** Run an array of items through `fn` with a bounded concurrency pool. */
export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

// ---------------------------------------------------------------------------
// Shared subagent process runner
// ---------------------------------------------------------------------------
//
// The codex/claude/opencode host runners each spawn an isolated CLI process,
// fold its JSON event stream into an accumulator, and classify the outcome
// into a RunResult. The spawn + idle-watchdog + abort + signal-kill + stderr-
// cap + post-exit classification block was copy-pasted across all three
// (~82 lines × 3, byte-identical after renaming) — which already caused one
// divergence bug (contextTokens). This function is that block, extracted once.
//
// Each host runner now does only what is genuinely host-specific — build the
// argv (bin/flags/model/permission/prompt) and provide a foldLine + accumulator
// — then delegates here for everything else. Adding a new host can no longer
// drift the process/classify contract.

/** Coerce a JSON-sourced numeric field to a finite number, defaulting to 0.
 *  Provider event streams are parsed off `any`; a version drift could ship a
 *  numeric STRING (e.g. "1234"), and `number += string` silently corrupts to
 *  string concatenation / NaN. This guard keeps usage accounting honest. */
export function num(v: unknown): number {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}

/** Tracks every live subagent child so a process exit can SIGKILL stragglers.
 *  Module-global (not per-host): a single exit handler must reach every host's
 *  children, so all host runners register here. */
const activeChildren = new Set<number>();

/** Signal the whole process tree rooted at a spawned subagent. POSIX children
 * are process-group leaders (`detached:true` at spawn), so a negative pid
 * reaches every descendant in the group. Windows has no equivalent signal;
 * taskkill /T /F is the platform-supported tree termination primitive. */
export function killProcessTree(pid: number, signal: NodeJS.Signals, direct?: ChildProcess): void {
	if (process.platform === "win32") {
		try {
			const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
				shell: false,
				stdio: "ignore",
				windowsHide: true,
			});
			killer.once("error", () => {
				try { direct?.kill(); } catch { /* already dead */ }
			});
			killer.unref();
		} catch {
			try { direct?.kill(); } catch { /* already dead */ }
		}
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		// A process can exit between the liveness check and group signal. Falling
		// back to the direct handle also covers platforms that reject group kills.
		try { direct?.kill(signal); } catch { /* already dead */ }
	}
}

/** Synchronous variant for the host's `exit` event, where asynchronous taskkill
 * cannot be awaited and would never get a chance to run. */
function killProcessTreeSync(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
				shell: false,
				stdio: "ignore",
				windowsHide: true,
			});
		} catch { /* already dead / taskkill unavailable */ }
		return;
	}
	try { process.kill(-pid, "SIGKILL"); } catch { /* already dead */ }
}

const killAllChildren = () => {
	for (const pid of activeChildren) {
		killProcessTreeSync(pid);
	}
};
process.on("exit", killAllChildren);

/** Same idle window every host runner uses: a child silent this long is wedged. */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

/** After a phase timeout aborts its runner, allow process-backed hosts enough
 * time to execute their SIGTERM to SIGKILL escalation. A custom runner that
 * ignores AbortSignal entirely is still bounded by this grace window. */
export const PHASE_TIMEOUT_ABORT_GRACE_MS = 5500;

/** Maximum NDJSON line size retained while waiting for a newline. A hostile or
 * broken host can otherwise stream an unterminated line until the orchestrator
 * runs out of memory. Host events are expected to be compact; 1 MiB still
 * leaves ample room for a large final answer while providing a hard bound. */
export const MAX_STDOUT_LINE_BYTES = 1024 * 1024;

/** The base accumulator contract the shared process runner reads/writes. Each
 *  host's accumulator (Codex/Claude/OpenCode) satisfies this structurally and
 *  may carry extra fields (e.g. claude's `sawResult`) its own foldLine uses. */
export interface SubagentAccumulator {
	usage: UsageStats;
	model?: string;
	/** Final answer text (the host's foldLine sets this from its event stream). */
	finalText: string;
	lastActivity: string;
	/** Set by the host foldLine when the stream reported a fatal error event. */
	fatalError?: string;
	/** Set by hosts whose protocol has an authoritative terminal event. */
	terminalSeen?: boolean;
}

/** Standard "unknown agent" RunResult — identical across every host runner. */
export function unknownAgentResult(
	agentName: string,
	task: string,
	agents: AgentConfig[],
): RunResult {
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

export interface RunSubagentProcessOptions<TAcc extends SubagentAccumulator> {
	/** Identity fields written verbatim onto the RunResult. */
	agent: string;
	task: string;
	model?: string;
	/** Spawn spec. `env` defaults to the parent process env; a host may override
	 *  (e.g. opencode injects OPENCODE_CONFIG_CONTENT for read-only phases). */
	bin: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
	cwd: string;
	/** Execution knobs (forwarded from the phase's RunOptions). */
	idleTimeoutMs?: number;
	signal?: AbortSignal;
	onLive?: (live: LiveUpdate) => void;
	/** Per-host event folding: the host's accumulator + its line parser. */
	acc: TAcc;
	foldLine: (acc: TAcc, line: string) => LiveUpdate | null;
	/** Fail closed when the CLI exits zero before its authoritative terminal event. */
	requireTerminalEvent?: boolean;
	terminalEventLabel?: string;
}

/** Spawn an isolated subagent process, fold its event stream, and classify the
 *  outcome into a RunResult. The whole tail (fatalError, signal-kill remap,
 *  idle-timeout, abort, isFailed + placeholder + sanitize) is the single source
 *  of truth — every host runner that delegates here gets identical semantics. */
export async function runSubagentProcess<TAcc extends SubagentAccumulator>(
	opts: RunSubagentProcessOptions<TAcc>,
): Promise<RunResult> {
	const { agent, task, model, bin, args, cwd, acc, foldLine } = opts;
	const env = opts.env ?? { ...process.env };
	const result: RunResult = {
		agent,
		task,
		exitCode: 0,
		output: "",
		stderr: "",
		usage: emptyUsage(),
		model,
	};

	let wasAborted = false;
	let idleTimedOut = false;
	let killedBySignal: string | undefined;
	let protocolError: string | undefined;
	const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

	// Structured run-log header, opt-in via PI_TASKFLOW_RUN_LOG. Written to the
	// HOST process's stderr (the MCP stdio log channel; pi's subagent diagnostic
	// stream) — never to stdout (stdout is JSON-RPC for MCP). One line per spawn
	// so an operator tailing stderr can see which agent/bin produced the
	// following child output. Default-off to avoid surprising users who capture
	// stderr; set PI_TASKFLOW_RUN_LOG=1 to enable.
	if (process.env.PI_TASKFLOW_RUN_LOG) {
		const flag = String(process.env.PI_TASKFLOW_RUN_LOG).toLowerCase();
		if (flag && flag !== "0" && flag !== "false") {
			process.stderr.write(
				`[taskflow:run] agent=${agent} bin=${bin} model=${model ?? "-"} args=${JSON.stringify(args)}\n`,
			);
		}
	}

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(bin, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env,
			// On POSIX this makes the subagent a process-group leader while retaining
			// piped stdout/stderr. Cancellation can then signal `-pid` and cannot
			// strand grandchildren that outlive the direct CLI process.
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		if (proc.pid) activeChildren.add(proc.pid);

		let buffer = "";
		let idleTimer: NodeJS.Timeout | undefined;
		let forceTimer: NodeJS.Timeout | undefined;
		let settled = false;
		let removeAbortListener = () => {};
		const clearTimers = () => {
			if (idleTimer) {
				clearTimeout(idleTimer);
				idleTimer = undefined;
			}
			if (forceTimer) {
				clearTimeout(forceTimer);
				forceTimer = undefined;
			}
		};
		const signalTree = (signal: NodeJS.Signals) => {
			if (proc.pid) killProcessTree(proc.pid, signal, proc);
			else {
				try { proc.kill(signal); } catch { /* spawn failed / already dead */ }
			}
		};
		const hardKill = () => {
			idleTimedOut = true;
			signalTree("SIGTERM");
			forceTimer = setTimeout(() => signalTree("SIGKILL"), 5000);
			forceTimer.unref();
		};
		const armIdle = () => {
			if (idleTimer) clearTimeout(idleTimer);
			if (idleMs <= 0) return;
			idleTimer = setTimeout(hardKill, idleMs);
			idleTimer.unref();
		};
		armIdle();

		const failProtocol = (message: string) => {
			if (protocolError) return;
			protocolError = message;
			signalTree("SIGTERM");
			forceTimer = setTimeout(() => signalTree("SIGKILL"), 5000);
			forceTimer.unref();
		};
		const processLine = (line: string) => {
			if (!line.trim() || protocolError) return;
			// Every supported host advertises a JSON/NDJSON stream. Treat malformed
			// records as a protocol failure: silently dropping them can turn a
			// truncated provider error into a successful phase with empty output.
			try {
				JSON.parse(line);
			} catch {
				failProtocol("Subagent emitted malformed or truncated JSON output");
				return;
			}
			let live: LiveUpdate | null;
			try {
				live = foldLine(acc, line);
			} catch (error) {
				failProtocol(`Subagent output parser failed: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			// onLive is a user callback and remains fail-open; parser failures above
			// are part of the transport contract and therefore fail closed.
			if (live && opts.onLive) {
				try { opts.onLive(live); } catch { /* user callback must not sink run */ }
			}
		};

		proc.stdout.on("data", (data) => {
			armIdle();
			buffer += data.toString();
			if (Buffer.byteLength(buffer) > MAX_STDOUT_LINE_BYTES && !buffer.includes("\n")) {
				// Drop the retained bytes before terminating so the bound remains true
				// even while a non-cooperative child takes time to die.
				buffer = "";
				failProtocol(`Subagent emitted an unterminated stdout record larger than ${MAX_STDOUT_LINE_BYTES} bytes`);
				return;
			}
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (Buffer.byteLength(line) > MAX_STDOUT_LINE_BYTES) {
					failProtocol(`Subagent emitted a stdout record larger than ${MAX_STDOUT_LINE_BYTES} bytes`);
					break;
				}
				processLine(line);
			}
		});

		const STDERR_MAX_LEN = 64 * 1024;
		let stderrCapped = false;
		proc.stderr.on("data", (data) => {
			// Diagnostics are real child activity too. A CLI that is actively
			// reporting provider retries on stderr must not be killed as idle.
			armIdle();
			if (!stderrCapped) {
				result.stderr += data.toString();
				if (result.stderr.length >= STDERR_MAX_LEN) {
					result.stderr = result.stderr.slice(0, STDERR_MAX_LEN) + "\n[...stderr truncated at 64KB]";
					stderrCapped = true;
				}
			}
		});

		// `close` waits for inherited stdio handles. A direct CLI can exit while a
		// background descendant still owns stdout/stderr, so reap the group at the
		// earlier `exit` boundary; `close` remains the point where buffered output
		// is folded and the result is settled.
		proc.once("exit", () => {
			if (proc.pid) killProcessTree(proc.pid, "SIGKILL", proc);
		});

		const finish = (code: number, signal?: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			// The direct CLI may intentionally or accidentally leave background
			// descendants behind. A phase boundary is also a process-tree boundary:
			// always reap the group before returning, not only on abort/idle timeout.
			// Otherwise detached grandchildren can keep mutating the workspace after
			// the phase has been persisted as complete.
			if (proc.pid) killProcessTree(proc.pid, "SIGKILL", proc);
			if (proc.pid) activeChildren.delete(proc.pid);
			clearTimers();
			removeAbortListener();
			if (buffer.trim()) processLine(buffer);
			if (signal) killedBySignal = signal;
			resolve(code);
		};
		proc.on("close", (code, signal) => {
			finish(code ?? 0, code === null ? signal : undefined);
		});
		proc.on("error", (err) => {
			if (!result.stderr) result.stderr = err.message;
			if (!result.errorMessage) result.errorMessage = err.message;
			finish(1);
		});

		if (opts.signal) {
			const kill = () => {
				wasAborted = true;
				// Disarm the idle watchdog first: otherwise, if the idle timer fires
				// between this SIGTERM and the close event, `idleTimedOut` would be
				// set and the post-exit classify chain (which checks idle BEFORE
				// abort) would misreport a user abort as an idle stall.
				clearTimers();
				signalTree("SIGTERM");
				forceTimer = setTimeout(() => signalTree("SIGKILL"), 5000);
				forceTimer.unref();
			};
			if (opts.signal.aborted) kill();
			else {
				opts.signal.addEventListener("abort", kill, { once: true });
				removeAbortListener = () => {
					opts.signal?.removeEventListener("abort", kill);
					removeAbortListener = () => {};
				};
			}
		}
	});

	result.exitCode = exitCode;
	result.usage = acc.usage;
	result.model = acc.model;
	result.output = acc.finalText;

	if (protocolError) {
		result.exitCode = result.exitCode || 1;
		result.stopReason = "error";
		result.errorMessage = protocolError;
	} else if (acc.fatalError) {
		result.exitCode = result.exitCode || 1;
		result.stopReason = "error";
		result.errorMessage = acc.fatalError;
	} else {
		result.stopReason = exitCode === 0 ? "end" : "error";
	}
	if (!isFailed(result) && opts.requireTerminalEvent && !acc.terminalSeen) {
		result.exitCode = 1;
		result.stopReason = "error";
		result.errorMessage = `Subagent stream ended before ${opts.terminalEventLabel ?? "the terminal event"}`;
	}

	if (exitCode === 0 && killedBySignal && !idleTimedOut && !wasAborted && !protocolError) {
		result.exitCode = 1;
		result.stopReason = "error";
		result.errorMessage = `Subagent killed by signal ${killedBySignal}`;
	}
	if (idleTimedOut) {
		result.stopReason = "error";
		result.idleTimeout = true;
		result.errorMessage = `Subagent stalled: no output for ${Math.round(idleMs / 1000)}s (idle timeout) — killed`;
	} else if (wasAborted) {
		result.stopReason = "aborted";
		result.errorMessage = "Subagent was aborted";
	}
	// A zero exit with no answer is not evidence of successful agent work. It is
	// the characteristic outcome of a truncated/unknown host stream whose lines
	// were syntactically valid but never contained a terminal answer.
	if (!isFailed(result) && !result.output.trim()) {
		result.exitCode = 1;
		result.stopReason = "error";
		result.errorMessage = "Subagent exited successfully without a final output";
	}

	if (isFailed(result)) {
		if (!result.output) {
			result.output = TRANSPORT_ERROR_PLACEHOLDER;
			if (!result.errorMessage) {
				result.errorMessage =
					result.stderr || `Subagent exited with code ${result.exitCode} (stopReason: ${result.stopReason ?? "unknown"})`;
			}
		}
		if (result.errorMessage) result.errorMessage = sanitizeErrorMessage(result.errorMessage);
	}

	return result;
}
