/**
 * CharterArc is the thin project loop above Taskflow:
 * ProjectDefinition → existing Taskflow → reality-backed Outcome.
 *
 * It deliberately owns no phase semantics, DAG scheduler, host process, daemon,
 * persistence ledger, or model planning.
 */

export { defineProject } from "./project/define.ts";
export { runProject } from "./project/cycle.ts";
export type {
	ObservationResult,
	ProjectDefinition,
	ProjectOutcome,
	ProjectRuntime,
} from "./project/types.ts";
