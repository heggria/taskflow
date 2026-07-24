/**
 * P17 offline replay adapter.
 *
 * The handler only reads a current Receipt-reachable trace artifact and calls
 * taskflow-core's pure replayRun. It has no provider or mutation dependency.
 */
import {
	readEvents,
	replayRun,
	type ReplayOverrides,
} from "taskflow-core";
import { sha256Hex, stableStringify } from "./hash.ts";
import {
	inspectProjectControlStore,
	type ProjectControlReadSnapshot,
} from "./store/project-store.ts";
import type { ArtifactRecord } from "./types.ts";
import type {
	WebEndpointId,
	WebHandlerMap,
} from "./web-protocol.ts";
import { WebReadServiceError } from "./web-read-service.ts";

export const WEB_IMPLEMENTED_REPLAY_HANDLER_IDS = [
	"runReplay",
] as const satisfies readonly WebEndpointId[];

export type WebReplayHandlerMap = Pick<
	WebHandlerMap,
	"runReplay"
>;

function fail(
	code:
		| "TF_INVALID_ARGUMENT"
		| "TF_NOT_FOUND"
		| "TF_AUTHORITY_REVOKED"
		| "TF_DURABILITY_FAILED",
	message: string,
	projectId: string,
	controlDomainId: string,
): never {
	throw new WebReadServiceError({
		code,
		message,
		recoveryAction:
			code === "TF_DURABILITY_FAILED"
				? "operator"
				: "refresh",
		sideEffects: "none",
		projectId,
		controlDomainId,
	});
}

function currentTraceArtifact(
	snapshot: ProjectControlReadSnapshot,
	runId: string,
	digest: string,
): ArtifactRecord | undefined {
	const run = snapshot.runs.find(
		(candidate) => candidate.runId === runId,
	);
	if (!run?.receiptId) return undefined;
	const receipt = snapshot.receipts.find(
		(candidate) =>
			candidate.receiptId === run.receiptId &&
			candidate.runId === runId,
	);
	if (!receipt) return undefined;
	return snapshot.artifacts.find(
		(artifact) =>
			artifact.digest === digest &&
			artifact.role === "replay-trace" &&
			artifact.runId === runId &&
			receipt.artifactRefs.includes(
				artifact.artifactId,
			) &&
			(artifact.receiptId === undefined ||
				artifact.receiptId === receipt.receiptId),
	);
}

function normalizedOverrides(
	overrides: Array<
		| {
				targetId: string;
				kind: "gate-verdict";
				value: "pass" | "block";
		  }
		| {
				targetId: string;
				kind: "condition-result";
				value: boolean;
		  }
		| {
				targetId: string;
				kind: "cache-decision";
				value: "hit" | "miss";
		  }
	>,
): typeof overrides {
	return [...overrides].sort(
		(left, right) =>
			left.targetId.localeCompare(
				right.targetId,
				"en",
			) ||
			left.kind.localeCompare(right.kind, "en"),
	);
}

function coreOverrides(
	overrides: ReturnType<typeof normalizedOverrides>,
): ReplayOverrides {
	const gateVerdicts: Record<string, "pass" | "block"> = {};
	const conditionResults: Record<string, boolean> = {};
	const cacheDecisions: Record<string, "hit" | "miss"> = {};
	for (const override of overrides) {
		if (override.kind === "gate-verdict") {
			gateVerdicts[override.targetId] = override.value;
		} else if (override.kind === "condition-result") {
			conditionResults[override.targetId] =
				override.value;
		} else {
			cacheDecisions[override.targetId] =
				override.value;
		}
	}
	return {
		...(Object.keys(gateVerdicts).length > 0
			? { gateVerdicts }
			: {}),
		...(Object.keys(conditionResults).length > 0
			? { conditionResults }
			: {}),
		...(Object.keys(cacheDecisions).length > 0
			? { cacheDecisions }
			: {}),
	};
}

function finalPhaseId(
	program: unknown,
): string | undefined {
	if (!program || typeof program !== "object") return undefined;
	const raw = (program as { phases?: unknown }).phases;
	if (!Array.isArray(raw)) return undefined;
	const phases = raw.flatMap((phase) =>
		phase &&
		typeof phase === "object" &&
		typeof (phase as { id?: unknown }).id === "string"
			? [
					{
						id: (phase as { id: string }).id,
						final:
							(phase as { final?: unknown })
								.final === true,
					},
				]
			: [],
	);
	return (
		phases.filter((phase) => phase.final).at(-1)?.id ??
		phases.at(-1)?.id
	);
}

