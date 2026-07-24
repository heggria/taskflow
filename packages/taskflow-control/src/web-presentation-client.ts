/**
 * P17 v5 browser-only deterministic projections.
 *
 * This module owns the tab-local live-state reducer plus observation and
 * failure presentation. It does not import server projection implementations.
 */
import {
	WEB_CONTENT_CATALOG_VERSION,
	type WebAuthoritativeResourceIdentity,
	type WebContentMessage,
	type WebFailurePresentation,
	type WebFailurePresentationInput,
	type WebLiveEvent,
	type WebLiveState,
	type WebObservationPresentation,
	type WebObservationPresentationInput,
} from "./web-presentation-schema.ts";

export const WEB_OBSERVATION_PRESENTATION_VERSION =
	"observation-presentation.v1" as const;
export const WEB_FAILURE_PRESENTATION_VERSION =
	"failure-presentation.v1" as const;

export const INITIAL_WEB_LIVE_STATE: WebLiveState = {
	streamState: "disconnected",
	resyncState: "required",
	invalidationEpoch: 0,
};

function incrementEpoch(epoch: number): number {
	if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch >= Number.MAX_SAFE_INTEGER) {
		throw new RangeError(
			"P17 live-state invalidation epoch exhausted; reload the browser session",
		);
	}
	return epoch + 1;
}

export function reduceWebLiveState(
	previous: WebLiveState,
	event: WebLiveEvent,
): WebLiveState {
	switch (event.type) {
		case "stream-connected":
			return {
				...previous,
				streamState: "connected",
				...(event.at === undefined ? {} : { lastFrameAt: event.at }),
			};
		case "stream-catching-up": {
			const startsNewInvalidation =
				previous.streamState !== "catching-up" &&
				previous.resyncState === "idle";
			return {
				...previous,
				streamState: "catching-up",
				resyncState: "required",
				invalidationEpoch: startsNewInvalidation
					? incrementEpoch(previous.invalidationEpoch)
					: previous.invalidationEpoch,
				...(event.at === undefined ? {} : { lastFrameAt: event.at }),
			};
		}
		case "stream-disconnected":
			if (previous.streamState === "disconnected") return previous;
			return {
				...previous,
				streamState: "disconnected",
				resyncState: "required",
				invalidationEpoch: incrementEpoch(previous.invalidationEpoch),
				...(event.at === undefined ? {} : { lastFrameAt: event.at }),
			};
		case "reset-required":
			return {
				...previous,
				streamState: "catching-up",
				resyncState: "required",
				invalidationEpoch: incrementEpoch(previous.invalidationEpoch),
				...(event.at === undefined ? {} : { lastFrameAt: event.at }),
			};
		case "principal-capability-changed":
			return {
				...previous,
				resyncState: "required",
				invalidationEpoch: incrementEpoch(previous.invalidationEpoch),
			};
		case "resync-started":
			return previous.resyncState === "required" ||
				previous.resyncState === "failed"
				? { ...previous, resyncState: "refreshing" }
				: previous;
		case "resync-succeeded":
			return previous.resyncState === "refreshing"
				? { ...previous, resyncState: "idle" }
				: previous;
		case "resync-failed":
			return previous.resyncState === "refreshing"
				? { ...previous, resyncState: "failed" }
				: previous;
	}
}

function message(
	key: WebContentMessage["key"],
	args: WebContentMessage["args"] = [],
): WebContentMessage {
	return {
		catalogVersion: WEB_CONTENT_CATALOG_VERSION,
		key,
		args: [...args].sort((a, b) => a.name.localeCompare(b.name, "en")),
	};
}

function sameResource(
	a: WebAuthoritativeResourceIdentity,
	b: WebAuthoritativeResourceIdentity,
): boolean {
	if (a.type !== b.type) return false;
	switch (a.type) {
		case "project":
			return (
				b.type === "project" &&
				a.projectId === b.projectId &&
				a.controlDomainId === b.controlDomainId
			);
		case "run":
			return (
				b.type === "run" &&
				a.projectId === b.projectId &&
				a.controlDomainId === b.controlDomainId &&
				a.runId === b.runId
			);
		case "approval":
			return (
				b.type === "approval" &&
				a.projectId === b.projectId &&
				a.controlDomainId === b.controlDomainId &&
				a.runId === b.runId &&
				a.approvalRequestId === b.approvalRequestId
			);
		case "reservation":
			return b.type === "reservation" && a.reservationId === b.reservationId;
	}
}

