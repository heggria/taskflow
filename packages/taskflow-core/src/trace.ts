/**
 * Deterministic-replay trace — the foundation.
 *
 * Every run may emit an **append-only event trace** (`runs/<flow>/<runId>.trace.jsonl`)
 * recording what each subagent call received and produced, plus the runtime's
 * own decisions (gate verdicts, when-guard results, budget hits, cache hits,
 * "this phase cannot be replayed" markers). A future `replay` action consumes
 * this trace to re-evaluate a recorded run against changed decision knobs
 * (thresholds, budget, model route) **without calling the model** — zero tokens.
 *
 * This module is deliberately **host-agnostic and side-effect-light**: it owns
 * only the data shape, a JSONL reader/writer with partial-line tolerance, and a
 * fail-open file-backed sink. The runtime emits events via `RuntimeDeps.trace`;
 * if no sink is injected, nothing happens (the host-agnostic invariant is
 * preserved — runs with no trace sink behave identically to today).
 *
 * **0.1.7 scope**: trace *emission* + read-only `trace` inspection only. The
 * `replay` action (which consumes these events) lands in 0.2.0 — but the schema
 * here is already complete enough that a 0.2.0 replay won't need a breaking
 * migration. See `replay.ts` for the `ReplayDecision` type stub.
 */

import {
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	closeSync,
	statSync,
	mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import type { UsageStats } from "./usage.ts";
import type { ScorerResult } from "./scorers.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Event shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One line in the trace JSONL. `kind` discriminates the record; the optional
 * fields are populated per-kind. A replay consumer groups by `phaseId` and
 * walks events in file (append) order.
 *
 * Design notes (from the cross-adversarial plan review):
 * - `attempt` / `mapIndex` / `variantIndex` discriminate which call was
 *   terminal for a retrying gate, a 30-item map, or a tournament (P0-1).
 * - `input.preRead` records the resolved `context:` file content so a changed
 *   context file is detected as a changed input, not silently reused (P0-2).
 * - `decision` captures the runtime's own verdicts (gate-score, when-guard,
 *   unreplayable) — the things a replay re-adjudicates against recorded
 *   outputs (P0-3..P0-5).
 */
export interface TraceEvent {
	ts: number; // Date.now() at emit
	runId: string;
	phaseId: string;
	kind: "phase-start" | "phase-end" | "subagent-call" | "decision";
	// — subagent-call (the load-bearing record a replay consumes) —
	input?: {
		agent: string;
		model?: string;
		task: string; // the resolved (interpolated) task text
		/** Resolved `context:` file content prepended to the task. Without this a
		 *  changed context file looks like an unchanged input → wrong reuse. */
		preRead?: string;
		/** Stable node path, e.g. "review", "review#item-3", "gate#judge". */
		nodePath: string;
		/** 0-based within runOne's retry loop; the completion's retry-count. */
		attempt?: number;
		/** Index in the items array for `map` phases (undefined otherwise). */
		mapIndex?: number;
		/** 1-based variant number for `tournament` phases (undefined otherwise). */
		variantIndex?: number;
	};
	output?: {
		text: string; // subagent's full output
		model?: string; // actual model that answered
		usage?: UsageStats;
		stopReason?: string;
	};
	/** The runtime's own decision — what a replay re-adjudicates. */
	decision?: TraceDecision;
	// — phase-end —
	status?: "done" | "failed" | "blocked" | "skipped" | "timedOut" | "pending" | "running";
	error?: string;
}

/** Discriminated record of a runtime decision. Reused `as const` kinds keep
 *  replay's type-narrowing sound. */
export type TraceDecision =
	| { type: "gate-verdict"; value: "pass" | "block"; reason?: string }
	| {
			type: "gate-score";
			target: string; // resolved score.target text
			/** Scorer config at emit time (pure scorers re-run from source; code-compiles is read from `results`). */
			results: ScorerResult[]; // per-scorer results — deterministic, already computed
			combined: number; // [0,1] combined score
			threshold?: number; // threshold at emit time
			verdict: "pass" | "block"; // verdict at the original threshold
			evalPassed?: boolean; // whether eval checks auto-passed (skipped the LLM gate)
			judgeOutput?: string; // judge response text, if a judge was invoked
	  }
	| { type: "tournament-winner"; value: number; reason?: string }
	| { type: "budget-hit"; value: string; reason?: string }
	| { type: "cache-hit"; scope: "cross-run" | "run-only"; reason?: string }
	| { type: "when-guard"; expression: string; result: boolean }
	| {
			type: "unreplayable";
			reason: "context-sharing" | "inner-flow" | "context-files" | "unobservable-deps";
	  };

// ─────────────────────────────────────────────────────────────────────────────
// Sink interface + no-op
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sink the runtime calls with each event. **Must not throw** — the runtime
 * wraps calls in try/catch (a disk-full or unwritable trace dir must never
 * crash a run), but implementations should catch their own errors too.
 *
 * Implementations buffer per-phase and flush once at `phase-end` to avoid
 * serialising concurrent subagent completions through a file lock.
 */
