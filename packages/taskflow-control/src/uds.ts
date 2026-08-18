/**
 * Unix domain socket transport for the ControlHost (beta.2 S2 收口 — A2/A2b).
 *
 * The winner of the user singleton lock `listen`s on `singletonPaths().endpointPath`;
 * every other process `connect`s as a client. The wire is newline-delimited
 * JSON (one frame per line):
 *
 *   {"type":"hello","hello":<NegotiationHandshake>}
 *   {"type":"hello-ack","ok":true,"serverHello":<...>,"fencingEpoch":N}
 *   {"type":"hello-ack","ok":false,"error":<ErrorEnvelope>}
 *   {"type":"rpc","id":N,"method":"control.probe","params":...,"fencingEpoch":N}
 *   {"type":"rpc-result","id":N,"ok":true,"result":...}
 *   {"type":"rpc-result","id":N,"ok":false,"error":<ErrorEnvelope>}
 *
 * Hello-before-RPC (P4) is enforced per connection: the first frame MUST be a
 * hello, a failed hello closes the socket, and a `protocolMajor` mismatch is
 * rejected on the wire (TF_PROTOCOL_INCOMPATIBLE). The socket permission is
 * explicitly chmod'ed to 0o600 — never umask luck (plan §4.1).
 *
 * Unix-only transport: Windows named pipe is explicitly NON-GA in 0.3-C.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import { bootstrapFailed, ControlError, errorFromEnvelope, errorToEnvelope, protocolError } from "./errors.ts";
import { createHelloGate } from "./hello.ts";
import type { ErrorEnvelope, NegotiationHandshake } from "./schema/transport.ts";

// ---------------------------------------------------------------------------
// Wire frames
// ---------------------------------------------------------------------------

export type UdsFrame =
	| { type: "hello"; hello: NegotiationHandshake }
	| { type: "hello-ack"; ok: true; serverHello: NegotiationHandshake; fencingEpoch: number }
	| { type: "hello-ack"; ok: false; error: ErrorEnvelope }
	| { type: "rpc"; id: number; method: string; params?: unknown; fencingEpoch: number }
	| { type: "rpc-result"; id: number; ok: true; result: unknown }
	| { type: "rpc-result"; id: number; ok: false; error: ErrorEnvelope };

function encodeFrame(frame: UdsFrame): string {
	return JSON.stringify(frame) + "\n";
}

function parseFrame(line: string): Record<string, unknown> {
	const raw: unknown = JSON.parse(line);
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("control wire frame must be a JSON object");
	}
	return raw as Record<string, unknown>;
}

/** Control is unreachable/not answering → TF_JOURNAL_UNAVAILABLE (fail closed). */
function controlUnavailable(message: string): ControlError {
	return new ControlError("TF_JOURNAL_UNAVAILABLE", message, { recoveryAction: "refresh", sideEffects: "none" });
}

// ---------------------------------------------------------------------------
// Server (winner: listen/accept)
// ---------------------------------------------------------------------------

export interface UdsServerOptions {
	/** Socket path from `singletonPaths().endpointPath`. */
	endpointPath: string;
	/** The server's own handshake, returned to compatible clients. */
	serverHello: NegotiationHandshake;
	/** Features the server demands from clients (P4). */
	requiredFeatures?: readonly string[];
	/** The winner's current fencing epoch, sent in the hello-ack (P16). */
	getFencingEpoch: () => number;
	/** Dispatch one RPC after a successful per-connection hello. */
	handleRpc: (method: string, params: unknown, fencingEpoch: number) => Promise<unknown>;
}

export interface UdsServer {
	readonly endpointPath: string;
	close(): Promise<void>;
}

/**
 * Start listening on a Unix socket. The socket file is chmod'ed to 0o600
 * immediately after bind (plan §4.1). Listen failure (e.g. a live foreign
 * socket already bound) fails closed with TF_BOOTSTRAP_FAILED — the caller
 * owns the singleton lock and must release it.
 */
export function startUdsServer(options: UdsServerOptions): Promise<UdsServer> {
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		handleServerConnection(socket, options);
	});

	return new Promise((resolve, reject) => {
		const onError = (error: NodeJS.ErrnoException): void => {
			server.removeListener("listening", onListening);
			reject(bootstrapFailed(`cannot listen on control endpoint ${options.endpointPath}: ${error.message}`));
		};
		const onListening = (): void => {
			server.removeListener("error", onError);
			try {
				fs.chmodSync(options.endpointPath, 0o600);
			} catch (error) {
				server.close();
				reject(bootstrapFailed(`cannot set 0o600 on control endpoint ${options.endpointPath}: ${error instanceof Error ? error.message : String(error)}`));
				return;
			}
			// Post-listen server errors (EMFILE etc.) must not crash the winner.
			server.on("error", () => { /* best effort */ });
			resolve({
				endpointPath: options.endpointPath,
				close: () =>
					new Promise<void>((closeResolve) => {
						for (const socket of sockets) socket.destroy();
						server.close(() => closeResolve());
					}),
			});
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(options.endpointPath);
	});
}

