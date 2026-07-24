/**
 * P17 v5 server-side deterministic presentation projections.
 *
 * This module selects Task, verification, and decision semantics. It does no
 * localization, I/O, store access, model/provider calls, or wall-clock reads.
 */
import { isTerminalRunStatus, type ControlError } from "./types.ts";
import {
	WEB_CONTENT_CATALOG_VERSION,
	WebTaskProjectionInputSchema,
	type WebAvailableAction,
	type WebContentMessage,
	type WebDecisionProjectionInput,
	type WebDecisionPresentation,
	type WebDecisionSet,
	type WebTaskPresentation,
	type WebTaskPresentationSummary,
	type WebTaskProjectionInput,
	type WebVerificationPresentation,
	type WebVerificationProjectionInput,
} from "./web-presentation-schema.ts";
import { Value } from "typebox/value";

export const WEB_TASK_PRESENTATION_VERSION = "task-presentation.v1" as const;
export const WEB_DECISION_PRESENTATION_VERSION =
	"decision-presentation.v1" as const;

type MessageArg = WebContentMessage["args"][number];

function message(
	key: WebContentMessage["key"],
	args: readonly MessageArg[] = [],
): WebContentMessage {
	const normalized = args.map((arg): MessageArg => {
		if (typeof arg.value === "string") {
			return { ...arg, value: arg.value.normalize("NFC") } as MessageArg;
		}
		if (Array.isArray(arg.value)) {
			return {
				...arg,
				value: arg.value.map((value) => value.normalize("NFC")),
			} as MessageArg;
		}
		return arg;
	});
	normalized.sort((a, b) => a.name.localeCompare(b.name, "en"));
	if (new Set(normalized.map((arg) => arg.name)).size !== normalized.length) {
		throw new TypeError(`duplicate WebContentMessage argument for ${key}`);
	}
	return {
		catalogVersion: WEB_CONTENT_CATALOG_VERSION,
		key,
		args: normalized,
	};
}

function verificationContentKey(
	state: WebVerificationPresentation["state"],
	detail: boolean,
): WebContentMessage["key"] {
	const stem =
		state === "partially-verified"
			? "partially-verified"
			: state === "verification-unavailable"
				? "unavailable"
				: state === "verification-failed"
					? "failed"
					: state;
	return `verification.${stem}${detail ? ".detail" : ""}` as WebContentMessage["key"];
}

function allVerificationChecks(input: WebVerificationProjectionInput) {
	return [
		input.eventManifest,
		input.journalContinuity,
		input.provenance,
		input.artifactIntegrity,
		input.providerConsistency.check,
		...input.artifactChecks
			.filter((check) => check.required)
			.map((check) => check.state),
	];
}

function mismatchReason(
	input: WebVerificationProjectionInput,
): WebVerificationPresentation["reason"] | undefined {
	if (input.providerConsistency.check === "mismatch") {
		return "provider-outcome-mismatch";
	}
	if (input.eventManifest === "mismatch") return "manifest-mismatch";
	if (
		input.artifactIntegrity === "mismatch" ||
		input.artifactChecks.some(
			(check) => check.required && check.state === "mismatch",
		)
	) {
		return "artifact-digest-mismatch";
	}
	if (
		input.provenance === "mismatch" ||
		input.journalContinuity === "mismatch"
	) {
		return "provenance-mismatch";
	}
	return undefined;
}

