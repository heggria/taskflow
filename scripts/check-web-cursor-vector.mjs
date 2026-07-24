#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { stableStringify } from "../packages/taskflow-control/src/hash.ts";
import { WebPageCursorPayloadSchema } from "../packages/taskflow-control/src/web-protocol.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(
	root,
	"packages/taskflow-control/test/fixtures/web-v1/cursor-known-answer.json",
);
const write = process.argv.includes("--write");
const keyHex =
	"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const now = 1_800_000_000_000;
const registryContext = {
	mode: "standalone",
	registryRevision: "standalone",
	visibleMounts: [
		{ projectId: "project-1", controlDomainId: "domain-1" },
	],
};
const projectWatermarks = [
	{
		projectId: "project-1",
		controlDomainId: "domain-1",
		nextCommitSeq: 10,
		minAvailableCommitSeq: 1,
	},
];
function digest(value) {
	return `sha256:${crypto
		.createHash("sha256")
		.update(stableStringify(value), "utf8")
		.digest("hex")}`;
}
const binding = {
	registryContext,
	visibleMountsHash: digest(registryContext.visibleMounts),
	projectWatermarks,
};
const payload = {
	version: 1,
	kind: "page",
	collection: "runs",
	listenerId: "listener-vector-1",
	principalHash: `sha256:${"a".repeat(64)}`,
	queryHash: `sha256:${"b".repeat(64)}`,
	sortKey: "updatedAt",
	sortDirection: "desc",
	registryMode: registryContext.mode,
	registryRevision: registryContext.registryRevision,
	registryContextHash: digest(registryContext),
	visibleMountsHash: binding.visibleMountsHash,
	projectWatermarksHash: digest(projectWatermarks),
	after: {
		sortValue: now,
		projectId: "project-1",
		controlDomainId: "domain-1",
		runId: "run-1",
	},
	issuedAt: now,
	expiresAt: now + 10 * 60_000,
};

if (!Value.Check(WebPageCursorPayloadSchema, payload)) {
	throw new Error("cursor known-answer source payload does not match P17 schema");
}

const canonicalPayloadJson = stableStringify(payload);
const payloadSegment = Buffer.from(canonicalPayloadJson, "utf8").toString(
	"base64url",
);
const signature = crypto
	.createHmac("sha256", Buffer.from(keyHex, "hex"))
	.update(payloadSegment, "ascii")
	.digest();
const signatureSegment = signature.toString("base64url");
const fixture = {
	fixtureVersion: "p17-cursor-known-answer.v1",
	keyHex,
	now,
	binding,
	payload,
	canonicalPayloadJson,
	payloadSegment,
	macInputHex: Buffer.from(payloadSegment, "ascii").toString("hex"),
	signatureHex: signature.toString("hex"),
	signatureSegment,
	cursor: `${payloadSegment}.${signatureSegment}`,
};
const expected = `${JSON.stringify(fixture, null, 2)}\n`;

if (write) {
	fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
	fs.writeFileSync(fixturePath, expected);
	console.log(`wrote ${path.relative(root, fixturePath)}`);
	process.exit(0);
}

const actual = fs.readFileSync(fixturePath, "utf8");
if (actual !== expected) {
	throw new Error(
		"cursor known-answer fixture drifted; run pnpm generate:web-cursor-vector",
	);
}
console.log("web cursor known-answer fixture is current");
