#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import {
	WebBootstrapViewSchema,
	WebOverviewViewSchema,
	WebReceiptViewSchema,
	WebRunGraphViewSchema,
} from "../packages/taskflow-control/src/web-protocol.ts";
import {
	WebFailurePresentationInputSchema,
	WebFailurePresentationSchema,
	WebObservationPresentationInputSchema,
	WebObservationPresentationSchema,
	WEB_CONTENT_CATALOG_VERSION,
	WebContentMessageSchema,
	WebTaskPresentationSchema,
	WebTaskProjectionInputSchema,
} from "../packages/taskflow-control/src/web-presentation-schema.ts";
import {
	projectDecisionPresentation,
	projectTaskPresentation,
} from "../packages/taskflow-control/src/web-presentation-server.ts";
import {
	projectControlErrorPresentation,
	projectObservationPresentation,
} from "../packages/taskflow-control/src/web-presentation-client.ts";
import {
	WEB_STATIC_CONTENT_KEYS,
	WEB_STATIC_CONTENT_REGISTRY,
	formatWebContentMessage,
	webContentCanonicalMaterial,
} from "../packages/taskflow-web/src/content/catalog.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(
	repoRoot,
	"packages/taskflow-control/test/fixtures/web-v1/reference",
);
const manifestPath = path.join(
	repoRoot,
	"docs/internal/webui/reference-set-v1/manifest.json",
);
const renderEvidencePath = path.join(
	repoRoot,
	"docs/internal/webui/reference-set-v1/render-evidence.json",
);
const shouldWrite = process.argv.includes("--write");
const digest = `sha256:${"1".repeat(64)}`;
const sensitiveDigest = `sha256:${"2".repeat(64)}`;
const secretDigest = `sha256:${"3".repeat(64)}`;
const at = 1_800_000_000_000;
const contentMaterial = webContentCanonicalMaterial();
const contentKeysetDigests = {
	projected: sha256(canonical(contentMaterial.projectedRegistry)),
	static: sha256(canonical(contentMaterial.staticRegistry)),
	combined: sha256(canonical(contentMaterial.combinedKeys)),
};
const contentCatalogDigests = {
	en: sha256(canonical(contentMaterial.catalogs.en)),
	"zh-CN": sha256(canonical(contentMaterial.catalogs["zh-CN"])),
};

const sourceObservation = {
	coverage: "complete",
	authority: "verified",
	observedAt: at,
	registryContext: {
		mode: "auto",
		registryRevision: "registry-1",
		visibleMounts: [
			{ projectId: "project-1", controlDomainId: "domain-1" },
		],
	},
	watermarks: [
		{
			projectId: "project-1",
			controlDomainId: "domain-1",
			nextCommitSeq: 20,
			minAvailableCommitSeq: 1,
		},
	],
};

function verification(overrides = {}) {
	return {
		runStatus: "completed",
		checkedAt: at,
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
				digest,
				required: true,
				state: "ok",
			},
		],
		artifactCheckCount: 1,
		requiredArtifactCheckCount: 1,
		sourceObservation,
		...overrides,
	};
}

function taskSource(overrides = {}) {
	const base = {
		run: {
			status: "running",
			stage: "executing",
			runVersion: 3,
			boundPlanHash: digest,
			needsOperator: false,
			stopping: false,
			sideEffects: "none",
			displayTitle: "Check release readiness",
			workspaceDisplayName: "Taskflow",
		},
		observedAt: at,
		sourceObservation,
		nodes: [
			{
				nodeInstanceId: "node-1",
				status: "running",
				origin: "static",
				presentation: {
					authoredPhaseId: "check-tests",
					groupId: "group-check-tests",
					role: "step",
					ordinal: 0,
					label: "Check test results",
				},
			},
		],
		inventorySealed: true,
		presentationMetadataValid: true,
		result: { kind: "none" },
		verification: verification({
			runStatus: "running",
			receiptId: undefined,
			eventManifest: "in-progress",
			journalContinuity: "in-progress",
			provenance: "in-progress",
			artifactIntegrity: "in-progress",
			providerConsistency: {
				expected: { kind: "exact", outcome: "completed" },
				check: "in-progress",
				sourceEventRefs: ["event-1"],
			},
			artifactChecks: [],
			artifactCheckCount: 0,
			requiredArtifactCheckCount: 0,
		}),
		availableActions: [],
		preservedResultCount: 0,
	};
	const run = { ...base.run, ...(overrides.run ?? {}) };
	return {
		...base,
		...overrides,
		run,
		verification: {
			...base.verification,
			...(overrides.verification ?? {}),
			runStatus: run.status,
		},
	};
}