export function projectVerificationPresentation(
	input: WebVerificationProjectionInput,
): WebVerificationPresentation {
	const checks = allVerificationChecks(input);
	const mismatch = mismatchReason(input);
	let state: WebVerificationPresentation["state"];
	let reason: WebVerificationPresentation["reason"];

	if (mismatch) {
		state = "verification-failed";
		reason = mismatch;
	} else if (
		!isTerminalRunStatus(input.runStatus) ||
		checks.includes("in-progress")
	) {
		state = "not-yet-verified";
		reason = checks.includes("in-progress")
			? "verification-in-progress"
			: "run-non-terminal";
	} else if (!input.lifecycleRequiresVerification) {
		state = "not-applicable";
		reason = "lifecycle-not-applicable";
	} else if (!input.receiptId) {
		state = "verification-unavailable";
		reason = "receipt-missing";
	} else if (!input.verifierAvailable) {
		state = "verification-unavailable";
		reason = "verifier-unavailable";
	} else if (!checks.some((check) => check === "ok" || check === "not-applicable")) {
		state = "verification-unavailable";
		reason = "no-required-check-completed";
	} else if (
		checks.includes("unknown") ||
		checks.includes("unavailable") ||
		input.artifactChecks.length < input.artifactCheckCount
	) {
		state = "partially-verified";
		reason = input.artifactChecks.some(
			(check) => check.required && check.state === "unavailable",
		)
			? "artifact-retained-without-blob"
			: "required-check-unknown";
	} else {
		const baseVerified =
			input.eventManifest === "ok" &&
			input.journalContinuity === "ok" &&
			input.provenance === "ok" &&
			(input.providerConsistency.check === "ok" ||
				input.providerConsistency.check === "not-applicable") &&
			input.artifactIntegrity === "ok";
		const artifactsVerified = input.artifactChecks
			.filter((check) => check.required)
			.every(
				(check) =>
					check.state === "ok" || check.state === "not-applicable",
			);
		if (baseVerified && artifactsVerified) {
			state = "verified";
			reason = "all-required-checks-ok";
		} else {
			state = "partially-verified";
			reason = "required-check-unknown";
		}
	}

	const reasonArg: MessageArg = {
		name: "verificationReason",
		value: reason,
	};
	return {
		state,
		reason,
		label: message(verificationContentKey(state, false), [reasonArg]),
		detail: message(verificationContentKey(state, true), [reasonArg]),
		checkedAt: input.checkedAt,
		...(input.receiptId ? { receiptId: input.receiptId } : {}),
		providerConsistency: input.providerConsistency,
		eventManifest: input.eventManifest,
		journalContinuity: input.journalContinuity,
		provenance: input.provenance,
		artifactIntegrity: input.artifactIntegrity,
		artifactCheckCount: input.artifactCheckCount,
		requiredArtifactCheckCount: input.requiredArtifactCheckCount,
		artifactChecks: input.artifactChecks,
		sourceObservation: input.sourceObservation,
	};
}

function decisionKey(
	operation: WebDecisionProjectionInput["operationClass"],
	suffix:
		| "question"
		| "impact"
		| "allow-label"
		| "do-not-allow-label"
		| "allow-consequence"
		| "do-not-allow-consequence",
): WebContentMessage["key"] {
	return `decision.${operation}.${suffix}` as WebContentMessage["key"];
}

export function projectDecisionPresentation(
	input: WebDecisionProjectionInput,
): WebDecisionPresentation {
	return {
		projectionVersion: WEB_DECISION_PRESENTATION_VERSION,
		operationClass: input.operationClass,
		question: message(decisionKey(input.operationClass, "question")),
		impact: message(decisionKey(input.operationClass, "impact")),
		...(input.deadline === undefined ? {} : { deadline: input.deadline }),
		...(input.quotedContext === undefined
			? {}
			: { quotedContext: input.quotedContext.normalize("NFC") }),
		choices: [
			{
				kind: "approve",
				label: message(decisionKey(input.operationClass, "allow-label")),
				consequence: message(
					decisionKey(input.operationClass, "allow-consequence"),
				),
				semanticWeight: "equal",
			},
			{
				kind: "reject",
				label: message(
					decisionKey(input.operationClass, "do-not-allow-label"),
				),
				consequence: message(
					decisionKey(input.operationClass, "do-not-allow-consequence"),
				),
				semanticWeight: "equal",
			},
		],
		noDefault: true,
		source: {
			projectId: input.projectId,
			controlDomainId: input.controlDomainId,
			runId: input.runId,
			approvalRequestId: input.approvalRequestId,
			runVersion: input.runVersion,
			approvalVersion: input.approvalVersion,
		},
	};
}