export interface TraceSink {
	/** Buffer an event (called from hot paths; must be cheap + lock-free). */
	emit(event: TraceEvent): void;
	/** Flush buffered events for a phase to durable storage. Called at phase-end. */
	flush(phaseId: string): void;
}

/** A sink that drops everything. The default when no sink is injected. */
export const NoopTraceSink: TraceSink = {
	emit() {},
	flush() {},
};

// ─────────────────────────────────────────────────────────────────────────────
// File-backed sink (buffered per phase, flushed at phase-end)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append-only JSONL trace, buffered per phase. Events for a phase accumulate in
 * memory (lock-free) and are written in one locked append at `flush(phaseId)`,
 * so a 30-item `map` fan-out never serialises 30 completions through the file
 * lock. Crash-safety is therefore at the phase boundary, not the sub-call —
 * sufficient for replay, which only needs completed phases.
 *
 * Each flush appends one line per event (`JSON.stringify` + `\n`) to a temp
 * file then renames atomically onto the trace path's *appended* content. To
 * keep appends atomic without read-modify-write races, flush holds an
 * exclusive lock file (`<runId>.trace.lock`) via `O_CREAT|O_EXCL` (the same
 * discipline as `store.ts`'s `withLock`).
 */
export class FileTraceSink implements TraceSink {
	private readonly buffer = new Map<string, TraceEvent[]>();
	private readonly tracePath: string;
	private readonly lockPath: string;

	constructor(tracePath: string) {
		this.tracePath = tracePath;
		this.lockPath = `${tracePath}.lock`;
		// Do NOT probe parent-dir existence here: the flow run directory is often
		// created later by the first saveRun(). mkdir is deferred to flush().
	}

	emit(event: TraceEvent): void {
		try {
			const arr = this.buffer.get(event.phaseId) ?? [];
			arr.push(event);
			this.buffer.set(event.phaseId, arr);
		} catch {
			/* fail-open */
		}
	}

	flush(phaseId: string): void {
		const events = this.buffer.get(phaseId);
		this.buffer.delete(phaseId);
		if (!events || events.length === 0) return;
		// Serialize + append under an exclusive lock. Best-effort: any error is
		// swallowed (trace is never run-breaking). Create the parent dir on first
		// flush so a sink constructed before saveRun still records events.
		try {
			mkdirSync(dirname(this.tracePath), { recursive: true });
			withExclusiveLock(this.lockPath, () => {
				const chunk = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
				appendAtomic(this.tracePath, chunk);
			});
		} catch {
			/* fail-open */
		}
	}
}

/** Atomic append: read current (if any) + write combined to temp + rename. */
function appendAtomic(path: string, chunk: string): void {
	let existing = "";
	try {
		existing = readFileSync(path, "utf8");
	} catch {
		existing = "";
	}
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, existing + chunk, "utf8");
	renameSync(tmp, path);
}

/** Hold an exclusive lock for the duration of `fn` via `O_CREAT|O_EXCL`. */
function withExclusiveLock(lockPath: string, fn: () => void): void {
	let fd: number | undefined;
	const staleMs = 60_000; // steal a lock older than 60s (a crashed writer)
	for (let i = 0; i < 200; i++) {
		try {
			fd = openSync(lockPath, "wx");
			break;
		} catch (e) {
			// Lock exists — steal if stale.
			try {
				const st = statSync(lockPath);
				if (Date.now() - st.mtimeMs > staleMs) {
					const stolen = `${lockPath}.steal-${process.pid}-${Date.now()}`;
					renameSync(lockPath, stolen);
					try {
						unlinkSync(stolen);
					} catch {
						/* ignore */
					}
					continue;
				}
			} catch {
				/* ignore stat failure */
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		}
	}
	if (fd === undefined) {
		// Could not acquire — run unlocked (fail-open; worst case a partial
		// interleaving that JSONL-line-parsing tolerates on read).
		fn();
		return;
	}
	try {
		fn();
	} finally {
		try {
			closeSync(fd);
		} catch {
			/* ignore */
		}
		try {
			unlinkSync(lockPath);
		} catch {
			/* ignore */
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Reader (partial-line tolerant)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read + parse a trace JSONL. Skips blank lines and any trailing partial line
 * (a crash mid-flush can leave a truncated final record). Returns events in
 * file (append) order. Best-effort: a missing file → empty array.
 */
export function readTrace(tracePath: string): TraceEvent[] {
	let text: string;
	try {
		text = readFileSync(tracePath, "utf8");
	} catch {
		return [];
	}
	const out: TraceEvent[] = [];
	const lines = text.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed) as TraceEvent);
		} catch {
			// Partial / corrupt line — skip (fail-open). A truncated final record
			// from a crashed flush is the expected case.
		}
	}
	return out;
}
