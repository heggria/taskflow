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
