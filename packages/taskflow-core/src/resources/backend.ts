/**
 * Host-neutral workspace execution policy contracts.
 *
 * These types describe authority which has already been authorized and resolved by
 * a trusted host.  They deliberately do not implement, or claim to implement, an
 * operating-system sandbox.
 */

import type {
	BoundCapabilityLifetime,
	PathIntent,
	ScopedCapability,
	WorkspaceAccess,
} from "./schema.ts";
import type {
	CanonicalLeaseKey,
	ExternalMutationModel,
	ExecutionOwner,
	VersionCommitMode,
} from "./types.ts";
import type { MutationPermit } from "./permits.ts";
import type { ResolvedPathRef } from "./resolve.ts";
import type { RunResult } from "../host/runner-types.ts";
import type { FileHandle } from "node:fs/promises";

export type {
	BoundCapabilityLifetime,
	CanonicalLeaseKey,
	ExternalMutationModel,
	ExecutionOwner,
	MutationPermit,
	PathIntent,
	ResolvedPathRef,
	ScopedCapability,
	VersionCommitMode,
	WorkspaceAccess,
};

export type RestoreStrategy = "replace-scope" | "provider-native";

export type CredentialDelivery =
	| { mode: "opaque-broker"; brokerId: string; maxTtlMs: number }
	| {
			mode: "isolated-host-process";
			scrubToolEnvironment: true;
			denyProcessInspection: true;
	  }
	| { mode: "unavailable" };

export interface ProviderMetadataGrant {
	metadataId: string;
	kind: "exact-file";
	contentDigest: string;
	secretScanPolicyId: string;
}

export interface HostBaselinePolicy {
	schemaVersion: 1;
	policyId: string;
	policyVersion: string;
	bodyDigest: string;
	readableSystemClasses: Array<"runtime" | "dynamic-libraries" | "ca-certificates">;
	providerMetadata: ProviderMetadataGrant[];
	credentialDelivery: CredentialDelivery;
	temp: { mode: "private-per-execution"; access: "read-write" };
	network?: "host-policy" | "none";
}

export interface SandboxGrant {
	bindingId: string;
	resourceDomainId: string;
	providerInstanceId: string;
	logicalWorkspaceId: string;
	logicalPrefix: string;
	physicalScopeRoot: string;
	scopeKind: "directory" | "file";
	access: WorkspaceAccess;
	lifetime: BoundCapabilityLifetime;
}

export interface BoundCredentialRequirement {
	credentialGrantId: string;
	credentialId: string;
	audience: string;
	purpose: string;
	ttlMs: number;
	delivery: Exclude<CredentialDelivery, { mode: "unavailable" }>;
}

export interface SandboxPolicyPlan {
	mode: "sandboxed" | "resolve-only";
	cwd: ResolvedPathRef;
	grants: SandboxGrant[];
	baseline: HostBaselinePolicy;
	credentialRequirements: BoundCredentialRequirement[];
	policyDigest: string;
}

export interface SandboxFeatureSet {
	maxGrants: number;
	scopeKinds: Array<"file" | "directory">;
	perGrantAccess: boolean;
	denyAmbientUserData: boolean;
	exactBaselineMounts: boolean;
	privateTempPerExecution: boolean;
	descendantEnforcement: boolean;
	raceFreeFileBroker: boolean;
	networkModes: Array<"host-policy" | "none">;
	credentialModes: Array<"opaque-broker" | "isolated-host-process">;
}

export interface WorkspaceBackendCapabilities {
	schemaVersion: 1;
	backendId: string;
	backendCapabilityVersion: string;
	agent: "native-single-root" | "native-multi-root" | "resolve-only";
	script: "native-single-root" | "native-multi-root" | "resolve-only";
	sandboxFeatures: SandboxFeatureSet;
	brokeredRead: boolean;
	brokeredWrite: boolean;
	versionCommitModes: VersionCommitMode[];
	restoreStrategies: RestoreStrategy[];
	baselinePolicyId: string;
}

export interface PhysicalBaselineMount {
	mountId: string;
	physicalPath: string;
	access: "read-only" | "read-write";
}

export interface CredentialBrokerBinding {
	credentialGrantId: string;
	brokerGrantId: string;
	expiresAt: string;
}

