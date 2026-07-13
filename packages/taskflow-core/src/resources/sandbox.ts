import {
	createHmac,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import path from "node:path";
import {
	hostProbeTargetsEqual,
	isExactHostProbeTarget,
	isVerifiedSandboxHostApproval,
	type HostProbeTarget,
	type VerifiedSandboxHostApproval,
} from "./baseline.ts";
import { canonicalJson, sha256Canonical } from "./canonical-json.ts";
import { isIssuedMutationPermit } from "./permits.ts";
import { isResolvedPathRef } from "./resolve.ts";
import type {
	BoundCapabilityLifetime,
	BoundCredentialRequirement,
	ConcreteSandboxPreparation,
	CredentialBrokerBinding,
	ExecutionOwner,
	HostBaselinePolicy,
	MutationPermit,
	PhysicalBaselineMount,
	PreparedSandboxPlan,
	ResolveOnlyPreparation,
	SandboxActivation,
	SandboxExecutionTarget,
	SandboxGrant,
	SandboxPlan,
	SandboxPolicyPlan,
	WorkspaceBackendCapabilities,
} from "./backend.ts";
import { SandboxPlanError } from "./backend.ts";

const POLICY_TAG = "tfws-policy/v1";
const POLICY_PREFIX = "tfws-policy:v1:";
const ENFORCEMENT_TAG = "tfws-enforcement/v1";
const ENFORCEMENT_PREFIX = "tfws-enforcement:v1:";

export interface ConcreteSandboxAdapter {
	/**
	 * Prepare and verify this exact concrete policy using the native adapter.
	 * Merely echoing WorkspaceBackendCapabilities is not a valid implementation.
	 */
	prepareConcreteSandbox(
		policy: Readonly<SandboxPolicyPlan>,
		owner: Readonly<ExecutionOwner>,
	): Promise<ConcreteSandboxPreparation>;
}

export interface ResolveOnlyAdapter {
	/** Performs path-only preparation and must return the explicit low-assurance tag. */
	prepareResolveOnly(
		policy: Readonly<SandboxPolicyPlan>,
		owner: Readonly<ExecutionOwner>,
	): Promise<ResolveOnlyPreparation>;
}

export interface SandboxPolicyFactoryOptions {
	capabilities: WorkspaceBackendCapabilities;
	executionTarget: SandboxExecutionTarget;
	/** Exact process-local host approval minted by the trusted evidence loader.
	 * Required for every native target; clone/JSON/spread copies are rejected. */
	sandboxApproval?: VerifiedSandboxHostApproval;
	/** Independently observed live Host/OS/binary/backend tuple. Native execution
	 * requires an exact all-field match with the approved target. */
	liveTarget?: HostProbeTarget;
	/** Expected checked-in host-support baseline identity. */
	hostSupportBaselineId?: string;
	/** Complete trusted baseline policies. bodyDigest is recomputed from the
	 * canonical full body (excluding bodyDigest) during registration. */
	baselineBindings: readonly HostBaselinePolicy[];
	/** At least 256 bits of process-local host key material. */
	key: Uint8Array;
	keyId: string;
	preparedPlanTtlMs?: number;
	now?: () => Date;
	concreteAdapter?: ConcreteSandboxAdapter;
	resolveOnlyAdapter?: ResolveOnlyAdapter;
	/** Host authorization decision made outside flow data. Default is deny. */
	authorizeResolveOnly?: (
		owner: Readonly<ExecutionOwner>,
		policy: Readonly<SandboxPolicyPlan>,
	) => boolean;
}

export interface SandboxActivationHooks {
	/** Journal CAS: issued -> active. Required for every plan carrying permits. */
	activateMutationPermits?: (
		permits: readonly MutationPermit[],
		owner: Readonly<ExecutionOwner>,
	) => Promise<void>;
	/** Always called after an activation callback was entered. */
	settleMutationPermits?: (
		permits: readonly MutationPermit[],
		owner: Readonly<ExecutionOwner>,
		outcome: "completed" | "failed",
	) => Promise<void>;
}

type PlanState = "sealed" | "activating" | "active" | "settled";

/** Build the path-free portable policy digest specified by the Workspace RFC. */
export function computeSandboxPolicyDigest(
	plan: Omit<SandboxPolicyPlan, "policyDigest"> | SandboxPolicyPlan,
	backend: Pick<WorkspaceBackendCapabilities, "backendId" | "backendCapabilityVersion">,
): string {
	const grants = plan.grants.map(projectGrant).sort(compareProjectedGrants);
	const credentials = plan.credentialRequirements.map(projectCredential).sort(compareProjectedCredentials);
	const writableScopes = grants
		.filter((grant) => grant.access === "read-write")
		.map((grant) => ({
			resourceDomainId: grant.resourceDomainId,
			logicalWorkspaceId: grant.logicalWorkspaceId,
			logicalPrefix: grant.logicalPrefix,
			scopeKind: grant.scopeKind,
			requiresMutationPermit: true,
		}))
		.sort((left, right) => compareStringTuple(
			[left.resourceDomainId, left.logicalWorkspaceId, left.logicalPrefix, left.scopeKind],
			[right.resourceDomainId, right.logicalWorkspaceId, right.logicalPrefix, right.scopeKind],
		));
	const payload = {
		schema: POLICY_TAG,
		mode: plan.mode,
		backend: {
			backendId: backend.backendId,
			backendCapabilityVersion: backend.backendCapabilityVersion,
		},
		baseline: {
			policyId: plan.baseline.policyId,
			policyVersion: plan.baseline.policyVersion,
			bodyDigest: plan.baseline.bodyDigest,
		},
		cwd: {
			logicalWorkspaceId: plan.cwd.capability.logicalWorkspaceId,
			logicalPrefix: plan.cwd.capability.logicalPrefix,
			logicalSubpath: plan.cwd.logicalSubpath,
			intent: plan.cwd.intent,
			access: plan.cwd.capability.access,
		},
		grants,
		writableScopes,
		credentialRequirements: credentials,
	};
	return `${POLICY_PREFIX}${sha256Canonical(payload)}`;
}

/** Canonical baseline body digest. The digest field itself is excluded; every
 * other policy field, including identity/version, is bound. */
export function computeHostBaselineBodyDigest(
	baseline: Omit<HostBaselinePolicy, "bodyDigest"> | HostBaselinePolicy,
): string {
	const { bodyDigest: _ignored, ...body } = baseline as HostBaselinePolicy;
	return sha256Canonical(body);
}

/** Content address the complete advertised backend capability record. */
export function computeWorkspaceBackendCapabilitiesSha256(
	capabilities: WorkspaceBackendCapabilities,
): string {
	assertCapabilities(capabilities);
	return sha256Canonical(capabilities);
}

/** Attach the computed portable digest without changing the concrete plan inputs. */
export function createSandboxPolicyPlan(
	plan: Omit<SandboxPolicyPlan, "policyDigest">,
	backend: Pick<WorkspaceBackendCapabilities, "backendId" | "backendCapabilityVersion">,
): SandboxPolicyPlan {
	return {
		...plan,
		policyDigest: computeSandboxPolicyDigest(plan, backend),
	};
}

/**
 * Process-local policy factory.  It negotiates and authenticates plans, but delegates
 * real native preparation to an adapter and therefore never pretends to be a sandbox.
 */
export class SandboxPolicyFactory {
	readonly #options: SandboxPolicyFactoryOptions;
	readonly #key: Buffer;
	readonly #baselineBindings = new Map<string, HostBaselinePolicy>();
	readonly #prepared = new WeakMap<PreparedSandboxPlan, ConcreteSandboxPreparation | ResolveOnlyPreparation>();
	readonly #preparedSealed = new WeakSet<PreparedSandboxPlan>();
	readonly #sealed = new WeakMap<SandboxPlan, PlanState>();

	constructor(options: SandboxPolicyFactoryOptions) {
		assertCapabilities(options.capabilities);
		if (options.executionTarget !== "agent" && options.executionTarget !== "script") {
			throw invalid("executionTarget must be agent or script");
		}
		const selectedMode = options.capabilities[options.executionTarget];
		if (selectedMode === "native-single-root" || selectedMode === "native-multi-root") {
			if (!isVerifiedSandboxHostApproval(options.sandboxApproval)) {
				throw unsupported("native sandbox construction requires an exact verified host approval");
			}
			const expectedClassification = selectedMode === "native-single-root"
				? "sandboxed-single-root"
				: "sandboxed-multi-root";
			if (!isExactHostProbeTarget(options.liveTarget) ||
				!hostProbeTargetsEqual(options.sandboxApproval.target, options.liveTarget) ||
				options.sandboxApproval.classification !== expectedClassification ||
				options.sandboxApproval.baselineId !== options.hostSupportBaselineId) {
				throw unsupported("verified host approval does not exactly match the live native host target");
			}
			if (options.liveTarget.backendId !== options.capabilities.backendId ||
				options.liveTarget.backendCapabilityVersion !== options.capabilities.backendCapabilityVersion ||
				options.liveTarget.backendCapabilitiesSha256 !== computeWorkspaceBackendCapabilitiesSha256(options.capabilities) ||
				options.liveTarget.baselinePolicyId !== options.capabilities.baselinePolicyId) {
				throw unsupported("live host target does not match the complete selected backend capabilities");
			}
		}
		if (!(options.key instanceof Uint8Array) || options.key.byteLength < 32) {
			throw invalid("enforcement HMAC key must contain at least 256 bits");
		}
		this.#key = Buffer.from(options.key);
		this.#options = Object.freeze({
			...options,
			capabilities: deepFreeze(structuredClone(options.capabilities)),
			baselineBindings: deepFreeze(structuredClone(options.baselineBindings)),
			key: this.#key,
		});
		assertNonEmpty(options.keyId, "keyId");
		if (options.preparedPlanTtlMs !== undefined &&
			(!Number.isSafeInteger(options.preparedPlanTtlMs) || options.preparedPlanTtlMs <= 0)) {
			throw invalid("preparedPlanTtlMs must be a positive safe integer");
		}
		for (const binding of options.baselineBindings) {
			validateBaseline(binding);
			const computed = computeHostBaselineBodyDigest(binding);
			if (binding.bodyDigest !== computed) {
				throw new SandboxPlanError("TFWS_BASELINE_MISMATCH", "trusted baseline bodyDigest does not match its canonical body");
			}
			const id = baselineKey(binding.policyId, binding.policyVersion);
			const prior = this.#baselineBindings.get(id);
			if (prior !== undefined && canonicalJson(prior) !== canonicalJson(binding)) {
				throw new SandboxPlanError(
					"TFWS_BASELINE_MISMATCH",
					`baseline ${id} is bound to more than one body digest`,
				);
			}
			this.#baselineBindings.set(id, deepFreeze(structuredClone(binding)));
		}
	}

	capabilities(): WorkspaceBackendCapabilities {
		return structuredClone(this.#options.capabilities);
	}

	async prepareSandbox(plan: SandboxPolicyPlan, owner: ExecutionOwner): Promise<PreparedSandboxPlan> {
		// Check the process-local resolver capability before cloning: structured
		// clone deliberately erases the WeakSet brand. Shape-correct handmade,
		// spread, and deserialized cwd objects are not authority.
		if (!isResolvedPathRef(plan.cwd)) {
			throw new SandboxPlanError("TFWS_INVALID_POLICY", "cwd was not issued by the workspace resolver");
		}
		// Snapshot before any asynchronous adapter call so caller mutation cannot alter
		// the policy which was validated/digested.
		const policySnapshot = freezePolicy(plan);
		const ownerSnapshot = freezeOwner(owner);
		validateOwner(ownerSnapshot);
		validatePolicyShape(policySnapshot, this.#now());
		validatePolicyOwnership(policySnapshot, ownerSnapshot);
		this.#validateBaseline(policySnapshot.baseline);
		const expectedDigest = computeSandboxPolicyDigest(policySnapshot, this.#options.capabilities);
		if (policySnapshot.policyDigest !== expectedDigest) {
			throw new SandboxPlanError(
				"TFWS_POLICY_DIGEST_MISMATCH",
				"portable policy digest does not match the concrete logical policy",
			);
		}
		this.#negotiate(policySnapshot);

		let evidence: ConcreteSandboxPreparation | ResolveOnlyPreparation;
		if (policySnapshot.mode === "sandboxed") {
			if (!this.#options.concreteAdapter) {
				throw unsupported("sandboxed mode requires concrete native preparation");
			}
			evidence = await this.#options.concreteAdapter.prepareConcreteSandbox(policySnapshot, ownerSnapshot);
			validateConcreteEvidence(evidence, policySnapshot, this.#now());
		} else {
			if (!this.#options.authorizeResolveOnly?.(ownerSnapshot, policySnapshot)) {
				throw new SandboxPlanError(
					"TFWS_RESOLVE_ONLY_NOT_AUTHORIZED",
					"resolve-only is a lower guarantee and requires explicit host authorization",
				);
			}
			if (!this.#options.resolveOnlyAdapter) {
				throw unsupported("resolve-only mode requires an explicit path-preparation adapter");
			}
			evidence = await this.#options.resolveOnlyAdapter.prepareResolveOnly(policySnapshot, ownerSnapshot);
			if (evidence.assurance !== "resolve-only-no-sandbox") {
				throw unsupported("resolve-only adapter returned an invalid assurance level");
			}
			assertNonEmpty(evidence.preparationId, "resolve-only preparationId");
		}

		const now = this.#now();
		const expiryCandidates = [
			now.getTime() + (this.#options.preparedPlanTtlMs ?? 30_000),
			parseTimestamp(policySnapshot.cwd.expiresAt, "cwd expiry"),
		];
		if (evidence.assurance === "native-sandbox-prepared") {
			for (const binding of evidence.credentialBindings) {
				expiryCandidates.push(parseTimestamp(binding.expiresAt, "credential binding expiry"));
			}
		}
		const expiryMs = Math.min(...expiryCandidates);
		if (expiryMs <= now.getTime()) throw unsupported("concrete preparation expires before it can be used");
		const expiresAt = new Date(expiryMs).toISOString();
		const prepared = Object.freeze({
			preparedPlanId: randomUUID(),
			backendId: this.#options.capabilities.backendId,
			backendCapabilityVersion: this.#options.capabilities.backendCapabilityVersion,
			owner: ownerSnapshot,
			policy: policySnapshot,
			expiresAt,
			assurance: evidence.assurance,
		}) as PreparedSandboxPlan;
		this.#prepared.set(prepared, structuredClone(evidence));
		return prepared;
	}

	sealSandbox(prepared: PreparedSandboxPlan, permits: readonly MutationPermit[]): SandboxPlan {
		const evidence = this.#prepared.get(prepared);
		if (!evidence) {
			throw new SandboxPlanError(
				"TFWS_FOREIGN_PREPARED_PLAN",
				"prepared plan was not produced by this factory",
			);
		}
		if (this.#preparedSealed.has(prepared)) {
			throw new SandboxPlanError("TFWS_PLAN_REPLAY", "prepared plan has already been sealed");
		}
		this.#assertNotExpired(prepared.expiresAt, "prepared sandbox plan");
		validatePermitCoverage(prepared, permits, this.#now());

		const permitCopies = permits.map(freezePermit);
		const enforcementDigest = this.#enforcementDigest(prepared, permitCopies, evidence);
		const sealed = Object.freeze({
			prepared,
			mutationPermits: Object.freeze(permitCopies),
			enforcementDigest,
		}) as SandboxPlan;
		this.#preparedSealed.add(prepared);
		this.#sealed.set(sealed, "sealed");
		return sealed;
	}

	/**
	 * Activate exactly once and keep permit activation/settlement around the actual
	 * execution callback.  Callers must put native spawn/open inside `execute`.
	 */
	async activateOnce<T>(
		plan: SandboxPlan,
		hooks: SandboxActivationHooks,
		execute: (activation: SandboxActivation) => Promise<T>,
	): Promise<T> {
		const state = this.#sealed.get(plan);
		if (state !== "sealed") {
			throw new SandboxPlanError("TFWS_PLAN_REPLAY", "sandbox plan is foreign, active, or already used");
		}
		this.#assertNotExpired(plan.prepared.expiresAt, "sandbox plan");
		this.#verifyEnforcementDigest(plan);
		if (plan.mutationPermits.length > 0 && !hooks.activateMutationPermits) {
			throw new SandboxPlanError(
				"TFWS_INVALID_MUTATION_PERMIT",
				"RW activation requires a journal permit activation hook",
			);
		}
		if (plan.mutationPermits.length > 0 && !hooks.settleMutationPermits) {
			throw new SandboxPlanError(
				"TFWS_INVALID_MUTATION_PERMIT",
				"RW activation requires a journal permit settlement hook",
			);
		}
		this.#sealed.set(plan, "activating");
		try {
			await hooks.activateMutationPermits?.(plan.mutationPermits, plan.prepared.owner);
		} catch (error) {
			this.#sealed.set(plan, "sealed");
			throw error;
		}
		this.#sealed.set(plan, "active");
		const activation = Object.freeze({
			plan,
			activatedAt: this.#now().toISOString(),
		}) as SandboxActivation;
		try {
			const result = await execute(activation);
			await hooks.settleMutationPermits?.(
				plan.mutationPermits,
				plan.prepared.owner,
				"completed",
			);
			return result;
		} catch (error) {
			await hooks.settleMutationPermits?.(
				plan.mutationPermits,
				plan.prepared.owner,
				"failed",
			).catch(() => undefined);
			throw error;
		} finally {
			this.#sealed.set(plan, "settled");
		}
	}

	#validateBaseline(baseline: HostBaselinePolicy): void {
		if (baseline.policyId !== this.#options.capabilities.baselinePolicyId) {
			throw new SandboxPlanError(
				"TFWS_BASELINE_MISMATCH",
				"plan baseline does not match backend baselinePolicyId",
			);
		}
		const expected = this.#baselineBindings.get(baselineKey(baseline.policyId, baseline.policyVersion));
		const computed = computeHostBaselineBodyDigest(baseline);
		if (baseline.bodyDigest !== computed || expected === undefined || canonicalJson(expected) !== canonicalJson(baseline)) {
			throw new SandboxPlanError(
				"TFWS_BASELINE_MISMATCH",
				"baseline policy/version/body digest is not registered immutably",
			);
		}
	}

	#negotiate(plan: SandboxPolicyPlan): void {
		const capabilities = this.#options.capabilities;
		const selectedMode = capabilities[this.#options.executionTarget];
		const features = capabilities.sandboxFeatures;
		if (selectedMode === "native-multi-root") {
			throw unsupported("native multi-root requires per-grant resolver capabilities and is not implemented");
		}
		if (plan.mode === "sandboxed" && selectedMode === "resolve-only") {
			throw unsupported(`${this.#options.executionTarget} backend is resolve-only`);
		}
		if (plan.mode === "resolve-only" && selectedMode !== "resolve-only") {
			throw unsupported("resolve-only must be advertised explicitly; it is not a sandbox fallback");
		}
		if (plan.grants.length > features.maxGrants) throw unsupported("grant count exceeds backend limit");
		if (selectedMode === "native-single-root" || selectedMode === "resolve-only") {
			if (plan.grants.length !== 1) throw unsupported("single-root execution requires exactly one grant");
		}
		for (const grant of plan.grants) {
			if (!features.scopeKinds.includes(grant.scopeKind)) {
				throw unsupported(`scope kind ${grant.scopeKind} is not representable`);
			}
			if (grant.access === "read-write" && !features.perGrantAccess) {
				throw unsupported("backend cannot enforce requested per-grant read-write access");
			}
			if (grant.access === "read-only" && !features.perGrantAccess) {
				throw unsupported("backend cannot enforce requested per-grant read-only access");
			}
		}
		if (plan.mode === "sandboxed") {
			if (!features.denyAmbientUserData) throw unsupported("ambient user-data denial is unavailable");
			if (!features.exactBaselineMounts) throw unsupported("exact baseline mounts are unavailable");
			if (!features.privateTempPerExecution) throw unsupported("private per-execution temp is unavailable");
			if (!features.descendantEnforcement) throw unsupported("descendant/tool enforcement is unavailable");
			if (!features.raceFreeFileBroker) throw unsupported("race-free file-broker enforcement is unavailable");
			if (!capabilities.brokeredRead || !capabilities.brokeredWrite) {
				throw unsupported("complete brokered read/write enforcement is unavailable");
			}
		}
		const network = plan.baseline.network ?? "host-policy";
		if (!features.networkModes.includes(network)) throw unsupported(`network mode ${network} is unavailable`);
		for (const credential of plan.credentialRequirements) {
			if (!features.credentialModes.includes(credential.delivery.mode)) {
				throw unsupported(`credential mode ${credential.delivery.mode} is unavailable`);
			}
			if (plan.baseline.credentialDelivery.mode === "unavailable" ||
				plan.baseline.credentialDelivery.mode !== credential.delivery.mode) {
				throw unsupported("credential requirement is not provided by the selected baseline");
			}
			if (plan.baseline.credentialDelivery.mode === "opaque-broker" &&
				credential.ttlMs > plan.baseline.credentialDelivery.maxTtlMs) {
				throw unsupported("credential TTL exceeds the host baseline broker limit");
			}
		}
	}

	#enforcementDigest(
		prepared: PreparedSandboxPlan,
		permits: readonly MutationPermit[],
		evidence: ConcreteSandboxPreparation | ResolveOnlyPreparation,
	): string {
		const payload = enforcementPayload(prepared, permits, evidence);
		const mac = createHmac("sha256", this.#key).update(canonicalJson(payload), "utf8").digest("hex");
		return `${ENFORCEMENT_PREFIX}${this.#options.keyId}:${mac}`;
	}

	#verifyEnforcementDigest(plan: SandboxPlan): void {
		const evidence = this.#prepared.get(plan.prepared);
		if (!evidence) throw new SandboxPlanError("TFWS_FOREIGN_PREPARED_PLAN", "unknown prepared plan");
		const expected = this.#enforcementDigest(plan.prepared, plan.mutationPermits, evidence);
		const actualBytes = Buffer.from(plan.enforcementDigest, "utf8");
		const expectedBytes = Buffer.from(expected, "utf8");
		if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
			throw new SandboxPlanError(
				"TFWS_ENFORCEMENT_DIGEST_MISMATCH",
				"sealed physical plan authentication failed",
			);
		}
	}

	#assertNotExpired(expiresAt: string, kind: string): void {
		const expiry = parseTimestamp(expiresAt, `${kind} expiry`);
		if (expiry <= this.#now().getTime()) {
			throw new SandboxPlanError("TFWS_PREPARED_PLAN_EXPIRED", `${kind} has expired`);
		}
	}

	#now(): Date {
		return this.#options.now?.() ?? new Date();
	}
}

