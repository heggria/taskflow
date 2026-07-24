/**
 * P17 resumable observation stream.
 *
 * The stream carries bounded invalidations/checkpoints only. Domain resources
 * are always refetched through their authoritative JSON endpoints.
 */
import * as fs from "node:fs";
import {
	sha256Hex,
	stableStringify,
} from "./hash.ts";
import type { ControlHost } from "./control-host.ts";
import { loadCompactionState } from "./compaction.ts";
import { projectControlRoot } from "./paths.ts";
import {
	WebCursorError,
	type WebCursorCodec,
} from "./web-cursor.ts";
import type {
	WebHandlerContext,
	WebHandlerMap,
	WebProjectWatermark,
	WebSourceObservation,
	WebStreamFrame,
} from "./web-protocol.ts";
import {
	WebReadServiceError,
} from "./web-read-service.ts";

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_HEARTBEAT_MS = 15_000;
const STREAM_CURSOR_MAX_AGE_MS = 60 * 60_000;

export const WEB_IMPLEMENTED_EVENT_HANDLER_IDS = [
	"events",
] as const;

export type WebEventHandlerMap = Pick<
	WebHandlerMap,
	"events"
>;

export type WebEventServiceOptions = {
	readonly cursorCodec: WebCursorCodec;
	readonly now?: () => number;
	readonly pollIntervalMs?: number;
	readonly heartbeatMs?: number;
	/** Current daemon mounts; avoids rescanning full ControlStore projections. */
	readonly listHosts?: () => readonly ControlHost[];
};

function digest(value: unknown): string {
	return `sha256:${sha256Hex(stableStringify(value))}`;
}

function same(left: unknown, right: unknown): boolean {
	return stableStringify(left) === stableStringify(right);
}

function createCommitWakeup(hosts: readonly ControlHost[]): {
	wait(milliseconds: number, signal?: AbortSignal): Promise<boolean>;
	close(): void;
} {
	const watchers: fs.FSWatcher[] = [];
	let pending = false;
	let waiting:
		| ((observed: boolean) => void)
		| undefined;
	const wake = () => {
		if (waiting) {
			const resolve = waiting;
			waiting = undefined;
			resolve(true);
			return;
		}
		pending = true;
	};
	for (const controlRoot of new Set(
		hosts.map((candidate) =>
			projectControlRoot(
				candidate.store.projectRoot,
			),
		),
	)) {
		try {
			const watcher = fs.watch(
				controlRoot,
				(_eventType, fileName) => {
					if (
						fileName === null ||
						fileName === "commit-seq.json"
					) {
						wake();
					}
				},
			);
			watcher.on("error", () => {
				watcher.close();
			});
			watchers.push(watcher);
		} catch {
			// The bounded poll remains the correctness fallback.
		}
	}
	return {
		wait(milliseconds, signal) {
			if (signal?.aborted) {
				return Promise.resolve(false);
			}
			if (pending) {
				pending = false;
				return Promise.resolve(true);
			}
			return new Promise((resolve) => {
				let settled = false;
				const finish = (observed: boolean) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					signal?.removeEventListener(
						"abort",
						aborted,
					);
					if (waiting === finish) {
						waiting = undefined;
					}
					resolve(observed);
				};
				const timer = setTimeout(
					() => finish(true),
					milliseconds,
				);
				const aborted = () => finish(false);
				waiting = finish;
				signal?.addEventListener(
					"abort",
					aborted,
					{ once: true },
				);
			});
		},
		close() {
			for (const watcher of watchers) {
				watcher.close();
			}
			watchers.length = 0;
			waiting?.(false);
			waiting = undefined;
		},
	};
}

function selectedWatermarks(
	observation: WebSourceObservation,
	projectIds: readonly string[],
): WebProjectWatermark[] {
	if (projectIds.length === 0) {
		return [...observation.watermarks];
	}
	const selected = new Set(projectIds);
	return observation.watermarks.filter((watermark) =>
		selected.has(watermark.projectId),
	);
}

function watermarkIdentity(
	watermark: Pick<
		WebProjectWatermark,
		"projectId" | "controlDomainId"
	>,
): string {
	return `${watermark.projectId}\u0000${watermark.controlDomainId}`;
}

function replaceWatermark(
	position: readonly WebProjectWatermark[],
	next: WebProjectWatermark,
): WebProjectWatermark[] {
	const identity = watermarkIdentity(next);
	return position
		.map((watermark) =>
			watermarkIdentity(watermark) === identity
				? next
				: watermark,
		)
		.sort(
			(left, right) =>
				left.projectId.localeCompare(
					right.projectId,
					"en",
				) ||
				left.controlDomainId.localeCompare(
					right.controlDomainId,
					"en",
				),
		);
}

