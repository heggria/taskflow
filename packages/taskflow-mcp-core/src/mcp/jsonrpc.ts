/**
 * Minimal, dependency-free stdio JSON-RPC 2.0 transport for an MCP server.
 *
 * taskflow-core ships ZERO runtime dependencies (a core selling point), so we do
 * NOT pull in `@modelcontextprotocol/sdk`. MCP's stdio transport is just
 * newline-delimited JSON-RPC 2.0 over stdin/stdout — small enough to implement
 * on Node built-ins. This module handles framing + dispatch only; the MCP
 * method semantics live in server.ts.
 *
 * Wire format: one JSON object per line on stdin (a request or notification),
 * one JSON object per line on stdout (a response). Notifications (no `id`) get
 * no response. Anything we can't parse is answered with a JSON-RPC parse error
 * when an id is recoverable, else dropped (never crash the loop).
 */

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: unknown;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

/** Standard JSON-RPC / MCP error codes we use. */
export const RPC = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
	REQUEST_CANCELLED: -32800,
} as const;

/** Maximum time stdio shutdown waits for request wrappers after aborting them.
 * Non-cooperative user handlers are detached (their eventual rejection is
 * observed) so a broken handler can never hold the MCP process open forever. */
export const TRANSPORT_SHUTDOWN_GRACE_MS = 100;

/** Thrown by a handler to return a structured JSON-RPC error to the client. */
export class RpcError extends Error {
	code: number;
	data?: unknown;
	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "RpcError";
		this.code = code;
		this.data = data;
	}
}

/**
 * A method handler. Return a JSON-serializable result, or throw `RpcError` for
 * a structured failure. Returning `undefined` for a request (has id) sends
 * `result: null`; for a notification it is ignored.
 */
export interface RpcContext {
	/** JSON-RPC request id. Notifications use null. */
	requestId: string | number | null;
	/** Aborted by MCP `notifications/cancelled` or transport disconnect. */
	signal: AbortSignal;
}

export type RpcHandler = (params: unknown, context: RpcContext) => Promise<unknown> | unknown;

/**
 * Run a JSON-RPC stdio loop over the given streams (defaults to process
 * stdin/stdout). Resolves when the input stream ends (client disconnect).
 */
