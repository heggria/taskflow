import type { RuntimeDeps, Taskflow, UsageStats } from "taskflow-core";

/** Optional scoped declaration: narrows desired promises and Flow selection. */
export interface ModuleDefinition {
	readonly desired: Readonly<Record<string, string>>;
	/** One ordinary Taskflow per desired key. */
	readonly maintain: Readonly<Record<string, Taskflow>>;
}

export type ObservationStatus = "satisfied" | "drifted" | "unknown";

export interface ObservationTarget {
	/** Desired key that authorizes one ordinary Taskflow selection. */
	readonly desired: string;
	readonly module?: string;
}

/**
 * Every observation is an explicit snapshot with facts.
 * Confirmed drift must identify one desired target; healthy / unknown
 * snapshots cannot carry mutation authority (`target`).
 */
export type ObservationResult =
	| {
			readonly status: "satisfied" | "unknown";
			readonly summary?: string;
			readonly facts: Readonly<Record<string, unknown>>;
			readonly target?: never;
	  }
	| {
			readonly status: "drifted";
			readonly summary?: string;
			readonly facts: Readonly<Record<string, unknown>>;
			readonly target: ObservationTarget;
	  };

export type ProjectObserver = (context: {
	readonly cwd: string;
	readonly signal: AbortSignal;
}) => Promise<ObservationResult>;

/**
 * Project declaration: keyed desired promises map to ordinary Taskflows.
 * Optional Modules narrow selection without a second runtime.
 * The removed single-Flow form (string desired + one Taskflow) is not accepted.
 */
export interface ProjectDefinition {
	readonly desired: Readonly<Record<string, string>>;
	readonly observe: ProjectObserver;
	readonly maintain: Readonly<Record<string, Taskflow>>;
	readonly modules?: Readonly<Record<string, ModuleDefinition>>;
}

/** Deterministic Flow selection recorded on the outcome when a multi-Flow Run is authorized. */
export interface FlowSelection {
	readonly desired: string;
	readonly flow: string;
	readonly module?: string;
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
	/**
	 * Fail-closed cycle success: true only when the latest observation is
	 * `satisfied` and any maintenance Run (if present) also succeeded.
	 * Distinct from `status`, which never claims the Run caused the state.
	 */
	readonly ok: boolean;
	readonly before: ObservationResult;
	readonly run?: FlowRunResult;
	readonly after?: ObservationResult;
	/** Present when multi-Flow confirmed drift authorized one ordinary Taskflow Run. */
	readonly selection?: FlowSelection;
}
