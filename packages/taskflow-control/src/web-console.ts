/** Explicitly launched, loopback-only operator console. No store or auth authority.
 * The trusted launcher owns OS identity; authorize MUST verify current policy on
 * each operation and return a client bound to that verified principal. Browser
 * sessions prove possession of launcher authority, not OS identity themselves.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Value } from "typebox/value";
import { ArtifactRefSchema, type ArtifactRef } from "./schema/evidence.ts";
import { UuidSchema } from "./schema/common.ts";
import { ControlError } from "./errors.ts";
import { CONSOLE_HTML, CONSOLE_JS, CONSOLE_CSS } from "./web-console/view.ts";

export type WebConsoleOperation = "control.status" | "projects.list" | "runs.list" | "runs.get" | "approvals.list" | "approval.decide" | "receipts.get" | "evidence.why";
export interface WebConsoleProject {
	projectId: string;
	controlDomainId: string;
	name?: string;
	path?: string;
	mountState?: string;
}
/** Internal seam for the owner to map to its authenticated ControlHost client.
 * projects.list returns WebConsoleProject[]; runs.list returns RunSnapshot[];
 * approvals.list returns ApprovalRequest[] (scoped by the requested project);
 * receipts.get returns Receipt|null; runs.get/control.status/evidence.why return
 * their actual owner DTO. No zero-ID snapshots or synthetic success fallback.
 */
export interface WebConsoleControlClient {
	call(operation: WebConsoleOperation, params: Readonly<Record<string, unknown>>): Promise<unknown>;
}
export interface WebConsoleAuthorization {
	operation: WebConsoleOperation;
	/** Random browser-session handle, NEVER a claimed principal. */
	sessionId: string;
	projectId?: string;
	controlDomainId?: string;
}
export interface WebConsoleOptions {
	/** Required live check. Resolve verified identity from trusted launcher state,
	 * never from HTTP input/sessionId alone. Re-check project/operation policy. */
	authorize: (request: WebConsoleAuthorization) => Promise<WebConsoleControlClient>;
	port?: number;
	/** Absolute browser session lifetime, default 30 minutes. */
	sessionTtlMs?: number;
	/** Absolute one-use bootstrap lifetime, default 5 minutes. */
	bootstrapTtlMs?: number;
	/** Owner enables only after its output-edit ArtifactRef contract is wired. */
	approvalEditWithArtifactRef?: boolean;
}
export interface WebConsoleServer {
	readonly url: string;
	/** One-use secret for trusted launcher/browser handoff. Never log, put in a
	 * URL, persist in localStorage or send to a remote service. */
	readonly bootstrapToken: string;
	close(): Promise<void>;
}
type Session = { csrf: string; expiresAt: number };
class HttpFailure extends Error {
	readonly status: number;
	constructor(status: number, message: string) { super(message); this.status = status; }
}
const token = (): string => randomBytes(32).toString("base64url");
const sameSecret = (actual: unknown, expected: string): boolean => {
	if (typeof actual !== "string") return false;
	const a = Buffer.from(actual);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
};
function positive(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
	return value;
}
function uuid(value: unknown, name: string): string {
	if (!Value.Check(UuidSchema, value)) throw new HttpFailure(400, `${name} must be a UUID`);
	return value as string;
}
function boundedText(value: unknown, name: string): string {
	if (typeof value !== "string" || !value || value.length > 512) throw new HttpFailure(400, `${name} is required (maximum 512 characters)`);
	return value;
}
function onlyKeys(body: Record<string, unknown>, keys: readonly string[]): void {
	if (Object.keys(body).some((key) => !keys.includes(key))) throw new HttpFailure(400, "Unexpected request field");
}
async function jsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
	if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new HttpFailure(415, "Content-Type must be application/json");
	if (Number(request.headers["content-length"]) > 65_536) throw new HttpFailure(413, "Request body exceeds 64 KiB");
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > 65_536) throw new HttpFailure(413, "Request body exceeds 64 KiB");
		chunks.push(buffer);
	}
	let raw: unknown;
	try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
	catch { throw new HttpFailure(400, "Malformed JSON request"); }
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpFailure(400, "Request must be a JSON object");
	return raw as Record<string, unknown>;
}

