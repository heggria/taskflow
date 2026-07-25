/**
 * P17 durable browser command adapter.
 *
 * This module owns no command state. It delegates mutations and idempotency to
 * ControlHost/ControlStore/UserCoordinatorStore, then projects the resulting
 * durable record into the browser protocol.
 */
import type {
	CommandRecord,
	ControlError,
	CoordinatorCommandRecord,
} from "./types.ts";
import type {
	AdmitResult,
	ControlHost,
} from "./control-host.ts";
import { hashRequest } from "./hash.ts";
import type {
	CoordinatorCommandRouteAuthority,
	CoordinatorCommandRouteClaim,
} from "./store/coordinator.ts";
import {
	WEB_COMMAND_KINDS,
	type WebCommandKind,
} from "./web-presentation-schema.ts";
import type {
	WebCommandOutcome,
	WebCommandRequest,
	WebEndpointId,
	WebHandlerContext,
	WebHandlerMap,
} from "./web-protocol.ts";
import { WebReadServiceError } from "./web-read-service.ts";

export const WEB_IMPLEMENTED_COMMAND_KINDS = [
	"approve",
	"reject",
	"cancel-run",
	"set-max-active-runs",
	"force-release",
] as const satisfies readonly WebCommandKind[];

/**
 * Commands enabled by the packaged beta.2 gateway without an explicit
 * capability decision. Approval and cancellation have packaged browser
 * interaction evidence; coordinator recovery controls remain Pro capability
 * decisions.
 */
export const WEB_DEFAULT_ENABLED_COMMAND_KINDS = [
	"approve",
	"reject",
	"cancel-run",
] as const satisfies readonly WebCommandKind[];

/**
 * Commands a production beta.2 gateway may advertise.
 *
 * Approve/reject both follow the durable ApprovalRequest CAS path. Approve
 * resumes the exact immutable BoundPlan from a private continuation checkpoint
 * and never replays settled Attempts; reject terminalizes without dispatch.
 */
export const WEB_PRODUCTION_ENABLEABLE_COMMAND_KINDS = [
	"approve",
	"reject",
	"cancel-run",
	"set-max-active-runs",
	"force-release",
] as const satisfies readonly WebCommandKind[];

export function assertProductionWebCommandCapabilities(
	commands: readonly WebCommandKind[],
): void {
	const enableable = new Set<WebCommandKind>(
		WEB_PRODUCTION_ENABLEABLE_COMMAND_KINDS,
	);
	const unsupported = commands.filter(
		(command) => !enableable.has(command),
	);
	if (unsupported.length > 0) {
		throw new Error(
			`Web command capability is not production-conforming: ${[
				...new Set(unsupported),
			]
				.sort((left, right) =>
					left.localeCompare(right, "en"),
				)
				.join(", ")}`,
		);
	}
}

export const WEB_IMPLEMENTED_COMMAND_HANDLER_IDS = [
	"commands",
	"command",
] as const satisfies readonly WebEndpointId[];

export type WebCommandHandlerMap = Pick<
	WebHandlerMap,
	"commands" | "command"
>;

export type WebCommandServiceOptions = {
	readonly supportedCommands?: readonly WebCommandKind[];
	/**
	 * Resolve the exact home authority for project-scoped commands. The
	 * listener never falls back to another mounted project.
	 */
	readonly resolveHost?: (
		projectId: string,
		controlDomainId: string,
	) => ControlHost | null;
	/** Enumerate mounted project authorities for command-id collision/query. */
	readonly listHosts?: () => readonly ControlHost[];
};

function protocolError(
	code: ControlError["code"],
	message: string,
	options: Partial<
		Pick<
			ControlError,
			| "recoveryAction"
			| "sideEffects"
			| "commandId"
			| "projectId"
			| "controlDomainId"
		>
	> = {},
): ControlError {
	return {
		code,
		message,
		recoveryAction: options.recoveryAction ?? "none",
		sideEffects: options.sideEffects ?? "none",
		...(options.commandId
			? { commandId: options.commandId }
			: {}),
		...(options.projectId
			? { projectId: options.projectId }
			: {}),
		...(options.controlDomainId
			? { controlDomainId: options.controlDomainId }
			: {}),
	};
}

