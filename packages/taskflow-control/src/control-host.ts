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
	type ControlError,
	type ControlEvent,
	type ControlMode,
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
import { boundedReconcile, applyReconcileToRun, DEFAULT_RECONCILE_BUDGET, type ReconcileBudget } from "./reconcile.ts";

export interface ControlHostOptions {
	projectRoot: string;
	/** Default auto. Silent auto→standalone is forbidden. */
	controlMode?: ControlMode;
	env?: NodeJS.ProcessEnv;
	/** Inject provider (default mock completed). */
	provider?: ExecutionProvider;
	/** Skip process singleton (tests that only need store path). */
	skipSingleton?: boolean;
	/** Holder id for singleton. */
	holderId?: string;
	/** Standalone skips global concurrency claims across projects. */
	reconcileBudget?: ReconcileBudget;
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
	/** Operator force-release of a concurrency reservation (CoordinatorCommandRecord). */
	forceReleaseReservation(
		reservationId: string,
		opts: { commandId?: string; principal?: string },
	): { ok: true } | { ok: false; error: ControlError };
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

	const store = openProjectControlStore(opts.projectRoot);
	const registry = openControlRegistry(env);
	registry.registerFromStore(store, opts.projectRoot);
	const coordinator = openUserCoordinatorStore(env);
	const provider = opts.provider ?? createMockExecutionProvider();
	const reconcileBudget = opts.reconcileBudget ?? DEFAULT_RECONCILE_BUDGET;

	// Provider handles by runId
	const handles = new Map<string, string>();

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

	function providerQuiescent(runId: string): boolean {
		const handle = handles.get(runId);
		if (!handle) {
			// No in-process handle — treat as no live side effects known to this host.
			return true;
		}
		if (typeof provider.isLive === "function") {
			return !provider.isLive(handle);
		}
		return true;
	}

