/**
 * Minimal Unix domain socket JSON-line protocol for taskflowd.
 *
 * Handshake: client sends {type:"hello", protocolMajor, clientId}
 * Server replies {type:"hello-ok", protocolMajor, fencingEpoch, role, capabilities}
 * RPC: {type:"rpc", id, method, params} → {type:"rpc-result"|"rpc-error", id, ...}
 *
 * Admit may carry absolute projectRoot for on-demand mount when projectId is
 * not yet in the writer host map (MCP/CLI attach single-ingress). Mount is
 * policy-gated (default deny); agent/gate remain fail-closed on the daemon
 * (no portable host LLM over UDS).
 *
 * Windows named-pipe: non-GA (P13).
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { ControlStoreDurabilityError, SingletonAuthorityError, type ControlHost } from "taskflow-control";
import { sameProjectRoot, type MountResult } from "./mount.ts";

export const PROTOCOL_MAJOR = 1;
/** Per-connection JSON-line ceiling; protects the daemon from unbounded pending frames. */
export const MAX_UDS_LINE_BYTES = 1_048_576;
/** Bound simultaneously open local peers so idle sockets cannot consume the daemon indefinitely. */
export const MAX_UDS_CONNECTIONS = 64;
/** A local peer must finish the one-shot hello before it can hold an admission slot. */
export const UDS_HELLO_DEADLINE_MS = 5_000;
/**
 * Client helper hang budget for udsRpc. This is a stall detector, not a
 * performance SLO: under concurrent suite load a quiet-machine 10s ceiling
 * is load-brittle. 120s is defensible for local UDS + script admits.
 */
export const UDS_RPC_TIMEOUT_MS = 120_000;

export interface UdsServerOptions {
	socketPath: string;
	fencingEpoch: number;
	/** Dynamic singleton epoch check; a stale server must reject mutations. */
	isWriterAuthoritative?: () => boolean;
	/**
	 * Resolve ControlHost by projectId. When projectId is omitted, callers
	 * must only use the result after {@link resolveDefaultHost} has enforced
	 * the exactly-one-mounted-host invariant (via mountedHostCount).
	 */
	getHost: (projectId?: string) => ControlHost | null;
	/**
	 * Number of currently mounted hosts. When > 1, requests without an
	 * explicit projectId/projectRoot fail closed (no silent first-host writes).
	 */
	mountedHostCount?: () => number;
	/**
	 * Writer-only: mount a project from absolute projectRoot when not yet
	 * present. Optional — without it, unknown projectId stays TF_NOT_FOUND.
	 */
	mountProject?: (projectRoot: string, expectedProjectId?: string) => MountResult;
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
	if (socket.destroyed || !socket.writable) return;
	socket.write(
		JSON.stringify({ type: "error", code: "TF_INVALID_ARGUMENT", message }) + "\n",
	);
}

