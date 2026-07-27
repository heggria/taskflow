/**
 * Minimal Unix domain socket JSON-line protocol for taskflowd.
 *
 * Handshake: client sends {type:"hello", protocolMajor, clientId}
 * Server replies {type:"hello-ok", protocolMajor, fencingEpoch, role, capabilities}
 * RPC: {type:"rpc", id, method, params} → {type:"rpc-result"|"rpc-error", id, ...}
 *
 * Windows named-pipe: non-GA (P13).
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { ControlStoreDurabilityError, SingletonAuthorityError, type ControlHost } from "taskflow-control";

export const PROTOCOL_MAJOR = 1;
/** Per-connection JSON-line ceiling; protects the daemon from unbounded pending frames. */
export const MAX_UDS_LINE_BYTES = 1_048_576;
/** Bound simultaneously open local peers so idle sockets cannot consume the daemon indefinitely. */
export const MAX_UDS_CONNECTIONS = 64;
/** A local peer must finish the one-shot hello before it can hold an admission slot. */
export const UDS_HELLO_DEADLINE_MS = 5_000;

export interface UdsServerOptions {
	socketPath: string;
	fencingEpoch: number;
	/** Dynamic singleton epoch check; a stale server must reject mutations. */
	isWriterAuthoritative?: () => boolean;
	/** Resolve ControlHost by projectId or default first mount. */
	getHost: (projectId?: string) => ControlHost | null;
	/** Writer role only serves mutations. */
	role: "writer" | "attach";
}

export interface UdsServerHandle {
	socketPath: string;
	close(): Promise<void>;
}

function parseLine(buf: string): unknown {
	return JSON.parse(buf);
}

/** JSON-line protocol messages must be objects; scalar JSON has no protocol shape. */
function isProtocolObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function writeProtocolError(socket: net.Socket, message: string): void {
	socket.write(
		JSON.stringify({ type: "error", code: "TF_INVALID_ARGUMENT", message }) + "\n",
	);
}

