import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { stableStringify } from "../src/hash.ts";
import {
	WebCursorError,
	createWebCursorCodec,
	type WebPageCursorInput,
	type WebStreamCursorInput,
} from "../src/web-cursor.ts";
import {
	WebPageCursorPayloadSchema,
	type WebPageCursorPayload,
} from "../src/web-protocol.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
	fs.readFileSync(
		path.join(testDir, "fixtures/web-v1/cursor-known-answer.json"),
		"utf8",
	),
) as {
	keyHex: string;
	now: number;
	binding: {
		registryContext: WebPageCursorInput["registryContext"];
		visibleMountsHash: string;
		projectWatermarks: WebPageCursorInput["projectWatermarks"];
	};
	payload: WebPageCursorPayload;
	canonicalPayloadJson: string;
	payloadSegment: string;
	macInputHex: string;
	signatureHex: string;
	signatureSegment: string;
	cursor: string;
};

function pageBinding(
	payload: WebPageCursorPayload,
	binding = vector.binding,
) {
	return {
		collection: payload.collection,
		listenerId: payload.listenerId,
		principalHash: payload.principalHash,
		queryHash: payload.queryHash,
		sortKey: payload.sortKey,
		sortDirection: payload.sortDirection,
		registryContext: binding.registryContext,
		visibleMountsHash: binding.visibleMountsHash,
		projectWatermarks: binding.projectWatermarks,
		resourceVersion: payload.resourceVersion,
	};
}

function assertCursorCode(
	action: () => unknown,
	code: "TF_INVALID_ARGUMENT" | "TF_CURSOR_EXPIRED",
): void {
	assert.throws(
		action,
		(error: unknown) =>
			error instanceof WebCursorError && error.controlError.code === code,
	);
}

test("P17 committed cursor vector freezes canonical JSON, MAC bytes, and cursor", () => {
	assert.equal(Value.Check(WebPageCursorPayloadSchema, vector.payload), true);
	const canonical = stableStringify(vector.payload);
	assert.equal(canonical, vector.canonicalPayloadJson);
	const payloadSegment = Buffer.from(canonical, "utf8").toString("base64url");
	assert.equal(payloadSegment, vector.payloadSegment);
	assert.equal(
		Buffer.from(payloadSegment, "ascii").toString("hex"),
		vector.macInputHex,
	);
	const signature = crypto
		.createHmac("sha256", Buffer.from(vector.keyHex, "hex"))
		.update(payloadSegment, "ascii")
		.digest();
	assert.equal(signature.toString("hex"), vector.signatureHex);
	assert.equal(signature.toString("base64url"), vector.signatureSegment);
	const codec = createWebCursorCodec({
		key: Buffer.from(vector.keyHex, "hex"),
		listenerId: vector.payload.listenerId,
		now: () => vector.now,
	});
	assert.equal(
		codec.encodePage({
			...vector.payload,
			...vector.binding,
		}),
		vector.cursor,
	);
	assert.deepEqual(
		codec.decodePage(vector.cursor, pageBinding(vector.payload)),
		vector.payload,
	);
});

test("cursor tampering and cross-kind use are invalid; authentic stale binding expires", () => {
	const codec = createWebCursorCodec({
		key: Buffer.from(vector.keyHex, "hex"),
		listenerId: vector.payload.listenerId,
		now: () => vector.now,
	});
	const changedLast =
		vector.cursor.slice(0, -1) + (vector.cursor.endsWith("A") ? "B" : "A");
	assertCursorCode(
		() => codec.decodePage(changedLast, pageBinding(vector.payload)),
		"TF_INVALID_ARGUMENT",
	);
	assertCursorCode(
		() =>
			codec.decodePage(vector.cursor, {
				...pageBinding(vector.payload),
				queryHash: `sha256:${"d".repeat(64)}`,
			}),
		"TF_CURSOR_EXPIRED",
	);
	assertCursorCode(
		() =>
			codec.decodeStream(vector.cursor, {
				listenerId: vector.payload.listenerId,
				principalHash: vector.payload.principalHash,
				...vector.binding,
			}),
		"TF_INVALID_ARGUMENT",
	);
});

test("page cursor expires on every authentic authorization or snapshot binding change", () => {
	const codec = createWebCursorCodec({
		key: Buffer.from(vector.keyHex, "hex"),
		listenerId: vector.payload.listenerId,
		now: () => vector.now,
	});
	const binding = pageBinding(vector.payload);
	const staleBindings = [
		{
			...binding,
			principalHash: `sha256:${"d".repeat(64)}`,
		},
		{
			...binding,
			collection: "attention" as const,
		},
		{
			...binding,
			visibleMountsHash: `sha256:${"d".repeat(64)}`,
		},
		{
			...binding,
			registryContext: {
				mode: "auto" as const,
				registryRevision: "registry-2",
				visibleMounts:
					binding.registryContext.visibleMounts,
			},
		},
		{
			...binding,
			projectWatermarks: binding.projectWatermarks.map((watermark) => ({
				...watermark,
				minAvailableCommitSeq: watermark.minAvailableCommitSeq + 1,
			})),
		},
	];
	for (const stale of staleBindings) {
		assertCursorCode(
			() => codec.decodePage(vector.cursor, stale),
			"TF_CURSOR_EXPIRED",
		);
	}
});