export function projectObservationPresentation(
	input: WebObservationPresentationInput,
): WebObservationPresentation {
	const { sourceObservation, liveState, scope } = input;
	const refreshStamp =
		scope.kind === "authoritative-detail" ? scope.refreshStamp : undefined;
	const stampMatches =
		scope.kind === "authoritative-detail" &&
		refreshStamp !== undefined &&
		sameResource(refreshStamp.resource, scope.resource) &&
		refreshStamp.invalidationEpoch === liveState.invalidationEpoch;
	const stateSensitiveActionsAllowed =
		scope.kind === "authoritative-detail" &&
		sourceObservation.authority === "verified" &&
		liveState.resyncState === "idle" &&
		stampMatches;

	let key: WebContentMessage["key"];
	if (sourceObservation.authority !== "verified") {
		key = "observation.source-authority-unverified";
	} else if (sourceObservation.coverage === "partial") {
		key = "observation.source-coverage-partial";
	} else if (
		liveState.streamState !== "connected" ||
		liveState.resyncState !== "idle"
	) {
		key = "observation.live-updates-paused";
	} else {
		key = "observation.source-ready";
	}
	return {
		projectionVersion: WEB_OBSERVATION_PRESENTATION_VERSION,
		message: message(key),
		severity: key === "observation.source-ready" ? "neutral" : "warning",
		stateSensitiveActionsAllowed,
		source: {
			scope:
				scope.kind === "aggregate" ? "aggregate" : "authoritative-detail",
			invalidationEpoch: liveState.invalidationEpoch,
			...(refreshStamp
				? { authorityRefreshEpoch: refreshStamp.invalidationEpoch }
				: {}),
			streamState: liveState.streamState,
			resyncState: liveState.resyncState,
			coverage: sourceObservation.coverage,
			authority: sourceObservation.authority,
			observedAt: sourceObservation.observedAt,
		},
	};
}

function availableAction(
	input: WebFailurePresentationInput,
	kind: string,
): boolean {
	return input.context.availableActions.some(
		(action) => action.kind === kind && action.state === "available",
	);
}

function recoveryKey(
	recoveryAction: WebFailurePresentationInput["failure"]["error"]["recoveryAction"],
): WebContentMessage["key"] {
	return `recovery.${recoveryAction}` as WebContentMessage["key"];
}

function riskKey(
	sideEffects: WebFailurePresentationInput["failure"]["error"]["sideEffects"],
): WebContentMessage["key"] {
	return sideEffects === "none"
		? "risk.none"
		: sideEffects === "possible"
			? "risk.possible-live-side-effects"
			: "risk.unknown-side-effects";
}

function failureActionKind(
	input: WebFailurePresentationInput,
): WebFailurePresentation["actionKind"] {
	const recovery = input.failure.error.recoveryAction;
	const operation = input.context.operation;
	switch (recovery) {
		case "refresh":
			return "refresh";
		case "retry-same-command":
			return operation !== "none" &&
				input.context.commandBodyState ===
					"present-in-current-tab-memory" &&
				availableAction(input, operation)
				? "retry-same-command"
				: "none";
		case "retry-new-command":
			return operation !== "none" &&
				input.context.supportedCommands.includes(operation) &&
				availableAction(input, operation)
				? "retry-new-command"
				: "none";
		case "reconcile":
			return availableAction(input, "reconcile-run")
				? "open-reconcile"
				: "none";
		case "operator":
			return "contact-operator";
		case "none":
			return "none";
	}
	return "none";
}

function sanitizedTechnicalMessage(value: string): string {
	return value
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
		.slice(0, 8_192);
}

export function projectControlErrorPresentation(
	input: WebFailurePresentationInput,
): WebFailurePresentation {
	const { error } = input.failure;
	const actionKind = failureActionKind(input);
	const nextAction =
		error.code === "TF_CURSOR_EXPIRED"
			? message("system.cursor-expired.refresh")
			: error.recoveryAction === "none"
				? message("system.no-action-required")
				: message(recoveryKey(error.recoveryAction));
	return {
		projectionVersion: WEB_FAILURE_PRESENTATION_VERSION,
		headline: message(
			`error.${error.code}.headline` as WebContentMessage["key"],
		),
		detail: message(
			`error.${error.code}.detail` as WebContentMessage["key"],
		),
		risk: message(riskKey(error.sideEffects)),
		nextAction,
		actionKind,
		technical: {
			code: error.code,
			sanitizedMessage: sanitizedTechnicalMessage(error.message),
			requestId: input.failure.requestId,
			...(error.commandId ? { commandId: error.commandId } : {}),
		},
	};
}