function handleServerConnection(socket: net.Socket, options: UdsServerOptions): void {
	// Per-connection hello gate (P4): the first frame must be a hello.
	const gate = createHelloGate(options.serverHello, { requiredFeatures: options.requiredFeatures });
	let greeted = false;
	let buffer = "";
	let destroyed = false;

	const send = (frame: UdsFrame): void => {
		if (destroyed) return;
		socket.write(encodeFrame(frame));
	};
	const failClosed = (frame: UdsFrame): void => {
		send(frame);
		destroyed = true;
		socket.destroy();
	};

	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		let index: number;
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (!line) continue;
			let raw: Record<string, unknown>;
			try {
				raw = parseFrame(line);
			} catch (error) {
				failClosed({
					type: greeted ? "rpc-result" : "hello-ack",
					...(greeted ? { id: 0 } : {}),
					ok: false,
					error: errorToEnvelope(error),
				} as UdsFrame);
				return;
			}
			void handleFrame(raw);
		}
	});
	socket.on("error", () => {
		destroyed = true;
		socket.destroy();
	});

	const handleFrame = async (raw: Record<string, unknown>): Promise<void> => {
		if (raw.type === "hello") {
			if (greeted) {
				failClosed({ type: "hello-ack", ok: false, error: errorToEnvelope(protocolError("duplicate hello on a control channel")) });
				return;
			}
			const verdict = gate.hello(raw.hello);
			if (!verdict.ok) {
				failClosed({ type: "hello-ack", ok: false, error: verdict.error.toEnvelope() });
				return;
			}
			greeted = true;
			send({
				type: "hello-ack",
				ok: true,
				serverHello: gate.serverHello,
				fencingEpoch: options.getFencingEpoch(),
			});
			return;
		}
		if (raw.type === "rpc") {
			if (!greeted) {
				failClosed({
					type: "rpc-result",
					id: typeof raw.id === "number" ? raw.id : 0,
					ok: false,
					error: errorToEnvelope(protocolError("hello must precede any RPC on this control channel")),
				});
				return;
			}
			const id = raw.id;
			if (typeof id !== "number") {
				failClosed({ type: "rpc-result", id: 0, ok: false, error: errorToEnvelope(protocolError("rpc frame requires a numeric id")) });
				return;
			}
			const method = typeof raw.method === "string" ? raw.method : "";
			if (!method) {
				failClosed({ type: "rpc-result", id, ok: false, error: errorToEnvelope(protocolError("rpc frame requires a method name")) });
				return;
			}
			const fencingEpoch = typeof raw.fencingEpoch === "number" ? raw.fencingEpoch : 0;
			try {
				const result = await options.handleRpc(method, raw.params, fencingEpoch);
				send({ type: "rpc-result", id, ok: true, result });
			} catch (error) {
				send({ type: "rpc-result", id, ok: false, error: errorToEnvelope(error) });
			}
			return;
		}
		failClosed({
			type: greeted ? "rpc-result" : "hello-ack",
			...(greeted ? { id: 0 } : {}),
			ok: false,
			error: errorToEnvelope(protocolError(`unknown control wire frame type ${JSON.stringify(raw.type)}`)),
		} as UdsFrame);
	};
}

// ---------------------------------------------------------------------------
// Client (loser: connect/attach)
// ---------------------------------------------------------------------------

export interface UdsClientOptions {
	endpointPath: string;
	clientHello: NegotiationHandshake;
	/** Budget for connect + hello (default 5s). */
	connectTimeoutMs?: number;
	/** Budget for a single RPC round-trip (default 10s). */
	rpcTimeoutMs?: number;
}

export interface UdsClient {
	readonly endpointPath: string;
	/** The winner's fencing epoch, received on the wire in the hello-ack (P16). */
	readonly fencingEpoch: number;
	/** The winner's handshake, received on the wire. */
	readonly serverHello: NegotiationHandshake;
	rpc<T>(method: string, params?: unknown, fencingEpoch?: number): Promise<T>;
	close(): void;
}

/**
 * Connect to the winner's Unix socket, perform the online hello, and return a
 * client bound to the winner's fencing epoch. A protocol/schema/feature
 * rejection on the wire rejects with the corresponding ControlError
 * (e.g. TF_PROTOCOL_INCOMPATIBLE); an unreachable endpoint fails closed with
 * TF_JOURNAL_UNAVAILABLE.
 */
