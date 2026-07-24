import {
	type WebArtifactMetadata,
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
};
export type WebJsonResponseObserver = (
	observation: WebJsonResponseObservation,
) => void;

async function readBounded(
	response: Response,
	maxBytes: number,
): Promise<Uint8Array> {
	const declared = response.headers.get("content-length");
	if (declared !== null && Number(declared) > maxBytes) {
		throw new WebClientCodecError("Taskflow response exceeded its byte budget");
	}
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let length = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		length += value.byteLength;
		if (length > maxBytes) {
			await reader.cancel();
			throw new WebClientCodecError(
				"Taskflow response exceeded its byte budget",
			);
		}
		chunks.push(value);
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
	const disposition = response.headers
		.get("content-disposition")
		?.toLowerCase()
		.startsWith("inline")
		? "inline"
		: "attachment";
	return {
		digest,
		size,
		mediaType:
			response.headers.get("content-type") ?? "application/octet-stream",
		contentDisposition: disposition,
		redactionClass:
			response.headers.get("x-taskflow-redaction-class") === "sensitive"
				? "sensitive"
				: "project",
	};
}

export function createFetchWebTransport(
	readCsrfToken: CsrfTokenReader,
	observeJsonResponse?: WebJsonResponseObserver,
): WebClientTransport {
	return {
		async request(request: WebClientTransportRequest): Promise<unknown> {
			if (request.responseKind === "event-stream") {
				throw new WebClientCodecError(
					"Event streams use the browser EventSource transport",
				);
			}
			const headers = new Headers({ Accept: "application/json" });
			const init: RequestInit = {
				method: request.method,
				headers,
				credentials: "same-origin",
				cache: "no-store",
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
				});
			}
			return value;
		},
	};
}
