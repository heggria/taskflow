/**
 * P17 loopback HTTP gateway.
 *
 * This file owns HTTP/session policy only. Domain truth is delegated to the
 * generated WebHandlerMap and therefore remains in ControlStore/ControlHost.
 */
import { createHash, randomBytes } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex, Writable } from "node:stream";
import { Value } from "typebox/value";
import {
	WEB_COMMAND_KINDS,
	WEB_CONTENT_CATALOG_VERSION,
	WEB_DEFAULT_LOCALE,
	WEB_ENDPOINTS,
	WEB_FEATURE_IDS,
	WEB_IMPLEMENTED_ANALYSIS_HANDLER_IDS,
	WEB_IMPLEMENTED_ARTIFACT_HANDLER_IDS,
	WEB_IMPLEMENTED_COMMAND_HANDLER_IDS,
	WEB_DEFAULT_ENABLED_COMMAND_KINDS,
	assertProductionWebCommandCapabilities,
	WEB_IMPLEMENTED_EVENT_HANDLER_IDS,
	WEB_IMPLEMENTED_READ_HANDLER_IDS,
	WEB_IMPLEMENTED_REPLAY_HANDLER_IDS,
	WEB_PROTOCOL_MAJOR,
	WEB_PROTOCOL_MINOR,
	WEB_POLLING_MIN_INTERVAL_MS,
	WEB_SCHEMA_VERSION,
	WEB_SUPPORTED_LOCALES,
	WebApiErrorResponseSchema,
	WebCursorError,
	WebReadServiceError,
	createWebAnalysisHandlers,
	createWebArtifactHandlers,
	createWebCommandHandlers,
	createWebCursorCodec,
	createWebEventHandlers,
	createWebReadHandlers,
	createWebReplayHandlers,
	type ControlError,
	type ControlHost,
	type WebEndpointId,
	type WebHandlerContext,
	type WebHandlerMap,
	type WebSourceObservation,
	type WebStreamFrame,
} from "taskflow-control";
import {
	createWebSessionAuthority,
	type WebSessionAuthority,
	type WebSessionRecord,
} from "./web-session.ts";
import {
	loadWebStaticAssets,
	serveWebStaticRequest,
	type WebStaticAssets,
} from "./web-static-assets.ts";

const LOOPBACK_ADDRESS = "127.0.0.1";
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_TARGET_BYTES = 16 * 1024;
const SINGLETON_SECURITY_HEADERS = [
	"content-type",
	"cookie",
	"last-event-id",
	"origin",
	"range",
	"sec-fetch-dest",
	"sec-fetch-mode",
	"sec-fetch-site",
	"x-taskflow-csrf",
	"x-taskflow-sensitive-ack",
] as const;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const REQUEST_BODY_TIMEOUT_MS = 30_000;
const SESSION_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;
const ARTIFACT_STALL_TIMEOUT_MS = 30_000;
export const WEB_ARTIFACT_ABSOLUTE_TIMEOUT_MS = 5 * 60_000;
export const WEB_ARTIFACT_IN_FLIGHT_BYTE_BUDGET = 100 * 1024 * 1024;
const ARTIFACT_WRITE_CHUNK_BYTES = 64 * 1024;
const SSE_MAX_QUEUED_FRAMES = 256;
const SSE_MAX_QUEUED_BYTES = 1024 * 1024;
const JSON_RESPONSE_DEADLINE_MS = 30_000;

type ContentKeysetDigests = {
	readonly projected: string;
	readonly static: string;
	readonly combined: string;
};

export type WebGatewayOptions = {
	readonly host: ControlHost;
	/**
	 * Exact mounted-authority resolver for project-scoped analysis, artifact,
	 * replay, and command handlers on a multi-project listener.
	 */
	readonly resolveHost?: (
		projectId: string,
		controlDomainId: string,
	) => ControlHost | null;
	readonly listHosts?: () => readonly ControlHost[];
	/**
	 * Additional capability-gated handlers (analysis, artifact, SSE), or test
	 * overrides. Authoritative reads and implemented commands are installed by
	 * the gateway itself.
	 */
	readonly handlers?: Partial<WebHandlerMap>;
	readonly contentKeysetDigests: ContentKeysetDigests;
	readonly supportedFeatures?: readonly (typeof WEB_FEATURE_IDS)[number][];
	readonly supportedCommands?: readonly (typeof WEB_COMMAND_KINDS)[number][];
	readonly hostname?: typeof LOOPBACK_ADDRESS;
	readonly port?: number;
	readonly listenerId?: string;
	readonly packageVersion?: string;
	readonly gitCommit?: string;
	readonly now?: () => number;
	/**
	 * Optional stricter request-body deadline. It may shorten but never enlarge
	 * the frozen P17 30-second maximum.
	 */
	readonly requestBodyTimeoutMs?: number;
	readonly staticAssets?: {
		readonly root: string;
	};
};

export const WEB_IMPLEMENTED_GATEWAY_ENDPOINT_IDS = [
	"sessionExchange",
	"sessionLogout",
	"sessionsRevokeAll",
	"bootstrap",
	...WEB_IMPLEMENTED_READ_HANDLER_IDS,
	...WEB_IMPLEMENTED_ANALYSIS_HANDLER_IDS,
	...WEB_IMPLEMENTED_ARTIFACT_HANDLER_IDS,
	...WEB_IMPLEMENTED_REPLAY_HANDLER_IDS,
	...WEB_IMPLEMENTED_COMMAND_HANDLER_IDS,
	...WEB_IMPLEMENTED_EVENT_HANDLER_IDS,
] as const satisfies readonly WebEndpointId[];

export const WEB_DEFAULT_IMPLEMENTED_FEATURES = [
	"overview",
	"project-detail",
	"run-detail",
	"run-timeline",
	"run-graph",
	"node-detail",
	"approval-detail",
	"approval-decision",
	"attention",
	"why-stale",
	"policy-explanation",
	"artifacts",
	"polling-fallback",
	"replay",
	"sse",
] as const satisfies readonly (typeof WEB_FEATURE_IDS)[number][];

export type WebGatewayHandle = {
	readonly server: http.Server;
	readonly listenerId: string;
	readonly hostNonce: string;
	readonly port: number;
	readonly origin: string;
	readonly launchUrl: string;
	readonly launchToken: string;
	readonly sessions: WebSessionAuthority;
	mintLaunchUrl(): {
		readonly launchUrl: string;
		readonly launchToken: string;
		readonly launchExpiresAt: number;
	};
	stop(): Promise<void>;
};

type MatchedRoute = {
	readonly endpointId: WebEndpointId;
	readonly params: Record<string, string>;
};

function requestId(): string {
	return `req-${randomBytes(12).toString("hex")}`;
}

function principalHash(principalId: string): string {
	return `sha256:${createHash("sha256")
		.update(principalId)
		.digest("hex")}`;
}

function commonHeaders(): http.OutgoingHttpHeaders {
	return {
		"Cache-Control": "no-store",
		"Content-Security-Policy":
			"default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
		"Cross-Origin-Opener-Policy": "same-origin",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
	};
}

function sendJson(
	response: http.ServerResponse,
	status: number,
	value: unknown,
	extraHeaders: http.OutgoingHttpHeaders = {},
): void {
	const body = Buffer.from(JSON.stringify(value), "utf8");
	response.writeHead(status, {
		...commonHeaders(),
		...extraHeaders,
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": String(body.byteLength),
	});
	response.end(body);
}

