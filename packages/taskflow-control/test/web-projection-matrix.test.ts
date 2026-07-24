/** Exhaustive P17 decision and browser-only failure projection branches. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
	WEB_COMMAND_KINDS,
	WEB_DECISION_OPERATION_CLASSES,
	WEB_VERIFICATION_CHECK_STATES,
	WEB_VERIFICATION_REASON_CODES,
	WebAvailableActionSchema,
	WebDecisionPresentationSchema,
	WebDecisionProjectionInputSchema,
	WebFailurePresentationInputSchema,
	WebFailurePresentationSchema,
	WebVerificationPresentationSchema,
	WebVerificationProjectionInputSchema,
	type WebAvailableAction,
	type WebCommandKind,
	type WebDecisionProjectionInput,
	type WebFailurePresentationInput,
	type WebVerificationProjectionInput,
} from "../src/web-presentation-schema.ts";
import { projectControlErrorPresentation } from "../src/web-presentation-client.ts";
import {
	projectDecisionPresentation,
	projectVerificationPresentation,
} from "../src/web-presentation-server.ts";
import {
	FORCE_RELEASE_ACKNOWLEDGEMENT,
	RECOVERY_ACTIONS,
	RUN_STATUSES,
	SIDE_EFFECT_LEVELS,
	TF_ERROR_CODES,
} from "../src/types.ts";

const identity = {
	projectId: "project-1",
	controlDomainId: "domain-1",
	runId: "run-1",
};

function verificationInput(): WebVerificationProjectionInput {
	return {
		runStatus: "completed",
		checkedAt: 1_800_000_000_000,
		lifecycleRequiresVerification: true,
		receiptId: "receipt-1",
		verifierAvailable: true,
		eventManifest: "ok",
		journalContinuity: "ok",
		provenance: "ok",
		artifactIntegrity: "ok",
		providerConsistency: {
			expected: { kind: "exact", outcome: "completed" },
			observed: "completed",
			check: "ok",
			sourceEventRefs: ["event-1"],
		},
		artifactChecks: [
			{
				artifactId: "artifact-1",
				digest: `sha256:${"a".repeat(64)}`,
				required: true,
				state: "ok",
			},
		],
		artifactCheckCount: 1,
		requiredArtifactCheckCount: 1,
		sourceObservation: {
			coverage: "complete",
			authority: "verified",
			observedAt: 1_800_000_000_000,
			registryContext: {
				mode: "standalone",
				registryRevision: "standalone",
				visibleMounts: [
					{
						projectId: identity.projectId,
						controlDomainId:
							identity.controlDomainId,
					},
				],
			},
			watermarks: [],
		},
	};
}

function availableAction(kind: WebCommandKind): WebAvailableAction {
	let requestBase: Record<string, unknown>;
	switch (kind) {
		case "approve":
		case "reject":
		case "edit-approval":
			requestBase = {
				kind,
				...identity,
				expectedRunVersion: 3,
				approvalRequestId: "approval-1",
			};
			break;
		case "cancel-run":
		case "resume-run":
		case "recompute-run":
		case "reconcile-run":
			requestBase = {
				kind,
				...identity,
				expectedRunVersion: 3,
			};
			break;
		case "set-max-active-runs":
			requestBase = {
				kind,
				expectedMaxActiveRuns: 4,
				expectedCoordinatorEpoch: 2,
			};
			break;
		case "force-release":
			requestBase = {
				kind,
				reservationId: "reservation-1",
				expectedState: "orphan-suspect",
				expectedRevision: 2,
				expectedCoordinatorEpoch: 3,
				expectedProjectId: identity.projectId,
				expectedControlDomainId:
					identity.controlDomainId,
				expectedRunId: identity.runId,
				acknowledgement:
					FORCE_RELEASE_ACKNOWLEDGEMENT,
			};
			break;
	}
	const value = {
		kind,
		state: "available",
		requestBase,
	};
	assert.equal(Value.Check(WebAvailableActionSchema, value), true, kind);
	return value as WebAvailableAction;
}

function failureInput(
	options: {
		readonly code?: (typeof TF_ERROR_CODES)[number];
		readonly recoveryAction?: (typeof RECOVERY_ACTIONS)[number];
		readonly sideEffects?: (typeof SIDE_EFFECT_LEVELS)[number];
		readonly operation?: WebCommandKind | "none";
		readonly commandBodyState?:
			| "not-applicable"
			| "present-in-current-tab-memory"
			| "unavailable";
		readonly supported?: boolean;
		readonly available?: boolean;
	} = {},
): WebFailurePresentationInput {
	const code = options.code ?? "TF_COMMAND_FAILED";
	const recoveryAction = options.recoveryAction ?? "none";
	const sideEffects = options.sideEffects ?? "none";
	const operation = options.operation ?? "none";
	const actionKind =
		recoveryAction === "reconcile"
			? "reconcile-run"
			: operation === "none"
				? undefined
				: operation;
	const value = {
		failure: {
			ok: false,
			requestId: "request-1",
			schemaVersion: "web.v1",
			error: {
				code,
				message: "technical failure",
				recoveryAction,
				sideEffects,
			},
		},
		context: {
			surface: "command-submit",
			operation,
			resourceState: { kind: "none" },
			sourceAuthority: "verified",
			commandBodyState:
				options.commandBodyState ??
				"not-applicable",
			supportedFeatures: [],
			supportedCommands:
				options.supported && operation !== "none"
					? [operation]
					: [],
			availableActions:
				options.available && actionKind
					? [availableAction(actionKind)]
					: [],
		},
	};
	assert.equal(
		Value.Check(WebFailurePresentationInputSchema, value),
		true,
		JSON.stringify(options),
	);
	return value as WebFailurePresentationInput;
}

test("P17 decision projection covers all eight operation classes symmetrically", () => {
	for (const operationClass of WEB_DECISION_OPERATION_CLASSES) {
		const input: WebDecisionProjectionInput = {
			operationClass,
			deadline: 1_800_000_000_000,
			quotedContext: "Cafe\u0301",
			...identity,
			approvalRequestId: "approval-1",
			runVersion: 3,
			approvalVersion: 2,
			availableActions: [
				availableAction("approve"),
				availableAction("reject"),
			],
		};
		assert.equal(
			Value.Check(WebDecisionProjectionInputSchema, input),
			true,
		);
		const projection = projectDecisionPresentation(input);
		assert.equal(
			Value.Check(WebDecisionPresentationSchema, projection),
			true,
		);
		assert.equal(
			projection.question.key,
			`decision.${operationClass}.question`,
		);
		assert.equal(
			projection.impact.key,
			`decision.${operationClass}.impact`,
		);
		assert.equal(projection.quotedContext, "Café");
		assert.equal(projection.noDefault, true);
		assert.deepEqual(
			projection.choices.map((choice) => ({
				kind: choice.kind,
				semanticWeight: choice.semanticWeight,
				label: choice.label.key,
				consequence: choice.consequence.key,
			})),
			[
				{
					kind: "approve",
					semanticWeight: "equal",
					label: `decision.${operationClass}.allow-label`,
					consequence: `decision.${operationClass}.allow-consequence`,
				},
				{
					kind: "reject",
					semanticWeight: "equal",
					label: `decision.${operationClass}.do-not-allow-label`,
					consequence: `decision.${operationClass}.do-not-allow-consequence`,
				},
			],
		);
	}
});

test("P17 verification projection reaches every closed reason code", () => {
	const base = verificationInput();
	const allUnknown = {
		...base,
		eventManifest: "unknown",
		journalContinuity: "unknown",
		provenance: "unknown",
		artifactIntegrity: "unknown",
		providerConsistency: {
			...base.providerConsistency,
			check: "unknown",
		},
		artifactChecks: base.artifactChecks.map((check) => ({
			...check,
			state: "unknown",
		})),
	} as const satisfies WebVerificationProjectionInput;
	const cases: Array<{
		input: WebVerificationProjectionInput;
		state:
			| "verified"
			| "partially-verified"
			| "verification-unavailable"
			| "verification-failed"
			| "not-yet-verified"
			| "not-applicable";
		reason: (typeof WEB_VERIFICATION_REASON_CODES)[number];
	}> = [
		{
			input: base,
			state: "verified",
			reason: "all-required-checks-ok",
		},
		{
			input: {
				...base,
				eventManifest: "not-applicable",
			},
			state: "partially-verified",
			reason: "required-check-unknown",
		},
		{
			input: {
				...base,
				artifactChecks: base.artifactChecks.map(
					(check) => ({
						...check,
						state: "unavailable",
					}),
				),
			},
			state: "partially-verified",
			reason: "artifact-retained-without-blob",
		},
		{
			input: { ...base, receiptId: undefined },
			state: "verification-unavailable",
			reason: "receipt-missing",
		},
		{
			input: { ...base, verifierAvailable: false },
			state: "verification-unavailable",
			reason: "verifier-unavailable",
		},
		{
			input: allUnknown,
			state: "verification-unavailable",
			reason: "no-required-check-completed",
		},
		{
			input: { ...base, eventManifest: "mismatch" },
			state: "verification-failed",
			reason: "manifest-mismatch",
		},
		{
			input: { ...base, artifactIntegrity: "mismatch" },
			state: "verification-failed",
			reason: "artifact-digest-mismatch",
		},
		{
			input: { ...base, provenance: "mismatch" },
			state: "verification-failed",
			reason: "provenance-mismatch",
		},
		{
			input: {
				...base,
				providerConsistency: {
					...base.providerConsistency,
					check: "mismatch",
				},
			},
			state: "verification-failed",
			reason: "provider-outcome-mismatch",
		},
		{
			input: { ...base, runStatus: "running" },
			state: "not-yet-verified",
			reason: "run-non-terminal",
		},
		{
			input: { ...base, eventManifest: "in-progress" },
			state: "not-yet-verified",
			reason: "verification-in-progress",
		},
		{
			input: {
				...base,
				lifecycleRequiresVerification: false,
			},
			state: "not-applicable",
			reason: "lifecycle-not-applicable",
		},
	];
	assert.deepEqual(
		cases.map((entry) => entry.reason).sort(),
		[...WEB_VERIFICATION_REASON_CODES].sort(),
	);
	for (const entry of cases) {
		assert.equal(
			Value.Check(
				WebVerificationProjectionInputSchema,
				entry.input,
			),
			true,
			entry.reason,
		);
		const projected =
			projectVerificationPresentation(entry.input);
		assert.equal(
			Value.Check(
				WebVerificationPresentationSchema,
				projected,
			),
			true,
			entry.reason,
		);
		assert.equal(projected.state, entry.state, entry.reason);
		assert.equal(projected.reason, entry.reason);
	}
});

test("P17 verification checks cover all states and mismatch priority", () => {
	const base = verificationInput();
	for (const checkState of WEB_VERIFICATION_CHECK_STATES) {
		for (const field of [
			"eventManifest",
			"journalContinuity",
			"provenance",
			"artifactIntegrity",
		] as const) {
			const input = { ...base, [field]: checkState };
			assert.equal(
				Value.Check(
					WebVerificationProjectionInputSchema,
					input,
				),
				true,
				`${field}:${checkState}`,
			);
			assert.equal(
				Value.Check(
					WebVerificationPresentationSchema,
					projectVerificationPresentation(input),
				),
				true,
				`${field}:${checkState}`,
			);
		}
		for (const input of [
			{
				...base,
				providerConsistency: {
					...base.providerConsistency,
					check: checkState,
				},
			},
			{
				...base,
				artifactChecks: base.artifactChecks.map(
					(check) => ({
						...check,
						state: checkState,
					}),
				),
			},
		]) {
			assert.equal(
				Value.Check(
					WebVerificationProjectionInputSchema,
					input,
				),
				true,
				checkState,
			);
			assert.equal(
				Value.Check(
					WebVerificationPresentationSchema,
					projectVerificationPresentation(input),
				),
				true,
				checkState,
			);
		}
	}

	for (const [input, reason] of [
		[
			{
				...base,
				eventManifest: "mismatch",
				artifactIntegrity: "mismatch",
				provenance: "mismatch",
				providerConsistency: {
					...base.providerConsistency,
					check: "mismatch",
				},
			},
			"provider-outcome-mismatch",
		],
		[
			{
				...base,
				eventManifest: "mismatch",
				artifactIntegrity: "mismatch",
				provenance: "mismatch",
			},
			"manifest-mismatch",
		],
		[
			{
				...base,
				artifactIntegrity: "mismatch",
				provenance: "mismatch",
			},
			"artifact-digest-mismatch",
		],
		[
			{ ...base, provenance: "mismatch" },
			"provenance-mismatch",
		],
		[
			{
				...base,
				eventManifest: "in-progress",
				artifactIntegrity: "mismatch",
			},
			"artifact-digest-mismatch",
		],
	] as const) {
		assert.equal(
			projectVerificationPresentation(
				input as WebVerificationProjectionInput,
			).reason,
			reason,
		);
	}
});

test("P17 terminal outcome verification binds completed, failed, cancelled, and not-admitted", () => {
	const base = verificationInput();
	const cases: readonly WebVerificationProjectionInput[] = [
		base,
		{
			...base,
			runStatus: "failed",
			providerConsistency: {
				...base.providerConsistency,
				expected: { kind: "exact", outcome: "failed" },
				observed: "failed",
			},
		},
		{
			...base,
			runStatus: "cancelled",
			providerConsistency: {
				...base.providerConsistency,
				expected: {
					kind: "exact",
					outcome: "cancelled",
				},
				observed: "cancelled",
			},
		},
		{
			...base,
			runStatus: "blocked",
			providerConsistency: {
				expected: {
					kind: "not-admitted",
					evidenceRef: "event-not-admitted",
				},
				check: "not-applicable",
				sourceEventRefs: ["event-not-admitted"],
			},
		},
	];
	for (const input of cases) {
		const projected = projectVerificationPresentation(input);
		assert.equal(projected.state, "verified", input.runStatus);
		assert.equal(
			projected.reason,
			"all-required-checks-ok",
		);
	}
	for (const runStatus of RUN_STATUSES.filter(
		(status) =>
			![
				"completed",
				"failed",
				"blocked",
				"cancelled",
			].includes(status),
	)) {
		const projected = projectVerificationPresentation({
			...base,
			runStatus,
		});
		assert.equal(projected.state, "not-yet-verified");
		assert.equal(projected.reason, "run-non-terminal");
	}
});

test("P17 failure projection covers every error and risk branch", () => {
	for (const code of TF_ERROR_CODES) {
		const projection = projectControlErrorPresentation(
			failureInput({ code }),
		);
		assert.equal(
			Value.Check(WebFailurePresentationSchema, projection),
			true,
		);
		assert.equal(projection.headline.key, `error.${code}.headline`);
		assert.equal(projection.detail.key, `error.${code}.detail`);
		assert.equal(projection.technical.code, code);
		assert.equal(
			projection.nextAction.key,
			code === "TF_CURSOR_EXPIRED"
				? "system.cursor-expired.refresh"
				: "system.no-action-required",
		);
	}
	const expectedRisks = {
		none: "risk.none",
		possible: "risk.possible-live-side-effects",
		unknown: "risk.unknown-side-effects",
	} as const;
	for (const sideEffects of SIDE_EFFECT_LEVELS) {
		const projection = projectControlErrorPresentation(
			failureInput({ sideEffects }),
		);
		assert.equal(
			projection.risk.key,
			expectedRisks[sideEffects],
		);
	}
});

test("P17 failure recovery action gate covers every operation and input condition", () => {
	const operations = [
		"none",
		...WEB_COMMAND_KINDS,
	] as const;
	const bodyStates = [
		"not-applicable",
		"present-in-current-tab-memory",
		"unavailable",
	] as const;
	let checked = 0;
	for (const recoveryAction of RECOVERY_ACTIONS) {
		for (const operation of operations) {
			for (const commandBodyState of bodyStates) {
				for (const available of [false, true]) {
					for (const supported of [false, true]) {
						const projection =
							projectControlErrorPresentation(
								failureInput({
									recoveryAction,
									operation,
									commandBodyState,
									available,
									supported,
								}),
							);
						let expected:
							| "refresh"
							| "retry-same-command"
							| "retry-new-command"
							| "open-reconcile"
							| "contact-operator"
							| "none";
						switch (recoveryAction) {
							case "refresh":
								expected = "refresh";
								break;
							case "retry-same-command":
								expected =
									operation !== "none" &&
									commandBodyState ===
										"present-in-current-tab-memory" &&
									available
										? "retry-same-command"
										: "none";
								break;
							case "retry-new-command":
								expected =
									operation !== "none" &&
									supported &&
									available
										? "retry-new-command"
										: "none";
								break;
							case "reconcile":
								expected = available
									? "open-reconcile"
									: "none";
								break;
							case "operator":
								expected =
									"contact-operator";
								break;
							case "none":
								expected = "none";
								break;
						}
						assert.equal(
							projection.actionKind,
							expected,
							JSON.stringify({
								recoveryAction,
								operation,
								commandBodyState,
								available,
								supported,
							}),
						);
						assert.equal(
							Value.Check(
								WebFailurePresentationSchema,
								projection,
							),
							true,
						);
						checked += 1;
					}
				}
			}
		}
	}
	assert.equal(checked, 720);
});

test("P17 failure technical detail strips controls and remains bounded", () => {
	const input = failureInput();
	const message = `${"x".repeat(9_000)}\u0000\u0007`;
	const projection = projectControlErrorPresentation({
		...input,
		failure: {
			...input.failure,
			error: {
				...input.failure.error,
				message,
			},
		},
	});
	assert.equal(projection.technical.sanitizedMessage.length, 8_192);
	assert.doesNotMatch(
		projection.technical.sanitizedMessage,
		/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u,
	);
	assert.equal(
		Value.Check(WebFailurePresentationSchema, projection),
		true,
	);
});
