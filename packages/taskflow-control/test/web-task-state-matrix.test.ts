/**
 * P17 reachable Task state matrix and contradictory projection fixtures.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
	WebTaskPresentationSchema,
	WebTaskProjectionInputSchema,
	type WebAvailableAction,
	type WebDecisionProjectionInput,
	type WebSourceObservation,
	type WebTaskProjectionInput,
	type WebVerificationPresentation,
} from "../src/web-presentation-schema.ts";
import { projectTaskPresentation } from "../src/web-presentation-server.ts";
import {
	RUN_STAGES,
	RUN_STATUSES,
	type RunStage,
	type RunStatus,
} from "../src/types.ts";

const observedAt = 1_800_000_000_000;
const digest = `sha256:${"a".repeat(64)}`;
const identity = {
	projectId: "project-1",
	controlDomainId: "domain-1",
	runId: "run-1",
};
const sourceObservation: WebSourceObservation = {
	coverage: "complete",
	authority: "verified",
	observedAt,
	registryContext: {
		mode: "auto",
		registryRevision: "registry-1",
		visibleMounts: [
			{
				projectId: identity.projectId,
				controlDomainId: identity.controlDomainId,
			},
		],
	},
	watermarks: [],
};

const reachableStates = [
	["running", "received", false],
	["running", "compiled", false],
	["running", "linked", false],
	["running", "queued", false],
	["running", "admitted", false],
	["running", "executing", false],
	["paused", "parked", false],
	["paused", "executing", true],
	["unknown", "reconciling", false],
	["completed", "terminal", false],
	["failed", "terminal", false],
	["blocked", "terminal", false],
	["cancelled", "terminal", false],
] as const satisfies readonly (readonly [RunStatus, RunStage, boolean])[];

function approvalAction(
	kind: "approve" | "reject",
	expectedRunVersion = 3,
): WebAvailableAction {
	return {
		kind,
		state: "available",
		requestBase: {
			kind,
			...identity,
			approvalRequestId: "approval-1",
			expectedRunVersion,
		},
	};
}

function decision(
	runVersion = 3,
	availableActions: WebAvailableAction[] = [
		approvalAction("approve", runVersion),
		approvalAction("reject", runVersion),
	],
): WebDecisionProjectionInput {
	return {
		operationClass: "generic-action",
		...identity,
		approvalRequestId: "approval-1",
		runVersion,
		approvalVersion: 2,
		availableActions,
	};
}

function taskInput(
	status: RunStatus,
	stage: RunStage,
	stopping: boolean,
	options: {
		readonly withActiveNode?: boolean;
		readonly decision?: WebDecisionProjectionInput;
		readonly availableActions?: WebAvailableAction[];
	} = {},
): WebTaskProjectionInput {
	return {
		run: {
			status,
			stage,
			stopping,
			runVersion: 3,
			boundPlanHash: digest,
			needsOperator: status === "unknown",
			sideEffects:
				status === "unknown" || stopping ? "possible" : "none",
			displayTitle: "Check release readiness",
			workspaceDisplayName: "Taskflow",
		},
		observedAt,
		sourceObservation,
		nodes: options.withActiveNode
			? [
					{
						nodeInstanceId: "node-1",
						status: "running",
						origin: "static",
						presentation: {
							authoredPhaseId: "check",
							groupId: "check",
							role: "step",
							ordinal: 0,
							label: "Check test results",
						},
					},
				]
			: [],
		inventorySealed: stage === "terminal",
		presentationMetadataValid: true,
		result: { kind: "none" },
		verification: {
			runStatus: status,
			checkedAt: observedAt,
			lifecycleRequiresVerification: true,
			verifierAvailable: true,
			eventManifest: "in-progress",
			journalContinuity: "in-progress",
			provenance: "in-progress",
			artifactIntegrity: "in-progress",
			providerConsistency: {
				expected: {
					kind: "exact",
					outcome:
						status === "failed"
							? "failed"
							: status === "cancelled"
								? "cancelled"
								: "completed",
				},
				check: "in-progress",
				sourceEventRefs: [],
			},
			artifactChecks: [],
			artifactCheckCount: 0,
			requiredArtifactCheckCount: 0,
			sourceObservation,
		},
		...(options.decision ? { decision: options.decision } : {}),
		availableActions: options.availableActions ?? [],
		preservedResultCount: 0,
	};
}

test("P17 executable schema accepts exactly the 13 reachable RunStatus × RunStage pairs", () => {
	const reachable = new Set(
		reachableStates.map(([status, stage]) => `${status}/${stage}`),
	);
	let accepted = 0;
	for (const status of RUN_STATUSES) {
		for (const stage of RUN_STAGES) {
			const stopping = status === "paused" && stage === "executing";
			const input = taskInput(status, stage, stopping);
			const expected = reachable.has(`${status}/${stage}`);
			assert.equal(
				Value.Check(WebTaskProjectionInputSchema, input),
				expected,
				`${status}/${stage}`,
			);
			if (expected) accepted += 1;
		}
	}
	assert.equal(accepted, reachableStates.length);
});

test("P17 reachable state schema rejects every contradictory stopping flag", () => {
	for (const [status, stage, stopping] of reachableStates) {
		assert.equal(
			Value.Check(
				WebTaskProjectionInputSchema,
				taskInput(status, stage, stopping),
			),
			true,
			`${status}/${stage}`,
		);
		assert.equal(
			Value.Check(
				WebTaskProjectionInputSchema,
				taskInput(status, stage, !stopping),
			),
			false,
			`${status}/${stage} contradictory stopping`,
		);
	}
});

test("P17 Task copy projects every reachable safety-distinct state", () => {
	const expectedHeadline = new Map<string, string>([
		["running/received", "task.waiting-to-start"],
		["running/compiled", "task.waiting-to-start"],
		["running/linked", "task.waiting-to-start"],
		["running/queued", "task.waiting-to-start"],
		["running/admitted", "task.waiting-to-start"],
		["running/executing", "task.working"],
		["paused/parked", "task.needs-input"],
		["paused/executing", "task.stopping"],
		["unknown/reconciling", "task.checking-execution"],
		["completed/terminal", "task.completed"],
		["failed/terminal", "task.failed"],
		["blocked/terminal", "task.could-not-continue"],
		["cancelled/terminal", "task.cancelled"],
	]);
	for (const [status, stage, stopping] of reachableStates) {
		const isDecision = status === "paused" && stage === "parked";
		const actions = isDecision
			? [approvalAction("approve"), approvalAction("reject")]
			: [];
		const input = taskInput(status, stage, stopping, {
			withActiveNode:
				status === "running" && stage === "executing",
			...(isDecision ? { decision: decision(), availableActions: actions } : {}),
		});
		const projection = projectTaskPresentation(input);
		assert.equal(
			Value.Check(WebTaskPresentationSchema, projection),
			true,
			`${status}/${stage}`,
		);
		assert.equal(
			projection.headline.key,
			expectedHeadline.get(`${status}/${stage}`),
			`${status}/${stage}`,
		);
	}
});

test("P17 Task projection rejects stale or contradictory authority inputs", () => {
	const actions = [approvalAction("approve"), approvalAction("reject")];
	const valid = taskInput("paused", "parked", false, {
		decision: decision(),
		availableActions: actions,
	});
	assert.equal(projectTaskPresentation(valid).decisionSet?.status, "actionable");

	const staleAction = taskInput("paused", "parked", false, {
		decision: decision(),
		availableActions: [
			approvalAction("approve", 2),
			approvalAction("reject"),
		],
	});
	const staleProjection = projectTaskPresentation(staleAction);
	assert.equal(staleProjection.decisionSet?.status, "status-only");
	assert.equal(staleProjection.primaryAction.kind, "none");

	assert.throws(
		() =>
			projectTaskPresentation({
				...valid,
				verification: {
					...valid.verification,
					runStatus: "running",
				},
			}),
		/verification RunStatus does not match/,
	);
	assert.throws(
		() =>
			projectTaskPresentation(
				taskInput("running", "executing", false, {
					decision: decision(),
					availableActions: actions,
				}),
			),
		/decision is not bound/,
	);
	assert.throws(
		() =>
			projectTaskPresentation(
				taskInput("paused", "parked", false, {
					decision: decision(2),
					availableActions: actions,
				}),
			),
		/decision is not bound/,
	);
});

type VerificationState = WebVerificationPresentation["state"];

function withVerificationState(
	input: WebTaskProjectionInput,
	state: VerificationState,
): WebTaskProjectionInput {
	const verification = input.verification;
	const expected = verification.providerConsistency.expected;
	const observed =
		expected.kind === "exact"
			? { observed: expected.outcome }
			: {};
	const allOk = {
		...verification,
		receiptId: "receipt-1",
		verifierAvailable: true,
		eventManifest: "ok" as const,
		journalContinuity: "ok" as const,
		provenance: "ok" as const,
		artifactIntegrity: "ok" as const,
		providerConsistency: {
			...verification.providerConsistency,
			...observed,
			check: "ok" as const,
		},
		artifactChecks: [],
		artifactCheckCount: 0,
		requiredArtifactCheckCount: 0,
	};
	switch (state) {
		case "verified":
			return { ...input, verification: allOk };
		case "partially-verified":
			return {
				...input,
				verification: {
					...allOk,
					eventManifest: "unknown",
				},
			};
		case "verification-unavailable":
			return {
				...input,
				verification: {
					...verification,
					receiptId: undefined,
					verifierAvailable: false,
					eventManifest: "unavailable",
					journalContinuity: "unavailable",
					provenance: "unavailable",
					artifactIntegrity: "unavailable",
					providerConsistency: {
						...verification.providerConsistency,
						check: "unavailable",
					},
				},
			};
		case "verification-failed":
			return {
				...input,
				verification: {
					...allOk,
					eventManifest: "mismatch",
				},
			};
		case "not-yet-verified":
			return {
				...input,
				verification: {
					...allOk,
					eventManifest: "in-progress",
				},
			};
		case "not-applicable":
			return {
				...input,
				verification: {
					...allOk,
					lifecycleRequiresVerification: false,
				},
			};
	}
}

test("P17 Task projection covers all 92 reachable safety-factor interactions", () => {
	const terminalVerificationStates: readonly VerificationState[] = [
		"verified",
		"partially-verified",
		"verification-unavailable",
		"verification-failed",
		"not-yet-verified",
		"not-applicable",
	];
	const nonTerminalVerificationStates: readonly VerificationState[] = [
		"verification-failed",
		"not-yet-verified",
	];
	let interactionCount = 0;

	for (const [status, stage, stopping] of reachableStates) {
		const terminal = stage === "terminal";
		const verificationStates = terminal
			? terminalVerificationStates
			: nonTerminalVerificationStates;
		const decisionDispositions =
			status === "paused" && stage === "parked"
				? (["none", "status-only", "actionable"] as const)
				: (["none"] as const);
		for (const verificationState of verificationStates) {
			for (const authority of [
				"verified",
				"unverified",
			] as const) {
				for (const disposition of decisionDispositions) {
					const actions =
						disposition === "actionable"
							? [
									approvalAction("approve"),
									approvalAction("reject"),
								]
							: [];
					let input = taskInput(status, stage, stopping, {
						withActiveNode:
							status === "running" &&
							stage === "executing",
						...(disposition === "none"
							? {}
							: {
									decision: decision(
										3,
										actions,
									),
									availableActions:
										actions,
								}),
					});
					const observation = {
						...sourceObservation,
						authority,
					};
					input = {
						...input,
						sourceObservation: observation,
						verification: {
							...input.verification,
							sourceObservation: observation,
						},
						...(status === "completed"
							? {
									result: {
										kind: "text" as const,
										source: {
											sourceId:
												"node-1",
											sourceKind:
												"runtime" as const,
										},
										preview:
											"Result available",
									},
								}
							: {}),
					};
					input = withVerificationState(
						input,
						verificationState,
					);
					const projection =
						projectTaskPresentation(input);
					assert.equal(
						Value.Check(
							WebTaskPresentationSchema,
							projection,
						),
						true,
					);
					assert.equal(
						projection.verification.state,
						verificationState,
					);
					const trulyActionable =
						disposition === "actionable" &&
						authority === "verified";
					assert.equal(
						projection.decisionSet?.status,
						disposition === "none"
							? undefined
							: trulyActionable
								? "actionable"
								: "status-only",
					);
					const expectedAction = trulyActionable
						? "open-required-input"
						: authority === "unverified"
							? "refresh-authority"
							: status === "completed"
								? "open-result"
								: status === "failed" ||
									  status === "blocked"
									? "open-error-details"
									: "none";
					assert.equal(
						projection.primaryAction.kind,
						expectedAction,
						`${status}/${stage}/${verificationState}/${authority}/${disposition}`,
					);
					interactionCount += 1;
				}
			}
		}
	}
	assert.equal(interactionCount, 92);
});
