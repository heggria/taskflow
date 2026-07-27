/**
 * ControlHost — single execution semantics for standalone / daemon / embedded (D18).
 *
 * Admit → reserve → execute → receipt (or needs-operator without receipt).
 */
import {
	DEFAULT_CONTROL_MODE,
	isTerminalRunStatus,
	reconcileRequiredError,
	type AdmissionIntent,
	type BoundPlan,
	type ControlError,
	type ControlEvent,
	type ControlMode,
	type DurableCancelRequest,
	type DurableDispatchAttempt,
	type Receipt,
	type RunContinuation,
	type RunProjection,
	type RunStage,
	type RunStatus,
} from "./types.ts";
import { hashRequest, newId } from "./hash.ts";
import { openProjectControlStore, type ProjectControlStore } from "./store/project-store.ts";
import { openControlRegistry, type ControlRegistry } from "./store/registry.ts";
import {
	openUserCoordinatorStore,
	type UserCoordinatorStore,
	canNormalRelease,
} from "./store/coordinator.ts";
import {
	acquireOrAttachSingleton,
	isSingletonMutationAuthorityCurrent,
	releaseSingleton,
	SingletonAuthorityError,
	withSingletonMutationAuthority,
	type SingletonMutationAuthority,
	type SingletonResult,
} from "./singleton.ts";
import { linkProgram } from "./linker.ts";
import {
	createMockExecutionProvider,
	providerHandleOwnershipFailure,
	type ExecutionProvider,
	type ProviderSubmissionFence,
} from "./provider.ts";
import { createScriptExecutionProvider } from "./script-provider.ts";
import {
	boundedReconcile,
	applyReconcileToRun,
	DEFAULT_RECONCILE_BUDGET,
	type ReconcileBudget,
} from "./reconcile.ts";
import { isSafeId } from "./validate-ids.ts";
import { ControlStoreDurabilityError, projectCoordinatorDir } from "./paths.ts";
import type { IdentityOpenPolicy } from "./identity.ts";
import {
	createApprovalRequest,
	decideApproval,
	expireApprovalIfDue,
	loadApprovalForRun,
	newApprovalRequest,
	transitionApproval,
} from "./approval.ts";
import { legacyConflictError, probeLegacyConflict } from "./legacy-conflict.ts";
import {
	lookupDurableDispatchForRecovery,
	schedulePhases,
	topoOrderPhases,
	type PhaseRecord,
	type ProviderSubmitAuthorization,
	type SchedulerCheckpoint,
} from "./phase-scheduler.ts";

export interface ControlHostOptions {
	projectRoot: string;
	/** Default auto. Silent auto→standalone is forbidden. */
	controlMode?: ControlMode;
	env?: NodeJS.ProcessEnv;
	/**
	 * Inject provider. **Production default is ScriptExecutionProvider** (real OS
	 * processes). Mock is NEVER the production default — tests must inject mock
	 * explicitly via `provider` or `allowMockProvider: true` (test-only).
	 * Used as the script-phase provider when `scriptProvider` omitted.
	 */
	provider?: ExecutionProvider;
	/**
	 * Phase-level script ExecutionProvider (default: ScriptExecutionProvider).
	 */
	scriptProvider?: ExecutionProvider;
	/**
	 * Phase-level host LLM ExecutionProvider (agent/gate/…). Required for
	 * non-script phases. When omitted, agent phases fail closed on ControlHost.
	 */
	llmProvider?: ExecutionProvider;
	/**
	 * TEST ONLY: when true and `provider` omitted, use MockExecutionProvider.
	 * Production CLI/daemon must never set this.
	 */
	allowMockProvider?: boolean;
	/** Skip process singleton (tests that only need store path). */
	skipSingleton?: boolean;
	/** Holder id for singleton. */
	holderId?: string;
	/**
	 * Parent singleton fence for an embedded host (taskflowd). When supplied,
	 * it is checked for every public mutation instead of treating skipSingleton
	 * as unconditional authority.
	 */
	mutationAuthority?: () => boolean;
	/**
	 * Process-local singleton capability passed by taskflowd to an embedded
	 * project host. A callback or serialized epoch cannot substitute for it.
	 */
	mutationCapability?: SingletonMutationAuthority;
	/**
	 * Parent singleton fence for synchronous durable mutations. taskflowd passes
	 * its outer singleton record here so child hosts cannot write after takeover.
	 */
	mutationFence?: <T>(fn: () => T) => T;
	/** Standalone skips global concurrency claims across projects. */
	reconcileBudget?: ReconcileBudget;
	/**
	 * Project identity policy for ControlStore open (P3).
	 * Default strict: refuse clone/worktree silent domain share.
	 */
	identityPolicy?: IdentityOpenPolicy;
}

export interface AdmitRequest {
	commandId?: string;
	callerPrincipal?: string;
	program: unknown;
	/** When false, do not re-execute if commandId+hash match. */
	idempotent?: boolean;
}

export interface AdmitResult {
	ok: boolean;
	run?: RunProjection;
	receipt?: Receipt;
	error?: ControlError;
	/** Snapshot for wait/status — always present on needs-operator. */
	snapshot?: RunSnapshot;
}

export interface RunSnapshot {
	run: RunProjection;
	/** Present when needs-operator after reconcile exhaustion. */
	controlError?: ControlError;
	receipt?: Receipt | null;
}

export type ControlHostRole = "writer" | "attach" | "standalone-local";

export interface ControlHost {
	readonly projectId: string;
	readonly controlDomainId: string;
	readonly controlMode: ControlMode;
	/** writer | attach (singleton multi-mount) | standalone-local (explicit). */
	readonly role: ControlHostRole;
	/** False for singleton attach — may observe only; must not commit Runs/Receipts. */
	readonly canMutate: boolean;
	readonly singleton?: SingletonResult;
	readonly store: ProjectControlStore;
	readonly registry: ControlRegistry;
	readonly coordinator: UserCoordinatorStore;
	/** Link + admit + execute (or park / needs-operator). Writer/standalone only. */
	admitAndRun(req: AdmitRequest): Promise<AdmitResult>;
	/** Status/wait snapshot — never transport-fails on TF_RECONCILE_REQUIRED. */
	getSnapshot(runId: string): RunSnapshot | null;
	wait(runId: string): Promise<RunSnapshot>;
	/**
	 * Resolve one journaled post-dispatch crash window without replaying it.
	 * This is intentionally conservative: it acknowledges a provider handle and
	 * observes that exact handle, then leaves downstream continuation/Receipt
	 * issuance operator-owned until the general restart scheduler is proven.
	 */
	reconcilePendingDispatch(
		runId: string,
		opts?: { commandId?: string; expectedRunVersion?: number },
	): Promise<AdmitResult>;
	cancel(
		runId: string,
		opts?: { commandId?: string; principal?: string; expectedRunVersion?: number },
	): Promise<AdmitResult>;
	/** Durable approval: park (release slot) only when provider quiescent (D38). */
	parkForApproval(
		runId: string,
		opts?: { expectedRunVersion?: number },
	): Promise<AdmitResult>;
	approve(
		runId: string,
		opts?: { commandId?: string; principal?: string; expectedRunVersion?: number },
	): Promise<AdmitResult>;
	/**
	 * Edit parked approval: CAS decide edit + re-reserve + terminal with edited payload.
	 * Same first-commit-wins CAS as approve (P15).
	 */
	edit(
		runId: string,
		opts: {
			commandId?: string;
			principal?: string;
			expectedRunVersion?: number;
			/** Required edited output / note (never empty). */
			note: string;
		},
	): Promise<AdmitResult>;
	/** Reject parked approval → blocked terminal (no re-reserve). */
	reject(
		runId: string,
		opts?: { commandId?: string; principal?: string; expectedRunVersion?: number; note?: string },
	): Promise<AdmitResult>;
	/** Expire pending approval past deadline → blocked. */
	expireApproval(runId: string, opts?: { now?: number }): Promise<AdmitResult>;
	/** Operator force-release of a concurrency reservation (CoordinatorCommandRecord). */
	forceReleaseReservation(
		reservationId: string,
		opts: {
			commandId?: string;
			principal: string;
			/** Must be true — operator risk acknowledgement (D37). */
			riskAcknowledged: boolean;
			reason?: string;
		},
	): { ok: true; commandId: string } | { ok: false; error: ControlError };
	close(): void;
}

type MutationFence = <T>(fn: () => T) => T;

