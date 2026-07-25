import {
	type WebArtifactMetadata,
	WebArtifactMetadataSchema,
	WebClientCodecError,
	type WebClientTransport,
	type WebClientTransportRequest,
} from "taskflow-control/web-protocol";
import { Value } from "typebox/value";

export type CsrfTokenReader = () => string | undefined;
export type WebJsonResponseObservation = {
	readonly endpointId: WebClientTransportRequest["endpointId"];
	readonly path: string;
	readonly envelope: unknown;
	readonly authorityGeneration: number;
};
export type WebJsonResponseObserver = (
	observation: WebJsonResponseObservation,
) => void;
export type WebUnauthorizedObserver = (
	observation: Pick<
		WebJsonResponseObservation,
		"endpointId" | "path"
	>,
) => void;

async function readBounded(
	response: Response,
	maxBytes: number,
): Promise<Uint8Array> {
	const declared = response.headers.get("content-length");
	let declaredLength: number | undefined;
	if (declared !== null) {
		if (!/^(0|[1-9][0-9]*)$/u.test(declared)) {
			throw new WebClientCodecError(
				"Taskflow returned an invalid content length",
			);
		}
		declaredLength = Number(declared);
		if (
			!Number.isSafeInteger(declaredLength) ||
			declaredLength > maxBytes
		) {
			throw new WebClientCodecError(
				"Taskflow response exceeded its byte budget",
			);
		}
	}
	const reader = response.body?.getReader();
	if (!reader) {
		if (declaredLength && declaredLength > 0) {
			throw new WebClientCodecError(
				"Taskflow response ended before its declared length",
			);
		}
		return new Uint8Array();
	}
	const chunks: Uint8Array[] = [];
	const declaredResult =
		declaredLength === undefined
			? undefined
			: new Uint8Array(declaredLength);
	let length = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		length += value.byteLength;
		if (
			length > maxBytes ||
			(declaredResult !== undefined &&
				length > declaredResult.byteLength)
		) {
			await reader.cancel();
			throw new WebClientCodecError(
				"Taskflow response exceeded its byte budget",
			);
		}
		if (declaredResult) {
			declaredResult.set(
				value,
				length - value.byteLength,
			);
		} else {
			chunks.push(value);
		}
	}
	if (declaredResult) {
		if (length !== declaredResult.byteLength) {
			throw new WebClientCodecError(
				"Taskflow response ended before its declared length",
			);
		}
		return declaredResult;
	}
	const result = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

function artifactMetadata(response: Response): WebArtifactMetadata {
	const size = Number(response.headers.get("content-length") ?? "0");
	const digest =
		response.headers.get("etag")?.replace(/^"|"$/gu, "") ?? "sha256:unknown";
	const contentDisposition =
		response.headers.get("content-disposition") ?? "";
	const disposition = contentDisposition
		.toLowerCase()
		.startsWith("inline")
		? "inline"
		: "attachment";
	const fileName =
		contentDisposition.match(
			/(?:^|;)\s*filename="([A-Za-z0-9._ -]{1,160})"\s*(?:;|$)/u,
		)?.[1];
	const redactionClass = response.headers.get(
		"x-taskflow-redaction-class",
	);
	const metadata = {
		digest,
		size,
		mediaType:
			response.headers.get("content-type") ?? "application/octet-stream",
		...(fileName ? { fileName } : {}),
		contentDisposition: disposition,
		redactionClass,
	};
	if (
		!Value.Check(WebArtifactMetadataSchema, metadata) ||
		metadata.redactionClass === "secret"
	) {
		throw new WebClientCodecError(
			"Taskflow returned invalid artifact metadata",
		);
	}
	return metadata;
}

export function createFetchWebTransport(
	readCsrfToken: CsrfTokenReader,
	observeJsonResponse?: WebJsonResponseObserver,
	observeUnauthorized?: WebUnauthorizedObserver,
	readAuthorityGeneration: () => number = () => 0,
): WebClientTransport {
	return {
		async request(request: WebClientTransportRequest): Promise<unknown> {
			if (request.responseKind === "event-stream") {
				throw new WebClientCodecError(
					"Event streams use the browser EventSource transport",
				);
			}
			const authorityGeneration = readAuthorityGeneration();
			const headers = new Headers({ Accept: "application/json" });
			if (request.sensitiveArtifactAcknowledgement) {
				headers.set(
					"X-Taskflow-Sensitive-Ack",
					request.sensitiveArtifactAcknowledgement,
				);
			}
			const init: RequestInit = {
				method: request.method,
				headers,
				credentials: "same-origin",
				cache: "no-store",
				...(request.signal ? { signal: request.signal } : {}),
			};
			if (request.method === "POST") {
				headers.set("Content-Type", "application/json");
				const csrfToken = readCsrfToken();
				if (
					request.endpointId !== "sessionExchange" &&
					csrfToken !== undefined
				) {
					headers.set("X-Taskflow-CSRF", csrfToken);
				}
				init.body = JSON.stringify(request.body);
			}
			const response = await fetch(request.path, init);
			if (
				response.status === 401 &&
				request.endpointId !== "sessionExchange"
			) {
				observeUnauthorized?.({
					endpointId: request.endpointId,
					path: request.path,
				});
			}
			const bytes = await readBounded(
				response,
				request.responseKind === "bytes"
					? 100 * 1024 * 1024
					: request.responseBudgetBytes,
			);
			if (request.responseKind === "bytes" && response.ok) {
				return { metadata: artifactMetadata(response), body: bytes };
			}
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			let value: unknown;
			try {
				value = JSON.parse(text);
			} catch {
				throw new WebClientCodecError(
					`Taskflow returned non-JSON data (${response.status})`,
				);
			}
			if (
				Value.Check(request.successResponseSchema, value)
			) {
				observeJsonResponse?.({
					endpointId: request.endpointId,
					path: request.path,
					envelope: value,
					authorityGeneration,
				});
			}
			return value;
		},
	};
}
