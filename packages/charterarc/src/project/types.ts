import type { RuntimeDeps, Taskflow, UsageStats } from "taskflow-core";

export interface ProjectDefinition {
	/** Human-readable desired state. The observer provides checkable evidence. */
	readonly desired: string;
	readonly observe: (context: {
		readonly cwd: string;
		readonly signal: AbortSignal;
	}) => Promise<ObservationResult>;
	/** One ordinary Taskflow owns inspect, repair, gates, and verification. */
	readonly maintain: Taskflow;
}

export type ObservationStatus = "satisfied" | "drifted" | "unknown";

export interface ObservationResult {
	readonly status: ObservationStatus;
	readonly summary?: string;
}

export interface FlowRunResult {
	readonly ok: boolean;
	readonly finalOutput?: string;
	/** Aggregated usage from the ordinary Taskflow run (contextTokens is not additive). */
	readonly usage?: UsageStats;
	/** Host usage-accounting mode observed for the run (from RuntimeDeps / runner). */
	readonly usageAccounting?: RuntimeDeps["usageAccounting"];
}

export interface ProjectRuntime {
	/** Finite observer deadline. A timeout is recorded as unknown. Default: 30s. */
	readonly observeTimeoutMs?: number;
	/** Existing Taskflow deps; its signal cancels observation and execution. */
	readonly taskflow: RuntimeDeps;
}

export interface ProjectOutcome {
	/** A statement about observed reality, never a claim of causation. */
	readonly status: ObservationStatus;
	readonly before: ObservationResult;
	readonly run?: FlowRunResult;
	readonly after?: ObservationResult;
}