function decisionActionIsAvailable(
	input: WebTaskProjectionInput,
	kind: "approve" | "reject",
): boolean {
	const decision = input.decision;
	if (
		!decision ||
		input.sourceObservation.authority !== "verified"
	) {
		return false;
	}
	const matches = (action: WebAvailableAction): boolean => {
		if (action.state !== "available") return false;
		if (action.kind !== "approve" && action.kind !== "reject") return false;
		if (action.kind !== kind) return false;
		const request = action.requestBase as {
			projectId: string;
			controlDomainId: string;
			runId: string;
			approvalRequestId: string;
			expectedRunVersion: number;
		};
		return (
			request.projectId === decision.projectId &&
			request.controlDomainId === decision.controlDomainId &&
			request.runId === decision.runId &&
			request.approvalRequestId === decision.approvalRequestId &&
			request.expectedRunVersion === decision.runVersion
		);
	};
	return (
		input.availableActions.some(matches) &&
		decision.availableActions.some(matches)
	);
}

function decisionSet(
	input: WebTaskProjectionInput,
): WebDecisionSet | undefined {
	if (!input.decision) return undefined;
	const approve = decisionActionIsAvailable(input, "approve");
	const reject = decisionActionIsAvailable(input, "reject");
	if (approve && reject) {
		return {
			status: "actionable",
			presentation: projectDecisionPresentation(input.decision),
		};
	}
	const reason: ControlError = {
		code: "TF_FEATURE_REQUIRED",
		message: "A two-sided approval decision is not currently available.",
		recoveryAction: "refresh",
		sideEffects: "none",
	};
	return { status: "status-only", reason };
}

type ProjectedNode = WebTaskProjectionInput["nodes"][number];
type ProjectedGroup = WebTaskPresentation["stepGroups"][number];

const GROUP_STATE_RANK: Record<ProjectedGroup["state"], number> = {
	failed: 0,
	blocked: 1,
	running: 2,
	waiting: 3,
	pending: 4,
	cancelled: 5,
	completed: 6,
};

function buildGroups(input: WebTaskProjectionInput): {
	groups: ProjectedGroup[];
	metadataValid: boolean;
	warnings: WebTaskPresentation["warnings"];
} {
	const warnings: WebTaskPresentation["warnings"] = [];
	const seenNodes = new Set<string>();
	const grouped = new Map<string, ProjectedNode[]>();
	let metadataValid = input.presentationMetadataValid;
	for (const node of input.nodes) {
		if (seenNodes.has(node.nodeInstanceId)) metadataValid = false;
		seenNodes.add(node.nodeInstanceId);
		const bucket = grouped.get(node.presentation.groupId) ?? [];
		bucket.push(node);
		grouped.set(node.presentation.groupId, bucket);
	}

	const groups: ProjectedGroup[] = [];
	for (const [groupId, members] of grouped) {
		members.sort(
			(a, b) =>
				a.presentation.ordinal - b.presentation.ordinal ||
				a.nodeInstanceId.localeCompare(b.nodeInstanceId, "en"),
		);
		const first = members[0]!;
		if (
			members.some(
				(member) =>
					member.presentation.label !== first.presentation.label ||
					member.presentation.ordinal !== first.presentation.ordinal,
			)
		) {
			metadataValid = false;
		}
		const originKinds = new Set(members.map((member) => member.origin));
		const sortedByState = [...members].sort(
			(a, b) => GROUP_STATE_RANK[a.status] - GROUP_STATE_RANK[b.status],
		);
		const memberIds = members
			.map((member) => member.nodeInstanceId)
			.sort((a, b) => a.localeCompare(b, "en"));
		if (memberIds.length > 200) {
			warnings.push({
				code: "group-members-truncated",
				nodeInstanceId: first.nodeInstanceId,
			});
		}
		groups.push({
			groupId,
			label: first.presentation.label.normalize("NFC"),
			state: sortedByState[0]!.status,
			origin:
				originKinds.size > 1
					? "mixed"
					: first.origin === "dynamic"
						? "dynamic"
						: "static",
			memberCount: members.length,
			memberNodeInstanceIds: memberIds.slice(0, 200),
			helperNodesCollapsed: members.some(
				(member) => member.presentation.role === "implementation",
			),
			membersTruncated: memberIds.length > 200,
			ordinal: first.presentation.ordinal,
		});
	}
	groups.sort(
		(a, b) =>
			a.ordinal - b.ordinal || a.groupId.localeCompare(b.groupId, "en"),
	);
	if (!metadataValid) warnings.unshift({ code: "presentation-metadata-invalid" });
	if (input.sourceObservation.authority !== "verified") {
		warnings.unshift({ code: "source-unverified" });
	}
	if (groups.length > 200) warnings.push({ code: "step-inventory-truncated" });
	return { groups, metadataValid, warnings };
}

