import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
	CONTROL_ERROR_CODES,
	CONTROL_WIRE_SCHEMA_VERSION,
	ApprovalModeSchema,
	ArtifactRefSchema,
	BoundPlanSchema,
	BootstrapManifestSchema,
	CommandRecordSchema,
	ConcurrencyReservationSchema,
	type ConcurrencyReservation,
	ControlEventSchema,
	ControlStoreHeaderSchema,
	CoordinatorLeaseSchema,
	EnforcementCapabilitiesSchema,
	ErrorEnvelopeSchema,
	NegotiationHandshakeSchema,
	PathRefSchema,
	ReceiptSchema,
	RunSnapshotSchema,
	RunStageSchema,
	RunStatusSchema,
} from "../src/schema/index.ts";
import { assertReservationInvariants } from "../src/schema/coordinator.ts";
import { TERMINAL_RUN_STATUSES, isTerminalRunStatus } from "../src/schema/run.ts";

const UUID = "00000000-0000-0000-0000-000000000001";
const SHA256 = "a".repeat(64);

test("schema: closed contracts reject unknown fields (additionalProperties: false)", () => {
	// Top-level wire docs must reject extra fields — no silent reparse.
	for (const [name, schema, valid] of [
		["ControlStoreHeader", ControlStoreHeaderSchema, { projectId: UUID, controlDomainId: UUID, schemaVersion: CONTROL_WIRE_SCHEMA_VERSION, directoryBinding: { canonicalPath: "/p", device: "d", inode: "i" } }],
		["ControlEvent", ControlEventSchema, event()],
		["CommandRecord", CommandRecordSchema, command()],
		["NegotiationHandshake", NegotiationHandshakeSchema, handshake()],
		["ErrorEnvelope", ErrorEnvelopeSchema, { code: "TF_COMMAND_FAILED", message: "boom", recoveryAction: "none", sideEffects: "none" }],
		["CoordinatorLease", CoordinatorLeaseSchema, { holderId: "h", fencingEpoch: 1, endpoint: "/sock", expiresAt: 123 }],
		["BoundPlan", BoundPlanSchema, boundPlan()],
		["Receipt", ReceiptSchema, receipt()],
		["BootstrapManifest", BootstrapManifestSchema, { controlBinaryPath: "/bin/taskflowd", controlHome: "/home", singletonEndpoint: "/sock", fencingEpoch: 1 }],
		["ArtifactRef", ArtifactRefSchema, { digest: SHA256, size: 1, mediaType: "text/plain", storageClass: "local", redactionClass: "none" }],
	] as const) {
		assert.equal(Value.Check(schema, valid), true, `${name} should accept its valid shape`);
		assert.equal(Value.Check(schema, { ...(valid as object), extraField: "x" }), false, `${name} must reject unknown fields`);
	}
});

test("schema: schemaVersion is pinned on envelope documents", () => {
	const header = ControlStoreHeaderSchema as { properties?: Record<string, unknown> };
	assert.ok(header.properties && "schemaVersion" in header.properties);
	const event = ControlEventSchema as { properties?: Record<string, unknown> };
	assert.ok(event.properties && "schemaVersion" in event.properties);
	assert.equal(CONTROL_WIRE_SCHEMA_VERSION, 1);
});

test("schema: RunStatus / RunStage are the exact frozen enums (P5)", () => {
	const status = Value.Check(RunStatusSchema, "completed");
	assert.equal(status, true);
	for (const bad of ["success", "succeeded", "terminated", "done", ""]) {
		assert.equal(Value.Check(RunStatusSchema, bad), false, `RunStatus must reject ${bad}`);
	}
	for (const stage of ["received", "compiled", "linked", "queued", "admitted", "executing", "parked", "reconciling", "terminal"]) {
		assert.equal(Value.Check(RunStageSchema, stage), true, `RunStage accepts ${stage}`);
	}
	assert.equal(Value.Check(RunStageSchema, "executed"), false);
	assert.deepEqual(TERMINAL_RUN_STATUSES, ["completed", "failed", "blocked", "cancelled"]);
	assert.equal(isTerminalRunStatus("unknown"), false, "unknown is non-terminal (D33)");
});

