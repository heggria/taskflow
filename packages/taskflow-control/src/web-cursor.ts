/**
 * P17 exact signed cursor codec (server-only).
 *
 * Payloads are P6-canonical JSON, encoded base64url without padding, and
 * authenticated over the ASCII payload segment with HMAC-SHA-256.
 */
import * as crypto from "node:crypto";
import { Value } from "typebox/value";
import { stableStringify } from "./hash.ts";
import type { ControlError } from "./types.ts";
import {
	WEB_CURSOR_MAX_BYTES,
	WebPageCursorPayloadSchema,
	WebStreamCursorPayloadSchema,
	type WebPageCursorPayload,
	type WebProjectWatermark,
	type WebRegistryContext,
	type WebStreamCursorPayload,
} from "./web-protocol.ts";

const PAGE_CURSOR_MAX_AGE_MS = 10 * 60_000;
const STREAM_CURSOR_MAX_AGE_MS = 60 * 60_000;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export type WebCursorPayload =
	| WebPageCursorPayload
	| WebStreamCursorPayload;

export class WebCursorError extends Error {
	readonly controlError: ControlError;

	constructor(kind: "invalid" | "expired") {
		const controlError: ControlError =
			kind === "expired"
				? {
						code: "TF_CURSOR_EXPIRED",
						message:
							"The cursor is authentic but no longer matches the current snapshot.",
						recoveryAction: "refresh",
						sideEffects: "none",
					}
				: {
						code: "TF_INVALID_ARGUMENT",
						message: "The cursor is malformed, tampered with, or the wrong kind.",
						recoveryAction: "refresh",
						sideEffects: "none",
					};
		super(controlError.message);
		this.name = "WebCursorError";
		this.controlError = controlError;
	}
}

type WebCursorRegistryBinding = {
	readonly registryContext: WebRegistryContext;
	readonly visibleMountsHash: string;
};

type WebCursorSnapshotBinding = WebCursorRegistryBinding & {
	readonly projectWatermarks: readonly WebProjectWatermark[];
};

type CompactRegistryFields =
	| "registryMode"
	| "registryRevision"
	| "registryContextHash"
	| "visibleMountsHash";

type CompactPageAuthorityFields =
	| CompactRegistryFields
	| "projectWatermarksHash";

type CompactStreamAuthorityFields =
	| CompactRegistryFields
	| "projectIdentityHash"
	| "projectPositions";

export type WebPageCursorBinding = Pick<
	WebPageCursorPayload,
	| "collection"
	| "listenerId"
	| "principalHash"
	| "queryHash"
	| "sortKey"
	| "sortDirection"
	| "resourceVersion"
> &
	WebCursorSnapshotBinding;

export type WebStreamCursorBinding = Pick<
	WebStreamCursorPayload,
	| "listenerId"
	| "principalHash"
> &
	WebCursorSnapshotBinding;

export type WebPageCursorInput = Omit<
	WebPageCursorPayload,
	CompactPageAuthorityFields
> &
	WebCursorSnapshotBinding;

export type WebStreamCursorInput = Omit<
	WebStreamCursorPayload,
	CompactStreamAuthorityFields
> &
	WebCursorSnapshotBinding;

export type WebDecodedStreamCursor =
	WebStreamCursorPayload & {
		readonly projectWatermarks: readonly WebProjectWatermark[];
	};

export type WebCursorCodec = {
	encodePage(payload: WebPageCursorInput): string;
	encodeStream(payload: WebStreamCursorInput): string;
	decodePage(
		cursor: string,
		expected: WebPageCursorBinding,
	): WebPageCursorPayload;
	decodeStream(
		cursor: string,
		expected: WebStreamCursorBinding,
	): WebDecodedStreamCursor;
};

export function createWebCursorKey(): Uint8Array {
	return crypto.randomBytes(32);
}

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

function decodeBase64url(segment: string): Uint8Array {
	if (
		segment.length === 0 ||
		!BASE64URL_PATTERN.test(segment) ||
		segment.includes("=")
	) {
		throw new WebCursorError("invalid");
	}
	try {
		const decoded = Buffer.from(segment, "base64url");
		if (base64url(decoded) !== segment) throw new WebCursorError("invalid");
		return decoded;
	} catch (error) {
		if (error instanceof WebCursorError) throw error;
		throw new WebCursorError("invalid");
	}
}

function sameBinding(left: unknown, right: unknown): boolean {
	return stableStringify(left) === stableStringify(right);
}

