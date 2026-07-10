/**
 * Host-neutral subagent execution contract.
 *
 * This is the seam that lets pi-taskflow's engine run on any host (pi, Codex,
 * …) without knowing how a subagent is actually spawned. The engine
 * (`runtime.ts`) only ever talks to a `SubagentRunner`; each host ships one
 * concrete implementation:
 *
 *   - pi    → `piSubagentRunner`  (spawns `pi --mode json -p …`, in runner.ts)
 *   - codex → `codexSubagentRunner` (spawns `codex exec --json …`, future)
 *
 * The data types here (`RunResult`, `RunOptions`, `LiveUpdate`) are
 * deliberately host-agnostic: they describe *what* a subagent run produces, not
 * *how* it was produced. Nothing in this file imports a host SDK.
 *
 * `runner.ts` re-exports these types so every existing
 * `import { RunResult, RunOptions, … } from "./runner.ts"` keeps working
 * unchanged — this file is purely additive.
 */

import type { UsageStats } from "../usage.ts";

/**
 * Minimal structural `Message` shape the core parser needs. Vendored (instead of
 * importing `@earendil-works/pi-ai`) so `taskflow-core` stays host-SDK-free. A
 * host whose subagent emits richer messages can pass them through — only these
 * fields are read structurally; everything else is accessed defensively.
 */
export interface CoreMessagePart {
	type: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}
export interface CoreMessage {
	role: string;
	content: CoreMessagePart[];
	[k: string]: unknown;
}

/** The structured outcome of a single subagent run, independent of host. */
export interface RunResult {
	agent: string;
	task: string;
	exitCode: number;
	output: string;
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	/** Total subagent attempts incl. retries (set by the runtime's retry wrapper). */
	attempts?: number;
	/** Set when the subagent was killed by the idle watchdog (not a user abort). */
	idleTimeout?: boolean;
	/** Set when the subagent was aborted by the phase's own `timeout` cap (not a
	 *  user abort, not an idle stall). Deterministic — never retried. */
	phaseTimeout?: boolean;
}

/** A streaming progress tick from a running subagent. */
export interface LiveUpdate {
	/** Latest assistant text or tool activity (single-line, truncated upstream). */
	text: string;
	usage: UsageStats;
	model?: string;
}

/** Per-run knobs the engine passes to whichever host runner executes the task. */
export interface RunOptions {
	model?: string;
	thinking?: string;
	tools?: string[];
	cwd?: string;
	signal?: AbortSignal;
	/** Fires on each assistant turn with the latest activity + accumulated usage. */
	onLive?: (live: LiveUpdate) => void;
	/**
	 * Idle watchdog: if the subagent produces no output for this many ms, it is
	 * considered stalled (hung stream / provider stall / tool deadlock) and is
	 * killed. Resets on every output chunk. 0/undefined keeps the host default.
	 */
	idleTimeoutMs?: number;
	/**
	 * Shared Context Tree (opt-in). When set, the spawned subagent is given the
	 * blackboard dir + node id so it can register the ctx_* tools (read/write/
	 * report/spawn). A host that cannot inject these may ignore them (fail-open:
	 * context sharing simply degrades to "no sharing").
	 */
	ctxDir?: string;
	nodeId?: string;
}

/**
 * The minimal contract a host must satisfy to execute taskflow subagents.
 *
 * `agents` is the resolved agent roster (name → model/prompt/tools); the runner
 * looks up `agentName` in it. `globalThinking` is the flow-level default applied
 * when neither the per-phase opts nor the agent frontmatter set a thinking
 * level. A runner MUST resolve a successful run to a `RunResult` (never throw
 * for an ordinary subagent failure) — set `exitCode`/`stopReason`/`errorMessage`
 * instead, so the engine's retry and fail-soft logic can act on it.
 */
export interface SubagentRunner<TAgent = unknown> {
	/** Whether this host reports authoritative token/cost usage. `unavailable`
	 * makes runtime budget declarations fail closed at every execution boundary. */
	readonly usageAccounting?: "available" | "unavailable";
	runTask(
		defaultCwd: string,
		agents: TAgent[],
		agentName: string,
		task: string,
		opts: RunOptions,
		globalThinking?: string,
	): Promise<RunResult>;
}