function safeWrite(socket: net.Socket, payload: string): void {
	if (socket.destroyed || !socket.writable) return;
	socket.write(payload);
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
					let settled = false;
					const finish = (value: boolean): void => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						resolve(value);
					};
					const c = net.connect(opts.socketPath, () => {
						c.end();
						// Give the peer a moment to finish; then destroy to drop the handle.
						c.once("close", () => finish(false));
						setTimeout(() => {
							c.destroy();
							finish(false);
						}, 50);
					});
					c.on("error", () => {
						c.destroy();
						finish(true);
					});
					const timer = setTimeout(() => {
						c.destroy();
						finish(true);
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
	/** All live peer sockets — closed deterministically on server stop (D3). */
	const liveSockets = new Set<net.Socket>();
	let closed = false;
	const server = net.createServer((socket) => {
		// A peer may reset while a response is being written; that must not surface
		// as an unhandled EventEmitter error that terminates the daemon.
		socket.on("error", () => {
			/* peer-specific transport failure; close handles slot release when held */
		});
		if (closed || activeConnections >= MAX_UDS_CONNECTIONS) {
			socket.end(
				JSON.stringify({
					type: "error",
					code: "TF_CAPACITY_EXCEEDED",
					message: `UDS connection capacity ${MAX_UDS_CONNECTIONS} is exhausted`,
				}) + "\n",
			);
			// Ensure capacity rejects do not leave half-open handles.
			socket.once("close", () => {});
			setTimeout(() => {
				if (!socket.destroyed) socket.destroy();
			}, 100);
			return;
		}
		activeConnections += 1;
		liveSockets.add(socket);
		let acc = Buffer.alloc(0);
		let inputRejected = false;
		let helloDeadline: ReturnType<typeof setTimeout> | undefined;
		const conn = {
			helloOk: false,
			principal: "anonymous" as string,
			onHelloAccepted: () => {
				if (helloDeadline) {
					clearTimeout(helloDeadline);
					helloDeadline = undefined;
				}
			},
		};
		const rejectMissingHello = (): void => {
			if (conn.helloOk || inputRejected) return;
			inputRejected = true;
			safeWrite(
				socket,
				JSON.stringify({
					type: "error",
					code: "TF_PROTOCOL_INCOMPATIBLE",
					message: `hello must complete within ${UDS_HELLO_DEADLINE_MS}ms`,
				}) + "\n",
			);
			socket.end();
		};
		helloDeadline = setTimeout(rejectMissingHello, UDS_HELLO_DEADLINE_MS);
		socket.once("close", () => {
			if (helloDeadline) {
				clearTimeout(helloDeadline);
				helloDeadline = undefined;
			}
			liveSockets.delete(socket);
			activeConnections = Math.max(0, activeConnections - 1);
		});
		const rejectOverlongFrame = (): void => {
			if (inputRejected) return;
			inputRejected = true;
			safeWrite(
				socket,
				JSON.stringify({
					type: "error",
					code: "TF_PROTOCOL_INCOMPATIBLE",
					message: `UDS frame exceeds ${MAX_UDS_LINE_BYTES} bytes`,
				}) + "\n",
			);
			socket.end();
		};
		/** Per-connection: exactly one hello establishes the immutable label before RPC. */
		socket.on("data", (chunk) => {
			if (inputRejected || closed) return;
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
				if (closed) {
					resolve();
					return;
				}
				closed = true;
				let settled = false;
				// Bound stop latency: a stuck peer must not pin test/daemon teardown.
				// Declared before finish so a sync server.close callback cannot hit TDZ.
				let forceTimer: ReturnType<typeof setTimeout> | undefined;
				const finish = (): void => {
					if (settled) return;
					settled = true;
					if (forceTimer !== undefined) clearTimeout(forceTimer);
					try {
						fs.unlinkSync(opts.socketPath);
					} catch {
						/* ignore */
					}
					resolve();
				};
				// Destroy every peer so server.close is not held open by half-open UDS
				// handles (the reason suites needed --test-force-exit).
				for (const s of [...liveSockets]) {
					try {
						s.removeAllListeners("data");
						s.destroy();
					} catch {
						/* ignore */
					}
				}
				liveSockets.clear();
				// Node 18.2+: drop any connection the server still tracks (incl. races
				// where a peer arrived after the Set snapshot). Typed via cast —
				// @types/node Server may omit closeAllConnections on net.Server.
				const closeAll = (
					server as net.Server & { closeAllConnections?: () => void }
				).closeAllConnections?.bind(server);
				try {
					closeAll?.();
				} catch {
					/* older Node — destroy path above is best-effort */
				}
				server.close(() => finish());
				forceTimer = setTimeout(() => {
					try {
						closeAll?.();
					} catch {
						/* ignore */
					}
					finish();
				}, 1_000);
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
			safeWrite(
				socket,
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
			safeWrite(
				socket,
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
			safeWrite(
				socket,
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
			safeWrite(
				socket,
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
		safeWrite(
			socket,
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
			safeWrite(
				socket,
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
			safeWrite(
				socket,
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
			safeWrite(
				socket,
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
			safeWrite(
				socket,
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
					safeWrite(
						socket,
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
				safeWrite(socket, JSON.stringify({ type: "rpc-result", id, result: snap }) + "\n");
				return;
			}
			if (method === "admit" || method === "cancel" || method === "approval") {
				if (opts.role !== "writer" || opts.isWriterAuthoritative?.() === false) {
					safeWrite(
						socket,
						JSON.stringify({
							type: "rpc-error",
							id,
							code: "TF_AUTHORITY_REVOKED",
							message: "attach or fenced writer cannot mutate",
						}) + "\n",
					);
					return;
				}
				const host =
					method === "admit"
						? resolveHostForAdmit(opts, params)
						: resolveHostExact(opts, params.projectId as string | undefined);
				if (!host.ok) {
					safeWrite(
						socket,
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
					safeWrite(socket, JSON.stringify({ type: "rpc-result", id, result }) + "\n");
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
					safeWrite(socket, JSON.stringify({ type: "rpc-result", id, result }) + "\n");
					return;
				}
				const result = await host.host.cancel(String(params.runId ?? ""), {
					expectedRunVersion:
						typeof params.expectedRunVersion === "number"
							? params.expectedRunVersion
							: undefined,
				});
				safeWrite(socket, JSON.stringify({ type: "rpc-result", id, result }) + "\n");
				return;
			}
			safeWrite(
				socket,
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
			safeWrite(
				socket,
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
 * When projectId/projectRoot is omitted, default only if exactly one host is
 * mounted. Multi-mount without an explicit selector must fail closed — never
 * silently write to whichever ledger happens to be first in the map.
 */
function resolveDefaultHost(
	opts: UdsServerOptions,
):
	| { ok: true; host: ControlHost }
	| { ok: false; code: string; message: string } {
	const count = opts.mountedHostCount?.();
	if (count !== undefined) {
		if (count === 0) {
			return { ok: false, code: "TF_NOT_FOUND", message: "no mounted host" };
		}
		if (count > 1) {
			return {
				ok: false,
				code: "TF_INVALID_ARGUMENT",
				message:
					"projectId or projectRoot required when multiple hosts are mounted (refusing silent first-host default)",
			};
		}
	}
	const h = opts.getHost(undefined);
	if (!h) {
		// getHost may already refuse multi-mount defaults (count unknown here).
		if (count === undefined) {
			return {
				ok: false,
				code: "TF_NOT_FOUND",
				message: "no mounted host (or multi-mount without project selector)",
			};
		}
		return { ok: false, code: "TF_NOT_FOUND", message: "no mounted host" };
	}
	return { ok: true, host: h };
}

/**
 * Require exact projectId when provided; missing/unknown → deny (no silent default
 * when client supplied an id). When projectId omitted, allow default only if
 * exactly one host is mounted (enforced invariant, not a comment).
 */
function resolveHostExact(
	opts: UdsServerOptions,
	projectId: string | undefined,
):
	| { ok: true; host: ControlHost }
	| { ok: false; code: string; message: string } {
	if (projectId !== undefined && projectId !== null && String(projectId).length > 0) {
		const h = opts.getHost(String(projectId));
		// getHost must not fall back to another project — verify identity matches.
		if (!h || h.projectId !== String(projectId)) {
			return {
				ok: false,
				code: "TF_NOT_FOUND",
				message: `unknown or mismatched projectId: ${projectId}`,
			};
		}
		return { ok: true, host: h };
	}
	return resolveDefaultHost(opts);
}

/**
 * Admit resolution: prefer an already-mounted projectId; otherwise mount on
 * demand from explicit absolute projectRoot (identity + allowlist validated).
 * Without projectRoot, unknown projectId remains TF_NOT_FOUND (hardening preserved).
 */
function resolveHostForAdmit(
	opts: UdsServerOptions,
	params: Record<string, unknown>,
):
	| { ok: true; host: ControlHost }
	| { ok: false; code: string; message: string } {
	const projectIdRaw = params.projectId;
	const projectId =
		projectIdRaw !== undefined && projectIdRaw !== null && String(projectIdRaw).length > 0
			? String(projectIdRaw)
			: undefined;
	const projectRoot = typeof params.projectRoot === "string" ? params.projectRoot : undefined;

	if (projectId) {
		const existing = opts.getHost(projectId);
		if (existing && existing.projectId === projectId) {
			if (projectRoot && !sameProjectRoot(existing.store.projectRoot, projectRoot)) {
				return {
					ok: false,
					code: "TF_IDENTITY_MISMATCH",
					message: `projectRoot ${path.resolve(projectRoot)} does not match mounted store ${existing.store.projectRoot}`,
				};
			}
			return { ok: true, host: existing };
		}
	}

	// On-demand mount when client carries absolute projectRoot (empty-mount daemon).
	if (projectRoot && opts.mountProject && opts.role === "writer") {
		const mounted = opts.mountProject(projectRoot, projectId);
		if (!mounted.ok) {
			return { ok: false, code: mounted.code, message: mounted.message };
		}
		return { ok: true, host: mounted.host };
	}

	if (projectId) {
		return {
			ok: false,
			code: "TF_NOT_FOUND",
			message: `unknown or mismatched projectId: ${projectId}`,
		};
	}

	// No projectId + no projectRoot: default only when exactly one host is mounted.
	// Multi-mount without a selector must fail closed (no silent first-host admit).
	const def = resolveDefaultHost(opts);
	if (!def.ok) {
		if (def.code === "TF_NOT_FOUND" && (opts.mountedHostCount?.() ?? 0) === 0) {
			return {
				ok: false,
				code: "TF_NOT_FOUND",
				message: "no mounted host (supply absolute projectRoot to mount on demand)",
			};
		}
		return def;
	}
	return def;
}

export interface UdsRpcOptions {
	/**
	 * Hang-detector budget in ms. Defaults to {@link UDS_RPC_TIMEOUT_MS}.
	 * Must stay high enough for concurrent suite load; do not set to a
	 * quiet-machine "feels fast" value in production tests.
	 */
	timeoutMs?: number;
	/** Principal label for hello (default "test"). */
	principal?: string;
}

/**
 * Client helper for tests: hello + one rpc.
 * Always clears its timer and destroys the socket so test suites exit without
 * --test-force-exit.
 */
export async function udsRpc(
	socketPath: string,
	method: string,
	params: Record<string, unknown>,
	rpcOpts: UdsRpcOptions = {},
): Promise<unknown> {
	const timeoutMs = rpcOpts.timeoutMs ?? UDS_RPC_TIMEOUT_MS;
	const principal = rpcOpts.principal ?? "test";
	return new Promise((resolve, reject) => {
		const sock = net.connect(socketPath);
		let acc = "";
		let phase: "hello" | "rpc" = "hello";
		let settled = false;
		const rpcId = `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				sock.removeAllListeners("data");
				if (!sock.destroyed) {
					sock.end();
					// Half-open local sockets must not pin the event loop.
					setImmediate(() => {
						if (!sock.destroyed) sock.destroy();
					});
				}
			} catch {
				/* ignore */
			}
			fn();
		};
		const timer = setTimeout(() => {
			finish(() =>
				reject(new Error(`uds rpc timeout after ${timeoutMs}ms (${method})`)),
			);
			if (!sock.destroyed) sock.destroy();
		}, timeoutMs);
		sock.on("connect", () => {
			sock.write(
				JSON.stringify({
					type: "hello",
					protocolMajor: PROTOCOL_MAJOR,
					clientId: principal,
					principal,
				}) + "\n",
			);
		});
		sock.on("data", (chunk) => {
			if (settled) return;
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
					finish(() =>
						reject(
							Object.assign(new Error(String(msg.message)), {
								code: msg.code,
							}),
						),
					);
					return;
				}
				if (msg.type === "rpc-result" && msg.id === rpcId) {
					finish(() => resolve(msg.result));
					return;
				}
				if (msg.type === "rpc-error" && msg.id === rpcId) {
					finish(() =>
						reject(
							Object.assign(new Error(String(msg.message)), {
								code: msg.code,
							}),
						),
					);
					return;
				}
			}
		});
		sock.on("error", (e) => {
			finish(() => reject(e));
		});
	});
}