const approveBase = {
	kind: "approve",
	projectId: "project-1",
	controlDomainId: "domain-1",
	runId: "run-1",
	expectedRunVersion: 4,
	approvalRequestId: "approval-1",
};
const rejectBase = { ...approveBase, kind: "reject" };
const decisionInput = {
	operationClass: "publish-files",
	deadline: at + 60_000,
	quotedContext: "Publish the generated release notes?",
	projectId: "project-1",
	controlDomainId: "domain-1",
	runId: "run-1",
	approvalRequestId: "approval-1",
	runVersion: 4,
	approvalVersion: 2,
	availableActions: [
		{ kind: "approve", state: "available", requestBase: approveBase },
		{ kind: "reject", state: "available", requestBase: rejectBase },
	],
};

const activeSource = taskSource({
	result: {
		kind: "text",
		source: { sourceId: "node-1", sourceKind: "node" },
		preview:
			"Test execution is still running. The completed checks have not found a release blocker.",
	},
	preservedResultCount: 1,
});
const decisionSource = taskSource({
	run: {
		status: "paused",
		stage: "parked",
		runVersion: 4,
		needsOperator: true,
	},
	nodes: [
		{
			nodeInstanceId: "node-approval",
			status: "waiting",
			origin: "static",
			presentation: {
				authoredPhaseId: "publish",
				groupId: "group-publish",
				role: "step",
				ordinal: 1,
				label: "Publish release",
			},
		},
	],
	decision: decisionInput,
	availableActions: decisionInput.availableActions,
});
const completedVerifiedSource = taskSource({
	run: { status: "completed", stage: "terminal", runVersion: 5 },
	nodes: [
		{
			...activeSource.nodes[0],
			status: "completed",
		},
	],
	result: {
		kind: "text",
		source: { sourceId: "node-1", sourceKind: "node" },
		preview: "All release checks passed. The release note is ready.",
	},
	verification: verification(),
	preservedResultCount: 1,
});
const completedUnavailableSource = taskSource({
	run: { status: "completed", stage: "terminal", runVersion: 6 },
	nodes: [
		{
			...activeSource.nodes[0],
			status: "completed",
		},
	],
	result: completedVerifiedSource.result,
	verification: verification({
		receiptId: undefined,
		verifierAvailable: false,
		eventManifest: "unavailable",
		journalContinuity: "unavailable",
		provenance: "unavailable",
		artifactIntegrity: "unavailable",
		providerConsistency: {
			expected: { kind: "exact", outcome: "completed" },
			observed: "completed",
			check: "unavailable",
			sourceEventRefs: ["event-1"],
		},
		artifactChecks: [],
		artifactCheckCount: 1,
		requiredArtifactCheckCount: 1,
	}),
	preservedResultCount: 1,
});
const reconcilingSource = taskSource({
	run: {
		status: "unknown",
		stage: "reconciling",
		runVersion: 7,
		needsOperator: true,
		sideEffects: "possible",
	},
	nodes: [
		{
			...activeSource.nodes[0],
			status: "waiting",
		},
	],
});