function digestCanonical(value: unknown): string {
	return `sha256:${crypto
		.createHash("sha256")
		.update(stableStringify(value), "utf8")
		.digest("hex")}`;
}

function compactRegistry(binding: WebCursorRegistryBinding) {
	return {
		registryMode: binding.registryContext.mode,
		registryRevision:
			binding.registryContext.registryRevision,
		registryContextHash: digestCanonical(
			binding.registryContext,
		),
		visibleMountsHash: binding.visibleMountsHash,
	};
}

function projectIdentityMaterial(
	watermarks: readonly WebProjectWatermark[],
) {
	return watermarks.map(({ projectId, controlDomainId }) => ({
		projectId,
		controlDomainId,
	}));
}

function compactPageInput(
	input: WebPageCursorInput,
): WebPageCursorPayload {
	const {
		registryContext,
		projectWatermarks,
		...rest
	} = input;
	return {
		...rest,
		...compactRegistry({
			registryContext,
			visibleMountsHash: input.visibleMountsHash,
		}),
		projectWatermarksHash: digestCanonical(
			projectWatermarks,
		),
	} as WebPageCursorPayload;
}

function compactStreamInput(
	input: WebStreamCursorInput,
): WebStreamCursorPayload {
	const {
		registryContext,
		projectWatermarks,
		...rest
	} = input;
	return {
		...rest,
		...compactRegistry({
			registryContext,
			visibleMountsHash: input.visibleMountsHash,
		}),
		projectIdentityHash: digestCanonical(
			projectIdentityMaterial(projectWatermarks),
		),
		projectPositions: projectWatermarks.map(
			(watermark) => watermark.nextCommitSeq,
		),
	} as WebStreamCursorPayload;
}