export async function startWebConsole(options: WebConsoleOptions): Promise<WebConsoleServer> {
	if (typeof options.authorize !== "function") throw new Error("A live authorize callback is required");
	const port = options.port ?? 0;
	if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("port must be 0..65535");
	const sessionTtlMs = positive(options.sessionTtlMs ?? 30 * 60_000, "sessionTtlMs");
	const bootstrapExpiresAt = Date.now() + positive(options.bootstrapTtlMs ?? 5 * 60_000, "bootstrapTtlMs");
	const bootstrapToken = token();
	let bootstrapUsed = false;
	let origin = "";
	let authority = "";
	const sessions = new Map<string, Session>();
	const sockets = new Set<Socket>();
	const features = { approvalEditWithArtifactRef: options.approvalEditWithArtifactRef === true };

	const server = http.createServer((request, response) => { void handle(request, response); });
	server.requestTimeout = 10_000;
	server.headersTimeout = 10_000;
	server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
	server.on("clientError", (_error, socket) => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
	});
	authority = `127.0.0.1:${(server.address() as AddressInfo).port}`;
	origin = `http://${authority}`;
	server.on("error", () => { /* no process-wide uncaught server errors */ });

	async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
		const send = (status: number, value: unknown): void => {
			response.statusCode = status;
			response.setHeader("Content-Type", "application/json; charset=utf-8");
			response.end(JSON.stringify(value));
		};
		try {
			if (request.headers.host !== authority) throw new HttpFailure(403, "Invalid console Host");
			if (request.headers.origin !== undefined && request.headers.origin !== origin) throw new HttpFailure(403, "Invalid console Origin");
			const site = request.headers["sec-fetch-site"];
			if (site !== undefined && site !== "same-origin" && site !== "none") throw new HttpFailure(403, "Cross-site console request denied");
			const url = new URL(request.url ?? "/", origin);
			if (url.origin !== origin) throw new HttpFailure(403, "Invalid request origin");
			const method = request.method ?? "GET";
			if (method === "GET" && ["/", "/app.js", "/style.css"].includes(url.pathname)) {
				response.setHeader("Content-Type", url.pathname === "/" ? "text/html; charset=utf-8" : url.pathname === "/app.js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8");
				response.end(url.pathname === "/" ? CONSOLE_HTML : url.pathname === "/app.js" ? CONSOLE_JS : CONSOLE_CSS);
				return;
			}
			if (!url.pathname.startsWith("/api/")) throw new HttpFailure(404, "Unknown console route");
			const mutating = method !== "GET";
			if (!["GET", "POST", "DELETE"].includes(method)) throw new HttpFailure(405, "Method not allowed");
			if (mutating && request.headers.origin !== origin) throw new HttpFailure(403, "Console mutations require same Origin");
			if (url.pathname === "/api/session" && method === "POST") {
				const body = await jsonBody(request);
				onlyKeys(body, ["token"]);
				if (bootstrapUsed || Date.now() >= bootstrapExpiresAt || !sameSecret(body.token, bootstrapToken)) throw new HttpFailure(401, "Invalid or expired launcher token");
				// Consume synchronously before any await: concurrent exchanges cannot reuse it.
				bootstrapUsed = true;
				const sessionId = token();
				const session = { csrf: token(), expiresAt: Date.now() + sessionTtlMs };
				sessions.set(sessionId, session);
				response.setHeader("Set-Cookie", `taskflow_console=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil(sessionTtlMs / 1000)}`);
				send(200, { csrf: session.csrf, expiresAt: session.expiresAt, features });
				return;
			}
			const cookies = (request.headers.cookie ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith("taskflow_console="));
			const sessionId = cookies.length === 1 ? cookies[0]!.slice("taskflow_console=".length) : "";
			const session = sessions.get(sessionId);
			if (!session || Date.now() >= session.expiresAt) {
				sessions.delete(sessionId);
				throw new HttpFailure(401, "Console session expired; launch a new session");
			}
			if (mutating && !sameSecret(request.headers["x-taskflow-csrf"], session.csrf)) throw new HttpFailure(403, "Invalid CSRF token");
			if (url.pathname === "/api/session") {
				if (method === "DELETE") {
					sessions.delete(sessionId);
					response.setHeader("Set-Cookie", "taskflow_console=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
					send(200, { closed: true });
				} else if (method === "GET") send(200, { csrf: session.csrf, expiresAt: session.expiresAt, features });
				else throw new HttpFailure(405, "Method not allowed");
				return;
			}
			let operation: WebConsoleOperation;
			let params: Record<string, unknown> = {};
			if (url.pathname === "/api/status" && method === "GET") operation = "control.status";
			else if (url.pathname === "/api/projects" && method === "GET") operation = "projects.list";
			else {
				const segments = url.pathname.split("/").slice(1);
				if (segments[0] !== "api" || segments[1] !== "projects") throw new HttpFailure(404, "Unknown console route");
				params = { projectId: uuid(segments[2], "projectId"), controlDomainId: uuid(url.searchParams.get("controlDomainId"), "controlDomainId") };
				if (segments.length === 4 && method === "GET" && segments[3] === "runs") operation = "runs.list";
				else if (segments.length === 4 && method === "GET" && segments[3] === "approvals") operation = "approvals.list";
				else if (segments[3] === "runs" && method === "GET" && [5, 6].includes(segments.length)) {
					params.runId = uuid(segments[4], "runId");
					if (segments.length === 5) operation = "runs.get";
					else if (segments[5] === "receipt") operation = "receipts.get";
					else if (segments[5] === "why") {
						operation = "evidence.why";
						params.kind = url.searchParams.get("kind");
						if (params.kind !== "stale" && params.kind !== "effect") throw new HttpFailure(400, "why kind must be stale or effect");
						if (params.kind === "effect") params.effectId = boundedText(url.searchParams.get("effectId"), "effectId");
						if (url.searchParams.has("phaseId")) params.phaseId = boundedText(url.searchParams.get("phaseId"), "phaseId");
					} else throw new HttpFailure(404, "Unknown console route");
				} else if (segments[3] === "approvals" && segments[5] === "decisions" && segments.length === 6 && method === "POST") {
					operation = "approval.decide";
					params.approvalRequestId = uuid(segments[4], "approvalRequestId");
					const body = await jsonBody(request);
					onlyKeys(body, ["commandId", "runId", "expectedRunVersion", "decision", "editArtifactRef"]);
					params.commandId = uuid(body.commandId, "commandId");
					params.runId = uuid(body.runId, "runId");
					if (!Number.isSafeInteger(body.expectedRunVersion) || Number(body.expectedRunVersion) < 0) throw new HttpFailure(400, "expectedRunVersion must be a non-negative safe integer");
					params.expectedRunVersion = body.expectedRunVersion;
					if (typeof body.decision !== "string" || !["approve", "reject", "edit"].includes(body.decision)) throw new HttpFailure(400, "Invalid approval decision");
					params.decision = body.decision;
					if (body.decision === "edit") {
						if (!features.approvalEditWithArtifactRef) throw new HttpFailure(409, "Approval editing is unavailable on this control service");
						if (!Value.Check(ArtifactRefSchema, body.editArtifactRef)) throw new HttpFailure(400, "edit requires a valid editArtifactRef");
						params.editArtifactRef = body.editArtifactRef as ArtifactRef;
					} else if (body.editArtifactRef !== undefined) throw new HttpFailure(400, "editArtifactRef requires edit decision");
				} else throw new HttpFailure(404, "Unknown console route");
			}
			const client = await options.authorize({ operation, sessionId, ...(typeof params.projectId === "string" ? { projectId: params.projectId } : {}), ...(typeof params.controlDomainId === "string" ? { controlDomainId: params.controlDomainId } : {}) });
			const result = await client.call(operation, params);
			send(200, { result });
		} catch (error) {
			if (response.headersSent) { response.destroy(); return; }
			if (error instanceof HttpFailure) send(error.status, { error: { message: error.message } });
			else if (error instanceof ControlError) {
				const status = ["TF_POLICY_DENIED", "TF_AUTHORITY_REVOKED", "TF_CROSS_PRINCIPAL_COMMAND"].includes(error.code) ? 403 : ["TF_STALE_VERSION", "TF_IDEMPOTENCY_CONFLICT"].includes(error.code) ? 409 : error.code === "TF_FEATURE_REQUIRED" ? 503 : 500;
				send(status, { error: error.toEnvelope() });
			} else send(500, { error: { message: "Control service request failed" } });
		}
	}
	return { url: origin, bootstrapToken, close: async () => {
		sessions.clear();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	} };
}
