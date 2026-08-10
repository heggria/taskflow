/**
 * Resolve-only execution coordinator and partial W1a control-plane scaffold
 * for the 0.2.1 cwd bridge.
 *
 * This is deliberately named for its guarantee: it provides principal/root
 * authorization, canonical resolution, cross-process leases, durable write
 * intents, one-shot mutation permits, and authenticated plans, but it does not
 * claim an OS filesystem sandbox, a race-free FileBroker, or atomic protection
 * against external path replacement. A future native backend can implement the
 * same runtime seam only after an exact host-support baseline cell passes.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../agents.ts";
import type { RunOptions, RunResult } from "../host/runner-types.ts";
import { emptyUsage } from "../usage.ts";
import { createHostInvocationAuthority, type InvocationAuthority } from "./authority.ts";
import type { HostBaselinePolicy, SandboxPolicyPlan, WorkspaceBackendCapabilities } from "./backend.ts";
import {
	WriteIntentJournal,
	type PreparedMutation,
	type ReconciliationResult,
} from "./journal.ts";
import { PersistentLeaseCoordinator, type LeaseHandle } from "./leases.ts";
import { createHostRootGrant, createRootRegistry, type RootGrant, type RootRegistry } from "./registry.ts";
import { resolvePathRef, type ResolvedPathRef } from "./resolve.ts";
import { computeHostBaselineBodyDigest, createSandboxPolicyPlan, SandboxPolicyFactory } from "./sandbox.ts";
import type { ScopedCapability } from "./schema.ts";
import { sameExecutionOwner, type ExecutionOwner } from "./types.ts";

export interface CoordinatedScriptResult {
	stdout: string;
	stderr: string;
	code: number | null;
	stdoutOversize: boolean;
	timedOut: boolean;
}

export interface ResolveOnlyWorkspaceSessionOptions {
	invocationRoot: string;
	/** Trusted control-plane storage, never exposed as a flow workspace. */
	controlDirectory?: string;
	principalId?: string;
	grantId?: string;
	registryId?: string;
	leaseTimeoutMs?: number;
	permitTtlMs?: number;
	signal?: AbortSignal;
	/** Trusted host decision. Flow/tool arguments cannot enable reconciliation. */
	allowReconcile?: boolean;
}

export interface BindResolveOnlyPhaseInput {
	invocationRoot: string;
	runId: string;
	phaseId: string;
	argName?: string;
	argDefinitions: Readonly<Record<string, unknown>>;
	argValues: Readonly<Record<string, unknown>>;
}

export interface ResolveOnlyAgentCall {
	agents: AgentConfig[];
	agentName: string;
	task: string;
	opts: RunOptions;
	globalThinking?: string;
	unitId?: string;
	invoke: () => Promise<RunResult>;
}

export interface ResolveOnlyScriptCall {
	unitId?: string;
	signal?: AbortSignal;
	invoke: () => Promise<CoordinatedScriptResult>;
}

export interface ResolveOnlyPhaseBinding {
	readonly assurance: "resolve-only-no-sandbox";
	readonly absolutePath: string;
	readonly logicalPath: string;
	readonly resourceDomainId: string;
	readonly runId: string;
	readonly phaseId: string;
	runAgent(call: ResolveOnlyAgentCall): Promise<RunResult>;
	runScript(call: ResolveOnlyScriptCall): Promise<CoordinatedScriptResult>;
}

export const WORKSPACE_RECONCILE_ACKNOWLEDGEMENT = "I acknowledge the current workspace state";
export const WORKSPACE_RECONCILE_MODE_ENV = "TASKFLOW_WORKSPACE_RECONCILE_MODE";

export function workspaceReconcileAllowedFromEnv(
	value: string | undefined = process.env[WORKSPACE_RECONCILE_MODE_ENV],
): boolean {
	return value === "explicit";
}

export interface ReconcileResolveOnlyWorkspaceInput {
	/** Exact deliberate acknowledgement. Reconciliation accepts the current
	 * external filesystem state; it does not restore or inspect lost writes. */
	acknowledgement: string;
	reason?: string;
	signal?: AbortSignal;
}