export function createWebCursorCodec(options: {
	key: Uint8Array;
	listenerId: string;
	now?: () => number;
}): WebCursorCodec {
	if (options.key.byteLength !== 32) {
		throw new RangeError("P17 listener cursor key must be exactly 256 bits");
	}
	const key = Buffer.from(options.key);
	const now = options.now ?? Date.now;
	let clockFloor = 0;

	function logicalNow(): number {
		const observed = now();
		if (!Number.isSafeInteger(observed) || observed < 0) {
			throw new RangeError("cursor clock must return a non-negative safe integer");
		}
		clockFloor = Math.max(clockFloor, observed);
		return clockFloor;
	}

	function sign(payload: WebCursorPayload): string {
		const payloadJson = stableStringify(payload);
		const payloadSegment = base64url(Buffer.from(payloadJson, "utf8"));
		const signature = crypto
			.createHmac("sha256", key)
			.update(payloadSegment, "ascii")
			.digest();
		const cursor = `${payloadSegment}.${base64url(signature)}`;
		if (Buffer.byteLength(cursor, "utf8") > WEB_CURSOR_MAX_BYTES) {
			throw new RangeError("P17 cursor exceeds 8 KiB");
		}
		return cursor;
	}

	function verify(cursor: string): unknown {
		if (
			typeof cursor !== "string" ||
			Buffer.byteLength(cursor, "utf8") > WEB_CURSOR_MAX_BYTES
		) {
			throw new WebCursorError("invalid");
		}
		const segments = cursor.split(".");
		if (segments.length !== 2) throw new WebCursorError("invalid");
		const payloadSegment = segments[0]!;
		const signatureSegment = segments[1]!;
		const payloadBytes = decodeBase64url(payloadSegment);
		const signature = decodeBase64url(signatureSegment);
		if (signature.byteLength !== 32) throw new WebCursorError("invalid");
		const expectedSignature = crypto
			.createHmac("sha256", key)
			.update(payloadSegment, "ascii")
			.digest();
		if (
			signature.byteLength !== expectedSignature.byteLength ||
			!crypto.timingSafeEqual(Buffer.from(signature), expectedSignature)
		) {
			throw new WebCursorError("invalid");
		}
		let payload: unknown;
		try {
			payload = JSON.parse(Buffer.from(payloadBytes).toString("utf8"));
		} catch {
			throw new WebCursorError("invalid");
		}
		const canonicalSegment = base64url(
			Buffer.from(stableStringify(payload), "utf8"),
		);
		if (canonicalSegment !== payloadSegment) {
			throw new WebCursorError("invalid");
		}
		return payload;
	}

	function assertTime(
		payload: { issuedAt: number; expiresAt: number },
		maxAgeMs: number,
	): void {
		const current = logicalNow();
		if (
			payload.expiresAt < payload.issuedAt ||
			payload.expiresAt - payload.issuedAt > maxAgeMs
		) {
			throw new WebCursorError("invalid");
		}
		if (payload.issuedAt > current) {
			throw new WebCursorError("invalid");
		}
		if (current >= payload.expiresAt) {
			throw new WebCursorError("expired");
		}
	}

	function assertListener(payload: { listenerId: string }): void {
		if (payload.listenerId !== options.listenerId) {
			throw new WebCursorError("expired");
		}
	}

	return {
		encodePage(input) {
			const current = logicalNow();
			const payload = compactPageInput(input);
			if (
				!Value.Check(WebPageCursorPayloadSchema, payload) ||
				payload.listenerId !== options.listenerId ||
				payload.issuedAt > current ||
				payload.expiresAt < payload.issuedAt ||
				payload.expiresAt - payload.issuedAt > PAGE_CURSOR_MAX_AGE_MS
			) {
				throw new TypeError("invalid P17 page cursor payload");
			}
			return sign(payload);
		},

		encodeStream(input) {
			const current = logicalNow();
			const payload = compactStreamInput(input);
			if (
				!Value.Check(WebStreamCursorPayloadSchema, payload) ||
				payload.listenerId !== options.listenerId ||
				payload.issuedAt > current ||
				payload.expiresAt < payload.issuedAt ||
				payload.expiresAt - payload.issuedAt > STREAM_CURSOR_MAX_AGE_MS
			) {
				throw new TypeError("invalid P17 stream cursor payload");
			}
			return sign(payload);
		},

		decodePage(cursor, expected) {
			const payload = verify(cursor);
			if (!Value.Check(WebPageCursorPayloadSchema, payload)) {
				throw new WebCursorError("invalid");
			}
			const page = payload as WebPageCursorPayload;
			assertListener(page);
			assertTime(page, PAGE_CURSOR_MAX_AGE_MS);
			const binding = {
				collection: page.collection,
				listenerId: page.listenerId,
				principalHash: page.principalHash,
				queryHash: page.queryHash,
				sortKey: page.sortKey,
				sortDirection: page.sortDirection,
				registryMode: page.registryMode,
				registryRevision: page.registryRevision,
				registryContextHash:
					page.registryContextHash,
				visibleMountsHash: page.visibleMountsHash,
				projectWatermarksHash:
					page.projectWatermarksHash,
				resourceVersion: page.resourceVersion,
			};
			const expectedBinding = {
				collection: expected.collection,
				listenerId: expected.listenerId,
				principalHash: expected.principalHash,
				queryHash: expected.queryHash,
				sortKey: expected.sortKey,
				sortDirection: expected.sortDirection,
				...compactRegistry(expected),
				projectWatermarksHash: digestCanonical(
					expected.projectWatermarks,
				),
				resourceVersion: expected.resourceVersion,
			};
			if (!sameBinding(binding, expectedBinding)) {
				throw new WebCursorError("expired");
			}
			return page;
		},

		decodeStream(cursor, expected) {
			const payload = verify(cursor);
			if (!Value.Check(WebStreamCursorPayloadSchema, payload)) {
				throw new WebCursorError("invalid");
			}
			const stream = payload as WebStreamCursorPayload;
			assertListener(stream);
			assertTime(stream, STREAM_CURSOR_MAX_AGE_MS);
			const binding = {
				listenerId: stream.listenerId,
				principalHash: stream.principalHash,
				registryMode: stream.registryMode,
				registryRevision:
					stream.registryRevision,
				registryContextHash:
					stream.registryContextHash,
				visibleMountsHash: stream.visibleMountsHash,
				projectIdentityHash:
					stream.projectIdentityHash,
			};
			const expectedBinding = {
				listenerId: expected.listenerId,
				principalHash: expected.principalHash,
				...compactRegistry(expected),
				projectIdentityHash: digestCanonical(
					projectIdentityMaterial(
						expected.projectWatermarks,
					),
				),
			};
			if (
				!sameBinding(binding, expectedBinding) ||
				stream.projectPositions.length !==
					expected.projectWatermarks.length
			) {
				throw new WebCursorError("expired");
			}
			return {
				...stream,
				projectWatermarks:
					expected.projectWatermarks.map(
						(watermark, index) => ({
							...watermark,
							nextCommitSeq:
								stream.projectPositions[index]!,
						}),
					),
			};
		},
	};
}
