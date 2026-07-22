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
import type { ControlHost } from "taskflow-control";

export const PROTOCOL_MAJOR = 1;

export interface UdsServerOptions {
	socketPath: string;
	fencingEpoch: number;
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

	const server = net.createServer((socket) => {
		let acc = "";
		socket.on("data", (chunk) => {
			acc += chunk.toString("utf8");
			let idx: number;
			while ((idx = acc.indexOf("\n")) >= 0) {
				const line = acc.slice(0, idx).trim();
				acc = acc.slice(idx + 1);
				if (!line) continue;
				void handleLine(socket, line, opts);
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(opts.socketPath, () => resolve());
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

async function handleLine(
	socket: net.Socket,
	line: string,
	opts: UdsServerOptions,
): Promise<void> {
	let msg: Record<string, unknown>;
	try {
		msg = parseLine(line) as Record<string, unknown>;
	} catch {
		socket.write(JSON.stringify({ type: "error", message: "invalid json" }) + "\n");
		return;
	}

	if (msg.type === "hello") {
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
		socket.write(
			JSON.stringify({
				type: "hello-ok",
				protocolMajor: PROTOCOL_MAJOR,
				fencingEpoch: opts.fencingEpoch,
				role: opts.role,
				capabilities: ["status", "wait", "admit", "cancel"],
			}) + "\n",
		);
		return;
	}

	if (msg.type === "rpc") {
		const id = msg.id;
		const method = String(msg.method ?? "");
		const params = (msg.params ?? {}) as Record<string, unknown>;
		try {
			if (method === "status") {
				const host = opts.getHost(params.projectId as string | undefined);
				if (!host) {
					socket.write(
						JSON.stringify({
							type: "rpc-error",
							id,
							code: "TF_NOT_FOUND",
							message: "no mounted host",
						}) + "\n",
					);
					return;
				}
				const snap = host.getSnapshot(String(params.runId ?? ""));
				socket.write(JSON.stringify({ type: "rpc-result", id, result: snap }) + "\n");
				return;
			}
			if (method === "admit" || method === "cancel") {
				if (opts.role !== "writer") {
					socket.write(
						JSON.stringify({
							type: "rpc-error",
							id,
							code: "TF_AUTHORITY_REVOKED",
							message: "attach cannot mutate",
						}) + "\n",
					);
					return;
				}
				const host = opts.getHost(params.projectId as string | undefined);
				if (!host) {
					socket.write(
						JSON.stringify({
							type: "rpc-error",
							id,
							code: "TF_NOT_FOUND",
							message: "no mounted host",
						}) + "\n",
					);
					return;
				}
				if (method === "admit") {
					const result = await host.admitAndRun({
						program: params.program,
						commandId: params.commandId as string | undefined,
						callerPrincipal: String(params.principal ?? "uds"),
					});
					socket.write(JSON.stringify({ type: "rpc-result", id, result }) + "\n");
					return;
				}
				const result = await host.cancel(String(params.runId ?? ""));
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
			socket.write(
				JSON.stringify({
					type: "rpc-error",
					id,
					code: "TF_COMMAND_FAILED",
					message: e instanceof Error ? e.message : String(e),
				}) + "\n",
			);
		}
	}
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
