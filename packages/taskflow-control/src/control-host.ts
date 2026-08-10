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
	type CommandRecord,
	type ControlError,
	type ControlEvent,
	type ControlMode,
	type ForceReleaseRequest,
	type Receipt,
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
import { acquireOrAttachSingleton, type SingletonResult } from "./singleton.ts";
import { linkProgram } from "./linker.ts";
import {
	createMockExecutionProvider,
	type ExecutionProvider,
} from "./provider.ts";
import { createScriptExecutionProvider } from "./script-provider.ts";
import { boundedReconcile, applyReconcileToRun, DEFAULT_RECONCILE_BUDGET, type ReconcileBudget } from "./reconcile.ts";
import { isSafeId } from "./validate-ids.ts";
import { projectCoordinatorDir } from "./paths.ts";
import type { IdentityOpenPolicy } from "./identity.ts";
import {
	createApprovalRequest,
	decideApproval,
	expireApprovalIfDue,
	loadApprovalForRun,
} from "./approval.ts";

export interface ControlHostOptions {
	projectRoot: string;
	/** Default auto. Silent auto→standalone is forbidden. */
	controlMode?: ControlMode;
	env?: NodeJS.ProcessEnv;
	/**
	 * Inject provider. **Production default is ScriptExecutionProvider** (real OS
	 * processes). Mock is NEVER the production default — tests must inject mock
	 * explicitly via `provider` or `allowMockProvider: true` (test-only).
	 */
	provider?: ExecutionProvider;
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
	cancel(
		runId: string,
		opts?: { commandId?: string; principal?: string; expectedRunVersion?: number; reason?: string },
	): Promise<AdmitResult>;
	/** Durable approval: park (release slot) only when provider quiescent (D38). */
	parkForApproval(
		runId: string,
		opts?: { expectedRunVersion?: number },
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
		opts?: { commandId?: string; principal?: string; expectedRunVersion?: number; note?: string },
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
	registry.registerFromStore(store, opts.projectRoot);
	const coordinator =
		controlMode === "standalone"
			? openUserCoordinatorStore(env, { baseDir: projectCoordinatorDir(opts.projectRoot) })
			: openUserCoordinatorStore(env);
	// Production default: real script provider. Mock only when explicitly allowed (tests).
	const provider =
		opts.provider ??
		(opts.allowMockProvider
			? createMockExecutionProvider()
			: createScriptExecutionProvider({
					stateDir: `${opts.projectRoot}/.taskflow/control/provider-jobs`,
				}));
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
		store.commit({ command, events: [ev], run, receipt });
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
				artifactIntegrity: "ok",
				provenance: "ok",
			},
			buildInfo: { packageVersion: "0.3.0", controlSchemaVersion: 1 },
			issuedAt: Date.now(),
		};
		return receipt;
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

			// Dispatch — probe → prepare → submit (D9 full contract)
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

			if (typeof provider.probe === "function") {
				const probe = await provider.probe({ cwd: opts.projectRoot, program: boundPlan.program });
				if (!probe.ok || probe.supportsProgram === false) {
					const reason = probe.detail ?? "provider probe rejected program";
					run = {
						...run,
						status: "failed",
						stage: "terminal",
						error: reason,
						updatedAt: Date.now(),
						runVersion: run.runVersion + 1,
					};
					run = emit(run, {
						type: "RunStatusChanged",
						runId,
						status: "failed",
						stage: "terminal",
						reason,
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
					return {
						ok: false,
						run,
						error: { code: "TF_COMMAND_FAILED", message: reason, recoveryAction: "none", sideEffects: "none" },
					};
				}
			}

			if (typeof provider.prepare === "function") {
				const prep = await provider.prepare({
					runId,
					program: boundPlan.program,
					cwd: opts.projectRoot,
				});
				if (prep.kind === "rejected") {
					run = {
						...run,
						status: "failed",
						stage: "terminal",
						error: prep.reason,
						updatedAt: Date.now(),
						runVersion: run.runVersion + 1,
					};
					run = emit(run, {
						type: "RunStatusChanged",
						runId,
						status: "failed",
						stage: "terminal",
						reason: prep.reason,
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
					return {
						ok: false,
						run,
						error: {
							code: "TF_COMMAND_FAILED",
							message: prep.reason,
							recoveryAction: "none",
							sideEffects: "none",
						},
					};
				}
			}

			const submit = await provider.submit({
				runId,
				idempotencyKey: `${runId}:attempt-1`,
				program: boundPlan.program,
				cwd: opts.projectRoot,
			});

			if (submit.kind === "rejected") {
				run = {
					...run,
					status: "failed",
					stage: "terminal",
					error: submit.reason,
					updatedAt: Date.now(),
					runVersion: run.runVersion + 1,
				};
				run = emit(run, {
					type: "RunStatusChanged",
					runId,
					status: "failed",
					stage: "terminal",
					reason: submit.reason,
				});
				try {
					coordinator.normalRelease(reservation.reservationId, {
						noLiveOrAmbiguousSideEffects: true,
						runIsTerminal: true,
						runIsParkedAndFutureDispatchRequiresReadmission: false,
					});
				} catch {
					/* keep slot if predicate fails */
				}
				return { ok: false, run, error: { code: "TF_COMMAND_FAILED", message: submit.reason, recoveryAction: "none", sideEffects: "possible" } };
			}

			if (submit.kind === "ambiguous" || submit.kind === "accepted") {
				const handle = submit.kind === "accepted" ? submit.handle : submit.handle;
				if (handle) {
					handles.set(runId, handle);
					// Persist handle + lease on run for restart reconcile (D9)
					run = {
						...run,
						providerHandle: handle,
						providerLeaseEpoch:
							submit.kind === "accepted" ? submit.leaseEpoch : undefined,
						providerName: provider.name,
						updatedAt: Date.now(),
						runVersion: run.runVersion + 1,
					};
					run = emit(run, {
						type: "Generic",
						kind: "ProviderHandleBound",
						data: {
							handle,
							leaseEpoch: submit.kind === "accepted" ? submit.leaseEpoch : undefined,
							providerName: provider.name,
						},
					});
				}

				if (submit.kind === "ambiguous" || (handle && provider.isLive?.(handle))) {
					// Enter reconciling
					run = {
						...run,
						status: "unknown",
						stage: "reconciling",
						updatedAt: Date.now(),
						runVersion: run.runVersion + 1,
					};
					run = emit(run, { type: "ReconcileStarted", runId, attempt: 1 });

					const outcome = await boundedReconcile(provider, handle!, reconcileBudget);
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
						// Release + receipt only on true terminal
						if (isTerminalRunStatus(run.status) && canNormalRelease({
							noLiveOrAmbiguousSideEffects: true,
							runIsTerminal: true,
							runIsParkedAndFutureDispatchRequiresReadmission: false,
						})) {
							coordinator.normalRelease(reservation.reservationId, {
								noLiveOrAmbiguousSideEffects: true,
								runIsTerminal: true,
								runIsParkedAndFutureDispatchRequiresReadmission: false,
							});
						}
						if (outcome.terminal === "completed" || run.status === "completed") {
							const receipt = issueReceipt(run, boundPlan);
							run = { ...run, receiptId: receipt.receiptId, status: "completed", stage: "terminal" };
							run = emit(run, { type: "ReceiptIssued", runId, receiptId: receipt.receiptId }, undefined, receipt);
							return { ok: true, run, receipt, snapshot: { run, receipt } };
						}
						return { ok: false, run, snapshot: { run, receipt: null } };
					}
				}

				// Happy path: poll until terminal (real script providers are async).
				if (handle) {
					const pollDeadline = Date.now() + (reconcileBudget.deadlineMs ?? 30_000);
					let collected = await provider.poll(handle);
					while (collected.kind === "still-running" && Date.now() < pollDeadline) {
						await new Promise((r) => setTimeout(r, 10));
						collected = await provider.poll(handle);
					}
					if (collected.kind === "completed") {
						run = {
							...run,
							status: "completed",
							stage: "terminal",
							finalOutput: collected.output,
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
						const receipt = issueReceipt(run, boundPlan);
						// Fail-closed assurance: only claim ok when we have real provider completed outcome
						const receiptHonest: typeof receipt = {
							...receipt,
							assurance: {
								...receipt.assurance,
								providerOutcome: "ok",
								journalContinuity: "ok",
								artifactIntegrity: "unknown",
								provenance: "ok",
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
					}
					if (collected.kind === "failed") {
						run = {
							...run,
							status: "failed",
							stage: "terminal",
							error: collected.error,
							updatedAt: Date.now(),
							runVersion: run.runVersion + 1,
						};
						run = emit(run, {
							type: "RunStatusChanged",
							runId,
							status: "failed",
							stage: "terminal",
						});
						coordinator.normalRelease(reservation.reservationId, {
							noLiveOrAmbiguousSideEffects: true,
							runIsTerminal: true,
							runIsParkedAndFutureDispatchRequiresReadmission: false,
						});
						// No final Receipt on failed terminal without explicit success evidence (fail-closed)
						return { ok: false, run, snapshot: { run, receipt: null } };
					}
					if (collected.kind === "cancelled") {
						run = {
							...run,
							status: "cancelled",
							stage: "terminal",
							updatedAt: Date.now(),
							runVersion: run.runVersion + 1,
						};
						run = emit(run, {
							type: "RunStatusChanged",
							runId,
							status: "cancelled",
							stage: "terminal",
						});
						coordinator.normalRelease(reservation.reservationId, {
							noLiveOrAmbiguousSideEffects: true,
							runIsTerminal: true,
							runIsParkedAndFutureDispatchRequiresReadmission: false,
						});
						return { ok: false, run, snapshot: { run, receipt: null } };
					}
					if (collected.kind === "still-running") {
						const outcome = await boundedReconcile(provider, handle, reconcileBudget);
						run = applyReconcileToRun(run, outcome);
						if (outcome.exhausted) {
							coordinator.markOrphanSuspect(reservation.reservationId);
							run = emit(run, { type: "NeedsOperator", runId, code: "TF_RECONCILE_REQUIRED" });
							const err = reconcileRequiredError("provider still running after budget", {
								commandId,
								projectId: store.header.projectId,
								controlDomainId: store.header.controlDomainId,
							});
							return { ok: false, run, error: err, snapshot: { run, controlError: err, receipt: null } };
						}
						if (outcome.terminal === "completed") {
							coordinator.normalRelease(reservation.reservationId, {
								noLiveOrAmbiguousSideEffects: true,
								runIsTerminal: true,
								runIsParkedAndFutureDispatchRequiresReadmission: false,
							});
							const receipt = issueReceipt(run, boundPlan);
							run = { ...run, receiptId: receipt.receiptId };
							run = emit(run, { type: "ReceiptIssued", runId, receiptId: receipt.receiptId }, undefined, receipt);
							return { ok: true, run, receipt, snapshot: { run, receipt } };
						}
					}
				}
			}

			return { ok: false, run, error: { code: "TF_COMMAND_FAILED", message: "unhandled provider path", recoveryAction: "operator", sideEffects: "unknown" } };
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
			// Quiescence check before lock (provider is process-local).
			const pre = store.getRun(runId);
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

			const pendingApr = loadApprovalForRun(store.projectRoot, runId);
			if (pendingApr) {
				const decided = decideApproval(store.projectRoot, pendingApr.approvalRequestId, {
					decision: "approve",
					principal,
					commandId,
				});
				if (!decided.ok) {
					const error = reconcileRequiredError(
						`coordinator committed but ApprovalRequest decision failed: ${decided.message}`,
						{ commandId, projectId: store.header.projectId, controlDomainId: store.header.controlDomainId },
					);
					return { ok: false, run: cas.run, error, snapshot: { run: cas.run, controlError: error, receipt: null } };
				}
			}

			// No dispatcher exists yet that can reconstruct the original BoundPlan.
			// Keep the command accepted and surface recovery instead of manufacturing
			// completed execution or a Receipt from an approval decision.
			const pendingDispatch = store.compareAndCommit({
				runId,
				expectedRunVersion: cas.run.runVersion,
				build: (run) => ({
					run: {
						...run,
						status: "unknown",
						stage: "reconciling",
						needsOperator: true,
						error: "approved run cannot dispatch until BoundPlan dispatcher is wired",
						updatedAt: Date.now(),
						runVersion: run.runVersion + 1,
					},
					events: [
						makeEvent(runId, { type: "NeedsOperator", runId, code: "TF_RECONCILE_REQUIRED" }, commandId),
					],
				}),
			});
			const run = pendingDispatch.ok ? pendingDispatch.run : pendingDispatch.run ?? cas.run;
			const error = reconcileRequiredError(
				"approval is durable and capacity-bound, but dispatcher handoff is not implemented",
				{ commandId, projectId: store.header.projectId, controlDomainId: store.header.controlDomainId },
			);
			return { ok: false, run, error, snapshot: { run, controlError: error, receipt: null } };
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
			if (!canMutate) return attachDenied("reject");
			const pendingApr = loadApprovalForRun(store.projectRoot, runId);
			if (pendingApr) {
				const decided = decideApproval(store.projectRoot, pendingApr.approvalRequestId, {
					decision: "reject",
					principal: opts.principal ?? "local",
					commandId: opts.commandId ?? newId("cmd"),
					note: opts.note,
				});
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