function enforcementPayload(
	prepared: PreparedSandboxPlan,
	permits: readonly MutationPermit[],
	evidence: ConcreteSandboxPreparation | ResolveOnlyPreparation,
): unknown {
	return {
		schema: ENFORCEMENT_TAG,
		policyDigest: prepared.policy.policyDigest,
		preparedPlanId: prepared.preparedPlanId,
		expiresAt: prepared.expiresAt,
		owner: prepared.owner,
		assurance: prepared.assurance,
		preparationId: evidence.preparationId,
		physicalMappings: prepared.policy.grants.map((grant) => ({
			bindingId: grant.bindingId,
			resourceDomainId: grant.resourceDomainId,
			providerInstanceId: grant.providerInstanceId,
			logicalWorkspaceId: grant.logicalWorkspaceId,
			logicalPrefix: grant.logicalPrefix,
			physicalScopeRoot: grant.physicalScopeRoot,
			scopeKind: grant.scopeKind,
			access: grant.access,
		})).sort(compareCanonical),
		cwdPhysicalPath: prepared.policy.cwd.physicalPath,
		baselineMounts: evidence.assurance === "native-sandbox-prepared"
			? evidence.baselineMounts.map(projectBaselineMount).sort(compareCanonical)
			: [],
		credentialBrokerBindings: evidence.assurance === "native-sandbox-prepared"
			? evidence.credentialBindings.map(projectCredentialBinding).sort(compareCanonical)
			: [],
		mutationPermits: permits.map((permit) => ({
			permitId: permit.permitId,
			intentId: permit.intentId,
			journalEpoch: permit.journalEpoch,
			nonce: permit.nonce,
			owner: permit.owner,
			expiresAt: permit.expiresAt,
			scopes: permit.scopes.map((scope) => ({ ...scope })).sort(compareCanonical),
		})).sort(compareCanonical),
	};
}