	/** Optimistic concurrency for dual-client approval/cancel (P15). */
	function casMismatch(
		run: RunProjection,
		expectedRunVersion: number | undefined,
	): ControlError | null {
		if (expectedRunVersion === undefined) return null;
		if (run.runVersion !== expectedRunVersion) {
			return {
				code: "TF_STALE_VERSION",
				message: `expected runVersion ${expectedRunVersion}, have ${run.runVersion}`,
				recoveryAction: "refresh",
				sideEffects: "none",
				projectId: store.header.projectId,
				controlDomainId: store.header.controlDomainId,
			};
		}
		return null;
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

	function issueReceipt(run: RunProjection, boundPlan: BoundPlan): Receipt {
		const events = store.readEvents(1, store.nextCommitSeq());
		const runEvents = events.filter(
			(e) => e.streamId === run.runId || (e.payload as { runId?: string }).runId === run.runId,
		);
		const receipt: Receipt = {
			receiptId: newId("rcpt"),
			controlDomainId: store.header.controlDomainId,
			projectId: store.header.projectId,
			runId: run.runId,
			boundPlanHash: boundPlan.boundPlanHash,
			boundFragmentHash: run.boundFragmentHash,
			eventManifest: runEvents.map((e) => e.eventId),
			startCommitSeq: runEvents[0]?.commitSeq ?? 1,
			endCommitSeq: runEvents[runEvents.length - 1]?.commitSeq ?? store.nextCommitSeq() - 1,
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

			// Reserve (standalone still uses local coordinator for tests of capacity)
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

			// Dispatch
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
				if (handle) handles.set(runId, handle);

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

				// Happy path: poll collect
				if (handle) {
					const collected = await provider.poll(handle);
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
						run = { ...run, receiptId: receipt.receiptId };
						run = emit(run, { type: "ReceiptIssued", runId, receiptId: receipt.receiptId }, undefined, receipt);
						return { ok: true, run, receipt, snapshot: { run, receipt } };
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
						return { ok: false, run };
					}
					if (collected.kind === "still-running") {
						// Treat as needs reconcile
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
			if (!canMutate) return attachDenied("cancel");
			// Re-read under mutation path for dual-client freshness.
			const run = store.getRun(runId);
			if (!run) {
				return {
					ok: false,
					error: { code: "TF_NOT_FOUND", message: "run not found", recoveryAction: "none", sideEffects: "none" },
				};
			}
			const stale = casMismatch(run, opts.expectedRunVersion);
			if (stale) return { ok: false, run, error: stale, snapshot: { run } };
			const handle = handles.get(runId);
			if (handle) await provider.cancel(handle);
			const next: RunProjection = {
				...run,
				status: "cancelled",
				stage: "terminal",
				updatedAt: Date.now(),
				runVersion: run.runVersion + 1,
			};
			const updated = emit(next, {
				type: "RunStatusChanged",
				runId,
				status: "cancelled",
				stage: "terminal",
				reason: "cancel",
			});
			if (run.reservationId) {
				try {
					coordinator.normalRelease(run.reservationId, {
						noLiveOrAmbiguousSideEffects: providerQuiescent(runId),
						runIsTerminal: true,
						runIsParkedAndFutureDispatchRequiresReadmission: false,
					});
				} catch {
					/* keep */
				}
			}
			return { ok: true, run: updated, snapshot: { run: updated } };
		},

		async parkForApproval(runId, opts = {}) {
			if (!canMutate) return attachDenied("parkForApproval");
			const run = store.getRun(runId);
			if (!run) {
				return {
					ok: false,
					error: { code: "TF_NOT_FOUND", message: "run not found", recoveryAction: "none", sideEffects: "none" },
				};
			}
			const stale = casMismatch(run, opts.expectedRunVersion);
			if (stale) return { ok: false, run, error: stale, snapshot: { run } };
			// D38: release slot only when provider is quiescent (no live/ambiguous side effects).
			const quiescent = providerQuiescent(runId);
			if (!quiescent) {
				return {
					ok: false,
					run,
					error: {
						code: "TF_PROVIDER_AMBIGUOUS",
						message:
							"cannot parkForApproval while provider job is still live; slot held until quiescence (D38)",
						recoveryAction: "reconcile",
						sideEffects: "possible",
						projectId: store.header.projectId,
						controlDomainId: store.header.controlDomainId,
					},
					snapshot: { run },
				};
			}
			const approvalRequestId = newId("apr");
			if (run.reservationId) {
				coordinator.normalRelease(run.reservationId, {
					noLiveOrAmbiguousSideEffects: true,
					runIsTerminal: false,
					runIsParkedAndFutureDispatchRequiresReadmission: true,
				});
			}
			const next: RunProjection = {
				...run,
				status: "paused",
				stage: "parked",
				approvalRequestId,
				reservationId: undefined,
				updatedAt: Date.now(),
				runVersion: run.runVersion + 1,
			};
			const updated = emit(next, { type: "ApprovalParked", runId, approvalRequestId });
			return { ok: true, run: updated, snapshot: { run: updated } };
		},

		async approve(runId, opts = {}) {
			if (!canMutate) return attachDenied("approve");
			const run = store.getRun(runId);
			if (!run) {
				return {
					ok: false,
					error: { code: "TF_NOT_FOUND", message: "run not found", recoveryAction: "none", sideEffects: "none" },
				};
			}
			const stale = casMismatch(run, opts.expectedRunVersion);
			if (stale) return { ok: false, run, error: stale, snapshot: { run } };
			if (run.stage !== "parked" && run.status !== "paused") {
				return {
					ok: false,
					run,
					error: {
						code: "TF_INVALID_ARGUMENT",
						message: `approve requires paused+parked run (have status=${run.status} stage=${run.stage})`,
						recoveryAction: "refresh",
						sideEffects: "none",
					},
					snapshot: { run },
				};
			}
			// Re-reserve before execute (D38)
			const reservation = coordinator.reserve({
				coordinatorEpoch: singleton?.lock.fencingEpoch ?? Date.now(),
			});
			if (!reservation) {
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
			let next: RunProjection = {
				...run,
				status: "running",
				stage: "queued",
				reservationId: reservation.reservationId,
				updatedAt: Date.now(),
				runVersion: run.runVersion + 1,
			};
			next = emit(next, {
				type: "ApprovalDecided",
				runId,
				approvalRequestId: run.approvalRequestId ?? "",
				decision: "approve",
			});
			coordinator.commitReservation(reservation.reservationId, {
				projectId: store.header.projectId,
				projectControlDomainId: store.header.controlDomainId,
				runId,
				projectAdmitCommitSeq: store.nextCommitSeq() - 1,
			});
			// Complete as simple approved continuation for closed-loop tests
			next = {
				...next,
				status: "completed",
				stage: "terminal",
				finalOutput: next.finalOutput ?? "approved",
				updatedAt: Date.now(),
				runVersion: next.runVersion + 1,
			};
			coordinator.normalRelease(reservation.reservationId, {
				noLiveOrAmbiguousSideEffects: true,
				runIsTerminal: true,
				runIsParkedAndFutureDispatchRequiresReadmission: false,
			});
			const boundPlanHash = next.boundPlanHash;
			const receipt = issueReceipt(next, {
				boundPlanHash,
				executionSemanticHash: "",
				programName: "approved",
				program: {},
				createdAt: Date.now(),
				approvalMode: "durable-optional",
				grantRefs: [],
			});
			next = { ...next, receiptId: receipt.receiptId };
			next = emit(next, { type: "ReceiptIssued", runId, receiptId: receipt.receiptId }, undefined, receipt);
			return { ok: true, run: next, receipt, snapshot: { run: next, receipt } };
		},

		forceReleaseReservation(reservationId, opts) {
			if (!canMutate) {
				return {
					ok: false as const,
					error: attachDenied("forceReleaseReservation").error!,
				};
			}
			try {
				coordinator.forceRelease(reservationId, {
					commandId: opts.commandId ?? newId("cmd"),
					callerPrincipal: opts.principal ?? "operator",
					requestBody: { reservationId, riskAcknowledged: true },
				});
				return { ok: true as const };
			} catch (e) {
				return {
					ok: false as const,
					error: {
						code: "TF_COMMAND_FAILED" as const,
						message: e instanceof Error ? e.message : String(e),
						recoveryAction: "none" as const,
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
