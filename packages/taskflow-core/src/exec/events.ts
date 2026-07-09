/**
 * Event Log Schema — the future event-sourced kernel.
 *
 * This module defines the **append-only event log** schema that the batch-2
 * event-sourced driver (Q8) will write to. It is a superset of the current
 * `TraceEvent` shape (`../trace.ts`) plus a schema-version field.
 *
 * **Why this exists**: The batch-2 event-sourced kernel needs an explicit,
 * versioned event schema that (a) can subsume trace.ts, (b) carries a `v`
 * field so future schema migrations are unambiguous on disk, and (c) provides
 * a back-compat reader that upgrades legacy trace.jsonl lines on the fly.
 *
 * **F3 dissolution**: the 5 currently-unemitted trace decisions
 * (gate-score, budget-hit, cache-hit, when-guard, unreplayable) dissolve here:
 * the event-sourced driver (batch 2) will emit *every* decision by
 * construction — this module is the log schema + version + back-compat.
 * Once batch 2 lands, this module subsumes trace.ts entirely (see §0.2.0 Roadmap).
 *
 * This is a **pure types+parser module** — zero runtime deps besides what
 * TypeScript/stdlib provides. No IO, no randomness, no Date.
 */

import type { UsageStats } from "../usage.ts";
import type { ScorerResult } from "../scorers.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Schema version
// ─────────────────────────────────────────────────────────────────────────────

/** Current event log schema version. Incremented on breaking changes. */
export const EVENT_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Event shape (superset of TraceEvent)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discriminated event kind — identical to TraceEvent's `kind` union.
 * A versioned Event carries a `v` field so a consumer can detect schema
 * drift without inspecting fields.
 */
export type EventKind = "phase-start" | "phase-end" | "subagent-call" | "decision";

/** Discriminated record of a runtime decision. Structurally duplicates
 *  TraceDecision so that this module has zero imports from trace.ts.
 *  The two converge in batch 2 when trace.ts is subsumed. */
export type EventDecision =
	| { type: "gate-verdict"; value: "pass" | "block"; reason?: string }
	| {
			type: "gate-score";
			target: string;
			results: ScorerResult[];
			combined: number;
			threshold?: number;
			verdict: "pass" | "block";
			evalPassed?: boolean;
			judgeOutput?: string;
	  }
	| { type: "tournament-winner"; value: number; reason?: string }
	| { type: "budget-hit"; value: string; reason?: string }
	| { type: "cache-hit"; scope: "cross-run" | "run-only"; reason?: string }
	| { type: "when-guard"; expression: string; result: boolean }
	| {
			type: "unreplayable";
			reason: "context-sharing" | "inner-flow" | "context-files" | "unobservable-deps";
	  };

/**
 * A single event in the append-only event log. Structurally identical to
 * TraceEvent but with an explicit `v` field for schema versioning.
 *
 * The batch-2 event-sourced driver (Q8) will emit these directly; legacy
 * trace.jsonl lines are upgraded via {@link upgradeTraceEvent}.
 */
export interface Event {
	/** Schema version (see {@link EVENT_SCHEMA_VERSION}). */
	v: number;

	/** Timestamp (Date.now()) at emit. */
	ts: number;
	/** Run identifier. */
	runId: string;
	/** Phase identifier. */
	phaseId: string;
	/** Discriminated kind. */
	kind: EventKind;

	// — subagent-call (the load-bearing record a replay consumes) —
	input?: {
		agent: string;
		model?: string;
		/** Resolved (interpolated) task text. */
		task: string;
		/** Resolved `context:` file content prepended to the task. */
		preRead?: string;
		/** Stable node path, e.g. "review", "review#item-3", "gate#judge". */
		nodePath: string;
		/** 0-based within runOne's retry loop. */
		attempt?: number;
		/** Index in the items array for `map` phases. */
		mapIndex?: number;
		/** 1-based variant number for `tournament` phases. */
		variantIndex?: number;
	};

	output?: {
		text: string;
		model?: string;
		usage?: UsageStats;
		stopReason?: string;
	};

	/** The runtime's own decision. */
	decision?: EventDecision;

	// — phase-end —
	status?: "done" | "failed" | "blocked" | "skipped" | "timedOut" | "pending" | "running";
	error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Back-compat: upgrading legacy TraceEvent → Event
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Accept any object shape that overlaps with the legacy TraceEvent fields
 * and stamp `v=` {@link EVENT_SCHEMA_VERSION} onto it. This is deliberately
 * lenient — a legacy trace.jsonl line may have extra / missing fields.
 *
 * **Design note (§8 back-compat)**: old trace.jsonl files have no `v` field.
 * This shim stamps the current schema version onto any missing event so that
 * the batch-2 event-sourced consumer can read both old and new records
 * through the same `Event` interface. When the schema version bumps, this
 * function is where the migration logic lives.
 */
export function upgradeTraceEvent(old: Record<string, unknown>): Event {
	return {
		v: EVENT_SCHEMA_VERSION,
		ts: typeof old.ts === "number" ? old.ts : Date.now(),
		runId: typeof old.runId === "string" ? old.runId : "",
		phaseId: typeof old.phaseId === "string" ? old.phaseId : "",
		kind: (["phase-start", "phase-end", "subagent-call", "decision"] as const).includes(
			old.kind as EventKind,
		)
			? (old.kind as EventKind)
			: "phase-start",
		input: old.input as Event["input"],
		output: old.output as Event["output"],
		decision: old.decision as EventDecision | undefined,
		status: old.status as Event["status"],
		error: typeof old.error === "string" ? old.error : undefined,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Reader (partial-line tolerant, upgrades versionless lines)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse an event log JSONL text into an array of {@link Event}s.
 *
 * **Partial-line tolerance**: any line that fails JSON.parse is silently
 * skipped (fail-open), matching trace.ts's `readTrace` behaviour. This
 * handles crash-truncated final records gracefully.
 *
 * **Versionless line upgrade**: any line whose parsed object lacks a `v`
 * field is routed through {@link upgradeTraceEvent} to stamp the current
 * schema version — so old trace.jsonl data is readable without migration.
 */
export function readEvents(text: string): Event[] {
	const out: Event[] = [];
	const lines = text.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as Record<string, unknown>;
			if (typeof parsed.v === "number") {
				// Already versioned — trust schema (double-cast via `unknown` since a
				// JSON-parsed record can't be proven to overlap with `Event`).
				out.push(parsed as unknown as Event);
			} else {
				// Legacy line — upgrade via back-compat shim.
				out.push(upgradeTraceEvent(parsed));
			}
		} catch {
			// Partial / corrupt line — skip (fail-open).
		}
	}
	return out;
}