function projectedTaskFixture(id, screenId, state, source) {
	if (!Value.Check(WebTaskProjectionInputSchema, source)) {
		throw new Error(`${id}: invalid WebTaskProjectionInput`);
	}
	const projection = projectTaskPresentation(source);
	if (!Value.Check(WebTaskPresentationSchema, projection)) {
		throw new Error(`${id}: invalid WebTaskPresentation`);
	}
	return { id, screenId, state, sourceKind: "task-projection", source, projection };
}

const overview = {
	sourceObservation,
	coordinatorCapacity: {
		maxActiveRuns: 4,
		occupied: 0,
		available: 4,
		fencingEpoch: 3,
	},
	runCounts: {
		byStatus: {
			running: 0,
			completed: 0,
			failed: 0,
			paused: 0,
			blocked: 0,
			cancelled: 0,
			unknown: 0,
		},
		byStage: {
			received: 0,
			compiled: 0,
			linked: 0,
			queued: 0,
			admitted: 0,
			executing: 0,
			parked: 0,
			reconciling: 0,
			terminal: 0,
		},
		needsOperator: 0,
	},
	attentionCounts: {
		needsUserInput: 0,
		statusOnly: 0,
		diagnostic: 0,
		pendingApprovals: 0,
	},
	usage: {
		availability: "measured",
		startAt: at,
		endAt: at,
		inputTokens: 0,
		outputTokens: 0,
		cost: 0,
		currency: "USD",
		methodology: "Receipt totals in the selected time range",
	},
	reuse: {
		estimatedReusedNodes: 0,
		methodology: "Recorded cache decisions",
		unavailableReason: "No tasks have run yet",
	},
	projectHealth: { healthy: 1, warning: 0, unavailable: 0, warnings: [] },
};

const graph = {
	projectId: "project-1",
	controlDomainId: "domain-1",
	runId: "run-1",
	runVersion: 3,
	query: { expectedRunVersion: 3, limit: 500, scope: { kind: "run" } },
	totalNodeCount: 2,
	matchedNodeCount: 2,
	totalEdgeCount: 1,
	matchedEdgeCount: 1,
	nodes: [
		{
			nodeInstanceId: "node-1",
			phaseId: "check-tests",
			phaseType: "agent",
			origin: "bound-plan",
			status: "completed",
			attemptCount: 1,
		},
		{
			nodeInstanceId: "node-2",
			phaseId: "publish",
			phaseType: "approval",
			origin: "bound-plan",
			status: "running",
			attemptCount: 1,
		},
	],
	edges: [
		{
			fromNodeInstanceId: "node-1",
			toNodeInstanceId: "node-2",
			kind: "depends-on",
		},
	],
	boundaryEdges: [],
	sourceObservation,
};

const verifiedPresentation =
	projectTaskPresentation(completedVerifiedSource).verification;