function validatePolicyShape(plan: SandboxPolicyPlan, now: Date): void {
	assertExactKeys(plan, ["mode", "cwd", "grants", "baseline", "credentialRequirements", "policyDigest"], "policy");
	if (plan.mode !== "sandboxed" && plan.mode !== "resolve-only") throw invalid("invalid plan mode");
	if (!Array.isArray(plan.grants) || !Array.isArray(plan.credentialRequirements)) {
		throw invalid("grants and credentialRequirements must be arrays");
	}
	validateBaseline(plan.baseline);
	validateResolvedCwd(plan, now);
	for (const grant of plan.grants) validateGrant(grant);
	for (const credential of plan.credentialRequirements) validateCredential(credential);
	assertDigest(plan.policyDigest, "policyDigest", POLICY_PREFIX);

	const cwdGrant = plan.grants.find((grant) =>
		grant.bindingId === plan.cwd.capability.bindingId &&
		grant.resourceDomainId === plan.cwd.capability.resourceDomainId &&
		grant.providerInstanceId === plan.cwd.capability.providerInstanceId &&
		grant.logicalWorkspaceId === plan.cwd.capability.logicalWorkspaceId &&
		grant.logicalPrefix === plan.cwd.capability.logicalPrefix,
	);
	if (!cwdGrant || cwdGrant.scopeKind !== "directory") throw invalid("cwd is not represented by a directory grant");
	if (!accessCovers(cwdGrant.access, plan.cwd.capability.access)) throw invalid("cwd access exceeds its grant");
	if (cwdGrant.physicalScopeRoot !== plan.cwd.capability.physicalScopeRoot) {
		throw invalid("cwd capability scope does not equal its concrete grant scope");
	}
	if (!lifetimeCovers(cwdGrant.lifetime, plan.cwd.capability.lifetime)) {
		throw invalid("cwd capability lifetime exceeds its concrete grant lifetime");
	}
	if (!physicalContains(cwdGrant.physicalScopeRoot, plan.cwd.physicalPath)) {
		throw invalid("cwd physical path escapes its concrete scope");
	}
}

