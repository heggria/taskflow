/**
 * ControlHost — single execution semantics for standalone / daemon / embedded (D18).
 *
 * Admit → reserve → execute → receipt (or needs-operator without receipt).
 */
import {
	DEFAULT_CONTROL_MODE,
	isTerminalRunStatus,
	reconcileRequiredError,
	type BoundPlan,
	type BoundFragment,
	type BoundFragmentLink,
	type CommandRecord,
	type ControlError,
	type ControlEvent,
	type ControlMode,
	type ForceReleaseRequest,
	type Receipt,
	type RunAttemptProjection,
	type RunNodeProjection,
	type RunProjection,
	type RunStage,
	type RunStatus,
} from "./types.ts";
import { hashRequest, newId } from "./hash.ts";
import { bindFragment } from "./bound-fragment.ts";
import { openProjectControlStore, type ProjectControlStore } from "./store/project-store.ts";
import {
	openControlRegistry,
	type ControlRegistry,
	type RegistryEntry,
} from "./store/registry.ts";
import {
	openUserCoordinatorStore,
	type UserCoordinatorStore,
	canNormalRelease,
} from "./store/coordinator.ts";
import { acquireOrAttachSingleton, type SingletonResult } from "./singleton.ts";
import { linkProgram } from "./linker.ts";
import {
	createMockExecutionProvider,
	type ExecutionProvider,
} from "./provider.ts";
import { createScriptExecutionProvider } from "./script-provider.ts";
import {
	boundedReconcile,
	applyReconcileToRun,
	DEFAULT_RECONCILE_BUDGET,
	settleTerminalNodes,
	type ReconcileBudget,
} from "./reconcile.ts";
import { isSafeId } from "./validate-ids.ts";
import { projectCoordinatorDir } from "./paths.ts";
import type { IdentityOpenPolicy } from "./identity.ts";
import {
	createApprovalRequest,
	decideApproval,
	expireApprovalIfDue,
	loadApprovalForRun,
} from "./approval.ts";
import {
	approvalContinuationMatchesRun,
	createApprovalContinuationCheckpoint,
	decodeApprovalContinuationCheckpoint,
	encodeApprovalContinuationCheckpoint,
	type ApprovalContinuationCheckpoint,
} from "./approval-continuation.ts";
import { inspectQueuedApprovalDispatch } from "./approval-dispatch.ts";
import { legacyConflictError, probeLegacyConflict } from "./legacy-conflict.ts";
import {
	schedulePhases,
	type PhaseAttempt,
	type ResolvedDynamicFragment,
} from "./phase-scheduler.ts";
import { buildControlReplayTrace } from "./replay-trace.ts";
import * as path from "node:path";

function projectPhaseInventory(
	phaseRecords: Array<Record<string, unknown>>,
	phaseAttempts: readonly PhaseAttempt[],
	linkedFragments: ReadonlyArray<{
		fragment: BoundFragment;
		link: BoundFragmentLink;
	}> = [],
): {
	nodes: RunNodeProjection[];
	attempts: RunAttemptProjection[];
} {
	const attemptsByPhase = new Map<string, PhaseAttempt[]>();
	for (const attempt of phaseAttempts) {
		const bucket = attemptsByPhase.get(attempt.phaseId) ?? [];
		bucket.push(attempt);
		attemptsByPhase.set(attempt.phaseId, bucket);
	}
	const staticNodes = phaseRecords.flatMap((phase, ordinal) => {
		if (typeof phase.id !== "string") return [];
		const attempts = attemptsByPhase.get(phase.id) ?? [];
		const latest = attempts[attempts.length - 1];
		const displayLabel =
			typeof phase.name === "string" && phase.name.trim()
				? phase.name.trim().slice(0, 512)
				: phase.id
						.replace(/[-_]+/gu, " ")
						.trim()
						.slice(0, 512);
		const status: RunNodeProjection["status"] =
			latest === undefined
				? "pending"
				: latest.status === "still-running"
					? "running"
					: latest.status === "skipped"
						? latest.error ===
							"upstream dependency failed"
							? "blocked"
							: "completed"
						: latest.status;
		return [
			{
				nodeInstanceId: phase.id,
				phaseId: phase.id,
				phaseType:
					latest?.type ??
					(typeof phase.type === "string"
						? phase.type
						: "agent"),
				origin: "bound-plan" as const,
				status,
				attemptCount: attempts.length,
				ordinal,
				displayLabel: displayLabel || phase.id,
			},
		];
	});
	const dynamicNodes = linkedFragments.flatMap(
		({ fragment, link }, fragmentOrdinal) => {
			const phases =
				fragment.fragment &&
				typeof fragment.fragment === "object" &&
				Array.isArray(
					(fragment.fragment as { phases?: unknown })
						.phases,
				)
					? (fragment.fragment as {
							phases: Array<Record<string, unknown>>;
						}).phases
					: [];
			const parentAttempt = (
				attemptsByPhase.get(link.originPhaseId) ?? []
			).at(-1);
			const status: RunNodeProjection["status"] =
				parentAttempt === undefined
					? "waiting"
					: parentAttempt.status === "still-running"
						? "running"
						: parentAttempt.status === "skipped"
							? "blocked"
							: parentAttempt.status;
			return phases.flatMap((phase, ordinal) => {
				if (typeof phase.id !== "string") return [];
				const displayLabel =
					typeof phase.name === "string" &&
					phase.name.trim()
						? phase.name.trim().slice(0, 512)
						: phase.id
								.replace(/[-_]+/gu, " ")
								.trim()
								.slice(0, 512);
				return [
					{
						nodeInstanceId: `dyn-${fragment.boundFragmentHash.slice(3, 15)}-${ordinal}`,
						phaseId: phase.id,
						phaseType:
							typeof phase.type === "string"
								? phase.type
								: "agent",
						origin: "bound-fragment" as const,
						boundFragmentHash:
							fragment.boundFragmentHash,
						status,
						attemptCount: 0,
						ordinal:
							staticNodes.length +
							fragmentOrdinal * 100 +
							ordinal,
						displayLabel: displayLabel || phase.id,
					},
				];
			});
		},
	);
	const nodes = [...staticNodes, ...dynamicNodes];
	const attempts = phaseAttempts.map(
		(attempt, attemptOrdinal): RunAttemptProjection => ({
			attemptId: attempt.attemptId,
			nodeInstanceId: attempt.phaseId,
			attemptOrdinal,
			...(attempt.providerName
				? { provider: attempt.providerName }
				: {}),
			status: attempt.status,
			...(attempt.startedAt === undefined
				? {}
				: { startedAt: attempt.startedAt }),
			...(attempt.endedAt === undefined
				? {}
				: { endedAt: attempt.endedAt }),
			providerJobHandlePresent: attempt.handle !== undefined,
			...(attempt.error
				? { error: attempt.error.slice(0, 8_192) }
				: {}),
		}),
	);
	return { nodes, attempts };
}

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
	/** Standalone skips global concurrency claims across projects. */
	reconcileBudget?: ReconcileBudget;
	/**
	 * Project identity policy for ControlStore open (P3).
	 * Default strict: refuse clone/worktree silent domain share.
	 */
	identityPolicy?: IdentityOpenPolicy;
	/**
	 * Daemon startup fast path for an already-mounted registry entry. The
	 * authoritative store header/path must match exactly or startup fails.
	 */
	registeredRegistryEntry?: RegistryEntry;
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

export interface ApprovalDispatchRecoveryItem {
	runId: string;
	outcome: "resumed" | "failed";
	reason?: string;
}

