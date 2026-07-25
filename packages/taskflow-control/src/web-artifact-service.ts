/**
 * P17 authorized artifact disclosure.
 *
 * Bytes are reachable only through the current durable Run/Receipt relation.
 * The ProjectControlStore re-hashes the immutable content-addressed blob before
 * this handler returns, so WebGateway can still fail with JSON before headers.
 */
import { sha256Hex } from "./hash.ts";
import type { ControlHost } from "./control-host.ts";
import type {
	ArtifactRecord,
	ArtifactRedactionClass,
} from "./types.ts";
import {
	inspectProjectControlStore,
	type ProjectControlReadSnapshot,
} from "./store/project-store.ts";
import type {
	WebEndpointId,
	WebHandlerMap,
} from "./web-protocol.ts";
import { WebReadServiceError } from "./web-read-service.ts";

export const WEB_MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
export const WEB_MAX_INLINE_ARTIFACT_BYTES = 5 * 1024 * 1024;
const INLINE_MEDIA_TYPES = new Set([
	"text/plain; charset=utf-8",
	"application/json; charset=utf-8",
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

export function webArtifactWithinDownloadBudget(byteLength: number): boolean {
	return (
		Number.isSafeInteger(byteLength) &&
		byteLength >= 0 &&
		byteLength <= WEB_MAX_ARTIFACT_BYTES
	);
}

export function webArtifactMayRenderInline(input: {
	readonly byteLength: number;
	readonly mediaType: string;
	readonly redactionClass: ArtifactRecord["redactionClass"];
}): boolean {
	return (
		webArtifactWithinDownloadBudget(input.byteLength) &&
		input.byteLength <= WEB_MAX_INLINE_ARTIFACT_BYTES &&
		input.redactionClass !== "sensitive" &&
		input.redactionClass !== "secret" &&
		INLINE_MEDIA_TYPES.has(input.mediaType)
	);
}
const REDACTION_RANK: Record<ArtifactRedactionClass, number> = {
	public: 0,
	project: 1,
	sensitive: 2,
	secret: 3,
};

export const WEB_IMPLEMENTED_ARTIFACT_HANDLER_IDS = [
	"artifact",
] as const satisfies readonly WebEndpointId[];

export type WebArtifactHandlerMap = Pick<
	WebHandlerMap,
	"artifact"
>;

function fail(
	code:
		| "TF_NOT_FOUND"
		| "TF_AUTHORITY_REVOKED"
		| "TF_DURABILITY_FAILED",
	message: string,
	projectId: string,
	controlDomainId: string,
): never {
	throw new WebReadServiceError({
		code,
		message,
		recoveryAction:
			code === "TF_DURABILITY_FAILED"
				? "operator"
				: "refresh",
		sideEffects: "none",
		projectId,
		controlDomainId,
	});
}

function safeAsciiFileName(
	value: string | undefined,
	digest: string,
	mediaType: string,
): string {
	const extension =
		mediaType === "text/plain; charset=utf-8"
			? ".txt"
			: mediaType === "application/json; charset=utf-8"
				? ".json"
				: mediaType === "image/png"
					? ".png"
					: mediaType === "image/jpeg"
						? ".jpg"
						: mediaType === "image/gif"
							? ".gif"
							: mediaType === "image/webp"
								? ".webp"
								: ".bin";
	const fallback = `artifact-${digest.slice("sha256:".length, 20)}${extension}`;
	if (!value) return fallback;
	const sanitized = value
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.replace(/[^A-Za-z0-9._ -]+/gu, "_")
		.replace(/\s+/gu, " ")
		.replace(/^\.+/u, "")
		.trim()
		.slice(0, 160);
	return sanitized || fallback;
}

function isCurrentlyReachable(
	snapshot: ProjectControlReadSnapshot,
	artifact: ArtifactRecord,
): boolean {
	if (!artifact.runId) return false;
	const run = snapshot.runs.find(
		(candidate) => candidate.runId === artifact.runId,
	);
	if (!run?.receiptId) return false;
	const receipt = snapshot.receipts.find(
		(candidate) =>
			candidate.receiptId === run.receiptId &&
			candidate.runId === artifact.runId,
	);
	return (
		receipt?.receiptId === run.receiptId &&
		receipt.artifactRefs.includes(artifact.artifactId) &&
		(artifact.receiptId === undefined ||
			artifact.receiptId === receipt.receiptId)
	);
}

export function createWebArtifactHandlers(
	host: ControlHost,
): WebArtifactHandlerMap {
	return {
		artifact: ({ params }) => {
			if (
				params.projectId !== host.projectId ||
				params.controlDomainId !== host.controlDomainId
			) {
				fail(
					"TF_AUTHORITY_REVOKED",
					"This listener is not the artifact authority for the requested project.",
					params.projectId,
					params.controlDomainId,
				);
			}
			const inspected = inspectProjectControlStore(
				host.store.projectRoot,
				{
					projectId: params.projectId,
					controlDomainId:
						params.controlDomainId,
				},
			);
			if (!inspected.ok) {
				fail(
					"TF_DURABILITY_FAILED",
					inspected.detail,
					params.projectId,
					params.controlDomainId,
				);
			}
			const reachable = inspected.snapshot.artifacts
				.filter(
					(artifact) =>
						artifact.digest === params.digest,
				)
				.filter((artifact) =>
					isCurrentlyReachable(
						inspected.snapshot,
						artifact,
					),
				);
			if (reachable.length === 0) {
				fail(
					"TF_NOT_FOUND",
					"Artifact is not reachable from a current durable Receipt.",
					params.projectId,
					params.controlDomainId,
				);
			}
			const redactionClass = reachable.reduce(
				(mostRestricted, artifact) =>
					REDACTION_RANK[artifact.redactionClass] >
					REDACTION_RANK[mostRestricted]
						? artifact.redactionClass
						: mostRestricted,
				reachable[0]!.redactionClass,
			);
			if (redactionClass === "secret") {
				fail(
					"TF_AUTHORITY_REVOKED",
					"Secret artifacts cannot be disclosed through the browser.",
					params.projectId,
					params.controlDomainId,
				);
			}
			const body = host.store.readArtifactBytes(params.digest);
			const expectedSize = reachable[0]!.size;
			if (
				!body ||
				body.byteLength !== expectedSize ||
				!webArtifactWithinDownloadBudget(body.byteLength) ||
				`sha256:${sha256Hex(body)}` !==
					params.digest ||
				reachable.some(
					(artifact) => artifact.size !== expectedSize,
				)
			) {
				fail(
					"TF_DURABILITY_FAILED",
					"Artifact bytes do not match their durable digest and length.",
					params.projectId,
					params.controlDomainId,
				);
			}
			const mediaTypes = new Set(
				reachable.map((artifact) => artifact.mediaType),
			);
			const declaredMediaType =
				mediaTypes.size === 1
					? reachable[0]!.mediaType
					: "application/octet-stream";
			const recognizedInlineType =
				INLINE_MEDIA_TYPES.has(declaredMediaType);
			const mediaType = recognizedInlineType
				? declaredMediaType
				: "application/octet-stream";
			const contentDisposition =
				webArtifactMayRenderInline({
					byteLength: body.byteLength,
					mediaType: declaredMediaType,
					redactionClass,
				})
					? ("inline" as const)
					: ("attachment" as const);
			const fileNames = [
				...new Set(
					reachable
						.map((artifact) => artifact.fileName)
						.filter(
							(value): value is string =>
								value !== undefined,
						),
				),
			];
			return {
				metadata: {
					digest: params.digest,
					size: body.byteLength,
					mediaType,
					fileName: safeAsciiFileName(
						fileNames.length === 1
							? fileNames[0]
							: undefined,
						params.digest,
						mediaType,
					),
					redactionClass,
					contentDisposition,
				},
				body,
			};
		},
	};
}