export function createWebReplayHandlers(
	host: import("./control-host.ts").ControlHost,
): WebReplayHandlerMap {
	return {
		runReplay: ({ params, body }) => {
			if (
				params.projectId !== host.projectId ||
				params.controlDomainId !== host.controlDomainId
			) {
				fail(
					"TF_AUTHORITY_REVOKED",
					"This listener is not the replay authority for the requested project.",
					params.projectId,
					params.controlDomainId,
				);
			}
			const inspected = inspectProjectControlStore(
				host.store.projectRoot,
				{
					projectId: params.projectId,
					controlDomainId:
						params.controlDomainId,
				},
			);
			if (!inspected.ok) {
				fail(
					"TF_DURABILITY_FAILED",
					inspected.detail,
					params.projectId,
					params.controlDomainId,
				);
			}
			const run = inspected.snapshot.runs.find(
				(candidate) =>
					candidate.runId === params.runId,
			);
			if (!run) {
				fail(
					"TF_NOT_FOUND",
					"Run not found.",
					params.projectId,
					params.controlDomainId,
				);
			}
			const trace = currentTraceArtifact(
				inspected.snapshot,
				params.runId,
				body.traceArtifactDigest,
			);
			if (!trace) {
				fail(
					"TF_NOT_FOUND",
					"Replay trace is not reachable from the current durable Receipt.",
					params.projectId,
					params.controlDomainId,
				);
			}
			const bytes = host.store.readArtifactBytes(
				trace.digest,
			);
			if (
				!bytes ||
				bytes.byteLength !== trace.size ||
				`sha256:${sha256Hex(
					Buffer.from(bytes),
				)}` !== trace.digest
			) {
				fail(
					"TF_DURABILITY_FAILED",
					"Replay trace failed its digest or length check.",
					params.projectId,
					params.controlDomainId,
				);
			}
			const events = readEvents(
				Buffer.from(bytes).toString("utf8"),
			);
			if (
				events.length === 0 ||
				!events.some(
					(event) =>
						event.runId === params.runId,
				)
			) {
				fail(
					"TF_DURABILITY_FAILED",
					"Replay trace contains no event lifecycle for this Run.",
					params.projectId,
					params.controlDomainId,
				);
			}
			const normalized = normalizedOverrides(
				body.overrides,
			);
			const unique = new Set(
				normalized.map(
					(override) =>
						`${override.targetId}\u0000${override.kind}`,
				),
			);
			if (unique.size !== normalized.length) {
				fail(
					"TF_INVALID_ARGUMENT",
					"Replay overrides contain a duplicate target and kind.",
					params.projectId,
					params.controlDomainId,
				);
			}
			const phaseIds = new Set(
				events
					.filter(
						(event) =>
							event.runId === params.runId,
					)
					.map((event) => event.phaseId),
			);
			if (
				normalized.some(
					(override) =>
						!phaseIds.has(override.targetId),
				)
			) {
				fail(
					"TF_INVALID_ARGUMENT",
					"Replay override target is absent from the selected trace.",
					params.projectId,
					params.controlDomainId,
				);
			}
			const report = replayRun(
				events,
				coreOverrides(normalized),
			);
			const warnings: string[] = [];
			if (report.needsLiveRerun) {
				warnings.push(
					"One or more counterfactual branches require a live rerun; no live work was started.",
				);
			}
			if (
				report.baseline.orphans > 0 ||
				report.replayed.orphans > 0
			) {
				warnings.push(
					"Trace contains events that could not be associated with a phase.",
				);
			}
			if (report.decisions.length > 200) {
				warnings.push(
					`Decision fold is bounded to 200 of ${report.decisions.length} phases.`,
				);
			}
			const decisionFold = report.decisions
				.slice(0, 200)
				.map((decision) =>
					stableStringify(decision).slice(0, 8_192),
				);
			const unreplayableBranches = report.decisions
				.filter(
					(decision) =>
						decision.outcome ===
						"needs-live-rerun",
				)
				.map((decision) => decision.phaseId)
				.slice(0, 200);
			const boundPlan = inspected.snapshot.boundPlans.find(
				(candidate) =>
					candidate.boundPlanHash ===
					run.boundPlanHash,
			);
			const finalId = finalPhaseId(boundPlan?.program);
			const finalPhase = finalId
				? report.replayed.phases[finalId]
				: undefined;
			return {
				sourceTraceDigest: trace.digest,
				overridesHash: `sha256:${sha256Hex(
					stableStringify(normalized),
				)}`,
				decisionFold,
				...(finalPhase?.status === "done" &&
				finalPhase.output !== undefined
					? {
							resultPreview:
								finalPhase.output.slice(
									0,
									32_768,
								),
						}
					: {}),
				warnings: warnings.slice(0, 200),
				unreplayableBranches,
				proof: {
					providerCalls: 0 as const,
					durableWrites: 0 as const,
				},
			};
		},
	};
}