function throwControl(error: ControlError): never {
	throw new WebReadServiceError(error);
}

function commandStatusError(
	record: CommandRecord | CoordinatorCommandRecord,
): ControlError {
	return protocolError(
		"TF_COMMAND_FAILED",
		record.status === "rejected"
			? "The durable command was rejected."
			: "The durable command failed.",
		{
			recoveryAction:
				record.status === "failed" ? "operator" : "refresh",
			sideEffects:
				record.status === "failed" ? "unknown" : "none",
			commandId: record.commandId,
			...("projectId" in record
				? {
						projectId: record.projectId,
						controlDomainId:
							record.controlDomainId,
					}
				: {}),
		},
	);
}

function browserCommandKind(
	record: CommandRecord | CoordinatorCommandRecord,
): string {
	if ("payload" in record) {
		return record.kind === "setMaxActiveRuns"
			? "set-max-active-runs"
			: "force-release";
	}
	return record.kind;
}

function projectOutcome(
	record: CommandRecord,
	observedAt: number,
): WebCommandOutcome {
	const identity = {
		commandId: record.commandId,
		requestHash: record.requestHash,
		kind: browserCommandKind(record),
		projectId: record.projectId,
		controlDomainId: record.controlDomainId,
		...(record.runId ? { runId: record.runId } : {}),
		firstCommitSeq: record.firstCommitSeq,
		lastCommitSeq: record.lastCommitSeq,
		observedAt,
	};
	switch (record.status) {
		case "accepted":
			return { ...identity, status: "pending" };
		case "completed":
			return { ...identity, status: "completed" };
		case "failed":
			return {
				...identity,
				status: "failed",
				error: commandStatusError(record),
			} as unknown as WebCommandOutcome;
		case "rejected":
			return {
				...identity,
				status: "rejected",
				error: commandStatusError(record),
			} as unknown as WebCommandOutcome;
	}
}

function coordinatorOutcome(
	record: CoordinatorCommandRecord,
	observedAt: number,
): WebCommandOutcome {
	const identity = {
		commandId: record.commandId,
		requestHash: record.requestHash,
		kind: browserCommandKind(record),
		firstCommitSeq: record.firstCommitSeq,
		lastCommitSeq: record.lastCommitSeq,
		observedAt,
	};
	switch (record.status) {
		case "accepted":
			return { ...identity, status: "pending" };
		case "completed":
			return { ...identity, status: "completed" };
		case "failed":
			return {
				...identity,
				status: "failed",
				error: commandStatusError(record),
			} as unknown as WebCommandOutcome;
		case "rejected":
			return {
				...identity,
				status: "rejected",
				error: commandStatusError(record),
			} as unknown as WebCommandOutcome;
	}
}

function resultError(result: AdmitResult): ControlError {
	return (
		result.error ??
		protocolError(
			"TF_COMMAND_FAILED",
			"Command processing failed without a durable outcome.",
			{
				recoveryAction: "operator",
				sideEffects: "unknown",
			},
		)
	);
}

function throwIdentityConflict(result: AdmitResult): void {
	if (
		result.error?.code === "TF_IDEMPOTENCY_CONFLICT" ||
		result.error?.code === "TF_CROSS_PRINCIPAL_COMMAND"
	) {
		throwControl(result.error);
	}
}