function activeGroups(groups: readonly ProjectedGroup[]): ProjectedGroup[] {
	const running = groups.filter((group) => group.state === "running");
	if (running.length > 0) return running;
	const frontier = groups.filter(
		(group) =>
			group.state === "waiting" ||
			group.state === "blocked" ||
			group.state === "pending",
	);
	return frontier.length > 0 ? [frontier[0]!] : [];
}

function taskCopy(
	input: WebTaskProjectionInput,
	active: readonly ProjectedGroup[],
	verification: WebVerificationPresentation,
): Pick<WebTaskPresentation, "headline" | "detail"> {
	const activeLabels = active.slice(0, 2).map((group) => group.label);
	const countArg: MessageArg = {
		name: "activeStepCount",
		value: active.length,
	};
	const labelsArg: MessageArg = {
		name: "activeStepLabels",
		value: activeLabels,
	};
	const verificationArg: MessageArg = {
		name: "verificationReason",
		value: verification.reason,
	};
	if (input.run.stopping) {
		return {
			headline: message("task.stopping"),
			detail: message("task.stopping.confirmation.detail"),
		};
	}
	if (
		input.run.status === "unknown" ||
		input.run.stage === "reconciling"
	) {
		return {
			headline: message("task.checking-execution"),
			detail: message("task.reconciling.ambiguous.detail"),
		};
	}
	if (input.run.status === "completed") {
		return {
			headline: message("task.completed"),
			detail: message("task.completed.verification.detail", [verificationArg]),
		};
	}
	if (input.run.status === "failed") {
		return {
			headline: message("task.failed"),
			detail: message("task.failed.terminal.detail", [
				{
					name: "preservedResultCount",
					value: input.preservedResultCount,
				},
			]),
		};
	}
	if (input.run.status === "cancelled") {
		return {
			headline: message("task.cancelled"),
			detail: message("task.cancelled.quiescent.detail"),
		};
	}
	if (input.run.status === "blocked") {
		return {
			headline: message("task.could-not-continue"),
			detail: message("task.blocked.reason.detail", [
				{
					name: "blockingReason",
					value: input.blockingReason ?? "unknown",
				},
			]),
		};
	}
	if (input.run.status === "paused" && input.decision) {
		return {
			headline: message("task.needs-input"),
			detail: message("task.approval-required.detail"),
		};
	}
	if (input.run.stage === "executing" && active.length > 0) {
		return {
			headline: message(
				active.length === 1 ? "task.working" : "task.working-multiple",
			),
			detail: message(
				active.length === 1
					? "task.working.one.detail"
					: "task.working.many.detail",
				[countArg, labelsArg],
			),
		};
	}
	if (input.capacityReason) {
		return {
			headline: message("task.waiting-to-start"),
			detail: message("task.waiting.capacity.detail", [
				{ name: "capacityReason", value: input.capacityReason },
			]),
		};
	}
	if (input.blockingReason === "policy-denied") {
		return {
			headline: message("task.waiting-to-start"),
			detail: message("task.waiting.policy.detail"),
		};
	}
	return {
		headline: message("task.waiting-to-start"),
		detail: message("task.waiting.generic.detail"),
	};
}