export interface ResolveOnlyWorkspaceSession {
	readonly assurance: "resolve-only-no-sandbox";
	readonly invocationRoot: string;
	readonly registry: RootRegistry;
	readonly authority: InvocationAuthority;
	bindPhase(input: BindResolveOnlyPhaseInput): Promise<ResolveOnlyPhaseBinding>;
	reconcile(input: ReconcileResolveOnlyWorkspaceInput): Promise<ReconciliationResult>;
}

const BASELINE_BODY: Omit<HostBaselinePolicy, "bodyDigest"> = {
	schemaVersion: 1,
	policyId: "taskflow-resolve-only",
	policyVersion: "1",
	readableSystemClasses: ["runtime", "dynamic-libraries", "ca-certificates"],
	providerMetadata: [],
	credentialDelivery: { mode: "unavailable" },
	temp: { mode: "private-per-execution", access: "read-write" },
	network: "host-policy",
};

const BASELINE_BODY_DIGEST = computeHostBaselineBodyDigest(BASELINE_BODY);

const RESOLVE_ONLY_BASELINE: HostBaselinePolicy = Object.freeze<HostBaselinePolicy>({
	schemaVersion: 1,
	policyId: "taskflow-resolve-only",
	policyVersion: "1",
	bodyDigest: BASELINE_BODY_DIGEST,
	readableSystemClasses: ["runtime", "dynamic-libraries", "ca-certificates"],
	providerMetadata: [],
	credentialDelivery: { mode: "unavailable" },
	temp: { mode: "private-per-execution", access: "read-write" },
	network: "host-policy",
});

const RESOLVE_ONLY_CAPABILITIES: WorkspaceBackendCapabilities = Object.freeze<WorkspaceBackendCapabilities>({
	schemaVersion: 1,
	backendId: "taskflow-resolve-only",
	backendCapabilityVersion: "1",
	agent: "resolve-only",
	script: "resolve-only",
	sandboxFeatures: {
		maxGrants: 1,
		scopeKinds: ["directory"],
		perGrantAccess: true,
		denyAmbientUserData: false,
		exactBaselineMounts: false,
		privateTempPerExecution: false,
		descendantEnforcement: false,
		raceFreeFileBroker: false,
		networkModes: ["host-policy"],
		credentialModes: [],
	},
	brokeredRead: false,
	brokeredWrite: false,
	versionCommitModes: ["generation-only"],
	restoreStrategies: [],
	baselinePolicyId: RESOLVE_ONLY_BASELINE.policyId,
});

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function stableRootToken(root: string): string {
	const stat = fs.statSync(root, { bigint: true });
	// This compatibility binding is explicitly path-bound (not a persisted host
	// registry UUID). Include both filesystem identity and canonical path so an
	// inode reused for a replacement directory cannot inherit prior authority or
	// dirty journal state.
	return crypto.createHash("sha256").update(`${stat.dev}:${stat.ino}:${root}`).digest("hex");
}

interface DirectoryIdentity {
	canonicalPath: string;
	device: string;
	inode: string;
}

function readDirectoryIdentity(directory: string): DirectoryIdentity {
	const canonicalPath = fs.realpathSync(directory);
	const stat = fs.statSync(canonicalPath, { bigint: true });
	if (!stat.isDirectory()) throw new Error("TFWS_IDENTITY_MISMATCH: workspace cwd is no longer a directory");
	return { canonicalPath, device: stat.dev.toString(), inode: stat.ino.toString() };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
	return left.canonicalPath === right.canonicalPath && left.device === right.device && left.inode === right.inode;
}

export function defaultWorkspaceControlDirectory(invocationRoot: string): string {
	const canonical = fs.realpathSync(invocationRoot);
	return path.join(os.homedir(), ".taskflow", "workspace-control", stableRootToken(canonical));
}

function ensurePrivateDirectory(directory: string): void {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") {
		const stat = fs.statSync(directory);
		if ((stat.mode & 0o077) !== 0) fs.chmodSync(directory, 0o700);
	}
}