test("cursor rejects oversize, non-canonical, excessive-TTL, and future-issued inputs", () => {
	const codec = createWebCursorCodec({
		key: Buffer.from(vector.keyHex, "hex"),
		listenerId: vector.payload.listenerId,
		now: () => vector.now,
	});
	assertCursorCode(
		() => codec.decodePage("a".repeat(8_193), pageBinding(vector.payload)),
		"TF_INVALID_ARGUMENT",
	);
	assertCursorCode(
		() =>
			codec.decodePage(
				`${vector.payloadSegment}=.${vector.signatureSegment}`,
				pageBinding(vector.payload),
			),
		"TF_INVALID_ARGUMENT",
	);
	assert.throws(
		() =>
			codec.encodePage({
				...vector.payload,
				...vector.binding,
				expiresAt: vector.payload.issuedAt + 10 * 60_000 + 1,
			}),
		/invalid P17 page cursor payload/u,
	);
	assert.throws(
		() =>
			codec.encodePage({
				...vector.payload,
				...vector.binding,
				issuedAt: vector.now + 1,
				expiresAt: vector.now + 2,
			}),
		/invalid P17 page cursor payload/u,
	);
});

test("cursor clock floor prevents wall-clock rollback from reviving an expired cursor", () => {
	let now = 1_000;
	const hash = `sha256:${"a".repeat(64)}`;
	const stream: WebStreamCursorInput = {
		version: 1,
		kind: "stream",
		listenerId: "listener-1",
		principalHash: hash,
		registryContext: {
			mode: "standalone",
			registryRevision: "standalone",
			visibleMounts: [
				{ projectId: "project-1", controlDomainId: "domain-1" },
			],
		},
		visibleMountsHash: hash,
		projectWatermarks: [
			{
				projectId: "project-1",
				controlDomainId: "domain-1",
				nextCommitSeq: 2,
				minAvailableCommitSeq: 1,
			},
		],
		issuedAt: 1_000,
		expiresAt: 1_100,
	};
	const codec = createWebCursorCodec({
		key: Buffer.alloc(32, 7),
		listenerId: stream.listenerId,
		now: () => now,
	});
	const cursor = codec.encodeStream(stream);
	const binding = {
		listenerId: stream.listenerId,
		principalHash: stream.principalHash,
		registryContext: stream.registryContext,
		visibleMountsHash: stream.visibleMountsHash,
		projectWatermarks: stream.projectWatermarks,
	};
	now = 1_101;
	assert.throws(
		() => codec.decodeStream(cursor, binding),
		(error: unknown) =>
			error instanceof WebCursorError &&
			error.controlError.code === "TF_CURSOR_EXPIRED",
	);
	now = 900;
	assert.throws(
		() => codec.decodeStream(cursor, binding),
		(error: unknown) =>
			error instanceof WebCursorError &&
			error.controlError.code === "TF_CURSOR_EXPIRED",
	);
});

