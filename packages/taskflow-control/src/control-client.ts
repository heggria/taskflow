/**
 * ControlClient — UDS client for attach peers (mandate 4).
 * Hello required before any RPC; exact projectId on admit when provided.
 */
import * as net from "node:net";
import { udsPath } from "./paths.ts";

export const CONTROL_PROTOCOL_MAJOR = 1;

export type ControlClientHello = {
	protocolMajor: number;
	fencingEpoch: number;
	role: string;
	capabilities: string[];
};

export type ControlClientOptions = {
	socketPath?: string;
	env?: NodeJS.ProcessEnv;
	clientId?: string;
	timeoutMs?: number;
	/** Authenticated local principal — rejected if looks remote/untrusted. */
	principal?: string;
};

function isTrustedLocalPrincipal(p: string): boolean {
	// Reject remote-looking / injection-style principals
	if (!p || p.length > 128) return false;
	if (/[\r\n\0]/.test(p)) return false;
	if (/^https?:\/\//i.test(p)) return false;
	return true;
}

/**
 * One-shot hello + RPC over taskflowd UDS.
 * Fails closed if hello missing, protocol mismatch, or untrusted principal.
 */
export async function controlClientRpc(
	method: string,
	params: Record<string, unknown>,
	opts: ControlClientOptions = {},
): Promise<unknown> {
	const principal = String(opts.principal ?? params.principal ?? "cli");
	if (!isTrustedLocalPrincipal(principal)) {
		throw Object.assign(new Error("TF_POLICY_DENIED: untrusted principal"), {
			code: "TF_POLICY_DENIED",
		});
	}
	const socketPath = opts.socketPath ?? udsPath(opts.env ?? process.env);
	const timeoutMs = opts.timeoutMs ?? 30_000;
	const clientId = opts.clientId ?? `cli-${process.pid}`;

	return new Promise((resolve, reject) => {
		const sock = net.connect(socketPath);
		let acc = "";
		let phase: "hello" | "rpc" = "hello";
		const rpcId = `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error("TF_COMMAND_FAILED: control client rpc timeout"));
		}, timeoutMs);

		sock.on("connect", () => {
			sock.write(
				JSON.stringify({
					type: "hello",
					protocolMajor: CONTROL_PROTOCOL_MAJOR,
					clientId,
					principal,
				}) + "\n",
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
				if (phase === "hello") {
					if (msg.type === "hello-ok") {
						phase = "rpc";
						sock.write(
							JSON.stringify({
								type: "rpc",
								id: rpcId,
								method,
								params: { ...params, principal },
							}) + "\n",
						);
						continue;
					}
					if (msg.type === "hello-error") {
						clearTimeout(timer);
						sock.end();
						reject(
							Object.assign(new Error(String(msg.message ?? "hello failed")), {
								code: msg.code ?? "TF_PROTOCOL_INCOMPATIBLE",
							}),
						);
						return;
					}
					continue;
				}
				if (msg.type === "rpc-result" && msg.id === rpcId) {
					clearTimeout(timer);
					sock.end();
					resolve(msg.result);
					return;
				}
				if (msg.type === "rpc-error" && msg.id === rpcId) {
					clearTimeout(timer);
					sock.end();
					reject(
						Object.assign(new Error(String(msg.message ?? "rpc error")), {
							code: msg.code ?? "TF_COMMAND_FAILED",
						}),
					);
					return;
				}
			}
		});

		sock.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
	});
}

/** Probe whether a daemon UDS endpoint accepts hello. */
export async function probeControlEndpoint(
	opts: ControlClientOptions = {},
): Promise<ControlClientHello | null> {
	const socketPath = opts.socketPath ?? udsPath(opts.env ?? process.env);
	return new Promise((resolve) => {
		const sock = net.connect(socketPath);
		let acc = "";
		const timer = setTimeout(() => {
			sock.destroy();
			resolve(null);
		}, opts.timeoutMs ?? 2_000);
		sock.on("connect", () => {
			sock.write(
				JSON.stringify({
					type: "hello",
					protocolMajor: CONTROL_PROTOCOL_MAJOR,
					clientId: opts.clientId ?? "probe",
				}) + "\n",
			);
		});
		sock.on("data", (chunk) => {
			acc += chunk.toString("utf8");
			const line = acc.split("\n")[0];
			if (!line) return;
			try {
				const msg = JSON.parse(line) as Record<string, unknown>;
				if (msg.type === "hello-ok") {
					clearTimeout(timer);
					sock.end();
					resolve({
						protocolMajor: Number(msg.protocolMajor ?? 0),
						fencingEpoch: Number(msg.fencingEpoch ?? 0),
						role: String(msg.role ?? ""),
						capabilities: Array.isArray(msg.capabilities)
							? (msg.capabilities as string[])
							: [],
					});
				} else if (msg.type === "hello-error") {
					clearTimeout(timer);
					sock.end();
					resolve(null);
				}
			} catch {
				/* keep reading */
			}
		});
		sock.on("error", () => {
			clearTimeout(timer);
			resolve(null);
		});
	});
}