function lifetimeCovers(parent: BoundCapabilityLifetime, child: BoundCapabilityLifetime): boolean {
	if (parent.scope === "external") {
		if (child.scope !== "external") return true;
		return parent.bindingId === child.bindingId &&
			parent.providerInstanceId === child.providerInstanceId;
	}
	if (parent.scope === "run") {
		return (child.scope === "run" && child.runId === parent.runId) ||
			(child.scope === "phase" && child.runId === parent.runId);
	}
	return child.scope === "phase" && canonicalJson(parent) === canonicalJson(child);
}

function validatePolicyOwnership(plan: SandboxPolicyPlan, owner: ExecutionOwner): void {
	for (const lifetime of [plan.cwd.capability.lifetime, ...plan.grants.map((grant) => grant.lifetime)]) {
		if (lifetime.scope === "phase" &&
			(lifetime.runId !== owner.runId || lifetime.phaseId !== owner.phaseId || lifetime.attemptId !== owner.attemptId)) {
			throw invalid("phase-scoped capability does not belong to the execution owner");
		}
		if (lifetime.scope === "run" && lifetime.runId !== owner.runId) {
			throw invalid("run-scoped capability does not belong to the execution owner");
		}
	}
}

function validateResolvedCwd(plan: SandboxPolicyPlan, now: Date): void {
	const cwd = plan.cwd;
	assertExactKeys(cwd, ["resolutionTokenId", "expiresAt", "capability", "logicalSubpath", "physicalPath", "intent"], "cwd");
	assertNonEmpty(cwd.resolutionTokenId, "cwd resolutionTokenId");
	parseTimestamp(cwd.expiresAt, "cwd expiry");
	if (parseTimestamp(cwd.expiresAt, "cwd expiry") <= now.getTime()) throw invalid("cwd resolution has expired");
	if (cwd.intent !== "existing-directory") throw invalid("cwd intent must be existing-directory");
	assertPhysicalPath(cwd.physicalPath, "cwd physicalPath");
	validateCapability(cwd.capability);
}

