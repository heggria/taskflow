/**
 * taskflow-dsl — authoring entry (`import { flow, agent, ... } from "taskflow-dsl"`).
 */

export {
	flow,
	agent,
	parallel,
	map,
	gate,
	reduce,
	approval,
	subflow,
	loop,
	tournament,
	script,
	json,
	expand,
	race,
	TfDslEraseOnlyError,
	type PhaseRef,
	type FlowCtx,
	type FlowOptions,
	type PhaseOptions,
	type ArgSpec,
	type TemplateInput,
	type TaskflowModuleDefault,
	type JsonExpectMarker,
} from "./runes.ts";

export type { Diagnostic, DiagnosticSeverity, Range } from "./diagnostics.ts";
export { formatDiagnostic, formatDiagnostics, hasErrors } from "./diagnostics.ts";
