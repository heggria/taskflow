/**
 * P17 bounded pure-analysis handlers whose inputs already exist in the 0.3
 * ControlStore. These functions must never submit providers or append journal
 * records.
 */
import type { Static } from "typebox";
import type { ControlHost } from "./control-host.ts";
import type { RunProjection } from "./types.ts";
import {
	WebRecomputePreviewSchema,
	type WebEndpointId,
	type WebHandlerContext,
	type WebHandlerMap,
} from "./web-protocol.ts";
import {
	WebReadServiceError,
	createWebReadService,
	type WebReadServiceOptions,
} from "./web-read-service.ts";

type WebRecomputePreview = Static<
	typeof WebRecomputePreviewSchema
>;

export const WEB_IMPLEMENTED_ANALYSIS_HANDLER_IDS = [
	"runRecomputePreview",
] as const satisfies readonly WebEndpointId[];

export type WebAnalysisHandlerMap = Pick<
	WebHandlerMap,
	"runRecomputePreview"
>;

type PhaseRecord = {
	id: string;
	dependsOn?: unknown;
	from?: unknown;
};

function phaseRecords(program: unknown): PhaseRecord[] {
	if (!program || typeof program !== "object") return [];
	const phases = (program as { phases?: unknown }).phases;
	if (!Array.isArray(phases)) return [];
	return phases.flatMap((phase) => {
		if (
			!phase ||
			typeof phase !== "object" ||
			typeof (phase as { id?: unknown }).id !== "string"
		) {
			return [];
		}
		return [phase as PhaseRecord];
	});
}

function dependencies(phase: PhaseRecord): string[] {
	const raw = Array.isArray(phase.dependsOn)
		? phase.dependsOn
		: Array.isArray(phase.from)
			? phase.from
			: [];
	return raw.filter(
		(value): value is string => typeof value === "string",
	);
}

function affectedPhases(
	phases: readonly PhaseRecord[],
	seeds: readonly string[],
): string[] {
	const affected = new Set(seeds);
	let changed = true;
	while (changed) {
		changed = false;
		for (const phase of phases) {
			if (affected.has(phase.id)) continue;
			if (
				dependencies(phase).some((dependency) =>
					affected.has(dependency),
				)
			) {
				affected.add(phase.id);
				changed = true;
			}
		}
	}
	return phases
		.map((phase) => phase.id)
		.filter((phaseId) => affected.has(phaseId));
}

function affectedNodes(
	run: RunProjection,
	affected: ReadonlySet<string>,
): string[] {
	if (run.nodes) {
		return run.nodes
			.filter((node) => affected.has(node.phaseId))
			.sort((left, right) => left.ordinal - right.ordinal)
			.map((node) => node.nodeInstanceId);
	}
	return [...affected];
}

export function createWebAnalysisHandlers(
	host: ControlHost,
	options: WebReadServiceOptions = {},
): WebAnalysisHandlerMap {
	const reads = createWebReadService(host, options);
	return {
		runRecomputePreview: (
			{ params, body },
			requestContext: WebHandlerContext,
		): WebRecomputePreview => {
			if (
				params.projectId !== host.projectId ||
				params.controlDomainId !== host.controlDomainId
			) {
				throw new WebReadServiceError({
					code: "TF_AUTHORITY_REVOKED",
					message:
						"This listener cannot analyze mutations for a non-home project authority.",
					recoveryAction: "refresh",
					sideEffects: "none",
					projectId: params.projectId,
					controlDomainId:
						params.controlDomainId,
				});
			}
			const detail = reads.readRunDetail(
				params.projectId,
				params.controlDomainId,
				params.runId,
				requestContext,
			);
			if (
				detail.run.runVersion !==
				body.expectedRunVersion
			) {
				throw new WebReadServiceError({
					code: "TF_STALE_VERSION",
					message:
						"Run changed after the preview request was prepared.",
					recoveryAction: "refresh",
					sideEffects: "none",
					projectId: params.projectId,
					controlDomainId:
						params.controlDomainId,
				});
			}
			const run = host.store.getRun(params.runId);
			if (!run) {
				throw new WebReadServiceError({
					code: "TF_NOT_FOUND",
					message: "Run not found.",
					recoveryAction: "refresh",
					sideEffects: "none",
					projectId: params.projectId,
					controlDomainId:
						params.controlDomainId,
				});
			}
			const boundPlan = host.store.getBoundPlan(
				run.boundPlanHash,
			);
			if (!boundPlan) {
				throw new WebReadServiceError({
					code: "TF_DURABILITY_FAILED",
					message:
						"BoundPlan required for recompute analysis is unavailable.",
					recoveryAction: "operator",
					sideEffects: "none",
					projectId: params.projectId,
					controlDomainId:
						params.controlDomainId,
				});
			}
			const phases = phaseRecords(boundPlan.program);
			const phaseIds = new Set(
				phases.map((phase) => phase.id),
			);
			const missing = body.phaseIds.filter(
				(phaseId) => !phaseIds.has(phaseId),
			);
			if (missing.length > 0) {
				throw new WebReadServiceError({
					code: "TF_INVALID_ARGUMENT",
					message:
						"One or more requested phases are not in the immutable BoundPlan.",
					recoveryAction: "refresh",
					sideEffects: "none",
					projectId: params.projectId,
					controlDomainId:
						params.controlDomainId,
				});
			}
			const requested = phases
				.map((phase) => phase.id)
				.filter((phaseId) =>
					body.phaseIds.includes(phaseId),
				);
			const affected = affectedPhases(phases, requested);
			const affectedSet = new Set(affected);
			return {
				requestedPhaseIds: requested,
				affectedPhaseIds: affected,
				affectedNodeInstanceIds: affectedNodes(
					run,
					affectedSet,
				),
				cacheExplanation:
					"Requested phases are forced to rerun. Every transitive declared dependent is conservatively invalidated; actual cache reuse is decided only after re-admission against current fingerprints.",
				reAdmissionRequired: true,
				uncertainty:
					"Cost and token estimates are unavailable because this ControlStore does not retain provider pricing or per-phase token forecasts.",
				sourceObservation: detail.sourceObservation,
			};
		},
	};
}
