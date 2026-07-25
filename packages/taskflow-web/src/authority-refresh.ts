import type {
	WebAuthoritativeResourceIdentity,
	WebAuthorityRefreshStamp,
} from "taskflow-control/web-presentation-schema";
import type { WebJsonResponseObservation } from "./api/fetch-transport.ts";

export type WebAuthorityRefreshRegistry = {
	generation: number;
	responses: WeakMap<
		object,
		{
			readonly generation: number;
			readonly stamp: WebAuthorityRefreshStamp;
		}
	>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(
	value: Record<string, unknown>,
	key: string,
): string | undefined {
	return typeof value[key] === "string" ? value[key] : undefined;
}

function resourceKey(resource: WebAuthoritativeResourceIdentity): string {
	switch (resource.type) {
		case "project":
			return `project\u0000${resource.projectId}\u0000${resource.controlDomainId}`;
		case "run":
			return `run\u0000${resource.projectId}\u0000${resource.controlDomainId}\u0000${resource.runId}`;
		case "approval":
			return `approval\u0000${resource.projectId}\u0000${resource.controlDomainId}\u0000${resource.runId}\u0000${resource.approvalRequestId}`;
		case "reservation":
			return `reservation\u0000${resource.reservationId}`;
	}
}

function responseRefreshStamp(
	observation: WebJsonResponseObservation,
	invalidationEpoch: number,
):
	| {
			readonly response: object;
			readonly stamp: WebAuthorityRefreshStamp;
	  }
	| undefined {
	if (!isRecord(observation.envelope) || observation.envelope.ok !== true) {
		return undefined;
	}
	const requestId = stringField(observation.envelope, "requestId");
	const data = observation.envelope.data;
	if (!requestId || !isRecord(data)) return undefined;
	const sourceObservation = data.sourceObservation;
	if (
		!isRecord(sourceObservation) ||
		sourceObservation.authority !== "verified" ||
		typeof sourceObservation.observedAt !== "number"
	) {
		return undefined;
	}

	let resource: WebAuthoritativeResourceIdentity | undefined;
	if (observation.endpointId === "projectDetail") {
		const projectId = stringField(data, "projectId");
		const controlDomainId = stringField(data, "controlDomainId");
		if (projectId && controlDomainId) {
			resource = { type: "project", projectId, controlDomainId };
		}
	} else if (observation.endpointId === "runDetail" && isRecord(data.run)) {
		const projectId = stringField(data.run, "projectId");
		const controlDomainId = stringField(data.run, "controlDomainId");
		const runId = stringField(data.run, "runId");
		if (projectId && controlDomainId && runId) {
			resource = { type: "run", projectId, controlDomainId, runId };
		}
	} else if (
		observation.endpointId === "approvalDetail" &&
		isRecord(data.summary)
	) {
		const projectId = stringField(data.summary, "projectId");
		const controlDomainId = stringField(data.summary, "controlDomainId");
		const runId = stringField(data.summary, "runId");
		const approvalRequestId = stringField(data.summary, "approvalRequestId");
		if (projectId && controlDomainId && runId && approvalRequestId) {
			resource = {
				type: "approval",
				projectId,
				controlDomainId,
				runId,
				approvalRequestId,
			};
		}
	} else if (observation.endpointId === "reservationDetail") {
		const reservationId = stringField(data, "reservationId");
		if (reservationId) resource = { type: "reservation", reservationId };
	}
	if (!resource) return undefined;
	return {
		response: data,
		stamp: {
			resource,
			invalidationEpoch,
			requestId,
			observedAt: sourceObservation.observedAt,
		},
	};
}

export function createWebAuthorityRefreshRegistry(): WebAuthorityRefreshRegistry {
	return {
		generation: 0,
		responses: new WeakMap(),
	};
}

export function invalidateWebAuthorityRefresh(
	registry: WebAuthorityRefreshRegistry,
): void {
	registry.generation += 1;
	registry.responses = new WeakMap();
}

export function acceptWebAuthorityRefresh(
	registry: WebAuthorityRefreshRegistry,
	observation: WebJsonResponseObservation,
	invalidationEpoch: number,
): boolean {
	const refreshed = responseRefreshStamp(observation, invalidationEpoch);
	if (
		!refreshed ||
		observation.authorityGeneration !== registry.generation
	) {
		return false;
	}
	registry.responses.set(refreshed.response, {
		generation: observation.authorityGeneration,
		stamp: refreshed.stamp,
	});
	return true;
}

export function webAuthorityRefreshStampFor(
	registry: WebAuthorityRefreshRegistry,
	resource: WebAuthoritativeResourceIdentity,
	response: object,
): WebAuthorityRefreshStamp | undefined {
	const refreshed = registry.responses.get(response);
	if (
		!refreshed ||
		refreshed.generation !== registry.generation ||
		resourceKey(refreshed.stamp.resource) !== resourceKey(resource)
	) {
		return undefined;
	}
	return refreshed.stamp;
}