export interface ApprovalDispatchRecoveryReport {
	inspected: number;
	resumed: number;
	failed: number;
	items: ApprovalDispatchRecoveryItem[];
}

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
	cancel(
		runId: string,
		opts?: { commandId?: string; principal?: string; expectedRunVersion?: number; reason?: string },
	): Promise<AdmitResult>;
	/** Durable approval: park (release slot) only when provider quiescent (D38). */
	parkForApproval(
		runId: string,
		opts?: {
			expectedRunVersion?: number;
			approvalPhaseId?: string;
			continuationArtifactId?: string;
			message?: string;
			upstream?: string;
		},
	): Promise<AdmitResult>;
	approve(
		runId: string,
		opts?: {
			commandId?: string;
			principal?: string;
			expectedRunVersion?: number;
			approvalRequestId?: string;
		},
	): Promise<AdmitResult>;
	/**
	 * Resume durable approve handoffs left at running+queued by a process
	 * crash. The daemon awaits this before exposing RPC or WebGateway.
	 */
	recoverApprovedContinuations(): Promise<ApprovalDispatchRecoveryReport>;
	/**
	 * Edit parked approval is capability-gated until edited BoundPlan persistence
	 * and the normal dispatcher handoff exist. It must fail closed meanwhile.
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
		opts?: {
			commandId?: string;
			principal?: string;
			expectedRunVersion?: number;
			approvalRequestId?: string;
			note?: string;
		},
	): Promise<AdmitResult>;
	/** Expire pending approval past deadline → blocked. */
	expireApproval(runId: string, opts?: { now?: number }): Promise<AdmitResult>;
	/** Operator force-release of a concurrency reservation (CoordinatorCommandRecord). */
	forceReleaseReservation(
		request: ForceReleaseRequest,
		opts: { commandId?: string; principal: string },
	): { ok: true; commandId: string } | { ok: false; error: ControlError };
	close(): void;
}

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
	/** Attach clients observe only — sole multi-mount writer mutates (P13/D32). */
	const canMutate = role !== "attach";

	const store = openProjectControlStore(opts.projectRoot, {
		identityPolicy: opts.identityPolicy ?? "strict",
	});
	const registry = openControlRegistry(env);
	// Registry discovery is fine for standalone; capacity must not use user-level
	// multi-project coordinator (D5/D30) — project-local baseDir below.
	if (opts.registeredRegistryEntry) {
		const registered = opts.registeredRegistryEntry;
		if (
			registered.mountState !== "mounted" ||
			registered.projectId !== store.header.projectId ||
			registered.controlDomainId !==
				store.header.controlDomainId ||
			path.resolve(registered.projectRoot) !==
				store.projectRoot ||
			path.resolve(registered.directoryBinding.path) !==
				path.resolve(
					store.header.directoryBinding.path,
				)
		) {
			throw Object.assign(
				new Error(
					"TF_AUTHORITY_REVOKED: pre-registered project authority does not match its ControlStore header",
				),
				{ code: "TF_AUTHORITY_REVOKED" },
			);
		}
	} else {
		registry.registerFromStore(store, opts.projectRoot);
	}
	const coordinator =
		controlMode === "standalone"
			? openUserCoordinatorStore(env, { baseDir: projectCoordinatorDir(opts.projectRoot) })
			: openUserCoordinatorStore(env);
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
	/** @deprecated single-provider field — maps to script provider for cancel/reconcile. */
	const provider = scriptProvider;
	const reconcileBudget = opts.reconcileBudget ?? DEFAULT_RECONCILE_BUDGET;

	// Provider handles by runId (memory cache; durable copy on RunProjection.providerHandle)
	const handles = new Map<string, string>();

	/** Resolve handle from memory or durable run projection (restart-safe). */
	function resolveHandle(runId: string): string | undefined {
		const mem = handles.get(runId);
		if (mem) return mem;
		const run = store.getRun(runId);
		if (run?.providerHandle) {
			handles.set(runId, run.providerHandle);
			return run.providerHandle;
		}
		return undefined;
	}

	function attachDenied(op: string): AdmitResult {
		return {
			ok: false,
			error: {
				code: "TF_AUTHORITY_REVOKED",
				message: `singleton attach cannot ${op}; route mutations to the multi-mount writer (holder=${singleton?.lock.holderId ?? "?"})`,
				recoveryAction: "retry-same-command",
				sideEffects: "none",
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
			},
		};
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

		const handle = resolveHandle(runId);
		if (!handle) {
			// Non-terminal without durable handle → cannot prove quiescent
			if (
				run.status === "running" ||
				run.status === "unknown" ||
				run.stage === "executing" ||
				run.stage === "reconciling"
			) {
				return false;
			}
			return true;
		}

		// isLive is authoritative when implemented (covers quiesceAll + pid liveness).
		if (typeof provider.isLive === "function") {
			return !provider.isLive(handle);
		}

		// No isLive — use durable handle record after restart.
		if (typeof provider.loadHandle === "function") {
			const rec = provider.loadHandle(handle);
			if (!rec) {
				// Handle missing for non-terminal → not proven quiescent
				return false;
			}
			if (rec.status === "running") return false;
			return (
				rec.status === "completed" || rec.status === "failed" || rec.status === "cancelled"
			);
		}

		// Cannot prove → fail-closed not quiescent
		return false;
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

	function discloseProjectCommand(
		commandId: string,
		principal: string,
		requestHash: string,
	): AdmitResult | null {
		const prior = store.getCommand(commandId);
		if (!prior) return null;
		if (prior.requestHash !== requestHash) {
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
		if (prior.callerPrincipal !== principal) {
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
		const boundRunId = store.getRunIdForCommand(commandId) ?? prior.runId;
		const run = boundRunId ? store.getRun(boundRunId) : null;
		if (!run) {
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
		const receipt = store.getReceiptForRun(run.runId);
		if (prior.status === "accepted" || run.needsOperator || run.status === "unknown") {
			const error = reconcileRequiredError("command outcome is pending or requires reconcile", {
				commandId,
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
			});
			return {
				ok: false,
				run,
				error,
				snapshot: { run, controlError: error, receipt },
			};
		}
		return {
			ok: prior.status === "completed",
			run,
			receipt: receipt ?? undefined,
			snapshot: { run, receipt },
		};
	}

	function newProjectCommand(input: {
		commandId: string;
		requestHash: string;
		principal: string;
		kind: string;
		runId: string;
		status: CommandRecord["status"];
		firstCommitSeq?: number;
	}): CommandRecord {
		return {
			commandId: input.commandId,
			requestHash: input.requestHash,
			callerPrincipal: input.principal,
			authorizationContextHash: hashRequest({ principal: input.principal }),
			projectId: store.header.projectId,
			controlDomainId: store.header.controlDomainId,
			kind: input.kind,
			status: input.status,
			firstCommitSeq: input.firstCommitSeq ?? 0,
			lastCommitSeq: 0,
			runId: input.runId,
			recordedAt: Date.now(),
		};
	}

	function emit(
		run: RunProjection,
		payload: ControlEvent["payload"],
		command?: Parameters<ProjectControlStore["commit"]>[0]["command"],
		receipt?: Receipt,
		boundPlan?: BoundPlan,
	): RunProjection {
		const ev: ControlEvent = {
			eventId: newId("ev"),
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
		store.commit({ command, events: [ev], run, receipt, boundPlan });
		return store.getRun(run.runId) ?? run;
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

	function issueReceipt(
		run: RunProjection,
		boundPlan: BoundPlan,
		/** When committing in the same batch, pass event ids about to be written. */
		pendingEventIds?: string[],
		traceAttempts: readonly PhaseAttempt[] = [],
	): Receipt {
		const events = store.readEvents(1, store.nextCommitSeq());
		const runEvents = events.filter(
			(e) => e.streamId === run.runId || (e.payload as { runId?: string }).runId === run.runId,
		);
		const manifest =
			pendingEventIds && pendingEventIds.length > 0
				? [...runEvents.map((e) => e.eventId), ...pendingEventIds]
				: runEvents.map((e) => e.eventId);
		const receiptId = newId("rcpt");
		const resultArtifact =
			run.finalOutput === undefined
				? undefined
				: store.putArtifact({
						bytes: Buffer.from(
							run.finalOutput,
							"utf8",
						),
						mediaType:
							"text/plain; charset=utf-8",
						role: "final-output",
						redactionClass: "project",
						runId: run.runId,
						receiptId,
						fileName: `${run.runId}-result.txt`,
					});
		const traceArtifact = store.putArtifact({
			bytes: Buffer.from(
				buildControlReplayTrace(
					run,
					boundPlan,
					traceAttempts,
				),
				"utf8",
			),
			mediaType:
				"application/x-ndjson; charset=utf-8",
			role: "replay-trace",
			redactionClass: "sensitive",
			runId: run.runId,
			receiptId,
			fileName: `${run.runId}-replay.jsonl`,
		});
		const durableBoundPlan =
			store.getBoundPlan(boundPlan.boundPlanHash);
		const attemptsHaveCompleteProvenance =
			traceAttempts.length > 0 &&
			traceAttempts.every(
				(attempt) =>
					attempt.status === "skipped" ||
					(attempt.status === "completed" &&
						attempt.type === "approval") ||
					(attempt.status === "completed" &&
						typeof attempt.providerName === "string" &&
						attempt.providerName.length > 0 &&
						typeof attempt.handle === "string" &&
						attempt.handle.length > 0 &&
						attempt.startedAt !== undefined &&
						attempt.endedAt !== undefined),
			);
		const fragmentProvenanceComplete =
			run.boundFragmentHash === undefined ||
			(store.getBoundFragment(run.boundFragmentHash) !== null &&
				store
					.listBoundFragmentsForRun(run.runId)
					.some(
						(candidate) =>
							candidate.fragment
								.boundFragmentHash ===
							run.boundFragmentHash,
					));
		const provenance =
			durableBoundPlan?.executionSemanticHash ===
				boundPlan.executionSemanticHash &&
			attemptsHaveCompleteProvenance &&
			fragmentProvenanceComplete
				? "ok"
				: "unknown";
		const receipt: Receipt = {
			receiptId,
			controlDomainId: store.header.controlDomainId,
			projectId: store.header.projectId,
			runId: run.runId,
			boundPlanHash: boundPlan.boundPlanHash,
			boundFragmentHash: run.boundFragmentHash,
			eventManifest: manifest,
			startCommitSeq: runEvents[0]?.commitSeq ?? store.nextCommitSeq(),
			endCommitSeq: store.nextCommitSeq() + Math.max(0, (pendingEventIds?.length ?? 0) - 1),
			artifactRefs: [
				...(resultArtifact
					? [resultArtifact.artifactId]
					: []),
				traceArtifact.artifactId,
			],
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
				artifactIntegrity: "ok",
				provenance,
			},
			buildInfo: { packageVersion: "0.3.0", controlSchemaVersion: 1 },
			issuedAt: Date.now(),
		};
		return receipt;
	}

	async function dispatchApprovedContinuation(input: {
		run: RunProjection;
		boundPlan: BoundPlan;
		checkpoint: ApprovalContinuationCheckpoint;
		reservationId: string;
		commandId: string;
		approvalNote?: string;
	}): Promise<AdmitResult> {
		const runId = input.run.runId;
		const dispatched = store.compareAndCommit({
			runId,
			expectedRunVersion: input.run.runVersion,
			validate: (run) =>
				run.status === "running" &&
				run.stage === "queued" &&
				run.reservationId === input.reservationId
					? null
					: "approval continuation dispatch requires the exact queued reservation binding",
			build: (run) => ({
				run: {
					...run,
					status: "running",
					stage: "executing",
					needsOperator: false,
					error: undefined,
					updatedAt: Date.now(),
					runVersion: run.runVersion + 1,
				},
				events: [
					makeEvent(
						runId,
						{
							type: "RunAdmitted",
							runId,
							reservationId:
								input.reservationId,
						},
						input.commandId,
					),
					makeEvent(
						runId,
						{
							type: "RunStatusChanged",
							runId,
							status: "running",
							stage: "executing",
							reason:
								"approval-continuation-dispatched",
						},
						input.commandId,
					),
				],
			}),
		});
		if (!dispatched.ok) {
			return casError(
				dispatched.code,
				dispatched.message,
				dispatched.run,
			);
		}
		let run = dispatched.run;

		const phaseRecords =
			input.boundPlan.program &&
			typeof input.boundPlan.program === "object" &&
			Array.isArray(
				(input.boundPlan.program as { phases?: unknown })
					.phases,
			)
				? (input.boundPlan.program as {
						phases: Array<Record<string, unknown>>;
					}).phases
				: [];
		const linkedFragments =
			store.listBoundFragmentsForRun(runId);

		const scheduled = await schedulePhases(
			input.boundPlan.program,
			{ script: scriptProvider, llm: llmProvider },
			{
				runId,
				cwd: opts.projectRoot,
				phaseDeadlineMs:
					reconcileBudget.deadlineMs ?? 60_000,
				resume: {
					attempts: input.checkpoint.attempts,
					phaseOutputs:
						input.checkpoint.phaseOutputs,
					approvedApproval: {
						phaseId:
							input.checkpoint
								.approvalPhaseId,
						...(input.approvalNote
							? {
									note:
										input.approvalNote,
								}
							: {}),
					},
				},
				onAttemptStarted: (
					startedAttempt,
					settledAttempts,
				) => {
					const inventory = projectPhaseInventory(
						phaseRecords,
						[
							...settledAttempts,
							startedAttempt,
						],
						linkedFragments,
					);
					if (startedAttempt.handle) {
						handles.set(
							runId,
							startedAttempt.handle,
						);
					}
					run = emit(
						{
							...run,
							...(startedAttempt.handle
								? {
										providerHandle:
											startedAttempt.handle,
										providerName:
											startedAttempt.providerName,
										...(startedAttempt.leaseEpoch ===
										undefined
											? {}
											: {
													providerLeaseEpoch:
														startedAttempt.leaseEpoch,
												}),
									}
								: {}),
							nodes: inventory.nodes,
							attempts:
								inventory.attempts,
							updatedAt: Date.now(),
							runVersion:
								run.runVersion + 1,
						},
						{
							type: "Generic",
							kind:
								"PhaseAttemptStarted",
							data: {
								attemptId:
									startedAttempt.attemptId,
								nodeInstanceId:
									startedAttempt.phaseId,
								provider:
									startedAttempt.providerName,
								providerJobHandlePresent:
									startedAttempt.handle !==
									undefined,
								...(startedAttempt.leaseEpoch ===
								undefined
									? {}
									: {
											providerLeaseEpoch:
												startedAttempt.leaseEpoch,
										}),
							},
						},
					);
				},
				onFragmentResolved: (
					resolved: ResolvedDynamicFragment,
				) => {
					const fragmentLink = linkProgram({
						program: resolved.fragment,
					});
					if (!fragmentLink.ok) {
						throw new Error(
							fragmentLink.errors.join("; "),
						);
					}
					const fragment = bindFragment({
						fragment:
							fragmentLink.boundPlan.program,
						parentBoundPlanHash:
							input.boundPlan.boundPlanHash,
						meta: {
							originPhaseId:
								resolved.originPhaseId,
							linkKind: resolved.linkKind,
						},
					});
					const nowLinked = Date.now();
					const pendingLink: BoundFragmentLink = {
						linkId: newId("bfl"),
						projectId: store.header.projectId,
						controlDomainId:
							store.header.controlDomainId,
						runId,
						boundFragmentHash:
							fragment.boundFragmentHash,
						parentNodeInstanceId:
							resolved.parentNodeInstanceId,
						originPhaseId:
							resolved.originPhaseId,
						causationId: input.commandId,
						linkKind: resolved.linkKind,
						createdAtCommitSeq: 0,
						dynamicNodeCount:
							resolved.fragment.phases.length,
						staticNodeCount:
							resolved.fragment.phases.length,
						createdAt: nowLinked,
					};
					const prospective = [
						...linkedFragments,
						{
							fragment,
							link: pendingLink,
						},
					];
					run = {
						...run,
						boundFragmentHash:
							fragment.boundFragmentHash,
						nodes: projectPhaseInventory(
							phaseRecords,
							[],
							prospective,
						).nodes,
						updatedAt: nowLinked,
						runVersion:
							run.runVersion + 1,
					};
					const event = makeEvent(
						runId,
						{
							type: "BoundFragmentLinked",
							runId,
							boundFragmentHash:
								fragment.boundFragmentHash,
							parentNodeInstanceId:
								resolved.parentNodeInstanceId,
							originPhaseId:
								resolved.originPhaseId,
							linkKind:
								resolved.linkKind,
						},
						input.commandId,
					);
					event.causationId = input.commandId;
					store.commit({
						events: [event],
						run,
						boundFragment: fragment,
						boundFragmentLink: pendingLink,
					});
					run = store.getRun(runId) ?? run;
					const durable = store
						.listBoundFragmentsForRun(runId)
						.find(
							(candidate) =>
								candidate.fragment
									.boundFragmentHash ===
									fragment.boundFragmentHash &&
								candidate.link
									.parentNodeInstanceId ===
									resolved.parentNodeInstanceId,
						);
					if (!durable) {
						throw new Error(
							"BoundFragment link did not survive its journal commit",
						);
					}
					linkedFragments.push(durable);
				},
			},
		);

		let externallyChanged = store.getRun(runId);
		if (
			externallyChanged &&
			(externallyChanged.status !== "running" ||
				externallyChanged.stage !== "executing")
		) {
			for (
				let attempt = 0;
				attempt < 50 &&
				externallyChanged.status === "paused" &&
				externallyChanged.stage === "executing";
				attempt += 1
			) {
				await new Promise((resolve) =>
					setTimeout(resolve, 10),
				);
				externallyChanged =
					store.getRun(runId) ??
					externallyChanged;
			}
			const receipt =
				store.getReceiptForRun(runId) ?? undefined;
			return {
				ok:
					externallyChanged.status ===
					"completed",
				run: externallyChanged,
				...(receipt ? { receipt } : {}),
				snapshot: {
					run: externallyChanged,
					...(receipt ? { receipt } : {}),
				},
			};
		}

		const lastHandle =
			scheduled.stillRunning?.handle ??
			[...scheduled.attempts]
				.reverse()
				.find((attempt) => attempt.handle)?.handle;
		if (lastHandle) handles.set(runId, lastHandle);
		const finalInventory = projectPhaseInventory(
			phaseRecords,
			scheduled.attempts,
			linkedFragments,
		);
		run = emit(
			{
				...run,
				...(lastHandle
					? {
							providerHandle: lastHandle,
							providerName:
								scheduled.stillRunning
									?.providerName ??
								scheduled.attempts.find(
									(attempt) =>
										attempt.handle ===
										lastHandle,
								)?.providerName,
						}
					: {}),
				nodes: finalInventory.nodes,
				attempts: finalInventory.attempts,
				updatedAt: Date.now(),
				runVersion: run.runVersion + 1,
			},
			{
				type: "Generic",
				kind: "PhaseScheduleComplete",
				data: {
					attempts:
						finalInventory.attempts.map(
							(attempt) => ({
								attemptId:
									attempt.attemptId,
								nodeInstanceId:
									attempt.nodeInstanceId,
								attemptOrdinal:
									attempt.attemptOrdinal,
								status: attempt.status,
								provider:
									attempt.provider,
								providerJobHandlePresent:
									attempt.providerJobHandlePresent,
							}),
					),
				},
			},
		);

		if (scheduled.approvalRequired) {
			const checkpoint =
				createApprovalContinuationCheckpoint({
					runId,
					boundPlanHash:
						input.boundPlan.boundPlanHash,
					approvalPhaseId:
						scheduled.approvalRequired.phaseId,
					attempts: scheduled.attempts,
					phaseOutputs: scheduled.phaseOutputs,
				});
			const artifact = store.putArtifact({
				bytes: encodeApprovalContinuationCheckpoint(
					checkpoint,
				),
				mediaType:
					"application/vnd.taskflow.approval-continuation+json",
				role: "approval-continuation",
				redactionClass: "secret",
				runId,
				fileName: `${runId}-approval-continuation.json`,
			});
			run = emit(
				{
					...run,
					approvalContinuationArtifactId:
						artifact.artifactId,
					nodes: (run.nodes ?? []).map(
						(node) =>
							node.nodeInstanceId ===
							scheduled.approvalRequired!
								.phaseId
								? {
										...node,
										status: "waiting",
									}
								: node,
					),
					updatedAt: Date.now(),
					runVersion: run.runVersion + 1,
				},
				{
					type: "Generic",
					kind:
						"ApprovalContinuationCheckpointed",
					data: {
						approvalPhaseId:
							scheduled.approvalRequired
								.phaseId,
						artifactId:
							artifact.artifactId,
						digest: artifact.digest,
					},
				},
			);
			return host.parkForApproval(runId, {
				expectedRunVersion: run.runVersion,
				approvalPhaseId:
					scheduled.approvalRequired.phaseId,
				continuationArtifactId:
					artifact.artifactId,
				message:
					scheduled.approvalRequired.message,
				upstream:
					scheduled.approvalRequired.upstream,
			});
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
				{
					type: "ReconcileStarted",
					runId,
					attempt: 1,
				},
			);
			const outcome = await boundedReconcile(
				scheduled.stillRunning.provider,
				scheduled.stillRunning.handle,
				reconcileBudget,
			);
			run = applyReconcileToRun(run, outcome);
			if (outcome.exhausted) {
				coordinator.markOrphanSuspect(
					input.reservationId,
				);
				run = emit(run, {
					type: "NeedsOperator",
					runId,
					code: "TF_RECONCILE_REQUIRED",
				});
				const error = reconcileRequiredError(
					"approved continuation reconcile exhausted",
					{
						commandId: input.commandId,
						projectId: store.header.projectId,
						controlDomainId:
							store.header.controlDomainId,
					},
				);
				return {
					ok: false,
					run,
					error,
					snapshot: {
						run,
						controlError: error,
						receipt: null,
					},
				};
			}
			if (
				outcome.terminal === "completed" ||
				run.status === "completed"
			) {
				run = emit(
					{
						...run,
						status: "completed",
						stage: "terminal",
					},
					{
						type: "RunStatusChanged",
						runId,
						status: "completed",
						stage: "terminal",
					},
				);
				coordinator.normalRelease(
					input.reservationId,
					{
						noLiveOrAmbiguousSideEffects:
							true,
						runIsTerminal: true,
						runIsParkedAndFutureDispatchRequiresReadmission:
							false,
					},
				);
				const receipt = issueReceipt(
					run,
					input.boundPlan,
					undefined,
					scheduled.attempts,
				);
				run = emit(
					{
						...run,
						receiptId: receipt.receiptId,
					},
					{
						type: "ReceiptIssued",
						runId,
						receiptId: receipt.receiptId,
					},
					undefined,
					receipt,
				);
				return {
					ok: true,
					run,
					receipt,
					snapshot: { run, receipt },
				};
			}
			if (outcome.terminal) {
				run = emit(
					{ ...run, stage: "terminal" },
					{
						type: "RunStatusChanged",
						runId,
						status: run.status,
						stage: "terminal",
					},
				);
				coordinator.normalRelease(
					input.reservationId,
					{
						noLiveOrAmbiguousSideEffects:
							true,
						runIsTerminal: true,
						runIsParkedAndFutureDispatchRequiresReadmission:
							false,
					},
				);
				return {
					ok: false,
					run,
					snapshot: { run, receipt: null },
				};
			}
			const error = reconcileRequiredError(
				"approved continuation reconcile did not settle",
				{
					commandId: input.commandId,
					projectId: store.header.projectId,
					controlDomainId:
						store.header.controlDomainId,
				},
			);
			return {
				ok: false,
				run,
				error,
				snapshot: {
					run,
					controlError: error,
					receipt: null,
				},
			};
		}

		if (!scheduled.ok) {
			run = emit(
				{
					...run,
					status: "failed",
					stage: "terminal",
					error: scheduled.error,
					finalOutput:
						Object.values(
							scheduled.phaseOutputs,
						).join("\n") || undefined,
					updatedAt: Date.now(),
					runVersion: run.runVersion + 1,
				},
				{
					type: "RunStatusChanged",
					runId,
					status: "failed",
					stage: "terminal",
					reason: scheduled.error,
				},
			);
			coordinator.normalRelease(input.reservationId, {
				noLiveOrAmbiguousSideEffects: true,
				runIsTerminal: true,
				runIsParkedAndFutureDispatchRequiresReadmission:
					false,
			});
			return {
				ok: false,
				run,
				error: {
					code: "TF_COMMAND_FAILED",
					message:
						scheduled.error ??
						"approved continuation failed",
					recoveryAction: "none",
					sideEffects: "possible",
				},
				snapshot: { run, receipt: null },
			};
		}

		run = emit(
			{
				...run,
				status: "completed",
				stage: "terminal",
				finalOutput: scheduled.finalOutput,
				updatedAt: Date.now(),
				runVersion: run.runVersion + 1,
			},
			{
				type: "RunStatusChanged",
				runId,
				status: "completed",
				stage: "terminal",
			},
		);
		coordinator.normalRelease(input.reservationId, {
			noLiveOrAmbiguousSideEffects: true,
			runIsTerminal: true,
			runIsParkedAndFutureDispatchRequiresReadmission:
				false,
		});
		const receipt = issueReceipt(
			run,
			input.boundPlan,
			undefined,
			scheduled.attempts,
		);
		run = emit(
			{ ...run, receiptId: receipt.receiptId },
			{
				type: "ReceiptIssued",
				runId,
				receiptId: receipt.receiptId,
			},
			undefined,
			receipt,
		);
		return {
			ok: true,
			run,
			receipt,
			snapshot: { run, receipt },
		};
	}

	let approvalRecoveryInFlight:
		| Promise<ApprovalDispatchRecoveryReport>
		| undefined;

	function failInterruptedApprovalRecovery(
		run: RunProjection,
		reason: string,
		commandId?: string,
	): RunProjection {
		const reservation = run.reservationId
			? coordinator.getReservation(run.reservationId)
			: null;
		if (
			reservation?.state === "committed" ||
			reservation?.state === "orphan-suspect"
		) {
			try {
				coordinator.markOrphanSuspect(
					reservation.reservationId,
				);
			} catch {
				/* the project Run remains the durable recovery authority */
			}
		}
		const failed = store.compareAndCommit({
			runId: run.runId,
			expectedRunVersion: run.runVersion,
			validate: (current) =>
				current.status === "running" &&
				(current.stage === "queued" ||
					current.stage === "executing") &&
				current.receiptId === undefined &&
				current.reservationId === run.reservationId
					? null
					: "interrupted approval recovery state changed",
			build: (current) => ({
				run: {
					...current,
					status: "unknown",
					stage: "reconciling",
					needsOperator: true,
					error: reason.slice(0, 8_192),
					updatedAt: Date.now(),
					runVersion: current.runVersion + 1,
				},
				events: [
					makeEvent(
						current.runId,
						{
							type: "NeedsOperator",
							runId: current.runId,
							code: "TF_RECONCILE_REQUIRED",
						},
						commandId,
					),
				],
			}),
		});
		return failed.ok ? failed.run : failed.run ?? run;
	}

	async function runApprovalRecovery(): Promise<ApprovalDispatchRecoveryReport> {
		const candidates = canMutate
			? store.listApprovalRecoveryRuns()
			: [];
		const report: ApprovalDispatchRecoveryReport = {
			inspected: candidates.length,
			resumed: 0,
			failed: 0,
			items: [],
		};

		for (const candidate of candidates) {
			let run =
				store.getRun(candidate.runId) ?? candidate;
			if (run.stage === "executing") {
				const reason =
					"approval dispatch was interrupted after execution began; provider side effects cannot be replayed safely";
				run = failInterruptedApprovalRecovery(
					run,
					`approved continuation startup recovery failed: ${reason}`,
				);
				report.failed += 1;
				report.items.push({
					runId: run.runId,
					outcome: "failed",
					reason,
				});
				continue;
			}
			let inspection = inspectQueuedApprovalDispatch({
				store,
				coordinator,
				run,
			});
			if (!inspection.ok) {
				run = failInterruptedApprovalRecovery(
					run,
					`approved continuation startup recovery failed: ${inspection.reason}`,
				);
				report.failed += 1;
				report.items.push({
					runId: run.runId,
					outcome: "failed",
					reason: inspection.reason,
				});
				continue;
			}

			let evidence = inspection.evidence;
			try {
				if (evidence.reservation.state === "reserved") {
					coordinator.commitReservation(
						evidence.reservation.reservationId,
						{
							projectId:
								store.header.projectId,
							projectControlDomainId:
								store.header
									.controlDomainId,
							runId: run.runId,
							projectAdmitCommitSeq:
								evidence
									.projectAdmitCommitSeq,
						},
					);
				}

				let approval = evidence.approval;
				if (approval.status === "pending") {
					const decided = decideApproval(
						store.projectRoot,
						approval.approvalRequestId,
						{
							decision: "approve",
							principal:
								evidence.principal,
							commandId:
								evidence.commandId,
						},
					);
					if (!decided.ok) {
						throw new Error(
							`ApprovalRequest decision could not be recovered: ${decided.message}`,
						);
					}
					approval = decided.request;
				}

				const currentCommand = store.getCommand(
					evidence.commandId,
				);
				if (
					!currentCommand ||
					(currentCommand.status !== "accepted" &&
						currentCommand.status !==
							"completed")
				) {
					throw new Error(
						"approve CommandRecord changed during recovery",
					);
				}
				run =
					store.getRun(run.runId) ??
					run;
				if (currentCommand.status === "accepted") {
					const settled = store.compareAndCommit({
						runId: run.runId,
						expectedRunVersion:
							run.runVersion,
						validate: (current) =>
							current.status ===
								"running" &&
							current.stage === "queued" &&
							current.reservationId ===
								evidence.reservation
									.reservationId
								? null
								: "approval recovery settlement requires the exact queued reservation",
						build: (current) => ({
							command: newProjectCommand({
								commandId:
									evidence.commandId,
								requestHash:
									currentCommand.requestHash,
								principal:
									evidence.principal,
								kind: "approve",
								runId: current.runId,
								status: "completed",
								firstCommitSeq:
									currentCommand.firstCommitSeq,
							}),
							run: {
								...current,
								updatedAt:
									Date.now(),
								runVersion:
									current.runVersion +
									1,
							},
							events: [
								makeEvent(
									current.runId,
									{
										type: "Generic",
										kind: "ApprovalDispatchAccepted",
										data: {
											approvalRequestId:
												approval.approvalRequestId,
											approvalPhaseId:
												evidence.checkpoint.approvalPhaseId,
											continuationArtifactId:
												approval.continuationArtifactId,
											recoveredAfterRestart:
												true,
										},
									},
									evidence.commandId,
								),
							],
						}),
					});
					if (!settled.ok) {
						throw new Error(
							`approve command settlement could not be recovered: ${settled.message}`,
						);
					}
					run = settled.run;
				}

				/*
				 * Re-inspect after any recovered coordinator / approval /
				 * command mutations. This keeps the dispatch gate identical
				 * for every crash point in the saga.
				 */
				inspection = inspectQueuedApprovalDispatch({
					store,
					coordinator,
					run,
				});
				if (!inspection.ok) {
					throw new Error(inspection.reason);
				}
				evidence = inspection.evidence;
				const result =
					await dispatchApprovedContinuation({
						run,
						boundPlan: evidence.boundPlan,
						checkpoint:
							evidence.checkpoint,
						reservationId:
							evidence.reservation
								.reservationId,
						commandId:
							evidence.commandId,
						...(approval.note
							? {
									approvalNote:
										approval.note,
								}
							: {}),
					});
				const after =
					store.getRun(run.runId) ??
					result.run ??
					run;
				if (
					after.status === "running" &&
					after.stage === "queued"
				) {
					throw new Error(
						result.error?.message ??
							"approved continuation remained queued",
					);
				}
				report.resumed += 1;
				report.items.push({
					runId: after.runId,
					outcome: "resumed",
				});
			} catch (cause) {
				const reason =
					cause instanceof Error
						? cause.message
						: String(cause);
				run = failInterruptedApprovalRecovery(
					store.getRun(run.runId) ?? run,
					`approved continuation startup recovery failed: ${reason}`,
					evidence.commandId,
				);
				report.failed += 1;
				report.items.push({
					runId: run.runId,
					outcome: "failed",
					reason,
				});
			}
		}
		return report;
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
		canMutate,
		singleton,
		store,
		registry,
		coordinator,

		recoverApprovedContinuations() {
			if (!approvalRecoveryInFlight) {
				approvalRecoveryInFlight =
					runApprovalRecovery().finally(() => {
						approvalRecoveryInFlight =
							undefined;
					});
			}
			return approvalRecoveryInFlight;
		},

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

			// Idempotent disclosure is allowed for attach (read-only return of prior result).
			const priorCmd = store.getCommand(commandId);
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

			// New admits require write authority (P13: attach must not fork writers).
			if (!canMutate) return attachDenied("admitAndRun");

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
			const runId = newId("run");
			const now = Date.now();

			// Atomic command claim — concurrent same commandId cannot mint dual Runs.
			const claim = store.claimCommand({
				commandId,
				requestHash,
				callerPrincipal: principal,
				kind: "admitAndRun",
				runId,
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
			if (claim.kind === "existing") {
				// Wait for the first claimer to publish the run (do not mint a second Run).
				const boundRunId = store.getRunIdForCommand(commandId) ?? claim.command.runId;
				if (!boundRunId) {
					return {
						ok: false,
						error: {
							code: "TF_NOT_FOUND",
							message: `command ${commandId} claimed by peer without runId`,
							recoveryAction: "retry-same-command",
							sideEffects: "unknown",
							commandId,
						},
					};
				}
				const deadline = Date.now() + 15_000;
				while (Date.now() < deadline) {
					const match = store.getRun(boundRunId);
					if (match) {
						return {
							ok: true,
							run: match,
							receipt: store.getReceiptForRun(match.runId) ?? undefined,
							snapshot: host.getSnapshot(match.runId) ?? undefined,
						};
					}
					await new Promise((r) => setTimeout(r, 20));
				}
				return {
					ok: false,
					error: {
						code: "TF_NOT_FOUND",
						message: `command ${commandId} in flight; run ${boundRunId} not published in time`,
						recoveryAction: "retry-same-command",
						sideEffects: "unknown",
						commandId,
					},
				};
			}
			// claim.kind === "claimed" — we alone may proceed to mint this runId

			// Reserve (standalone uses project-local coordinator only)
			const reservation = coordinator.reserve({
				coordinatorEpoch: singleton?.lock.fencingEpoch ?? now,
			});
			if (!reservation) {
				return {
					ok: false,
					error: {
						code: "TF_CAPACITY_EXCEEDED",
						message: `maxActiveRuns=${coordinator.maxActiveRuns} capacity full`,
						recoveryAction: "retry-same-command",
						sideEffects: "none",
					},
				};
			}

			let run: RunProjection = {
				runId,
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
				status: "running",
				stage: "queued",
				boundPlanHash: boundPlan.boundPlanHash,
				needsOperator: false,
				reservationId: reservation.reservationId,
				createdAt: now,
				updatedAt: now,
				runVersion: 1,
			};

			const cmd = {
				commandId,
				requestHash,
				callerPrincipal: principal,
				authorizationContextHash: hashRequest({ principal }),
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
				kind: "admitAndRun",
				status: "accepted" as const,
				firstCommitSeq: 0,
				lastCommitSeq: 0,
				runId,
				recordedAt: now,
			};

			run = emit(
				{ ...run, stage: "received" },
				{ type: "RunReceived", runId, boundPlanHash: boundPlan.boundPlanHash },
				cmd,
				undefined,
				boundPlan,
			);

			// Commit reservation after admit event
			const admitSeq = store.nextCommitSeq() - 1;
			coordinator.commitReservation(reservation.reservationId, {
				projectId: store.header.projectId,
				projectControlDomainId: store.header.controlDomainId,
				runId,
				projectAdmitCommitSeq: admitSeq,
			});

			run = emit(
				{ ...run, stage: "admitted", status: "running" },
				{ type: "RunAdmitted", runId, reservationId: reservation.reservationId },
			);

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

			const phaseRecords =
				boundPlan.program &&
				typeof boundPlan.program === "object" &&
				Array.isArray(
					(boundPlan.program as { phases?: unknown }).phases,
				)
					? ((boundPlan.program as {
							phases: Array<Record<string, unknown>>;
						}).phases)
					: [];
			const linkedFragments: Array<{
				fragment: BoundFragment;
				link: BoundFragmentLink;
			}> = [];
			const scheduled = await schedulePhases(
				boundPlan.program,
				{ script: scriptProvider, llm: llmProvider },
				{
					runId,
					cwd: opts.projectRoot,
					phaseDeadlineMs: reconcileBudget.deadlineMs ?? 60_000,
					onAttemptStarted: (
						startedAttempt,
						settledAttempts,
					) => {
						const inventory = projectPhaseInventory(
							phaseRecords,
							[...settledAttempts, startedAttempt],
							linkedFragments,
						);
						if (startedAttempt.handle) {
							handles.set(
								runId,
								startedAttempt.handle,
							);
						}
						run = {
							...run,
							...(startedAttempt.handle
								? {
										providerHandle:
											startedAttempt.handle,
										providerName:
											startedAttempt.providerName,
										...(startedAttempt.leaseEpoch ===
										undefined
											? {}
											: {
													providerLeaseEpoch:
														startedAttempt.leaseEpoch,
												}),
									}
								: {}),
							nodes: inventory.nodes,
							attempts: inventory.attempts,
							updatedAt: Date.now(),
							runVersion: run.runVersion + 1,
						};
						run = emit(run, {
							type: "Generic",
							kind: "PhaseAttemptStarted",
							data: {
								attemptId:
									startedAttempt.attemptId,
								nodeInstanceId:
									startedAttempt.phaseId,
								provider:
									startedAttempt.providerName,
								providerJobHandlePresent:
									startedAttempt.handle !==
									undefined,
								...(startedAttempt.leaseEpoch ===
								undefined
									? {}
									: {
											providerLeaseEpoch:
												startedAttempt.leaseEpoch,
										}),
							},
						});
					},
					onFragmentResolved: (
						resolved: ResolvedDynamicFragment,
					) => {
						const fragmentLink = linkProgram({
							program: resolved.fragment,
						});
						if (!fragmentLink.ok) {
							throw new Error(
								fragmentLink.errors.join("; "),
							);
						}
						const fragment = bindFragment({
							fragment:
								fragmentLink.boundPlan.program,
							parentBoundPlanHash:
								boundPlan.boundPlanHash,
							meta: {
								originPhaseId:
									resolved.originPhaseId,
								linkKind: resolved.linkKind,
							},
						});
						const nowLinked = Date.now();
						const pendingLink: BoundFragmentLink = {
							linkId: newId("bfl"),
							projectId:
								store.header.projectId,
							controlDomainId:
								store.header
									.controlDomainId,
							runId,
							boundFragmentHash:
								fragment.boundFragmentHash,
							parentNodeInstanceId:
								resolved.parentNodeInstanceId,
							originPhaseId:
								resolved.originPhaseId,
							causationId: commandId,
							linkKind: resolved.linkKind,
							createdAtCommitSeq: 0,
							dynamicNodeCount:
								resolved.fragment.phases
									.length,
							staticNodeCount:
								resolved.fragment.phases
									.length,
							createdAt: nowLinked,
						};
						const prospective = [
							...linkedFragments,
							{
								fragment,
								link: pendingLink,
							},
						];
						run = {
							...run,
							boundFragmentHash:
								fragment.boundFragmentHash,
							nodes: projectPhaseInventory(
								phaseRecords,
								[],
								prospective,
							).nodes,
							updatedAt: nowLinked,
							runVersion:
								run.runVersion + 1,
						};
						const event = makeEvent(
							runId,
							{
								type: "BoundFragmentLinked",
								runId,
								boundFragmentHash:
									fragment.boundFragmentHash,
								parentNodeInstanceId:
									resolved.parentNodeInstanceId,
								originPhaseId:
									resolved.originPhaseId,
								linkKind:
									resolved.linkKind,
							},
							commandId,
						);
						event.causationId = commandId;
						store.commit({
							events: [event],
							run,
							boundFragment: fragment,
							boundFragmentLink:
								pendingLink,
						});
						run = store.getRun(runId) ?? run;
						const durable = store
							.listBoundFragmentsForRun(runId)
							.find(
								(candidate) =>
									candidate.fragment
										.boundFragmentHash ===
										fragment.boundFragmentHash &&
									candidate.link
										.parentNodeInstanceId ===
										resolved.parentNodeInstanceId,
							);
						if (!durable) {
							throw new Error(
								"BoundFragment link did not survive its journal commit",
							);
						}
						linkedFragments.push(durable);
					},
				},
			);

			/*
			 * A durable command may have changed this Run while the provider
			 * poll was suspended. In particular, cancel commits
			 * paused/executing and then cancelled/terminal while unblocking the
			 * provider poll. The executor must never reuse its stale local
			 * projection to overwrite that command outcome as a phase failure.
			 */
			let externallyChanged = store.getRun(runId);
			if (
				externallyChanged &&
				(externallyChanged.status !== "running" ||
					externallyChanged.stage !== "executing")
			) {
				// Give the cancel request's second CAS a bounded chance to
				// replace its transient paused/executing marker.
				for (
					let attempt = 0;
					attempt < 50 &&
					externallyChanged.status === "paused" &&
					externallyChanged.stage === "executing";
					attempt += 1
				) {
					await new Promise((resolve) =>
						setTimeout(resolve, 10),
					);
					externallyChanged =
						store.getRun(runId) ??
						externallyChanged;
				}
				const receipt =
					store.getReceiptForRun(runId) ?? undefined;
				const controlError =
					externallyChanged.status === "unknown" ||
					externallyChanged.needsOperator
						? reconcileRequiredError(
								"execution was superseded by a durable command and requires reconcile",
								{
									commandId,
									projectId:
										store.header.projectId,
									controlDomainId:
										store.header
											.controlDomainId,
								},
							)
						: undefined;
				return {
					ok: externallyChanged.status === "completed",
					run: externallyChanged,
					...(receipt ? { receipt } : {}),
					...(controlError ? { error: controlError } : {}),
					snapshot: {
						run: externallyChanged,
						...(receipt ? { receipt } : {}),
						...(controlError
							? { controlError }
							: {}),
					},
				};
			}

			// Persist last attempt handle for cancel/reconcile of the terminal phase.
			const lastHandle =
				scheduled.stillRunning?.handle ??
				[...scheduled.attempts].reverse().find((a) => a.handle)?.handle;
			const activeProvider = scheduled.stillRunning?.provider ?? scriptProvider;
			const finalInventory = projectPhaseInventory(
				phaseRecords,
				scheduled.attempts,
				linkedFragments,
			);
			const nodeInventory = finalInventory.nodes;
			const attemptInventory = finalInventory.attempts;
			if (lastHandle) {
				handles.set(runId, lastHandle);
				// Keep cancel/reconcile on the provider that owns the live handle.
				if (activeProvider !== scriptProvider) {
					// Prefer LLM/script that submitted the live job for isLive/cancel.
					// `provider` alias below still points at script for default paths;
					// resolveHandle + cancel use handles map + provider.isLive — ensure
					// cancel uses the right provider by storing name on the run.
				}
			}
			run = {
				...run,
				...(lastHandle ? { providerHandle: lastHandle } : {}),
				...(lastHandle
					? {
							providerName:
								scheduled.stillRunning?.providerName ??
								scheduled.attempts.find(
									(attempt) => attempt.handle === lastHandle,
								)?.providerName,
						}
					: {}),
				nodes: nodeInventory,
				attempts: attemptInventory,
				updatedAt: Date.now(),
				runVersion: run.runVersion + 1,
			};
			run = emit(run, {
				type: "Generic",
				kind: "PhaseScheduleComplete",
				data: {
					attempts: attemptInventory.map((attempt) => ({
						attemptId: attempt.attemptId,
						nodeInstanceId: attempt.nodeInstanceId,
						attemptOrdinal: attempt.attemptOrdinal,
						status: attempt.status,
						provider: attempt.provider,
						providerJobHandlePresent:
							attempt.providerJobHandlePresent,
					})),
					stillRunning: scheduled.stillRunning
						? {
								phaseId: scheduled.stillRunning.phaseId,
								provider: scheduled.stillRunning.providerName,
							}
						: undefined,
				},
			});

			if (scheduled.approvalRequired) {
				try {
					const checkpoint =
						createApprovalContinuationCheckpoint({
							runId,
							boundPlanHash:
								boundPlan.boundPlanHash,
							approvalPhaseId:
								scheduled.approvalRequired
									.phaseId,
							attempts: scheduled.attempts,
							phaseOutputs:
								scheduled.phaseOutputs,
						});
					const checkpointArtifact =
						store.putArtifact({
							bytes: encodeApprovalContinuationCheckpoint(
								checkpoint,
							),
							mediaType:
								"application/vnd.taskflow.approval-continuation+json",
							role: "approval-continuation",
							redactionClass: "secret",
							runId,
							fileName: `${runId}-approval-continuation.json`,
						});
					run = {
						...run,
						approvalContinuationArtifactId:
							checkpointArtifact.artifactId,
						nodes: (run.nodes ?? []).map(
							(node) =>
								node.nodeInstanceId ===
								scheduled
									.approvalRequired!
									.phaseId
									? {
											...node,
											status: "waiting",
										}
									: node,
						),
						updatedAt: Date.now(),
						runVersion:
							run.runVersion + 1,
					};
					run = emit(run, {
						type: "Generic",
						kind:
							"ApprovalContinuationCheckpointed",
						data: {
							approvalPhaseId:
								scheduled.approvalRequired
									.phaseId,
							artifactId:
								checkpointArtifact.artifactId,
							digest:
								checkpointArtifact.digest,
						},
					});
					return host.parkForApproval(runId, {
						expectedRunVersion:
							run.runVersion,
						approvalPhaseId:
							scheduled.approvalRequired
								.phaseId,
						continuationArtifactId:
							checkpointArtifact.artifactId,
						message:
							scheduled.approvalRequired
								.message,
						upstream:
							scheduled.approvalRequired
								.upstream,
					});
				} catch (cause) {
					run = {
						...run,
						status: "unknown",
						stage: "reconciling",
						needsOperator: true,
						error:
							"approval continuation checkpoint could not be persisted",
						updatedAt: Date.now(),
						runVersion:
							run.runVersion + 1,
					};
					run = emit(run, {
						type: "NeedsOperator",
						runId,
						code: "TF_RECONCILE_REQUIRED",
					});
					coordinator.markOrphanSuspect(
						reservation.reservationId,
					);
					const error = reconcileRequiredError(
						`approval continuation checkpoint failed: ${cause instanceof Error ? cause.message : String(cause)}`,
						{
							commandId,
							projectId:
								store.header.projectId,
							controlDomainId:
								store.header
									.controlDomainId,
						},
					);
					return {
						ok: false,
						run,
						error,
						snapshot: {
							run,
							controlError: error,
							receipt: null,
						},
					};
				}
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
						const receipt = issueReceipt(
							run,
							boundPlan,
							undefined,
							scheduled.attempts,
						);
						const receiptHonest: typeof receipt = {
							...receipt,
							assurance: {
								...receipt.assurance,
							providerOutcome: "ok",
							journalContinuity: "ok",
							artifactIntegrity:
								receipt.assurance.artifactIntegrity,
							provenance:
								receipt.assurance.provenance,
							},
						};
						run = { ...run, receiptId: receiptHonest.receiptId, status: "completed", stage: "terminal" };
						run = emit(
							run,
							{ type: "ReceiptIssued", runId, receiptId: receiptHonest.receiptId },
							undefined,
							receiptHonest,
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
			const receipt = issueReceipt(
				run,
				boundPlan,
				undefined,
				scheduled.attempts,
			);
			const receiptHonest: typeof receipt = {
				...receipt,
				assurance: {
					...receipt.assurance,
					providerOutcome: "ok",
					journalContinuity: "ok",
					artifactIntegrity:
						receipt.assurance.artifactIntegrity,
					provenance: receipt.assurance.provenance,
				},
			};
			run = { ...run, receiptId: receiptHonest.receiptId };
			run = emit(
				run,
				{ type: "ReceiptIssued", runId, receiptId: receiptHonest.receiptId },
				undefined,
				receiptHonest,
			);
			return { ok: true, run, receipt: receiptHonest, snapshot: { run, receipt: receiptHonest } };
		},

		getSnapshot(runId: string): RunSnapshot | null {
			const run = store.getRun(runId);
			if (!run) return null;
			const receipt = store.getReceiptForRun(runId);
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

		async cancel(runId, opts = {}) {
			const commandId = opts.commandId ?? newId("cmd");
			if (!isSafeId(commandId) || !isSafeId(runId)) {
				return casError("TF_INVALID_ARGUMENT", "unsafe commandId or runId");
			}
			const principal = opts.principal ?? "local";
			const requestHash = hashRequest({
				kind: "cancel-run",
				runId,
				expectedRunVersion: opts.expectedRunVersion,
				reason: opts.reason,
			});
			const prior = discloseProjectCommand(commandId, principal, requestHash);
			if (prior) return prior;
			if (!canMutate) return attachDenied("cancel");

			let hadDurableQuiescence = false;
			const requested = store.compareAndCommit({
				runId,
				expectedRunVersion: opts.expectedRunVersion,
				validate: (run) =>
					isTerminalRunStatus(run.status) || run.stage === "terminal" || Boolean(run.receiptId)
						? `cancel requires non-terminal run (have status=${run.status})`
						: null,
				build: (run) => {
					hadDurableQuiescence = run.status === "paused" && run.stage === "parked";
					const command = newProjectCommand({
						commandId,
						requestHash,
						principal,
						kind: "cancel-run",
						runId,
						status: "accepted",
					});
					const next: RunProjection = {
						...run,
						status: "paused",
						stage: "executing",
						updatedAt: Date.now(),
						runVersion: run.runVersion + 1,
					};
					return {
						command,
						run: next,
						events: [
							makeEvent(runId, { type: "CancelRequested", runId }, commandId),
							makeEvent(
								runId,
								{
									type: "RunStatusChanged",
									runId,
									status: "paused",
									stage: "executing",
									reason: opts.reason ?? "cancel-requested",
								},
								commandId,
							),
						],
					};
				},
			});
			if (!requested.ok) {
				return (
					discloseProjectCommand(commandId, principal, requestHash) ??
					casError(requested.code, requested.message, requested.run)
				);
			}

			const handle = resolveHandle(runId);
			let cancellation: Awaited<ReturnType<ExecutionProvider["cancel"]>> | null = null;
			if (handle) {
				try {
					cancellation = await provider.cancel(handle);
				} catch {
					cancellation = { kind: "ambiguous" };
				}
			}

			const cancellationProven =
				hadDurableQuiescence ||
				(handle !== undefined && cancellation?.kind === "cancelled" && providerQuiescent(runId));
			if (cancellationProven) {
				const acceptedCommand = store.getCommand(commandId);
				const settled = store.compareAndCommit({
					runId,
					expectedRunVersion: requested.run.runVersion,
					build: (run) => ({
						command: newProjectCommand({
							commandId,
							requestHash,
							principal,
							kind: "cancel-run",
							runId,
							status: "completed",
							firstCommitSeq: acceptedCommand?.firstCommitSeq,
						}),
						run: {
							...run,
							status: "cancelled",
							stage: "terminal",
							...(run.nodes
								? {
										nodes: settleTerminalNodes(
											run.nodes,
											"cancelled",
										),
									}
								: {}),
							needsOperator: false,
							updatedAt: Date.now(),
							runVersion: run.runVersion + 1,
						},
						events: [
							makeEvent(runId, {
								type: "RunStatusChanged",
								runId,
								status: "cancelled",
								stage: "terminal",
								reason: "cancel-settled",
							}, commandId),
						],
					}),
				});
				if (!settled.ok) return casError(settled.code, settled.message, settled.run);
				if (settled.run.reservationId) {
					try {
						coordinator.normalRelease(settled.run.reservationId, {
							noLiveOrAmbiguousSideEffects: true,
							runIsTerminal: true,
							runIsParkedAndFutureDispatchRequiresReadmission: false,
						});
					} catch {
						/* retain capacity if the release record changed */
					}
				}
				return { ok: true, run: settled.run, snapshot: { run: settled.run } };
			}

			const uncertain = store.compareAndCommit({
				runId,
				expectedRunVersion: requested.run.runVersion,
				build: (run) => ({
					run: {
						...run,
						status: "unknown",
						stage: "reconciling",
						needsOperator: true,
						updatedAt: Date.now(),
						runVersion: run.runVersion + 1,
					},
					events: [
						makeEvent(runId, { type: "ReconcileStarted", runId, attempt: 1 }, commandId),
						makeEvent(runId, { type: "NeedsOperator", runId, code: "TF_RECONCILE_REQUIRED" }, commandId),
					],
				}),
			});
			if (!uncertain.ok) return casError(uncertain.code, uncertain.message, uncertain.run);
			if (uncertain.run.reservationId) {
				try {
					coordinator.markOrphanSuspect(uncertain.run.reservationId);
				} catch {
					/* already released/changed; Run remains unknown */
				}
			}
			const error = reconcileRequiredError("cancel outcome is not proven; capacity remains held", {
				commandId,
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
			});
			return {
				ok: false,
				run: uncertain.run,
				error,
				snapshot: { run: uncertain.run, controlError: error, receipt: null },
			};
		},

		async parkForApproval(runId, opts = {}) {
			if (!canMutate) return attachDenied("parkForApproval");
			let hasValidatedContinuation = false;
			if (
				(opts.approvalPhaseId === undefined) !==
					(opts.continuationArtifactId === undefined) ||
				(opts.approvalPhaseId !== undefined &&
					!isSafeId(opts.approvalPhaseId)) ||
				(opts.continuationArtifactId !== undefined &&
					!isSafeId(opts.continuationArtifactId))
			) {
				return casError(
					"TF_INVALID_ARGUMENT",
					"approval phase and continuation artifact must be supplied together",
				);
			}
			if (opts.continuationArtifactId) {
				const candidateRun = store.getRun(runId);
				const artifact = store.getArtifact(
					opts.continuationArtifactId,
				);
				const bytes = artifact
					? store.readArtifactBytes(artifact.digest)
					: null;
				try {
					const checkpoint = bytes
						? decodeApprovalContinuationCheckpoint(
								bytes,
							)
						: null;
					if (
						!candidateRun ||
						!artifact ||
						!checkpoint ||
						artifact.runId !== runId ||
						artifact.role !==
							"approval-continuation" ||
						artifact.redactionClass !== "secret" ||
						checkpoint.runId !== runId ||
						checkpoint.boundPlanHash !==
							candidateRun.boundPlanHash ||
						checkpoint.approvalPhaseId !==
							opts.approvalPhaseId ||
						!approvalContinuationMatchesRun(
							checkpoint,
							candidateRun,
							{ exact: true },
						) ||
						candidateRun
							.approvalContinuationArtifactId !==
							artifact.artifactId
					) {
						throw new Error(
							"continuation identity or artifact provenance does not match the Run",
						);
					}
					hasValidatedContinuation = true;
				} catch (cause) {
					return {
						ok: false,
						...(candidateRun
							? { run: candidateRun }
							: {}),
						error: {
							code: "TF_DURABILITY_FAILED",
							message: `approval continuation is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
							recoveryAction: "operator",
							sideEffects: "none",
							projectId:
								store.header.projectId,
							controlDomainId:
								store.header
									.controlDomainId,
						},
						...(candidateRun
							? {
									snapshot: {
										run: candidateRun,
										receipt: null,
									},
								}
							: {}),
					};
				}
			}
			// Quiescence check before lock (provider is process-local).
			const pre = store.getRun(runId);
			if (
				pre &&
				!hasValidatedContinuation &&
				!providerQuiescent(runId)
			) {
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
			const cas = store.compareAndCommit({
				runId,
				expectedRunVersion: opts.expectedRunVersion,
				validate: (run) =>
					isTerminalRunStatus(run.status)
						? `parkForApproval requires non-terminal run (have status=${run.status})`
						: null,
				build: (run) => {
					releasedReservationId = run.reservationId;
					const apr = createApprovalRequest(store.projectRoot, {
						runId,
						projectId: store.header.projectId,
						controlDomainId: store.header.controlDomainId,
						...(opts.approvalPhaseId
							? {
									nodeInstanceId:
										opts.approvalPhaseId,
									boundPlanHash:
										run.boundPlanHash,
									continuationArtifactId:
										opts.continuationArtifactId,
									message:
										(
											opts.message ??
											"Approve to continue?"
										).slice(0, 32_768),
									...(opts.upstream
										? {
												upstream:
													opts.upstream.slice(
														0,
														32_768,
													),
											}
										: {}),
									allowedDecisions: [
										"approve",
										"reject",
									],
								}
							: {}),
						expectedRunVersion: run.runVersion + 1,
						deadline: Date.now() + 3_600_000,
					});
					const next: RunProjection = {
						...run,
						status: "paused",
						stage: "parked",
						approvalRequestId: apr.approvalRequestId,
						// Keep this binding until coordinator release is durable.
						reservationId: run.reservationId,
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
			if (!cas.ok) return casError(cas.code, cas.message, cas.run);

			if (releasedReservationId) {
				try {
					coordinator.normalRelease(releasedReservationId, {
						noLiveOrAmbiguousSideEffects: true,
						runIsTerminal: false,
						runIsParkedAndFutureDispatchRequiresReadmission: true,
					});
				} catch (cause) {
					const failed = store.compareAndCommit({
						runId,
						expectedRunVersion: cas.run.runVersion,
						build: (run) => ({
							run: {
								...run,
								needsOperator: true,
								error: "approval parked but coordinator release is unresolved",
								updatedAt: Date.now(),
								runVersion: run.runVersion + 1,
							},
							events: [
								makeEvent(runId, {
									type: "NeedsOperator",
									runId,
									code: "TF_RECONCILE_REQUIRED",
								}),
							],
						}),
					});
					const run = failed.ok ? failed.run : failed.run ?? cas.run;
					const error = reconcileRequiredError(
						`approval parked but reservation release failed: ${cause instanceof Error ? cause.message : String(cause)}`,
						{
							projectId: store.header.projectId,
							controlDomainId: store.header.controlDomainId,
						},
					);
					return {
						ok: false,
						run,
						error,
						snapshot: { run, controlError: error, receipt: null },
					};
				}
			}
				const cleared = store.compareAndCommit({
					runId,
					expectedRunVersion: cas.run.runVersion,
					validate: (run) =>
						run.status === "paused" && run.stage === "parked"
							? null
							: "park state changed before reservation binding was cleared",
					build: (run) => ({
						run: {
							...run,
							reservationId: undefined,
							updatedAt: Date.now(),
							runVersion: run.runVersion + 1,
						},
						events: [makeEvent(runId, { type: "Generic", kind: "ApprovalParkReleaseSettled" })],
					}),
				});
				if (!cleared.ok) {
					const run = cleared.run ?? cas.run;
					const error = reconcileRequiredError(
						"reservation released but project binding clear did not commit",
						{ projectId: store.header.projectId, controlDomainId: store.header.controlDomainId },
					);
					return { ok: false, run, error, snapshot: { run, controlError: error, receipt: null } };
				}
				return { ok: true, run: cleared.run, snapshot: { run: cleared.run } };
			},

		async approve(runId, opts = {}) {
			const commandId = opts.commandId ?? newId("cmd");
			if (!isSafeId(commandId) || !isSafeId(runId)) {
				return casError("TF_INVALID_ARGUMENT", "unsafe commandId or runId");
			}
			const principal = opts.principal ?? "local";
			const requestHash = hashRequest({
				kind: "approve",
				runId,
				expectedRunVersion: opts.expectedRunVersion,
				approvalRequestId: opts.approvalRequestId,
			});
			const prior = discloseProjectCommand(commandId, principal, requestHash);
			if (prior) return prior;
			if (!canMutate) return attachDenied("approve");

			const reservation = coordinator.reserve({
				coordinatorEpoch: singleton?.lock.fencingEpoch ?? Date.now(),
			});
			if (!reservation) {
				const run = store.getRun(runId) ?? undefined;
				return {
					ok: false,
					run,
					error: {
						code: "TF_CAPACITY_EXCEEDED",
						message: "cannot re-reserve after approval",
						recoveryAction: "retry-same-command",
						sideEffects: "none",
					},
				};
			}

			// Phase 1: project ledger records accepted+queued, never completed.
			const cas = store.compareAndCommit({
				runId,
				expectedRunVersion: opts.expectedRunVersion,
				validate: (run) => {
					if (run.status !== "paused" || run.stage !== "parked") {
						return `approve requires paused+parked run (have status=${run.status} stage=${run.stage})`;
					}
					if (run.reservationId !== undefined) {
						return "approval park release saga has not settled";
					}
					if (
						opts.approvalRequestId !== undefined &&
						run.approvalRequestId !== opts.approvalRequestId
					) {
						return "approval request changed; refresh before approve";
					}
					return null;
				},
				build: (run) => {
					const now = Date.now();
					const command = newProjectCommand({
						commandId,
						requestHash,
						principal,
						kind: "approve",
						runId,
						status: "accepted",
					});
					const afterDecide: RunProjection = {
						...run,
						status: "running",
						stage: "queued",
						needsOperator: false,
						reservationId: reservation.reservationId,
						updatedAt: now,
						runVersion: run.runVersion + 1,
					};
					const evDecide = makeEvent(runId, {
						type: "ApprovalDecided",
						runId,
						approvalRequestId: run.approvalRequestId ?? "",
						decision: "approve",
					}, commandId);
					const evStatus = makeEvent(runId, {
						type: "RunStatusChanged",
						runId,
						status: "running",
						stage: "queued",
						reason: "approval-approved-awaiting-dispatch",
					}, commandId);
					return {
						command,
						run: afterDecide,
						events: [evDecide, evStatus],
					};
				},
			});

			if (!cas.ok) {
				// Loser frees pre-admit reserved slot (still `reserved`, TTL-reclaimable too).
				try {
					coordinator.normalRelease(reservation.reservationId, {
						noLiveOrAmbiguousSideEffects: true,
						runIsTerminal: false,
						runIsParkedAndFutureDispatchRequiresReadmission: true,
					});
				} catch {
					/* ignore */
				}
				return (
					discloseProjectCommand(commandId, principal, requestHash) ??
					casError(cas.code, cas.message, cas.run)
				);
			}

			const binding = {
				projectId: store.header.projectId,
				projectControlDomainId: store.header.controlDomainId,
				runId,
				projectAdmitCommitSeq: cas.commitSeqEnd,
			};
			try {
				coordinator.commitReservation(reservation.reservationId, binding);
			} catch (cause) {
				try {
					coordinator.markReservationCommitUnknown(reservation.reservationId, binding);
				} catch {
					/* the Run below remains the durable recovery marker */
				}
				const uncertain = store.compareAndCommit({
					runId,
					expectedRunVersion: cas.run.runVersion,
					build: (run) => ({
						run: {
							...run,
							status: "unknown",
							stage: "reconciling",
							needsOperator: true,
							error: "approval accepted but coordinator binding is unresolved",
							updatedAt: Date.now(),
							runVersion: run.runVersion + 1,
						},
						events: [
							makeEvent(runId, { type: "NeedsOperator", runId, code: "TF_RECONCILE_REQUIRED" }, commandId),
						],
					}),
				});
				const run = uncertain.ok ? uncertain.run : uncertain.run ?? cas.run;
				const error = reconcileRequiredError(
					`approval accepted but coordinator commit failed: ${cause instanceof Error ? cause.message : String(cause)}`,
					{ commandId, projectId: store.header.projectId, controlDomainId: store.header.controlDomainId },
				);
				return { ok: false, run, error, snapshot: { run, controlError: error, receipt: null } };
			}

			const failApprovedDispatch = (
				currentRun: RunProjection,
				reason: string,
			): AdmitResult => {
				try {
					coordinator.markOrphanSuspect(
						reservation.reservationId,
					);
				} catch {
					/* the durable Run remains the recovery authority */
				}
				const pendingDispatch =
					store.compareAndCommit({
						runId,
						expectedRunVersion:
							currentRun.runVersion,
						validate: (run) =>
							!isTerminalRunStatus(
								run.status,
							) &&
							run.stage !== "terminal" &&
							run.receiptId ===
								undefined &&
							run.reservationId ===
								reservation.reservationId
								? null
								: "approved dispatch recovery requires the exact active reservation binding",
						build: (run) => ({
							run: {
								...run,
								status: "unknown",
								stage: "reconciling",
								needsOperator: true,
								error: reason.slice(
									0,
									8_192,
								),
								updatedAt:
									Date.now(),
								runVersion:
									run.runVersion + 1,
							},
							events: [
								makeEvent(
									runId,
									{
										type: "NeedsOperator",
										runId,
										code: "TF_RECONCILE_REQUIRED",
									},
									commandId,
								),
							],
						}),
					});
				const run = pendingDispatch.ok
					? pendingDispatch.run
					: (pendingDispatch.run ?? currentRun);
				const error = reconcileRequiredError(reason, {
					commandId,
					projectId: store.header.projectId,
					controlDomainId:
						store.header.controlDomainId,
				});
				return {
					ok: false,
					run,
					error,
					snapshot: {
						run,
						controlError: error,
						receipt: null,
					},
				};
			};

			const pendingApr = loadApprovalForRun(
				store.projectRoot,
				runId,
			);
			if (
				!pendingApr ||
				pendingApr.approvalRequestId !==
					cas.run.approvalRequestId ||
				pendingApr.runId !== runId ||
				pendingApr.projectId !==
					store.header.projectId ||
				pendingApr.controlDomainId !==
					store.header.controlDomainId
			) {
				return failApprovedDispatch(
					cas.run,
					"approval accepted, but the exact ApprovalRequest cannot be recovered",
				);
			}

			const decided = decideApproval(
				store.projectRoot,
				pendingApr.approvalRequestId,
				{
					decision: "approve",
					principal,
					commandId,
				},
			);
			if (!decided.ok) {
				return failApprovedDispatch(
					cas.run,
					`coordinator committed but ApprovalRequest decision failed: ${decided.message}`,
				);
			}

			let checkpoint: ApprovalContinuationCheckpoint;
			let boundPlan: BoundPlan;
			try {
				if (
					!pendingApr.nodeInstanceId ||
					!pendingApr.boundPlanHash ||
					!pendingApr.continuationArtifactId
				) {
					throw new Error(
						"ApprovalRequest has no scheduler continuation identity",
					);
				}
				if (
					pendingApr.boundPlanHash !==
						cas.run.boundPlanHash ||
					pendingApr.continuationArtifactId !==
						cas.run
							.approvalContinuationArtifactId
				) {
					throw new Error(
						"ApprovalRequest does not match the parked Run",
					);
				}
				const artifact = store.getArtifact(
					pendingApr.continuationArtifactId,
				);
				if (
					!artifact ||
					artifact.runId !== runId ||
					artifact.role !==
						"approval-continuation" ||
					artifact.redactionClass !== "secret" ||
					artifact.mediaType !==
						"application/vnd.taskflow.approval-continuation+json"
				) {
					throw new Error(
						"approval continuation artifact provenance is invalid",
					);
				}
				const bytes = store.readArtifactBytes(
					artifact.digest,
				);
				if (!bytes) {
					throw new Error(
						"approval continuation artifact is missing or corrupt",
					);
				}
				checkpoint =
					decodeApprovalContinuationCheckpoint(
						bytes,
					);
				if (
					checkpoint.runId !== runId ||
					checkpoint.boundPlanHash !==
						pendingApr.boundPlanHash ||
					checkpoint.approvalPhaseId !==
						pendingApr.nodeInstanceId ||
					!approvalContinuationMatchesRun(
						checkpoint,
						cas.run,
						{ exact: true },
					)
				) {
					throw new Error(
						"approval continuation checkpoint identity is invalid",
					);
				}
				boundPlan =
					store.getBoundPlan(
						pendingApr.boundPlanHash,
					) ??
					(() => {
						throw new Error(
							"the original immutable BoundPlan is unavailable",
						);
					})();
				const approvalPhase =
					boundPlan.program &&
					typeof boundPlan.program ===
						"object" &&
					Array.isArray(
						(
							boundPlan.program as {
								phases?: unknown;
							}
						).phases,
					)
						? (
								boundPlan.program as {
									phases: Array<
										Record<
											string,
											unknown
										>
									>;
								}
							).phases.find(
								(phase) =>
									phase.id ===
										checkpoint.approvalPhaseId &&
									phase.type ===
										"approval",
							)
						: undefined;
				if (
					!approvalPhase ||
					checkpoint.attempts.some(
						(attempt) =>
							attempt.phaseId ===
							checkpoint.approvalPhaseId,
					)
				) {
					throw new Error(
						"approval continuation does not identify one unconsumed approval phase",
					);
				}
			} catch (cause) {
				return failApprovedDispatch(
					cas.run,
					`approval is durable, but continuation validation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				);
			}

			const acceptedCommand =
				store.getCommand(commandId);
			const settled = store.compareAndCommit({
				runId,
				expectedRunVersion: cas.run.runVersion,
				validate: (run) =>
					run.status === "running" &&
					run.stage === "queued" &&
					run.reservationId ===
						reservation.reservationId
						? null
						: "approval dispatch settlement requires the exact queued reservation binding",
				build: (run) => ({
					command: newProjectCommand({
						commandId,
						requestHash,
						principal,
						kind: "approve",
						runId,
						status: "completed",
						firstCommitSeq:
							acceptedCommand?.firstCommitSeq,
					}),
					run: {
						...run,
						updatedAt: Date.now(),
						runVersion:
							run.runVersion + 1,
					},
					events: [
						makeEvent(
							runId,
							{
								type: "Generic",
								kind:
									"ApprovalDispatchAccepted",
								data: {
									approvalRequestId:
										pendingApr.approvalRequestId,
									approvalPhaseId:
										checkpoint.approvalPhaseId,
									continuationArtifactId:
										pendingApr.continuationArtifactId,
								},
							},
							commandId,
						),
					],
				}),
			});
			if (!settled.ok) {
				return failApprovedDispatch(
					settled.run ?? cas.run,
					`approval decision is durable, but command settlement failed: ${settled.message}`,
				);
			}

			try {
				return await dispatchApprovedContinuation({
					run: settled.run,
					boundPlan,
					checkpoint,
					reservationId:
						reservation.reservationId,
					commandId,
					...(decided.request.note
						? {
								approvalNote:
									decided.request.note,
							}
						: {}),
				});
			} catch (cause) {
				return failApprovedDispatch(
					store.getRun(runId) ?? settled.run,
					`approval continuation dispatch failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				);
			}
		},

		async edit(runId, opts) {
			if (!canMutate) return attachDenied("edit");
			const note = opts.note?.trim();
			if (!note) {
				return casError("TF_INVALID_ARGUMENT", "edit requires non-empty note/payload");
			}
			const run = store.getRun(runId) ?? undefined;
			return {
				ok: false,
				run,
				error: {
					code: "TF_FEATURE_REQUIRED",
					message:
						"edit approval is disabled until edited BoundPlan persistence and dispatcher handoff are implemented",
					recoveryAction: "none",
					sideEffects: "none",
					projectId: store.header.projectId,
					controlDomainId: store.header.controlDomainId,
				},
				snapshot: run ? { run, receipt: store.getReceiptForRun(runId) } : undefined,
			};
		},

		async reject(runId, opts = {}) {
			const commandId = opts.commandId ?? newId("cmd");
			if (!isSafeId(commandId) || !isSafeId(runId)) {
				return casError("TF_INVALID_ARGUMENT", "unsafe commandId or runId");
			}
			const principal = opts.principal ?? "local";
			const requestHash = hashRequest({
				kind: "reject",
				runId,
				expectedRunVersion: opts.expectedRunVersion,
				approvalRequestId: opts.approvalRequestId,
				reason: opts.note,
			});
			const prior = discloseProjectCommand(
				commandId,
				principal,
				requestHash,
			);
			if (prior) return prior;
			if (!canMutate) return attachDenied("reject");
			const pendingApr = loadApprovalForRun(store.projectRoot, runId);
			if (!pendingApr) {
				return casError(
					"TF_NOT_FOUND",
					"no approval request for run",
					store.getRun(runId) ?? undefined,
				);
			}
			if (
				opts.approvalRequestId !== undefined &&
				opts.approvalRequestId !== pendingApr.approvalRequestId
			) {
				return casError(
					"TF_STALE_VERSION",
					"approval request changed; refresh before reject",
					store.getRun(runId) ?? undefined,
				);
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
					if (
						run.approvalRequestId !==
						pendingApr.approvalRequestId
					) {
						return "approval request changed; refresh before reject";
					}
					return null;
				},
				build: (run) => {
					const command = newProjectCommand({
						commandId,
						requestHash,
						principal,
						kind: "reject",
						runId,
						status: "accepted",
					});
					const next: RunProjection = {
						...run,
						status: "blocked",
						stage: "terminal",
						...(run.nodes
							? {
									nodes: run.nodes.map((node) =>
										node.nodeInstanceId ===
										pendingApr.nodeInstanceId
											? {
													...node,
													status: "blocked",
												}
											: node,
									),
								}
							: {}),
						updatedAt: Date.now(),
						runVersion: run.runVersion + 1,
						error: opts.note ?? "approval rejected",
					};
					return {
						command,
						run: next,
						events: [
							makeEvent(runId, {
								type: "ApprovalDecided",
								runId,
								approvalRequestId: run.approvalRequestId ?? "",
								decision: "reject",
							}, commandId),
							makeEvent(runId, {
								type: "RunStatusChanged",
								runId,
								status: "blocked",
								stage: "terminal",
								reason: "approval rejected",
							}, commandId),
						],
					};
				},
			});
			if (!cas.ok) return casError(cas.code, cas.message, cas.run);
			const decided = decideApproval(
				store.projectRoot,
				pendingApr.approvalRequestId,
				{
					decision: "reject",
					principal,
					commandId,
					note: opts.note,
				},
			);
			if (!decided.ok) {
				const error = reconcileRequiredError(
					`Run rejection committed but ApprovalRequest decision failed: ${decided.message}`,
					{
						commandId,
						projectId: store.header.projectId,
						controlDomainId:
							store.header.controlDomainId,
					},
				);
				return {
					ok: false,
					run: cas.run,
					error,
					snapshot: {
						run: cas.run,
						controlError: error,
						receipt: null,
					},
				};
			}
			const acceptedCommand = store.getCommand(commandId);
			const settled = store.compareAndCommit({
				runId,
				expectedRunVersion: cas.run.runVersion,
				allowTerminalCommandSettlement: true,
				validate: (run) =>
					run.status === "blocked" &&
					run.stage === "terminal" &&
					run.receiptId === undefined
						? null
						: "reject settlement requires the exact terminal blocked Run without a Receipt",
				build: (run) => ({
					command: newProjectCommand({
						commandId,
						requestHash,
						principal,
						kind: "reject",
						runId,
						status: "completed",
						firstCommitSeq:
							acceptedCommand?.firstCommitSeq,
					}),
					run: {
						...run,
						updatedAt: Date.now(),
						runVersion: run.runVersion + 1,
					},
					events: [
						makeEvent(
							runId,
							{
								type: "Generic",
								kind: "ApprovalRejectSettled",
							},
							commandId,
						),
					],
				}),
			});
			if (!settled.ok) {
				const run = settled.run ?? cas.run;
				const error = reconcileRequiredError(
					"Approval rejection is durable, but command settlement requires reconciliation",
					{
						commandId,
						projectId: store.header.projectId,
						controlDomainId:
							store.header.controlDomainId,
					},
				);
				return {
					ok: false,
					run,
					error,
					snapshot: {
						run,
						controlError: error,
						receipt: null,
					},
				};
			}
			return {
				ok: true,
				run: settled.run,
				snapshot: { run: settled.run },
			};
		},

		async expireApproval(runId, opts = {}) {
			if (!canMutate) return attachDenied("expireApproval");
			const pendingApr = loadApprovalForRun(store.projectRoot, runId);
			if (!pendingApr) {
				return casError("TF_NOT_FOUND", "no approval request for run", store.getRun(runId) ?? undefined);
			}
			// Force deadline past so expire takes effect
			const now = opts.now ?? Date.now();
			const expired =
				expireApprovalIfDue(store.projectRoot, pendingApr.approvalRequestId, now) ?? pendingApr;
			if (expired.status === "pending") {
				// No deadline set — force expire on disk
				const forced = { ...expired, status: "expired" as const, decidedAt: now, deadline: now - 1 };
				const { writeFileAtomic, projectControlRoot } = await import("./paths.ts");
				writeFileAtomic(
					`${projectControlRoot(store.projectRoot)}/approvals/${expired.approvalRequestId}.json`,
					JSON.stringify(forced, null, 2),
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
						...(run.nodes
							? {
									nodes: run.nodes.map((node) =>
										node.nodeInstanceId ===
										pendingApr.nodeInstanceId
											? {
													...node,
													status: "blocked",
												}
											: node,
									),
								}
							: {}),
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

		forceReleaseReservation(request, opts) {
			if (!canMutate) {
				return {
					ok: false as const,
					error: attachDenied("forceReleaseReservation").error!,
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
			if (
				!isSafeId(request.reservationId) ||
				!isSafeId(request.expectedProjectId) ||
				!isSafeId(request.expectedControlDomainId) ||
				!isSafeId(request.expectedRunId)
			) {
				return {
					ok: false as const,
					error: {
						code: "TF_INVALID_ARGUMENT" as const,
						message: "unsafe force-release identifier",
						recoveryAction: "none" as const,
						sideEffects: "none" as const,
					},
				};
			}
			try {
				const commandId = opts.commandId ?? newId("cmd");
				if (!isSafeId(commandId)) {
					throw new Error("TF_INVALID_ARGUMENT: unsafe commandId");
				}
				const { command } = coordinator.forceRelease(request, {
					commandId,
					callerPrincipal: opts.principal,
				});
				return { ok: true as const, commandId: command.commandId };
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				const code = msg.includes("STALE_VERSION")
					? ("TF_STALE_VERSION" as const)
					: msg.includes("IDEMPOTENCY")
						? ("TF_IDEMPOTENCY_CONFLICT" as const)
						: msg.includes("CROSS_PRINCIPAL")
							? ("TF_CROSS_PRINCIPAL_COMMAND" as const)
							: msg.includes("INVALID_ARGUMENT")
								? ("TF_INVALID_ARGUMENT" as const)
								: ("TF_COMMAND_FAILED" as const);
				return {
					ok: false as const,
					error: {
						code,
						message: msg,
						recoveryAction: code === "TF_STALE_VERSION" ? "refresh" as const : "none" as const,
						sideEffects: "unknown" as const,
					},
				};
			}
		},

		close() {
			// Writer may release singleton; attachers do not
			if (singleton?.role === "writer") {
				// leave lock for other attaches in process lifetime tests
			}
		},
	};

	return host;
}

// re-export types used by callers
export type { RunStatus, RunStage, BoundPlan, Receipt };