function validateCapability(capability: SandboxPolicyPlan["cwd"]["capability"]): void {
	assertExactKeys(capability, [
		"bindingId", "resourceDomainId", "providerInstanceId", "logicalWorkspaceId",
		"logicalPrefix", "physicalScopeRoot", "access", "version", "lifetime",
	], "cwd capability");
	for (const [name, value] of Object.entries({
		bindingId: capability.bindingId,
		resourceDomainId: capability.resourceDomainId,
		providerInstanceId: capability.providerInstanceId,
		logicalWorkspaceId: capability.logicalWorkspaceId,
	})) assertNonEmpty(value, `cwd capability ${name}`);
	validateLogicalPrefix(capability.logicalPrefix);
	assertPhysicalPath(capability.physicalScopeRoot, "cwd capability physicalScopeRoot");
	validateAccess(capability.access);
	assertExactKeys(capability.version, ["identityMode", "contentId", "scopeDigest", "generation", "state"], "resource version");
	if (!Number.isSafeInteger(capability.version.generation) || capability.version.generation < 0) {
		throw invalid("resource version generation must be a non-negative safe integer");
	}
	validateLifetime(capability.lifetime);
}

function validateGrant(grant: SandboxGrant): void {
	assertExactKeys(grant, [
		"bindingId", "resourceDomainId", "providerInstanceId", "logicalWorkspaceId",
		"logicalPrefix", "physicalScopeRoot", "scopeKind", "access", "lifetime",
	], "grant");
	for (const [name, value] of Object.entries({
		bindingId: grant.bindingId,
		resourceDomainId: grant.resourceDomainId,
		providerInstanceId: grant.providerInstanceId,
		logicalWorkspaceId: grant.logicalWorkspaceId,
	})) assertNonEmpty(value, `grant ${name}`);
	validateLogicalPrefix(grant.logicalPrefix);
	assertPhysicalPath(grant.physicalScopeRoot, "grant physicalScopeRoot");
	if (grant.scopeKind !== "file" && grant.scopeKind !== "directory") throw invalid("invalid grant scopeKind");
	validateAccess(grant.access);
	validateLifetime(grant.lifetime);
}