function loadOrCreateEnforcementKey(directory: string): Buffer {
	const keyPath = path.join(directory, "enforcement-key-v1");
	try {
		const existing = fs.readFileSync(keyPath);
		if (existing.length !== 32) throw new Error("invalid enforcement key length");
		return existing;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const key = crypto.randomBytes(32);
	try {
		const fd = fs.openSync(keyPath, "wx", 0o600);
		try {
			fs.writeFileSync(fd, key);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		return key;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existing = fs.readFileSync(keyPath);
		if (existing.length !== 32) throw new Error("invalid enforcement key length");
		return existing;
	}
}

function agentFailure(agentName: string, task: string, error: unknown): RunResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		agent: agentName,
		task,
		exitCode: 1,
		output: "",
		stderr: message,
		usage: emptyUsage(),
		stopReason: "error",
		errorMessage: message,
		workspaceMutationStarted: error instanceof ResolveOnlyExecutionError ? error.mutationStarted : false,
	};
}

class ResolveOnlyExecutionError extends Error {
	readonly mutationStarted: boolean;

	constructor(error: unknown, mutationStarted: boolean) {
		super(error instanceof Error ? error.message : String(error), { cause: error });
		this.name = "ResolveOnlyExecutionError";
		this.mutationStarted = mutationStarted;
	}
}

function agentSucceeded(result: RunResult): boolean {
	return result.exitCode === 0 && result.stopReason !== "error" && result.stopReason !== "aborted" && !result.errorMessage;
}

function scriptSucceeded(result: CoordinatedScriptResult): boolean {
	return result.code === 0 && result.timedOut !== true;
}

class ResolveOnlyWorkspaceSessionImpl implements ResolveOnlyWorkspaceSession {
	readonly assurance = "resolve-only-no-sandbox" as const;
	readonly invocationRoot: string;
	readonly registry: RootRegistry;
	readonly authority: InvocationAuthority;
	readonly #grant: RootGrant;
	readonly #leases: PersistentLeaseCoordinator;
	readonly #journal: WriteIntentJournal;
	readonly #agentFactory: SandboxPolicyFactory;
	readonly #scriptFactory: SandboxPolicyFactory;
	readonly #leaseTimeoutMs: number;
	readonly #permitTtlMs: number;
	readonly #signal?: AbortSignal;
	readonly #rootIdentity: DirectoryIdentity;
	readonly #pendingLeaseReleases = new Set<LeaseHandle>();
	readonly #allowReconcile: boolean;
	// A single resolve-only session can fan out many tasks over the same granted
	// root. They are all potential writers and cannot safely overlap without a
	// native broker/snapshot backend. Serialize them before lease acquisition so
	// ordinary parallel/map/tournament phases do not self-deadlock on the 10s
	// cross-process lease timeout. External sessions still contend durably.
	#mutationTail: Promise<void> = Promise.resolve();