const receipt = {
	receipt: {
		receiptId: "receipt-1",
		projectId: "project-1",
		controlDomainId: "domain-1",
		runId: "run-1",
		boundPlanHash: digest,
		eventManifest: ["event-1"],
		startCommitSeq: 1,
		endCommitSeq: 9,
		artifactRefs: [
			{
				artifactId: "artifact-1",
				role: "final-output",
				digest,
				size: 42,
				mediaType: "text/plain",
				storageClass: "control-store",
				redactionClass: "public",
				receiptId: "receipt-1",
				integrity: "ok",
				disclosure: {
					access: "direct",
					action: {
						catalogVersion:
							WEB_CONTENT_CATALOG_VERSION,
						key: "artifact.download.action",
						args: [],
					},
				},
			},
			{
				artifactId: "artifact-2",
				role: "replay-trace",
				digest: sensitiveDigest,
				size: 128,
				mediaType:
					"application/x-ndjson; charset=utf-8",
				storageClass: "control-store",
				redactionClass: "sensitive",
				receiptId: "receipt-1",
				integrity: "ok",
				disclosure: {
					access: "acknowledgement-required",
					question: {
						catalogVersion:
							WEB_CONTENT_CATALOG_VERSION,
						key: "artifact.sensitive.question",
						args: [],
					},
					impact: {
						catalogVersion:
							WEB_CONTENT_CATALOG_VERSION,
						key: "artifact.sensitive.impact",
						args: [],
					},
					confirm: {
						catalogVersion:
							WEB_CONTENT_CATALOG_VERSION,
						key: "artifact.sensitive.confirm",
						args: [],
					},
					decline: {
						catalogVersion:
							WEB_CONTENT_CATALOG_VERSION,
						key: "artifact.sensitive.decline",
						args: [],
					},
				},
			},
			{
				artifactId: "artifact-3",
				role: "restricted-audit-material",
				digest: secretDigest,
				size: 64,
				mediaType: "application/octet-stream",
				storageClass: "control-store",
				redactionClass: "secret",
				receiptId: "receipt-1",
				integrity: "ok",
				disclosure: {
					access: "blocked",
					headline: {
						catalogVersion:
							WEB_CONTENT_CATALOG_VERSION,
						key: "artifact.secret.headline",
						args: [],
					},
					detail: {
						catalogVersion:
							WEB_CONTENT_CATALOG_VERSION,
						key: "artifact.secret.detail",
						args: [],
					},
				},
			},
		],
		issuedAt: at,
		assurance: {
			journalContinuity: "ok",
			providerOutcome: "ok",
			artifactIntegrity: "ok",
			provenance: "ok",
		},
		buildInfo: { packageVersion: "0.3.0-beta.2", controlSchemaVersion: 1 },
	},
	verification: verifiedPresentation,
	artifactCount: 3,
	eventManifest: {
		items: [
			{
				eventId: "event-1",
				commitSeq: 1,
				eventKind: "run-completed",
				eventDigest: digest,
			},
		],
		sourceObservation,
	},
	sourceObservation,
};

const bootstrap = {
	browserProtocolMajor: 1,
	browserProtocolMinor: 0,
	protocolConsumerRange: { major: 1, minMinor: 0, maxMinor: 0 },
	schemaVersion: "web.v1",
	contentCatalogVersion: "taskflow-content.v1",
	defaultLocale: "en",
	supportedLocales: ["en", "zh-CN"],
	contentKeysetDigests: {
		...contentKeysetDigests,
	},
	listenerId: "listener-1",
	mode: "auto",
	role: "writer",
	principalId: "principal-1",
	principalDisplayName: "Local user",
	csrfToken: "fixture-csrf-token-000000000000000000000000",
	sessionIdleExpiresAt: at + 30 * 60_000,
	sessionAbsoluteExpiresAt: at + 8 * 60 * 60_000,
	buildInfo: {
		packageVersion: "0.3.0-beta.2",
		gitCommit: "fixture",
		controlSchemaVersion: 1,
	},
	supportedFeatures: ["overview", "run-detail", "approval-detail", "artifacts"],
	supportedCommands: ["approve", "reject", "cancel-run"],
	pollingMinIntervalMs: 3_000,
	registryContext: sourceObservation.registryContext,
	sourceObservation,
};

function failureSource(code, recoveryAction, sideEffects, overrides = {}) {
	return {
		failure: {
			ok: false,
			requestId: `request-${code.toLowerCase().replaceAll("_", "-")}`,
			schemaVersion: "web.v1",
			error: {
				code,
				message: "Sanitized fixture diagnostic",
				recoveryAction,
				sideEffects,
				...(overrides.commandId ? { commandId: overrides.commandId } : {}),
			},
		},
		context: {
			surface: overrides.surface ?? "authoritative-detail",
			operation: overrides.operation ?? "none",
			resourceState: overrides.resourceState ?? { kind: "none" },
			sourceAuthority: "verified",
			commandBodyState: overrides.commandBodyState ?? "not-applicable",
			supportedFeatures: ["run-detail", "reconcile-run"],
			supportedCommands: ["cancel-run", "reconcile-run"],
			availableActions: overrides.availableActions ?? [],
		},
	};
}

