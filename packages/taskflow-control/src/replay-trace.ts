/**
 * Convert the ControlHost phase scheduler result into the versioned
 * taskflow-core event format consumed by replayRun.
 *
 * This is an evidence adapter, not a second replay engine. Facts the scheduler
 * did not retain are marked unreplayable instead of being invented.
 */
import {
	EVENT_SCHEMA_VERSION,
	type Event,
} from "taskflow-core";
import { stableStringify } from "./hash.ts";
import type { PhaseAttempt } from "./phase-scheduler.ts";
import type {
	BoundPlan,
	RunProjection,
} from "./types.ts";

const MAX_REPLAY_OUTPUT_CHARS = 32_768;

type TracePhase = {
	id: string;
	dependsOn?: unknown;
	from?: unknown;
	when?: unknown;
};

function phases(boundPlan: BoundPlan): TracePhase[] {
	if (
		!boundPlan.program ||
		typeof boundPlan.program !== "object"
	) {
		return [];
	}
	const raw = (boundPlan.program as { phases?: unknown }).phases;
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((phase) =>
		phase &&
		typeof phase === "object" &&
		typeof (phase as { id?: unknown }).id === "string"
			? [phase as TracePhase]
			: [],
	);
}

function dependencies(phase: TracePhase): string[] {
	return [
		...(Array.isArray(phase.dependsOn)
			? phase.dependsOn
			: []),
		...(Array.isArray(phase.from) ? phase.from : []),
	].filter(
		(value): value is string => typeof value === "string",
	);
}

function event(
	runId: string,
	phaseId: string,
	kind: Event["kind"],
	ts: number,
	extra: Omit<
		Partial<Event>,
		"v" | "runId" | "phaseId" | "kind" | "ts"
	> = {},
): Event {
	return {
		v: EVENT_SCHEMA_VERSION,
		runId,
		phaseId,
		kind,
		ts,
		...extra,
	};
}

export function buildControlReplayEvents(
	run: RunProjection,
	boundPlan: BoundPlan,
	attempts: readonly PhaseAttempt[] = [],
): Event[] {
	const attemptByPhase = new Map(
		attempts.map((attempt) => [
			attempt.phaseId,
			attempt,
		]),
	);
	const events: Event[] = [];
	for (const [ordinal, phase] of phases(boundPlan).entries()) {
		const attempt = attemptByPhase.get(phase.id);
		const startedAt =
			attempt?.startedAt ??
			run.createdAt + ordinal * 2;
		const endedAt =
			attempt?.endedAt ??
			Math.max(startedAt, run.updatedAt);
		events.push(
			event(
				run.runId,
				phase.id,
				"phase-start",
				startedAt,
				{ dependencies: dependencies(phase) },
			),
		);
		if (typeof phase.when === "string") {
			events.push(
				event(
					run.runId,
					phase.id,
					"decision",
					startedAt,
					{
						decision: {
							type: "when-guard",
							expression: phase.when,
							result:
								attempt?.status !==
									"skipped" ||
								attempt.error !==
									"when guard false",
						},
					},
				),
			);
		}
		if (
			attempt?.output !== undefined &&
			attempt.output.length <=
				MAX_REPLAY_OUTPUT_CHARS
		) {
			events.push(
				event(
					run.runId,
					phase.id,
					"subagent-call",
					endedAt,
					{
						output: {
							text: attempt.output,
							...(attempt.providerName
								? {
										model:
											attempt.providerName,
									}
								: {}),
						},
					},
				),
			);
		} else if (
			!attempt ||
			(attempt.status === "completed" &&
				attempt.output === undefined) ||
			(attempt.output?.length ?? 0) >
				MAX_REPLAY_OUTPUT_CHARS
		) {
			events.push(
				event(
					run.runId,
					phase.id,
					"decision",
					endedAt,
					{
						decision: {
							type: "unreplayable",
							reason: "unobservable-deps",
						},
					},
				),
			);
		}
		const status: Event["status"] =
			attempt?.status === "completed"
				? "done"
				: attempt?.status === "failed"
					? "failed"
					: attempt?.status === "skipped"
						? "skipped"
						: attempt?.status ===
							  "still-running"
							? "running"
							: "pending";
		events.push(
			event(
				run.runId,
				phase.id,
				"phase-end",
				endedAt,
				{
					status,
					...(attempt?.error
						? { error: attempt.error }
						: {}),
				},
			),
		);
	}
	return events;
}

export function buildControlReplayTrace(
	run: RunProjection,
	boundPlan: BoundPlan,
	attempts: readonly PhaseAttempt[] = [],
): string {
	return `${buildControlReplayEvents(run, boundPlan, attempts)
		.map((record) => stableStringify(record))
		.join("\n")}\n`;
}
