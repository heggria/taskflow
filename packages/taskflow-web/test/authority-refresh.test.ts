import assert from "node:assert/strict";
import { test } from "node:test";
import {
	acceptWebAuthorityRefresh,
	createWebAuthorityRefreshRegistry,
	invalidateWebAuthorityRefresh,
	webAuthorityRefreshStampFor,
} from "../src/authority-refresh.ts";

const resource = {
	type: "run",
	projectId: "project-1",
	controlDomainId: "domain-1",
	runId: "run-1",
} as const;

function observation(
	authorityGeneration: number,
	requestId: string,
	observedAt: number,
) {
	return {
		endpointId: "runDetail",
		path: "/api/v1/projects/project-1/domains/domain-1/runs/run-1",
		authorityGeneration,
		envelope: {
			ok: true,
			requestId,
			schemaVersion: "web.v1",
			data: {
				run: {
					projectId: resource.projectId,
					controlDomainId: resource.controlDomainId,
					runId: resource.runId,
				},
				sourceObservation: {
					authority: "verified",
					observedAt,
				},
			},
		},
	} as const;
}

test("authority refresh: a response started before invalidation cannot stamp current detail", () => {
	const registry = createWebAuthorityRefreshRegistry();
	const stale = observation(registry.generation, "request-stale", 10);
	const staleData = stale.envelope.data;

	invalidateWebAuthorityRefresh(registry);

	assert.equal(acceptWebAuthorityRefresh(registry, stale, 1), false);
	assert.equal(
		webAuthorityRefreshStampFor(registry, resource, staleData),
		undefined,
	);
});

test("authority refresh: stamp is bound to the exact returned object and generation", () => {
	const registry = createWebAuthorityRefreshRegistry();
	const current = observation(registry.generation, "request-current", 20);
	assert.equal(acceptWebAuthorityRefresh(registry, current, 2), true);

	assert.deepEqual(
		webAuthorityRefreshStampFor(
			registry,
			resource,
			current.envelope.data,
		),
		{
			resource,
			invalidationEpoch: 2,
			requestId: "request-current",
			observedAt: 20,
		},
	);
	assert.equal(
		webAuthorityRefreshStampFor(registry, resource, {
			...current.envelope.data,
		}),
		undefined,
	);

	invalidateWebAuthorityRefresh(registry);
	assert.equal(
		webAuthorityRefreshStampFor(
			registry,
			resource,
			current.envelope.data,
		),
		undefined,
	);
});