	constructor(options: ResolveOnlyWorkspaceSessionOptions) {
		this.invocationRoot = fs.realpathSync(options.invocationRoot);
		this.#rootIdentity = readDirectoryIdentity(this.invocationRoot);
		const rootToken = stableRootToken(this.invocationRoot);
		const grantId = options.grantId ?? "invocation";
		const registryId = options.registryId ?? `invocation-${rootToken}`;
		const principalId = options.principalId ?? "local-host-invocation";
		this.authority = createHostInvocationAuthority({
			principalId,
			allowedGrantIds: [grantId],
			allowResolveOnly: true,
		});
		this.#grant = createHostRootGrant({
			grantId,
			bindingId: `binding-${rootToken}`,
			resourceDomainId: `domain-${rootToken}`,
			physicalRoot: this.invocationRoot,
			maxAccess: "read-write",
			allowedPrincipals: [principalId],
			enforcement: "resolve-only",
		});
		this.registry = createRootRegistry({ registryId, grants: [this.#grant] });
		const controlDirectory = options.controlDirectory ?? defaultWorkspaceControlDirectory(this.invocationRoot);
		ensurePrivateDirectory(controlDirectory);
		const canonicalControlDirectory = fs.realpathSync(controlDirectory);
		if (isWithin(this.invocationRoot, canonicalControlDirectory) || isWithin(canonicalControlDirectory, this.invocationRoot)) {
			throw new Error("TFWS_INVALID_POLICY: control-plane storage must not overlap the flow workspace grant");
		}
		this.#leases = new PersistentLeaseCoordinator({ directory: canonicalControlDirectory, registryId });
		this.#journal = new WriteIntentJournal({ directory: canonicalControlDirectory, journalEpoch: 1 });
		const key = loadOrCreateEnforcementKey(canonicalControlDirectory);
		const factory = (executionTarget: "agent" | "script") => new SandboxPolicyFactory({
			capabilities: RESOLVE_ONLY_CAPABILITIES,
			executionTarget,
			baselineBindings: [RESOLVE_ONLY_BASELINE],
			key,
			keyId: "resolve-only-v1",
			resolveOnlyAdapter: {
				prepareResolveOnly: async () => ({
					assurance: "resolve-only-no-sandbox",
					preparationId: crypto.randomUUID(),
				}),
			},
			authorizeResolveOnly: () => this.authority.allowResolveOnly,
		});
		this.#agentFactory = factory("agent");
		this.#scriptFactory = factory("script");
		this.#leaseTimeoutMs = options.leaseTimeoutMs ?? 10_000;
		this.#permitTtlMs = options.permitTtlMs ?? 60_000;
		this.#signal = options.signal;
		this.#allowReconcile = options.allowReconcile === true;
	}

	async initialize(): Promise<void> {
		await this.#leases.recoverStale();
		await this.#journal.recoverPending(undefined, {
			isOwnerActive: async (owner) => {
				const active = await this.#leases.list();
				return active.some((lease) => sameExecutionOwner(lease.owner, owner));
			},
		});
	}

	async bindPhase(input: BindResolveOnlyPhaseInput): Promise<ResolveOnlyPhaseBinding> {
		await this.#drainPendingLeaseReleases();
		this.#assertRootIdentity();
		const authorized = this.registry.authorize(this.#grant.grantId, this.authority, "read-write");
		if (!("physicalRoot" in authorized)) throw new Error(`${authorized.code}: ${authorized.redactedMessage}`);
		const invocationRoot = fs.realpathSync(input.invocationRoot);
		if (!isWithin(this.invocationRoot, invocationRoot)) {
			throw new Error("TFWS_PATH_ESCAPE: nested invocation root escapes the authorized grant");
		}
		const attemptId = crypto.randomUUID();
		const resolved = await this.#resolve(input, invocationRoot, attemptId);
		return new ResolveOnlyPhaseBindingImpl(this, input, resolved);
	}

	async reconcile(input: ReconcileResolveOnlyWorkspaceInput): Promise<ReconciliationResult> {
		if (!this.#allowReconcile) {
			throw new Error("TFWS_RECONCILE_NOT_AUTHORIZED: reconciliation requires an explicit trusted host decision");
		}
		if (input.acknowledgement !== WORKSPACE_RECONCILE_ACKNOWLEDGEMENT) {
			throw new Error(
				`TFWS_RECONCILE_ACK_REQUIRED: acknowledgement must exactly equal '${WORKSPACE_RECONCILE_ACKNOWLEDGEMENT}'`,
			);
		}
		await this.#drainPendingLeaseReleases();
		this.#assertRootIdentity();
		const owner: ExecutionOwner = {
			runId: `workspace-reconcile-${crypto.randomUUID()}`,
			phaseId: "reconcile",
			attemptId: crypto.randomUUID(),
			unitId: "workspace",
			ancestry: [],
		};
		let lease: LeaseHandle | undefined;
		try {
			lease = await this.#leases.acquire([{
				key: {
					resourceDomainId: this.#grant.resourceDomainId,
					canonicalPrefix: this.invocationRoot,
				},
				access: "read-write",
				owner,
			}], {
				timeoutMs: this.#leaseTimeoutMs,
				signal: input.signal ?? this.#signal,
			});
			this.#assertRootIdentity();
			return await this.#journal.reconcileDomain(
				this.#grant.resourceDomainId,
				input.reason?.trim() || "operator acknowledged current external workspace state",
			);
		} finally {
			if (lease) await this.#releaseLeaseBestEffort(lease);
		}
	}

	async #resolve(input: BindResolveOnlyPhaseInput, invocationRoot: string, attemptId: string): Promise<ResolvedPathRef> {
		const generation = await this.#journal.getDomainGeneration(this.#grant.resourceDomainId);
		const rootPrefix = path.relative(this.invocationRoot, invocationRoot).split(path.sep).filter(Boolean).join("/");
		const capability: ScopedCapability = {
			bindingId: this.#grant.bindingId,
			resourceDomainId: this.#grant.resourceDomainId,
			providerInstanceId: "root",
			logicalWorkspaceId: "invocation",
			logicalPrefix: rootPrefix,
			physicalScopeRoot: invocationRoot,
			access: "read-write",
			version: { identityMode: "path-bound", generation, state: "clean" },
			lifetime: { scope: "run", runId: input.runId },
		};
		const ref = {
			workspace: "invocation",
			...(input.argName === undefined ? {} : { subpath: { argPath: input.argName } }),
			access: "read-write",
			intent: "existing-directory",
			maxLifetime: { scope: "phase" },
		};
		const result = resolvePathRef(
			ref,
			{
				workspaces: new Map([["invocation", capability]]),
				runId: input.runId,
				phaseId: input.phaseId,
				attemptId,
			},
			{ definitions: input.argDefinitions, values: input.argValues },
		);
		if (!result.ok) throw new Error(`${result.error.code}: ${result.error.redactedMessage}`);
		return result.value;
	}

	async executeMutation<T>(
		input: BindResolveOnlyPhaseInput,
		boundPath: string,
		unitId: string,
		target: "agent" | "script",
		callSignal: AbortSignal | undefined,
		invoke: () => Promise<T>,
		succeeded: (result: T) => boolean,
	): Promise<T> {
		const previous = this.#mutationTail.catch(() => undefined);
		let releaseTurn!: () => void;
		const turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
		this.#mutationTail = previous.then(() => turn);
		const signals = [this.#signal, callSignal].filter((candidate): candidate is AbortSignal => candidate !== undefined);
		const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
		try {
			await this.#waitForMutationTurn(previous, signal);
			return await this.#executeMutationNow(input, boundPath, unitId, target, signal, invoke, succeeded);
		} finally {
			releaseTurn();
		}
	}

	async #executeMutationNow<T>(
		input: BindResolveOnlyPhaseInput,
		boundPath: string,
		unitId: string,
		target: "agent" | "script",
		signal: AbortSignal | undefined,
		invoke: () => Promise<T>,
		succeeded: (result: T) => boolean,
	): Promise<T> {
		await this.#drainPendingLeaseReleases();
		const owner: ExecutionOwner = {
			runId: input.runId,
			phaseId: input.phaseId,
			attemptId: crypto.randomUUID(),
			unitId,
			ancestry: [],
		};
		let lease: LeaseHandle | undefined;
		let mutation: PreparedMutation | undefined;
		try {
			this.#assertRootIdentity();
			if (signal?.aborted) throw new Error("ABORT_ERR: workspace execution was cancelled before lease acquisition");
			const dirty = (await this.#journal.listIntents()).find((intent) =>
				intent.resourceDomainId === this.#grant.resourceDomainId && intent.status === "dirty-unknown");
			if (dirty) throw new Error("TFWS_RESOURCE_DIRTY: workspace requires reconciliation before another write");
			lease = await this.#leases.acquire([{
				key: { resourceDomainId: this.#grant.resourceDomainId, canonicalPrefix: boundPath },
				access: "read-write",
				owner,
			}], { timeoutMs: this.#leaseTimeoutMs, signal });

			this.#assertRootIdentity();
			if (signal?.aborted) throw new Error("ABORT_ERR: workspace execution was cancelled before mutation preparation");
			const resolved = await this.#resolve(input, fs.realpathSync(input.invocationRoot), owner.attemptId);
			if (resolved.physicalPath !== boundPath) {
				throw new Error("TFWS_IDENTITY_MISMATCH: cwd changed between binding and execution");
			}
			const boundIdentity = readDirectoryIdentity(boundPath);
			const policy = this.#policy(resolved);
			const factory = target === "agent" ? this.#agentFactory : this.#scriptFactory;
			const prepared = await factory.prepareSandbox(policy, owner);
			mutation = await this.#journal.prepare({
				resourceDomainId: this.#grant.resourceDomainId,
				providerInstanceId: "root",
				scopes: [{ canonicalPrefix: boundPath, scopeDigest: crypto.createHash("sha256").update(resolved.capability.logicalPrefix).digest("hex") }],
				owner,
				commitMode: "generation-only",
				externalMutation: "externally-mutable",
				permitTtlMs: this.#permitTtlMs,
			});
			const sealed = factory.sealSandbox(prepared, [mutation.permit]);
			return await factory.activateOnce(
				sealed,
				{
					activateMutationPermits: (permits, activationOwner) => this.#journal.activate(permits, activationOwner),
					// Journal terminal WAL methods own best-effort settlement. This hook is
					// intentionally non-throwing so post-commit cleanup cannot turn a
					// successful filesystem mutation into a retryable runner failure.
					settleMutationPermits: async () => undefined,
				},
				async () => {
					try {
						const result = await invoke();
						if (signal?.aborted) {
							await this.#journal.markUnknown(
								mutation!.intent.intentId,
								`${target} execution completed after cancellation; filesystem outcome is not reusable`,
							);
							throw new Error("ABORT_ERR: workspace execution completed after cancellation and was marked dirty");
						}
						if (succeeded(result)) {
							// A runner may replace the invocation root or the selected subtree
							// while it is active. Success is committable only if the exact root
							// identity and canonical bound path still match after the process ends.
							this.#assertRootIdentity();
							const postResolved = await this.#resolve(
								input,
								fs.realpathSync(input.invocationRoot),
								owner.attemptId,
							);
							// Resolve-only cannot make an externally mutable filesystem path and
							// the WAL commit one atomic operation. Bracket the awaited resolver with
							// root identity checks so every observable replacement fails closed;
							// eliminating the remaining external TOCTOU requires a native directory
							// handle/file broker and is outside resolve-only assurance.
							this.#assertRootIdentity();
							if (postResolved.physicalPath !== boundPath) {
								throw new Error("TFWS_IDENTITY_MISMATCH: cwd changed during workspace execution");
							}
							if (signal?.aborted) {
								await this.#journal.markUnknown(
									mutation!.intent.intentId,
									`${target} execution was cancelled during post-execution validation`,
								);
								throw new Error("ABORT_ERR: workspace execution was cancelled and marked dirty");
							}
							await this.#journal.commitGeneration(mutation!.intent.intentId, {
								preCommitGuard: () => {
									if (signal?.aborted) {
										throw new Error("ABORT_ERR: workspace execution was cancelled before commit");
									}
									this.#assertRootIdentity();
									if (!sameDirectoryIdentity(readDirectoryIdentity(boundPath), boundIdentity)) {
										throw new Error("TFWS_IDENTITY_MISMATCH: cwd changed before workspace commit");
									}
								},
							});
						} else {
							await this.#journal.markUnknown(mutation!.intent.intentId, `${target} execution failed or was aborted`);
						}
						return result;
					} catch (error) {
						await this.#markUnknownIfPending(mutation!, `${target} execution threw: ${error instanceof Error ? error.message : String(error)}`);
						throw error;
					}
				},
			);
		} catch (error) {
			if (mutation) await this.#markUnknownIfPending(mutation, `execution preparation failed: ${error instanceof Error ? error.message : String(error)}`);
			if (error instanceof ResolveOnlyExecutionError) throw error;
			throw new ResolveOnlyExecutionError(error, mutation !== undefined);
		} finally {
			if (lease) await this.#releaseLeaseBestEffort(lease);
		}
	}

	async #waitForMutationTurn(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
		if (!signal) {
			await previous;
			return;
		}
		if (signal.aborted) throw new ResolveOnlyExecutionError("ABORT_ERR: workspace execution was cancelled while queued", false);
		let onAbort!: () => void;
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(new ResolveOnlyExecutionError("ABORT_ERR: workspace execution was cancelled while queued", false));
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			await Promise.race([previous, aborted]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	async #releaseLeaseBestEffort(lease: LeaseHandle): Promise<void> {
		this.#pendingLeaseReleases.add(lease);
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await lease.release();
				this.#pendingLeaseReleases.delete(lease);
				return;
			} catch {
				// Retry the same authenticated lease handle. A successful mutation must
				// not be reported as failed merely because cleanup storage was briefly
				// unavailable.
			}
		}
		console.warn(`[taskflow] workspace lease cleanup deferred for lease ${lease.leaseId}`);
	}

	async #drainPendingLeaseReleases(): Promise<void> {
		for (const lease of [...this.#pendingLeaseReleases]) {
			await this.#releaseLeaseBestEffort(lease);
		}
		if (this.#pendingLeaseReleases.size > 0) {
			throw new Error("TFWS_CONTROL_PLANE_CLEANUP: a prior workspace lease could not be released");
		}
	}

	#assertRootIdentity(): void {
		let current: DirectoryIdentity | undefined;
		try {
			current = readDirectoryIdentity(this.invocationRoot);
		} catch {
			current = undefined;
		}
		if (!current || !sameDirectoryIdentity(current, this.#rootIdentity)) {
			throw new Error("TFWS_IDENTITY_MISMATCH: invocation root identity changed after workspace authorization");
		}
	}

	#policy(resolved: ResolvedPathRef): SandboxPolicyPlan {
		return createSandboxPolicyPlan({
			mode: "resolve-only",
			cwd: resolved,
			grants: [{
				bindingId: resolved.capability.bindingId,
				resourceDomainId: resolved.capability.resourceDomainId,
				providerInstanceId: resolved.capability.providerInstanceId,
				logicalWorkspaceId: resolved.capability.logicalWorkspaceId,
				logicalPrefix: resolved.capability.logicalPrefix,
				physicalScopeRoot: resolved.capability.physicalScopeRoot,
				scopeKind: "directory",
				access: resolved.capability.access,
				lifetime: resolved.capability.lifetime,
			}],
			baseline: RESOLVE_ONLY_BASELINE,
			credentialRequirements: [],
		}, RESOLVE_ONLY_CAPABILITIES);
	}

	async #markUnknownIfPending(mutation: PreparedMutation, reason: string): Promise<void> {
		const current = await this.#journal.getIntent(mutation.intent.intentId);
		if (current?.status === "pending") await this.#journal.markUnknown(current.intentId, reason);
	}
}

