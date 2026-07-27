/**
 * UDS hardening adversarial tests (mandate 4):
 * - RPC before hello denied, no side effect
 * - missing/unknown projectId denied
 * - writer + CLI attach via ControlClient succeeds over UDS
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { startDaemon } from "../src/daemon.ts";
import {
	MAX_UDS_CONNECTIONS,
	PROTOCOL_MAJOR,
	UDS_HELLO_DEADLINE_MS,
} from "../src/uds-server.ts";
import { runCli } from "../../taskflow-cli/src/cli.ts";
import { controlClientRpc as rpc, probeControlEndpoint } from "taskflow-control";

function temp(): { env: NodeJS.ProcessEnv; home: string; project: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-uds-h-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-uds-h-proj-"));
	return {
		home,
		project,
		env: { ...process.env, TASKFLOW_HOME: home },
		cleanup: () => {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(project, { recursive: true, force: true });
		},
	};
}

/** Raw RPC without hello — must be denied. */
function rpcWithoutHello(
	socketPath: string,
	method: string,
	params: Record<string, unknown>,
): Promise<{ type: string; code?: string; message?: string }> {
	return new Promise((resolve, reject) => {
		const sock = net.connect(socketPath);
		const id = "no-hello-1";
		let acc = "";
		sock.on("connect", () => {
			sock.write(JSON.stringify({ type: "rpc", id, method, params }) + "\n");
		});
		sock.on("data", (chunk) => {
			acc += chunk.toString("utf8");
			const line = acc.split("\n")[0];
			if (!line) return;
			try {
				const msg = JSON.parse(line) as {
					type: string;
					code?: string;
					message?: string;
				};
				sock.end();
				resolve(msg);
			} catch {
				/* keep */
			}
		});
		sock.on("error", reject);
		setTimeout(() => {
			sock.destroy();
			reject(new Error("timeout"));
		}, 5_000);
	});
}

/** A raw client is needed to prove that an RPC cannot switch hello's principal. */
function rpcWithHelloPrincipal(
	socketPath: string,
	helloPrincipal: string,
	method: unknown,
	params: unknown,
): Promise<{ type: string; code?: string; message?: string; result?: unknown }> {
	return new Promise((resolve, reject) => {
		const sock = net.connect(socketPath);
		const id = `principal-switch-${Date.now()}`;
		let phase: "hello" | "rpc" = "hello";
		let acc = "";
		let settled = false;
		const finish = (
			result: { type: string; code?: string; message?: string; result?: unknown },
		): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			sock.end();
			resolve(result);
		};
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			sock.destroy();
			reject(error);
		};
		const timer = setTimeout(() => fail(new Error("timeout")), 5_000);
		sock.on("connect", () => {
			sock.write(
				JSON.stringify({
					type: "hello",
					protocolMajor: PROTOCOL_MAJOR,
					clientId: "principal-switch-test",
					principal: helloPrincipal,
				}) + "\n",
			);
		});
		sock.on("data", (chunk) => {
			acc += chunk.toString("utf8");
			let newline: number;
			while ((newline = acc.indexOf("\n")) >= 0) {
				const line = acc.slice(0, newline);
				acc = acc.slice(newline + 1);
				let message: { type?: unknown; id?: unknown; code?: unknown; message?: unknown; result?: unknown };
				try {
					message = JSON.parse(line) as typeof message;
				} catch {
					continue;
				}
				if (phase === "hello" && message.type === "hello-ok") {
					phase = "rpc";
					sock.write(JSON.stringify({ type: "rpc", id, method, params }) + "\n");
					continue;
				}
				if (phase === "hello" && message.type === "hello-error") {
					finish({
						type: "hello-error",
						code: typeof message.code === "string" ? message.code : undefined,
						message: typeof message.message === "string" ? message.message : undefined,
					});
					return;
				}
				if (phase === "rpc" && message.id === id && (message.type === "rpc-result" || message.type === "rpc-error")) {
					finish({
						type: String(message.type),
						code: typeof message.code === "string" ? message.code : undefined,
						message: typeof message.message === "string" ? message.message : undefined,
						result: message.result,
					});
					return;
				}
			}
		});
		sock.on("error", (error) => fail(error));
	});
}

