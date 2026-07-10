/**
 * Event Log Schema — the future event-sourced kernel.
 *
 * This module defines the **append-only event log** schema that the batch-2
 * event-sourced driver (Q8) will write to. It is a **versioned extension** of
 * the current `TraceEvent` shape (`../trace.ts`): `Event = TraceEvent & { v }`.
 *
 * **Why this exists**: The batch-2 event-sourced kernel needs an explicit,
 * versioned event schema that (a) can subsume trace.ts, (b) carries a `v`
 * field so future schema migrations are unambiguous on disk, and (c) provides
 * a back-compat reader that upgrades legacy trace.jsonl lines on the fly.
 *
 * **Single source of truth**: `Event` / `EventDecision` / `EventKind` are
 * type aliases over `TraceEvent` / `TraceDecision` — never a parallel copy —
 * so adding a decision variant or field in `trace.ts` automatically lands
 * here (no dual-schema drift).
 *
 * **F3 dissolution**: the 5 currently-unemitted trace decisions
 * (gate-score, budget-hit, cache-hit, when-guard, unreplayable) dissolve here:
 * the event-sourced driver (batch 2) will emit *every* decision by
 * construction — this module is the log schema + version + back-compat.
 * Once batch 2 lands, this module subsumes trace.ts entirely (see §0.2.0 Roadmap).
 *
 * Pure types + parser: no IO, no randomness. Missing `ts` on upgrade uses `0`
 * (not `Date.now()`) so upgrade is deterministic for replay.
 */

import type { TraceEvent, TraceDecision } from "../trace.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Schema version
// ─────────────────────────────────────────────────────────────────────────────

/** Current event log schema version. Incremented on breaking changes. */
export const EVENT_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Event shape = TraceEvent + v (single source of truth)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discriminated event kind — identical to TraceEvent's `kind` union.
 * A versioned Event carries a `v` field so a consumer can detect schema
 * drift without inspecting fields.
 */
export type EventKind = TraceEvent["kind"];

/** Discriminated record of a runtime decision — alias of TraceDecision. */
export type EventDecision = TraceDecision;

/**
 * A single event in the append-only event log. Structurally identical to
 * {@link TraceEvent} with an explicit `v` field for schema versioning.
 *
 * The batch-2 event-sourced driver (Q8) will emit these directly; legacy
 * trace.jsonl lines are upgraded via {@link upgradeTraceEvent}.
 */
export type Event = TraceEvent & {
	/** Schema version (see {@link EVENT_SCHEMA_VERSION}). */
	v: number;
};

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
 *
 * **Determinism**: missing `ts` becomes `0`, never `Date.now()` — the same
 * corrupt line upgrades to the same bytes every time (replay-safe).
 */
export function upgradeTraceEvent(old: Record<string, unknown>): Event {
	return {
		v: EVENT_SCHEMA_VERSION,
		ts: typeof old.ts === "number" ? old.ts : 0,
		runId: typeof old.runId === "string" ? old.runId : "",
		phaseId: typeof old.phaseId === "string" ? old.phaseId : "",
		kind: (["phase-start", "phase-end", "subagent-call", "decision"] as const).includes(
			old.kind as EventKind,
		)
			? (old.kind as EventKind)
			: "phase-start",
		dependencies: Array.isArray(old.dependencies)
			? old.dependencies.filter((x): x is string => typeof x === "string")
			: undefined,
		optional: old.optional === true,
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