test("schema: ApprovalMode / error codes are the closed frozen sets", () => {
	assert.equal(Value.Check(ApprovalModeSchema, "compat-auto-reject"), true);
	assert.equal(Value.Check(ApprovalModeSchema, "durable-required"), true);
	assert.equal(Value.Check(ApprovalModeSchema, "auto-approve"), false);
	const codes = CONTROL_ERROR_CODES;
	assert.ok(codes.includes("TF_PROTOCOL_INCOMPATIBLE"));
	assert.ok(codes.includes("TF_RECONCILE_REQUIRED"));
	assert.ok(codes.includes("TF_ADMISSION_BINDING_CONFLICT"));
	assert.ok(codes.includes("TF_CAPACITY_EXCEEDED"));
	// No optional holes: the code set is closed and non-empty.
	assert.ok(codes.length >= 18);
});

test("schema: no optional holes on P16/P8 pinned fields", () => {
	// ConcurrencyReservation.slots is fixed at 1 and must be present.
	const reservation = {
		reservationId: UUID,
		state: "reserved",
		slots: 1,
		projectId: UUID,
		projectControlDomainId: UUID,
		runId: UUID,
		coordinatorEpoch: 1,
	};
	assert.equal(Value.Check(ConcurrencyReservationSchema, reservation), true);
	assert.equal(Value.Check(ConcurrencyReservationSchema, { ...reservation, slots: 2 }), false);
	assert.equal(Value.Check(ConcurrencyReservationSchema, { ...reservation, slots: undefined }), false);

	// BoundPlan.enforcementCapabilities is required.
	const plan = boundPlan();
	assert.equal(Value.Check(BoundPlanSchema, plan), true);
	const { enforcementCapabilities: _drop, ...withoutEnforcement } = plan;
	assert.equal(Value.Check(BoundPlanSchema, withoutEnforcement), false, "BoundPlan.enforcementCapabilities is required");

	// CommandRecord.requestHash is required (P12).
	const cmd = command();
	const { requestHash: _dropHash, ...withoutHash } = cmd;
	assert.equal(Value.Check(CommandRecordSchema, withoutHash), false, "CommandRecord.requestHash is required");
});

test("schema: P16 reservation invariants — committed requires projectAdmitCommitSeq, rejects residual TTL", () => {
	const committed: ConcurrencyReservation = {
		reservationId: UUID,
		state: "committed",
		slots: 1,
		projectId: UUID,
		projectControlDomainId: UUID,
		runId: UUID,
		projectAdmitCommitSeq: 7,
		coordinatorEpoch: 1,
	};
	assertReservationInvariants(committed); // ok
	assert.throws(
		() => assertReservationInvariants({ ...committed, projectAdmitCommitSeq: undefined } as ConcurrencyReservation),
		/TF_ADMISSION_BINDING_CONFLICT/,
	);
	assert.throws(
		() => assertReservationInvariants({ ...committed, reservedExpiresAt: 123 } as ConcurrencyReservation),
		/must not retain reservedExpiresAt/,
	);
	assert.throws(
		() => assertReservationInvariants({ ...committed, slots: 2 } as unknown as ConcurrencyReservation),
		/slots are fixed at 1/,
	);
});

test("schema: EnforcementCapabilities is the P8 default package shape", () => {
	const caps = {
		resolution: "contained",
		mutationMediation: "brokered",
		processIsolation: "none",
		revocation: "admission-only",
		baselinePolicyId: "taskflow-resolve-only",
		hostProbeSha256: SHA256,
	};
	assert.equal(Value.Check(EnforcementCapabilitiesSchema, caps), true);
	assert.equal(Value.Check(EnforcementCapabilitiesSchema, { ...caps, resolution: "unbound" }), true, "unbound is representable in the wire");
	assert.equal(Value.Check(EnforcementCapabilitiesSchema, { ...caps, processIsolation: "weird" }), false);
	// Bound-latency revocation object form validates.
	assert.equal(Value.Check(EnforcementCapabilitiesSchema, { ...caps, revocation: { mode: "bounded-latency", maxLatencyMs: 500 } }), true);
});

