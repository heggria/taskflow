/** P17 v5 executable endpoint, projection, and reference-fixture evidence. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import {
	WEB_ENDPOINTS,
	WebClientFailureError,
	compileWebEndpointPath,
	createWebClient,
	encodeWebQuery,
	generateWebHandlerRoutes,
	type WebClientTransportRequest,
	type WebEndpointId,
	type WebHandlerMap,
} from "../src/web-protocol.ts";
import {
	WebFailurePresentationInputSchema,
	WebFailurePresentationSchema,
	WebObservationPresentationInputSchema,
	WebObservationPresentationSchema,
	WebTaskPresentationSchema,
	WebTaskPresentationConsumerSchema,
	WebTaskProjectionInputSchema,
	WebVerificationProjectionInputSchema,
	type WebLiveState,
	type WebSourceObservation,
} from "../src/web-presentation-schema.ts";
import {
	projectTaskPresentation,
	projectVerificationPresentation,
} from "../src/web-presentation-server.ts";
import {
	projectControlErrorPresentation,
	projectObservationPresentation,
	reduceWebLiveState,
} from "../src/web-presentation-client.ts";
import {
	buildBoundedWebPage,
	strictlyAfterKeyset,
	webJsonByteLength,
} from "../src/web-pagination.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../..");
const fixtureRoot = path.join(testDir, "fixtures/web-v1/reference");
const manifestPath = path.join(
	repoRoot,
	"docs/internal/webui/reference-set-v1/manifest.json",
);

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
		.join(",")}}`;
}

function sha256(value: string): string {
	return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

test("P17 WEB_ENDPOINTS is the exact 29-row executable inventory", () => {
	const entries = Object.entries(WEB_ENDPOINTS);
	assert.equal(entries.length, 29);
	assert.equal(new Set(entries.map(([, endpoint]) => endpoint.path)).size, 29);
	for (const [id, endpoint] of entries) {
		assert.ok(endpoint.method === "GET" || endpoint.method === "POST", id);
		assert.ok(endpoint.path.startsWith("/api/v1/"), id);
		assert.ok(endpoint.routeTokens.length >= 3, id);
		assert.ok(endpoint.responseBudgetBytes > 0, id);
		assert.equal(typeof endpoint.requestSchemaName, "string", id);
		assert.equal(typeof endpoint.successDataName, "string", id);
		assert.ok(Value.Check(endpoint.paramsSchema, {} ) || endpoint.routeTokens.some((token) => token.kind === "safe-id"));
	}
});

test("generated client compiles typed routes and canonical query without route copies", async () => {
	const requests: WebClientTransportRequest[] = [];
	const client = createWebClient({
		async request(request) {
			requests.push(request);
			return { ok: true };
		},
	});
	await assert.rejects(
		client.runGraph({
			params: {
				projectId: "project-1",
				controlDomainId: "domain-1",
				runId: "run-1",
			},
			query: {
				expectedRunVersion: 3,
				limit: 500,
				statuses: ["running", "failed"],
			},
			body: {},
		}),
		/did not match its P17 consumer codec/u,
	);
	assert.equal(
		requests[0]?.path,
		"/api/v1/projects/project-1/domains/domain-1/runs/run-1/graph?expectedRunVersion=3&limit=500&statuses=running&statuses=failed",
	);
	assert.throws(
		() =>
			compileWebEndpointPath("runDetail", {
				projectId: "../escape",
				controlDomainId: "domain-1",
				runId: "run-1",
			}),
		/unsafe route parameter/u,
	);
	assert.equal(
		compileWebEndpointPath("artifact", {
			projectId: "project-1",
			controlDomainId: "domain-1",
			digest: `sha256:${"a".repeat(64)}`,
		}),
		`/api/v1/projects/project-1/domains/domain-1/artifacts/sha256%3A${"a".repeat(64)}`,
	);
	assert.equal(
		encodeWebQuery({ scope: { kind: "run" }, limit: 50 }),
		"?limit=50&scope=%7B%22kind%22%3A%22run%22%7D",
	);
});

test("generated client validates byte metadata and body length", async () => {
	let body = new Uint8Array([1]);
	const client = createWebClient({
		async request(request) {
			assert.equal(
				Value.Check(request.successResponseSchema, {
					digest: `sha256:${"a".repeat(64)}`,
					size: 1,
					mediaType: "application/octet-stream",
					redactionClass: "project",
					contentDisposition: "attachment",
				}),
				true,
			);
			return {
				metadata: {
					digest: `sha256:${"a".repeat(64)}`,
					size: 1,
					mediaType: "application/octet-stream",
					redactionClass: "project",
					contentDisposition: "attachment",
				},
				body,
			};
		},
	});
	const valid = await client.artifact({
		params: {
			projectId: "project-1",
			controlDomainId: "domain-1",
			digest: `sha256:${"a".repeat(64)}`,
		},
		query: {},
		body: {},
	});
	assert.deepEqual([...valid.body], [1]);
	body = new Uint8Array();
	await assert.rejects(
		client.artifact({
			params: {
				projectId: "project-1",
				controlDomainId: "domain-1",
				digest: `sha256:${"a".repeat(64)}`,
			},
			query: {},
			body: {},
		}),
		/did not match its P17 byte codec/u,
	);
});

test("generated byte client preserves the typed P17 failure envelope", async () => {
	const failure = {
		ok: false as const,
		requestId: "request-artifact-denied",
		schemaVersion: "web.v1" as const,
		error: {
			code: "TF_AUTHORITY_REVOKED" as const,
			message: "Artifact access was revoked.",
			recoveryAction: "none" as const,
			sideEffects: "none" as const,
			projectId: "project-1",
			controlDomainId: "domain-1",
		},
	};
	const client = createWebClient({
		async request() {
			return failure;
		},
	});
	await assert.rejects(
		client.artifact({
			params: {
				projectId: "project-1",
				controlDomainId: "domain-1",
				digest: `sha256:${"a".repeat(64)}`,
			},
			query: {},
			body: {},
		}),
		(error: unknown) => {
			assert.ok(error instanceof WebClientFailureError);
			assert.deepEqual(error.failure, failure);
			return true;
		},
	);
});

test("generated client exposes the sensitive acknowledgement only on artifact", () => {
	const client = createWebClient({
		async request() {
			return {};
		},
	});
	if (false) {
		void client.artifact(
			{
				params: {
					projectId: "project-1",
					controlDomainId: "domain-1",
					digest: `sha256:${"a".repeat(64)}`,
				},
				query: {},
				body: {},
			},
			{ sensitiveArtifactAcknowledgement: "download" },
		);
		void client.bootstrap(
			{ params: {}, query: {}, body: {} },
			{
				// @ts-expect-error Sensitive acknowledgement is artifact-only.
				sensitiveArtifactAcknowledgement: "download",
			},
		);
	}
});

test("generated handler routes remain bijective with WEB_ENDPOINTS", () => {
	const handler = async () => ({});
	const handlers = Object.fromEntries(
		(Object.keys(WEB_ENDPOINTS) as WebEndpointId[]).map((id) => [id, handler]),
	) as unknown as WebHandlerMap;
	const routes = generateWebHandlerRoutes(handlers);
	assert.equal(routes.length, 29);
	assert.deepEqual(
		routes.map((route) => route.id),
		Object.keys(WEB_ENDPOINTS),
	);
	assert.equal(new Set(routes.map((route) => `${route.method} ${route.path}`)).size, 29);
});

test("pagination exact-boundary fixture returns N and resumes strictly after N", () => {
	const all = [
		{ id: 1, value: "one" },
		{ id: 2, value: "two" },
		{ id: 3, value: "three" },
	];
	const envelope = (
		items: readonly (typeof all)[number][],
		nextCursor: string | undefined,
	) => ({
		ok: true,
		requestId: "request-1",
		schemaVersion: "web.v1",
		data: {
			items,
			...(nextCursor ? { nextCursor } : {}),
			sourceObservation: "fixture",
		},
	});
	const exactBudget = webJsonByteLength(
		envelope(all.slice(0, 2), "after=2"),
	);
	const first = buildBoundedWebPage({
		orderedItems: all,
		limit: 3,
		maximumLimit: 200,
		responseBudgetBytes: exactBudget,
		keyOf: (item) => item.id,
		cursorAfter: (last) => `after=${last}`,
		envelope,
	});
	assert.equal(first.encodedBytes, exactBudget);
	assert.deepEqual(first.items.map((item) => item.id), [1, 2]);
	assert.equal(first.lastReturnedKey, 2);
	assert.equal(first.nextCursor, "after=2");

	const remaining = strictlyAfterKeyset(
		all,
		first.lastReturnedKey,
		(item) => item.id,
		(left, right) => left - right,
	);
	const second = buildBoundedWebPage({
		orderedItems: remaining,
		limit: 3,
		maximumLimit: 200,
		responseBudgetBytes: exactBudget,
		keyOf: (item) => item.id,
		cursorAfter: (last) => `after=${last}`,
		envelope,
	});
	assert.deepEqual(second.items.map((item) => item.id), [3]);
	assert.equal(second.nextCursor, undefined);
	assert.deepEqual(
		[...first.items, ...second.items].map((item) => item.id),
		[1, 2, 3],
	);
});

test("reference manifest binds all nine families and every fixture hash", () => {
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
		status: string;
		screens: Array<{
			screenId: string;
			fixtures: Array<{
				fixtureId: string;
				sourceSha256: string;
				projectionSha256: string;
				fixtureFileSha256: string;
			}>;
		}>;
	};
	assert.equal(manifest.status, "draft-unapproved");
	assert.equal(manifest.screens.length, 9);
	for (const screen of manifest.screens) {
		assert.ok(screen.fixtures.length > 0, screen.screenId);
		for (const binding of screen.fixtures) {
			const file = path.join(fixtureRoot, `${binding.fixtureId}.json`);
			const raw = fs.readFileSync(file, "utf8");
			const fixture = JSON.parse(raw) as {
				sourceKind: string;
				source: unknown;
				projection: unknown;
			};
			assert.equal(sha256(raw), binding.fixtureFileSha256);
			assert.equal(sha256(canonical(fixture.source)), binding.sourceSha256);
			assert.equal(
				sha256(canonical(fixture.projection)),
				binding.projectionSha256,
			);
		}
	}
});

test("server and browser projection goldens recompute byte-identically", () => {
	for (const name of fs.readdirSync(fixtureRoot).sort()) {
		const fixture = JSON.parse(
			fs.readFileSync(path.join(fixtureRoot, name), "utf8"),
		) as {
			sourceKind: string;
			source: unknown;
			projection: unknown;
		};
		let projection: unknown;
		if (fixture.sourceKind === "task-projection") {
			assert.equal(Value.Check(WebTaskProjectionInputSchema, fixture.source), true);
			projection = projectTaskPresentation(
				fixture.source as Parameters<typeof projectTaskPresentation>[0],
			);
			assert.equal(Value.Check(WebTaskPresentationSchema, projection), true);
		} else if (fixture.sourceKind === "observation-projection") {
			assert.equal(
				Value.Check(WebObservationPresentationInputSchema, fixture.source),
				true,
			);
			projection = projectObservationPresentation(
				fixture.source as Parameters<typeof projectObservationPresentation>[0],
			);
			assert.equal(
				Value.Check(WebObservationPresentationSchema, projection),
				true,
			);
		} else if (fixture.sourceKind === "failure-projection") {
			assert.equal(
				Value.Check(WebFailurePresentationInputSchema, fixture.source),
				true,
			);
			projection = projectControlErrorPresentation(
				fixture.source as Parameters<typeof projectControlErrorPresentation>[0],
			);
			assert.equal(Value.Check(WebFailurePresentationSchema, projection), true);
		} else {
			continue;
		}
		assert.equal(canonical(projection), canonical(fixture.projection), name);
	}
});

test("producer schemas stay closed while marked presentation consumers tolerate only top-level additions", () => {
	const fixture = JSON.parse(
		fs.readFileSync(path.join(fixtureRoot, "completed-verified.json"), "utf8"),
	) as { projection: Record<string, unknown> };
	const additive = { ...fixture.projection, futureTechnicalHint: "additive" };
	assert.equal(Value.Check(WebTaskPresentationSchema, additive), false);
	assert.equal(Value.Check(WebTaskPresentationConsumerSchema, additive), true);
	const headline = fixture.projection.headline as Record<string, unknown>;
	const illegalNested = {
		...fixture.projection,
		headline: { ...headline, futureAuthorityField: true },
	};
	assert.equal(
		Value.Check(WebTaskPresentationConsumerSchema, illegalNested),
		false,
	);
});

test("catch-up invalidates an old detail stamp once and resync cannot revive it", () => {
	const observation: WebSourceObservation = {
		coverage: "complete",
		authority: "verified",
		observedAt: 1,
		registryContext: {
			mode: "auto",
			registryRevision: "registry-1",
			visibleMounts: [
				{ projectId: "project-1", controlDomainId: "domain-1" },
			],
		},
		watermarks: [],
	};
	const resource = {
		type: "run",
		projectId: "project-1",
		controlDomainId: "domain-1",
		runId: "run-1",
	} as const;
	const stamp = {
		resource,
		invalidationEpoch: 3,
		requestId: "request-1",
		observedAt: 1,
	};
	let state: WebLiveState = {
		streamState: "connected",
		resyncState: "idle",
		invalidationEpoch: 3,
	};
	assert.equal(
		projectObservationPresentation({
			sourceObservation: observation,
			liveState: state,
			scope: { kind: "authoritative-detail", resource, refreshStamp: stamp },
		}).stateSensitiveActionsAllowed,
		true,
	);
	state = reduceWebLiveState(state, { type: "stream-catching-up" });
	assert.equal(state.invalidationEpoch, 4);
	state = reduceWebLiveState(state, { type: "stream-catching-up" });
	assert.equal(state.invalidationEpoch, 4);
	state = reduceWebLiveState(state, { type: "resync-started" });
	state = reduceWebLiveState(state, { type: "resync-succeeded" });
	assert.equal(
		projectObservationPresentation({
			sourceObservation: observation,
			liveState: state,
			scope: { kind: "authoritative-detail", resource, refreshStamp: stamp },
		}).stateSensitiveActionsAllowed,
		false,
	);
});

test("verification mismatch wins over in-progress", () => {
	const source = JSON.parse(
		fs.readFileSync(
			path.join(fixtureRoot, "completed-verified.json"),
			"utf8",
		),
	) as {
		source: { verification: Record<string, unknown> };
	};
	const input = {
		...source.source.verification,
		eventManifest: "in-progress",
		artifactIntegrity: "mismatch",
	};
	assert.equal(Value.Check(WebVerificationProjectionInputSchema, input), true);
	const projected = projectVerificationPresentation(
		input as Parameters<typeof projectVerificationPresentation>[0],
	);
	assert.equal(projected.state, "verification-failed");
	assert.equal(projected.reason, "artifact-digest-mismatch");
});

test("all browser-safe protocol/projection modules reject server runtime imports", () => {
	for (const file of [
		"web-protocol.ts",
		"web-presentation-schema.ts",
		"web-presentation-server.ts",
		"web-presentation-client.ts",
	]) {
		const source = fs.readFileSync(
			path.join(repoRoot, "packages/taskflow-control/src", file),
			"utf8",
		);
		assert.doesNotMatch(source, /from ["']node:/u, file);
		assert.doesNotMatch(
			source,
			/from ["'].+(?:store|provider|daemon|runtime|runner)/u,
			file,
		);
	}
	assert.doesNotMatch(
		fs.readFileSync(
			path.join(
				repoRoot,
				"packages/taskflow-control/src/web-presentation-client.ts",
			),
			"utf8",
		),
		/web-presentation-server/u,
	);
});
