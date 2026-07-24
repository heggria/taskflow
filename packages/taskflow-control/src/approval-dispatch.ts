/**
 * Read-only validation for the durable approve -> continuation handoff.
 *
 * The project journal, ApprovalRequest, private continuation artifact,
 * immutable BoundPlan, and coordinator reservation must all describe the
 * exact same queued Run before startup recovery is allowed to dispatch.
 */
import {
	loadApprovalForRun,
	type ApprovalRequest,
} from "./approval.ts";
import {
	approvalContinuationMatchesRun,
	decodeApprovalContinuationCheckpoint,
	type ApprovalContinuationCheckpoint,
} from "./approval-continuation.ts";
import type { UserCoordinatorStore } from "./store/coordinator.ts";
import type { ProjectControlStore } from "./store/project-store.ts";
import type {
	BoundPlan,
	CommandRecord,
	ConcurrencyReservation,
	RunProjection,
} from "./types.ts";

export interface ApprovalDispatchEvidence {
	approval: ApprovalRequest;
	boundPlan: BoundPlan;
	checkpoint: ApprovalContinuationCheckpoint;
	command: CommandRecord;
	commandId: string;
	principal: string;
	reservation: ConcurrencyReservation;
	/** End of the project-ledger transaction that accepted the approve command. */
	projectAdmitCommitSeq: number;
}

export type ApprovalDispatchInspection =
	| { ok: true; evidence: ApprovalDispatchEvidence }
	| { ok: false; reason: string };

function fail(reason: string): ApprovalDispatchInspection {
	return { ok: false, reason };
}

function findApprovalCommand(
	store: ProjectControlStore,
	run: RunProjection,
	approval: ApprovalRequest,
): {
	commandId: string;
	projectAdmitCommitSeq: number;
} | null {
	const events = store
		.readEvents(1, Math.max(0, store.nextCommitSeq() - 1))
		.filter(
			(event) =>
				event.streamId === run.runId &&
				event.commandId !== undefined,
		);
	const decisions = events.filter(
		(event) =>
			event.payload.type === "ApprovalDecided" &&
			event.payload.approvalRequestId ===
				approval.approvalRequestId &&
			event.payload.decision === "approve",
	);
	const decision = decisions.at(-1);
	const commandId =
		approval.decisionCommandId ?? decision?.commandId;
	if (!commandId) return null;
	if (
		decision?.commandId !== undefined &&
		decision.commandId !== commandId
	) {
		return null;
	}
	const queued = events.find(
		(event) =>
			event.commandId === commandId &&
			event.payload.type === "RunStatusChanged" &&
			event.payload.status === "running" &&
			event.payload.stage === "queued" &&
			event.payload.reason ===
				"approval-approved-awaiting-dispatch",
	);
	if (!decision || !queued) return null;
	return {
		commandId,
		projectAdmitCommitSeq: Math.max(
			decision.commitSeq,
			queued.commitSeq,
		),
	};
}

function exactReservationBinding(
	reservation: ConcurrencyReservation,
	store: ProjectControlStore,
	run: RunProjection,
	projectAdmitCommitSeq: number,
): boolean {
	return (
		reservation.projectId === store.header.projectId &&
		reservation.projectControlDomainId ===
			store.header.controlDomainId &&
		reservation.runId === run.runId &&
		reservation.projectAdmitCommitSeq ===
			projectAdmitCommitSeq
	);
}