/** A second hello must not rotate a connection's already-bound principal. */
function rpcAfterRepeatedHello(
	socketPath: string,
	firstPrincipal: string,
	secondPrincipal: string,
	method: unknown,
	params: unknown,
): Promise<{
	secondHello: { type?: unknown; code?: unknown; message?: unknown };
	rpc: { type?: unknown; code?: unknown; message?: unknown; result?: unknown };
}> {
	return new Promise((resolve, reject) => {
		const sock = net.connect(socketPath);
		const id = `duplicate-hello-${Date.now()}`;
		let phase: "first-hello" | "second-hello" | "rpc" = "first-hello";
		let acc = "";
		let settled = false;
		let secondHello: { type?: unknown; code?: unknown; message?: unknown } | undefined;
		const finish = (rpc: { type?: unknown; code?: unknown; message?: unknown; result?: unknown }): void => {
			if (settled || !secondHello) return;
			settled = true;
			clearTimeout(timer);
			sock.end();
			resolve({ secondHello, rpc });
		};
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			sock.destroy();
			reject(error);
		};
		const timer = setTimeout(() => fail(new Error("timeout")), 5_000);
		const sendHello = (principal: string): void => {
			sock.write(
				JSON.stringify({
					type: "hello",
					protocolMajor: PROTOCOL_MAJOR,
					clientId: "duplicate-hello-test",
					principal,
				}) + "\n",
			);
		};
		sock.on("connect", () => sendHello(firstPrincipal));
		sock.on("data", (chunk) => {
			acc += chunk.toString("utf8");
			let newline: number;
			while ((newline = acc.indexOf("\n")) >= 0) {
				const line = acc.slice(0, newline);
				acc = acc.slice(newline + 1);
				let message: { type?: unknown; id?: unknown; code?: unknown; message?: unknown; result?: unknown };
				try {
					message = JSON.parse(line) as typeof message;
				} catch {
					continue;
				}
				if (phase === "first-hello") {
					if (message.type !== "hello-ok") {
						fail(new Error(`first hello failed: ${String(message.message ?? message.type)}`));
						return;
					}
					phase = "second-hello";
					sendHello(secondPrincipal);
					continue;
				}
				if (phase === "second-hello") {
					if (message.type !== "hello-ok" && message.type !== "hello-error") {
						fail(new Error(`unexpected duplicate hello response: ${String(message.type)}`));
						return;
					}
					secondHello = {
						type: message.type,
						code: message.code,
						message: message.message,
					};
					phase = "rpc";
					sock.write(JSON.stringify({ type: "rpc", id, method, params }) + "\n");
					continue;
				}
				if (message.id === id && (message.type === "rpc-result" || message.type === "rpc-error")) {
					finish({
						type: message.type,
						code: message.code,
						message: message.message,
						result: message.result,
					});
					return;
				}
			}
		});
		sock.on("error", (error) => fail(error));
	});
}

function sendOversizedUnterminatedFrame(
	socketPath: string,
): Promise<{ closedByServer: boolean; response: { type?: unknown; code?: unknown; message?: unknown } | null }> {
	return new Promise((resolve, reject) => {
		const sock = net.connect(socketPath);
		let response: { type?: unknown; code?: unknown; message?: unknown } | null = null;
		let settled = false;
		const finish = (closedByServer: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ closedByServer, response });
		};
		const timer = setTimeout(() => {
			if (settled) return;
			sock.destroy();
			finish(false);
		}, 1_500);
		sock.on("connect", () => {
			// One byte above the proposed 1 MiB frame ceiling, deliberately without
			// a newline: the server must bound the pending frame rather than retain it.
			sock.write(Buffer.alloc(1_048_577, 0x61));
		});
		sock.on("data", (chunk) => {
			try {
				response = JSON.parse(chunk.toString("utf8").trim()) as typeof response;
			} catch {
				/* wait for close; the assertion will reject malformed responses */
			}
		});
		sock.on("close", () => finish(true));
		sock.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
	});
}