function sendMinimalParserFailure(
	socket: Duplex,
	status: 400 | 431,
): void {
	if (!socket.writable) {
		socket.destroy();
		return;
	}
	const reason =
		status === 431
			? "Request Header Fields Too Large"
			: "Bad Request";
	socket.end(
		`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
	);
}

function sendRawJsonFailure(
	socket: Duplex,
	status: 400 | 421,
	value: unknown,
): void {
	if (!socket.writable) {
		socket.destroy();
		return;
	}
	const bytes = Buffer.from(JSON.stringify(value), "utf8");
	const reason =
		status === 421 ? "Misdirected Request" : "Bad Request";
	socket.end(
		[
			`HTTP/1.1 ${status} ${reason}`,
			"Connection: close",
			"Cache-Control: no-store",
			"Content-Type: application/json; charset=utf-8",
			`Content-Length: ${bytes.byteLength}`,
			"X-Content-Type-Options: nosniff",
			"",
			bytes.toString("utf8"),
		].join("\r\n"),
	);
}

type ArtifactWriteOptions = {
	readonly stallTimeoutMs?: number;
	readonly absoluteTimeoutMs?: number;
	readonly chunkBytes?: number;
};

function positiveInteger(
	value: number,
	label: string,
): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new RangeError(`${label} must be a positive safe integer`);
	}
	return value;
}

type WebSsePumpOptions = {
	readonly firstFrame: WebStreamFrame;
	readonly iterator: AsyncIterator<WebStreamFrame>;
	readonly writeFrame: (frame: WebStreamFrame) => Promise<void>;
	readonly validateFrame?: (frame: WebStreamFrame) => boolean;
	readonly shouldContinue?: () => boolean;
	readonly stop?: () => void;
	readonly maxQueuedFrames?: number;
	readonly maxQueuedBytes?: number;
};

export type WebSsePumpResult = "ended" | "closed" | "overflow-reset";

type WebHandlerDeadlineOptions = {
	readonly timeoutMs?: number;
	readonly timeoutError: ControlError;
	readonly abortSignal?: AbortSignal;
	readonly abortError?: ControlError;
};

type QueuedWebSseFrame = {
	readonly frame: WebStreamFrame;
	readonly encodedBytes: number;
	readonly overflowReset: boolean;
};

export function encodeWebSseFrame(frame: WebStreamFrame): string {
	return `id: ${frame.id}\nevent: taskflow\ndata: ${JSON.stringify(frame)}\n\n`;
}

function webSseOverflowReset(frame: WebStreamFrame): WebStreamFrame {
	return {
		type: "reset-required",
		id: frame.id,
		cursor: frame.cursor,
		observedAt: frame.observedAt,
		error: protocolError(
			"TF_CURSOR_EXPIRED",
			"Event updates exceeded the bounded delivery queue; refresh authoritative resources.",
			"refresh",
			"none",
		),
	} as unknown as WebStreamFrame;
}

/**
 * Bounded SSE producer/consumer pump.
 *
 * Pulling the handler concurrently with socket writes makes backpressure
 * observable without allowing unbounded memory. Once either queue cap is
 * crossed, every queued change is discarded, exactly one reset is attempted
 * using the latest signed stream cursor, and the stream ends.
 */
export async function pumpWebSseFrames(
	options: WebSsePumpOptions,
): Promise<WebSsePumpResult> {
	const maxQueuedFrames = positiveInteger(
		options.maxQueuedFrames ?? SSE_MAX_QUEUED_FRAMES,
		"SSE queued-frame cap",
	);
	const maxQueuedBytes = positiveInteger(
		options.maxQueuedBytes ?? SSE_MAX_QUEUED_BYTES,
		"SSE queued-byte cap",
	);
	const validateFrame = options.validateFrame ?? (() => true);
	const shouldContinue = options.shouldContinue ?? (() => true);
	if (!validateFrame(options.firstFrame)) {
		throw new TypeError("initial SSE frame violated its executable schema");
	}

	const queue: QueuedWebSseFrame[] = [];
	let queuedBytes = 0;
	let producerDone = false;
	let stopped = false;
	let overflow = false;
	let producerError: unknown;
	let wakeConsumer: (() => void) | undefined;

	const wake = () => {
		const resolve = wakeConsumer;
		wakeConsumer = undefined;
		resolve?.();
	};
	const enqueue = (
		frame: WebStreamFrame,
		overflowReset: boolean,
	): void => {
		const encodedBytes = Buffer.byteLength(
			encodeWebSseFrame(frame),
			"utf8",
		);
		queue.push({ frame, encodedBytes, overflowReset });
		queuedBytes += encodedBytes;
		wake();
	};
	enqueue(options.firstFrame, false);

	const producer = (async () => {
		try {
			while (!stopped && !overflow && shouldContinue()) {
				const next = await options.iterator.next();
				if (next.done) break;
				if (!validateFrame(next.value)) {
					throw new TypeError(
						"SSE frame violated its executable schema",
					);
				}
				const encodedBytes = Buffer.byteLength(
					encodeWebSseFrame(next.value),
					"utf8",
				);
				if (
					queue.length + 1 > maxQueuedFrames ||
					queuedBytes + encodedBytes > maxQueuedBytes
				) {
					queue.length = 0;
					queuedBytes = 0;
					overflow = true;
					enqueue(
						webSseOverflowReset(next.value),
						true,
					);
					break;
				}
				enqueue(next.value, false);
			}
		} catch (cause) {
			producerError = cause;
		} finally {
			producerDone = true;
			wake();
		}
	})();

	let result: WebSsePumpResult = "ended";
	try {
		for (;;) {
			if (!shouldContinue()) {
				result = "closed";
				break;
			}
			if (queue.length === 0) {
				if (producerDone) break;
				await new Promise<void>((resolve) => {
					wakeConsumer = resolve;
				});
				continue;
			}
			const queued = queue.shift()!;
			queuedBytes -= queued.encodedBytes;
			await options.writeFrame(queued.frame);
			if (queued.overflowReset) {
				result = "overflow-reset";
				break;
			}
		}
		if (producerError !== undefined) throw producerError;
		return result;
	} finally {
		stopped = true;
		options.stop?.();
		wake();
		await producer;
	}
}

/**
 * Applies the P17 non-stream response deadline and supplies a cancellation
 * signal to pure/read/command handlers. Timing out never invents a domain
 * outcome: the caller chooses a typed ControlError whose side-effect class is
 * appropriate for the operation.
 */
export async function runWebHandlerWithDeadline<Value>(
	operation: (signal: AbortSignal) => Value | Promise<Value>,
	options: WebHandlerDeadlineOptions,
): Promise<Value> {
	const timeoutMs = positiveInteger(
		options.timeoutMs ?? JSON_RESPONSE_DEADLINE_MS,
		"Web handler response deadline",
	);
	const controller = new AbortController();
	let timer: NodeJS.Timeout | undefined;
	let abortListener: (() => void) | undefined;
	const timedOut = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			const error = new WebReadServiceError(options.timeoutError);
			reject(error);
			controller.abort(error);
		}, timeoutMs);
	});
	const externallyAborted = new Promise<never>((_resolve, reject) => {
		if (!options.abortSignal) return;
		abortListener = () => {
			const error = new WebReadServiceError(
				options.abortError ?? options.timeoutError,
			);
			reject(error);
			controller.abort(error);
		};
		if (options.abortSignal.aborted) {
			abortListener();
		} else {
			options.abortSignal.addEventListener(
				"abort",
				abortListener,
				{ once: true },
			);
		}
	});
	try {
		return await Promise.race([
			Promise.resolve().then(() =>
				operation(controller.signal),
			),
			timedOut,
			externallyAborted,
		]);
	} finally {
		if (timer) clearTimeout(timer);
		if (abortListener && options.abortSignal) {
			options.abortSignal.removeEventListener(
				"abort",
				abortListener,
			);
		}
	}
}

async function runWebHandlerForRequest<Value>(
	request: http.IncomingMessage,
	response: http.ServerResponse,
	operation: (signal: AbortSignal) => Value | Promise<Value>,
	options: Omit<WebHandlerDeadlineOptions, "abortSignal">,
): Promise<Value> {
	const clientAbort = new AbortController();
	const abortForClientClose = () => clientAbort.abort();
	request.once("aborted", abortForClientClose);
	response.once("close", abortForClientClose);
	if (request.aborted || response.destroyed) clientAbort.abort();
	try {
		return await runWebHandlerWithDeadline(operation, {
			...options,
			abortSignal: clientAbort.signal,
		});
	} finally {
		request.off("aborted", abortForClientClose);
		response.off("close", abortForClientClose);
	}
}

function waitForWritableProgress(
	response: Writable,
	stallTimeoutMs: number,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (progressed: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			response.off("drain", drained);
			response.off("close", closed);
			response.off("error", closed);
			resolve(progressed);
		};
		const drained = () => finish(true);
		const closed = () => finish(false);
		const timer = setTimeout(() => {
			response.destroy();
			finish(false);
		}, stallTimeoutMs);
		response.once("drain", drained);
		response.once("close", closed);
		response.once("error", closed);
	});
}

/**
 * Writes a verified immutable artifact with an absolute lifetime and a
 * per-backpressure progress deadline. Options exist for deterministic tests;
 * production callers use the P17 constants above.
 */
export async function writeWebArtifactBody(
	response: Writable,
	bytes: Uint8Array,
	options: ArtifactWriteOptions = {},
): Promise<void> {
	const stallTimeoutMs = positiveInteger(
		options.stallTimeoutMs ?? ARTIFACT_STALL_TIMEOUT_MS,
		"artifact stall timeout",
	);
	const absoluteTimeoutMs = positiveInteger(
		options.absoluteTimeoutMs ?? WEB_ARTIFACT_ABSOLUTE_TIMEOUT_MS,
		"artifact absolute timeout",
	);
	const chunkBytes = positiveInteger(
		options.chunkBytes ?? ARTIFACT_WRITE_CHUNK_BYTES,
		"artifact write chunk size",
	);
	const absoluteTimer = setTimeout(
		() => response.destroy(),
		absoluteTimeoutMs,
	);
	absoluteTimer.unref();
	try {
		for (
			let offset = 0;
			offset < bytes.byteLength;
			offset += chunkBytes
		) {
			if (response.destroyed) return;
			const chunk = bytes.subarray(
				offset,
				Math.min(offset + chunkBytes, bytes.byteLength),
			);
			if (
				!response.write(chunk) &&
				!(await waitForWritableProgress(
					response,
					stallTimeoutMs,
				))
			) {
				return;
			}
		}
		if (response.destroyed) return;
		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				response.off("finish", finish);
				response.off("close", finish);
				response.off("error", finish);
				resolve();
			};
			const timer = setTimeout(() => {
				response.destroy();
				finish();
			}, stallTimeoutMs);
			response.once("finish", finish);
			response.once("close", finish);
			response.once("error", finish);
			response.end();
		});
	} finally {
		clearTimeout(absoluteTimer);
	}
}

function failure(
	id: string,
	error: ControlError,
): {
	ok: false;
	requestId: string;
	schemaVersion: typeof WEB_SCHEMA_VERSION;
	error: ControlError;
} {
	const value = {
		ok: false as const,
		requestId: id,
		schemaVersion: WEB_SCHEMA_VERSION,
		error: {
			...error,
			message: error.message
				.replace(
					/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu,
					"",
				)
				.slice(0, 8_192),
		},
	};
	if (!Value.Check(WebApiErrorResponseSchema, value)) {
		return {
			ok: false,
			requestId: id,
			schemaVersion: WEB_SCHEMA_VERSION,
			error: {
				code: "TF_COMMAND_FAILED",
				message: "Request failed without a safe protocol error.",
				recoveryAction: "none",
				sideEffects: "unknown",
			},
		};
	}
	return value;
}

function statusFor(error: ControlError): number {
	switch (error.code) {
		case "TF_INVALID_ARGUMENT":
			return 400;
		case "TF_AUTHORITY_REVOKED":
		case "TF_CROSS_PRINCIPAL_COMMAND":
			return 403;
		case "TF_NOT_FOUND":
			return 404;
		case "TF_STALE_VERSION":
		case "TF_IDEMPOTENCY_CONFLICT":
		case "TF_CAPACITY_EXCEEDED":
		case "TF_FEATURE_REQUIRED":
			return 409;
		case "TF_CURSOR_EXPIRED":
			return 410;
		case "TF_IDENTITY_MISMATCH":
		case "TF_DURABILITY_FAILED":
			return 503;
		default:
			return 500;
	}
}

function routeMatch(pathname: string): MatchedRoute[] {
	const segments = pathname.split("/").filter(Boolean);
	const matches: MatchedRoute[] = [];
	for (const endpointId of Object.keys(
		WEB_ENDPOINTS,
	) as WebEndpointId[]) {
		const endpoint = WEB_ENDPOINTS[endpointId];
		if (segments.length !== endpoint.routeTokens.length) continue;
		const params: Record<string, string> = {};
		let matched = true;
		for (let index = 0; index < segments.length; index += 1) {
			const token = endpoint.routeTokens[index]!;
			const raw = segments[index]!;
			if (token.kind === "literal") {
				if (raw !== token.value) matched = false;
				continue;
			}
			let decoded: string;
			try {
				decoded = decodeURIComponent(raw);
			} catch {
				matched = false;
				continue;
			}
			if (decoded.includes("/") || decoded.includes("\\")) {
				matched = false;
				continue;
			}
			params[token.name] = decoded;
		}
		if (matched) matches.push({ endpointId, params });
	}
	return matches;
}

function scalarKind(
	schema: Record<string, unknown>,
): "integer" | "number" | "boolean" | "object" | "string" {
	const type = schema.type;
	if (
		type === "integer" ||
		type === "number" ||
		type === "boolean" ||
		type === "object"
	) {
		return type;
	}
	return "string";
}

function convertQueryValue(
	raw: string,
	schema: Record<string, unknown>,
): unknown {
	switch (scalarKind(schema)) {
		case "integer":
		case "number": {
			if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(raw)) {
				return Number.NaN;
			}
			return Number(raw);
		}
		case "boolean":
			return raw === "true"
				? true
				: raw === "false"
					? false
					: raw;
		case "object":
			try {
				return JSON.parse(raw) as unknown;
			} catch {
				return raw;
			}
		case "string":
			return raw;
	}
}

function decodeQuery(
	endpointId: WebEndpointId,
	searchParams: URLSearchParams,
): Record<string, unknown> {
	const schema = WEB_ENDPOINTS[endpointId]
		.querySchema as unknown as {
		properties?: Record<string, Record<string, unknown>>;
	};
	const properties = schema.properties ?? {};
	const unknownKeys = [...new Set(searchParams.keys())].filter(
		(key) => !(key in properties),
	);
	if (unknownKeys.length > 0) {
		throw new TypeError("query contains unknown fields");
	}
	const output: Record<string, unknown> = {};
	for (const [key, property] of Object.entries(properties)) {
		const values = searchParams.getAll(key);
		if (values.length === 0) continue;
		if (property.type === "array") {
			const itemSchema =
				(property.items as Record<string, unknown> | undefined) ??
				{};
			output[key] = values.map((value) =>
				convertQueryValue(value, itemSchema),
			);
		} else {
			if (values.length !== 1) {
				throw new TypeError(
					"scalar query field appeared more than once",
				);
			}
			output[key] = convertQueryValue(values[0]!, property);
		}
	}
	return output;
}

async function readJsonBody(
	request: http.IncomingMessage,
	timeoutMs: number,
): Promise<unknown> {
	const body = (async () => {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of request) {
			const bytes = Buffer.isBuffer(chunk)
				? chunk
				: Buffer.from(chunk);
			size += bytes.byteLength;
			if (size > MAX_JSON_BODY_BYTES) {
				throw new RangeError("request body is too large");
			}
			chunks.push(bytes);
		}
		if (size === 0) return {};
		const text = Buffer.concat(chunks).toString("utf8");
		return JSON.parse(text) as unknown;
	})();
	let timer: NodeJS.Timeout | undefined;
	const timedOut = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new WebRequestBodyTimeoutError()),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([body, timedOut]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

class WebRequestBodyTimeoutError extends Error {
	override readonly name = "WebRequestBodyTimeoutError";
}

function rawHeaderCount(
	request: http.IncomingMessage,
	name: string,
): number {
	let count = 0;
	for (let index = 0; index < request.rawHeaders.length; index += 2) {
		if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
	}
	return count;
}

function sessionTokenFromCookie(
	header: string | undefined,
	cookieName: string,
): string | null {
	if (!header) return null;
	const matches = header
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.startsWith(`${cookieName}=`));
	if (matches.length !== 1) return null;
	const token = matches[0]!.slice(cookieName.length + 1);
	return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}

function isAnalysis(endpointId: WebEndpointId): boolean {
	const operation = WEB_ENDPOINTS[endpointId].operationClass;
	return (
		operation === "Pure analysis" ||
		operation === "Pure analysis, capability-gated"
	);
}

function handlerContext(
	id: string,
	listenerId: string,
	session: WebSessionRecord,
	observedAt: number,
	signal?: AbortSignal,
): WebHandlerContext {
	return {
		requestId: id,
		listenerId,
		principalId: session.principalId,
		principalDisplayName: session.principalDisplayName,
		principalHash: principalHash(session.principalId),
		observedAt,
		sessionAbsoluteExpiresAt: session.absoluteExpiresAt,
		...(signal ? { signal } : {}),
	};
}

function protocolError(
	code: ControlError["code"],
	message: string,
	recoveryAction: ControlError["recoveryAction"] = "none",
	sideEffects: ControlError["sideEffects"] = "none",
): ControlError {
	return { code, message, recoveryAction, sideEffects };
}

export async function startWebGateway(
	options: WebGatewayOptions,
): Promise<WebGatewayHandle> {
	const now = options.now ?? Date.now;
	const requestBodyTimeoutMs = positiveInteger(
		options.requestBodyTimeoutMs ?? REQUEST_BODY_TIMEOUT_MS,
		"Web request-body timeout",
	);
	if (requestBodyTimeoutMs > REQUEST_BODY_TIMEOUT_MS) {
		throw new RangeError(
			"Web request-body timeout cannot exceed the P17 30-second maximum",
		);
	}
	const packageVersion = options.packageVersion ?? "0.3.0-beta.2";
	const staticAssets: WebStaticAssets | undefined = options.staticAssets
		? loadWebStaticAssets({
				root: options.staticAssets.root,
				packageVersion,
				protocolMajor: WEB_PROTOCOL_MAJOR,
				protocolMinor: WEB_PROTOCOL_MINOR,
				contentKeysetDigests: options.contentKeysetDigests,
			})
		: undefined;
	const listenerId =
		options.listenerId ??
		`listener-${randomBytes(12).toString("hex")}`;
	const sessions = createWebSessionAuthority({
		listenerId,
		now,
	});
	const supportedCommands =
		options.supportedCommands ??
		WEB_DEFAULT_ENABLED_COMMAND_KINDS;
	assertProductionWebCommandCapabilities(supportedCommands);
	const supportedFeatures = [
		...new Set(
			options.supportedFeatures ??
				WEB_DEFAULT_IMPLEMENTED_FEATURES,
		),
	].sort((left, right) => left.localeCompare(right, "en"));
	const supportedFeatureSet = new Set(supportedFeatures);
	const cursorCodec = createWebCursorCodec({
		key: randomBytes(32),
		listenerId,
		now,
	});
	const exactProjectHost = (
		projectId: string,
		controlDomainId: string,
	): ControlHost => {
		const candidate =
			options.resolveHost?.(projectId, controlDomainId) ??
			(projectId === options.host.projectId &&
			controlDomainId === options.host.controlDomainId
				? options.host
				: null);
		if (
			!candidate ||
			candidate.projectId !== projectId ||
			candidate.controlDomainId !== controlDomainId
		) {
			throw new WebReadServiceError(
				protocolError(
					"TF_AUTHORITY_REVOKED",
					"This listener has no mounted authority for the requested project.",
					"refresh",
					"none",
				),
			);
		}
		return candidate;
	};
	const analysisHandlers = {
		runRecomputePreview: (request, context) =>
			createWebAnalysisHandlers(
				exactProjectHost(
					request.params.projectId,
					request.params.controlDomainId,
				),
				{
					cursorCodec,
					supportedCommands,
				},
			).runRecomputePreview(request, context),
	} satisfies Partial<WebHandlerMap>;
	const artifactHandlers = {
		artifact: (request, context) =>
			createWebArtifactHandlers(
				exactProjectHost(
					request.params.projectId,
					request.params.controlDomainId,
				),
			).artifact(request, context),
	} satisfies Partial<WebHandlerMap>;
	const replayHandlers = {
		runReplay: (request, context) =>
			createWebReplayHandlers(
				exactProjectHost(
					request.params.projectId,
					request.params.controlDomainId,
				),
			).runReplay(request, context),
	} satisfies Partial<WebHandlerMap>;
	const readHandlers = createWebReadHandlers(options.host, {
			cursorCodec,
			supportedCommands,
			resolveHost: options.resolveHost,
			snapshotCacheMs: 10 * 60_000,
		});
	const handlers: Partial<WebHandlerMap> = {
		...readHandlers,
		...analysisHandlers,
		...artifactHandlers,
		...replayHandlers,
		...createWebCommandHandlers(options.host, {
			supportedCommands,
			resolveHost: options.resolveHost,
			listHosts: options.listHosts,
		}),
		...createWebEventHandlers(options.host, {
			cursorCodec,
			now,
			listHosts: options.listHosts,
		}),
		...(options.handlers ?? {}),
	};
	// Build the immutable aggregate snapshot before advertising the listener.
	// Bootstrap/Home then reuse the same watermark-checked context rather than
	// making the user's first authenticated navigation pay for every mounted
	// ControlStore inspection.
	const prewarmObservedAt = now();
	await readHandlers.overview(
		{ params: {}, query: {}, body: {} },
		{
			requestId: `prewarm-${listenerId}`,
			listenerId,
			principalId: "local-user",
			principalDisplayName: "Local user",
			principalHash: `sha256:${"0".repeat(64)}`,
			observedAt: prewarmObservedAt,
			sessionAbsoluteExpiresAt:
				prewarmObservedAt + 60_000,
		},
	);
	const streamResponses = new Map<
		string,
		Set<http.ServerResponse>
	>();
	function registerStream(
		sessionId: string,
		response: http.ServerResponse,
	): () => void {
		const responses =
			streamResponses.get(sessionId) ?? new Set();
		responses.add(response);
		streamResponses.set(sessionId, responses);
		return () => {
			responses.delete(response);
			if (responses.size === 0) {
				streamResponses.delete(sessionId);
			}
		};
	}
	function closeStreams(sessionId?: string): void {
		for (const [candidate, responses] of streamResponses) {
			if (
				sessionId !== undefined &&
				candidate !== sessionId
			) {
				continue;
			}
			for (const stream of responses) stream.destroy();
			streamResponses.delete(candidate);
		}
	}
	let expectedAuthority = "";
	let origin = "";
	let artifactBytesReserved = 0;

	function acquireArtifactBytes(byteBudget: number): (() => void) | null {
		if (
			!Number.isSafeInteger(byteBudget) ||
			byteBudget < 0 ||
			artifactBytesReserved + byteBudget >
				WEB_ARTIFACT_IN_FLIGHT_BYTE_BUDGET
		) {
			return null;
		}
		artifactBytesReserved += byteBudget;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			artifactBytesReserved -= byteBudget;
		};
	}

	const server = http.createServer(
		{
			maxHeaderSize: MAX_HEADER_BYTES,
			requireHostHeader: true,
			joinDuplicateHeaders: false,
		},
		async (request, response) => {
			const id = requestId();
			let releaseRequest: (() => void) | undefined;
			let releaseArtifactBytes: (() => void) | undefined;
			try {
				if (request.rawHeaders.length / 2 > 64) {
					response.setHeader("Connection", "close");
					sendJson(
						response,
						431,
						failure(
							id,
							protocolError(
								"TF_INVALID_ARGUMENT",
								"Request contains too many headers.",
							),
						),
					);
					return;
				}
				if (
					Buffer.byteLength(request.url ?? "", "utf8") >
					MAX_TARGET_BYTES
				) {
					sendJson(
						response,
						413,
						failure(
							id,
							protocolError(
								"TF_INVALID_ARGUMENT",
								"Request target is too large.",
							),
						),
					);
					return;
				}
				if (
					rawHeaderCount(request, "host") !== 1 ||
					request.headers.host !== expectedAuthority
				) {
					sendJson(
						response,
						421,
						failure(
							id,
							protocolError(
								"TF_INVALID_ARGUMENT",
								"Request Host does not match this Taskflow listener.",
							),
						),
					);
					return;
				}
				if (
					rawHeaderCount(request, "content-length") > 1 ||
					rawHeaderCount(request, "transfer-encoding") > 1 ||
					(request.headers["content-length"] !== undefined &&
						request.headers["transfer-encoding"] !==
							undefined)
				) {
					response.setHeader("Connection", "close");
					sendJson(
						response,
						400,
						failure(
							id,
							protocolError(
								"TF_INVALID_ARGUMENT",
								"Request framing is ambiguous.",
							),
						),
					);
					return;
				}
				const duplicateSecurityHeader =
					SINGLETON_SECURITY_HEADERS.find(
						(name) =>
							rawHeaderCount(request, name) > 1,
					);
				if (duplicateSecurityHeader !== undefined) {
					response.setHeader("Connection", "close");
					sendJson(
						response,
						400,
						failure(
							id,
							protocolError(
								"TF_INVALID_ARGUMENT",
								"Security-sensitive request headers must appear exactly once.",
							),
						),
					);
					return;
				}
				const connectionTokens = String(
					request.headers.connection ?? "",
				)
					.split(",")
					.map((token) => token.trim().toLowerCase());
				if (
					rawHeaderCount(request, "upgrade") > 0 ||
					connectionTokens.includes("upgrade")
				) {
					response.setHeader("Connection", "close");
					sendJson(
						response,
						400,
						failure(
							id,
							protocolError(
								"TF_INVALID_ARGUMENT",
								"HTTP Upgrade is not supported.",
							),
						),
					);
					return;
				}
				if (request.headers.expect !== undefined) {
					sendJson(
						response,
						417,
						failure(
							id,
							protocolError(
								"TF_INVALID_ARGUMENT",
								"Expect is not supported.",
							),
						),
					);
					return;
				}
				const fetchSite = request.headers["sec-fetch-site"];
				const rawPath = (request.url ?? "/").split(/[?#]/u, 1)[0] ?? "/";
				const publicShellNavigation =
					(request.method === "GET" || request.method === "HEAD") &&
					rawPath !== "/api/v1" &&
					!rawPath.startsWith("/api/v1/") &&
					request.headers["sec-fetch-mode"] === "navigate" &&
					request.headers["sec-fetch-dest"] === "document";
				if (
					fetchSite !== undefined &&
					fetchSite !== "same-origin" &&
					!publicShellNavigation
				) {
					sendJson(
						response,
						403,
						failure(
							id,
							protocolError(
								"TF_INVALID_ARGUMENT",
								"Cross-site requests are not allowed.",
							),
						),
					);
					return;
				}
				const requestUrl = new URL(
					request.url ?? "/",
					origin,
				);
				if (
					requestUrl.pathname !== "/api/v1" &&
					!requestUrl.pathname.startsWith("/api/v1/")
				) {
					if (staticAssets) {
						const result = serveWebStaticRequest(
							staticAssets,
							request,
							response,
						);
						if (result.handled) return;
					}
					sendJson(
						response,
						404,
						failure(
							id,
							protocolError(
								"TF_NOT_FOUND",
								"Application route was not found.",
							),
						),
					);
					return;
				}
				const routeMatches = routeMatch(requestUrl.pathname);
				if (routeMatches.length === 0) {
					sendJson(
						response,
						404,
						failure(
							id,
							protocolError(
								"TF_NOT_FOUND",
								"Endpoint not found.",
							),
						),
					);
					return;
				}
				const method = request.method ?? "GET";
				const matched = routeMatches.find(
					(match) =>
						WEB_ENDPOINTS[match.endpointId].method ===
						method,
				);
				if (!matched) {
					const allow = [
						...new Set(
							routeMatches.map(
								(match) =>
									WEB_ENDPOINTS[match.endpointId]
										.method,
							),
						),
					]
						.sort()
						.join(", ");
					sendJson(
						response,
						405,
						failure(
							id,
							protocolError(
								"TF_INVALID_ARGUMENT",
								"Method is not supported for this endpoint.",
							),
						),
						{ Allow: allow },
					);
					return;
				}
				const endpointId = matched.endpointId;
				const endpoint = WEB_ENDPOINTS[endpointId];
				if (
					!Value.Check(endpoint.paramsSchema, matched.params)
				) {
					sendJson(
						response,
						400,
						failure(
							id,
							protocolError(
								"TF_INVALID_ARGUMENT",
								"Path parameters are invalid.",
							),
						),
					);
					return;
				}
				let query: Record<string, unknown>;
				try {
					query = decodeQuery(
						endpointId,
						requestUrl.searchParams,
					);
				} catch {
					sendJson(
						response,
						400,
						failure(
							id,
							protocolError(
								"TF_INVALID_ARGUMENT",
								"Query parameters are invalid.",
							),
						),
					);
					return;
				}
				if (!Value.Check(endpoint.querySchema, query)) {
					sendJson(
						response,
						400,
						failure(
							id,
							protocolError(
								"TF_INVALID_ARGUMENT",
								"Query parameters do not match the endpoint contract.",
							),
						),
					);
					return;
				}
				if (endpointId === "events") {
					if (
						rawHeaderCount(
							request,
							"last-event-id",
						) > 1
					) {
						sendJson(
							response,
							400,
							failure(
								id,
								protocolError(
									"TF_INVALID_ARGUMENT",
									"Last-Event-ID appeared more than once.",
								),
							),
						);
						return;
					}
					const lastEventId =
						request.headers["last-event-id"];
					const eventQuery = query as {
						cursor?: string;
						projectIds?: string[];
					};
					if (
						lastEventId !== undefined &&
						(typeof lastEventId !== "string" ||
							Buffer.byteLength(
								lastEventId,
								"utf8",
							) > 8 * 1024)
					) {
						sendJson(
							response,
							400,
							failure(
								id,
								protocolError(
									"TF_INVALID_ARGUMENT",
									"Last-Event-ID is invalid.",
								),
							),
						);
						return;
					}
					if (
						typeof lastEventId === "string" &&
						eventQuery.cursor !== undefined &&
						eventQuery.cursor !== lastEventId
					) {
						sendJson(
							response,
							400,
							failure(
								id,
								protocolError(
									"TF_INVALID_ARGUMENT",
									"Cursor and Last-Event-ID must be byte-identical.",
								),
							),
						);
						return;
					}
					if (
						typeof lastEventId === "string" &&
						eventQuery.cursor === undefined
					) {
						query = {
							...query,
							cursor: lastEventId,
						};
					}
				}
				const isPost = method === "POST";
				if (
					isPost &&
					request.headers.origin !== origin
				) {
					sendJson(
						response,
						403,
						failure(
							id,
							protocolError(
								"TF_INVALID_ARGUMENT",
								"Request Origin does not match this Taskflow listener.",
							),
						),
					);
					return;
				}
				if (
					!isPost &&
					request.headers.origin !== undefined &&
					request.headers.origin !== origin
				) {
					sendJson(
						response,
						403,
						failure(
							id,
							protocolError(
								"TF_INVALID_ARGUMENT",
								"Request Origin does not match this Taskflow listener.",
							),
						),
					);
					return;
				}
				let body: unknown = {};
				if (isPost) {
					if (
						request.headers["content-type"] !==
						"application/json"
					) {
						sendJson(
							response,
							415,
							failure(
								id,
								protocolError(
									"TF_INVALID_ARGUMENT",
									"POST requests require application/json.",
								),
							),
						);
						return;
					}
					try {
						body = await readJsonBody(
							request,
							requestBodyTimeoutMs,
						);
					} catch (cause) {
						if (
							cause instanceof
							WebRequestBodyTimeoutError
						) {
							response.setHeader(
								"Connection",
								"close",
							);
						}
						sendJson(
							response,
							cause instanceof
								WebRequestBodyTimeoutError
								? 408
								: cause instanceof RangeError
									? 413
									: 400,
							failure(
								id,
								protocolError(
									"TF_INVALID_ARGUMENT",
									cause instanceof
										WebRequestBodyTimeoutError
										? "Request body did not complete before the deadline."
										: cause instanceof
													RangeError
											? "Request body is too large."
											: "Request body is not valid JSON.",
								),
							),
						);
						return;
					}
				} else if (
					request.headers["content-length"] !== undefined ||
					request.headers["transfer-encoding"] !== undefined
				) {
					sendJson(
						response,
						400,
						failure(
							id,
							protocolError(
								"TF_INVALID_ARGUMENT",
								"GET requests cannot carry a body.",
							),
						),
					);
					return;
				}
				if (!Value.Check(endpoint.bodySchema, body)) {
					sendJson(
						response,
						400,
						failure(
							id,
							protocolError(
								"TF_INVALID_ARGUMENT",
								"Request body does not match the endpoint contract.",
							),
						),
					);
					return;
				}

				if (endpointId === "sessionExchange") {
					const launchToken = (
						body as { launchToken: string }
					).launchToken;
					const exchanged = sessions.exchange(launchToken);
					if (!exchanged) {
						sendJson(
							response,
							401,
							failure(
								id,
								protocolError(
									"TF_INVALID_ARGUMENT",
									"Launch capability is invalid or expired.",
								),
							),
						);
						return;
					}
					sendJson(
						response,
						200,
						{
							ok: true,
							requestId: id,
							schemaVersion: WEB_SCHEMA_VERSION,
							data: exchanged.view,
						},
						{
							"Set-Cookie": `${sessions.cookieName}=${exchanged.sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
						},
					);
					return;
				}

				const token = sessionTokenFromCookie(
					request.headers.cookie,
					sessions.cookieName,
				);
				const session = token
					? sessions.authenticate(token)
					: null;
				if (!token || !session) {
					sendJson(
						response,
						401,
						failure(
							id,
							protocolError(
								"TF_INVALID_ARGUMENT",
								"Browser session is missing or expired.",
							),
						),
					);
					return;
				}
				if (isPost) {
					const csrfHeader =
						request.headers["x-taskflow-csrf"];
					const bodyCsrf =
						typeof body === "object" &&
						body !== null &&
						"csrfToken" in body
							? (body as { csrfToken?: unknown })
									.csrfToken
							: undefined;
					if (
						typeof csrfHeader !== "string" ||
						!sessions.verifyCsrf(
							session,
							csrfHeader,
						) ||
						(endpointId === "sessionLogout" ||
						endpointId === "sessionsRevokeAll"
							? bodyCsrf !== csrfHeader
							: false)
					) {
						sendJson(
							response,
							403,
							failure(
								id,
								protocolError(
									"TF_INVALID_ARGUMENT",
									"CSRF validation failed.",
								),
							),
						);
						return;
					}
				}
				const acquiredRequest =
					endpointId === "events"
						? sessions.acquireStream(session)
						: sessions.acquireRequest(
								session,
								isAnalysis(endpointId),
							);
				if (!acquiredRequest) {
					sendJson(
						response,
						429,
						failure(
							id,
							protocolError(
								"TF_CAPACITY_EXCEEDED",
								"Browser session request capacity is full.",
								"none",
								"none",
							),
						),
						{ "Retry-After": "1" },
					);
					return;
				}
				releaseRequest = acquiredRequest;

				if (
					endpointId === "sessionLogout" ||
					endpointId === "sessionsRevokeAll"
				) {
					const revokedSessionCount =
						endpointId === "sessionLogout"
							? Number(sessions.revoke(token))
							: sessions.revokeAll();
					closeStreams(
						endpointId === "sessionLogout"
							? session.sessionId
							: undefined,
					);
					sendJson(
						response,
						200,
						{
							ok: true,
							requestId: id,
							schemaVersion: WEB_SCHEMA_VERSION,
							data: {
								revokedAt: now(),
								revokedSessionCount,
							},
						},
						{
							"Set-Cookie": `${sessions.cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
						},
					);
					return;
				}

				if (endpointId === "bootstrap") {
					const overviewHandler = handlers.overview;
					if (!overviewHandler) {
						throw new WebReadServiceError(
							protocolError(
								"TF_FEATURE_REQUIRED",
								"Authoritative overview source is unavailable.",
								"none",
								"none",
							),
						);
					}
					const observedAt = now();
					const context = handlerContext(
						id,
						listenerId,
						session,
						observedAt,
					);
					const overview = await runWebHandlerForRequest(
						request,
						response,
						(signal) =>
							overviewHandler(
								{
									params: {},
									query: {},
									body: {},
								},
								{
									...context,
									signal,
								},
							),
						{
							timeoutError: protocolError(
								"TF_DURABILITY_FAILED",
								"Bootstrap deadline elapsed before current authority could be returned.",
								"refresh",
								"none",
							),
							abortError: protocolError(
								"TF_DURABILITY_FAILED",
								"Client connection closed before bootstrap authority was returned.",
								"refresh",
								"none",
							),
						},
					);
					const sourceObservation = (
						overview as {
							sourceObservation: WebSourceObservation;
						}
					).sourceObservation;
					const data = {
						browserProtocolMajor: WEB_PROTOCOL_MAJOR,
						browserProtocolMinor: WEB_PROTOCOL_MINOR,
						protocolConsumerRange: {
							major: WEB_PROTOCOL_MAJOR,
							minMinor: WEB_PROTOCOL_MINOR,
							maxMinor: WEB_PROTOCOL_MINOR,
						},
						schemaVersion: WEB_SCHEMA_VERSION,
						contentCatalogVersion:
							WEB_CONTENT_CATALOG_VERSION,
						defaultLocale: WEB_DEFAULT_LOCALE,
						supportedLocales: WEB_SUPPORTED_LOCALES,
						contentKeysetDigests:
							options.contentKeysetDigests,
						listenerId,
						mode:
							options.host.controlMode ===
							"standalone"
								? "standalone"
								: "auto",
						role: options.host.role,
						principalId: session.principalId,
						principalDisplayName:
							session.principalDisplayName,
						csrfToken: session.csrfToken,
						sessionIdleExpiresAt:
							session.idleExpiresAt,
						sessionAbsoluteExpiresAt:
							session.absoluteExpiresAt,
						buildInfo: {
							packageVersion,
							...(options.gitCommit
								? {
										gitCommit:
											options.gitCommit,
									}
								: {}),
							controlSchemaVersion: 1,
						},
						supportedFeatures,
						supportedCommands: [
							...supportedCommands,
						].sort((left, right) =>
							left.localeCompare(right, "en"),
						),
						pollingMinIntervalMs:
							WEB_POLLING_MIN_INTERVAL_MS,
						registryContext:
							sourceObservation.registryContext,
						sourceObservation,
					};
					if (
						!Value.Check(
							endpoint.successDataSchema,
							data,
						)
					) {
						throw new Error(
							"bootstrap projection violated its executable schema",
						);
					}
					sendJson(response, 200, {
						ok: true,
						requestId: id,
						schemaVersion: WEB_SCHEMA_VERSION,
						data,
					});
					return;
				}

				if (
					endpoint.capability !== null &&
					!supportedFeatureSet.has(endpoint.capability)
				) {
					sendJson(
						response,
						409,
						failure(
							id,
							protocolError(
								"TF_FEATURE_REQUIRED",
								`Endpoint requires the unadvertised ${endpoint.capability} capability.`,
							),
						),
					);
					return;
				}

				if (endpointId === "events") {
					const eventHandler = handlers.events;
					if (!eventHandler) {
						sendJson(
							response,
							409,
							failure(
								id,
								protocolError(
									"TF_FEATURE_REQUIRED",
									"Event observation is not implemented by this packaged backend.",
								),
							),
						);
						return;
					}
					const observedAt = now();
					const streamAbort =
						new AbortController();
					const iterable = await eventHandler(
						{
							params: {},
							query: query as {
								cursor?: string;
								projectIds?: string[];
							},
							body: {},
						},
						handlerContext(
							id,
							listenerId,
							session,
							observedAt,
							streamAbort.signal,
						),
					);
					const iterator =
						iterable[Symbol.asyncIterator]();
					// Pull one frame before streaming headers so cursor,
					// authorization, and resume failures remain JSON.
					const first = await iterator.next();
					if (first.done) {
						throw new WebReadServiceError(
							protocolError(
								"TF_DURABILITY_FAILED",
								"Event stream ended before its initial checkpoint.",
							),
						);
					}
					if (
						!Value.Check(
							endpoint.successDataSchema,
							first.value,
						)
					) {
						throw new Error(
							"events handler violated its executable frame schema",
						);
					}
					response.writeHead(200, {
						...commonHeaders(),
						"Cache-Control":
							"no-store, no-transform",
						"Content-Type":
							"text/event-stream; charset=utf-8",
						Connection: "keep-alive",
						"Content-Encoding": "identity",
						"X-Accel-Buffering": "no",
					});
					response.write("retry: 3000\n\n");
					const unregister = registerStream(
						session.sessionId,
						response,
					);
					let closed = false;
					const sessionExpiryTimer = setTimeout(
						() => {
							closed = true;
							streamAbort.abort();
							response.destroy();
						},
						Math.max(
							1,
							session.absoluteExpiresAt - now(),
						),
					);
					sessionExpiryTimer.unref();
					response.once("close", () => {
						closed = true;
						streamAbort.abort();
					});
					const writeFrame = async (
						frame: WebStreamFrame,
					): Promise<void> => {
						if (
							!Value.Check(
								endpoint.successDataSchema,
								frame,
							)
						) {
							throw new Error(
								"events handler violated its executable frame schema",
							);
						}
						const chunk = encodeWebSseFrame(frame);
						if (
							Buffer.byteLength(
								chunk,
								"utf8",
							) >
							endpoint.responseBudgetBytes
						) {
							throw new Error(
								"event frame exceeded its byte budget",
							);
						}
						if (response.write(chunk)) return;
						await new Promise<void>((resolve) => {
							const settled = () => {
								response.off(
									"drain",
									settled,
								);
								response.off(
									"close",
									settled,
								);
								resolve();
							};
							response.once("drain", settled);
							response.once("close", settled);
						});
					};
					try {
						await pumpWebSseFrames({
							firstFrame: first.value,
							iterator,
							writeFrame,
							validateFrame: (frame) =>
								Value.Check(
									endpoint.successDataSchema,
									frame,
								),
							shouldContinue: () =>
								!closed &&
								sessions.authenticate(
									token,
									false,
								) !== null,
							stop: () => streamAbort.abort(),
						});
					} finally {
						clearTimeout(sessionExpiryTimer);
						streamAbort.abort();
						await iterator.return?.();
						unregister();
					}
					if (!closed) response.end();
					return;
				}

				if (
					endpointId === "artifact" &&
					request.headers.range !== undefined
				) {
					sendJson(
						response,
						416,
						failure(
							id,
							protocolError(
								"TF_INVALID_ARGUMENT",
								"Artifact byte ranges are not supported.",
							),
						),
						{ "Accept-Ranges": "none" },
					);
					return;
				}

				const handler = handlers[endpointId] as
					| ((
							input: {
								params: Record<string, string>;
								query: Record<string, unknown>;
								body: unknown;
							},
							context: WebHandlerContext,
					  ) => unknown | Promise<unknown>)
					| undefined;
				if (!handler) {
					sendJson(
						response,
						409,
						failure(
							id,
							protocolError(
								"TF_FEATURE_REQUIRED",
								"Endpoint is not implemented by this packaged backend.",
							),
						),
					);
					return;
				}
				if (endpointId === "artifact") {
					const acquired = acquireArtifactBytes(
						endpoint.responseBudgetBytes,
					);
					if (!acquired) {
						sendJson(
							response,
							429,
							failure(
								id,
								protocolError(
									"TF_CAPACITY_EXCEEDED",
									"Artifact download capacity is currently full.",
									"none",
									"none",
								),
							),
							{ "Retry-After": "1" },
						);
						return;
					}
					releaseArtifactBytes = acquired;
				}
				const observedAt = now();
				const timeoutCommandId =
					endpointId === "commands" &&
					typeof body === "object" &&
					body !== null &&
					"commandId" in body &&
					typeof (
						body as { commandId?: unknown }
					).commandId === "string"
						? (
								body as {
									commandId: string;
								}
							).commandId
						: undefined;
				const data = await runWebHandlerForRequest(
					request,
					response,
					(signal) =>
						handler(
							{
								params: matched.params,
								query,
								body,
							},
							handlerContext(
								id,
								listenerId,
								session,
								observedAt,
								signal,
							),
						),
					{
						abortError:
							endpointId === "commands"
								? {
										...protocolError(
											"TF_COMMAND_FAILED",
											"Client connection closed before the durable command outcome was returned.",
											"retry-same-command",
											"unknown",
										),
										...(timeoutCommandId
											? {
													commandId:
														timeoutCommandId,
												}
											: {}),
									}
								: protocolError(
										"TF_DURABILITY_FAILED",
										"Client connection closed before current authority was returned.",
										"refresh",
										"none",
									),
						timeoutError:
							endpointId === "commands"
								? {
										...protocolError(
											"TF_COMMAND_FAILED",
											"Command response deadline elapsed; recover the durable outcome before retrying.",
											"retry-same-command",
											"unknown",
										),
										...(timeoutCommandId
											? {
													commandId:
														timeoutCommandId,
												}
											: {}),
									}
								: protocolError(
										"TF_DURABILITY_FAILED",
										"Response deadline elapsed before current authority could be returned.",
										"refresh",
										"none",
									),
					},
				);
				if (endpoint.responseKind === "bytes") {
					const result = data as {
						metadata?: unknown;
						body?: unknown;
					};
					if (
						!Value.Check(
							endpoint.successDataSchema,
							result.metadata,
						) ||
						!(
							result.body instanceof
							Uint8Array
						)
					) {
						throw new Error(
							`${endpointId} handler violated its executable byte schema`,
						);
					}
					const metadata = result.metadata as {
						digest: string;
						size: number;
						mediaType: string;
						fileName?: string;
						redactionClass: string;
						contentDisposition:
							| "inline"
							| "attachment";
					};
					const bytes = result.body;
					const digest = `sha256:${createHash(
						"sha256",
					)
						.update(bytes)
						.digest("hex")}`;
					if (
						bytes.byteLength !== metadata.size ||
						bytes.byteLength >
							endpoint.responseBudgetBytes ||
						digest !== metadata.digest
					) {
						throw new WebReadServiceError(
							protocolError(
								"TF_DURABILITY_FAILED",
								"Artifact snapshot failed its final digest or length check.",
								"operator",
								"none",
							),
						);
					}
					if (
						metadata.redactionClass ===
						"sensitive"
					) {
						const acknowledgement =
							request.headers[
								"x-taskflow-sensitive-ack"
							];
						if (
							rawHeaderCount(
								request,
								"x-taskflow-sensitive-ack",
							) !== 1 ||
							acknowledgement !== "download"
						) {
							sendJson(
								response,
								403,
								failure(
									id,
									protocolError(
										"TF_AUTHORITY_REVOKED",
										"Sensitive artifact download requires an explicit acknowledgement.",
										"none",
										"none",
									),
								),
							);
							return;
						}
					}
					const fileName =
						metadata.fileName &&
						/^[A-Za-z0-9._ -]{1,160}$/u.test(
							metadata.fileName,
						)
							? metadata.fileName
							: `artifact-${metadata.digest.slice(
									"sha256:".length,
									20,
								)}.bin`;
					const disposition = `${metadata.contentDisposition}; filename="${fileName.replace(
						/["\\]/gu,
						"_",
					)}"`;
					response.writeHead(200, {
						...commonHeaders(),
						"Cache-Control": "no-store",
						"Content-Security-Policy":
							"default-src 'none'; sandbox",
						"Content-Type": metadata.mediaType,
						"Content-Length": String(
							bytes.byteLength,
						),
						"Content-Disposition": disposition,
						"X-Taskflow-Redaction-Class":
							metadata.redactionClass,
						ETag: `"${metadata.digest}"`,
						"Accept-Ranges": "none",
					});
					await writeWebArtifactBody(
						response,
						bytes,
					);
					return;
				}
				if (!Value.Check(endpoint.successDataSchema, data)) {
					throw new Error(
						`${endpointId} handler violated its executable success schema`,
					);
				}
				const envelope = {
					ok: true as const,
					requestId: id,
					schemaVersion: WEB_SCHEMA_VERSION,
					data,
				};
				const encodedBytes = Buffer.byteLength(
					JSON.stringify(envelope),
					"utf8",
				);
				if (encodedBytes > endpoint.responseBudgetBytes) {
					throw new WebReadServiceError(
						protocolError(
							"TF_DURABILITY_FAILED",
							"Response exceeded its endpoint byte budget.",
							"none",
							"none",
						),
					);
				}
				sendJson(response, 200, envelope);
			} catch (cause) {
				const error =
					cause instanceof WebReadServiceError
						? cause.controlError
						: cause instanceof WebCursorError
							? cause.controlError
						: protocolError(
								"TF_COMMAND_FAILED",
								"Request could not be completed.",
								"none",
								"unknown",
							);
				if (!response.headersSent && !response.destroyed) {
					sendJson(
						response,
						statusFor(error),
						failure(id, error),
					);
				} else if (!response.destroyed) {
					response.destroy();
				}
			} finally {
				releaseArtifactBytes?.();
				releaseRequest?.();
			}
		},
	);

	server.on("checkContinue", (request, response) => {
		const id = requestId();
		response.setHeader("Connection", "close");
		if (
			rawHeaderCount(request, "host") !== 1 ||
			request.headers.host !== expectedAuthority
		) {
			sendJson(
				response,
				421,
				failure(
					id,
					protocolError(
						"TF_INVALID_ARGUMENT",
						"Request Host does not match this Taskflow listener.",
					),
				),
			);
			return;
		}
		sendJson(
			response,
			417,
			failure(
				id,
				protocolError(
					"TF_INVALID_ARGUMENT",
					"Expect is not supported.",
				),
			),
		);
	});
	server.on("checkExpectation", (request, response) => {
		const id = requestId();
		response.setHeader("Connection", "close");
		if (
			rawHeaderCount(request, "host") !== 1 ||
			request.headers.host !== expectedAuthority
		) {
			sendJson(
				response,
				421,
				failure(
					id,
					protocolError(
						"TF_INVALID_ARGUMENT",
						"Request Host does not match this Taskflow listener.",
					),
				),
			);
			return;
		}
		sendJson(
			response,
			417,
			failure(
				id,
				protocolError(
					"TF_INVALID_ARGUMENT",
					"Expect is not supported.",
				),
			),
		);
	});
	server.on("upgrade", (request, socket) => {
		const id = requestId();
		if (
			rawHeaderCount(request, "host") !== 1 ||
			request.headers.host !== expectedAuthority
		) {
			sendRawJsonFailure(
				socket,
				421,
				failure(
					id,
					protocolError(
						"TF_INVALID_ARGUMENT",
						"Request Host does not match this Taskflow listener.",
					),
				),
			);
			return;
		}
		sendRawJsonFailure(
			socket,
			400,
			failure(
				id,
				protocolError(
					"TF_INVALID_ARGUMENT",
					"HTTP Upgrade is not supported.",
				),
			),
		);
	});
	server.on("clientError", (error, socket) => {
		const code = (error as NodeJS.ErrnoException).code;
		sendMinimalParserFailure(
			socket,
			code === "HPE_HEADER_OVERFLOW" ? 431 : 400,
		);
	});

	// Node 24 truncates rawHeaders at maxHeadersCount before the request
	// callback. Keep one sentinel header visible so the application can reject
	// >64 consistently instead of silently accepting a truncated request.
	server.maxHeadersCount = 65;
	server.headersTimeout = 10_000;
	server.requestTimeout = 30_000;
	server.keepAliveTimeout = 5_000;
	server.maxRequestsPerSocket = 100;
	const keepAliveServer = server as http.Server & {
		keepAliveTimeoutBuffer?: number;
	};
	if ("keepAliveTimeoutBuffer" in keepAliveServer) {
		keepAliveServer.keepAliveTimeoutBuffer = 1_000;
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(
			options.port ?? 0,
			options.hostname ?? LOOPBACK_ADDRESS,
			() => {
				server.off("error", reject);
				resolve();
			},
		);
	});
	const address = server.address() as AddressInfo;
	const port = address.port;
	expectedAuthority = `${sessions.hostNonce}.localhost:${port}`;
	origin = `http://${expectedAuthority}`;
	const launchUrl = (token: string) =>
		`${origin}/#launch=${token}`;
	let stopping: Promise<void> | undefined;
	const stop = (): Promise<void> => {
		if (stopping) return stopping;
		stopping = (async () => {
			sessions.revokeAll();
			closeStreams();
			if (!server.listening) return;
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (
						error &&
						(error as NodeJS.ErrnoException).code !==
							"ERR_SERVER_NOT_RUNNING"
					) {
						reject(error);
					} else {
						resolve();
					}
				});
				server.closeAllConnections();
			});
		})();
		return stopping;
	};
	return {
		server,
		listenerId,
		hostNonce: sessions.hostNonce,
		port,
		origin,
		launchUrl: launchUrl(sessions.launchToken),
		launchToken: sessions.launchToken,
		sessions,
		mintLaunchUrl() {
			const capability = sessions.mintLaunchCapability();
			if (!capability) {
				throw Object.assign(
					new Error(
						"TF_CAPACITY_EXCEEDED: too many pending browser launch capabilities",
					),
					{ code: "TF_CAPACITY_EXCEEDED" },
				);
			}
			return {
				launchUrl: launchUrl(capability.launchToken),
				...capability,
			};
		},
		stop,
	};
}
