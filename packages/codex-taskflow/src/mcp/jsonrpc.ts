/**
 * Minimal, dependency-free stdio JSON-RPC 2.0 transport for an MCP server.
 *
 * pi-taskflow ships ZERO runtime dependencies (a core selling point), so we do
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
} as const;

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
export type RpcHandler = (params: unknown) => Promise<unknown> | unknown;

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

	const write = (obj: unknown) => {
		output.write(JSON.stringify(obj) + "\n");
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

		const handler = handlers[msg.method];
		if (!handler) {
			// Unknown notifications are silently ignored (e.g. notifications/*).
			if (!isNotification) respondErr(id, { code: RPC.METHOD_NOT_FOUND, message: `Method not found: ${msg.method}` });
			return;
		}

		try {
			const result = await handler(msg.params);
			if (!isNotification) respondOk(id, result);
		} catch (e) {
			if (isNotification) return; // can't report errors for notifications
			if (e instanceof RpcError) {
				respondErr(id, { code: e.code, message: e.message, data: e.data });
			} else {
				const message = e instanceof Error ? e.message : String(e);
				respondErr(id, { code: RPC.INTERNAL_ERROR, message });
			}
		}
	};

	return new Promise<void>((resolve) => {
		let buffer = "";
		// Serialize line handling so responses are emitted in request order even
		// when handlers are async (MCP clients tolerate interleaving, but ordered
		// output is simpler to reason about and test).
		let chain: Promise<void> = Promise.resolve();
		input.on("data", (data: Buffer | string) => {
			buffer += data.toString();
			let i: number;
			while ((i = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, i);
				buffer = buffer.slice(i + 1);
				chain = chain.then(() => handleLine(line));
			}
		});
		input.on("end", () => {
			chain = chain.then(() => {
				if (buffer.trim()) return handleLine(buffer);
			}).then(() => resolve());
		});
		input.on("close", () => resolve());
	});
}
