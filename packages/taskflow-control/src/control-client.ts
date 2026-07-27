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
	/** Connection-bound local principal label; not an OS-authenticated identity. */
	principal?: string;
	/** Bind an attach RPC to the exact epoch advertised by its singleton record. */
	expectedFencingEpoch?: number;
	/** Attach clients may only route mutations to a verified writer endpoint. */
	expectedRole?: "writer" | "attach";
};

function isValidLocalPrincipalLabel(p: string): boolean {
	// Reject remote-looking / injection-style labels. The UDS peer still needs an
	// OS-backed or adapter-backed authentication design before this is GA.
	if (!p || p.length > 128) return false;
	if (/[\r\n\0]/.test(p)) return false;
	if (/^https?:\/\//i.test(p)) return false;
	return true;
}

function isValidHello(hello: ControlClientHello): boolean {
	return (
		hello.protocolMajor === CONTROL_PROTOCOL_MAJOR &&
		Number.isSafeInteger(hello.fencingEpoch) &&
		hello.fencingEpoch >= 0 &&
		(hello.role === "writer" || hello.role === "attach") &&
		hello.capabilities.every((capability) => typeof capability === "string")
	);
}

function helloMatchesExpectedEndpoint(hello: ControlClientHello, opts: ControlClientOptions): boolean {
	return (
		isValidHello(hello) &&
		(opts.expectedFencingEpoch === undefined ||
			hello.fencingEpoch === opts.expectedFencingEpoch) &&
		(opts.expectedRole === undefined || hello.role === opts.expectedRole)
	);
}


function parseHello(message: Record<string, unknown>): ControlClientHello | null {
	if (
		!Array.isArray(message.capabilities) ||
		!message.capabilities.every((capability) => typeof capability === "string")
	) {
		return null;
	}
	return {
		protocolMajor: Number(message.protocolMajor ?? 0),
		fencingEpoch: Number(message.fencingEpoch ?? -1),
		role: String(message.role ?? ""),
		capabilities: message.capabilities,
	};
}

function endpointIdentityError(hello: ControlClientHello | null): Error & { code: string } {
	const detail = hello
		? `protocol=${hello.protocolMajor}, role=${hello.role}, epoch=${hello.fencingEpoch}`
		: "malformed hello";
	return Object.assign(
		new Error(
			`TF_BOOTSTRAP_FAILED: control endpoint identity mismatch (${detail})`,
		),
		{ code: "TF_BOOTSTRAP_FAILED" },
	);
}

/**
 * One-shot hello + RPC over taskflowd UDS.
 * Fails closed if hello missing, protocol mismatch, or an invalid principal
 * label. This binds an RPC to its hello label; it does not authenticate the
 * local OS principal (P13 remains partial).
 */
export async function controlClientRpc(
	method: string,
	params: Record<string, unknown>,
	opts: ControlClientOptions = {},
): Promise<unknown> {
	const principal = String(opts.principal ?? params.principal ?? "cli");
	if (!isValidLocalPrincipalLabel(principal)) {
		throw Object.assign(new Error("TF_POLICY_DENIED: invalid principal label"), {
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
						const hello = parseHello(msg);
						if (!hello || !helloMatchesExpectedEndpoint(hello, opts)) {
							clearTimeout(timer);
							sock.end();
							reject(endpointIdentityError(hello));
							return;
						}
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
					const hello = parseHello(msg);
					clearTimeout(timer);
					sock.end();
					resolve(hello && helloMatchesExpectedEndpoint(hello, opts) ? hello : null);
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
