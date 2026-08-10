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
	/** Operator force-release of a concurrency reservation (CoordinatorCommandRecord). */
	forceReleaseReservation(
		request: ForceReleaseRequest,
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
			// Missing process-local knowledge is not proof. Only already durable
			// terminal/parked states carry their own prior quiescence proof.
			const run = store.getRun(runId);
			return Boolean(
				run &&
					(isTerminalRunStatus(run.status) ||
						(run.status === "paused" && run.stage === "parked")),
			);
		}
		if (typeof provider.isLive === "function") {
			return !provider.isLive(handle);
		}
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
		if (run.needsOperator || run.status === "unknown") {
			const error = reconcileRequiredError("command outcome requires operator reconcile", {
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
			ok: true,
			run,
			receipt: receipt ?? undefined,
			snapshot: { run, receipt },
		};
	}

	function newProjectCommand(opts: {
		commandId: string;
		requestHash: string;
		principal: string;
		kind: string;
		runId: string;
		status: CommandRecord["status"];
		firstCommitSeq?: number;
	}): CommandRecord {
		return {
			commandId: opts.commandId,
			requestHash: opts.requestHash,
			callerPrincipal: opts.principal,
			authorizationContextHash: hashRequest({ principal: opts.principal }),
			projectId: store.header.projectId,
			controlDomainId: store.header.controlDomainId,
			kind: opts.kind,
			status: opts.status,
			firstCommitSeq: opts.firstCommitSeq ?? 0,
			lastCommitSeq: 0,
			runId: opts.runId,
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
			const commandId = opts.commandId ?? newId("cmd");
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

			// First durably win the cancel/approval race. Never touch the provider
			// before the caller's expected version has won first-commit-wins CAS.
			let hadDurableQuiescence = false;
			const requested = store.compareAndCommit({
				runId,
				expectedRunVersion: opts.expectedRunVersion,
				validate: (run) =>
					isTerminalRunStatus(run.status)
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

			const handle = handles.get(runId);
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
				(handle !== undefined &&
					cancellation?.kind === "cancelled" &&
					providerQuiescent(runId));
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
							makeEvent(
								runId,
								{
									type: "RunStatusChanged",
									runId,
									status: "cancelled",
									stage: "terminal",
									reason: "cancel-settled",
								},
								commandId,
							),
						],
					}),
				});
				if (!settled.ok) {
					return {
						ok: false,
						run: settled.run,
						error: {
							code: settled.code,
							message: `provider cancel settled but authoritative Run changed: ${settled.message}`,
							recoveryAction: "reconcile",
							sideEffects: "possible",
							commandId,
							projectId: store.header.projectId,
							controlDomainId: store.header.controlDomainId,
						},
						snapshot: settled.run ? { run: settled.run } : undefined,
					};
				}
				if (settled.run.reservationId) {
					try {
						coordinator.normalRelease(settled.run.reservationId, {
							noLiveOrAmbiguousSideEffects: true,
							runIsTerminal: true,
							runIsParkedAndFutureDispatchRequiresReadmission: false,
						});
					} catch {
						/* retain capacity if release proof/record changed */
					}
				}
				return { ok: true, run: settled.run, snapshot: { run: settled.run } };
			}

			// Missing handle, ambiguous provider response, or unverifiable liveness:
			// never mint a terminal state and never release capacity.
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
						makeEvent(
							runId,
							{ type: "NeedsOperator", runId, code: "TF_RECONCILE_REQUIRED" },
							commandId,
						),
					],
				}),
			});
			if (!uncertain.ok) {
				return {
					ok: false,
					run: uncertain.run,
					error: {
						code: uncertain.code,
						message: `cancel requested but reconciliation state changed: ${uncertain.message}`,
						recoveryAction: "reconcile",
						sideEffects: "unknown",
						commandId,
						projectId: store.header.projectId,
						controlDomainId: store.header.controlDomainId,
					},
					snapshot: uncertain.run ? { run: uncertain.run } : undefined,
				};
			}
			if (uncertain.run.reservationId) {
				try {
					coordinator.markOrphanSuspect(uncertain.run.reservationId);
				} catch {
					/* already released/changed: keep Run unknown for operator review */
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
					const approvalRequestId = newId("apr");
					const next: RunProjection = {
						...run,
						status: "paused",
						stage: "parked",
						needsOperator: false,
						approvalRequestId,
						reservationId: undefined,
						updatedAt: Date.now(),
						runVersion: run.runVersion + 1,
					};
					return {
						run: next,
						events: [makeEvent(runId, { type: "ApprovalParked", runId, approvalRequestId })],
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
				} catch {
					/* keep */
				}
			}
			return { ok: true, run: cas.run, snapshot: { run: cas.run } };
		},

		async approve(runId, opts = {}) {
			const commandId = opts.commandId ?? newId("cmd");
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

			// Re-reserve before execute (D38). If CAS loses, free the reserved slot.
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

			// Single exclusive compareAndCommit: re-read + CAS + paused+parked → queued.
			// Two clients with the same expectedRunVersion → exactly one ok:true.
			const cas = store.compareAndCommit({
				runId,
				expectedRunVersion: opts.expectedRunVersion,
				validate: (run) => {
					// D38: require BOTH paused status AND parked stage (not OR).
					if (run.status !== "paused" || run.stage !== "parked") {
						return `approve requires paused+parked run (have status=${run.status} stage=${run.stage})`;
					}
					if (
						opts.approvalRequestId !== undefined &&
						run.approvalRequestId !== opts.approvalRequestId
					) {
						return `approval request changed (expected ${opts.approvalRequestId}, have ${run.approvalRequestId ?? "none"})`;
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
						status: "completed",
					});
					const afterDecide: RunProjection = {
						...run,
						status: "running",
						stage: "queued",
						needsOperator: false,
						reservationId: reservation.reservationId,
						updatedAt: now,
						// Approval is a re-admission decision, never provider completion.
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

			// Winner: bind the re-reservation. It remains capacity-occupying while
			// queued and until later provider truth reaches a D37 release predicate.
			try {
				coordinator.commitReservation(reservation.reservationId, {
					projectId: store.header.projectId,
					projectControlDomainId: store.header.controlDomainId,
					runId,
					projectAdmitCommitSeq: cas.commitSeqEnd,
				});
			} catch {
				/* reservation may already be committed */
			}
			return {
				ok: true,
				run: cas.run,
				snapshot: { run: cas.run, receipt: null },
			};
		},

		forceReleaseReservation(request, opts) {
			if (!canMutate) {
				return {
					ok: false as const,
					error: attachDenied("forceReleaseReservation").error!,
				};
			}
			try {
				coordinator.forceRelease(request, {
					commandId: opts.commandId ?? newId("cmd"),
					callerPrincipal: opts.principal ?? "operator",
					requestBody: request,
				});
				return { ok: true as const };
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				const code = message.startsWith("TF_STALE_VERSION")
					? "TF_STALE_VERSION"
					: message.startsWith("TF_IDEMPOTENCY_CONFLICT")
						? "TF_IDEMPOTENCY_CONFLICT"
						: message.startsWith("TF_CROSS_PRINCIPAL_COMMAND")
							? "TF_CROSS_PRINCIPAL_COMMAND"
							: "TF_COMMAND_FAILED";
				return {
					ok: false as const,
					error: {
						code,
						message,
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
