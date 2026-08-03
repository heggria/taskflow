/**
 * CharterArc is the declarative reconciliation layer above Taskflow:
 * Project Snapshot → selected existing Taskflow → reality-backed Outcome.
 *
 * It deliberately owns no phase semantics, DAG scheduler, host process, daemon,
 * persistence model, or model planning.
 */

export { defineProject } from "./project/define.ts";
export { runProject } from "./project/cycle.ts";
export type {
	FlowSelection,
	ModuleDefinition,
	ObservationResult,
	ObservationTarget,
	ProjectDefinition,
	ProjectOutcome,
	ProjectRuntime,
} from "./project/types.ts";