export function inspectQueuedApprovalDispatch(input: {
	store: ProjectControlStore;
	coordinator: UserCoordinatorStore;
	run: RunProjection;
	now?: number;
}): ApprovalDispatchInspection {
	const { store, coordinator, run } = input;
	if (
		run.status !== "running" ||
		run.stage !== "queued" ||
		run.receiptId !== undefined ||
		!run.approvalRequestId ||
		!run.reservationId
	) {
		return fail(
			"Run is not an unsettled queued approval handoff",
		);
	}

	const approval = loadApprovalForRun(
		store.projectRoot,
		run.runId,
	);
	if (
		!approval ||
		approval.approvalRequestId !==
			run.approvalRequestId ||
		approval.runId !== run.runId ||
		approval.projectId !== store.header.projectId ||
		approval.controlDomainId !==
			store.header.controlDomainId
	) {
		return fail(
			"the exact ApprovalRequest cannot be recovered",
		);
	}
	if (
		approval.status !== "pending" &&
		approval.status !== "approved"
	) {
		return fail(
			`approval is not recoverable from status ${approval.status}`,
		);
	}
	if (
		approval.deadline !== undefined &&
		(input.now ?? Date.now()) > approval.deadline
	) {
		return fail("approval expired before dispatch recovery");
	}
	if (!approval.allowedDecisions.includes("approve")) {
		return fail("ApprovalRequest does not allow approve");
	}

	const commandIdentity = findApprovalCommand(
		store,
		run,
		approval,
	);
	if (!commandIdentity) {
		return fail(
			"approve command journal identity is unavailable",
		);
	}
	const command = store.getCommand(
		commandIdentity.commandId,
	);
	if (
		!command ||
		command.kind !== "approve" ||
		command.runId !== run.runId ||
		command.projectId !== store.header.projectId ||
		command.controlDomainId !==
			store.header.controlDomainId ||
		(command.status !== "accepted" &&
			command.status !== "completed") ||
		!command.callerPrincipal.trim()
	) {
		return fail(
			"approve CommandRecord is missing or inconsistent",
		);
	}
	if (
		command.status === "completed" &&
		!store
			.readEvents(
				command.firstCommitSeq,
				command.lastCommitSeq,
			)
			.some(
				(event) =>
					event.commandId === command.commandId &&
					event.payload.type === "Generic" &&
					event.payload.kind ===
						"ApprovalDispatchAccepted" &&
					event.payload.data
						?.approvalRequestId ===
						approval.approvalRequestId,
			)
	) {
		return fail(
			"completed approve command has no durable dispatch-accepted event",
		);
	}
	if (
		approval.status === "approved" &&
		(approval.decision !== "approve" ||
			approval.decisionCommandId !== command.commandId ||
			approval.deciderPrincipal !==
				command.callerPrincipal)
	) {
		return fail(
			"approved ApprovalRequest does not match its command",
		);
	}

	const reservation = coordinator.getReservation(
		run.reservationId,
	);
	if (
		!reservation ||
		(reservation.state !== "reserved" &&
			reservation.state !== "committed")
	) {
		return fail(
			"the exact capacity reservation is unavailable",
		);
	}
	if (
		reservation.state === "committed" &&
		!exactReservationBinding(
			reservation,
			store,
			run,
			commandIdentity.projectAdmitCommitSeq,
		)
	) {
		return fail(
			"committed reservation binding does not match the approve handoff",
		);
	}

	if (
		!approval.nodeInstanceId ||
		!approval.boundPlanHash ||
		!approval.continuationArtifactId ||
		approval.boundPlanHash !== run.boundPlanHash ||
		approval.continuationArtifactId !==
			run.approvalContinuationArtifactId
	) {
		return fail(
			"ApprovalRequest has no exact scheduler continuation identity",
		);
	}
	const artifact = store.getArtifact(
		approval.continuationArtifactId,
	);
	if (
		!artifact ||
		artifact.runId !== run.runId ||
		artifact.role !== "approval-continuation" ||
		artifact.redactionClass !== "secret" ||
		artifact.mediaType !==
			"application/vnd.taskflow.approval-continuation+json"
	) {
		return fail(
			"approval continuation artifact provenance is invalid",
		);
	}
	const bytes = store.readArtifactBytes(artifact.digest);
	if (!bytes) {
		return fail(
			"approval continuation artifact is missing or corrupt",
		);
	}

	let checkpoint: ApprovalContinuationCheckpoint;
	try {
		checkpoint =
			decodeApprovalContinuationCheckpoint(bytes);
	} catch (cause) {
		return fail(
			`approval continuation cannot be decoded: ${
				cause instanceof Error
					? cause.message
					: String(cause)
			}`,
		);
	}
	if (
		checkpoint.runId !== run.runId ||
		checkpoint.boundPlanHash !==
			approval.boundPlanHash ||
		checkpoint.approvalPhaseId !==
			approval.nodeInstanceId ||
		!approvalContinuationMatchesRun(
			checkpoint,
			run,
			{ exact: true },
		)
	) {
		return fail(
			"approval continuation checkpoint identity is invalid",
		);
	}

	const boundPlan = store.getBoundPlan(
		approval.boundPlanHash,
	);
	if (!boundPlan) {
		return fail(
			"the original immutable BoundPlan is unavailable",
		);
	}
	const phases =
		boundPlan.program &&
		typeof boundPlan.program === "object" &&
		Array.isArray(
			(boundPlan.program as { phases?: unknown })
				.phases,
		)
			? (
					boundPlan.program as {
						phases: Array<
							Record<string, unknown>
						>;
					}
				).phases
			: [];
	const approvalPhase = phases.find(
		(phase) =>
			phase.id === checkpoint.approvalPhaseId &&
			phase.type === "approval",
	);
	if (
		!approvalPhase ||
		checkpoint.attempts.some(
			(attempt) =>
				attempt.phaseId ===
				checkpoint.approvalPhaseId,
		)
	) {
		return fail(
			"continuation does not identify one unconsumed approval phase",
		);
	}

	return {
		ok: true,
		evidence: {
			approval,
			boundPlan,
			checkpoint,
			command,
			commandId: command.commandId,
			principal: command.callerPrincipal,
			reservation,
			projectAdmitCommitSeq:
				commandIdentity.projectAdmitCommitSeq,
		},
	};
}