function sendRawLine(
	socketPath: string,
	line: string,
): Promise<{ type?: unknown; code?: unknown; message?: unknown }> {
	return new Promise((resolve, reject) => {
		const sock = net.connect(socketPath);
		let acc = "";
		let settled = false;
		const finish = (result: { type?: unknown; code?: unknown; message?: unknown }): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			sock.end();
			resolve(result);
		};
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			sock.destroy();
			reject(error);
		};
		const timer = setTimeout(() => fail(new Error("timeout")), 5_000);
		sock.on("connect", () => sock.write(`${line}\n`));
		sock.on("data", (chunk) => {
			acc += chunk.toString("utf8");
			const newline = acc.indexOf("\n");
			if (newline < 0) return;
			try {
				finish(JSON.parse(acc.slice(0, newline)) as { type?: unknown; code?: unknown; message?: unknown });
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
		sock.on("error", (error) => fail(error));
	});
}

function openIdleSocket(socketPath: string): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const sock = net.connect(socketPath);
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error("idle socket connection timeout"));
		}, 2_000);
		sock.once("connect", () => {
			clearTimeout(timer);
			resolve(sock);
		});
		sock.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

function receiveUnsolicitedFrame(
	socketPath: string,
	timeoutMs = 1_500,
): Promise<{ type?: unknown; code?: unknown; message?: unknown }> {
	return new Promise((resolve, reject) => {
		const sock = net.connect(socketPath);
		let acc = "";
		let settled = false;
		const finish = (result: { type?: unknown; code?: unknown; message?: unknown }): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			sock.end();
			resolve(result);
		};
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			sock.destroy();
			reject(error);
		};
		const timer = setTimeout(() => fail(new Error("unsolicited frame timeout")), timeoutMs);
		sock.on("data", (chunk) => {
			acc += chunk.toString("utf8");
			const newline = acc.indexOf("\n");
			if (newline < 0) return;
			try {
				finish(JSON.parse(acc.slice(0, newline)) as { type?: unknown; code?: unknown; message?: unknown });
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
		sock.on("error", (error) => fail(error));
	});
}

async function closeIdleSockets(sockets: readonly net.Socket[]): Promise<void> {
	await Promise.all(
		sockets.map(
			(sock) =>
				new Promise<void>((resolve) => {
					if (sock.destroyed) {
						resolve();
						return;
					}
					sock.once("close", resolve);
					sock.end();
				}),
		),
	);
	// The peer close event follows the local FIN; let the server release its
	// admission counters before the recovery RPC asserts availability.
	await new Promise((resolve) => setTimeout(resolve, 25));
}

test("adversarial: RPC before hello is denied and performs no side effect", async () => {
	if (process.platform === "win32") return;
	const t = temp();
	try {
		const d = await startDaemon({
			env: t.env,
			projectRoots: [t.project],
			holderId: "uds-hello-guard",
			listenUds: true,
		});
		assert.equal(d.role, "writer");
		assert.ok(d.socketPath);

		const marker = path.join(t.project, "should-not-run.txt");
		const denied = await rpcWithoutHello(d.socketPath!, "admit", {
			program: {
				name: "no-hello",
				phases: [
					{
						id: "main",
						type: "script",
						run: `echo leaked > "${marker}"`,
						final: true,
					},
				],
			},
			commandId: "no-hello-cmd",
		});
		assert.equal(denied.type, "rpc-error");
		assert.equal(denied.code, "TF_PROTOCOL_INCOMPATIBLE");
		assert.match(denied.message ?? "", /hello required/i);
		assert.ok(!fs.existsSync(marker), "RPC before hello must not execute program");

		// After proper hello, admit works
		const ok = (await rpc(
			"admit",
			{
				program: {
					name: "with-hello",
					phases: [{ id: "main", type: "script", run: "echo ok", final: true }],
				},
				commandId: "with-hello-cmd",
				projectId: [...d.hosts.keys()][0],
			},
			{ socketPath: d.socketPath!, env: t.env, principal: "test" },
		)) as { ok?: boolean };
		assert.equal(ok.ok, true);

		await d.stop();
	} finally {
		t.cleanup();
	}
	void PROTOCOL_MAJOR;
});

test("adversarial: UDS connection cap rejects excess idle peers without killing the daemon", async () => {
	if (process.platform === "win32") return;
	const t = temp();
	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	let held: net.Socket[] = [];
	try {
		daemon = await startDaemon({
			env: t.env,
			projectRoots: [t.project],
			holderId: "uds-connection-cap",
			listenUds: true,
		});
		assert.ok(daemon.socketPath);
		held = await Promise.all(
			Array.from({ length: MAX_UDS_CONNECTIONS }, () => openIdleSocket(daemon!.socketPath!)),
		);
		const excess = await receiveUnsolicitedFrame(daemon.socketPath!);
		assert.equal(excess.type, "error");
		assert.equal(excess.code, "TF_CAPACITY_EXCEEDED");
		assert.match(String(excess.message ?? ""), /connection|capacity|exhausted/i);
		const resetPeer = await openIdleSocket(daemon.socketPath!);
		resetPeer.destroy();
		await new Promise((resolve) => setTimeout(resolve, 25));

		await closeIdleSockets(held);
		held = [];
		const recovered = (await rpc(
			"admit",
			{
				projectId: [...daemon.hosts.keys()][0],
				commandId: "after-connection-cap",
				program: {
					name: "after-connection-cap",
					phases: [{ id: "main", type: "script", run: "true", final: true }],
				},
			},
			{ socketPath: daemon.socketPath!, env: t.env, principal: "test" },
		)) as { ok?: boolean };
		assert.equal(recovered.ok, true, "admission after idle peers close must still work");
	} finally {
		await closeIdleSockets(held);
		await daemon?.stop();
		t.cleanup();
	}
});

test("adversarial: pre-hello idle peer expires without killing the daemon", async () => {
	if (process.platform === "win32") return;
	const t = temp();
	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	try {
		daemon = await startDaemon({
			env: t.env,
			projectRoots: [t.project],
			holderId: "uds-hello-deadline",
			listenUds: true,
		});
		assert.ok(daemon.socketPath);
		const expired = await receiveUnsolicitedFrame(
			daemon.socketPath!,
			UDS_HELLO_DEADLINE_MS + 1_500,
		);
		assert.equal(expired.type, "error");
		assert.equal(expired.code, "TF_PROTOCOL_INCOMPATIBLE");
		assert.match(String(expired.message ?? ""), /hello|deadline|within/i);

		const recovered = (await rpc(
			"admit",
			{
				projectId: [...daemon.hosts.keys()][0],
				commandId: "after-hello-deadline",
				program: {
					name: "after-hello-deadline",
					phases: [{ id: "main", type: "script", run: "true", final: true }],
				},
			},
			{ socketPath: daemon.socketPath!, env: t.env, principal: "test" },
		)) as { ok?: boolean };
		assert.equal(recovered.ok, true, "an expired peer must not stop the writer daemon");
	} finally {
		await daemon?.stop();
		t.cleanup();
	}
});

test("adversarial: RPC cannot switch the principal established by hello", async () => {
	if (process.platform === "win32") return;
	const t = temp();
	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	try {
		daemon = await startDaemon({
			env: t.env,
			projectRoots: [t.project],
			holderId: "uds-principal-binding",
			listenUds: true,
		});
		assert.ok(daemon.socketPath);
		const marker = path.join(t.project, "principal-switch-must-not-run.txt");
		const response = await rpcWithHelloPrincipal(daemon.socketPath!, "alice", "admit", {
			projectId: [...daemon.hosts.keys()][0],
			principal: "mallory",
			commandId: "principal-switch-command",
			program: {
				name: "principal-switch",
				phases: [
					{
						id: "main",
						type: "script",
						run: `printf forbidden > ${JSON.stringify(marker)}`,
						final: true,
					},
				],
			},
		});
		assert.equal(response.type, "rpc-error");
		assert.equal(response.code, "TF_POLICY_DENIED");
		assert.match(response.message ?? "", /principal.*hello|hello.*principal/i);
		assert.equal(fs.existsSync(marker), false, "rejected principal switch must not run a provider");
	} finally {
		await daemon?.stop();
		t.cleanup();
	}
});

test("adversarial: a duplicate hello cannot rotate the bound principal", async () => {
	if (process.platform === "win32") return;
	const t = temp();
	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	try {
		daemon = await startDaemon({
			env: t.env,
			projectRoots: [t.project],
			holderId: "uds-duplicate-hello",
			listenUds: true,
		});
		assert.ok(daemon.socketPath);
		const projectId = [...daemon.hosts.keys()][0];
		const marker = path.join(t.project, "duplicate-hello-must-not-run.txt");
		const response = await rpcAfterRepeatedHello(
			daemon.socketPath!,
			"alice",
			"mallory",
			"admit",
			{
				projectId,
				principal: "mallory",
				commandId: "duplicate-hello-command",
				program: {
					name: "duplicate-hello",
					phases: [
						{
							id: "main",
							type: "script",
							run: `printf forbidden > ${JSON.stringify(marker)}`,
							final: true,
						},
					],
				},
			},
		);
		assert.equal(response.secondHello.type, "hello-error");
		assert.equal(response.secondHello.code, "TF_PROTOCOL_INCOMPATIBLE");
		assert.equal(response.rpc.type, "rpc-error");
		assert.equal(response.rpc.code, "TF_POLICY_DENIED");
		assert.equal(fs.existsSync(marker), false, "duplicate hello must not rebind an RPC principal");

		const recovered = (await rpc(
			"admit",
			{
				projectId,
				commandId: "after-duplicate-hello",
				program: {
					name: "after-duplicate-hello",
					phases: [{ id: "main", type: "script", run: "true", final: true }],
				},
			},
			{ socketPath: daemon.socketPath!, env: t.env, principal: "test" },
		)) as { ok?: boolean };
		assert.equal(recovered.ok, true, "rejected duplicate hello must not stop the writer daemon");
	} finally {
		await daemon?.stop();
		t.cleanup();
	}
});

test("adversarial: oversized unterminated UDS frame is rejected without killing the daemon", async () => {
	if (process.platform === "win32") return;
	const t = temp();
	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	try {
		daemon = await startDaemon({
			env: t.env,
			projectRoots: [t.project],
			holderId: "uds-frame-limit",
			listenUds: true,
		});
		assert.ok(daemon.socketPath);
		const oversized = await sendOversizedUnterminatedFrame(daemon.socketPath!);
		assert.equal(oversized.closedByServer, true, "server must close an over-limit incomplete frame");
		assert.equal(oversized.response?.type, "error");
		assert.equal(oversized.response?.code, "TF_PROTOCOL_INCOMPATIBLE");
		assert.match(String(oversized.response?.message ?? ""), /frame|line|message/i);

		const recovered = (await rpc(
			"admit",
			{
				projectId: [...daemon.hosts.keys()][0],
				commandId: "after-oversized-frame",
				program: {
					name: "after-oversized-frame",
					phases: [{ id: "main", type: "script", run: "true", final: true }],
				},
			},
			{ socketPath: daemon.socketPath!, env: t.env, principal: "test" },
		)) as { ok?: boolean };
		assert.equal(recovered.ok, true, "an abusive connection must not stop the writer daemon");
	} finally {
		await daemon?.stop();
		t.cleanup();
	}
});

test("adversarial: non-object JSON frames are rejected without crashing the daemon", async () => {
	if (process.platform === "win32") return;
	const t = temp();
	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	try {
		daemon = await startDaemon({
			env: t.env,
			projectRoots: [t.project],
			holderId: "uds-scalar-frame",
			listenUds: true,
		});
		assert.ok(daemon.socketPath);
		for (const frame of [
			"null",
			"true",
			"42",
			JSON.stringify("scalar"),
			"[]",
			"{}",
			JSON.stringify({ type: null }),
			JSON.stringify({ type: "unknown-message" }),
		]) {
			const malformed = await sendRawLine(daemon.socketPath!, frame);
			assert.equal(malformed.type, "error", `frame ${frame} must be rejected`);
			assert.equal(malformed.code, "TF_INVALID_ARGUMENT", `frame ${frame} must be typed`);
			assert.match(String(malformed.message ?? ""), /object|message|json|type|unknown/i);
		}

		const recovered = (await rpc(
			"admit",
			{
				projectId: [...daemon.hosts.keys()][0],
				commandId: "after-scalar-frame",
				program: {
					name: "after-scalar-frame",
					phases: [{ id: "main", type: "script", run: "true", final: true }],
				},
			},
			{ socketPath: daemon.socketPath!, env: t.env, principal: "test" },
		)) as { ok?: boolean };
		assert.equal(recovered.ok, true, "a scalar frame must not stop the writer daemon");
	} finally {
		await daemon?.stop();
		t.cleanup();
	}
});

test("adversarial: malformed UDS object fields are rejected before dispatch", async () => {
	if (process.platform === "win32") return;
	const t = temp();
	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	try {
		daemon = await startDaemon({
			env: t.env,
			projectRoots: [t.project],
			holderId: "uds-object-shape",
			listenUds: true,
		});
		assert.ok(daemon.socketPath);
		const projectId = [...daemon.hosts.keys()][0];
		const marker = path.join(t.project, "malformed-object-must-not-run.txt");

		const invalidHello = await sendRawLine(
			daemon.socketPath!,
			JSON.stringify({
				type: "hello",
				protocolMajor: PROTOCOL_MAJOR,
				principal: { asserted: "not-a-string" },
			}),
		);
		assert.equal(invalidHello.type, "hello-error");
		assert.equal(invalidHello.code, "TF_POLICY_DENIED");

		const invalidMethod = await rpcWithHelloPrincipal(daemon.socketPath!, "alice", 42, {
			projectId,
			program: {
				name: "malformed-method",
				phases: [
					{
						id: "main",
						type: "script",
						run: `printf forbidden > ${JSON.stringify(marker)}`,
						final: true,
					},
				],
			},
		});
		assert.equal(invalidMethod.type, "rpc-error");
		assert.equal(invalidMethod.code, "TF_INVALID_ARGUMENT");

		const invalidParams = await rpcWithHelloPrincipal(
			daemon.socketPath!,
			"alice",
			"admit",
			null,
		);
		assert.equal(invalidParams.type, "rpc-error");
		assert.equal(invalidParams.code, "TF_INVALID_ARGUMENT");
		assert.equal(fs.existsSync(marker), false, "malformed fields must not dispatch a provider");

		const recovered = (await rpc(
			"admit",
			{
				projectId,
				commandId: "after-malformed-object",
				program: {
					name: "after-malformed-object",
					phases: [{ id: "main", type: "script", run: "true", final: true }],
				},
			},
			{ socketPath: daemon.socketPath!, env: t.env, principal: "test" },
		)) as { ok?: boolean };
		assert.equal(recovered.ok, true, "malformed fields must not stop the writer daemon");
	} finally {
		await daemon?.stop();
		t.cleanup();
	}
});

test("adversarial: unknown projectId is denied", async () => {
	if (process.platform === "win32") return;
	const t = temp();
	try {
		const d = await startDaemon({
			env: t.env,
			projectRoots: [t.project],
			holderId: "uds-proj-id",
			listenUds: true,
		});
		assert.ok(d.socketPath);
		await assert.rejects(
			() =>
				rpc(
					"admit",
					{
						program: {
							name: "x",
							phases: [{ id: "main", type: "script", run: "true", final: true }],
						},
						projectId: "proj_does_not_exist_zzzz",
						commandId: "bad-proj",
					},
					{ socketPath: d.socketPath!, env: t.env, principal: "test" },
				),
			(e: Error & { code?: string }) =>
				e.code === "TF_NOT_FOUND" || /unknown or mismatched projectId/i.test(e.message),
		);
		await d.stop();
	} finally {
		t.cleanup();
	}
});

test("adversarial: daemon writer + CLI auto succeeds via UDS client not local attach", async () => {
	if (process.platform === "win32") return;
	const t = temp();
	try {
		const d = await startDaemon({
			env: t.env,
			projectRoots: [t.project],
			holderId: "uds-cli-writer",
			listenUds: true,
		});
		assert.equal(d.role, "writer");
		assert.ok(d.socketPath);
		const hello = await probeControlEndpoint({
			socketPath: d.socketPath!,
			env: t.env,
		});
		assert.ok(hello);
		assert.equal(hello!.role, "writer");

		// CLI under same TASKFLOW_HOME attaches and must route via UDS
		const r = await runCli(
			[
				"run",
				"--cwd",
				t.project,
				"--controlMode",
				"auto",
				"--commandId",
				"cli-uds-1",
				"--define",
				JSON.stringify({
					name: "cli-via-uds",
					phases: [{ id: "main", type: "script", run: "echo via-uds", final: true }],
				}),
			],
			{ env: t.env, cwd: t.project },
		);
		assert.equal(r.ok, true, JSON.stringify(r.json));
		const json = r.json as { via?: string; ok?: boolean; receipt?: { receiptId: string } };
		assert.equal(json.via, "uds-client", "CLI must use UDS when attach, not local mutate");
		assert.ok(json.receipt?.receiptId || (json as { run?: { status: string } }).run);

		await d.stop();
	} finally {
		t.cleanup();
	}
});
