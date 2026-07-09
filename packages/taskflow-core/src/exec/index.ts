/**
 * Event-sourced execution log — barrel.
 *
 * Re-exports the event log schema + back-compat reader from `./events.ts`.
 * This is the schema the batch-2 event-sourced kernel (Q8) will write to; it
 * is a versioned superset of the current `TraceEvent` shape (see `../trace.ts`)
 * with a `v` field for forward-compatible migrations.
 *
 * Pure types + parser module — zero runtime deps beyond stdlib. Surfaced
 * through the main `taskflow-core` barrel so host adapters can read/upgrade
 * event logs without a deep import.
 */

export * from "./events.ts";
export * from "./fold.ts";
