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
import { Value } from "typebox/value";
import { bootstrapFailed, ControlError, errorFromEnvelope, errorToEnvelope, protocolError } from "./errors.ts";
import { createHelloGate } from "./hello.ts";
import { ErrorEnvelopeSchema, NegotiationHandshakeSchema, type ErrorEnvelope, type NegotiationHandshake } from "./schema/transport.ts";

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

/** Per-frame UTF-8 limit; large plans/evidence can use up to 16 MiB by default. */
export const UDS_MAX_FRAME_BYTES = 16 * 1024 * 1024;

function frameLimit(value = UDS_MAX_FRAME_BYTES): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("maxFrameBytes must be a positive safe integer");
	return value;
}

function isWireCounter(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function encodeFrame(frame: UdsFrame, maxBytes = UDS_MAX_FRAME_BYTES): string {
	const encoded = JSON.stringify(frame);
	if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error(`control wire frame exceeds ${maxBytes} bytes`);
	return encoded + "\n";
}

/** Bound each frame before appending; coalesced frames have independent budgets. */
function frameReader(maxBytes: number) {
	let buffer = "";
	let bytes = 0;
	const clear = (): void => { buffer = ""; bytes = 0; };
	return {
		clear,
		push(chunk: string, onLine: (line: string) => boolean): void {
			let start = 0;
			while (start < chunk.length) {
				const end = chunk.indexOf("\n", start);
				const part = chunk.slice(start, end < 0 ? undefined : end);
				const addedBytes = Buffer.byteLength(part, "utf8");
				if (bytes + addedBytes > maxBytes) throw new Error(`control wire frame exceeds ${maxBytes} bytes`);
				buffer += part;
				bytes += addedBytes;
				if (end < 0) return;
				const line = buffer.trim();
				clear();
				if (line && !onLine(line)) return;
				start = end + 1;
			}
		},
	};
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
	/** Absolute deadline for the first valid hello (default 5s). */
	helloTimeoutMs?: number;
	/** Maximum UTF-8 bytes per frame, excluding newline (default 16 MiB). */
	maxFrameBytes?: number;
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
	frameLimit(options.maxFrameBytes);
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
	const maxFrameBytes = frameLimit(options.maxFrameBytes);
	const reader = frameReader(maxFrameBytes);
	let destroyed = false;
	const helloTimer = setTimeout(() => {
		destroyed = true;
		reader.clear();
		socket.destroy();
	}, options.helloTimeoutMs ?? 5_000);

	const send = (frame: UdsFrame): void => {
		if (destroyed) return;
		socket.write(encodeFrame(frame, maxFrameBytes));
	};
	const failClosed = (frame: UdsFrame): void => {
		try {
			send(frame);
		} finally {
			destroyed = true;
			reader.clear();
			socket.destroy();
		}
	};

	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		if (destroyed) return;
		try {
			reader.push(chunk, (line) => {
				const raw = parseFrame(line);
				// Synchronous negotiation completes before a pipelined frame is read.
				void handleFrame(raw).catch(() => {
					destroyed = true;
					reader.clear();
					socket.destroy();
				});
				return !destroyed;
			});
		} catch (error) {
			try {
				failClosed({ type: greeted ? "rpc-result" : "hello-ack", ...(greeted ? { id: 0 } : {}), ok: false, error: errorToEnvelope(error) } as UdsFrame);
			} catch {
				// Even encoding a rejection must remain local to the offending socket.
				socket.destroy();
			}
		}
	});
	socket.on("close", () => {
		clearTimeout(helloTimer);
		destroyed = true;
		reader.clear();
	});
	socket.on("error", () => {
		destroyed = true;
		reader.clear();
		socket.destroy();
	});

	const handleFrame = async (raw: Record<string, unknown>): Promise<void> => {
		if (destroyed) return;
		try {
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
				const fencingEpoch = options.getFencingEpoch();
				greeted = true;
				clearTimeout(helloTimer);
				send({
					type: "hello-ack",
					ok: true,
					serverHello: gate.serverHello,
					fencingEpoch,
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
				if (!isWireCounter(id)) {
					failClosed({ type: "rpc-result", id: 0, ok: false, error: errorToEnvelope(protocolError("rpc frame requires a non-negative safe integer id")) });
					return;
				}
				const method = typeof raw.method === "string" ? raw.method : "";
				if (!method) {
					failClosed({ type: "rpc-result", id, ok: false, error: errorToEnvelope(protocolError("rpc frame requires a method name")) });
					return;
				}
				// Preserve the legacy omitted-epoch default, not malformed values.
				const fencingEpoch = raw.fencingEpoch === undefined ? 0 : raw.fencingEpoch;
				if (!isWireCounter(fencingEpoch)) {
					failClosed({ type: "rpc-result", id, ok: false, error: errorToEnvelope(protocolError("rpc frame requires a non-negative safe integer fencingEpoch")) });
					return;
				}
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
		} catch (error) {
			// Catch synchronous negotiation failures before the data loop can
			// dispatch another pipelined frame on this failed connection.
			failClosed({
				type: greeted ? "rpc-result" : "hello-ack",
				...(greeted ? { id: typeof raw.id === "number" ? raw.id : 0 } : {}),
				ok: false,
				error: errorToEnvelope(error),
			} as UdsFrame);
		}
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
	/** Maximum UTF-8 bytes per frame, excluding newline (default 16 MiB). */
	maxFrameBytes?: number;
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
	const maxFrameBytes = frameLimit(options.maxFrameBytes);

	return new Promise((resolve, reject) => {
		const socket = net.connect(options.endpointPath);
		const reader = frameReader(maxFrameBytes);
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

		const failClosed = (error: ControlError): void => {
			closed = true;
			reader.clear();
			clearTimeout(timer);
			if (!settled) { settled = true; reject(error); }
			rejectPending(error);
			socket.destroy();
		};

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			rejectPending(controlUnavailable(`control endpoint ${options.endpointPath} did not answer hello within ${connectTimeoutMs}ms`));
			socket.destroy();
			reject(controlUnavailable(`control endpoint ${options.endpointPath} did not answer hello within ${connectTimeoutMs}ms`));
		}, connectTimeoutMs);

		socket.on("connect", () => {
			try {
				socket.write(encodeFrame({ type: "hello", hello: options.clientHello }, maxFrameBytes));
			} catch (error) {
				failClosed(controlUnavailable(`control hello could not be sent: ${error instanceof Error ? error.message : String(error)}`));
			}
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
			if (closed) return;
			try {
				reader.push(chunk, (line) => {
					const raw = parseFrame(line);
					if (raw.type !== "hello-ack" && raw.type !== "rpc-result") throw new Error("unexpected frame type");
					if (typeof raw.ok !== "boolean" || (raw.ok === false && !Value.Check(ErrorEnvelopeSchema, raw.error))) {
						throw new Error("failure reply must match ErrorEnvelope and have a boolean ok");
					}
					// Reject opposite-branch members without forbidding future metadata.
					// Void successful RPCs may omit result, and null is a valid result.
					if ((raw.ok && Object.hasOwn(raw, "error")) || (!raw.ok && (
						raw.type === "hello-ack"
							? Object.hasOwn(raw, "serverHello") || Object.hasOwn(raw, "fencingEpoch")
							: Object.hasOwn(raw, "result")
					))) throw new Error("reply contains contradictory success and failure members");
					if (raw.type === "hello-ack") {
						if (settled) throw new Error("duplicate hello-ack");
						if (raw.ok === false) {
							failClosed(errorFromEnvelope(raw.error as ErrorEnvelope));
							return false;
						}
						if (!isWireCounter(raw.fencingEpoch) || !Value.Check(NegotiationHandshakeSchema, raw.serverHello)) {
							throw new Error("malformed hello-ack");
						}
						settled = true;
						clearTimeout(timer);
						wireEpoch = raw.fencingEpoch as number;
						wireServerHello = raw.serverHello as NegotiationHandshake;
						resolve({
							endpointPath: options.endpointPath,
							get fencingEpoch() { return wireEpoch; },
							get serverHello() { return wireServerHello as NegotiationHandshake; },
							rpc: <T>(method: string, params?: unknown, fencingEpoch?: number) =>
								rpc<T>(socket, pending, () => closed, () => wireEpoch, () => nextId++, rpcTimeoutMs, maxFrameBytes, method, params, fencingEpoch),
							close: () => failClosed(controlUnavailable(`control client for ${options.endpointPath} is closed`)),
						});
						return true;
					}
					if (!settled || !isWireCounter(raw.id)) throw new Error("malformed rpc-result");
					const id = raw.id as number;
					const entry = pending.get(id);
					if (entry) {
						pending.delete(id);
						if (raw.ok === true) entry.resolve(raw.result);
						else entry.reject(errorFromEnvelope(raw.error as ErrorEnvelope));
					}
					return true;
				});
			} catch (error) {
				failClosed(controlUnavailable(`control endpoint ${options.endpointPath} sent a malformed frame: ${error instanceof Error ? error.message : String(error)}`));
			}
		});

		socket.on("close", () => {
			closed = true;
			reader.clear();
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
	maxFrameBytes: number,
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
			socket.write(encodeFrame(frame, maxFrameBytes));
		} catch (error) {
			pending.delete(id);
			clearTimeout(rpcTimer);
			reject(controlUnavailable(`control RPC ${JSON.stringify(method)} could not be sent: ${error instanceof Error ? error.message : String(error)}`));
		}
	});
}