function failureFixture(id, state, source) {
	if (!Value.Check(WebFailurePresentationInputSchema, source)) {
		throw new Error(`${id}: invalid WebFailurePresentationInput`);
	}
	const projection = projectControlErrorPresentation(source);
	if (!Value.Check(WebFailurePresentationSchema, projection)) {
		throw new Error(`${id}: invalid WebFailurePresentation`);
	}
	return {
		id,
		screenId: "error-recovery",
		state,
		sourceKind: "failure-projection",
		source,
		projection,
	};
}

const disconnectedObservationInput = {
	sourceObservation: { ...sourceObservation, coverage: "partial" },
	liveState: {
		streamState: "disconnected",
		resyncState: "required",
		invalidationEpoch: 2,
	},
	scope: { kind: "aggregate" },
};

const fixtures = [
	{
		id: "simple-home-empty",
		screenId: "simple-home",
		state: "empty",
		sourceKind: "endpoint-view",
		source: overview,
		projection: { emptyStateKey: "empty.home.no-tasks" },
		schema: WebOverviewViewSchema,
	},
	{
		id: "simple-home-partial-disconnected",
		screenId: "simple-home",
		state: "partial-disconnected",
		sourceKind: "observation-projection",
		source: disconnectedObservationInput,
		projection: projectObservationPresentation(disconnectedObservationInput),
		sourceSchema: WebObservationPresentationInputSchema,
		schema: WebObservationPresentationSchema,
	},
	projectedTaskFixture(
		"active-task-result",
		"active-task",
		"running-with-result-pane",
		activeSource,
	),
	projectedTaskFixture(
		"needs-input-decision",
		"needs-input-decision",
		"two-sided-decision",
		decisionSource,
	),
	projectedTaskFixture(
		"completed-verified",
		"completed-task",
		"verified",
		completedVerifiedSource,
	),
	projectedTaskFixture(
		"completed-verification-unavailable",
		"completed-task",
		"verification-unavailable",
		completedUnavailableSource,
	),
	projectedTaskFixture(
		"unknown-reconciling",
		"unknown-reconciling",
		"possible-live-side-effects",
		reconcilingSource,
	),
	{
		id: "pro-graph-node-inspector",
		screenId: "pro-graph",
		state: "node-selected",
		sourceKind: "endpoint-view",
		source: graph,
		projection: { selectedNodeInstanceId: "node-2" },
		schema: WebRunGraphViewSchema,
	},
	{
		id: "pro-evidence-receipt",
		screenId: "pro-evidence",
		state: "verified-receipt",
		sourceKind: "endpoint-view",
		source: receipt,
		projection: verifiedPresentation,
		schema: WebReceiptViewSchema,
	},
	{
		id: "settings-session",
		screenId: "settings",
		state: "simple-mode-session-active",
		sourceKind: "endpoint-view",
		source: bootstrap,
		projection: { mode: "simple", theme: "system", locale: "en" },
		schema: WebBootstrapViewSchema,
	},
	failureFixture(
		"error-ordinary-preserved-result",
		"ordinary-failure-preserved-result",
		failureSource("TF_COMMAND_FAILED", "retry-new-command", "none"),
	),
	failureFixture(
		"error-protocol-incompatible",
		"protocol-incompatible",
		failureSource("TF_PROTOCOL_INCOMPATIBLE", "operator", "none", {
			surface: "bootstrap",
		}),
	),
	failureFixture(
		"error-cursor-expired",
		"cursor-expired",
		failureSource("TF_CURSOR_EXPIRED", "refresh", "none", {
			surface: "aggregate-list",
		}),
	),
	failureFixture(
		"error-command-outcome-unknown",
		"lost-command-outcome",
		failureSource("TF_COMMAND_FAILED", "retry-same-command", "unknown", {
			surface: "command-recovery",
			operation: "cancel-run",
			commandId: "command-1",
			commandBodyState: "present-in-current-tab-memory",
			resourceState: {
				kind: "command",
				commandId: "command-1",
				outcome: "not-found",
			},
			availableActions: [
				{
					kind: "cancel-run",
					state: "available",
					requestBase: {
						kind: "cancel-run",
						projectId: "project-1",
						controlDomainId: "domain-1",
						runId: "run-1",
						expectedRunVersion: 7,
					},
				},
			],
		}),
	),
];