/** Result of a trusted adapter preparing the exact concrete policy. */
export interface ConcreteSandboxPreparation {
	/** Must describe the real adapter result, never a static feature advertisement. */
	assurance: "native-sandbox-prepared";
	preparationId: string;
	baselineMounts: PhysicalBaselineMount[];
	credentialBindings: CredentialBrokerBinding[];
}

export interface ResolveOnlyPreparation {
	assurance: "resolve-only-no-sandbox";
	preparationId: string;
}

export type SandboxPreparationEvidence = ConcreteSandboxPreparation | ResolveOnlyPreparation;

declare const PREPARED_SANDBOX: unique symbol;

export interface PreparedSandboxPlan {
	readonly [PREPARED_SANDBOX]: true;
	readonly preparedPlanId: string;
	readonly backendId: string;
	readonly backendCapabilityVersion: string;
	readonly owner: ExecutionOwner;
	readonly policy: SandboxPolicyPlan;
	readonly expiresAt: string;
	/** Prevents resolve-only plans from being presented as sandboxed plans. */
	readonly assurance: SandboxPreparationEvidence["assurance"];
}

declare const SEALED_SANDBOX: unique symbol;

export interface SandboxPlan {
	readonly [SEALED_SANDBOX]: true;
	readonly prepared: PreparedSandboxPlan;
	readonly mutationPermits: readonly MutationPermit[];
	readonly enforcementDigest: string;
}

declare const SANDBOX_ACTIVATION: unique symbol;

export interface SandboxActivation {
	readonly [SANDBOX_ACTIVATION]: true;
	readonly plan: SandboxPlan;
	readonly activatedAt: string;
}

export interface AgentRequest {
	agentName: string;
	task: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	idleTimeoutMs?: number;
	signal?: AbortSignal;
}

export interface ScriptRequest {
	/** Shell-free argv. Capability mode never interpolates a shell string. */
	argv: string[];
	stdin?: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface WorkspaceScriptResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	stdoutOversize: boolean;
}

export interface FingerprintSelector {
	type: "content" | "metadata";
	algorithm: "sha256";
	maxBytes?: number;
}

declare const PREPARED_FILE_BROKER: unique symbol;

export interface PreparedFileBrokerPlan {
	readonly [PREPARED_FILE_BROKER]: true;
	readonly preparedFilePlanId: string;
	readonly operation: "read" | "write";
	readonly owner: ExecutionOwner;
	readonly ref: ResolvedPathRef;
	readonly resourcePolicyDigest: string;
	readonly expiresAt: string;
}

export interface FileBrokerReadPlan {
	readonly prepared: PreparedFileBrokerPlan & { operation: "read" };
	readonly enforcementDigest: string;
}

export interface FileBrokerWritePlan {
	readonly prepared: PreparedFileBrokerPlan & { operation: "write" };
	readonly permit: MutationPermit;
	readonly enforcementDigest: string;
}

export interface ImmutableArtifactRef {
	artifactId: string;
	contentId: string;
	kind: "phase-output" | "workspace-snapshot";
	manifestDigest: string;
	scopeDigest?: string;
}

export interface PostStateObservation {
	contentId?: string;
	restorableSnapshot?: ImmutableArtifactRef;
}

export type RestoreSafety = "taskflow-exclusive" | "atomic-content-cas" | "external-fencing" | "none";

export interface ResourceVersioningPlan {
	commitMode: VersionCommitMode;
	restore:
		| { mode: "none" }
		| {
				mode: "restorable-snapshot";
				strategy: RestoreStrategy;
				safety: RestoreSafety;
				transactionGroupId: string;
		  };
	externalMutation: ExternalMutationModel;
}

export interface RestoreStateRequest {
	capability: ScopedCapability;
	snapshot: ImmutableArtifactRef;
	expectedBeforeContentId: string;
	expectedScopeDigest: string;
}

declare const PREPARED_RESTORE: unique symbol;

export interface PreparedRestoreTransaction {
	readonly [PREPARED_RESTORE]: true;
	readonly transactionId: string;
	readonly transactionGroupId: string;
	readonly requests: RestoreStateRequest[];
	readonly expiresAt: string;
}

export interface RestoreTransactionPlan {
	prepared: PreparedRestoreTransaction;
	permits: MutationPermit[];
	enforcementDigest: string;
}