function coordinatorFailure(
	cause: unknown,
	commandId: string,
): ControlError {
	const message =
		cause instanceof Error ? cause.message : String(cause);
	const code: ControlError["code"] = message.includes(
		"TF_STALE_VERSION",
	)
		? "TF_STALE_VERSION"
		: message.includes("TF_IDEMPOTENCY_CONFLICT")
			? "TF_IDEMPOTENCY_CONFLICT"
			: message.includes("TF_CROSS_PRINCIPAL_COMMAND")
				? "TF_CROSS_PRINCIPAL_COMMAND"
				: message.includes("TF_CAPACITY_EXCEEDED")
					? "TF_CAPACITY_EXCEEDED"
					: message.includes("TF_INVALID_ARGUMENT")
						? "TF_INVALID_ARGUMENT"
						: "TF_COMMAND_FAILED";
	return protocolError(code, message.slice(0, 8_192), {
		recoveryAction:
			code === "TF_STALE_VERSION" ? "refresh" : "none",
		sideEffects:
			code === "TF_COMMAND_FAILED" ? "unknown" : "none",
		commandId,
	});
}

function resolveHomeProject(
	host: ControlHost,
	request: Extract<
		WebCommandRequest,
		{ projectId: string }
	>,
	options: WebCommandServiceOptions,
): ControlHost {
	const resolved =
		options.resolveHost?.(
			request.projectId,
			request.controlDomainId,
		) ??
		(request.projectId === host.projectId &&
		request.controlDomainId === host.controlDomainId
			? host
			: null);
	if (
		!resolved ||
		resolved.projectId !== request.projectId ||
		resolved.controlDomainId !== request.controlDomainId
	) {
		throwControl(
			protocolError(
				"TF_AUTHORITY_REVOKED",
				"This listener is not the mutation authority for the requested project.",
				{
					recoveryAction: "refresh",
					sideEffects: "none",
					commandId: request.commandId,
					projectId: request.projectId,
					controlDomainId:
						request.controlDomainId,
				},
			),
		);
	}
	return resolved;
}

function sameCommandAuthority(
	left: CoordinatorCommandRouteAuthority,
	right: CoordinatorCommandRouteAuthority,
): boolean {
	return (
		left.kind === right.kind &&
		(left.kind === "coordinator" ||
			(right.kind === "project" &&
				left.projectId === right.projectId &&
				left.controlDomainId === right.controlDomainId))
	);
}

function commandAuthorityConflict(
	commandId: string,
	code:
		| "TF_IDEMPOTENCY_CONFLICT"
		| "TF_CROSS_PRINCIPAL_COMMAND",
): never {
	throwControl(
		protocolError(
			code,
			code === "TF_CROSS_PRINCIPAL_COMMAND"
				? "The command belongs to another principal."
				: "The command id is already bound to another request or authority.",
			{
				recoveryAction:
					code === "TF_IDEMPOTENCY_CONFLICT"
						? "retry-new-command"
						: "none",
				sideEffects: "none",
				commandId,
			},
		),
	);
}

function legacyAuthorityRequestHash(
	request: WebCommandRequest,
): string | null {
	switch (request.kind) {
		case "approve":
			return hashRequest({
				kind: request.kind,
				runId: request.runId,
				expectedRunVersion: request.expectedRunVersion,
				approvalRequestId: request.approvalRequestId,
			});
		case "reject":
			return hashRequest({
				kind: request.kind,
				runId: request.runId,
				expectedRunVersion: request.expectedRunVersion,
				approvalRequestId: request.approvalRequestId,
				reason: request.reason,
			});
		case "cancel-run":
			return hashRequest({
				kind: request.kind,
				runId: request.runId,
				expectedRunVersion: request.expectedRunVersion,
				reason: request.reason,
			});
		case "set-max-active-runs":
			return hashRequest({
				value: request.value,
				expectedMaxActiveRuns: request.expectedMaxActiveRuns,
				expectedCoordinatorEpoch:
					request.expectedCoordinatorEpoch,
			});
		case "force-release":
			return hashRequest({
				reservationId: request.reservationId,
				expectedState: request.expectedState,
				expectedRevision: request.expectedRevision,
				expectedCoordinatorEpoch:
					request.expectedCoordinatorEpoch,
				expectedProjectId: request.expectedProjectId,
				expectedControlDomainId:
					request.expectedControlDomainId,
				expectedRunId: request.expectedRunId,
				acknowledgement: request.acknowledgement,
			});
		case "edit-approval":
		case "resume-run":
		case "recompute-run":
		case "reconcile-run":
			return null;
	}
}