export async function startUdsServer(opts: UdsServerOptions): Promise<UdsServerHandle> {
	if (process.platform === "win32") {
		throw new Error("TF_BOOTSTRAP_FAILED: Windows named-pipe transport is non-GA in 0.3");
	}
	// Stale socket cleanup
	try {
		if (fs.existsSync(opts.socketPath)) {
			const st = fs.statSync(opts.socketPath);
			if (st.isSocket()) {
				// Try connect; if fails, unlink
				const dead = await new Promise<boolean>((resolve) => {
					const c = net.connect(opts.socketPath, () => {
						c.end();
						resolve(false);
					});
					c.on("error", () => resolve(true));
					setTimeout(() => {
						c.destroy();
						resolve(true);
					}, 200);
				});
				if (dead) fs.unlinkSync(opts.socketPath);
			} else {
				fs.unlinkSync(opts.socketPath);
			}
		}
	} catch {
		try {
			fs.unlinkSync(opts.socketPath);
		} catch {
			/* ignore */
		}
	}

	// Private socket directory permissions (owner-only when possible).
	try {
		const dir = path.dirname(opts.socketPath);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.chmodSync(dir, 0o700);
	} catch {
		/* best-effort */
	}

	let activeConnections = 0;
	const server = net.createServer((socket) => {
		// A peer may reset while a response is being written; that must not surface
		// as an unhandled EventEmitter error that terminates the daemon.
		socket.on("error", () => {
			/* peer-specific transport failure; close handles slot release when held */
		});
		if (activeConnections >= MAX_UDS_CONNECTIONS) {
			socket.end(
				JSON.stringify({
					type: "error",
					code: "TF_CAPACITY_EXCEEDED",
					message: `UDS connection capacity ${MAX_UDS_CONNECTIONS} is exhausted`,
				}) + "\n",
			);
			return;
		}
		activeConnections += 1;
		let acc = Buffer.alloc(0);
		let inputRejected = false;
		let helloDeadline: ReturnType<typeof setTimeout> | undefined;
		const conn = {
			helloOk: false,
			principal: "anonymous" as string,
			onHelloAccepted: () => {
				if (helloDeadline) clearTimeout(helloDeadline);
			},
		};
		const rejectMissingHello = (): void => {
			if (conn.helloOk || inputRejected) return;
			inputRejected = true;
			socket.end(
				JSON.stringify({
					type: "error",
					code: "TF_PROTOCOL_INCOMPATIBLE",
					message: `hello must complete within ${UDS_HELLO_DEADLINE_MS}ms`,
				}) + "\n",
			);
		};
		helloDeadline = setTimeout(rejectMissingHello, UDS_HELLO_DEADLINE_MS);
		socket.once("close", () => {
			if (helloDeadline) clearTimeout(helloDeadline);
			activeConnections = Math.max(0, activeConnections - 1);
		});
		const rejectOverlongFrame = (): void => {
			if (inputRejected) return;
			inputRejected = true;
			socket.end(
				JSON.stringify({
					type: "error",
					code: "TF_PROTOCOL_INCOMPATIBLE",
					message: `UDS frame exceeds ${MAX_UDS_LINE_BYTES} bytes`,
				}) + "\n",
			);
		};
		/** Per-connection: exactly one hello establishes the immutable label before RPC. */
		socket.on("data", (chunk) => {
			if (inputRejected) return;
			const data = acc.length === 0 ? chunk : Buffer.concat([acc, chunk]);
			let start = 0;
			let idx: number;
			while ((idx = data.indexOf(0x0a, start)) >= 0) {
				const rawLine = data.subarray(start, idx);
				if (rawLine.length > MAX_UDS_LINE_BYTES) {
					rejectOverlongFrame();
					return;
				}
				start = idx + 1;
				const line = rawLine.toString("utf8").trim();
				if (!line) continue;
				void handleLine(socket, line, opts, conn);
			}
			const remainder = data.subarray(start);
			if (remainder.length > MAX_UDS_LINE_BYTES) {
				rejectOverlongFrame();
				return;
			}
			// Copy the retained tail so a short partial frame does not pin a large
			// network chunk in memory after earlier complete frames were consumed.
			acc = Buffer.from(remainder);
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(opts.socketPath, () => {
			try {
				fs.chmodSync(opts.socketPath, 0o600);
			} catch {
				/* best-effort */
			}
			resolve();
		});
	});

	return {
		socketPath: opts.socketPath,
		close: () =>
			new Promise((resolve) => {
				server.close(() => {
					try {
						fs.unlinkSync(opts.socketPath);
					} catch {
						/* ignore */
					}
					resolve();
				});
			}),
	};
}

/** Syntax-only admission for a client-asserted label; this is not OS auth. */
function isValidPrincipalLabel(p: string): boolean {
	if (!p || p.length > 128) return false;
	if (/[\r\n\0]/.test(p)) return false;
	if (/^https?:\/\//i.test(p)) return false;
	return true;
}

type ConnState = { helloOk: boolean; principal: string; onHelloAccepted: () => void };

async function handleLine(
	socket: net.Socket,
	line: string,
	opts: UdsServerOptions,
	conn: ConnState,
): Promise<void> {
	let parsed: unknown;
	try {
		parsed = parseLine(line);
	} catch {
		writeProtocolError(socket, "invalid json");
		return;
	}
	if (!isProtocolObject(parsed)) {
		writeProtocolError(socket, "protocol message must be a JSON object");
		return;
	}
	const msg = parsed;
	if (typeof msg.type !== "string") {
		writeProtocolError(socket, "protocol message type must be a string");
		return;
	}

	if (msg.type === "hello") {
		if (conn.helloOk) {
			socket.write(
				JSON.stringify({
					type: "hello-error",
					code: "TF_PROTOCOL_INCOMPATIBLE",
					message: "hello is already complete for this connection",
				}) + "\n",
			);
			return;
		}
		const major = msg.protocolMajor;
		if (major !== PROTOCOL_MAJOR) {
			socket.write(
				JSON.stringify({
					type: "hello-error",
					code: "TF_PROTOCOL_INCOMPATIBLE",
					message: `server protocolMajor=${PROTOCOL_MAJOR}`,
				}) + "\n",
			);
			return;
		}
		const principalInput =
			msg.principal !== undefined
				? msg.principal
				: msg.clientId !== undefined
					? msg.clientId
					: "anonymous";
		if (typeof principalInput !== "string") {
			socket.write(
				JSON.stringify({
					type: "hello-error",
					code: "TF_POLICY_DENIED",
					message: "principal label must be a string",
				}) + "\n",
			);
			return;
		}
		const principal = principalInput;
		if (!isValidPrincipalLabel(principal)) {
			socket.write(
				JSON.stringify({
					type: "hello-error",
					code: "TF_POLICY_DENIED",
					message: "invalid principal label",
				}) + "\n",
			);
			return;
		}
		conn.helloOk = true;
		conn.principal = principal;
		conn.onHelloAccepted();
		socket.write(
			JSON.stringify({
				type: "hello-ok",
				protocolMajor: PROTOCOL_MAJOR,
				fencingEpoch: opts.fencingEpoch,
				role: opts.role,
				capabilities: ["status", "wait", "admit", "cancel", "approval"],
			}) + "\n",
		);
		return;
	}

	if (msg.type === "rpc") {
		const id = msg.id;
		// Mandate 4: deny RPC before hello — no side effects.
		if (!conn.helloOk) {
			socket.write(
				JSON.stringify({
					type: "rpc-error",
					id,
					code: "TF_PROTOCOL_INCOMPATIBLE",
					message: "hello required before rpc",
				}) + "\n",
			);
			return;
		}
		if (typeof msg.method !== "string" || msg.method.length === 0) {
			socket.write(
				JSON.stringify({
					type: "rpc-error",
					id,
					code: "TF_INVALID_ARGUMENT",
					message: "rpc method must be a non-empty string",
				}) + "\n",
			);
			return;
		}
		const method = msg.method;
		const rawParams = msg.params === undefined ? {} : msg.params;
		if (!isProtocolObject(rawParams)) {
			socket.write(
				JSON.stringify({
					type: "rpc-error",
					id,
					code: "TF_INVALID_ARGUMENT",
					message: "rpc params must be a JSON object",
				}) + "\n",
			);
			return;
		}
		const params = rawParams;
		// Command replay and authorization are principal-scoped. A caller may not
		// switch that identity after hello: otherwise one connection can mint a
		// command owned by a different principal and bypass cross-principal checks.
		const requestedPrincipal = params.principal;
		if (
			requestedPrincipal !== undefined &&
			(typeof requestedPrincipal !== "string" || requestedPrincipal !== conn.principal)
		) {
			socket.write(
				JSON.stringify({
					type: "rpc-error",
					id,
					code: "TF_POLICY_DENIED",
					message: "RPC principal must match the principal established by hello",
				}) + "\n",
			);
			return;
		}
		const principal = conn.principal;
		try {
			if (method === "status" || method === "wait") {
				const host = resolveHostExact(opts, params.projectId as string | undefined);
				if (!host.ok) {
					socket.write(
						JSON.stringify({
							type: "rpc-error",
							id,
							code: host.code,
							message: host.message,
						}) + "\n",
					);
					return;
				}
				const snap =
					method === "wait"
						? await host.host.wait(String(params.runId ?? ""))
						: host.host.getSnapshot(String(params.runId ?? ""));
				socket.write(JSON.stringify({ type: "rpc-result", id, result: snap }) + "\n");
				return;
			}
			if (method === "admit" || method === "cancel" || method === "approval") {
				if (opts.role !== "writer" || opts.isWriterAuthoritative?.() === false) {
					socket.write(
						JSON.stringify({
							type: "rpc-error",
							id,
							code: "TF_AUTHORITY_REVOKED",
							message: "attach or fenced writer cannot mutate",
						}) + "\n",
					);
					return;
				}
				const host = resolveHostExact(opts, params.projectId as string | undefined);
				if (!host.ok) {
					socket.write(
						JSON.stringify({
							type: "rpc-error",
							id,
							code: host.code,
							message: host.message,
						}) + "\n",
					);
					return;
				}
				if (method === "admit") {
					const result = await host.host.admitAndRun({
						program: params.program,
						commandId: params.commandId as string | undefined,
						callerPrincipal: principal,
					});
					socket.write(JSON.stringify({ type: "rpc-result", id, result }) + "\n");
					return;
				}
				if (method === "approval") {
					const decision = String(params.decision ?? "approve");
					const runId = String(params.runId ?? "");
					const expectedRunVersion =
						typeof params.expectedRunVersion === "number"
							? params.expectedRunVersion
							: undefined;
					let result;
					if (decision === "reject") {
						result = await host.host.reject(runId, {
							expectedRunVersion,
							principal,
							note: params.note as string | undefined,
						});
					} else if (decision === "edit") {
						result = await host.host.edit(runId, {
							expectedRunVersion,
							principal,
							note: String(params.note ?? ""),
						});
					} else {
						result = await host.host.approve(runId, {
							expectedRunVersion,
							principal,
						});
					}
					socket.write(JSON.stringify({ type: "rpc-result", id, result }) + "\n");
					return;
				}
				const result = await host.host.cancel(String(params.runId ?? ""), {
					expectedRunVersion:
						typeof params.expectedRunVersion === "number"
							? params.expectedRunVersion
							: undefined,
				});
				socket.write(JSON.stringify({ type: "rpc-result", id, result }) + "\n");
				return;
			}
			socket.write(
				JSON.stringify({
					type: "rpc-error",
					id,
					code: "TF_INVALID_ARGUMENT",
					message: `unknown method ${method}`,
				}) + "\n",
			);
			} catch (e) {
				const authorityRevoked =
					e instanceof SingletonAuthorityError ||
					(!!e && typeof e === "object" && (e as { code?: unknown }).code === "TF_AUTHORITY_REVOKED");
				const durabilityFailed =
					e instanceof ControlStoreDurabilityError ||
					(!!e && typeof e === "object" && (e as { code?: unknown }).code === "TF_DURABILITY_FAILED");
				socket.write(
					JSON.stringify({
						type: "rpc-error",
						id,
						code: authorityRevoked
							? "TF_AUTHORITY_REVOKED"
							: durabilityFailed
								? "TF_DURABILITY_FAILED"
								: "TF_COMMAND_FAILED",
					message: e instanceof Error ? e.message : String(e),
				}) + "\n",
			);
		}
		return;
	}

	writeProtocolError(socket, `unknown protocol message type ${msg.type}`);
}

/**
 * Require exact projectId when provided; missing/unknown → deny (no silent default
 * when client supplied an id). When projectId omitted, allow single-mount default.
 */
function resolveHostExact(
	opts: UdsServerOptions,
	projectId: string | undefined,
):
	| { ok: true; host: ControlHost }
	| { ok: false; code: string; message: string } {
	if (projectId !== undefined && projectId !== null && String(projectId).length > 0) {
		const h = opts.getHost(String(projectId));
		// getHost may fall back to first mount — verify identity matches.
		if (!h || h.projectId !== String(projectId)) {
			return {
				ok: false,
				code: "TF_NOT_FOUND",
				message: `unknown or mismatched projectId: ${projectId}`,
			};
		}
		return { ok: true, host: h };
	}
	const h = opts.getHost(undefined);
	if (!h) {
		return { ok: false, code: "TF_NOT_FOUND", message: "no mounted host" };
	}
	return { ok: true, host: h };
}

/** Client helper for tests: hello + one rpc. */
export async function udsRpc(
	socketPath: string,
	method: string,
	params: Record<string, unknown>,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const sock = net.connect(socketPath);
		let acc = "";
		let phase: "hello" | "rpc" = "hello";
		const rpcId = `r-${Date.now()}`;
		sock.on("connect", () => {
			sock.write(
				JSON.stringify({ type: "hello", protocolMajor: PROTOCOL_MAJOR, clientId: "test" }) +
					"\n",
			);
		});
		sock.on("data", (chunk) => {
			acc += chunk.toString("utf8");
			let idx: number;
			while ((idx = acc.indexOf("\n")) >= 0) {
				const line = acc.slice(0, idx);
				acc = acc.slice(idx + 1);
				let msg: Record<string, unknown>;
				try {
					msg = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}
				if (phase === "hello" && msg.type === "hello-ok") {
					phase = "rpc";
					sock.write(
						JSON.stringify({ type: "rpc", id: rpcId, method, params }) + "\n",
					);
					continue;
				}
				if (phase === "hello" && msg.type === "hello-error") {
					sock.end();
					reject(new Error(String(msg.message)));
					return;
				}
				if (msg.type === "rpc-result" && msg.id === rpcId) {
					sock.end();
					resolve(msg.result);
					return;
				}
				if (msg.type === "rpc-error" && msg.id === rpcId) {
					sock.end();
					reject(Object.assign(new Error(String(msg.message)), { code: msg.code }));
					return;
				}
			}
		});
		sock.on("error", reject);
		setTimeout(() => {
			sock.destroy();
			reject(new Error("uds rpc timeout"));
		}, 10_000);
	});
}