export function projectTaskPresentation(
	input: WebTaskProjectionInput,
): WebTaskPresentation {
	if (!Value.Check(WebTaskProjectionInputSchema, input)) {
		throw new TypeError(
			"WebTaskProjectionInput contains an impossible RunStatus/RunStage/stopping combination.",
		);
	}
	if (input.verification.runStatus !== input.run.status) {
		throw new TypeError(
			"WebTaskProjectionInput verification RunStatus does not match the Run.",
		);
	}
	if (
		input.decision &&
		(input.run.status !== "paused" ||
			input.run.stage !== "parked" ||
			input.run.stopping ||
			input.decision.runVersion !== input.run.runVersion)
	) {
		throw new TypeError(
			"WebTaskProjectionInput decision is not bound to the current paused/parked Run.",
		);
	}
	const verification = projectVerificationPresentation(input.verification);
	const built = buildGroups(input);
	const groups = built.groups;
	const active = activeGroups(groups);
	const decision = decisionSet(input);
	const copy = taskCopy(input, active, verification);
	const completed = groups.filter((group) => group.state === "completed").length;
	const progress: WebTaskPresentation["progress"] =
		input.sourceObservation.authority !== "verified"
			? { semantics: "indeterminate", reason: "source-unverified" }
			: !built.metadataValid
				? {
						semantics: "indeterminate",
						reason: "presentation-metadata-invalid",
					}
				: input.inventorySealed
					? {
							semantics: "exact",
							completed,
							total: groups.length,
							inventorySealed: true,
						}
					: {
							semantics: "lower-bound",
							completed,
							inventorySealed: false,
						};

	const activeSteps = active.slice(0, 20).map((group) => ({
		nodeInstanceId: group.memberNodeInstanceIds[0]!,
		groupId: group.groupId,
		label: group.label,
		status: group.state,
		ordinal: group.ordinal,
	}));
	const decisionIsActionable = decision?.status === "actionable";
	const sourceUnverified = input.sourceObservation.authority !== "verified";
	const resultAvailable = input.result.kind !== "none";
	const failed = input.run.status === "failed" || input.run.status === "blocked";
	const primaryAction: WebTaskPresentation["primaryAction"] = {
		kind: decisionIsActionable
			? "open-required-input"
			: sourceUnverified
				? "refresh-authority"
				: resultAvailable
					? "open-result"
					: failed
						? "open-error-details"
						: "none",
	};
	const primaryActionSource: WebTaskPresentation["decisionProvenance"]["primaryActionSource"] =
		decisionIsActionable
			? "decision-disposition"
			: sourceUnverified
				? "source-observation"
				: resultAvailable
					? "result"
					: failed
						? "error"
						: "none";

	return {
		projectionVersion: WEB_TASK_PRESENTATION_VERSION,
		source: {
			runVersion: input.run.runVersion,
			boundPlanHash: input.run.boundPlanHash,
			observedAt: input.observedAt,
			sourceObservation: input.sourceObservation,
		},
		...copy,
		activeStepCount: active.length,
		activeSteps,
		stepGroupCount: groups.length,
		stepGroups: groups.slice(0, 200),
		progress,
		result: input.result,
		verification,
		primaryAction,
		...(decision ? { decisionSet: decision } : {}),
		decisionProvenance: {
			runStatus: input.run.status,
			runStage: input.run.stage,
			runVersion: input.run.runVersion,
			needsOperator: input.run.needsOperator,
			sideEffects: input.run.sideEffects,
			activeNodeIds: activeSteps.map((step) => step.nodeInstanceId),
			activeGroupIds: active.map((group) => group.groupId).slice(0, 20),
			...(input.result.kind === "none"
				? {}
				: { finalResultSourceId: input.result.source.sourceId }),
			finalResultKind: input.result.kind,
			...(verification.receiptId
				? { verificationReceiptId: verification.receiptId }
				: {}),
			verificationCheck: verification.state,
			primaryActionSource,
		},
		warnings: built.warnings,
	};
}

export function summarizeTaskPresentation(
	full: WebTaskPresentation,
): WebTaskPresentationSummary {
	return {
		projectionVersion: WEB_TASK_PRESENTATION_VERSION,
		runVersion: full.source.runVersion,
		headline: full.headline,
		detail: full.detail,
		activeStepCount: full.activeStepCount,
		activeStepLabels: full.activeSteps
			.slice(0, 3)
			.map((step) => step.label),
		progress: full.progress,
		verificationState: full.verification.state,
		verificationReason: full.verification.reason,
		navigationAction: full.primaryAction,
	};
}