function claimCommandRoute(
	host: ControlHost,
	request: WebCommandRequest,
	principalId: string,
	authority: CoordinatorCommandRouteAuthority,
	listHosts: () => readonly ControlHost[],
): CoordinatorCommandRouteClaim {
	const projectRecords = listHosts().flatMap((candidate) => {
		const record = candidate.store.getCommand(request.commandId);
		return record
			? [
					{
						record,
						authority: {
							kind: "project" as const,
							projectId: candidate.projectId,
							controlDomainId:
								candidate.controlDomainId,
						},
					},
				]
			: [];
	});
	const coordinator = host.coordinator.getCommand(request.commandId);
	const existing = [
		...projectRecords,
		...(coordinator
			? [
					{
						record: coordinator,
						authority: {
							kind: "coordinator" as const,
						},
					},
				]
			: []),
	];
	if (existing.length > 1) {
		throwControl(
			protocolError(
				"TF_DURABILITY_FAILED",
				"The command id is bound in more than one authority.",
				{
					recoveryAction: "operator",
					sideEffects: "unknown",
					commandId: request.commandId,
				},
			),
		);
	}
	const prior = existing[0];
	if (prior) {
		if (prior.record.callerPrincipal !== principalId) {
			commandAuthorityConflict(
				request.commandId,
				"TF_CROSS_PRINCIPAL_COMMAND",
			);
		}
		if (!sameCommandAuthority(prior.authority, authority)) {
			commandAuthorityConflict(
				request.commandId,
				"TF_IDEMPOTENCY_CONFLICT",
			);
		}
		const expectedLegacyHash =
			legacyAuthorityRequestHash(request);
		if (
			expectedLegacyHash === null ||
			browserCommandKind(prior.record) !== request.kind ||
			prior.record.requestHash !== expectedLegacyHash
		) {
			commandAuthorityConflict(
				request.commandId,
				"TF_IDEMPOTENCY_CONFLICT",
			);
		}
	}
	const result = host.coordinator.claimCommandRoute({
		commandId: request.commandId,
		authority,
		callerPrincipal: principalId,
		requestHash: hashRequest(request),
	});
	if (result.kind === "conflict") {
		commandAuthorityConflict(
			request.commandId,
			result.claim.callerPrincipal === principalId
				? "TF_IDEMPOTENCY_CONFLICT"
				: "TF_CROSS_PRINCIPAL_COMMAND",
		);
	}
	return result.claim;
}

