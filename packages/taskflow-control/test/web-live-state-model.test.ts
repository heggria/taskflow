/** Exhaustive P17 browser-local reducer and observation-gate matrix. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
	WebLiveStateSchema,
	WebObservationPresentationSchema,
	type WebAuthoritativeResourceIdentity,
	type WebLiveEvent,
	type WebLiveState,
	type WebSourceObservation,
} from "../src/web-presentation-schema.ts";
import {
	projectObservationPresentation,
	reduceWebLiveState,
} from "../src/web-presentation-client.ts";

const streamStates = [
	"connected",
	"catching-up",
	"disconnected",
] as const;
const resyncStates = [
	"idle",
	"required",
	"refreshing",
	"failed",
] as const;
const events: readonly WebLiveEvent[] = [
	{ type: "stream-connected", at: 13 },
	{ type: "stream-catching-up", at: 13 },
	{ type: "stream-disconnected", at: 13 },
	{ type: "reset-required", at: 13 },
	{ type: "principal-capability-changed" },
	{ type: "resync-started" },
	{ type: "resync-succeeded" },
	{ type: "resync-failed" },
];

function expectedTransition(
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
			const increments =
				previous.streamState !== "catching-up" &&
				previous.resyncState === "idle";
			return {
				...previous,
				streamState: "catching-up",
				resyncState: "required",
				invalidationEpoch:
					previous.invalidationEpoch +
					Number(increments),
				...(event.at === undefined ? {} : { lastFrameAt: event.at }),
			};
		}
		case "stream-disconnected":
			return previous.streamState === "disconnected"
				? previous
				: {
						...previous,
						streamState: "disconnected",
						resyncState: "required",
						invalidationEpoch:
							previous.invalidationEpoch + 1,
						...(event.at === undefined
							? {}
							: { lastFrameAt: event.at }),
					};
		case "reset-required":
			return {
				...previous,
				streamState: "catching-up",
				resyncState: "required",
				invalidationEpoch:
					previous.invalidationEpoch + 1,
				...(event.at === undefined ? {} : { lastFrameAt: event.at }),
			};
		case "principal-capability-changed":
			return {
				...previous,
				resyncState: "required",
				invalidationEpoch:
					previous.invalidationEpoch + 1,
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

test("P17 live-state reducer covers every state × event transition", () => {
	let checked = 0;
	for (const streamState of streamStates) {
		for (const resyncState of resyncStates) {
			const previous: WebLiveState = {
				streamState,
				resyncState,
				invalidationEpoch: 7,
				lastFrameAt: 11,
			};
			assert.equal(Value.Check(WebLiveStateSchema, previous), true);
			for (const event of events) {
				const snapshot = structuredClone(previous);
				const actual = reduceWebLiveState(previous, event);
				assert.deepEqual(
					actual,
					expectedTransition(previous, event),
					JSON.stringify({
						streamState,
						resyncState,
						event: event.type,
					}),
				);
				assert.deepEqual(previous, snapshot);
				assert.equal(Value.Check(WebLiveStateSchema, actual), true);
				assert.ok(
					actual.invalidationEpoch ===
						previous.invalidationEpoch ||
						actual.invalidationEpoch ===
							previous.invalidationEpoch + 1,
				);
				checked += 1;
			}
		}
	}
	assert.equal(checked, 96);
});

test("P17 disconnect/reset/principal invalidation is not doubled by catch-up", () => {
	for (const invalidation of [
		{ type: "stream-disconnected", at: 1 },
		{ type: "reset-required", at: 1 },
		{ type: "principal-capability-changed" },
	] as const satisfies readonly WebLiveEvent[]) {
		const invalidated = reduceWebLiveState(
			{
				streamState: "connected",
				resyncState: "idle",
				invalidationEpoch: 4,
			},
			invalidation,
		);
		assert.equal(invalidated.invalidationEpoch, 5);
		const catchingUp = reduceWebLiveState(invalidated, {
			type: "stream-catching-up",
			at: 2,
		});
		assert.equal(catchingUp.invalidationEpoch, 5);
		assert.equal(catchingUp.resyncState, "required");
	}
});

test("P17 invalidation epoch overflow fails closed without wrapping", () => {
	const maximum: WebLiveState = {
		streamState: "connected",
		resyncState: "idle",
		invalidationEpoch: Number.MAX_SAFE_INTEGER,
	};
	for (const event of [
		{ type: "stream-catching-up" },
		{ type: "stream-disconnected" },
		{ type: "reset-required" },
		{ type: "principal-capability-changed" },
	] as const satisfies readonly WebLiveEvent[]) {
		assert.throws(
			() => reduceWebLiveState(maximum, event),
			/invalidation epoch exhausted/u,
			event.type,
		);
	}
	assert.equal(
		reduceWebLiveState(
			{ ...maximum, resyncState: "required" },
			{ type: "stream-catching-up" },
		).invalidationEpoch,
		Number.MAX_SAFE_INTEGER,
	);
	assert.equal(
		reduceWebLiveState(
			{ ...maximum, streamState: "disconnected" },
			{ type: "stream-disconnected" },
		).invalidationEpoch,
		Number.MAX_SAFE_INTEGER,
	);
});

const resources: readonly WebAuthoritativeResourceIdentity[] = [
	{
		type: "project",
		projectId: "project-1",
		controlDomainId: "domain-1",
	},
	{
		type: "run",
		projectId: "project-1",
		controlDomainId: "domain-1",
		runId: "run-1",
	},
	{
		type: "approval",
		projectId: "project-1",
		controlDomainId: "domain-1",
		runId: "run-1",
		approvalRequestId: "approval-1",
	},
	{
		type: "reservation",
		reservationId: "reservation-1",
	},
];

function mismatched(
	resource: WebAuthoritativeResourceIdentity,
): WebAuthoritativeResourceIdentity {
	switch (resource.type) {
		case "project":
			return { ...resource, projectId: "project-2" };
		case "run":
			return { ...resource, runId: "run-2" };
		case "approval":
			return {
				...resource,
				approvalRequestId: "approval-2",
			};
		case "reservation":
			return {
				...resource,
				reservationId: "reservation-2",
			};
	}
}

test("P17 observation projection covers every gate and message-priority axis", () => {
	let checked = 0;
	for (const streamState of streamStates) {
		for (const resyncState of resyncStates) {
			for (const coverage of ["complete", "partial"] as const) {
				for (const authority of ["verified", "unverified"] as const) {
					const sourceObservation: WebSourceObservation = {
						coverage,
						authority,
						observedAt: 17,
						registryContext: {
							mode: "standalone",
							registryRevision: "standalone",
							visibleMounts: [
								{
									projectId: "project-1",
									controlDomainId: "domain-1",
								},
							],
						},
						watermarks: [],
					};
					const liveState: WebLiveState = {
						streamState,
						resyncState,
						invalidationEpoch: 9,
						lastFrameAt: 16,
					};
					const expectedKey =
						authority !== "verified"
							? "observation.source-authority-unverified"
							: coverage === "partial"
								? "observation.source-coverage-partial"
								: streamState !== "connected" ||
										resyncState !== "idle"
									? "observation.live-updates-paused"
									: "observation.source-ready";
					const aggregate =
						projectObservationPresentation({
							sourceObservation,
							liveState,
							scope: { kind: "aggregate" },
						});
					assert.equal(
						Value.Check(
							WebObservationPresentationSchema,
							aggregate,
						),
						true,
					);
					assert.equal(aggregate.message.key, expectedKey);
					assert.equal(
						aggregate.stateSensitiveActionsAllowed,
						false,
					);
					checked += 1;

					for (const resource of resources) {
						for (const stampCase of [
							"absent",
							"current-match",
							"stale-match",
							"current-mismatch",
						] as const) {
							const refreshStamp =
								stampCase === "absent"
									? undefined
									: {
											resource:
												stampCase ===
												"current-mismatch"
													? mismatched(
															resource,
														)
													: resource,
											invalidationEpoch:
												stampCase ===
												"stale-match"
													? 8
													: 9,
											requestId:
												"request-1",
											observedAt: 17,
										};
							const projected =
								projectObservationPresentation({
									sourceObservation,
									liveState,
									scope: {
										kind: "authoritative-detail",
										resource,
										...(refreshStamp
											? {
													refreshStamp,
												}
											: {}),
									},
								});
							assert.equal(
								Value.Check(
									WebObservationPresentationSchema,
									projected,
								),
								true,
							);
							assert.equal(
								projected.message.key,
								expectedKey,
							);
							assert.equal(
								projected
									.stateSensitiveActionsAllowed,
								authority === "verified" &&
									resyncState === "idle" &&
									stampCase ===
										"current-match",
								JSON.stringify({
									streamState,
									resyncState,
									coverage,
									authority,
									resource: resource.type,
									stampCase,
								}),
							);
							assert.equal(
								projected.source
									.invalidationEpoch,
								9,
							);
							checked += 1;
						}
					}
				}
			}
		}
	}
	assert.equal(checked, 816);
});