function validateBaseline(baseline: HostBaselinePolicy): void {
	assertExactKeys(baseline, [
		"schemaVersion", "policyId", "policyVersion", "bodyDigest", "readableSystemClasses",
		"providerMetadata", "credentialDelivery", "temp", "network",
	], "baseline");
	if (baseline.schemaVersion !== 1) throw invalid("baseline schemaVersion must be 1");
	assertNonEmpty(baseline.policyId, "baseline policyId");
	assertNonEmpty(baseline.policyVersion, "baseline policyVersion");
	assertDigest(baseline.bodyDigest, "baseline bodyDigest");
	if (!Array.isArray(baseline.readableSystemClasses) || !Array.isArray(baseline.providerMetadata)) {
		throw invalid("baseline classes and metadata must be arrays");
	}
	if (baseline.temp?.mode !== "private-per-execution" || baseline.temp.access !== "read-write") {
		throw invalid("baseline temp must be private-per-execution read-write");
	}
	if (baseline.network !== undefined && baseline.network !== "host-policy" && baseline.network !== "none") {
		throw invalid("invalid baseline network mode");
	}
	for (const metadata of baseline.providerMetadata) {
		assertExactKeys(metadata, ["metadataId", "kind", "contentDigest", "secretScanPolicyId"], "provider metadata");
		assertNonEmpty(metadata.metadataId, "provider metadataId");
		if (metadata.kind !== "exact-file") throw invalid("provider metadata must be exact-file");
		assertDigest(metadata.contentDigest, "provider metadata contentDigest");
		assertNonEmpty(metadata.secretScanPolicyId, "provider metadata secretScanPolicyId");
	}
	const delivery = baseline.credentialDelivery;
	if (delivery.mode === "opaque-broker") {
		assertExactKeys(delivery, ["mode", "brokerId", "maxTtlMs"], "credential delivery");
		assertNonEmpty(delivery.brokerId, "credential brokerId");
		if (!Number.isSafeInteger(delivery.maxTtlMs) || delivery.maxTtlMs <= 0) throw invalid("invalid broker maxTtlMs");
	} else if (delivery.mode === "isolated-host-process") {
		assertExactKeys(delivery, ["mode", "scrubToolEnvironment", "denyProcessInspection"], "credential delivery");
		if (delivery.scrubToolEnvironment !== true || delivery.denyProcessInspection !== true) {
			throw invalid("isolated host credential delivery requires both isolation controls");
		}
	} else if (delivery.mode !== "unavailable") {
		throw invalid("invalid credential delivery mode");
	} else {
		assertExactKeys(delivery, ["mode"], "credential delivery");
	}
	assertExactKeys(baseline.temp, ["mode", "access"], "baseline temp");
}

function validateCredential(requirement: BoundCredentialRequirement): void {
	assertExactKeys(requirement, [
		"credentialGrantId", "credentialId", "audience", "purpose", "ttlMs", "delivery",
	], "credential requirement");
	assertNonEmpty(requirement.credentialGrantId, "credentialGrantId");
	assertNonEmpty(requirement.credentialId, "credentialId");
	assertNonEmpty(requirement.audience, "credential audience");
	assertNonEmpty(requirement.purpose, "credential purpose");
	if (!Number.isSafeInteger(requirement.ttlMs) || requirement.ttlMs <= 0) throw invalid("invalid credential ttlMs");
	if (requirement.delivery.mode === "opaque-broker") {
		assertExactKeys(requirement.delivery, ["mode", "brokerId", "maxTtlMs"], "bound credential delivery");
		assertNonEmpty(requirement.delivery.brokerId, "credential brokerId");
		if (requirement.ttlMs > requirement.delivery.maxTtlMs) throw invalid("credential ttl exceeds delivery maximum");
	} else if (requirement.delivery.mode !== "isolated-host-process") {
		throw invalid("bound credential cannot use unavailable delivery");
	} else {
		assertExactKeys(requirement.delivery, ["mode", "scrubToolEnvironment", "denyProcessInspection"], "bound credential delivery");
	}
}

function validateConcreteEvidence(
	evidence: ConcreteSandboxPreparation,
	plan: SandboxPolicyPlan,
	now: Date,
): void {
	if (evidence.assurance !== "native-sandbox-prepared") {
		throw unsupported("native adapter did not attest concrete preparation");
	}
	assertNonEmpty(evidence.preparationId, "native preparationId");
	if (!Array.isArray(evidence.baselineMounts) || !Array.isArray(evidence.credentialBindings)) {
		throw unsupported("native preparation omitted concrete baseline or credential evidence");
	}
	const expectedMountIds = new Set([
		...plan.baseline.readableSystemClasses.map((kind) => `system:${kind}`),
		...plan.baseline.providerMetadata.map((metadata) => `provider:${metadata.metadataId}`),
		"temp:execution",
	]);
	const observedMountIds = new Set<string>();
	for (const mount of evidence.baselineMounts) {
		assertNonEmpty(mount.mountId, "baseline mountId");
		assertPhysicalPath(mount.physicalPath, "baseline mount physicalPath");
		validateAccess(mount.access);
		if (observedMountIds.has(mount.mountId)) throw unsupported("duplicate concrete baseline mount");
		observedMountIds.add(mount.mountId);
	}
	if (expectedMountIds.size !== observedMountIds.size || [...expectedMountIds].some((id) => !observedMountIds.has(id))) {
		throw unsupported("native preparation did not bind the exact baseline mount set");
	}
	const requiredIds = new Set(plan.credentialRequirements.map((item) => item.credentialGrantId));
	const observedIds = new Set<string>();
	for (const binding of evidence.credentialBindings) {
		assertNonEmpty(binding.credentialGrantId, "credential binding grantId");
		assertNonEmpty(binding.brokerGrantId, "credential broker grantId");
		const expiry = parseTimestamp(binding.expiresAt, "credential binding expiry");
		const requirement = plan.credentialRequirements.find((item) =>
			item.credentialGrantId === binding.credentialGrantId,
		);
		if (!requirement || expiry < now.getTime() + requirement.ttlMs) {
			throw unsupported("credential broker binding does not satisfy the requested TTL");
		}
		if (observedIds.has(binding.credentialGrantId)) throw unsupported("duplicate credential broker binding");
		observedIds.add(binding.credentialGrantId);
	}
	if (requiredIds.size !== observedIds.size || [...requiredIds].some((id) => !observedIds.has(id))) {
		throw unsupported("native preparation did not bind every credential requirement exactly once");
	}
}

function validatePermitCoverage(
	prepared: PreparedSandboxPlan,
	permits: readonly MutationPermit[],
	now: Date,
): void {
	const writable = prepared.policy.grants.filter((grant) => grant.access === "read-write");
	if (writable.length > 0 && permits.length === 0) {
		throw new SandboxPlanError("TFWS_MISSING_MUTATION_PERMIT", "RW policy has no mutation permit");
	}
	const permitIds = new Set<string>();
	for (const permit of permits) {
		validatePermit(permit, prepared.owner, now);
		if (permitIds.has(permit.permitId)) throw invalidPermit("duplicate permit ID");
		permitIds.add(permit.permitId);
		if (!writable.some((grant) => permit.scopes.some((scope) => scopeCovers(scope, grant)))) {
			throw invalidPermit(`permit ${permit.permitId} does not cover a writable grant`);
		}
	}
	for (const grant of writable) {
		if (!permits.some((permit) => permit.scopes.some((scope) => scopeCovers(scope, grant)))) {
			throw new SandboxPlanError(
				"TFWS_MISSING_MUTATION_PERMIT",
				`no permit covers ${grant.resourceDomainId}:${grant.logicalPrefix}`,
			);
		}
	}
}