export function serveStdio(
	handlers: Record<string, RpcHandler>,
	io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): Promise<void> {
	const input: NodeJS.ReadableStream = io.input ?? process.stdin;
	const output: NodeJS.WritableStream = io.output ?? process.stdout;
	const activeRequests = new Map<string, AbortController>();
	const activeControllers = new Set<AbortController>();
	const pending = new Set<Promise<void>>();
	const requestKey = (id: string | number): string => `${typeof id}:${String(id)}`;
	let transportClosed = false;
	let requestTransportTeardown: (() => void) | undefined;

	const write = (obj: unknown) => {
		if (transportClosed) return;
		try {
			output.write(JSON.stringify(obj) + "\n");
		} catch {
			// Some Writable implementations throw synchronously instead of reporting
			// failures through their callback. Route both forms through the same
			// teardown so active work is aborted and shutdown remains bounded.
			requestTransportTeardown?.();
		}
	};

	const respondOk = (id: string | number | null, result: unknown) => {
		write({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
	};
	const respondErr = (id: string | number | null, err: JsonRpcError) => {
		write({ jsonrpc: "2.0", id, error: err });
	};

	const handleLine = async (line: string): Promise<void> => {
		const trimmed = line.trim();
		if (!trimmed) return;

		let msg: JsonRpcRequest;
		try {
			msg = JSON.parse(trimmed);
		} catch {
			// No recoverable id — per JSON-RPC, a parse error uses id:null.
			respondErr(null, { code: RPC.PARSE_ERROR, message: "Parse error" });
			return;
		}

		const isNotification = msg.id === undefined || msg.id === null;
		const id = (msg.id ?? null) as string | number | null;

		if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
			if (!isNotification) respondErr(id, { code: RPC.INVALID_REQUEST, message: "Invalid Request" });
			return;
		}

		// MCP cancellation is a notification aimed at an in-flight request. Handle
		// it in the transport so every method automatically receives the same
		// AbortSignal and hosts do not need bespoke cancellation handlers.
		if (msg.method === "notifications/cancelled") {
			const params = msg.params as { requestId?: unknown } | undefined;
			const cancelledId = params?.requestId;
			if (typeof cancelledId === "string" || typeof cancelledId === "number") {
				activeRequests.get(requestKey(cancelledId))?.abort();
			}
			return;
		}

		const handler = handlers[msg.method];
		if (!handler) {
			// Unknown notifications are silently ignored (e.g. notifications/*).
			if (!isNotification) respondErr(id, { code: RPC.METHOD_NOT_FOUND, message: `Method not found: ${msg.method}` });
			return;
		}

		const key = !isNotification && id !== null ? requestKey(id) : undefined;
		if (key) {
			const duplicate = activeRequests.get(key);
			if (duplicate) {
				// JSON-RPC ids identify one in-flight request. Never overwrite the
				// original controller: abort the ambiguous first request and ignore the
				// duplicate, yielding one deterministic cancellation response.
				duplicate.abort();
				return;
			}
		}
		const controller = new AbortController();
		activeControllers.add(controller);
		if (key) activeRequests.set(key, controller);
		const ABORTED = Symbol("aborted");
		let abortListener: (() => void) | undefined;
		const aborted = new Promise<typeof ABORTED>((resolve) => {
			abortListener = () => resolve(ABORTED);
			if (controller.signal.aborted) resolve(ABORTED);
			else controller.signal.addEventListener("abort", abortListener, { once: true });
		});
		// Invoke immediately so synchronous protocol handlers can complete before a
		// following stdin EOF, but normalize throws and async results into one promise.
		let handlerPromise: Promise<unknown>;
		try {
			handlerPromise = Promise.resolve(handler(msg.params, { requestId: id, signal: controller.signal }));
		} catch (error) {
			handlerPromise = Promise.reject(error);
		}
		// Promise.race installs a rejection observer on handlerPromise. If abort wins,
		// a later handler rejection is consumed and can never become unhandled.
		try {
			const result = await Promise.race([handlerPromise, aborted]);
			if (!isNotification) {
				if (result === ABORTED || controller.signal.aborted)
					respondErr(id, { code: RPC.REQUEST_CANCELLED, message: "Request cancelled" });
				else respondOk(id, result);
			}
		} catch (e) {
			if (isNotification) return; // can't report errors for notifications
			if (controller.signal.aborted) {
				respondErr(id, { code: RPC.REQUEST_CANCELLED, message: "Request cancelled" });
			} else if (e instanceof RpcError) {
				respondErr(id, { code: e.code, message: e.message, data: e.data });
			} else {
				const message = e instanceof Error ? e.message : String(e);
				respondErr(id, { code: RPC.INTERNAL_ERROR, message });
			}
		} finally {
			if (abortListener) controller.signal.removeEventListener("abort", abortListener);
			activeControllers.delete(controller);
			if (key && activeRequests.get(key) === controller) activeRequests.delete(key);
		}
	};

	return new Promise<void>((resolve) => {
		let buffer = "";
		let finishPromise: Promise<void> | undefined;
		let resolved = false;
		const track = (promise: Promise<void>) => {
			pending.add(promise);
			void promise.then(
				() => pending.delete(promise),
				() => pending.delete(promise),
			);
		};
		const removeTransportListeners = () => {
			input.removeListener("data", onData);
			input.removeListener("end", onEnd);
			input.removeListener("close", onClose);
			input.removeListener("error", onInputError);
			output.removeListener("error", onOutputError);
			requestTransportTeardown = undefined;
		};
		const finish = (): Promise<void> => {
			transportClosed = true;
			for (const controller of activeControllers) controller.abort();
			if (!finishPromise) {
				finishPromise = new Promise<void>((done) => {
					let completed = false;
					const settle = () => {
						if (completed) return;
						completed = true;
						clearTimeout(timer);
						done();
					};
					const timer = setTimeout(settle, TRANSPORT_SHUTDOWN_GRACE_MS);
					void Promise.allSettled([...pending]).then(settle);
				}).then(() => {
					removeTransportListeners();
					if (!resolved) {
						resolved = true;
						resolve();
					}
				});
			}
			return finishPromise;
		};
		const teardown = () => void finish();
		const onData = (data: Buffer | string) => {
			if (transportClosed) return;
			buffer += data.toString();
			let i: number;
			while ((i = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, i);
				buffer = buffer.slice(i + 1);
				track(handleLine(line));
			}
		};
		const onEnd = () => {
			if (transportClosed) return;
			if (buffer.trim()) track(handleLine(buffer));
			teardown();
		};
		const onClose = teardown;
		const onInputError = teardown;
		const onOutputError = teardown;
		requestTransportTeardown = teardown;
		input.on("data", onData);
		input.on("end", onEnd);
		input.on("close", onClose);
		input.on("error", onInputError);
		output.on("error", onOutputError);
	});
}