export interface RestoreMutationResult {
	resourceDomainId: string;
	observedAfterContentId: string;
	scopeDigest: string;
}

export interface ProviderControllerGrant {
	controllerId: string;
	provider: "temp" | "dedicated" | "worktree" | "artifact";
	baseBindingId?: string;
	operations: ReadonlySet<"create" | "resume" | "snapshot" | "release" | "reconcile">;
}

export interface ProviderControlRequest {
	operation: "create" | "resume" | "snapshot" | "release" | "reconcile";
	providerInstanceId?: string;
	parameters?: Readonly<Record<string, unknown>>;
}

export interface ProviderControlResult {
	providerInstanceId: string;
	artifact?: ImmutableArtifactRef;
}

/**
 * Unified authority boundary for every data-plane filesystem/process action.
 * Implementations must fail closed for unsupported methods; capability flags
 * alone never prove that a concrete plan can be enforced.
 */
export interface WorkspaceExecutionBackend {
	capabilities(): WorkspaceBackendCapabilities;
	versioning(capability: ScopedCapability): Promise<ResourceVersioningPlan>;
	prepareSandbox(plan: SandboxPolicyPlan, owner: ExecutionOwner): Promise<PreparedSandboxPlan>;
	sealSandbox(prepared: PreparedSandboxPlan, permits: MutationPermit[]): Promise<SandboxPlan> | SandboxPlan;
	runAgent(plan: SandboxPlan, request: AgentRequest): Promise<RunResult>;
	runScript(plan: SandboxPlan, request: ScriptRequest): Promise<WorkspaceScriptResult>;
	prepareFileRead(ref: ResolvedPathRef, owner: ExecutionOwner): Promise<PreparedFileBrokerPlan & { operation: "read" }>;
	prepareFileWrite(ref: ResolvedPathRef, owner: ExecutionOwner): Promise<PreparedFileBrokerPlan & { operation: "write" }>;
	sealFileRead(prepared: PreparedFileBrokerPlan & { operation: "read" }): Promise<FileBrokerReadPlan>;
	openRead(plan: FileBrokerReadPlan): Promise<FileHandle>;
	sealFileWrite(
		prepared: PreparedFileBrokerPlan & { operation: "write" },
		permit: MutationPermit,
	): Promise<FileBrokerWritePlan>;
	openWrite(plan: FileBrokerWritePlan): Promise<FileHandle>;
	fingerprint(plan: FileBrokerReadPlan, selector: FingerprintSelector): Promise<string>;
	observePostState(
		capability: ScopedCapability,
		permit: MutationPermit,
		plan: ResourceVersioningPlan,
	): Promise<PostStateObservation>;
	prepareRestoreTransaction(
		transactionId: string,
		requests: RestoreStateRequest[],
	): Promise<PreparedRestoreTransaction>;
	sealRestoreTransaction(
		prepared: PreparedRestoreTransaction,
		permits: MutationPermit[],
	): Promise<RestoreTransactionPlan>;
	restoreTransaction(plan: RestoreTransactionPlan): Promise<RestoreMutationResult[]>;
	providerControl(
		grant: ProviderControllerGrant,
		request: ProviderControlRequest,
	): Promise<ProviderControlResult>;
}

export type SandboxExecutionTarget = "agent" | "script";

export type SandboxPlanErrorCode =
	| "TFWS_INVALID_POLICY"
	| "TFWS_POLICY_DIGEST_MISMATCH"
	| "TFWS_BASELINE_MISMATCH"
	| "TFWS_UNSUPPORTED_SANDBOX_POLICY"
	| "TFWS_RESOLVE_ONLY_NOT_AUTHORIZED"
	| "TFWS_PREPARED_PLAN_EXPIRED"
	| "TFWS_FOREIGN_PREPARED_PLAN"
	| "TFWS_MISSING_MUTATION_PERMIT"
	| "TFWS_INVALID_MUTATION_PERMIT"
	| "TFWS_ENFORCEMENT_DIGEST_MISMATCH"
	| "TFWS_PLAN_REPLAY";

export class SandboxPlanError extends Error {
	readonly code: SandboxPlanErrorCode;

	constructor(code: SandboxPlanErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.name = "SandboxPlanError";
		this.code = code;
	}
}