test("page and stream cursors remain resumable below 8 KiB for 200 visible projects", () => {
	const now = 1_000;
	const visibleMounts = Array.from(
		{ length: 200 },
		(_, index) => ({
			projectId: `project-${String(index).padStart(3, "0")}`,
			controlDomainId: `domain-${String(index).padStart(3, "0")}`,
		}),
	);
	const registryContext = {
		mode: "auto" as const,
		registryRevision: "registry-200",
		visibleMounts,
	};
	const projectWatermarks = visibleMounts.map(
		(mount, index) => ({
			...mount,
			nextCommitSeq: index + 10,
			minAvailableCommitSeq: index,
		}),
	);
	const visibleMountsHash = `sha256:${crypto
		.createHash("sha256")
		.update(stableStringify(visibleMounts), "utf8")
		.digest("hex")}`;
	const binding = {
		registryContext,
		visibleMountsHash,
		projectWatermarks,
	};
	const codec = createWebCursorCodec({
		key: Buffer.alloc(32, 8),
		listenerId: "listener-200",
		now: () => now,
	});
	const pageCursor = codec.encodePage({
		version: 1,
		kind: "page",
		collection: "runs",
		listenerId: "listener-200",
		principalHash: `sha256:${"a".repeat(64)}`,
		queryHash: `sha256:${"b".repeat(64)}`,
		sortKey: "updatedAt",
		sortDirection: "desc",
		...binding,
		after: {
			sortValue: now,
			projectId: "project-199",
			controlDomainId: "domain-199",
			runId: "run-199",
		},
		issuedAt: now,
		expiresAt: now + 60_000,
	});
	assert.ok(Buffer.byteLength(pageCursor, "utf8") < 8_192);
	const decodedPage = codec.decodePage(pageCursor, {
			collection: "runs",
			listenerId: "listener-200",
			principalHash: `sha256:${"a".repeat(64)}`,
			queryHash: `sha256:${"b".repeat(64)}`,
			sortKey: "updatedAt",
			sortDirection: "desc",
			...binding,
		});
	assert.equal(decodedPage.collection, "runs");
	if (decodedPage.collection !== "runs") {
		assert.fail("run page cursor decoded as the wrong collection");
	}
	assert.equal(decodedPage.after?.runId, "run-199");

	const streamCursor = codec.encodeStream({
		version: 1,
		kind: "stream",
		listenerId: "listener-200",
		principalHash: `sha256:${"a".repeat(64)}`,
		...binding,
		issuedAt: now,
		expiresAt: now + 60_000,
	});
	assert.ok(Buffer.byteLength(streamCursor, "utf8") < 8_192);
	const currentWatermarks = projectWatermarks.map(
		(watermark) => ({
			...watermark,
			nextCommitSeq: watermark.nextCommitSeq + 100,
		}),
	);
	const decoded = codec.decodeStream(streamCursor, {
		listenerId: "listener-200",
		principalHash: `sha256:${"a".repeat(64)}`,
		registryContext,
		visibleMountsHash,
		projectWatermarks: currentWatermarks,
	});
	assert.equal(decoded.projectWatermarks.length, 200);
	assert.equal(
		decoded.projectWatermarks[199]?.nextCommitSeq,
		projectWatermarks[199]?.nextCommitSeq,
	);
});

test("page cursor union closes each collection over its own keyset", () => {
	const base = {
		version: 1,
		kind: "page",
		listenerId: "listener-1",
		principalHash: `sha256:${"a".repeat(64)}`,
		queryHash: `sha256:${"b".repeat(64)}`,
		registryMode: "standalone",
		registryRevision: "standalone",
		registryContextHash: `sha256:${"c".repeat(64)}`,
		visibleMountsHash: `sha256:${"c".repeat(64)}`,
		projectWatermarksHash: `sha256:${"c".repeat(64)}`,
		issuedAt: 1_000,
		expiresAt: 1_100,
	};
	const variants = [
		{
			...base,
			collection: "projects",
			sortKey: "project-id",
			sortDirection: "asc",
			after: { projectId: "project-1", controlDomainId: "domain-1" },
		},
		{
			...base,
			collection: "runs",
			sortKey: "updatedAt",
			sortDirection: "desc",
			after: {
				sortValue: 1,
				projectId: "project-1",
				controlDomainId: "domain-1",
				runId: "run-1",
			},
		},
		{
			...base,
			collection: "fragments",
			sortKey: "created-commit",
			sortDirection: "asc",
			after: {
				createdAtCommitSeq: 1,
				boundFragmentHash: `bf:${"d".repeat(64)}`,
			},
		},
		{
			...base,
			collection: "graph",
			sortKey: "node-instance-id",
			sortDirection: "asc",
			after: { nodeInstanceId: "node-1" },
		},
		{
			...base,
			collection: "timeline",
			sortKey: "commit-seq",
			sortDirection: "asc",
			after: { commitSeq: 1, eventId: "event-1" },
		},
		{
			...base,
			collection: "attempts",
			sortKey: "attempt-ordinal",
			sortDirection: "asc",
			after: { attemptOrdinal: 1, attemptId: "attempt-1" },
		},
		{
			...base,
			collection: "artifacts",
			sortKey: "role-digest-artifact",
			sortDirection: "asc",
			after: {
				role: "result",
				digest: `sha256:${"d".repeat(64)}`,
				artifactId: "artifact-1",
			},
		},
		{
			...base,
			collection: "receipt-manifest",
			sortKey: "commit-seq",
			sortDirection: "asc",
			after: { commitSeq: 1, eventId: "event-1" },
		},
		{
			...base,
			collection: "approvals",
			sortKey: "created-at",
			sortDirection: "desc",
			after: {
				createdAt: 1,
				projectId: "project-1",
				controlDomainId: "domain-1",
				runId: "run-1",
				approvalRequestId: "approval-1",
			},
		},
		{
			...base,
			collection: "attention",
			sortKey: "observed-at",
			sortDirection: "desc",
			after: { observedAt: 1, attentionId: "attention-1" },
		},
	];
	for (const variant of variants) {
		assert.equal(
			Value.Check(WebPageCursorPayloadSchema, variant),
			true,
			variant.collection,
		);
	}
	assert.equal(
		Value.Check(WebPageCursorPayloadSchema, {
			...variants[0],
			after: { nodeInstanceId: "node-1" },
		}),
		false,
	);
});
