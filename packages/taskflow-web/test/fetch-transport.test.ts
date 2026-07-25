import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type {
	WebClientTransportRequest,
} from "taskflow-control/web-protocol";
import { Type } from "typebox";
import { createFetchWebTransport } from "../src/api/fetch-transport.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function request(
	endpointId: WebClientTransportRequest["endpointId"],
): WebClientTransportRequest {
	return {
		endpointId,
		method: endpointId === "sessionExchange" ? "POST" : "GET",
		path:
			endpointId === "sessionExchange"
				? "/api/v1/session/exchange"
				: "/api/v1/bootstrap",
		body:
			endpointId === "sessionExchange"
				? { launchToken: "expired" }
				: {},
		responseKind: "json",
		successResponseSchema: Type.Unknown(),
		responseBudgetBytes: 64 * 1024,
	};
}

function unauthorizedResponse(): Response {
	return new Response(
		JSON.stringify({
			ok: false,
			requestId: "request-unauthorized",
			schemaVersion: "1.0",
			error: {
				code: "TF_POLICY_DENIED",
				message: "Browser session is unavailable.",
				recoveryAction: "none",
				sideEffects: "none",
			},
		}),
		{
			status: 401,
			headers: {
				"Content-Type": "application/json",
			},
		},
	);
}

test("fetch transport: authenticated 401 terminates the current browser session", async () => {
	globalThis.fetch = async () => unauthorizedResponse();
	const observations: Array<{
		endpointId: string;
		path: string;
	}> = [];
	const transport = createFetchWebTransport(
		() => undefined,
		undefined,
		(observation) => {
			observations.push(observation);
		},
	);

	await transport.request(request("bootstrap"));
	assert.deepEqual(observations, [
		{
			endpointId: "bootstrap",
			path: "/api/v1/bootstrap",
		},
	]);
});

test("fetch transport: failed launch exchange remains a boot error, not a terminated session", async () => {
	globalThis.fetch = async () => unauthorizedResponse();
	let unauthorized = false;
	const transport = createFetchWebTransport(
		() => undefined,
		undefined,
		() => {
			unauthorized = true;
		},
	);

	await transport.request(request("sessionExchange"));
	assert.equal(unauthorized, false);
});

test("fetch transport: response keeps the authority generation captured before fetch", async () => {
	let resolveFetch: ((response: Response) => void) | undefined;
	globalThis.fetch = () =>
		new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		});
	let generation = 4;
	const observed: number[] = [];
	const transport = createFetchWebTransport(
		() => undefined,
		(observation) => observed.push(observation.authorityGeneration),
		undefined,
		() => generation,
	);
	const pending = transport.request(request("bootstrap"));
	generation = 5;
	resolveFetch?.(
		new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
	);
	await pending;
	assert.deepEqual(observed, [4]);
});

test("fetch transport: sensitive artifact acknowledgement and redaction metadata stay explicit", async () => {
	let observedHeaders: Headers | undefined;
	globalThis.fetch = async (_input, init) => {
		observedHeaders = new Headers(init?.headers);
		return new Response(new Uint8Array([1, 2, 3]), {
			status: 200,
			headers: {
				"Content-Length": "3",
				"Content-Type": "application/octet-stream",
				ETag: `"sha256:${"a".repeat(64)}"`,
				"Content-Disposition":
					'attachment; filename="sensitive.bin"',
				"X-Taskflow-Redaction-Class": "sensitive",
			},
		});
	};
	const transport = createFetchWebTransport(() => undefined);
	const result = (await transport.request({
		endpointId: "artifact",
		method: "GET",
		path: `/api/v1/projects/project/domains/domain/artifacts/sha256:${"a".repeat(64)}`,
		body: {},
		responseKind: "bytes",
		successResponseSchema: Type.Unknown(),
		responseBudgetBytes: 100 * 1024 * 1024,
		sensitiveArtifactAcknowledgement: "download",
	})) as {
		metadata: { redactionClass: string; digest: string };
		body: Uint8Array;
	};
	assert.equal(
		observedHeaders?.get("x-taskflow-sensitive-ack"),
		"download",
	);
	assert.equal(result.metadata.redactionClass, "sensitive");
	assert.equal(result.metadata.digest, `sha256:${"a".repeat(64)}`);
	assert.deepEqual([...result.body], [1, 2, 3]);
});

test("fetch transport: artifact redaction metadata is exact and fail-closed", async () => {
	const artifactRequest: WebClientTransportRequest = {
		endpointId: "artifact",
		method: "GET",
		path: `/api/v1/projects/project/domains/domain/artifacts/sha256:${"b".repeat(64)}`,
		body: {},
		responseKind: "bytes",
		successResponseSchema: Type.Unknown(),
		responseBudgetBytes: 100 * 1024 * 1024,
	};
	globalThis.fetch = async () =>
		new Response(new Uint8Array([7]), {
			status: 200,
			headers: {
				"Content-Length": "1",
				"Content-Type": "application/octet-stream",
				ETag: `"sha256:${"b".repeat(64)}"`,
				"Content-Disposition":
					'attachment; filename="public.bin"',
				"X-Taskflow-Redaction-Class": "public",
			},
		});
	const transport = createFetchWebTransport(() => undefined);
	const publicResult = (await transport.request(artifactRequest)) as {
		metadata: { redactionClass: string };
	};
	assert.equal(publicResult.metadata.redactionClass, "public");

	globalThis.fetch = async () =>
		new Response(new Uint8Array([7]), {
			status: 200,
			headers: {
				"Content-Length": "1",
				"Content-Type": "application/octet-stream",
				ETag: `"sha256:${"b".repeat(64)}"`,
				"Content-Disposition":
					'attachment; filename="unknown.bin"',
				"X-Taskflow-Redaction-Class": "unknown",
			},
		});
	await assert.rejects(
		transport.request(artifactRequest),
		/invalid artifact metadata/u,
	);

	globalThis.fetch = async () =>
		new Response(new Uint8Array([7]), {
			status: 200,
			headers: {
				"Content-Length": "2",
				"Content-Type": "application/octet-stream",
				ETag: `"sha256:${"b".repeat(64)}"`,
				"Content-Disposition":
					'attachment; filename="short.bin"',
				"X-Taskflow-Redaction-Class": "project",
			},
		});
	await assert.rejects(
		transport.request(artifactRequest),
		/ended before its declared length/u,
	);
});