export function createControlHost(opts: ControlHostOptions): ControlHost {
	const env = opts.env ?? process.env;
	const controlMode = opts.controlMode ?? DEFAULT_CONTROL_MODE;
	if (controlMode !== "auto" && controlMode !== "coordinated" && controlMode !== "standalone") {
		throw new Error(`invalid controlMode: ${controlMode}`);
	}

	const holderId = opts.holderId ?? newId("host");
	let singleton: SingletonResult | undefined;
	if (!opts.skipSingleton && controlMode !== "standalone") {
		singleton = acquireOrAttachSingleton(holderId, env);
	} else if (controlMode === "auto" && opts.skipSingleton) {
		// Tests may skip; production auto never silently becomes full standalone
		// without an explicit controlMode: standalone.
	}

	const role: ControlHostRole =
		controlMode === "standalone"
			? "standalone-local"
			: singleton?.role === "attach"
				? "attach"
				: "writer";
	const singletonMutationCapability =
		opts.mutationCapability ?? (singleton?.role === "writer" ? singleton.mutationAuthority : undefined);
	/**
	 * Attach clients observe only. A multi-mount writer also loses mutation
	 * authority immediately when a stale takeover installs another epoch.
	 * `skipSingleton` is test/explicit embedded plumbing and intentionally keeps
	 * its existing local authority semantics; it remains a non-GA route.
	 */
	function hasMutationAuthority(): boolean {
		if (role === "attach") return false;
		if (singletonMutationCapability) {
			return isSingletonMutationAuthorityCurrent(singletonMutationCapability, env);
		}
		if (opts.mutationAuthority) return opts.mutationAuthority();
		if (role === "standalone-local" || opts.skipSingleton) return true;
		return false;
	}
	const attachMutationFence: MutationFence = <T>(_fn: () => T): T => {
		throw new SingletonAuthorityError("singleton attach cannot mutate");
	};
	const localMutationFence: MutationFence | undefined =
		singletonMutationCapability
			? <T>(fn: () => T): T => withSingletonMutationAuthority(singletonMutationCapability, fn, env)
			: singleton?.role === "attach"
				? attachMutationFence
				: undefined;
	const mutationFence = opts.mutationFence ?? localMutationFence;
	function runDurableMutation<T>(fn: () => T): T {
		return mutationFence ? mutationFence(fn) : fn();
	}

	const store = openProjectControlStore(opts.projectRoot, {
		identityPolicy: opts.identityPolicy ?? "strict",
		mutationFence,
		readOnly: role === "attach",
	});
	const registry = openControlRegistry(env, { readOnly: role === "attach" });
	// Registry discovery is fine for standalone; capacity must not use user-level
	// multi-project coordinator (D5/D30) — project-local baseDir below.
	if (role !== "attach") registry.registerFromStore(store, opts.projectRoot);
	const coordinator =
		controlMode === "standalone"
			? openUserCoordinatorStore(env, {
					baseDir: projectCoordinatorDir(opts.projectRoot),
					durabilityRoot: opts.projectRoot,
					mutationFence,
				})
			: openUserCoordinatorStore(env, {
					mutationAuthority: singletonMutationCapability,
					allowUnfencedMutationForExplicitNonGaMode: opts.skipSingleton === true,
					...(singletonMutationCapability ? {} : { mutationFence }),
				});
	// Production default: real script provider. Mock only when explicitly allowed (tests).
	const scriptProvider =
		opts.scriptProvider ??
		opts.provider ??
		(opts.allowMockProvider
			? createMockExecutionProvider()
			: createScriptExecutionProvider({
					stateDir: `${opts.projectRoot}/.taskflow/control/provider-jobs`,
				}));
	const llmProvider = opts.llmProvider;
	/**
	 * A persisted providerName is a routing authority, not a display label. Do
	 * not infer a provider from an opaque handle or silently fall back to script:
	 * that would let an LLM/remote job be cancelled or declared quiescent by an
	 * unrelated provider after restart (D9/D38/C7).
	 */
	const providersByName = new Map<string, ExecutionProvider>();
	function registerProvider(slot: "script" | "llm", candidate: ExecutionProvider | undefined): void {
		if (!candidate) return;
		if (!candidate.name.trim()) {
			throw new Error(`${slot} ExecutionProvider must expose a non-empty durable name`);
		}
		const existing = providersByName.get(candidate.name);
		if (existing && existing !== candidate) {
			throw new Error(
				`distinct ${slot} ExecutionProvider reuses durable provider name ${JSON.stringify(candidate.name)}`,
			);
		}
		providersByName.set(candidate.name, candidate);
	}
	registerProvider("script", scriptProvider);
	registerProvider("llm", llmProvider);
	const reconcileBudget = opts.reconcileBudget ?? DEFAULT_RECONCILE_BUDGET;

	type DurableProviderRouteIdentity = {
		runId: string;
		providerName: string;
		handle: string;
		continuationId: string;
		continuationVersion: number;
		attemptId: string;
		phaseId: string;
	};
	type DurableProviderRoute =
		| { ok: true; provider: ExecutionProvider; identity: DurableProviderRouteIdentity }
		| { ok: false; reason: string };

	/**
	 * Derive the exact provider route from the journaled Run + active attempt.
	 * The active attempt is intentionally required: a stale last-handle from a
	 * prior phase is not a capability to signal or release a later phase.
	 */
	function durableProviderRouteIdentity(run: RunProjection): DurableProviderRoute | { ok: true; identity: DurableProviderRouteIdentity } {
		if (!run.providerName || !run.providerHandle || !run.continuationId) {
			return { ok: false, reason: "run has no complete durable provider route" };
		}
		let continuation: RunContinuation | null;
		try {
			continuation = store.getContinuation(run.runId);
		} catch (error) {
			return {
				ok: false,
				reason: `cannot read durable continuation: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		if (!continuation || continuation.continuationId !== run.continuationId) {
			return { ok: false, reason: "run has no matching durable continuation" };
		}
		const active = continuation.activeAttempt;
		if (!active) {
			return { ok: false, reason: "run has no active durable provider attempt" };
		}
		if (continuation.nextPhaseId !== active.phaseId) {
			return { ok: false, reason: "active durable provider attempt does not match continuation cursor" };
		}
		if (active.state !== "acknowledged" && active.state !== "ambiguous") {
			return { ok: false, reason: `active provider attempt is ${active.state}, not handle-bearing` };
		}
		if (
			active.providerName !== run.providerName ||
			active.providerHandle !== run.providerHandle
		) {
			return { ok: false, reason: "run provider route disagrees with durable active attempt" };
		}
		return {
			ok: true,
			identity: {
				runId: run.runId,
				providerName: active.providerName,
				handle: active.providerHandle!,
				continuationId: continuation.continuationId,
				continuationVersion: continuation.version,
				attemptId: active.attemptId,
				phaseId: active.phaseId,
			},
		};
	}

	function cancelRouteIdentity(
		run: RunProjection,
		request: DurableCancelRequest | undefined,
	): DurableProviderRouteIdentity | undefined {
		if (
			!request?.providerName ||
			!request.providerHandle ||
			!request.continuationId ||
			request.continuationVersion === undefined ||
			!request.attemptId ||
			!request.phaseId
		) {
			return undefined;
		}
		return {
			runId: run.runId,
			providerName: request.providerName,
			handle: request.providerHandle,
			continuationId: request.continuationId,
			continuationVersion: request.continuationVersion,
			attemptId: request.attemptId,
			phaseId: request.phaseId,
		};
	}

	function resolveDurableProviderRoute(
		run: RunProjection,
		expected?: DurableProviderRouteIdentity,
	): DurableProviderRoute {
		const derived = durableProviderRouteIdentity(run);
		if (!derived.ok) return derived;
		const identity = derived.identity;
		if (
			expected &&
			(expected.runId !== identity.runId ||
				expected.providerName !== identity.providerName ||
				expected.handle !== identity.handle ||
				expected.continuationId !== identity.continuationId ||
				expected.continuationVersion !== identity.continuationVersion ||
				expected.attemptId !== identity.attemptId ||
				expected.phaseId !== identity.phaseId)
		) {
			return { ok: false, reason: "current durable provider route changed after cancel was requested" };
		}
		const resolved = providersByName.get(identity.providerName);
		if (!resolved) {
			return {
				ok: false,
				reason: `no current ExecutionProvider is registered for durable provider ${identity.providerName}`,
			};
		}
		const recordFailure = providerHandleRecordFailure(resolved, identity);
		if (recordFailure) return { ok: false, reason: recordFailure };
		return { ok: true, provider: resolved, identity };
	}

	/**
	 * A journal tuple chooses a provider, but it is not enough authority to
	 * signal an opaque handle. Before cancel/reconcile/park uses that provider,
	 * the provider's own durable record must prove the handle belongs to this
	 * exact Run/phase route. Provider incarnation/lease fencing is a separate
	 * C7-C capability gap; absence or disagreement is still fail-closed here.
	 */
	function providerHandleRecordFailure(
		provider: ExecutionProvider,
		identity: DurableProviderRouteIdentity,
	): string | undefined {
		return providerHandleOwnershipFailure(provider, {
			handle: identity.handle,
			runId: `${identity.runId}:${identity.phaseId}`,
			providerName: identity.providerName,
		});
	}

	function authorityDenied(op: string): AdmitResult {
		const reason =
			role === "attach"
				? "singleton attach"
				: "writer lost its singleton fencing epoch";
		return {
			ok: false,
			error: {
				code: "TF_AUTHORITY_REVOKED",
				message: `${reason} cannot ${op}; route mutations to the current multi-mount writer (holder=${singleton?.lock.holderId ?? "?"})`,
				recoveryAction: "retry-same-command",
				sideEffects: "none",
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
			},
		};
	}

	type ProviderSubmissionLease = {
		runId: string;
		runVersion: number;
		continuationId: string;
		continuationVersion: number;
		attemptId: string;
		phaseId: string;
		providerName: string;
	};

	/**
	 * `commit.lock` handles other processes; this tiny in-process queue closes
	 * the lock's deliberate re-entrancy escape hatch. A provider can call
	 * `host.cancel()` synchronously from inside `submissionFence.execute`; that
	 * cancel must wait until the protected external submit operation has returned
	 * instead of committing C between the final lease check and S.
	 */
	type LocalProviderSubmissionFence = {
		depth: number;
		settled: Promise<void>;
		release: () => void;
	};
	const localProviderSubmissionFences = new Map<string, LocalProviderSubmissionFence>();

	function pendingProviderSubmissionFence(runId: string): Promise<void> | undefined {
		return localProviderSubmissionFences.get(runId)?.settled;
	}

	function withProviderSideEffectFence<T>(runId: string, operation: () => T): T {
		let local = localProviderSubmissionFences.get(runId);
		if (!local) {
			let release!: () => void;
			local = {
				depth: 0,
				settled: new Promise<void>((resolve) => {
					release = resolve;
				}),
				release,
			};
			localProviderSubmissionFences.set(runId, local);
		}
		local.depth += 1;
		try {
			return store.withProviderSubmissionFence(runId, operation);
		} finally {
			local.depth -= 1;
			if (local.depth === 0) {
				localProviderSubmissionFences.delete(runId);
				local.release();
			}
		}
	}

	class ProviderSubmissionLeaseError extends Error {
		readonly code: "TF_AUTHORITY_REVOKED" | "TF_RECONCILE_REQUIRED";

		constructor(code: "TF_AUTHORITY_REVOKED" | "TF_RECONCILE_REQUIRED", message: string) {
			super(message);
			this.name = "ProviderSubmissionLeaseError";
			this.code = code;
		}
	}

	/**
	 * A dispatch intent is not permission to submit forever. The scheduler keeps
	 * a local cursor, but cancel/approval/recovery commands can advance the
	 * durable Run between `DispatchIntentRecorded` and `provider.submit`. Check
	 * the exact run + continuation + intent identity immediately before the
	 * external call and, for providers that honor it, inside their synchronous
	 * submission fence as well.
	 */
	function staleSubmissionLeaseReason(lease: ProviderSubmissionLease): string | undefined {
		const current = store.getRun(lease.runId);
		if (!current) return "durable run disappeared before provider submission";
		if (current.cancelRequest) {
			return "durable cancellation won before provider submission";
		}
		if (current.runVersion !== lease.runVersion) {
			return (
				`durable runVersion changed before provider submission ` +
				`(expected ${lease.runVersion}, have ${current.runVersion})`
			);
		}
		if (current.status !== "running" || current.stage !== "executing") {
			return `run is no longer executing before provider submission (have ${current.status}/${current.stage})`;
		}
		if (current.continuationId !== lease.continuationId) {
			return "durable continuation identity changed before provider submission";
		}
		const continuation = store.getContinuation(lease.runId);
		if (!continuation || continuation.continuationId !== lease.continuationId) {
			return "durable continuation disappeared before provider submission";
		}
		if (continuation.version !== lease.continuationVersion) {
			return (
				`durable continuation version changed before provider submission ` +
				`(expected ${lease.continuationVersion}, have ${continuation.version})`
			);
		}
		const active = continuation.activeAttempt;
		if (
			!active ||
			active.state !== "intent-recorded" ||
			active.attemptId !== lease.attemptId ||
			active.phaseId !== lease.phaseId ||
			active.providerName !== lease.providerName
		) {
			return "durable dispatch intent changed before provider submission";
		}
		return undefined;
	}

	/**
	 * Check authority after the durable intent is journaled and immediately
	 * before a provider side effect. ScriptExecutionProvider additionally runs
	 * its reserve → spawn → durable-ack block under the returned synchronous
	 * fence. Remote/generic providers still need their own credentialed fencing
	 * and recovery protocol before P13 can close.
	 */
	function authorizeProviderSubmit(
		run: RunProjection,
		continuation: RunContinuation,
		attempt: DurableDispatchAttempt,
	): ProviderSubmitAuthorization {
		if (!hasMutationAuthority()) {
			return {
				allowed: false,
				code: "TF_AUTHORITY_REVOKED",
				message:
					"ControlHost lost mutation authority after recording durable dispatch intent; " +
					"provider submit was suppressed and the authoritative writer must reconcile the attempt",
			};
		}
		const lease: ProviderSubmissionLease = {
			runId: run.runId,
			runVersion: run.runVersion,
			continuationId: continuation.continuationId,
			continuationVersion: continuation.version,
			attemptId: attempt.attemptId,
			phaseId: attempt.phaseId,
			providerName: attempt.providerName,
		};
		const staleReason = staleSubmissionLeaseReason(lease);
		if (staleReason) {
			return {
				allowed: false,
				code: "TF_RECONCILE_REQUIRED",
				message: `${staleReason}; provider submit was suppressed and the run requires reconciliation`,
			};
		}
		return {
			allowed: true,
			submissionFence: {
				execute: <T>(operation: () => T): T =>
						withProviderSideEffectFence(lease.runId, () => {
						if (!hasMutationAuthority()) {
							throw new ProviderSubmissionLeaseError(
								"TF_AUTHORITY_REVOKED",
								"singleton writer lost authority before provider submit critical section",
							);
						}
						const fencedStaleReason = staleSubmissionLeaseReason(lease);
						if (fencedStaleReason) {
							throw new ProviderSubmissionLeaseError(
								"TF_RECONCILE_REQUIRED",
								`${fencedStaleReason}; provider submit was suppressed by its durable submission fence`,
							);
						}
						return operation();
						}),
				},
			};
		}

	/**
	 * Cancellation has its own durable requested → signalling protocol. Do not
	 * reuse the synchronous submit fence here: a provider's cancellation API is
	 * asynchronous, so retaining `commit.lock` across it can strand the writer
	 * after a crash boundary. C/S currently protects submit only; cancellation
	 * routing is strict and unresolved cases remain reconciler-owned.
	 */
	function authorizeProviderCancel(): ProviderSubmissionFence | null {
		if (!hasMutationAuthority()) return null;
		return {
			execute: <T>(operation: () => T): T =>
				runDurableMutation(() => {
					if (!hasMutationAuthority()) {
						throw new SingletonAuthorityError(
							"singleton writer lost authority before provider cancellation critical section",
						);
					}
					return operation();
				}),
		};
	}

	function cancelReconcileRequired(
		run: RunProjection,
		commandId: string,
		message: string,
		sideEffects: "possible" | "unknown",
	): AdmitResult {
		const error: ControlError = {
			code: "TF_RECONCILE_REQUIRED",
			message,
			recoveryAction: "reconcile",
			sideEffects,
			commandId,
			projectId: store.header.projectId,
			controlDomainId: store.header.controlDomainId,
		};
		return { ok: false, run, error, snapshot: { run, controlError: error, receipt: null } };
	}

	/**
	 * Do not turn a cancellation mutation-fence exception into an uncaught RPC
	 * failure, terminal state, or slot release. Before the initial request is
	 * committed, the same command can be retried through the new writer; once a
	 * durable request exists, preserve its exact snapshot for reconciliation.
	 */
	function cancelAuthorityRevoked(
		run: RunProjection,
		commandId: string,
		message: string,
		sideEffects: "none" | "possible" | "unknown",
		recoveryAction: "retry-same-command" | "reconcile" = "reconcile",
	): AdmitResult {
		const error: ControlError = {
			code: "TF_AUTHORITY_REVOKED",
			message,
			recoveryAction,
			sideEffects,
			commandId,
			projectId: store.header.projectId,
			controlDomainId: store.header.controlDomainId,
		};
		return { ok: false, run, error, snapshot: { run, controlError: error, receipt: null } };
	}

	/**
	 * Preserve the active durable intent when the last pre-submit authority
	 * check fails. In particular, do not terminalize the run or release the
	 * reservation: either action could let a new writer misclassify the intent
	 * as safely absent.
	 */
	function providerSubmitDenied(
		run: RunProjection,
		commandId: string,
		denial: { code: "TF_AUTHORITY_REVOKED" | "TF_RECONCILE_REQUIRED"; message: string },
	): AdmitResult {
		const current = store.getRun(run.runId) ?? run;
		if (current.cancelRequest) {
			return cancelReconcileRequired(
				current,
				current.cancelRequest.commandId,
				"durable cancellation won before provider submission; the cancellation remains authoritative and requires reconciliation",
				"unknown",
			);
		}
		if (denial.code === "TF_RECONCILE_REQUIRED") {
			const error = reconcileRequiredError(denial.message, {
				commandId,
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
			});
			return { ok: false, run: current, error, snapshot: { run: current, controlError: error, receipt: null } };
		}
		const error: ControlError = {
			code: denial.code,
			message: denial.message,
			recoveryAction: "retry-same-command",
			sideEffects: "none",
			commandId,
			projectId: store.header.projectId,
			controlDomainId: store.header.controlDomainId,
		};
		return { ok: false, run: current, error, snapshot: { run: current, controlError: error, receipt: null } };
	}

	/**
	 * Provider work may already exist, but this epoch could not persist its
	 * project-journal acknowledgement. Retain the original intent/reservation and
	 * report a possible side effect; only a future authoritative recovery owner
	 * may resolve the provider handle.
	 */
	function providerDispatchAcknowledgementLost(
		run: RunProjection,
		commandId: string,
		loss: { phaseId: string; providerName: string; handle: string; message: string },
	): AdmitResult {
		const error: ControlError = {
			code: "TF_AUTHORITY_REVOKED",
			message:
				`${loss.message}; provider ${loss.providerName} accepted phase ${loss.phaseId} ` +
				`with handle ${loss.handle}, but DispatchAcknowledged was not durably recorded`,
			recoveryAction: "reconcile",
			sideEffects: "possible",
			commandId,
			projectId: store.header.projectId,
			controlDomainId: store.header.controlDomainId,
		};
		return { ok: false, run, error, snapshot: { run, controlError: error, receipt: null } };
	}

	/**
	 * An accepted opaque handle that cannot be proven provider-owned is a
	 * possible side effect, not a failed phase. For a new acknowledgement, retain
	 * the exact `intent-recorded` continuation and never persist the handle. For
	 * a historical acknowledgement whose record can no longer be proven, retain
	 * that historical evidence but never observe or terminalize it. In both
	 * cases, make an operator-owned reconcile state durable.
	 */
	function providerDispatchHandleInvalid(
		run: RunProjection,
		continuation: RunContinuation,
		checkpoint: SchedulerCheckpoint,
		commandId: string,
		invalid: {
			phaseId: string;
			providerName: string;
			handle: string;
			stage: "acknowledgement" | "terminal-observation";
			reason: string;
		},
	): AdmitResult {
		const handling =
			invalid.stage === "acknowledgement"
				? "the handle was not acknowledged or observed"
				: "the historical acknowledgement was not treated as ownership proof, and the handle was not observed";
		const message =
			`provider ${invalid.providerName} returned handle ${invalid.handle} for phase ${invalid.phaseId}, ` +
			`but durable ownership verification failed before ${invalid.stage}: ${invalid.reason}; ${handling}`;
		try {
			const persisted = commitContinuation(run, continuation, checkpoint, {
				status: "active",
				runPatch: {
					status: "unknown",
					stage: "reconciling",
					needsOperator: true,
					error: message,
				},
				extraEvents: [
					makeEvent(run.runId, { type: "ReconcileStarted", runId: run.runId, attempt: 1 }, commandId),
					makeEvent(run.runId, { type: "ReconcileSettled", runId: run.runId, outcome: "exhausted" }, commandId),
					makeEvent(
						run.runId,
						{ type: "NeedsOperator", runId: run.runId, code: "TF_RECONCILE_REQUIRED" },
						commandId,
					),
				],
			});
			try {
				if (persisted.run.reservationId) {
					coordinator.markOrphanSuspect(persisted.run.reservationId);
				}
			} catch {
				// Retaining a committed reservation is fail-closed if the coordinator
				// cannot record the stronger orphan-suspect projection.
			}
			const error = reconcileRequiredError(message, {
				commandId,
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
			});
			return {
				ok: false,
				run: persisted.run,
				error,
				snapshot: { run: persisted.run, controlError: error, receipt: null },
			};
		} catch (error) {
			const conflict = schedulerMutationConflict(run.runId, commandId, error);
			if (conflict) return conflict;
			if (error instanceof SingletonAuthorityError) {
				return pendingDispatchAuthorityRevoked(
					store.getRun(run.runId) ?? run,
					commandId,
					"writer lost authority while retaining an unverified provider handle",
				);
			}
			throw error;
		}
	}

	function pendingDispatchAuthorityRevoked(
		run: RunProjection,
		commandId: string,
		message: string,
	): AdmitResult {
		const error: ControlError = {
			code: "TF_AUTHORITY_REVOKED",
			message,
			recoveryAction: "reconcile",
			sideEffects: "possible",
			commandId,
			projectId: store.header.projectId,
			controlDomainId: store.header.controlDomainId,
		};
		return { ok: false, run, error, snapshot: { run, controlError: error, receipt: null } };
	}

	/**
	 * Fail-closed quiescent check (D9/D38).
	 * Restart must not treat unknown non-terminal provider state as quiescent.
	 * When isLive is available it is authoritative (supports explicit quiesceAll in tests
	 * and pid checks in ScriptExecutionProvider).
	 */
	function providerQuiescent(runId: string): boolean {
		const run = store.getRun(runId);
		if (!run) return true;
		if (isTerminalRunStatus(run.status) && !run.needsOperator) return true;

		const route = resolveDurableProviderRoute(run);
		if (!route.ok) return false;
		const { provider, identity } = route;

		try {
			// A provider-local `isLive` answer is useful only after a durable handle
			// record proves that this provider owns this exact run/phase attempt.
			// No loadHandle means no restart-safe containment proof.
			if (providerHandleRecordFailure(provider, identity)) return false;
			if (typeof provider.isLive === "function") return !provider.isLive(identity.handle);
			const record = provider.loadHandle?.(identity.handle);
			return (
				record?.status === "completed" || record?.status === "failed" || record?.status === "cancelled"
			);
		} catch {
			// A provider observation can fail after an external cancel boundary. It
			// must make quiescence unproven, never reject the command before it can
			// be journaled as ambiguous and reconciled.
			return false;
		}
	}

	function casError(
		code: "TF_STALE_VERSION" | "TF_NOT_FOUND" | "TF_INVALID_ARGUMENT",
		message: string,
		run?: RunProjection,
	): AdmitResult {
		return {
			ok: false,
			run,
			error: {
				code,
				message,
				recoveryAction: code === "TF_STALE_VERSION" ? "refresh" : code === "TF_NOT_FOUND" ? "none" : "refresh",
				sideEffects: "none",
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
			},
			snapshot: run ? { run } : undefined,
		};
	}

	type JournalRunSnapshot = ReturnType<ProjectControlStore["getJournalRunSnapshot"]>;

	function durabilityFailure(
		run: RunProjection | undefined,
		commandId: string,
		message: string,
	): AdmitResult {
		const controlError: ControlError = {
			code: "TF_DURABILITY_FAILED",
			message,
			recoveryAction: "operator",
			sideEffects: "unknown",
			commandId,
			projectId: store.header.projectId,
			controlDomainId: store.header.controlDomainId,
		};
		return run
			? { ok: false, run, error: controlError, snapshot: { run, controlError, receipt: null } }
			: { ok: false, error: controlError };
	}

	function reconcileDisclosure(
		run: RunProjection,
		commandId: string,
		message: string,
		sideEffects: "none" | "unknown" = "unknown",
	): AdmitResult {
		const controlError: ControlError = {
			...reconcileRequiredError(message, {
				commandId,
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
			}),
			sideEffects,
		};
		return { ok: false, run, error: controlError, snapshot: { run, controlError, receipt: null } };
	}

	function successfulJournalDisclosure(snapshot: JournalRunSnapshot, commandId: string): AdmitResult {
		const run = snapshot.run;
		if (!run) {
			return durabilityFailure(undefined, commandId, "journal snapshot has no durable Run to disclose");
		}
		return {
			ok: true,
			run,
			receipt: snapshot.receipt ?? undefined,
			snapshot: { run, receipt: snapshot.receipt },
		};
	}

	/**
	 * Classify an existing admission from exactly one journal-derived Run view.
	 * Success is restricted to a receipted completed Run, a quiescent parked Run,
	 * or an executing Run with an acknowledged provider handle. In particular,
	 * `intent-recorded` precedes provider.submit and is not a recovery owner.
	 */
	function executingAdmissionDisclosure(snapshot: JournalRunSnapshot, commandId: string): AdmitResult {
		const run = snapshot.run;
		if (!run) {
			return durabilityFailure(undefined, commandId, "admission disappeared from its journal snapshot");
		}
		if (run.needsOperator || run.status === "unknown" || run.stage === "reconciling") {
			return reconcileDisclosure(
				run,
				commandId,
				"admission is already reconciliation-owned; do not disclose a prior state as success",
			);
		}
		if (run.stage === "terminal") {
			if (run.status === "completed") {
				if (!snapshot.receipt || snapshot.receipt.receiptId !== run.receiptId) {
					return durabilityFailure(run, commandId, "completed admission has no matching durable Receipt");
				}
				return successfulJournalDisclosure(snapshot, commandId);
			}
			return {
				ok: false,
				run,
				error: {
					code: "TF_COMMAND_FAILED",
					message: run.error ?? `admission reached terminal ${run.status} without a success Receipt`,
					recoveryAction: "none",
					sideEffects: "possible",
					commandId,
					projectId: store.header.projectId,
					controlDomainId: store.header.controlDomainId,
				},
				snapshot: { run, receipt: null },
			};
		}
		if (run.stage === "parked" && run.status === "paused") {
			return successfulJournalDisclosure(snapshot, commandId);
		}
		if (run.stage !== "executing") {
			return reconcileDisclosure(
				run,
				commandId,
				`admission is ${run.status}/${run.stage} without a verified dispatch or Receipt`,
			);
		}
		const continuation = snapshot.continuation;
		if (!continuation || continuation.continuationId !== run.continuationId) {
			return durabilityFailure(run, commandId, "executing admission has no matching durable continuation");
		}
		if (continuation.activeAttempt?.state === "acknowledged") {
			return successfulJournalDisclosure(snapshot, commandId);
		}
		const state = continuation.activeAttempt?.state;
		return reconcileDisclosure(
			run,
			commandId,
			state === "prepared"
				? "executing admission has only a prepared dispatch record; first provider submission remains recovery-owned"
				: state === "intent-recorded"
					? "executing admission has a pre-submit dispatch intent but no durable dispatch owner; do not disclose success"
					: state === "ambiguous"
						? "executing admission has an ambiguous provider submission; reconciliation remains owner"
						: "executing admission has no durable dispatch attempt; first provider submission remains recovery-owned",
		);
	}

	/**
	 * Native approval persists its approved continuation and admitted Run before
	 * it has a versioned first-dispatch recovery owner. An admitted retry must
	 * therefore stop conservatively; any later state is classified from the same
	 * journal snapshot rather than falling back to an older projection.
	 */
	function nativeApprovalAdmissionDisclosure(snapshot: JournalRunSnapshot, commandId: string): AdmitResult {
		const run = snapshot.run;
		if (!run) {
			return durabilityFailure(undefined, commandId, "native approval disappeared from its journal snapshot");
		}
		if (run.stage !== "admitted") return executingAdmissionDisclosure(snapshot, commandId);
		const continuation = snapshot.continuation;
		if (
			!continuation ||
			continuation.continuationId !== run.continuationId ||
			continuation.status !== "approved" ||
			continuation.activeAttempt !== undefined
		) {
			return durabilityFailure(run, commandId, "admitted native approval has no coherent, ownerless approved continuation");
		}
		if (!run.reservationId) {
			return durabilityFailure(run, commandId, "admitted native approval has no durable coordinator reservation id");
		}
		let reservation;
		try {
			reservation = coordinator.getReservation(run.reservationId);
		} catch (error) {
			return durabilityFailure(
				run,
				commandId,
				`cannot read admitted native approval coordinator reservation: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!reservation) {
			return durabilityFailure(run, commandId, "admitted native approval reservation is missing from the coordinator");
		}
		if (reservation.state === "expired") {
			return reconcileDisclosure(
				run,
				commandId,
				"native approval reservation expired after project admission and before provider dispatch; the approved continuation remains operator-owned",
				"none",
			);
		}
		return reconcileDisclosure(
			run,
			commandId,
			"native approval is admitted without a durable first dispatch owner; do not disclose or replay it as success",
		);
	}

	/**
	 * P15 is deliberately fail-closed until a parked attempt has a durable,
	 * provider-verifiable continuation protocol. The current projection records
	 * only the last provider handle, not an immutable resume cursor/attempt plan;
	 * re-running the original flow could duplicate already completed side
	 * effects. An approval decision must therefore never manufacture terminal
	 * success or a Receipt merely because a human clicked approve/edit.
	 */
	function approvalContinuationUnavailable(
		runId: string,
		expectedRunVersion: number | undefined,
		operation: "approve" | "edit",
	): AdmitResult {
		const run = store.getRun(runId);
		if (!run) return casError("TF_NOT_FOUND", `run ${runId} not found`);
		if (expectedRunVersion !== undefined && run.runVersion !== expectedRunVersion) {
			return casError(
				"TF_STALE_VERSION",
				`expected runVersion ${expectedRunVersion}, have ${run.runVersion}`,
				run,
			);
		}
		if (run.stage === "terminal" || run.receiptId) {
			return casError("TF_INVALID_ARGUMENT", `run is terminal/has Receipt; cannot ${operation}`, run);
		}
		if (run.status !== "paused" || run.stage !== "parked") {
			return casError(
				"TF_INVALID_ARGUMENT",
				`${operation} requires paused+parked run (have status=${run.status} stage=${run.stage})`,
				run,
			);
		}
		const approval = loadApprovalForRun(store.projectRoot, runId);
		if (!approval || approval.status !== "pending" || approval.approvalRequestId !== run.approvalRequestId) {
			return casError("TF_INVALID_ARGUMENT", "parked run has no matching pending ApprovalRequest", run);
		}
		return {
			ok: false,
			run,
			error: {
				code: "TF_FEATURE_REQUIRED",
				message:
					`cannot ${operation} parked run without a durable provider continuation; ` +
					"the run remains parked and no Receipt was issued",
				recoveryAction: "operator",
				sideEffects: "none",
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
			},
			snapshot: { run, receipt: null },
		};
	}

	function emit(
		run: RunProjection,
		payload: ControlEvent["payload"],
		command?: Parameters<ProjectControlStore["commit"]>[0]["command"],
		receipt?: Receipt,
		eventId?: string,
	): RunProjection {
		const ev: ControlEvent = {
			eventId: eventId ?? newId("ev"),
			schemaVersion: 1,
			controlDomainId: store.header.controlDomainId,
			streamId: run.runId,
			streamSeq: 0,
			commitSeq: 0,
			projectId: store.header.projectId,
			recordedAt: Date.now(),
			payload,
			commandId: command?.commandId,
		};
		return emitMany(run, [ev], command, receipt);
	}

	function emitMany(
		run: RunProjection,
		events: ControlEvent[],
		command?: Parameters<ProjectControlStore["commit"]>[0]["command"],
		receipt?: Receipt,
	): RunProjection {
		store.commit({ command, events, run, receipt });
		return store.getRun(run.runId) ?? run;
	}

	/**
	 * A scheduler callback lost its durable linearization point. It is not a
	 * provider failure: the caller must stop advancing the stale cursor and let
	 * the current Run state decide recovery.
	 */
	class SchedulerMutationConflictError extends Error {
		readonly run?: RunProjection;

		constructor(message: string, run?: RunProjection) {
			super(message);
			this.name = "SchedulerMutationConflictError";
			this.run = run;
		}
	}

	function schedulerMutationConflict(
		runId: string,
		commandId: string,
		error: unknown,
	): AdmitResult | undefined {
		if (!(error instanceof SchedulerMutationConflictError || error instanceof ControlStoreDurabilityError)) {
			return undefined;
		}
		const current = store.getRun(runId) ?? (error instanceof SchedulerMutationConflictError ? error.run : undefined);
		if (!current) return undefined;
		if (current.cancelRequest) {
			return cancelReconcileRequired(
				current,
				current.cancelRequest.commandId,
				"a scheduler mutation lost its version fence after durable cancellation; " +
					"the cancellation remains authoritative and requires reconciliation",
				"possible",
			);
		}
		if (error instanceof ControlStoreDurabilityError) {
			const controlError: ControlError = {
				code: "TF_DURABILITY_FAILED",
				message:
					`a scheduler durable mutation failed without a competing cancellation: ${error.message}; ` +
					"do not advance, release, or retry the run until an operator verifies the journal",
				recoveryAction: "operator",
				sideEffects: "unknown",
				commandId,
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
			};
			return {
				ok: false,
				run: current,
				error: controlError,
				snapshot: { run: current, controlError, receipt: null },
			};
		}
		const controlError = reconcileRequiredError(
			"scheduler mutation lost its durable version/continuation fence; do not advance or release the run",
			{
				commandId,
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
			},
		);
		return { ok: false, run: current, error: controlError, snapshot: { run: current, controlError, receipt: null } };
	}

	function makeEvent(
		runId: string,
		payload: ControlEvent["payload"],
		commandId?: string,
	): ControlEvent {
		return {
			eventId: newId("ev"),
			schemaVersion: 1,
			controlDomainId: store.header.controlDomainId,
			streamId: runId,
			streamSeq: 0,
			commitSeq: 0,
			projectId: store.header.projectId,
			recordedAt: Date.now(),
			payload,
			commandId,
		};
	}

	/**
	 * Persist one native scheduler cursor advance in the project journal. The
	 * caller holds the in-memory latest object only as a convenience; the next
	 * host reconstructs the same state through `store.getContinuation`.
	 */
	function commitContinuation(
		run: RunProjection,
		continuation: RunContinuation,
		checkpoint: SchedulerCheckpoint,
		opts: {
			status?: RunContinuation["status"];
			approvalPhaseId?: string;
			approvalRequestId?: string;
			runPatch?: Partial<RunProjection>;
			extraEvents?: ControlEvent[];
			command?: Parameters<ProjectControlStore["commit"]>[0]["command"];
		} = {},
	): { run: RunProjection; continuation: RunContinuation } {
		const now = Date.now();
		const {
			activeAttempt: _previousActiveAttempt,
			nextPhaseId: _previousNextPhaseId,
			approvalPhaseId: previousApprovalPhaseId,
			approvalRequestId: previousApprovalRequestId,
			...continuationBase
		} = continuation;
		const nextContinuation: RunContinuation = {
			...continuationBase,
			status: opts.status ?? continuation.status,
			phaseAttempts: checkpoint.phaseAttempts.map((attempt) => ({ ...attempt })),
			phaseOutputs: { ...checkpoint.phaseOutputs },
			...(checkpoint.activeAttempt === undefined
				? {}
				: { activeAttempt: { ...checkpoint.activeAttempt } }),
			...(checkpoint.nextPhaseId === undefined ? {} : { nextPhaseId: checkpoint.nextPhaseId }),
			...(opts.approvalPhaseId === undefined
				? previousApprovalPhaseId === undefined
					? {}
					: { approvalPhaseId: previousApprovalPhaseId }
				: { approvalPhaseId: opts.approvalPhaseId }),
			...(opts.approvalRequestId === undefined
				? previousApprovalRequestId === undefined
					? {}
					: { approvalRequestId: previousApprovalRequestId }
				: { approvalRequestId: opts.approvalRequestId }),
			updatedAt: now,
			version: continuation.version + 1,
		};
		const cas = store.compareAndCommit({
			runId: run.runId,
			expectedRunVersion: run.runVersion,
			validate: (current) => {
				if (current.cancelRequest) {
					return "scheduler continuation cannot advance a run with a durable cancellation request";
				}
				if (current.continuationId !== continuation.continuationId) {
					return "scheduler continuation identity changed before checkpoint commit";
				}
				const durableContinuation = store.getContinuation(run.runId);
				if (
					!durableContinuation ||
					durableContinuation.continuationId !== continuation.continuationId ||
					durableContinuation.version !== continuation.version
				) {
					return "scheduler continuation version changed before checkpoint commit";
				}
				return null;
			},
			build: (current) => {
				const nextRun: RunProjection = {
					...current,
					...opts.runPatch,
					continuationId: nextContinuation.continuationId,
					updatedAt: now,
					runVersion: current.runVersion + 1,
				};
				const continuationEvent = makeEvent(
					nextRun.runId,
					{ type: "ContinuationStored", continuation: nextContinuation },
					opts.command?.commandId,
				);
				return {
					run: nextRun,
					events: [...(opts.extraEvents ?? []), continuationEvent],
					command: opts.command,
				};
			},
		});
		if (!cas.ok) {
			throw new SchedulerMutationConflictError(cas.message, cas.run ?? run);
		}
		return { run: cas.run, continuation: nextContinuation };
	}

	function nextPhaseAfter(boundPlan: BoundPlan, phaseId: string): string | undefined {
		const program = boundPlan.program as { phases?: unknown };
		if (!Array.isArray(program.phases)) return undefined;
		const phases = program.phases.filter(
			(phase): phase is PhaseRecord =>
				!!phase && typeof phase === "object" && typeof (phase as PhaseRecord).id === "string",
		);
		const ordered = topoOrderPhases(phases);
		if (!ordered) return undefined;
		const index = ordered.findIndex((phase) => phase.id === phaseId);
		return index >= 0 ? ordered[index + 1]?.id : undefined;
	}

	function issueReceipt(
		run: RunProjection,
		boundPlan: BoundPlan,
		/** When committing in the same batch, pass event ids about to be written. */
		pendingEventIds?: string[],
	): Receipt {
		const events = store.readEvents(1, store.nextCommitSeq());
		const runEvents = events.filter(
			(e) => e.streamId === run.runId || (e.payload as { runId?: string }).runId === run.runId,
		);
		const manifest =
			pendingEventIds && pendingEventIds.length > 0
				? [...runEvents.map((e) => e.eventId), ...pendingEventIds]
				: runEvents.map((e) => e.eventId);
		const receipt: Receipt = {
			receiptId: newId("rcpt"),
			controlDomainId: store.header.controlDomainId,
			projectId: store.header.projectId,
			runId: run.runId,
			boundPlanHash: boundPlan.boundPlanHash,
			boundFragmentHash: run.boundFragmentHash,
			eventManifest: manifest,
			startCommitSeq: runEvents[0]?.commitSeq ?? store.nextCommitSeq(),
			endCommitSeq: store.nextCommitSeq() + Math.max(0, (pendingEventIds?.length ?? 0) - 1),
			artifactRefs: [],
			assurance: {
				journalContinuity: "ok",
				providerOutcome:
					run.status === "completed"
						? "ok"
						: run.status === "cancelled"
							? "cancelled"
							: run.status === "failed"
								? "failed"
								: "unknown",
				// Fail-closed: do not claim artifact integrity without verification.
				artifactIntegrity: "unknown",
				provenance: "ok",
			},
			buildInfo: { packageVersion: "0.3.0", controlSchemaVersion: 1 },
			issuedAt: Date.now(),
		};
		return receipt;
	}

	/**
	 * Resume a scheduler-native approval checkpoint. Legacy externally parked
	 * runs do not enter here: without an immutable plan + checkpoint they remain
	 * deliberately fail-closed through approvalContinuationUnavailable().
	 */
	async function approveNativeContinuation(
		runId: string,
		approvalOpts: { commandId?: string; principal?: string; expectedRunVersion?: number },
	): Promise<AdmitResult | null> {
		const requestedCommandId = approvalOpts.commandId ?? newId("cmd");
		let observedSnapshot: JournalRunSnapshot;
		try {
			observedSnapshot = store.getJournalRunSnapshot(runId);
		} catch (error) {
			return durabilityFailure(
				undefined,
				requestedCommandId,
				`cannot read native approval journal snapshot: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const observedRun = observedSnapshot.run;
		const observedContinuation = observedSnapshot.continuation;
		const observedApproval = observedSnapshot.approval;
		if (
			!observedRun ||
			!observedContinuation ||
			!observedApproval ||
			observedRun.continuationId !== observedContinuation.continuationId ||
			observedApproval.continuationId !== observedContinuation.continuationId
		) {
			return null;
		}
		const boundPlan = store.getBoundPlan(observedRun.boundPlanHash);
		if (!boundPlan) {
			return {
				ok: false,
				run: observedRun,
				error: {
					code: "TF_DURABILITY_FAILED",
					message: "native approval continuation has no immutable BoundPlan snapshot",
					recoveryAction: "operator",
					sideEffects: "unknown",
					projectId: store.header.projectId,
					controlDomainId: store.header.controlDomainId,
				},
				snapshot: { run: observedRun, receipt: null },
			};
		}
		const commandId = requestedCommandId;
		if (!isSafeId(commandId)) {
			return casError("TF_INVALID_ARGUMENT", `unsafe commandId: ${JSON.stringify(commandId)}`, observedRun);
		}
		const principal = approvalOpts.principal ?? "local";
		const requestHash = hashRequest({ runId, decision: "approve", v: 1 });
		// An accepted approval command may have committed its decision but failed
		// admission because capacity was full. Keep that command as the durable
		// authority and retry only its queued continuation; never re-decide the
		// approval or replay the already-settled upstream phases.
		let queuedRetry: { run: RunProjection; continuation: RunContinuation } | undefined;
		const priorCommand = store.getCommand(commandId);
		if (priorCommand) {
			if (priorCommand.requestHash !== requestHash) {
				return {
					ok: false,
					run: observedRun,
					error: {
						code: "TF_IDEMPOTENCY_CONFLICT",
						message: "same approval commandId with different requestHash",
						recoveryAction: "retry-new-command",
						sideEffects: "none",
						commandId,
					},
				};
			}
			if (priorCommand.callerPrincipal !== principal) {
				return {
					ok: false,
					run: observedRun,
					error: {
						code: "TF_CROSS_PRINCIPAL_COMMAND",
						message: "approval command owned by different principal",
						recoveryAction: "none",
						sideEffects: "none",
						commandId,
					},
				};
			}
			let currentSnapshot: JournalRunSnapshot;
			try {
				currentSnapshot = store.getJournalRunSnapshot(runId);
			} catch (error) {
				return durabilityFailure(
					observedRun,
					commandId,
					`cannot read accepted approval command journal snapshot: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const current = currentSnapshot.run;
			if (!current) {
				return durabilityFailure(observedRun, commandId, "accepted approval command has no durable Run snapshot");
			}
			const currentReceipt = currentSnapshot.receipt;
			if (current.status === "running" && current.stage === "queued" && !current.reservationId) {
				const currentContinuation = currentSnapshot.continuation;
				if (
					!currentContinuation ||
					current.continuationId !== currentContinuation.continuationId ||
					current.boundPlanHash !== boundPlan.boundPlanHash ||
					currentContinuation.boundPlanHash !== boundPlan.boundPlanHash ||
					currentContinuation.status !== "approved"
				) {
					return {
						ok: false,
						run: current,
						error: {
							code: "TF_DURABILITY_FAILED",
							message:
								"accepted approval command has no matching queued native continuation",
							recoveryAction: "operator",
							sideEffects: "unknown",
							commandId,
							projectId: store.header.projectId,
							controlDomainId: store.header.controlDomainId,
						},
						snapshot: { run: current, receipt: currentReceipt },
					};
				}
				queuedRetry = { run: current, continuation: currentContinuation };
			} else {
				return nativeApprovalAdmissionDisclosure(currentSnapshot, commandId);
			}
		}

		let run: RunProjection;
		let continuation: RunContinuation;
		if (queuedRetry) {
			run = queuedRetry.run;
			continuation = queuedRetry.continuation;
		} else {
			let resumedContinuation: RunContinuation | undefined;
			const cas = store.compareAndCommit({
				runId,
				expectedRunVersion: approvalOpts.expectedRunVersion,
				validate: (run) => {
					if (run.status !== "paused" || run.stage !== "parked") {
						return `approve requires paused+parked run (have ${run.status}/${run.stage})`;
					}
					const continuation = store.getContinuation(runId);
					const approval = store.getApprovalForRun(runId);
					if (
						!continuation ||
						!approval ||
						run.continuationId !== continuation.continuationId ||
						approval.continuationId !== continuation.continuationId ||
						approval.approvalRequestId !== run.approvalRequestId ||
						approval.status !== "pending" ||
						continuation.status !== "parked" ||
						!approval.phaseId ||
						continuation.approvalPhaseId !== approval.phaseId
					) {
						return "parked run has no matching native approval continuation";
					}
					if (continuation.phaseAttempts.some((attempt) => attempt.phaseId === approval.phaseId)) {
						return "native approval phase is already settled";
					}
					const decision = transitionApproval(approval, {
						decision: "approve",
						principal,
						commandId,
					});
					return decision.ok ? null : decision.message;
				},
				build: (run) => {
					const continuation = store.getContinuation(runId)!;
					const approval = store.getApprovalForRun(runId)!;
					const decision = transitionApproval(approval, {
						decision: "approve",
						principal,
						commandId,
					});
					if (!decision.ok) {
						throw new Error(`approval transition changed after validation: ${decision.message}`);
					}
					const approvalOutput = "approved";
					const approvalAttempt = {
						phaseId: approval.phaseId!,
						type: "approval",
						status: "completed" as const,
						attemptId: `apr-${approval.approvalRequestId}`,
						output: approvalOutput,
					};
					const {
						activeAttempt: _activeAttempt,
						nextPhaseId: _nextPhaseId,
						...continuationBase
					} = continuation;
					const nextContinuation: RunContinuation = {
						...continuationBase,
						status: "approved",
						phaseAttempts: [...continuation.phaseAttempts, approvalAttempt],
						phaseOutputs: { ...continuation.phaseOutputs, [approval.phaseId!]: approvalOutput },
						...(nextPhaseAfter(boundPlan, approval.phaseId!) === undefined
							? {}
							: { nextPhaseId: nextPhaseAfter(boundPlan, approval.phaseId!) }),
						updatedAt: Date.now(),
						version: continuation.version + 1,
					};
					resumedContinuation = nextContinuation;
					const nextRun: RunProjection = {
						...run,
						status: "running",
						stage: "queued",
						reservationId: undefined,
						updatedAt: Date.now(),
						runVersion: run.runVersion + 1,
					};
					const command = {
						commandId,
						requestHash,
						callerPrincipal: principal,
						authorizationContextHash: hashRequest({ principal }),
						projectId: store.header.projectId,
						controlDomainId: store.header.controlDomainId,
						kind: "approve",
						status: "accepted" as const,
						firstCommitSeq: 0,
						lastCommitSeq: 0,
						runId,
						recordedAt: Date.now(),
					};
					return {
						run: nextRun,
						command,
						events: [
							makeEvent(runId, { type: "ApprovalRequestStored", approval: decision.request }, commandId),
							makeEvent(
								runId,
								{
									type: "ApprovalDecided",
									runId,
									approvalRequestId: approval.approvalRequestId,
									decision: "approve",
								},
								commandId,
							),
							makeEvent(
								runId,
								{ type: "RunStatusChanged", runId, status: "running", stage: "queued", reason: "approval approved" },
								commandId,
							),
							makeEvent(
								runId,
								{ type: "ContinuationStored", continuation: nextContinuation },
								commandId,
							),
						],
					};
				},
			});
			if (!cas.ok) return casError(cas.code, cas.message, cas.run);
			if (!resumedContinuation) {
				return {
					ok: false,
					run: cas.run,
					error: {
						code: "TF_DURABILITY_FAILED",
						message: "approval decision committed without a continuation checkpoint",
						recoveryAction: "operator",
						sideEffects: "unknown",
					},
				};
			}
			run = cas.run;
			continuation = resumedContinuation;
		}
			const reservation = coordinator.reserve();
		if (!reservation) {
			return {
				ok: false,
				run,
				error: {
					code: "TF_CAPACITY_EXCEEDED",
					message: `maxActiveRuns=${coordinator.maxActiveRuns} capacity full; approval is queued`,
					recoveryAction: "retry-same-command",
					sideEffects: "none",
					commandId,
					projectId: store.header.projectId,
					controlDomainId: store.header.controlDomainId,
				},
				snapshot: { run, receipt: null },
			};
		}
		// Capacity reservation alone is not permission to dispatch. Atomically bind
		// it to the still-queued continuation first, so two deliveries of the same
		// accepted approval command cannot both schedule the downstream provider.
		let admittedContinuation: RunContinuation | undefined;
		const admission = store.compareAndCommit({
			runId,
			validate: (current) => {
				if (current.status !== "running" || current.stage !== "queued" || current.reservationId) {
					return `approved continuation is no longer queued (have ${current.status}/${current.stage})`;
				}
				const durableContinuation = store.getContinuation(runId);
				if (
					!durableContinuation ||
					current.continuationId !== continuation.continuationId ||
					current.boundPlanHash !== boundPlan.boundPlanHash ||
					durableContinuation.continuationId !== continuation.continuationId ||
					durableContinuation.boundPlanHash !== boundPlan.boundPlanHash ||
					durableContinuation.status !== "approved" ||
					durableContinuation.activeAttempt !== undefined
				) {
					return "queued run has no matching approved native continuation";
				}
				return null;
			},
			build: (current) => {
				const durableContinuation = store.getContinuation(runId);
				if (!durableContinuation) {
					throw new Error("approved native continuation disappeared during admission");
				}
				admittedContinuation = durableContinuation;
				const admitted: RunProjection = {
					...current,
					reservationId: reservation.reservationId,
					stage: "admitted",
					status: "running",
					updatedAt: Date.now(),
					runVersion: current.runVersion + 1,
				};
				return {
					run: admitted,
					events: [makeEvent(runId, { type: "RunAdmitted", runId, reservationId: reservation.reservationId })],
				};
			},
		});
		if (!admission.ok) {
			try {
				coordinator.releaseUnboundReservation(reservation.reservationId);
			} catch {
				/* retain a reservation if its release cannot be proven */
			}
			let currentSnapshot: JournalRunSnapshot;
			try {
				currentSnapshot = store.getJournalRunSnapshot(runId);
			} catch (error) {
				return durabilityFailure(
					admission.run,
					commandId,
					`cannot read competing native approval journal snapshot: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const current = currentSnapshot.run;
			if (!current) {
				return durabilityFailure(admission.run, commandId, "competing native approval has no durable Run snapshot");
			}
			// A competing delivery already owns the same accepted command. Idempotent
			// retries classify its one coherent journal view instead of composing a
			// stale CAS projection with a later continuation or Receipt.
			if (current && (current.stage !== "queued" || current.reservationId)) {
				return nativeApprovalAdmissionDisclosure(currentSnapshot, commandId);
			}
			return casError(admission.code, admission.message, current ?? undefined);
		}
		run = admission.run;
		continuation = admittedContinuation ?? continuation;
		try {
		coordinator.commitReservation(reservation.reservationId, {
			projectId: store.header.projectId,
			projectControlDomainId: store.header.controlDomainId,
			runId,
			projectAdmitCommitSeq: admission.commitSeqEnd,
		});
		run = emit(
			{
				...run,
				stage: "executing",
				status: "running",
				updatedAt: Date.now(),
				runVersion: run.runVersion + 1,
			},
			{ type: "RunStatusChanged", runId, status: "running", stage: "executing" },
		);

		const scheduled = await schedulePhases(boundPlan.program, { script: scriptProvider, llm: llmProvider }, {
			runId,
			admissionId: run.admissionId,
			cwd: opts.projectRoot,
			phaseDeadlineMs: reconcileBudget.deadlineMs ?? 60_000,
			continuation,
			onDispatchIntent: (attempt) => {
				const checkpoint: SchedulerCheckpoint = {
					phaseAttempts: continuation.phaseAttempts,
					phaseOutputs: continuation.phaseOutputs,
					activeAttempt: attempt,
					nextPhaseId: attempt.phaseId,
				};
				const prepared: DurableDispatchAttempt = {
					...attempt,
					state: "prepared",
					updatedAt: attempt.createdAt,
				};
				const persisted = commitContinuation(run, continuation, checkpoint, {
					status: "active",
					extraEvents: [
						makeEvent(runId, {
							type: "AttemptPrepared",
							runId,
							continuationId: continuation.continuationId,
							attempt: prepared,
						}),
						makeEvent(runId, {
							type: "DispatchIntentRecorded",
							runId,
							continuationId: continuation.continuationId,
							attempt,
						}),
					],
				});
				run = persisted.run;
				continuation = persisted.continuation;
			},
			beforeProviderSubmit: (attempt) => authorizeProviderSubmit(run, continuation, attempt),
			onDispatchAcknowledged: (attempt) => {
				const checkpoint: SchedulerCheckpoint = {
					phaseAttempts: continuation.phaseAttempts,
					phaseOutputs: continuation.phaseOutputs,
					activeAttempt: attempt,
					nextPhaseId: attempt.phaseId,
				};
				const persisted = commitContinuation(run, continuation, checkpoint, {
					status: "active",
					runPatch: { providerHandle: attempt.providerHandle, providerName: attempt.providerName },
					extraEvents: [
						makeEvent(runId, {
							type: "DispatchAcknowledged",
							runId,
							continuationId: continuation.continuationId,
							attempt,
						}),
					],
				});
				run = persisted.run;
				continuation = persisted.continuation;
			},
			onCheckpoint: (checkpoint) => {
				const persisted = commitContinuation(run, continuation, checkpoint, { status: "active" });
				run = persisted.run;
				continuation = persisted.continuation;
			},
		});

		if (scheduled.dispatchAcknowledgementLost) {
			return providerDispatchAcknowledgementLost(run, commandId, scheduled.dispatchAcknowledgementLost);
		}
		if (scheduled.dispatchHandleInvalid) {
			return providerDispatchHandleInvalid(
				run,
				continuation,
				scheduled.checkpoint,
				commandId,
				scheduled.dispatchHandleInvalid,
			);
		}
		if (scheduled.dispatchDenied) {
			return providerSubmitDenied(run, commandId, scheduled.dispatchDenied);
		}
		if (scheduled.parked) {
			const approval = newApprovalRequest({
				runId,
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
				expectedRunVersion: run.runVersion + 1,
				deadline: Date.now() + 3_600_000,
				continuationId: continuation.continuationId,
				phaseId: scheduled.parked.phaseId,
				message: scheduled.parked.message,
			});
			const parked = commitContinuation(run, continuation, scheduled.checkpoint, {
				status: "parked",
				approvalPhaseId: scheduled.parked.phaseId,
				approvalRequestId: approval.approvalRequestId,
				runPatch: {
					status: "paused",
					stage: "parked",
					approvalRequestId: approval.approvalRequestId,
					reservationId: undefined,
				},
				extraEvents: [
					makeEvent(runId, { type: "ApprovalRequestStored", approval }),
					makeEvent(runId, {
						type: "ApprovalParked",
						runId,
						approvalRequestId: approval.approvalRequestId,
					}),
				],
			});
			run = parked.run;
			try {
				coordinator.normalRelease(reservation.reservationId, {
					noLiveOrAmbiguousSideEffects: true,
					runIsTerminal: false,
					runIsParkedAndFutureDispatchRequiresReadmission: true,
				});
			} catch {
				/* safe to retain a slot if cross-store release cannot be proven */
			}
			return { ok: true, run, snapshot: { run, receipt: null } };
		}
		if (scheduled.stillRunning) {
			run = emit(
				{
					...run,
					status: "unknown",
					stage: "reconciling",
					updatedAt: Date.now(),
					runVersion: run.runVersion + 1,
				},
				{ type: "ReconcileStarted", runId, attempt: 1 },
			);
			coordinator.markOrphanSuspect(reservation.reservationId);
			const error = reconcileRequiredError("approval continuation provider is still running", {
				commandId,
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
			});
			return { ok: false, run, error, snapshot: { run, controlError: error, receipt: null } };
		}
		if (!scheduled.ok) {
			const terminal = commitContinuation(run, continuation, scheduled.checkpoint, {
				status: "terminal",
				runPatch: {
					status: "failed",
					stage: "terminal",
					error: scheduled.error,
					finalOutput: Object.values(scheduled.phaseOutputs).join("\n") || undefined,
				},
			});
			run = terminal.run;
			try {
				coordinator.normalRelease(reservation.reservationId, {
					noLiveOrAmbiguousSideEffects: true,
					runIsTerminal: true,
					runIsParkedAndFutureDispatchRequiresReadmission: false,
				});
			} catch {
				/* keep slot */
			}
			return {
				ok: false,
				run,
				snapshot: { run, receipt: null },
				error: {
					code: "TF_COMMAND_FAILED",
					message: scheduled.error ?? "approval continuation schedule failed",
					recoveryAction: "none",
					sideEffects: "possible",
				},
			};
		}

		const terminal = commitContinuation(run, continuation, scheduled.checkpoint, {
			status: "terminal",
			runPatch: {
				status: "completed",
				stage: "terminal",
				finalOutput: scheduled.finalOutput,
			},
		});
		run = terminal.run;
		coordinator.normalRelease(reservation.reservationId, {
			noLiveOrAmbiguousSideEffects: true,
			runIsTerminal: true,
			runIsParkedAndFutureDispatchRequiresReadmission: false,
		});
		const receiptEventId = newId("ev");
		const receipt = issueReceipt(run, boundPlan, [receiptEventId]);
		const receiptHonest: typeof receipt = {
			...receipt,
			assurance: {
				...receipt.assurance,
				providerOutcome: "ok",
				journalContinuity: "ok",
				artifactIntegrity: "unknown",
				provenance: "unknown",
			},
		};
		run = { ...run, receiptId: receiptHonest.receiptId };
		run = emit(
			run,
			{ type: "ReceiptIssued", runId, receiptId: receiptHonest.receiptId },
			undefined,
			receiptHonest,
			receiptEventId,
		);
		return { ok: true, run, receipt: receiptHonest, snapshot: { run, receipt: receiptHonest } };
			} catch (error) {
				let snapshot: JournalRunSnapshot;
				try {
					snapshot = store.getJournalRunSnapshot(runId);
				} catch (snapshotError) {
					return durabilityFailure(
						run,
						commandId,
						`cannot read native approval journal snapshot after scheduler error: ${snapshotError instanceof Error ? snapshotError.message : String(snapshotError)}`,
					);
				}
				if (
					snapshot.run &&
					(snapshot.run.stage === "admitted" ||
						snapshot.run.stage === "executing" ||
						snapshot.run.stage === "terminal" ||
						snapshot.run.stage === "reconciling" ||
						snapshot.run.status === "unknown")
				) {
					return nativeApprovalAdmissionDisclosure(snapshot, commandId);
				}
				const conflict = schedulerMutationConflict(runId, commandId, error);
				if (conflict) return conflict;
				throw error;
		}
	}

	const host: ControlHost = {
		get projectId() {
			return store.header.projectId;
		},
		get controlDomainId() {
			return store.header.controlDomainId;
		},
		controlMode,
		role,
		get canMutate() {
			return hasMutationAuthority();
		},
		singleton,
		store,
		registry,
		coordinator,

		async admitAndRun(req: AdmitRequest): Promise<AdmitResult> {
			const commandId = req.commandId ?? newId("cmd");
			if (!isSafeId(commandId)) {
				return {
					ok: false,
					error: {
						code: "TF_INVALID_ARGUMENT",
						message: `unsafe commandId: ${JSON.stringify(commandId)}`,
						recoveryAction: "retry-new-command",
						sideEffects: "none",
					},
				};
			}
			const principal = req.callerPrincipal ?? "local";
			const requestHash = hashRequest({ program: req.program, v: 1 });

			// Idempotent disclosure is allowed for attach (read-only return of a
			// completed/in-progress run). A P16 admission intent is different: it
			// has a durable same-command recovery owner and must not be collapsed
			// into the old "accepted command, missing Run" error path.
			const priorCmd = store.getCommand(commandId);
			let admission: AdmissionIntent | undefined;
			if (priorCmd) {
				if (priorCmd.requestHash !== requestHash) {
					return {
						ok: false,
						error: {
							code: "TF_IDEMPOTENCY_CONFLICT",
							message: "same commandId with different requestHash",
							recoveryAction: "retry-new-command",
							sideEffects: "none",
							commandId,
						},
					};
				}
				// Re-auth disclosure: same principal only in 0.3 simple check
				if (priorCmd.callerPrincipal !== principal) {
					return {
						ok: false,
						error: {
							code: "TF_CROSS_PRINCIPAL_COMMAND",
							message: "command owned by different principal",
							recoveryAction: "none",
							sideEffects: "none",
							commandId,
						},
					};
				}
				if (!priorCmd.admission) {
					// Return the run bound to THIS commandId — never listRuns()[0].
					const boundRunId = store.getRunIdForCommand(commandId) ?? priorCmd.runId;
					if (boundRunId) {
						const match = store.getRun(boundRunId);
						if (match) {
							return {
								ok: true,
								run: match,
								receipt: store.getReceiptForRun(match.runId) ?? undefined,
								snapshot: host.getSnapshot(match.runId) ?? undefined,
							};
						}
					}
					// Command recorded but run missing — do not invent another run's receipt.
					return {
						ok: false,
						error: {
							code: "TF_NOT_FOUND",
							message: `command ${commandId} known but bound run not found`,
							recoveryAction: "operator",
							sideEffects: "unknown",
							commandId,
						},
					};
				}
				admission = priorCmd.admission;
				let existingSnapshot: JournalRunSnapshot;
				try {
					existingSnapshot = store.getJournalRunSnapshot(admission.runId);
				} catch (error) {
					return durabilityFailure(
						undefined,
						commandId,
						`cannot read existing admission journal snapshot: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				const existingRun = existingSnapshot.run;
				if (existingRun && existingRun.stage !== "queued" && existingRun.stage !== "admitted") {
					return executingAdmissionDisclosure(existingSnapshot, commandId);
				}
			}

			// New admits and queued-admission recovery require write authority (P13:
			// attach must never become a second saga recovery owner).
			if (!hasMutationAuthority()) return authorityDenied("admitAndRun");

			// P9: refuse new Attempts while recent 0.2-style writers may be active.
			const legacy = probeLegacyConflict(opts.projectRoot);
			if (legacy.conflict) {
				return { ok: false, error: legacyConflictError(legacy) };
			}

			const linked = linkProgram({ program: req.program });
			if (!linked.ok) {
				return {
					ok: false,
					error: {
						code: "TF_INVALID_ARGUMENT",
						message: linked.errors.join("; "),
						recoveryAction: "retry-new-command",
						sideEffects: "none",
					},
				};
			}
			const boundPlan = linked.boundPlan;
			const now = Date.now();

			if (!admission) {
				const newAdmission: AdmissionIntent = {
					schemaVersion: 1,
					admissionId: newId("adm"),
					runId: newId("run"),
					continuationId: newId("cont"),
					boundPlanHash: boundPlan.boundPlanHash,
					state: "queued",
					reservationGeneration: 0,
					createdAt: now,
					updatedAt: now,
				};
				const claim = store.claimAdmissionIntent({
					commandId,
					requestHash,
					callerPrincipal: principal,
					authorizationContextHash: hashRequest({ principal }),
					admission: newAdmission,
				});
				if (claim.kind === "conflict") {
					return {
						ok: false,
						error: {
							code: "TF_IDEMPOTENCY_CONFLICT",
							message: "same commandId with different requestHash",
							recoveryAction: "retry-new-command",
							sideEffects: "none",
							commandId,
						},
					};
				}
				if (claim.command.callerPrincipal !== principal) {
					return {
						ok: false,
						error: {
							code: "TF_CROSS_PRINCIPAL_COMMAND",
							message: "command owned by different principal",
							recoveryAction: "none",
							sideEffects: "none",
							commandId,
						},
					};
				}
				if (!claim.command.admission) {
					return {
						ok: false,
						error: {
							code: "TF_DURABILITY_FAILED",
							message: `command ${commandId} lacks the required admission intent`,
							recoveryAction: "operator",
							sideEffects: "unknown",
							commandId,
						},
					};
				}
				admission = claim.command.admission;
			}

			if (admission.boundPlanHash !== boundPlan.boundPlanHash) {
				return {
					ok: false,
					error: {
						code: "TF_DURABILITY_FAILED",
						message: `command ${commandId} admission plan hash disagrees with its idempotent request`,
						recoveryAction: "operator",
						sideEffects: "unknown",
						commandId,
					},
				};
			}

			const runId = admission.runId;
			let existingAdmissionSnapshot: JournalRunSnapshot;
			try {
				existingAdmissionSnapshot = store.getJournalRunSnapshot(admission.runId);
			} catch (error) {
				return durabilityFailure(
					undefined,
					commandId,
					`cannot read admission recovery journal snapshot: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const existingAdmissionRun = existingAdmissionSnapshot.run;
			if (
				existingAdmissionRun &&
				existingAdmissionRun.stage !== "queued" &&
				existingAdmissionRun.stage !== "admitted"
			) {
				return executingAdmissionDisclosure(existingAdmissionSnapshot, commandId);
			}
			let run: RunProjection;
			let continuation: RunContinuation;
			if (existingAdmissionRun) {
				const durableContinuation = existingAdmissionSnapshot.continuation;
				if (!durableContinuation || durableContinuation.continuationId !== admission.continuationId) {
					return {
						ok: false,
						run: existingAdmissionRun,
						error: {
							code: "TF_DURABILITY_FAILED",
							message: `admission ${admission.admissionId} Run lacks its immutable continuation`,
							recoveryAction: "operator",
							sideEffects: "unknown",
							commandId,
						},
					};
				}
				run = existingAdmissionRun;
				continuation = durableContinuation;
			} else {
				continuation = {
					schemaVersion: 1,
					continuationId: admission.continuationId,
					runId: admission.runId,
					projectId: store.header.projectId,
					controlDomainId: store.header.controlDomainId,
					boundPlanHash: boundPlan.boundPlanHash,
					status: "active",
					phaseAttempts: [],
					phaseOutputs: {},
					createdAt: now,
					updatedAt: now,
					version: 1,
				};
				run = {
					runId: admission.runId,
					projectId: store.header.projectId,
					controlDomainId: store.header.controlDomainId,
					status: "running",
					stage: "queued",
					boundPlanHash: boundPlan.boundPlanHash,
					needsOperator: false,
					admissionId: admission.admissionId,
					createdAt: now,
					updatedAt: now,
					runVersion: 1,
					continuationId: continuation.continuationId,
				};
			}

			// The coordinator stores `admissionId` too, making same-command retries
			// converge on one live reservation rather than racing into two slots.
			const reservation = coordinator.reserve({
				admissionId: admission.admissionId,
			});
			if (!reservation) {
				if (admission.state !== "queued") {
					return {
						ok: false,
						run,
						error: reconcileRequiredError(
							"prepared admission has no recoverable live coordinator reservation",
							{
								commandId,
								projectId: store.header.projectId,
								controlDomainId: store.header.controlDomainId,
							},
						),
					};
				}
				return {
					ok: false,
					error: {
						code: "TF_CAPACITY_EXCEEDED",
						message: `maxActiveRuns=${coordinator.maxActiveRuns} capacity full; admission is queued`,
						recoveryAction: "retry-same-command",
						sideEffects: "none",
						commandId,
						projectId: store.header.projectId,
						controlDomainId: store.header.controlDomainId,
					},
				};
			}

			const prepared = store.prepareAdmission({
				commandId,
				admissionId: admission.admissionId,
				boundPlan,
				continuation,
				run,
				reservation,
			});
			run = prepared.run;
			const durableContinuation = store.getContinuation(run.runId);
			if (!durableContinuation) {
				return {
					ok: false,
					run,
					error: {
						code: "TF_DURABILITY_FAILED",
						message: `prepared admission ${admission.admissionId} lost its continuation checkpoint`,
						recoveryAction: "operator",
						sideEffects: "unknown",
						commandId,
					},
				};
			}
			continuation = durableContinuation;

			let coordinatorCommitSucceeded = false;
			try {
				coordinator.commitReservation(reservation.reservationId, {
					projectId: store.header.projectId,
					projectControlDomainId: store.header.controlDomainId,
					runId: run.runId,
					projectAdmitCommitSeq: prepared.projectAdmitCommitSeq,
					admissionId: admission.admissionId,
				});
				coordinatorCommitSucceeded = true;
				const finalized = store.finalizeAdmission({
					commandId,
					admissionId: admission.admissionId,
					reservationId: reservation.reservationId,
					projectAdmitCommitSeq: prepared.projectAdmitCommitSeq,
				});
				run = finalized.run;
				if (finalized.kind === "existing") {
					return {
						ok: false,
						run,
						error: reconcileRequiredError(
							"another writer finalized this admission; provider dispatch remains recovery-owned",
							{
								commandId,
								projectId: store.header.projectId,
								controlDomainId: store.header.controlDomainId,
							},
						),
					};
				}

			// Dispatch: per-phase schedule (mandate 1) — no whole-flow script shortcut.
			run = {
				...run,
				stage: "executing",
				status: "running",
				updatedAt: Date.now(),
				runVersion: run.runVersion + 1,
			};
			run = emit(run, {
				type: "RunStatusChanged",
				runId,
				status: "running",
				stage: "executing",
			});

			const scheduled = await schedulePhases(
				boundPlan.program,
				{ script: scriptProvider, llm: llmProvider },
				{
					runId,
					admissionId: admission.admissionId,
					cwd: opts.projectRoot,
					phaseDeadlineMs: reconcileBudget.deadlineMs ?? 60_000,
					continuation,
						onDispatchIntent: (attempt) => {
						const checkpoint: SchedulerCheckpoint = {
							phaseAttempts: continuation.phaseAttempts,
							phaseOutputs: continuation.phaseOutputs,
							activeAttempt: attempt,
							nextPhaseId: attempt.phaseId,
						};
						const prepared: DurableDispatchAttempt = {
							...attempt,
							state: "prepared",
							updatedAt: attempt.createdAt,
						};
						const persisted = commitContinuation(run, continuation, checkpoint, {
							status: "active",
							extraEvents: [
								makeEvent(runId, {
									type: "AttemptPrepared",
									runId,
									continuationId: continuation.continuationId,
									attempt: prepared,
								}),
								makeEvent(runId, {
									type: "DispatchIntentRecorded",
									runId,
									continuationId: continuation.continuationId,
									attempt,
								}),
							],
						});
							run = persisted.run;
							continuation = persisted.continuation;
						},
						beforeProviderSubmit: (attempt) => authorizeProviderSubmit(run, continuation, attempt),
						onDispatchAcknowledged: (attempt) => {
						const checkpoint: SchedulerCheckpoint = {
							phaseAttempts: continuation.phaseAttempts,
							phaseOutputs: continuation.phaseOutputs,
							activeAttempt: attempt,
							nextPhaseId: attempt.phaseId,
						};
						const persisted = commitContinuation(run, continuation, checkpoint, {
							status: "active",
							runPatch: {
								providerHandle: attempt.providerHandle,
								providerName: attempt.providerName,
							},
							extraEvents: [
								makeEvent(runId, {
									type: "DispatchAcknowledged",
									runId,
									continuationId: continuation.continuationId,
									attempt,
								}),
							],
						});
						run = persisted.run;
						continuation = persisted.continuation;
					},
					onCheckpoint: (checkpoint) => {
						const persisted = commitContinuation(run, continuation, checkpoint, {
							status: "active",
						});
						run = persisted.run;
						continuation = persisted.continuation;
					},
				},
			);

			if (scheduled.dispatchAcknowledgementLost) {
				return providerDispatchAcknowledgementLost(run, commandId, scheduled.dispatchAcknowledgementLost);
			}
			if (scheduled.dispatchHandleInvalid) {
				return providerDispatchHandleInvalid(
					run,
					continuation,
					scheduled.checkpoint,
					commandId,
					scheduled.dispatchHandleInvalid,
				);
			}
			if (scheduled.dispatchDenied) {
				return providerSubmitDenied(run, commandId, scheduled.dispatchDenied);
			}
			// Native approval is reached only after each upstream phase checkpoint has
			// been journaled. Park the exact cursor and request in one batch, then
			// release the run slot through the D37 predicate.
			if (scheduled.parked) {
				const approval = newApprovalRequest({
					runId,
					projectId: store.header.projectId,
					controlDomainId: store.header.controlDomainId,
					expectedRunVersion: run.runVersion + 1,
					deadline: Date.now() + 3_600_000,
					continuationId: continuation.continuationId,
					phaseId: scheduled.parked.phaseId,
					message: scheduled.parked.message,
				});
				const parked = commitContinuation(run, continuation, scheduled.checkpoint, {
					status: "parked",
					approvalPhaseId: scheduled.parked.phaseId,
					approvalRequestId: approval.approvalRequestId,
					runPatch: {
						status: "paused",
						stage: "parked",
						approvalRequestId: approval.approvalRequestId,
						reservationId: undefined,
					},
					extraEvents: [
						makeEvent(runId, { type: "ApprovalRequestStored", approval }),
						makeEvent(runId, {
							type: "ApprovalParked",
							runId,
							approvalRequestId: approval.approvalRequestId,
						}),
					],
				});
				run = parked.run;
				continuation = parked.continuation;
				try {
					coordinator.normalRelease(reservation.reservationId, {
						noLiveOrAmbiguousSideEffects: true,
						runIsTerminal: false,
						runIsParkedAndFutureDispatchRequiresReadmission: true,
					});
				} catch {
					/* A durable parked run with a held slot is safe; later reconciliation may release it. */
				}
				return { ok: true, run, snapshot: { run, receipt: null } };
			}

			// Persist last attempt handle for cancel/reconcile of the terminal phase.
				const lastHandle =
					scheduled.stillRunning?.handle ??
					[...scheduled.attempts].reverse().find((a) => a.handle)?.handle;
				if (lastHandle) {
					run = {
					...run,
					providerHandle: lastHandle,
					providerName:
						scheduled.stillRunning?.providerName ??
						scheduled.attempts.find((a) => a.handle === lastHandle)?.providerName,
					updatedAt: Date.now(),
					runVersion: run.runVersion + 1,
				};
				run = emit(run, {
					type: "Generic",
					kind: "PhaseScheduleComplete",
					data: {
						attempts: scheduled.attempts.map((a) => ({
							phaseId: a.phaseId,
							status: a.status,
							provider: a.providerName,
						})),
						stillRunning: scheduled.stillRunning
							? {
									phaseId: scheduled.stillRunning.phaseId,
									handle: scheduled.stillRunning.handle,
								}
							: undefined,
					},
				});
			}

			// Still-running after phase deadline → bounded reconcile (capacity held).
			if (scheduled.stillRunning) {
				const handle = scheduled.stillRunning.handle;
				const reconProvider = scheduled.stillRunning.provider;
				run = {
					...run,
					status: "unknown",
					stage: "reconciling",
					updatedAt: Date.now(),
					runVersion: run.runVersion + 1,
				};
				run = emit(run, { type: "ReconcileStarted", runId, attempt: 1 });

				const outcome = await boundedReconcile(reconProvider, handle, reconcileBudget);
				run = applyReconcileToRun(run, outcome);

				if (outcome.exhausted) {
					coordinator.markOrphanSuspect(reservation.reservationId);
					run = emit(run, { type: "ReconcileSettled", runId, outcome: "exhausted" });
					run = emit(run, { type: "NeedsOperator", runId, code: "TF_RECONCILE_REQUIRED" });
					const snap: RunSnapshot = {
						run,
						controlError: reconcileRequiredError(
							"auto-reconcile exhausted; run remains unknown; no final Receipt",
							{
								commandId,
								projectId: store.header.projectId,
								controlDomainId: store.header.controlDomainId,
							},
						),
						receipt: null,
					};
					return { ok: false, run, snapshot: snap, error: snap.controlError };
				}

				if (outcome.terminal) {
					run = emit(run, {
						type: "RunStatusChanged",
						runId,
						status: run.status,
						stage: "terminal",
					});
					if (
						isTerminalRunStatus(run.status) &&
						canNormalRelease({
							noLiveOrAmbiguousSideEffects: true,
							runIsTerminal: true,
							runIsParkedAndFutureDispatchRequiresReadmission: false,
						})
					) {
						coordinator.normalRelease(reservation.reservationId, {
							noLiveOrAmbiguousSideEffects: true,
							runIsTerminal: true,
							runIsParkedAndFutureDispatchRequiresReadmission: false,
						});
					}
					if (outcome.terminal === "completed" || run.status === "completed") {
						const receiptEventId = newId("ev");
						const receipt = issueReceipt(run, boundPlan, [receiptEventId]);
						const receiptHonest: typeof receipt = {
							...receipt,
							assurance: {
								...receipt.assurance,
								providerOutcome: "ok",
								journalContinuity: "ok",
								artifactIntegrity: "unknown",
								provenance: "unknown",
							},
						};
						run = { ...run, receiptId: receiptHonest.receiptId, status: "completed", stage: "terminal" };
						run = emit(
							run,
							{ type: "ReceiptIssued", runId, receiptId: receiptHonest.receiptId },
							undefined,
							receiptHonest,
							receiptEventId,
						);
						return {
							ok: true,
							run,
							receipt: receiptHonest,
							snapshot: { run, receipt: receiptHonest },
						};
					}
					return { ok: false, run, snapshot: { run, receipt: null } };
				}

				// Non-exhausted, non-terminal reconcile: stay unknown
				const snap: RunSnapshot = {
					run,
					controlError: reconcileRequiredError("reconcile did not settle", {
						commandId,
						projectId: store.header.projectId,
						controlDomainId: store.header.controlDomainId,
					}),
					receipt: null,
				};
				return { ok: false, run, snapshot: snap, error: snap.controlError };
			}

			if (!scheduled.ok) {
				run = {
					...run,
					status: "failed",
					stage: "terminal",
					error: scheduled.error,
					finalOutput: Object.values(scheduled.phaseOutputs).join("\n") || undefined,
					updatedAt: Date.now(),
					runVersion: run.runVersion + 1,
				};
				run = emit(run, {
					type: "RunStatusChanged",
					runId,
					status: "failed",
					stage: "terminal",
					reason: scheduled.error,
				});
				try {
					coordinator.normalRelease(reservation.reservationId, {
						noLiveOrAmbiguousSideEffects: true,
						runIsTerminal: true,
						runIsParkedAndFutureDispatchRequiresReadmission: false,
					});
				} catch {
					/* keep slot */
				}
				// No success Receipt on failed DAG
				return {
					ok: false,
					run,
					snapshot: { run, receipt: null },
					error: {
						code: "TF_COMMAND_FAILED",
						message: scheduled.error ?? "phase schedule failed",
						recoveryAction: "none",
						sideEffects: "possible",
					},
				};
			}

			run = {
				...run,
				status: "completed",
				stage: "terminal",
				finalOutput: scheduled.finalOutput,
				updatedAt: Date.now(),
				runVersion: run.runVersion + 1,
			};
			run = emit(run, {
				type: "RunStatusChanged",
				runId,
				status: "completed",
				stage: "terminal",
			});
			coordinator.normalRelease(reservation.reservationId, {
				noLiveOrAmbiguousSideEffects: true,
				runIsTerminal: true,
				runIsParkedAndFutureDispatchRequiresReadmission: false,
			});
			const receiptEventId = newId("ev");
			const receipt = issueReceipt(run, boundPlan, [receiptEventId]);
			const receiptHonest: typeof receipt = {
				...receipt,
				assurance: {
					...receipt.assurance,
					providerOutcome: "ok",
					journalContinuity: "ok",
					artifactIntegrity: "unknown",
					provenance: "unknown",
				},
			};
			run = { ...run, receiptId: receiptHonest.receiptId };
			run = emit(
				run,
				{ type: "ReceiptIssued", runId, receiptId: receiptHonest.receiptId },
				undefined,
				receiptHonest,
				receiptEventId,
			);
			return { ok: true, run, receipt: receiptHonest, snapshot: { run, receipt: receiptHonest } };
			} catch (error) {
				// The only automatically retryable admission fault is the narrow
				// pre-provider window where the coordinator itself persisted expiry
				// after project preparation. Return the durable retry owner instead
				// of throwing a raw error or inventing another Run.
				if (!coordinatorCommitSucceeded) {
					const durableRun = store.getRun(runId);
					const durableAdmission = store.getCommand(commandId)?.admission;
					const durableReservation = coordinator.getReservation(reservation.reservationId);
					if (
						durableReservation?.state === "expired" &&
						durableReservation.admissionId === admission.admissionId &&
						durableAdmission?.admissionId === admission.admissionId &&
						durableAdmission.state === "project-prepared" &&
						durableAdmission.reservationId === reservation.reservationId &&
						durableRun?.admissionId === admission.admissionId &&
						durableRun.reservationId === reservation.reservationId &&
						durableRun.status === "running" &&
						durableRun.stage === "queued" &&
						durableRun.providerHandle === undefined &&
						durableRun.receiptId === undefined
					) {
						const recoveryError: ControlError = {
							code: "TF_RECONCILE_REQUIRED",
							message:
								"coordinator reservation expired after project preparation; retry the same command to rebind before provider dispatch",
							recoveryAction: "retry-same-command",
							sideEffects: "none",
							commandId,
							projectId: store.header.projectId,
							controlDomainId: store.header.controlDomainId,
						};
						return {
							ok: false,
							run: durableRun,
							error: recoveryError,
							snapshot: { run: durableRun, controlError: recoveryError, receipt: null },
						};
					}
				}
				const conflict = schedulerMutationConflict(runId, commandId, error);
				if (conflict) return conflict;
				throw error;
			}
		},

			getSnapshot(runId: string): RunSnapshot | null {
				const durable = store.getJournalRunSnapshot(runId);
				const run = durable.run;
				if (!run) return null;
				const receipt = durable.receipt;
				const snap: RunSnapshot = { run, receipt };
			if (run.needsOperator || run.status === "unknown") {
				snap.controlError = reconcileRequiredError(
					"run requires operator reconcile",
					{
						projectId: store.header.projectId,
						controlDomainId: store.header.controlDomainId,
					},
				);
			}
			return snap;
		},

		async wait(runId: string): Promise<RunSnapshot> {
			const snap = host.getSnapshot(runId);
			if (!snap) {
				return {
					run: {
						runId,
						projectId: store.header.projectId,
						controlDomainId: store.header.controlDomainId,
						status: "failed",
						stage: "terminal",
						boundPlanHash: "",
						needsOperator: false,
						createdAt: Date.now(),
						updatedAt: Date.now(),
						runVersion: 0,
						error: "not found",
					},
					controlError: {
						code: "TF_NOT_FOUND",
						message: `run ${runId} not found`,
						recoveryAction: "none",
						sideEffects: "none",
					},
				};
			}
			// Normal snapshot even for TF_RECONCILE_REQUIRED — not transport failure
			return snap;
		},

		async reconcilePendingDispatch(runId, recoveryOpts = {}) {
			const commandId = recoveryOpts.commandId ?? newId("cmd");
			if (!isSafeId(commandId)) {
				return casError("TF_INVALID_ARGUMENT", `unsafe commandId: ${JSON.stringify(commandId)}`);
			}
			if (!isSafeId(runId)) {
				return casError("TF_INVALID_ARGUMENT", `unsafe runId: ${JSON.stringify(runId)}`);
			}
			if (!hasMutationAuthority()) return authorityDenied("reconcilePendingDispatch");

			const observedRun = store.getRun(runId);
			if (!observedRun) return casError("TF_NOT_FOUND", `run ${runId} not found`);
			if (observedRun.stage === "terminal" || observedRun.receiptId) {
				return casError("TF_INVALID_ARGUMENT", "terminal/receipted run has no pending dispatch", observedRun);
			}
			const observedContinuation = store.getContinuation(runId);
			if (
				!observedContinuation ||
				observedRun.continuationId !== observedContinuation.continuationId ||
				!observedContinuation.activeAttempt
			) {
				return casError(
					"TF_INVALID_ARGUMENT",
					"run has no coherent durable active dispatch attempt",
					observedRun,
				);
			}
			const observedAttempt = observedContinuation.activeAttempt;
			const startingVersion = recoveryOpts.expectedRunVersion ?? observedRun.runVersion;

			const matchesObservedAttempt = (run: RunProjection, expectedHandle?: string): string | null => {
				if (run.stage === "terminal" || run.receiptId) {
					return "run became terminal while recovering a pending dispatch";
				}
				const continuation = store.getContinuation(runId);
				const active = continuation?.activeAttempt;
				if (
					!continuation ||
					run.continuationId !== observedContinuation.continuationId ||
					continuation.continuationId !== observedContinuation.continuationId ||
					!active ||
					active.attemptId !== observedAttempt.attemptId ||
					active.phaseId !== observedAttempt.phaseId ||
					active.idempotencyKey !== observedAttempt.idempotencyKey ||
					active.providerName !== observedAttempt.providerName
				) {
					return "durable active dispatch changed while recovery was in progress";
				}
				if (expectedHandle !== undefined && active.providerHandle !== expectedHandle) {
					return "durable provider handle changed while recovery was in progress";
				}
				return null;
			};

			const markNeedsOperator = (
				baseRun: RunProjection,
				expectedRunVersion: number,
				message: string,
				outcome: "terminal" | "still-running" | "exhausted",
				expectedHandle?: string,
			): AdmitResult => {
				try {
					const marked = store.compareAndCommit({
						runId,
						expectedRunVersion,
						validate: (current) => matchesObservedAttempt(current, expectedHandle),
						build: (current) => {
							const next: RunProjection = {
								...current,
								status: "unknown",
								stage: "reconciling",
								needsOperator: true,
								error: message,
								updatedAt: Date.now(),
								runVersion: current.runVersion + 1,
							};
							return {
								run: next,
								events: [
									makeEvent(runId, { type: "ReconcileStarted", runId, attempt: 1 }, commandId),
									makeEvent(runId, { type: "ReconcileSettled", runId, outcome }, commandId),
									makeEvent(
										runId,
										{ type: "NeedsOperator", runId, code: "TF_RECONCILE_REQUIRED" },
										commandId,
									),
								],
							};
						},
					});
					if (!marked.ok) return casError(marked.code, marked.message, marked.run);
					const error = reconcileRequiredError(message, {
						commandId,
						projectId: store.header.projectId,
						controlDomainId: store.header.controlDomainId,
					});
					return {
						ok: false,
						run: marked.run,
						error,
						snapshot: { run: marked.run, controlError: error, receipt: null },
					};
				} catch (error) {
					if (error instanceof SingletonAuthorityError) {
						return pendingDispatchAuthorityRevoked(
							store.getRun(runId) ?? baseRun,
							commandId,
							"writer lost authority while marking pending provider recovery",
						);
					}
					throw error;
				}
			};

			const boundPlan = store.getBoundPlan(observedRun.boundPlanHash);
			if (!boundPlan) {
				return markNeedsOperator(
					observedRun,
					startingVersion,
					"pending dispatch has no immutable BoundPlan snapshot; cannot prove recovery request shape",
					"exhausted",
				);
			}

			let lookup;
			try {
				lookup = await lookupDurableDispatchForRecovery(
					boundPlan.program,
					{ script: scriptProvider, llm: llmProvider },
					{
						runId,
						cwd: opts.projectRoot,
						continuation: observedContinuation,
					},
				);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return markNeedsOperator(
					observedRun,
					startingVersion,
					`provider recovery lookup threw: ${detail}`,
					"exhausted",
				);
			}
			if (lookup.kind !== "found") {
				const detail =
					lookup.kind === "not-found"
						? "provider proves no durable handle, but automatic replay is forbidden"
						: lookup.reason;
				return markNeedsOperator(
					observedRun,
					startingVersion,
					`cannot resolve durable dispatch ${observedAttempt.idempotencyKey}: ${detail}`,
					"exhausted",
				);
			}
			const recoveredRouteIdentity: DurableProviderRouteIdentity = {
				runId,
				providerName: lookup.providerName,
				handle: lookup.handle,
				continuationId: observedContinuation.continuationId,
				continuationVersion: observedContinuation.version,
				attemptId: observedAttempt.attemptId,
				phaseId: observedAttempt.phaseId,
			};
			const recoveredRecordFailure = providerHandleRecordFailure(
				lookup.provider,
				recoveredRouteIdentity,
			);
			if (recoveredRecordFailure) {
				return markNeedsOperator(
					observedRun,
					startingVersion,
					`cannot verify recovered provider handle ownership: ${recoveredRecordFailure}`,
					"exhausted",
				);
			}

			let recoveredRun = observedRun;
			const alreadyAcknowledged = store.getContinuation(runId)?.activeAttempt;
			if (
				alreadyAcknowledged?.state === "acknowledged" &&
				alreadyAcknowledged.providerHandle === lookup.handle
			) {
				if (
					recoveryOpts.expectedRunVersion !== undefined &&
					recoveredRun.runVersion !== recoveryOpts.expectedRunVersion
				) {
					return casError(
						"TF_STALE_VERSION",
						`expected runVersion ${recoveryOpts.expectedRunVersion}, have ${recoveredRun.runVersion}`,
						recoveredRun,
					);
				}
			} else {
				try {
					const acknowledged = store.compareAndCommit({
						runId,
						expectedRunVersion: startingVersion,
						validate: (current) => {
							const mismatch = matchesObservedAttempt(current);
							if (mismatch) return mismatch;
							const active = store.getContinuation(runId)?.activeAttempt;
							return active?.state === "intent-recorded"
								? null
								: `pending dispatch is ${active?.state ?? "missing"}, not intent-recorded`;
						},
						build: (current) => {
							const durableContinuation = store.getContinuation(runId)!;
							const active = durableContinuation.activeAttempt!;
							const now = Date.now();
							const attempt: DurableDispatchAttempt = {
								...active,
								state: "acknowledged",
								providerHandle: lookup.handle,
								updatedAt: now,
							};
							const continuation: RunContinuation = {
								...durableContinuation,
								activeAttempt: attempt,
								updatedAt: now,
								version: durableContinuation.version + 1,
							};
							const next: RunProjection = {
								...current,
								status: "unknown",
								stage: "reconciling",
								needsOperator: false,
								providerHandle: lookup.handle,
								providerName: lookup.providerName,
								updatedAt: now,
								runVersion: current.runVersion + 1,
							};
							return {
								run: next,
								events: [
									makeEvent(
										runId,
										{
											type: "DispatchAcknowledged",
											runId,
											continuationId: continuation.continuationId,
											attempt,
										},
										commandId,
									),
									makeEvent(runId, { type: "ContinuationStored", continuation }, commandId),
									makeEvent(runId, { type: "ReconcileStarted", runId, attempt: 1 }, commandId),
								],
							};
						},
					});
					if (!acknowledged.ok) {
						const latest = store.getContinuation(runId)?.activeAttempt;
						const latestRun = store.getRun(runId) ?? observedRun;
						if (latest?.state === "acknowledged" && latest.providerHandle === lookup.handle) {
							recoveredRun = latestRun;
						} else {
							return casError(acknowledged.code, acknowledged.message, acknowledged.run);
						}
					} else {
						recoveredRun = acknowledged.run;
					}
				} catch (error) {
					if (error instanceof SingletonAuthorityError) {
						return pendingDispatchAuthorityRevoked(
							store.getRun(runId) ?? observedRun,
							commandId,
							"writer lost authority before durable provider-handle acknowledgement",
						);
					}
					throw error;
				}
			}

			if (!hasMutationAuthority()) {
				return pendingDispatchAuthorityRevoked(
					recoveredRun,
					commandId,
					"writer lost authority before observing recovered provider handle",
				);
			}
			let providerOutcome: "terminal" | "still-running" | "exhausted" = "exhausted";
			let observation = "provider reconcile did not return a trustworthy result";
			try {
				const result = await lookup.provider.reconcile(lookup.handle);
				if (result.kind === "running") {
					providerOutcome = "still-running";
					observation = "provider reports the recovered handle is still running";
				} else if (result.kind === "completed") {
					providerOutcome = "terminal";
					observation = "provider reports the recovered handle completed";
				} else if (result.kind === "failed") {
					providerOutcome = "terminal";
					observation = `provider reports the recovered handle failed: ${result.error}`;
				} else if (result.kind === "cancelled") {
					providerOutcome = "terminal";
					observation = "provider reports the recovered handle cancelled";
				} else {
					observation = `provider cannot prove recovered handle state: ${result.reason}`;
				}
			} catch (error) {
				observation = `provider reconcile threw: ${error instanceof Error ? error.message : String(error)}`;
			}
			return markNeedsOperator(
				recoveredRun,
				recoveredRun.runVersion,
				`${observation}; recovered handle is journaled, but automatic phase continuation and Receipt issuance remain disabled`,
				providerOutcome,
				lookup.handle,
			);
		},

			async cancel(runId, opts = {}) {
				if (!isSafeId(runId)) {
					return casError("TF_INVALID_ARGUMENT", `unsafe runId: ${JSON.stringify(runId)}`);
				}
				const pendingSubmission = pendingProviderSubmissionFence(runId);
				if (pendingSubmission) await pendingSubmission;
				if (!hasMutationAuthority()) return authorityDenied("cancel");
			const commandId = opts.commandId ?? newId("cmd");
			if (!isSafeId(commandId)) {
				return casError("TF_INVALID_ARGUMENT", `unsafe commandId: ${JSON.stringify(commandId)}`);
			}
			const principal = opts.principal ?? "local";
			if (!principal.trim()) {
				return casError("TF_INVALID_ARGUMENT", "cancel principal must be non-empty");
			}
			const requestHash = hashRequest({ runId, operation: "cancel", version: 1 });
			const resolveExistingCancelCommand = (
				existingCommand: NonNullable<ReturnType<typeof store.getCommand>>,
			): AdmitResult => {
				if (existingCommand.requestHash !== requestHash || existingCommand.kind !== "cancel") {
					return {
						ok: false,
						error: {
								code: "TF_IDEMPOTENCY_CONFLICT",
								message: "same cancel commandId has a different request shape",
								recoveryAction: "retry-new-command",
								sideEffects: "none",
								commandId,
								projectId: store.header.projectId,
								controlDomainId: store.header.controlDomainId,
							},
						};
				}
				if (existingCommand.callerPrincipal !== principal) {
					return {
						ok: false,
						error: {
								code: "TF_CROSS_PRINCIPAL_COMMAND",
								message: "cancel command is owned by a different principal",
								recoveryAction: "none",
								sideEffects: "none",
								commandId,
								projectId: store.header.projectId,
								controlDomainId: store.header.controlDomainId,
							},
						};
				}
				if (existingCommand.runId !== runId) {
					return {
						ok: false,
						error: {
								code: "TF_IDEMPOTENCY_CONFLICT",
								message: "cancel command belongs to a different run",
								recoveryAction: "retry-new-command",
								sideEffects: "none",
								commandId,
								projectId: store.header.projectId,
								controlDomainId: store.header.controlDomainId,
						},
					};
				}
				const current = store.getRun(runId);
				if (!current) return casError("TF_NOT_FOUND", `run ${runId} not found`);
				if (current.cancelRequest?.commandId !== commandId) {
					return cancelReconcileRequired(
						current,
						commandId,
						"accepted cancel command has no matching durable cancel request",
						"unknown",
					);
				}
				if (current.cancelRequest.state === "requested") {
					return cancelReconcileRequired(
						current,
						commandId,
						"accepted cancel command has an unresolved original signal owner; reconcile instead of re-signalling",
						"unknown",
					);
				}
				if (
					current.cancelRequest.state === "signalling" ||
					current.cancelRequest.state === "ambiguous"
				) {
					return cancelReconcileRequired(
						current,
						commandId,
						"cancel signal may already have reached the provider; reconcile instead of re-signalling",
						"possible",
					);
				}
				return cancelReconcileRequired(
					current,
					commandId,
					"cancel command has an unsupported durable state; reconcile is required",
					"unknown",
				);
			};

			const existingCommand = store.getCommand(commandId);
			if (existingCommand) return resolveExistingCancelCommand(existingCommand);

			let requested: ReturnType<ProjectControlStore["compareAndCommit"]>;
			try {
				requested = store.compareAndCommit({
				runId,
				expectedRunVersion: opts.expectedRunVersion,
				validate: (run) => {
					if (run.stage === "terminal" || run.receiptId) {
						return `run is terminal/has Receipt (status=${run.status}); cannot cancel`;
					}
					if (run.cancelRequest) return "another durable cancellation is already in progress";
					return null;
					},
					build: (run) => {
						const now = Date.now();
						const route = durableProviderRouteIdentity(run);
						const routeIdentity = route.ok ? route.identity : undefined;
						const cancelRequest: DurableCancelRequest = {
							commandId,
							requestHash,
						principal,
							state: "requested",
							...(run.providerHandle === undefined ? {} : { providerHandle: run.providerHandle }),
							...(run.providerName === undefined ? {} : { providerName: run.providerName }),
							...(routeIdentity === undefined
								? {}
								: {
										continuationId: routeIdentity.continuationId,
										continuationVersion: routeIdentity.continuationVersion,
										attemptId: routeIdentity.attemptId,
										phaseId: routeIdentity.phaseId,
									}),
							...(singleton?.role === "writer" ? { fencingEpoch: singleton.lock.fencingEpoch } : {}),
						requestedAt: now,
						updatedAt: now,
					};
					const next: RunProjection = {
						...run,
						status: "unknown",
						stage: "reconciling",
						needsOperator: false,
						error: "durable cancellation requested; provider signal not yet observed",
						cancelRequest,
						updatedAt: now,
						runVersion: run.runVersion + 1,
					};
					const command = {
						commandId,
						requestHash,
						callerPrincipal: principal,
						authorizationContextHash: hashRequest({ principal }),
						projectId: store.header.projectId,
						controlDomainId: store.header.controlDomainId,
						kind: "cancel",
						status: "accepted" as const,
						firstCommitSeq: 0,
						lastCommitSeq: 0,
						runId,
						recordedAt: now,
					};
					return {
						run: next,
						command,
						events: [
							makeEvent(
								runId,
								{
									type: "RunStatusChanged",
									runId,
									status: "unknown",
									stage: "reconciling",
									reason: "cancel requested",
								},
								commandId,
							),
						],
					};
				},
				});
			} catch (error) {
				if (error instanceof SingletonAuthorityError) {
					const observedRun = store.getRun(runId);
					if (!observedRun) return authorityDenied("cancel");
					return cancelAuthorityRevoked(
						observedRun,
						commandId,
						"writer lost authority before durable CancelRequested commit",
						"none",
						"retry-same-command",
					);
				}
				throw error;
			}
			if (!requested.ok) {
				const racedCommand = store.getCommand(commandId);
				if (racedCommand) return resolveExistingCancelCommand(racedCommand);
				return casError(requested.code, requested.message, requested.run);
			}
			const intentRun = requested.run;

			const request = intentRun.cancelRequest;
			if (!request || request.commandId !== commandId || request.state !== "requested") {
				return cancelReconcileRequired(
					intentRun,
					commandId,
					"cancel intent is not in a state that permits a first provider signal",
					"unknown",
				);
			}
			let signalling: ReturnType<ProjectControlStore["compareAndCommit"]>;
			try {
				signalling = store.compareAndCommit({
					runId,
					expectedRunVersion: intentRun.runVersion,
					validate: (run) =>
						run.cancelRequest?.commandId === commandId && run.cancelRequest.state === "requested"
							? null
							: "cancel intent changed before provider signal",
					build: (run) => {
						const now = Date.now();
						const next: RunProjection = {
							...run,
							cancelRequest: { ...run.cancelRequest!, state: "signalling", updatedAt: now },
							updatedAt: now,
							runVersion: run.runVersion + 1,
						};
						return {
							run: next,
							events: [
								makeEvent(
									runId,
									{
										type: "RunStatusChanged",
										runId,
										status: "unknown",
										stage: "reconciling",
										reason: "cancel signal intent recorded",
									},
									commandId,
								),
							],
						};
					},
				});
			} catch (error) {
				if (error instanceof SingletonAuthorityError) {
					return cancelAuthorityRevoked(
						intentRun,
						commandId,
						"writer lost authority after recording CancelRequested and before durable signalling",
						"none",
					);
				}
				throw error;
			}
			if (!signalling.ok) return casError(signalling.code, signalling.message, signalling.run);

				const signalRun = signalling.run;
			const markAmbiguous = (
				message: string,
			): { run: RunProjection; authorityRevoked: boolean } => {
				try {
					const ambiguous = store.compareAndCommit({
						runId,
						expectedRunVersion: signalRun.runVersion,
						validate: (run) =>
							run.cancelRequest?.commandId === commandId && run.cancelRequest.state === "signalling"
								? null
								: "cancel state changed while provider result was pending",
						build: (run) => {
							const now = Date.now();
							const next: RunProjection = {
								...run,
								status: "unknown",
								stage: "reconciling",
								needsOperator: true,
								error: message,
								cancelRequest: { ...run.cancelRequest!, state: "ambiguous", updatedAt: now },
								updatedAt: now,
								runVersion: run.runVersion + 1,
							};
							return {
								run: next,
								events: [
									makeEvent(
										runId,
										{
											type: "RunStatusChanged",
											runId,
											status: "unknown",
											stage: "reconciling",
											reason: "cancel requires reconciliation",
										},
										commandId,
									),
								],
							};
						},
					});
					return {
						run: ambiguous.ok ? ambiguous.run : ambiguous.run ?? signalRun,
						authorityRevoked: false,
					};
				} catch (error) {
					// A generic durability error still retains the existing signalling
					// snapshot for reconcile. A lost writer fence has a distinct public
					// contract: callers must learn that this epoch cannot own the next
					// cancellation state transition.
					return { run: signalRun, authorityRevoked: error instanceof SingletonAuthorityError };
				}
			};
				const requestedRoute = cancelRouteIdentity(signalRun, signalRun.cancelRequest);
				const providerRoute = requestedRoute
					? resolveDurableProviderRoute(signalRun, requestedRoute)
					: {
							ok: false as const,
							reason:
								"CancelRequested has no complete continuation/version/attempt/provider route identity",
						};
				if (!providerRoute.ok) {
					const marked = markAmbiguous(
						`cancel cannot safely route a provider signal: ${providerRoute.reason}`,
					);
				if (marked.authorityRevoked) {
					return cancelAuthorityRevoked(
						marked.run,
						commandId,
						"writer lost authority while recording missing-handle cancellation ambiguity",
						"unknown",
					);
				}
					return cancelReconcileRequired(
						marked.run,
						commandId,
						"cancel cannot signal without a coherent durable provider route; reconcile or operator action is required",
						"unknown",
					);
			}

			const cancellationFence = authorizeProviderCancel();
			if (!cancellationFence) {
				return cancelAuthorityRevoked(
					signalRun,
					commandId,
					"writer lost authority before provider cancellation signal",
					"none",
				);
			}

				let providerResult: Awaited<ReturnType<ExecutionProvider["cancel"]>>;
				try {
					providerResult = await providerRoute.provider.cancel(providerRoute.identity.handle, { cancellationFence });
			} catch (error) {
				if (error instanceof SingletonAuthorityError) {
					return cancelAuthorityRevoked(signalRun, commandId, error.message, "possible");
				}
				const marked = markAmbiguous(
					`provider cancellation threw: ${error instanceof Error ? error.message : String(error)}`,
				);
				if (marked.authorityRevoked) {
					return cancelAuthorityRevoked(
						marked.run,
						commandId,
						"writer lost authority while recording provider-cancellation ambiguity",
						"possible",
					);
				}
				return cancelReconcileRequired(
					marked.run,
					commandId,
					"provider cancellation threw after durable signal intent; reconcile is required",
					"possible",
				);
			}
			if (!hasMutationAuthority()) {
				return cancelAuthorityRevoked(
					signalRun,
					commandId,
					"writer lost authority after provider cancellation call",
					"possible",
				);
			}
			let quiescent = false;
			let quiescenceObservationFailed = false;
			if (providerResult.kind === "cancelled") {
				try {
					quiescent = providerQuiescent(runId);
				} catch {
					// A ControlStore/provider read can fail after the external cancel
					// boundary. The only safe result is an ambiguous durable cancel.
					quiescenceObservationFailed = true;
				}
			}
			// A naked provider enum plus `isLive=false` is only a provider-local
			// observation. It cannot prove that remote work or a detached child tree
			// has no remaining side effects, and no durable containment-proof protocol
			// exists yet to bind such a proof to this cancel command and journal entry.
			// Therefore every current provider result remains nonterminal: keep the
			// reservation and require an explicit reconciliation/containment owner.
			const marked = markAmbiguous(
				providerResult.kind === "ambiguous"
					? "provider cancellation reported an ambiguous result"
					: quiescenceObservationFailed
						? "provider quiescence observation failed after cancellation"
						: providerResult.kind !== "cancelled" || !quiescent
							? "provider cancellation did not prove process quiescence"
							: "provider reported cancellation quiescence without a durable containment proof",
			);
			if (marked.authorityRevoked) {
				return cancelAuthorityRevoked(
					marked.run,
					commandId,
					"writer lost authority while recording provider-cancellation ambiguity",
					"possible",
				);
			}
			return cancelReconcileRequired(
				marked.run,
				commandId,
				"provider cancellation cannot terminalize without a durable containment proof; reconcile is required",
				"possible",
			);
		},

			async parkForApproval(runId, opts = {}) {
				const pendingSubmission = pendingProviderSubmissionFence(runId);
				if (pendingSubmission) await pendingSubmission;
				if (!hasMutationAuthority()) return authorityDenied("parkForApproval");
			// Quiescence check before lock (provider is process-local).
			const pre = store.getRun(runId);
			if (pre?.cancelRequest) {
				return cancelReconcileRequired(
					pre,
					pre.cancelRequest.commandId,
					"cannot park a run with a durable cancellation request; reconcile containment before approval",
					"possible",
				);
			}
			if (pre && !providerQuiescent(runId)) {
				return {
					ok: false,
					run: pre,
					error: {
						code: "TF_PROVIDER_AMBIGUOUS",
						message:
							"cannot parkForApproval while provider job is still live; slot held until quiescence (D38)",
						recoveryAction: "reconcile",
						sideEffects: "possible",
						projectId: store.header.projectId,
						controlDomainId: store.header.controlDomainId,
					},
					snapshot: { run: pre },
				};
			}

			let releasedReservationId: string | undefined;
			let durableAprId: string | undefined;
			const cas = store.compareAndCommit({
				runId,
				expectedRunVersion: opts.expectedRunVersion,
				validate: (run) =>
					run.cancelRequest
						? "cannot park a run with a durable cancellation request"
						: null,
				build: (run) => {
					releasedReservationId = run.reservationId;
					const apr = createApprovalRequest(store.projectRoot, {
						runId,
						projectId: store.header.projectId,
						controlDomainId: store.header.controlDomainId,
						expectedRunVersion: run.runVersion + 1,
						deadline: Date.now() + 3_600_000,
					});
					durableAprId = apr.approvalRequestId;
					const next: RunProjection = {
						...run,
						status: "paused",
						stage: "parked",
						approvalRequestId: apr.approvalRequestId,
						reservationId: undefined,
						updatedAt: Date.now(),
						runVersion: run.runVersion + 1,
					};
					return {
						run: next,
						events: [
							makeEvent(runId, {
								type: "ApprovalParked",
								runId,
								approvalRequestId: apr.approvalRequestId,
							}),
						],
					};
				},
			});
			if (!cas.ok) {
				if (cas.run?.cancelRequest) {
					return cancelReconcileRequired(
						cas.run,
						cas.run.cancelRequest.commandId,
						"cancellation won the park-for-approval race; reconcile containment before approval",
						"possible",
					);
				}
				return casError(cas.code, cas.message, cas.run);
			}

			if (releasedReservationId) {
				try {
					coordinator.normalRelease(releasedReservationId, {
						noLiveOrAmbiguousSideEffects: true,
						runIsTerminal: false,
						runIsParkedAndFutureDispatchRequiresReadmission: true,
					});
				} catch {
					/* keep */
				}
			}
			void durableAprId;
			return { ok: true, run: cas.run, snapshot: { run: cas.run } };
		},

		async approve(runId, opts = {}) {
			if (!hasMutationAuthority()) return authorityDenied("approve");
			const native = await approveNativeContinuation(runId, opts);
			if (native) return native;
			return approvalContinuationUnavailable(runId, opts.expectedRunVersion, "approve");
		},

		async edit(runId, opts) {
			if (!hasMutationAuthority()) return authorityDenied("edit");
			const note = opts.note?.trim();
			if (!note) {
				return casError("TF_INVALID_ARGUMENT", "edit requires non-empty note/payload");
			}
			return approvalContinuationUnavailable(runId, opts.expectedRunVersion, "edit");
		},

		async reject(runId, opts = {}) {
			if (!hasMutationAuthority()) return authorityDenied("reject");
			const pendingApr = loadApprovalForRun(store.projectRoot, runId);
			if (pendingApr) {
				const decided = runDurableMutation(() =>
					decideApproval(store.projectRoot, pendingApr.approvalRequestId, {
						decision: "reject",
						principal: opts.principal ?? "local",
						commandId: opts.commandId ?? newId("cmd"),
						note: opts.note,
					}),
				);
				if (!decided.ok) {
					return casError(decided.code, decided.message, store.getRun(runId) ?? undefined);
				}
			}
			const cas = store.compareAndCommit({
				runId,
				expectedRunVersion: opts.expectedRunVersion,
				validate: (run) => {
					if (run.stage === "terminal" || run.receiptId) {
						return `run is terminal/has Receipt; cannot reject`;
					}
					if (run.status !== "paused" || run.stage !== "parked") {
						return `reject requires paused+parked (have ${run.status}/${run.stage})`;
					}
					return null;
				},
				build: (run) => {
					const next: RunProjection = {
						...run,
						status: "blocked",
						stage: "terminal",
						updatedAt: Date.now(),
						runVersion: run.runVersion + 1,
						error: opts.note ?? "approval rejected",
					};
					return {
						run: next,
						events: [
							makeEvent(runId, {
								type: "ApprovalDecided",
								runId,
								approvalRequestId: run.approvalRequestId ?? "",
								decision: "reject",
							}),
							makeEvent(runId, {
								type: "RunStatusChanged",
								runId,
								status: "blocked",
								stage: "terminal",
								reason: "approval rejected",
							}),
						],
					};
				},
			});
			if (!cas.ok) return casError(cas.code, cas.message, cas.run);
			return { ok: true, run: cas.run, snapshot: { run: cas.run } };
		},

		async expireApproval(runId, opts = {}) {
			if (!hasMutationAuthority()) return authorityDenied("expireApproval");
			const pendingApr = loadApprovalForRun(store.projectRoot, runId);
			if (!pendingApr) {
				return casError("TF_NOT_FOUND", "no approval request for run", store.getRun(runId) ?? undefined);
			}
			// Force deadline past so expire takes effect
			const now = opts.now ?? Date.now();
			const expired =
				runDurableMutation(() =>
					expireApprovalIfDue(store.projectRoot, pendingApr.approvalRequestId, now),
				) ?? pendingApr;
			if (expired.status === "pending") {
				// No deadline set — force expire on disk
				const forced = { ...expired, status: "expired" as const, decidedAt: now, deadline: now - 1 };
				const { writeFileAtomic, projectControlRoot } = await import("./paths.ts");
				runDurableMutation(() =>
					writeFileAtomic(
						`${projectControlRoot(store.projectRoot)}/approvals/${expired.approvalRequestId}.json`,
						JSON.stringify(forced, null, 2),
					),
				);
			}
			const cas = store.compareAndCommit({
				runId,
				validate: (run) => {
					if (run.stage === "terminal" || run.receiptId) return `already terminal`;
					if (run.status !== "paused" || run.stage !== "parked") {
						return `expire requires parked run`;
					}
					return null;
				},
				build: (run) => {
					const next: RunProjection = {
						...run,
						status: "blocked",
						stage: "terminal",
						updatedAt: Date.now(),
						runVersion: run.runVersion + 1,
						error: "approval expired",
					};
					return {
						run: next,
						events: [
							makeEvent(runId, {
								type: "RunStatusChanged",
								runId,
								status: "blocked",
								stage: "terminal",
								reason: "approval expired",
							}),
						],
					};
				},
			});
			if (!cas.ok) return casError(cas.code, cas.message, cas.run);
			return { ok: true, run: cas.run, snapshot: { run: cas.run } };
		},

		forceReleaseReservation(reservationId, opts) {
			if (!hasMutationAuthority()) {
				return {
					ok: false as const,
					error: authorityDenied("forceReleaseReservation").error!,
				};
			}
			if (!opts.principal?.trim()) {
				return {
					ok: false as const,
					error: {
						code: "TF_INVALID_ARGUMENT" as const,
						message: "forceRelease requires principal",
						recoveryAction: "none" as const,
						sideEffects: "none" as const,
					},
				};
			}
			if (opts.riskAcknowledged !== true) {
				return {
					ok: false as const,
					error: {
						code: "TF_POLICY_DENIED" as const,
						message: "forceRelease requires riskAcknowledged:true",
						recoveryAction: "none" as const,
						sideEffects: "none" as const,
					},
				};
			}
			if (!isSafeId(reservationId)) {
				return {
					ok: false as const,
					error: {
						code: "TF_INVALID_ARGUMENT" as const,
						message: `unsafe reservationId`,
						recoveryAction: "none" as const,
						sideEffects: "none" as const,
					},
				};
			}
			if (opts.commandId !== undefined && !isSafeId(opts.commandId)) {
				return {
					ok: false as const,
					error: {
						code: "TF_INVALID_ARGUMENT" as const,
						message: "unsafe commandId",
						recoveryAction: "none" as const,
						sideEffects: "none" as const,
					},
				};
			}
			const commandId = opts.commandId ?? newId("cmd");
			try {
				const { command } = coordinator.forceRelease(reservationId, {
					commandId,
					callerPrincipal: opts.principal,
					requestBody: {
						reservationId,
						riskAcknowledged: true,
						reason: opts.reason,
					},
				});
				return { ok: true as const, commandId: command.commandId };
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				const code: ControlError["code"] = msg.includes("TF_CROSS_PRINCIPAL_COMMAND")
					? "TF_CROSS_PRINCIPAL_COMMAND"
					: msg.includes("TF_IDEMPOTENCY_CONFLICT")
						? "TF_IDEMPOTENCY_CONFLICT"
						: msg.includes("TF_INVALID_ARGUMENT")
							? "TF_INVALID_ARGUMENT"
							: msg.includes("TF_DURABILITY_FAILED")
								? "TF_DURABILITY_FAILED"
								: "TF_COMMAND_FAILED";
				const deterministicNoSideEffects =
					code === "TF_CROSS_PRINCIPAL_COMMAND" ||
					code === "TF_IDEMPOTENCY_CONFLICT" ||
					code === "TF_INVALID_ARGUMENT";
				return {
					ok: false as const,
					error: {
						code,
						message: msg,
						recoveryAction:
							code === "TF_IDEMPOTENCY_CONFLICT"
								? "retry-new-command"
								: code === "TF_DURABILITY_FAILED"
									? "operator"
									: "none",
						sideEffects: deterministicNoSideEffects ? "none" : "unknown",
						commandId,
					},
				};
			}
		},

		close() {
				// Only the opaque current writer capability may release the singleton.
				if (singleton?.role === "writer") {
					try {
						releaseSingleton(singleton.mutationAuthority, env);
				} catch {
					/* close is best-effort; a durable replacement must remain intact */
				}
			}
		},
	};

	return host;
}

// re-export types used by callers
export type { RunStatus, RunStage, BoundPlan, Receipt };