function validatePermit(permit: MutationPermit, owner: ExecutionOwner, now: Date): void {
	if (!isIssuedMutationPermit(permit)) throw invalidPermit("permit was not issued by the mutation permit registry");
	assertNonEmptyPermit(permit.permitId, "permitId");
	assertNonEmptyPermit(permit.intentId, "intentId");
	assertNonEmptyPermit(permit.nonce, "nonce");
	if (!Number.isSafeInteger(permit.journalEpoch) || permit.journalEpoch < 0) throw invalidPermit("invalid journalEpoch");
	validateOwner(permit.owner);
	if (!ownersEqual(permit.owner, owner)) throw invalidPermit("permit owner does not match execution owner");
	const issuedAt = parsePermitTimestamp(permit.issuedAt, "permit issuedAt");
	const expiresAt = parsePermitTimestamp(permit.expiresAt, "permit expiresAt");
	if (issuedAt > now.getTime() || expiresAt <= now.getTime() || expiresAt <= issuedAt) {
		throw invalidPermit("permit lifetime is invalid or expired");
	}
	if (!Array.isArray(permit.scopes) || permit.scopes.length === 0) throw invalidPermit("permit has no scopes");
	for (const scope of permit.scopes) {
		assertNonEmptyPermit(scope.resourceDomainId, "permit scope resourceDomainId");
		try {
			assertPhysicalPath(scope.canonicalPrefix, "permit canonicalPrefix");
		} catch {
			throw invalidPermit("permit canonicalPrefix is invalid");
		}
	}
}

function projectGrant(grant: SandboxGrant) {
	return {
		resourceDomainId: grant.resourceDomainId,
		logicalWorkspaceId: grant.logicalWorkspaceId,
		logicalPrefix: grant.logicalPrefix,
		scopeKind: grant.scopeKind,
		access: grant.access,
		lifetime: grant.lifetime,
	};
}

function projectCredential(requirement: BoundCredentialRequirement) {
	return {
		credentialGrantId: requirement.credentialGrantId,
		credentialId: requirement.credentialId,
		audience: requirement.audience,
		purpose: requirement.purpose,
		ttlMs: requirement.ttlMs,
		delivery: requirement.delivery,
	};
}

function projectBaselineMount(mount: PhysicalBaselineMount) {
	return { mountId: mount.mountId, physicalPath: mount.physicalPath, access: mount.access };
}

function projectCredentialBinding(binding: CredentialBrokerBinding) {
	return {
		credentialGrantId: binding.credentialGrantId,
		brokerGrantId: binding.brokerGrantId,
		expiresAt: binding.expiresAt,
	};
}

function compareCanonical(left: unknown, right: unknown): number {
	const a = canonicalJson(left);
	const b = canonicalJson(right);
	return a < b ? -1 : a > b ? 1 : 0;
}

function compareProjectedGrants(left: ReturnType<typeof projectGrant>, right: ReturnType<typeof projectGrant>): number {
	return compareStringTuple(
		[left.resourceDomainId, left.logicalWorkspaceId, left.logicalPrefix, left.scopeKind, left.access],
		[right.resourceDomainId, right.logicalWorkspaceId, right.logicalPrefix, right.scopeKind, right.access],
	) || compareCanonical(left, right);
}

function compareProjectedCredentials(
	left: ReturnType<typeof projectCredential>,
	right: ReturnType<typeof projectCredential>,
): number {
	return compareStringTuple(
		[left.credentialGrantId, left.audience, left.purpose],
		[right.credentialGrantId, right.audience, right.purpose],
	) || compareCanonical(left, right);
}

function compareStringTuple(left: readonly string[], right: readonly string[]): number {
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const a = left[index] ?? "";
		const b = right[index] ?? "";
		if (a < b) return -1;
		if (a > b) return 1;
	}
	return 0;
}

function validateLifetime(lifetime: BoundCapabilityLifetime): void {
	if (lifetime.scope === "phase") {
		assertExactKeys(lifetime, ["scope", "runId", "phaseId", "attemptId"], "phase lifetime");
		assertNonEmpty(lifetime.runId, "lifetime runId");
		assertNonEmpty(lifetime.phaseId, "lifetime phaseId");
		assertNonEmpty(lifetime.attemptId, "lifetime attemptId");
	} else if (lifetime.scope === "run") {
		assertExactKeys(lifetime, ["scope", "runId"], "run lifetime");
		assertNonEmpty(lifetime.runId, "lifetime runId");
	} else if (lifetime.scope === "external") {
		assertExactKeys(lifetime, ["scope", "bindingId", "providerInstanceId"], "external lifetime");
		assertNonEmpty(lifetime.bindingId, "lifetime bindingId");
	} else {
		throw invalid("invalid capability lifetime");
	}
}

function validateAccess(access: "read-only" | "read-write"): void {
	if (access !== "read-only" && access !== "read-write") throw invalid("invalid workspace access");
}

function validateOwner(owner: ExecutionOwner): void {
	for (const [name, value] of Object.entries({
		runId: owner.runId,
		phaseId: owner.phaseId,
		attemptId: owner.attemptId,
		unitId: owner.unitId,
	})) assertNonEmpty(value, `owner ${name}`);
	if (!Array.isArray(owner.ancestry) || owner.ancestry.some((item) => typeof item !== "string" || item.length === 0)) {
		throw invalid("owner ancestry must be non-empty strings");
	}
}

function validateLogicalPrefix(prefix: string): void {
	if (typeof prefix !== "string" || prefix.includes("\\") || prefix.includes("\0") || prefix.startsWith("/")) {
		throw invalid("logical prefix must be a portable relative path");
	}
	if (prefix === "") return;
	const segments = prefix.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw invalid("logical prefix contains an invalid segment");
	}
}

function validateCapabilities(capabilities: WorkspaceBackendCapabilities): void {
	assertCapabilities(capabilities);
}