export function createWebCommandHandlers(
	host: ControlHost,
	options: WebCommandServiceOptions = {},
): WebCommandHandlerMap {
	const listHosts =
		options.listHosts ??
		(() => [host] as readonly ControlHost[]);
	const supported = new Set<WebCommandKind>(
		options.supportedCommands ??
			WEB_DEFAULT_ENABLED_COMMAND_KINDS,
	);
	for (const kind of supported) {
		if (
			!(WEB_COMMAND_KINDS as readonly string[]).includes(
				kind,
			)
		) {
			throw new TypeError(`unknown Web command kind: ${kind}`);
		}
		if (
			!(
				WEB_IMPLEMENTED_COMMAND_KINDS as readonly string[]
			).includes(kind)
		) {
			throw new TypeError(
				`Web command kind is not implemented: ${kind}`,
			);
		}
	}

	async function submit(
		request: WebCommandRequest,
		context: WebHandlerContext,
	): Promise<WebCommandOutcome> {
		if (!supported.has(request.kind)) {
			throwControl(
				protocolError(
					"TF_FEATURE_REQUIRED",
					"This command is not implemented by the packaged backend.",
					{
						commandId: request.commandId,
						recoveryAction: "none",
						sideEffects: "none",
					},
				),
			);
		}

		switch (request.kind) {
			case "approve": {
				const projectHost = resolveHomeProject(
					host,
					request,
					options,
				);
				claimCommandRoute(
					host,
					request,
					context.principalId,
					{
						kind: "project",
						projectId: projectHost.projectId,
						controlDomainId:
							projectHost.controlDomainId,
					},
					listHosts,
				);
				const result = await projectHost.approve(request.runId, {
					commandId: request.commandId,
					principal: context.principalId,
					expectedRunVersion:
						request.expectedRunVersion,
					approvalRequestId:
						request.approvalRequestId,
				});
				throwIdentityConflict(result);
				const record = projectHost.store.getCommand(
					request.commandId,
				);
				if (record) {
					return projectOutcome(
						record,
						context.observedAt,
					);
				}
				throwControl(resultError(result));
			}
			case "reject": {
				const projectHost = resolveHomeProject(
					host,
					request,
					options,
				);
				claimCommandRoute(
					host,
					request,
					context.principalId,
					{
						kind: "project",
						projectId: projectHost.projectId,
						controlDomainId:
							projectHost.controlDomainId,
					},
					listHosts,
				);
				const result = await projectHost.reject(request.runId, {
					commandId: request.commandId,
					principal: context.principalId,
					expectedRunVersion:
						request.expectedRunVersion,
					approvalRequestId:
						request.approvalRequestId,
					note: request.reason,
				});
				throwIdentityConflict(result);
				const record = projectHost.store.getCommand(
					request.commandId,
				);
				if (record) {
					return projectOutcome(
						record,
						context.observedAt,
					);
				}
				throwControl(resultError(result));
			}
			case "cancel-run": {
				const projectHost = resolveHomeProject(
					host,
					request,
					options,
				);
				claimCommandRoute(
					host,
					request,
					context.principalId,
					{
						kind: "project",
						projectId: projectHost.projectId,
						controlDomainId:
							projectHost.controlDomainId,
					},
					listHosts,
				);
				const result = await projectHost.cancel(request.runId, {
					commandId: request.commandId,
					principal: context.principalId,
					expectedRunVersion:
						request.expectedRunVersion,
					reason: request.reason,
				});
				throwIdentityConflict(result);
				const record = projectHost.store.getCommand(
					request.commandId,
				);
				if (record) {
					return projectOutcome(
						record,
						context.observedAt,
					);
				}
				throwControl(resultError(result));
			}
			case "set-max-active-runs": {
				if (!host.canMutate) {
					throwControl(
						protocolError(
							"TF_AUTHORITY_REVOKED",
							"This listener is not the coordinator mutation authority.",
							{
								commandId:
									request.commandId,
								recoveryAction:
									"refresh",
							},
						),
					);
				}
				claimCommandRoute(
					host,
					request,
					context.principalId,
					{ kind: "coordinator" },
					listHosts,
				);
				try {
					const record =
						host.coordinator.setMaxActiveRuns(
							{
								value: request.value,
								expectedMaxActiveRuns:
									request.expectedMaxActiveRuns,
								expectedCoordinatorEpoch:
									request.expectedCoordinatorEpoch,
							},
							{
								commandId:
									request.commandId,
								callerPrincipal:
									context.principalId,
							},
						);
					return coordinatorOutcome(
						record,
						context.observedAt,
					);
				} catch (cause) {
					throwControl(
						coordinatorFailure(
							cause,
							request.commandId,
						),
					);
				}
			}
			case "force-release": {
				claimCommandRoute(
					host,
					request,
					context.principalId,
					{ kind: "coordinator" },
					listHosts,
				);
				const result = host.forceReleaseReservation(
					{
						reservationId:
							request.reservationId,
						expectedState: request.expectedState,
						expectedRevision:
							request.expectedRevision,
						expectedCoordinatorEpoch:
							request.expectedCoordinatorEpoch,
						expectedProjectId:
							request.expectedProjectId,
						expectedControlDomainId:
							request.expectedControlDomainId,
						expectedRunId:
							request.expectedRunId,
						acknowledgement:
							request.acknowledgement,
					},
					{
						commandId: request.commandId,
						principal: context.principalId,
					},
				);
				if (!result.ok) throwControl(result.error);
				const record = host.coordinator.getCommand(
					request.commandId,
				);
				if (!record) {
					throwControl(
						protocolError(
							"TF_DURABILITY_FAILED",
							"Force release returned without a durable command record.",
							{
								commandId:
									request.commandId,
								recoveryAction:
									"operator",
								sideEffects: "unknown",
							},
						),
					);
				}
				return coordinatorOutcome(
					record,
					context.observedAt,
				);
			}
			case "edit-approval":
			case "resume-run":
			case "recompute-run":
			case "reconcile-run":
				return throwControl(
					protocolError(
						"TF_FEATURE_REQUIRED",
						"This command is not implemented by the packaged backend.",
						{
							commandId: request.commandId,
							recoveryAction: "none",
							sideEffects: "none",
						},
					),
				);
		}
	}

	function query(
		commandId: string,
		context: WebHandlerContext,
	): WebCommandOutcome {
		const route = host.coordinator.getCommandRoute(commandId);
		if (route) {
			if (route.callerPrincipal !== context.principalId) {
				commandAuthorityConflict(
					commandId,
					"TF_CROSS_PRINCIPAL_COMMAND",
				);
			}
			let record: CommandRecord | CoordinatorCommandRecord | null;
			if (route.authority.kind === "coordinator") {
				record = host.coordinator.getCommand(commandId);
			} else {
				const authority = route.authority;
				const projectHost =
					options.resolveHost?.(
						authority.projectId,
						authority.controlDomainId,
					) ??
					listHosts().find(
						(candidate) =>
							candidate.projectId ===
								authority.projectId &&
							candidate.controlDomainId ===
								authority.controlDomainId,
					) ??
					null;
				record =
					projectHost?.store.getCommand(commandId) ?? null;
			}
			if (!record) {
				return {
					commandId,
					status: "not-found",
					observedAt: context.observedAt,
				};
			}
			if (record.callerPrincipal !== route.callerPrincipal) {
				throwControl(
					protocolError(
						"TF_DURABILITY_FAILED",
						"The durable command route and record disagree.",
						{
							commandId,
							recoveryAction: "operator",
							sideEffects: "unknown",
						},
					),
				);
			}
			return route.authority.kind === "project"
				? projectOutcome(
						record as CommandRecord,
						context.observedAt,
					)
				: coordinatorOutcome(
						record as CoordinatorCommandRecord,
						context.observedAt,
					);
		}
		const projectRecords = listHosts().flatMap((candidate) => {
			const record = candidate.store.getCommand(commandId);
			return record ? [record] : [];
		});
		const coordinator =
			host.coordinator.getCommand(commandId);
		if (
			projectRecords.length > 1 ||
			(projectRecords.length === 1 && coordinator)
		) {
			throwControl(
				protocolError(
					"TF_DURABILITY_FAILED",
					"The command id is bound in more than one authority.",
					{
						commandId,
						recoveryAction: "operator",
						sideEffects: "unknown",
					},
				),
			);
		}
		const project = projectRecords[0];
		const record = project ?? coordinator;
		if (!record) {
			return {
				commandId,
				status: "not-found",
				observedAt: context.observedAt,
			};
		}
		if (record.callerPrincipal !== context.principalId) {
			throwControl(
				protocolError(
					"TF_CROSS_PRINCIPAL_COMMAND",
					"The command belongs to another principal.",
					{
						commandId,
						recoveryAction: "none",
						sideEffects: "none",
					},
				),
			);
		}
		return project
			? projectOutcome(project, context.observedAt)
			: coordinatorOutcome(
					coordinator!,
					context.observedAt,
				);
	}

	return {
		commands: ({ body }, context) =>
			submit(body, context),
		command: ({ params }, context) =>
			query(params.commandId, context),
	};
}