test("schema: PathRef mirror accepts the TE workspace/handle XOR shapes", () => {
	assert.equal(Value.Check(PathRefSchema, { workspace: "invocation", intent: "existing-directory" }), true);
	assert.equal(Value.Check(PathRefSchema, { workspace: "invocation", subpath: { argPath: "dir" }, access: "read-write", intent: "existing-directory" }), true);
	assert.equal(Value.Check(PathRefSchema, { handle: { producerPhaseId: "p", exportName: "e" }, intent: "existing-file" }), true);
	assert.equal(Value.Check(PathRefSchema, { workspace: "invocation", handle: { producerPhaseId: "p", exportName: "e" }, intent: "existing-file" }), false, "workspace and handle are XOR");
});

test("schema: RunSnapshot carries status + stage + slot + needsOperator", () => {
	const snapshot = {
		runId: UUID,
		projectId: UUID,
		controlDomainId: UUID,
		status: "unknown",
		stage: "reconciling",
		slot: "orphan-suspect",
		needsOperator: true,
		projectAdmitCommitSeq: 3,
	};
	assert.equal(Value.Check(RunSnapshotSchema, snapshot), true);
	assert.equal(Value.Check(RunSnapshotSchema, { ...snapshot, needsOperator: undefined }), false);
});

function event() {
	return {
		eventId: UUID,
		schemaVersion: CONTROL_WIRE_SCHEMA_VERSION,
		controlDomainId: UUID,
		streamId: "run:1",
		streamSeq: 1,
		commitSeq: 1,
		causationId: UUID,
		correlationId: UUID,
		projectId: UUID,
		recordedAt: 0,
		payload: { kind: "dispatch.acknowledged", providerJobHandle: "j" },
	};
}

function command() {
	return {
		commandId: UUID,
		kind: "run.submit",
		requestHash: SHA256,
		callerPrincipal: "cli",
		authorizationContextHash: SHA256,
		projectId: UUID,
		controlDomainId: UUID,
		status: "accepted",
		firstCommitSeq: 1,
		lastCommitSeq: 2,
		recordedAt: 0,
	};
}

function handshake() {
	return {
		protocolMajor: 1,
		supportedReadSchemas: ["taskflow.wire.v1"],
		supportedWriteSchemas: ["taskflow.wire.v1"],
		requiredFeatures: [],
		offeredFeatures: [],
		buildInfo: { packageVersion: "0.3.0", gitCommit: "abc", schemaVersion: 1 },
	};
}

function boundPlan() {
	return {
		schemaVersion: CONTROL_WIRE_SCHEMA_VERSION,
		projectId: UUID,
		controlDomainId: UUID,
		planId: UUID,
		bindings: [],
		spawnTemplate: {
			allowedAgentClasses: ["executor"],
			allowedProviderClasses: ["te-resources"],
			maxToolCallsPerStep: 10,
			maxEffectsPerNode: 5,
			maxChildren: 4,
			maxDepth: 2,
			budgetShare: 0.5,
		},
		savedFlowPins: [],
		grantRefs: [],
		claims: [],
		enforcementCapabilities: {
			resolution: "contained",
			mutationMediation: "brokered",
			processIsolation: "none",
			revocation: "admission-only",
			baselinePolicyId: "taskflow-resolve-only",
			hostProbeSha256: SHA256,
		},
		dynamicPolicy: { hostCeiling: {}, authorizationContextHash: SHA256 },
		boundPlanHash: "plan:" + SHA256,
	};
}

function receipt() {
	return {
		schemaVersion: CONTROL_WIRE_SCHEMA_VERSION,
		controlDomainId: UUID,
		runId: UUID,
		boundPlanHash: "plan:" + SHA256,
		eventManifest: [UUID],
		manifestRoot: SHA256,
		startCommitSeq: 1,
		endCommitSeq: 2,
		artifactRefs: [],
		assurance: {
			journalContinuity: true,
			providerOutcome: "completed",
			artifactIntegrity: "verified",
			provenance: { confidentiality: "internal", integrity: "project" },
			enforcement: {
				capabilities: {
					resolution: "contained",
					mutationMediation: "brokered",
					processIsolation: "none",
					revocation: "admission-only",
					baselinePolicyId: "taskflow-resolve-only",
					hostProbeSha256: SHA256,
				},
			},
		},
		buildInfo: { packageVersion: "0.3.0", gitCommit: "abc", schemaVersion: 1 },
	};
}
