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
import type { ControlHost } from "taskflow-control";

export const PROTOCOL_MAJOR = 1;

export interface UdsServerOptions {
	socketPath: string;
	fencingEpoch: number;
	/** Resolve ControlHost by projectId or default first mount. */
	getHost: (projectId?: string) => ControlHost | null;
	/** Writer role only serves mutations. */
	role: "writer" | "attach";
	/** Optional owner-process WebGateway lifecycle controls. */
	webUi?: {
		start(
			params: Record<string, unknown>,
			principal: string,
		): Promise<unknown>;
		stop(
			params: Record<string, unknown>,
			principal: string,
		): Promise<unknown>;
		status(
			params: Record<string, unknown>,
			principal: string,
		): Promise<unknown> | unknown;
	};
	/** Project-local standalone socket exposes only Web UI lifecycle RPCs. */
	webUiOnly?: boolean;
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

	// The endpoint may live in a deterministic temporary fallback directory
	// when TASKFLOW_HOME is too deep for sockaddr_un. Directory ownership and
	// privacy are therefore authority checks, not best-effort decoration.
	const dir = path.dirname(opts.socketPath);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const directoryStat = fs.lstatSync(dir);
	if (
		directoryStat.isSymbolicLink() ||
		!directoryStat.isDirectory() ||
		(typeof process.getuid === "function" &&
			directoryStat.uid !== process.getuid())
	) {
		throw new Error(
			"TF_BOOTSTRAP_FAILED: control socket directory is not an owner-controlled directory",
		);
	}
	fs.chmodSync(dir, 0o700);

	const server = net.createServer((socket) => {
		let acc = "";
		/** Per-connection: hello must succeed before any RPC (mandate 4). */
		const conn = { helloOk: false, principal: "anonymous" as string };
		socket.on("data", (chunk) => {
			acc += chunk.toString("utf8");
			let idx: number;
			while ((idx = acc.indexOf("\n")) >= 0) {
				const line = acc.slice(0, idx).trim();
				acc = acc.slice(idx + 1);
				if (!line) continue;
				void handleLine(socket, line, opts, conn);
			}
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

function isTrustedPrincipal(p: string): boolean {
	if (!p || p.length > 128) return false;
	if (/[\r\n\0]/.test(p)) return false;
	if (/^https?:\/\//i.test(p)) return false;
	return true;
}

type ConnState = { helloOk: boolean; principal: string };

async function handleLine(
	socket: net.Socket,
	line: string,
	opts: UdsServerOptions,
	conn: ConnState,
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
		const principal = String(msg.principal ?? msg.clientId ?? "anonymous");
		if (!isTrustedPrincipal(principal)) {
			socket.write(
				JSON.stringify({
					type: "hello-error",
					code: "TF_POLICY_DENIED",
					message: "untrusted principal",
				}) + "\n",
			);
			return;
		}
		conn.helloOk = true;
		conn.principal = principal;
		socket.write(
			JSON.stringify({
				type: "hello-ok",
				protocolMajor: PROTOCOL_MAJOR,
				fencingEpoch: opts.fencingEpoch,
				role: opts.role,
				capabilities: [
					...(opts.webUiOnly
						? []
						: [
								"status",
								"wait",
								"admit",
								"cancel",
								"approval",
							]),
					...(opts.webUi
						? ["ui-start", "ui-stop", "ui-status"]
						: []),
				],
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
		const method = String(msg.method ?? "");
		const params = (msg.params ?? {}) as Record<string, unknown>;
		// Reject untrusted principal strings on every RPC
		const principal = String(params.principal ?? conn.principal);
		if (!isTrustedPrincipal(principal)) {
			socket.write(
				JSON.stringify({
					type: "rpc-error",
					id,
					code: "TF_POLICY_DENIED",
					message: "untrusted principal",
				}) + "\n",
			);
			return;
		}
		try {
			if (
				method === "ui-start" ||
				method === "ui-stop" ||
				method === "ui-status"
			) {
				if (opts.role !== "writer" || !opts.webUi) {
					socket.write(
						JSON.stringify({
							type: "rpc-error",
							id,
							code: "TF_FEATURE_REQUIRED",
							message:
								"the active singleton does not expose WebGateway lifecycle control",
						}) + "\n",
					);
					return;
				}
				const result =
					method === "ui-start"
						? await opts.webUi.start(params, principal)
						: method === "ui-stop"
							? await opts.webUi.stop(params, principal)
							: await opts.webUi.status(params, principal);
				socket.write(
					JSON.stringify({
						type: "rpc-result",
						id,
						result,
					}) + "\n",
				);
				return;
			}
			if (opts.webUiOnly) {
				socket.write(
					JSON.stringify({
						type: "rpc-error",
						id,
						code: "TF_INVALID_ARGUMENT",
						message: `unknown method ${method}`,
					}) + "\n",
				);
				return;
			}
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