for (const fixture of fixtures) {
	if (fixture.sourceSchema && !Value.Check(fixture.sourceSchema, fixture.source)) {
		throw new Error(`${fixture.id}: source schema validation failed`);
	}
	if (fixture.schema && !Value.Check(fixture.schema, fixture.sourceKind === "endpoint-view" ? fixture.source : fixture.projection)) {
		throw new Error(`${fixture.id}: output schema validation failed`);
	}
	delete fixture.schema;
	delete fixture.sourceSchema;
}

// The decision fixture freezes the standalone decision projection too.
const decisionProjection = projectDecisionPresentation(decisionInput);
fixtures.find((fixture) => fixture.id === "needs-input-decision").decisionProjection =
	decisionProjection;

function canonical(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
		.join(",")}}`;
}

function sha256(value) {
	return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function jsonValue(value) {
	return JSON.parse(JSON.stringify(value));
}

function serialized(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function collectRenderedContent(value, currentPath = "$", output = []) {
	if (Array.isArray(value)) {
		value.forEach((item, index) =>
			collectRenderedContent(item, `${currentPath}[${index}]`, output),
		);
		return output;
	}
	if (value === null || typeof value !== "object") return output;
	if (Value.Check(WebContentMessageSchema, value)) {
		output.push({
			path: currentPath,
			key: value.key,
			en: formatWebContentMessage(value, "en", { timeZone: "UTC" }),
			"zh-CN": formatWebContentMessage(value, "zh-CN", {
				timeZone: "UTC",
			}),
		});
		return output;
	}
	for (const [key, child] of Object.entries(value)) {
		collectRenderedContent(child, `${currentPath}.${key}`, output);
	}
	return output;
}

const outputs = new Map();
for (const fixture of fixtures) {
	const body = serialized({
		fixtureVersion: "web-reference-fixture.v1",
		...fixture,
		renderedContent: collectRenderedContent(fixture.projection),
	});
	outputs.set(path.join(fixtureRoot, `${fixture.id}.json`), body);
}

const screenOrder = [
	"simple-home",
	"active-task",
	"needs-input-decision",
	"completed-task",
	"unknown-reconciling",
	"pro-graph",
	"pro-evidence",
	"settings",
	"error-recovery",
];
const screenStaticKeys = {
	"simple-home": [
		"app.brand",
		"nav.home",
		"nav.tasks",
		"nav.needs-input",
		"section.active-tasks",
		"section.recent-tasks",
		"summary.task-count",
		"summary.workspace-count",
	],
	"active-task": [
		"app.brand",
		"nav.tasks",
		"section.task-details",
		"section.steps",
		"section.result",
		"section.verification",
	],
	"needs-input-decision": [
		"app.brand",
		"nav.needs-input",
		"section.required-input",
		"section.task-details",
	],
	"completed-task": [
		"app.brand",
		"nav.tasks",
		"section.result",
		"section.verification",
	],
	"unknown-reconciling": [
		"app.brand",
		"nav.tasks",
		"section.task-details",
		"section.steps",
	],
	"pro-graph": [
		"app.brand",
		"nav.pro.graph",
		"section.pro.graph",
		"section.pro.node",
		"graph.legend.depends-on",
		"graph.selected-step",
	],
	"pro-evidence": [
		"app.brand",
		"nav.pro.evidence",
		"section.pro.evidence",
		"section.pro.artifacts",
		"evidence.immutable-record",
		"evidence.current-checks",
		"evidence.export-check-title",
		"evidence.export-check-detail",
		"evidence.export-downloaded",
		"evidence.export-failed",
		"action.download-receipt-json",
	],
	settings: [
		"app.brand",
		"nav.settings",
		"section.preferences",
		"settings.mode.label",
		"settings.theme.label",
		"settings.language.label",
	],
	"error-recovery": [
		"app.brand",
		"action.show-details",
		"section.pro.technical",
		"pro.field.request-id",
	],
};
for (const [screenId, keys] of Object.entries(screenStaticKeys)) {
	for (const key of keys) {
		if (!WEB_STATIC_CONTENT_KEYS.includes(key)) {
			throw new Error(`${screenId}: unknown static content key ${key}`);
		}
		if (!WEB_STATIC_CONTENT_REGISTRY[key]) {
			throw new Error(`${screenId}: missing static catalog value ${key}`);
		}
	}
}
const manifest = {
	manifestVersion: "taskflow-web-reference-set.v1",
	status: "draft-unapproved",
	protocol: { major: 1, minor: 0, schemaVersion: "web.v1" },
	contentCatalogs: {
		version: contentMaterial.version,
		keyCounts: {
			projected: contentMaterial.projectedRegistry.length,
			static: contentMaterial.staticRegistry.length,
			combined: contentMaterial.combinedKeys.length,
		},
		keysetDigests: contentKeysetDigests,
		catalogDigests: contentCatalogDigests,
	},
	projectionVersions: {
		task: "task-presentation.v1",
		decision: "decision-presentation.v1",
		observation: "observation-presentation.v1",
		failure: "failure-presentation.v1",
	},
	reviewMatrix: {
		locales: ["en", "zh-CN"],
		themes: ["light", "dark"],
		viewports: ["1440x900", "1024x768", "320-css-px", "200-percent-zoom"],
		evidenceState: fs.existsSync(renderEvidencePath)
			? "rendered-awaiting-human-approval"
			: "required-not-yet-rendered",
		...(fs.existsSync(renderEvidencePath)
			? { evidenceManifest: "render-evidence.json" }
			: {}),
	},
	screens: screenOrder.map((screenId) => ({
		screenId,
		spec: `screens/${screenId}.md`,
		staticContentKeys: screenStaticKeys[screenId],
		fixtures: fixtures
			.filter((fixture) => fixture.screenId === screenId)
			.map((fixture) => {
				const body = outputs.get(path.join(fixtureRoot, `${fixture.id}.json`));
				return {
					fixtureId: fixture.id,
					state: fixture.state,
					path: `../../../../packages/taskflow-control/test/fixtures/web-v1/reference/${fixture.id}.json`,
					sourceSha256: sha256(canonical(jsonValue(fixture.source))),
					projectionSha256: sha256(canonical(jsonValue(fixture.projection))),
					fixtureFileSha256: sha256(body),
					contentKeys: Array.from(
						new Set(
							[
								...collectRenderedContent(
									fixture.source,
								),
								...collectRenderedContent(
									fixture.projection,
								),
							].map((entry) => entry.key),
						),
					).sort(),
				};
			}),
		reviewStatus: "unapproved",
	})),
};
outputs.set(manifestPath, serialized(manifest));

let drift = false;
for (const [file, expected] of outputs) {
	const actual = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
	if (actual === expected) continue;
	drift = true;
	if (shouldWrite) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, expected);
	} else {
		process.stderr.write(`${path.relative(repoRoot, file)} is missing or stale\n`);
	}
}

if (!shouldWrite && drift) process.exitCode = 1;
if (!drift) {
	process.stdout.write(`web reference fixtures match (${fixtures.length} fixtures)\n`);
} else if (shouldWrite) {
	process.stdout.write(`wrote ${fixtures.length} web reference fixtures + manifest\n`);
}