function assertCapabilities(capabilities: WorkspaceBackendCapabilities): void {
	if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
		throw invalid("backend capabilities must be an object");
	}
	assertExactKeys(capabilities, [
		"schemaVersion",
		"backendId",
		"backendCapabilityVersion",
		"agent",
		"script",
		"sandboxFeatures",
		"brokeredRead",
		"brokeredWrite",
		"versionCommitModes",
		"restoreStrategies",
		"baselinePolicyId",
	], "backend capabilities");
	if (capabilities.schemaVersion !== 1) throw invalid("backend capability schemaVersion must be 1");
	assertNonEmpty(capabilities.backendId, "backendId");
	assertNonEmpty(capabilities.backendCapabilityVersion, "backendCapabilityVersion");
	assertNonEmpty(capabilities.baselinePolicyId, "baselinePolicyId");
	const executionModes = ["native-single-root", "native-multi-root", "resolve-only"] as const;
	if (!executionModes.includes(capabilities.agent)) throw invalid("backend agent mode is invalid");
	if (!executionModes.includes(capabilities.script)) throw invalid("backend script mode is invalid");
	if (!capabilities.sandboxFeatures || typeof capabilities.sandboxFeatures !== "object" || Array.isArray(capabilities.sandboxFeatures)) {
		throw invalid("sandboxFeatures must be an object");
	}
	const features = capabilities.sandboxFeatures;
	assertExactKeys(features, [
		"maxGrants",
		"scopeKinds",
		"perGrantAccess",
		"denyAmbientUserData",
		"exactBaselineMounts",
		"privateTempPerExecution",
		"descendantEnforcement",
		"raceFreeFileBroker",
		"networkModes",
		"credentialModes",
	], "sandboxFeatures");
	if (!Number.isSafeInteger(features.maxGrants) || features.maxGrants < 1) {
		throw invalid("sandbox maxGrants must be a positive safe integer");
	}
	for (const field of [
		"perGrantAccess",
		"denyAmbientUserData",
		"exactBaselineMounts",
		"privateTempPerExecution",
		"descendantEnforcement",
		"raceFreeFileBroker",
	] as const) {
		if (typeof features[field] !== "boolean") throw invalid(`sandboxFeatures.${field} must be boolean`);
	}
	if (typeof capabilities.brokeredRead !== "boolean" || typeof capabilities.brokeredWrite !== "boolean") {
		throw invalid("brokeredRead and brokeredWrite must be boolean");
	}
	assertEnumArray(features.scopeKinds, ["file", "directory"], "sandboxFeatures.scopeKinds", true);
	assertEnumArray(features.networkModes, ["host-policy", "none"], "sandboxFeatures.networkModes", true);
	assertEnumArray(
		features.credentialModes,
		["opaque-broker", "isolated-host-process"],
		"sandboxFeatures.credentialModes",
		false,
	);
	assertEnumArray(
		capabilities.versionCommitModes,
		["content-snapshot", "generation-only", "unavailable"],
		"versionCommitModes",
		true,
	);
	assertEnumArray(capabilities.restoreStrategies, ["replace-scope", "provider-native"], "restoreStrategies", false);
	const advertisesNative = capabilities.agent !== "resolve-only" || capabilities.script !== "resolve-only";
	if (advertisesNative && (!features.raceFreeFileBroker || !capabilities.brokeredRead || !capabilities.brokeredWrite)) {
		throw invalid("native execution requires a race-free broker with brokered read and write");
	}
	if (advertisesNative && capabilities.versionCommitModes.every((mode) => mode === "unavailable")) {
		throw invalid("native execution requires an enforceable version commit mode");
	}
}

function assertEnumArray<T extends string>(
	value: readonly T[],
	allowed: readonly T[],
	name: string,
	requireNonEmpty: boolean,
): void {
	if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)) {
		throw invalid(`${name} must be ${requireNonEmpty ? "a non-empty" : "an"} array`);
	}
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string" || !allowed.includes(item as T)) throw invalid(`${name} contains an invalid value`);
		if (seen.has(item)) throw invalid(`${name} contains a duplicate value`);
		seen.add(item);
	}
}

function freezePolicy(plan: SandboxPolicyPlan): SandboxPolicyPlan {
	return deepFreeze(structuredClone(plan));
}

function freezeOwner(owner: ExecutionOwner): ExecutionOwner {
	return deepFreeze(structuredClone(owner));
}

function freezePermit(permit: MutationPermit): MutationPermit {
	// MutationPermitRegistry already returns a deeply frozen, WeakSet-branded
	// capability. Cloning it would erase that live brand and make the sealed
	// plan impossible to activate against the durable registry. Retain the exact
	// issued object after seal-time validation; reconstructed objects never reach
	// this point because validatePermit() rejects them first.
	return permit;
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const item of Object.values(value)) deepFreeze(item);
		Object.freeze(value);
	}
	return value;
}

function accessCovers(outer: "read-only" | "read-write", inner: "read-only" | "read-write"): boolean {
	return outer === "read-write" || inner === "read-only";
}

function physicalContains(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function scopeCovers(scope: MutationPermit["scopes"][number], grant: SandboxGrant): boolean {
	if (scope.resourceDomainId !== grant.resourceDomainId) return false;
	return physicalContains(scope.canonicalPrefix, grant.physicalScopeRoot);
}

function ownersEqual(left: ExecutionOwner, right: ExecutionOwner): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

function assertPhysicalPath(value: string, name: string): void {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) {
		throw invalid(`${name} must be a non-empty absolute path`);
	}
}

function assertDigest(value: string, name: string, prefix = ""): void {
	const suffix = prefix === "" ? value : value.slice(prefix.length);
	if ((prefix && !value.startsWith(prefix)) || !/^[a-f0-9]{64}$/.test(suffix)) {
		throw invalid(`${name} must be ${prefix || ""}64 lowercase SHA-256 hex characters`);
	}
}

function assertNonEmpty(value: string, name: string): void {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw invalid(`${name} is invalid`);
}

function assertExactKeys(value: object, allowed: readonly string[], name: string): void {
	const allowedKeys = new Set(allowed);
	const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
	if (unexpected.length > 0) throw invalid(`${name} has unsigned or unsupported fields: ${unexpected.join(", ")}`);
}

function assertNonEmptyPermit(value: string, name: string): void {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw invalidPermit(`${name} is invalid`);
}

function parseTimestamp(value: string, name: string): number {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw invalid(`${name} must be an ISO timestamp`);
	return parsed;
}

function parsePermitTimestamp(value: string, name: string): number {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw invalidPermit(`${name} must be an ISO timestamp`);
	return parsed;
}

function baselineKey(policyId: string, version: string): string {
	return `${policyId}\0${version}`;
}

function invalid(message: string): SandboxPlanError {
	return new SandboxPlanError("TFWS_INVALID_POLICY", message);
}

function invalidPermit(message: string): SandboxPlanError {
	return new SandboxPlanError("TFWS_INVALID_MUTATION_PERMIT", message);
}

function unsupported(message: string): SandboxPlanError {
	return new SandboxPlanError("TFWS_UNSUPPORTED_SANDBOX_POLICY", message);
}

// Kept as a named export seam for conformance tools without implying that a
// capability advertisement proves enforcement.
export const validateWorkspaceBackendCapabilities = validateCapabilities;