export function connectUdsClient(options: UdsClientOptions): Promise<UdsClient> {
	const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
	const rpcTimeoutMs = options.rpcTimeoutMs ?? 10_000;

	return new Promise((resolve, reject) => {
		const socket = net.connect(options.endpointPath);
		let buffer = "";
		let settled = false;
		let closed = false;
		let nextId = 1;
		let wireEpoch = 0;
		let wireServerHello: NegotiationHandshake | undefined;
		const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();

		const rejectPending = (error: unknown): void => {
			for (const [, entry] of pending) entry.reject(error);
			pending.clear();
		};

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			rejectPending(controlUnavailable(`control endpoint ${options.endpointPath} did not answer hello within ${connectTimeoutMs}ms`));
			socket.destroy();
			reject(controlUnavailable(`control endpoint ${options.endpointPath} did not answer hello within ${connectTimeoutMs}ms`));
		}, connectTimeoutMs);

		socket.on("connect", () => {
			socket.write(encodeFrame({ type: "hello", hello: options.clientHello }));
		});

		socket.on("error", (error) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(controlUnavailable(`cannot connect to control endpoint ${options.endpointPath}: ${error.message}`));
				return;
			}
			rejectPending(controlUnavailable(`control endpoint ${options.endpointPath} closed: ${error.message}`));
		});

		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let index: number;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (!line) continue;
				let raw: Record<string, unknown>;
				try {
					raw = parseFrame(line);
				} catch (error) {
					rejectPending(controlUnavailable(`control endpoint ${options.endpointPath} sent a malformed frame: ${error instanceof Error ? error.message : String(error)}`));
					continue;
				}
				if (raw.type === "hello-ack") {
					if (settled) continue;
					settled = true;
					clearTimeout(timer);
					if (raw.ok === true) {
						if (typeof raw.fencingEpoch !== "number" || raw.serverHello === undefined) {
							reject(controlUnavailable(`control endpoint ${options.endpointPath} sent a malformed hello-ack`));
							socket.destroy();
							return;
						}
						wireEpoch = raw.fencingEpoch;
						wireServerHello = raw.serverHello as NegotiationHandshake;
						const client: UdsClient = {
							endpointPath: options.endpointPath,
							get fencingEpoch() {
								return wireEpoch;
							},
							get serverHello() {
								return wireServerHello as NegotiationHandshake;
							},
							rpc: <T>(method: string, params?: unknown, fencingEpoch?: number) =>
								rpc<T>(socket, pending, () => closed, () => wireEpoch, () => nextId++, rpcTimeoutMs, method, params, fencingEpoch),
							close: () => {
								closed = true;
								rejectPending(controlUnavailable(`control client for ${options.endpointPath} is closed`));
								socket.destroy();
							},
						};
						resolve(client);
					} else {
						socket.destroy();
						reject(errorFromEnvelope(raw.error as ErrorEnvelope));
					}
					return;
				}
				if (raw.type === "rpc-result") {
					const id = raw.id;
					if (typeof id !== "number") continue;
					const entry = pending.get(id);
					if (!entry) continue;
					pending.delete(id);
					if (raw.ok === true) entry.resolve(raw.result);
					else entry.reject(errorFromEnvelope(raw.error as ErrorEnvelope));
					return;
				}
			}
		});

		socket.on("close", () => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(controlUnavailable(`control endpoint ${options.endpointPath} closed before hello`));
				return;
			}
			rejectPending(controlUnavailable(`control endpoint ${options.endpointPath} closed`));
		});
	});
}

function rpc<T>(
	socket: net.Socket,
	pending: Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>,
	isClosed: () => boolean,
	getEpoch: () => number,
	nextId: () => number,
	rpcTimeoutMs: number,
	method: string,
	params: unknown,
	fencingEpoch?: number,
): Promise<T> {
	if (isClosed()) {
		return Promise.reject(controlUnavailable(`control client for ${socket.remoteAddress ?? "unix"} is closed`));
	}
	const id = nextId();
	return new Promise<T>((resolve, reject) => {
		const rpcTimer = setTimeout(() => {
			pending.delete(id);
			reject(controlUnavailable(`control RPC ${JSON.stringify(method)} timed out after ${rpcTimeoutMs}ms`));
		}, rpcTimeoutMs);
		pending.set(id, {
			resolve: (value: unknown) => {
				clearTimeout(rpcTimer);
				resolve(value as T);
			},
			reject: (error: unknown) => {
				clearTimeout(rpcTimer);
				reject(error);
			},
		});
		const frame: UdsFrame = {
			type: "rpc",
			id,
			method,
			...(params !== undefined ? { params } : {}),
			fencingEpoch: fencingEpoch ?? getEpoch(),
		};
		try {
			socket.write(encodeFrame(frame));
		} catch (error) {
			pending.delete(id);
			clearTimeout(rpcTimer);
			reject(controlUnavailable(`control RPC ${JSON.stringify(method)} could not be sent: ${error instanceof Error ? error.message : String(error)}`));
		}
	});
}