class ResolveOnlyPhaseBindingImpl implements ResolveOnlyPhaseBinding {
	readonly assurance = "resolve-only-no-sandbox" as const;
	readonly absolutePath: string;
	readonly logicalPath: string;
	readonly resourceDomainId: string;
	readonly runId: string;
	readonly phaseId: string;
	readonly #session: ResolveOnlyWorkspaceSessionImpl;
	readonly #input: BindResolveOnlyPhaseInput;

	constructor(session: ResolveOnlyWorkspaceSessionImpl, input: BindResolveOnlyPhaseInput, resolved: ResolvedPathRef) {
		this.#session = session;
		this.#input = input;
		this.absolutePath = resolved.physicalPath;
		this.logicalPath = resolved.capability.logicalPrefix;
		this.resourceDomainId = resolved.capability.resourceDomainId;
		this.runId = input.runId;
		this.phaseId = input.phaseId;
	}

	async runAgent(call: ResolveOnlyAgentCall): Promise<RunResult> {
		try {
			const result = await this.#session.executeMutation(
				this.#input,
				this.absolutePath,
				call.unitId ?? this.phaseId,
				"agent",
				call.opts.signal,
				call.invoke,
				agentSucceeded,
			);
			return { ...result, workspaceMutationStarted: true };
		} catch (error) {
			return agentFailure(call.agentName, call.task, error);
		}
	}

	runScript(call: ResolveOnlyScriptCall): Promise<CoordinatedScriptResult> {
		return this.#session.executeMutation(
			this.#input,
			this.absolutePath,
			call.unitId ?? this.phaseId,
			"script",
			call.signal,
			call.invoke,
			scriptSucceeded,
		);
	}
}

export async function createResolveOnlyWorkspaceSession(
	options: ResolveOnlyWorkspaceSessionOptions,
): Promise<ResolveOnlyWorkspaceSession> {
	const session = new ResolveOnlyWorkspaceSessionImpl(options);
	await session.initialize();
	return session;
}

export async function reconcileResolveOnlyWorkspace(
	options: ResolveOnlyWorkspaceSessionOptions,
	input: ReconcileResolveOnlyWorkspaceInput,
): Promise<ReconciliationResult> {
	const session = await createResolveOnlyWorkspaceSession(options);
	return session.reconcile(input);
}