export function createWebEventHandlers(
	host: ControlHost,
	options: WebEventServiceOptions,
): WebEventHandlerMap {
	const now = options.now ?? Date.now;
	const pollIntervalMs =
		options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const heartbeatMs =
		options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
	if (
		!Number.isSafeInteger(pollIntervalMs) ||
		pollIntervalMs < 10
	) {
		throw new RangeError(
			"Web event poll interval must be an integer >= 10ms",
		);
	}
	if (
		!Number.isSafeInteger(heartbeatMs) ||
		heartbeatMs < pollIntervalMs
	) {
		throw new RangeError(
			"Web event heartbeat must be an integer >= poll interval",
		);
	}
	function observation(): WebSourceObservation {
		const observedAt = now();
		const registryEntries =
			host.controlMode === "standalone"
				? [
						{
							projectId: host.projectId,
							controlDomainId:
								host.controlDomainId,
						},
					]
				: host.registry
						.list()
						.sort(
							(left, right) =>
								left.projectId.localeCompare(
									right.projectId,
									"en",
								) ||
								left.controlDomainId.localeCompare(
									right.controlDomainId,
									"en",
								),
						);
		const entries = registryEntries.slice(0, 200);
		const mounts = [
			...(options.listHosts?.() ?? [host]),
		];
		const mountedByIdentity = new Map(
			mounts.map((mounted) => [
				watermarkIdentity(mounted),
				mounted,
			]),
		);
		const visibleMounts = entries.map((entry) => ({
			projectId: entry.projectId,
			controlDomainId: entry.controlDomainId,
		}));
		const watermarks = entries.flatMap((entry) => {
			const mounted = mountedByIdentity.get(
				watermarkIdentity(entry),
			);
			if (!mounted) return [];
			return [
				{
					projectId: entry.projectId,
					controlDomainId:
						entry.controlDomainId,
					nextCommitSeq:
						mounted.store.nextCommitSeq(),
					minAvailableCommitSeq:
						loadCompactionState(
							mounted.store.projectRoot,
						).minAvailableCommitSeq,
				},
			];
		});
		const complete =
			registryEntries.length <= 200 &&
			watermarks.length === entries.length;
		return {
			coverage: complete ? "complete" : "partial",
			authority: complete ? "verified" : "unverified",
			observedAt,
			registryContext:
				host.controlMode === "standalone"
					? {
							mode: "standalone",
							registryRevision: "standalone",
							visibleMounts: [
								{
									projectId:
										host.projectId,
									controlDomainId:
										host.controlDomainId,
								},
							],
						}
					: {
							mode: "auto",
							registryRevision:
								host.registry.revision,
							visibleMounts,
						},
			watermarks,
		};
	}

	function cursor(
		source: WebSourceObservation,
		position: readonly WebProjectWatermark[],
		context: WebHandlerContext,
	): string {
		const observedAt = now();
		return options.cursorCodec.encodeStream({
			version: 1,
			kind: "stream",
			listenerId: context.listenerId,
			principalHash: context.principalHash,
			registryContext: source.registryContext,
			visibleMountsHash: digest(
				source.registryContext.visibleMounts,
			),
			projectWatermarks: [...position],
			issuedAt: observedAt,
			expiresAt: Math.min(
				observedAt + STREAM_CURSOR_MAX_AGE_MS,
				context.sessionAbsoluteExpiresAt,
			),
		});
	}

	function checkpoint(
		source: WebSourceObservation,
		position: readonly WebProjectWatermark[],
		context: WebHandlerContext,
	): WebStreamFrame {
		const encoded = cursor(source, position, context);
		return {
			type: "checkpoint",
			id: encoded,
			cursor: encoded,
			observedAt: now(),
			registryRevision:
				source.registryContext.registryRevision,
			projectWatermarks: [...position],
		};
	}

	function reset(
		source: WebSourceObservation,
		position: readonly WebProjectWatermark[],
		context: WebHandlerContext,
		message: string,
	): WebStreamFrame {
		const encoded = cursor(source, position, context);
		return {
			type: "reset-required",
			id: encoded,
			cursor: encoded,
			observedAt: now(),
			error: {
				code: "TF_CURSOR_EXPIRED",
				message,
				recoveryAction: "refresh",
				sideEffects: "none",
			},
		} as unknown as WebStreamFrame;
	}

	return {
		events: (
			{ query },
			context,
		): AsyncIterable<WebStreamFrame> => {
			const projectIds = [...(query.projectIds ?? [])].sort(
				(left, right) =>
					left.localeCompare(right, "en"),
			);
			return (async function* stream() {
				let source = observation();
				const visibleProjectIds = new Set(
					source.registryContext.visibleMounts.map(
						(mount) => mount.projectId,
					),
				);
				if (
					projectIds.some(
						(projectId) =>
							!visibleProjectIds.has(projectId),
					)
				) {
					throw new WebReadServiceError({
						code: "TF_AUTHORITY_REVOKED",
						message:
							"Event filter contains a project outside the current visible mounts.",
						recoveryAction: "refresh",
						sideEffects: "none",
					});
				}
				let current = selectedWatermarks(
					source,
					projectIds,
				);
				let position = [...current];
				if (query.cursor) {
					let decoded;
					try {
						decoded =
							options.cursorCodec.decodeStream(
								query.cursor,
								{
									listenerId:
										context.listenerId,
									principalHash:
										context.principalHash,
									registryContext:
										source.registryContext,
									visibleMountsHash:
										digest(
											source
												.registryContext
												.visibleMounts,
										),
									projectWatermarks:
										current,
								},
							);
					} catch (cause) {
						if (cause instanceof WebCursorError) {
							throw new WebReadServiceError(
								cause.controlError,
							);
						}
						throw cause;
					}
					if (
						!same(
							decoded.projectWatermarks.map(
								watermarkIdentity,
							),
							current.map(watermarkIdentity),
						)
					) {
						throw new WebReadServiceError({
							code: "TF_CURSOR_EXPIRED",
							message:
								"Event cursor belongs to a different project filter.",
							recoveryAction: "refresh",
							sideEffects: "none",
						});
					}
					position = [
						...decoded.projectWatermarks,
					];
					const currentById = new Map(
						current.map((watermark) => [
							watermarkIdentity(watermark),
							watermark,
						]),
					);
					const gap = position.some((watermark) => {
						const latest = currentById.get(
							watermarkIdentity(watermark),
						);
						return (
							!latest ||
							watermark.nextCommitSeq <
								latest.minAvailableCommitSeq ||
							watermark.nextCommitSeq >
								latest.nextCommitSeq
						);
					});
					if (gap) {
						yield reset(
							source,
							current,
							context,
							"Event history is no longer continuously available; refresh authoritative resources.",
						);
						return;
					}
				}
				yield checkpoint(source, position, context);

				let lastFrameAt = now();
				const commitWakeup = createCommitWakeup([
					...(options.listHosts?.() ?? [host]),
				]);
				try {
					for (;;) {
						if (
							context.signal?.aborted ||
							now() >=
								context.sessionAbsoluteExpiresAt
						) {
							return;
						}
						if (
							!(await commitWakeup.wait(
								pollIntervalMs,
								context.signal,
							))
						) {
							return;
						}
					const nextSource = observation();
					if (
						!same(
							nextSource.registryContext,
							source.registryContext,
						)
					) {
						const next = selectedWatermarks(
							nextSource,
							projectIds,
						);
						yield reset(
							nextSource,
							next,
							context,
							"Visible project mounts changed; refresh authoritative resources.",
						);
						return;
					}
					current = selectedWatermarks(
						nextSource,
						projectIds,
					);
					const positionById = new Map(
						position.map((watermark) => [
							watermarkIdentity(watermark),
							watermark,
						]),
					);
					for (const latest of current) {
						const prior = positionById.get(
							watermarkIdentity(latest),
						);
						if (
							!prior ||
							prior.nextCommitSeq <
								latest.minAvailableCommitSeq
						) {
							yield reset(
								nextSource,
								current,
								context,
								"Event history was compacted before it could be observed; refresh authoritative resources.",
							);
							return;
						}
						if (
							latest.nextCommitSeq <=
							prior.nextCommitSeq
						) {
							continue;
						}
						position = replaceWatermark(
							position,
							latest,
						);
						const encoded = cursor(
							nextSource,
							position,
							context,
						);
						yield {
							type: "change",
							id: encoded,
							cursor: encoded,
							observedAt: now(),
							kind: "invalidated",
							resourceType: "project",
							resourceId: latest.projectId,
							projectId: latest.projectId,
							controlDomainId:
								latest.controlDomainId,
							...(latest.nextCommitSeq > 1
								? {
										commitSeq:
											latest.nextCommitSeq -
											1,
									}
								: {}),
						};
						lastFrameAt = now();
					}
					source = nextSource;
					if (
						now() - lastFrameAt >=
						heartbeatMs
					) {
						const encoded = cursor(
							source,
							position,
							context,
						);
						yield {
							type: "heartbeat",
							id: encoded,
							cursor: encoded,
							observedAt: now(),
						};
						lastFrameAt = now();
					}
					}
				} finally {
					commitWakeup.close();
				}
			})();
		},
	};
}
