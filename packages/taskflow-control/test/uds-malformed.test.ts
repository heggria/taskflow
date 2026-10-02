import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { connectUdsClient } from "../src/uds.ts";
import { PROTOCOL_MAJOR, type NegotiationHandshake } from "../src/schema/transport.ts";

const UNIX_ONLY = { skip: process.platform === "win32", timeout: 15_000 };
const HELLO: NegotiationHandshake = {
	protocolMajor: PROTOCOL_MAJOR,
	supportedReadSchemas: ["taskflow.wire.v1"],
	supportedWriteSchemas: ["taskflow.wire.v1"],
	requiredFeatures: [],
	offeredFeatures: [],
	buildInfo: { packageVersion: "test", gitCommit: "test", schemaVersion: 1 },
};
const helloFrame = { type: "hello", hello: HELLO };
const mutateFrame = { type: "rpc", id: 1, method: "mutate", fencingEpoch: 1 };

async function isolatedServer(t: TestContext, failEpoch = false, maxFrameBytes = 4096) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-bad-uds-"));
	const endpointPath = path.join(root, "control.sock");
	const child = spawn(process.execPath, [
		"--conditions=development", "--experimental-strip-types", "--unhandled-rejections=strict",
		path.join(import.meta.dirname, "fixtures", "uds-malformed-server.ts"),
	], {
		env: { ...process.env, TF_TEST_ENDPOINT: endpointPath, TF_TEST_FAIL_EPOCH: failEpoch ? "1" : "0", TF_TEST_MAX_FRAME_BYTES: String(maxFrameBytes) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}
		fs.rmSync(root, { recursive: true, force: true });
	});
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`server readiness timeout: ${stderr}`)), 5_000);
		child.once("exit", () => { clearTimeout(timer); reject(new Error(`server exited: ${stderr}`)); });
		child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
	});
	return {
		endpointPath,
		async probe() {
			try {
				const client = await connectUdsClient({ endpointPath, clientHello: HELLO, connectTimeoutMs: 1_000 });
				try { return await client.rpc<{ mutations: number }>("probe"); }
				finally { client.close(); }
			} catch (error) {
				throw new Error(`valid client failed after fault; server exit=${child.exitCode}; ${stderr}`, { cause: error });
			}
		},
	};
}

function exchangeUntilClosed(endpointPath: string, frames: unknown[]): Promise<string> {
	return exchangeWireUntilClosed(endpointPath, frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
}

function exchangeWireUntilClosed(endpointPath: string, wire: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(endpointPath);
		let response = "";
		const timer = setTimeout(() => { socket.destroy(); reject(new Error("bad client was not closed")); }, 2_000);
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => { response += chunk; });
		socket.on("error", () => { /* reset is a valid fail-closed outcome */ });
		socket.on("close", () => { clearTimeout(timer); resolve(response); });
		socket.on("connect", () => { socket.write(wire); });
	});
}

test("uds: malformed hello shapes cannot terminate the shared server", UNIX_ONLY, async (t) => {
	const server = await isolatedServer(t);
	for (const patch of [
		{ requiredFeatures: {} }, { offeredFeatures: {} }, { requiredFeatures: "feature" },
		{ supportedReadSchemas: [null] }, { supportedWriteSchemas: [42] },
		{ buildInfo: null }, { offeredFeatures: [false] },
	]) {
		const response = await exchangeUntilClosed(server.endpointPath, [{ type: "hello", hello: { ...HELLO, ...patch } }]);
		assert.deepEqual(await server.probe(), { mutations: 0 });
		assert.match(response, /TF_PROTOCOL_INCOMPATIBLE/, JSON.stringify(patch));
	}
});

test("uds: invalid RPC counters fail closed before mutation and leave the shared server healthy", UNIX_ONLY, async (t) => {
	const server = await isolatedServer(t);
	// Raw JSON is necessary: JSON.stringify would replace Infinity with null.
	const invalidTokens = ["1e999", "-1", "0.5", "9007199254740992", "null", '"1"', "true"];
	const frames = [
		...invalidTokens.map((token) => `{"type":"rpc","id":${token},"method":"mutate","fencingEpoch":1}`),
		...invalidTokens.map((token) => `{"type":"rpc","id":1,"method":"mutate","fencingEpoch":${token}}`),
		'{"type":"rpc","method":"mutate","fencingEpoch":1}',
	];
	for (const frame of frames) {
		const response = await exchangeWireUntilClosed(server.endpointPath,
			`${JSON.stringify(helloFrame)}\n${frame}\n${JSON.stringify(mutateFrame)}\n`);
		assert.match(response, /TF_PROTOCOL_INCOMPATIBLE/, frame);
		assert.deepEqual(await server.probe(), { mutations: 0 }, frame);
	}
});

test("uds: zero RPC id and omitted legacy fencing epoch remain legal", UNIX_ONLY, async (t) => {
	const server = await isolatedServer(t);
	const reply = await new Promise<{ id: number; ok: boolean; result: { fencingEpoch: number } }>((resolve, reject) => {
		const socket = net.connect(server.endpointPath);
		let buffer = "";
		const timer = setTimeout(() => { socket.destroy(); reject(new Error("legacy RPC timed out")); }, 2_000);
		socket.setEncoding("utf8");
		socket.on("error", (error) => { clearTimeout(timer); socket.destroy(); reject(error); });
		socket.on("connect", () => socket.write(`${JSON.stringify(helloFrame)}\n${JSON.stringify({ type: "rpc", id: 0, method: "inspect-epoch" })}\n`));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const frame = JSON.parse(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				if (frame.type === "rpc-result") {
					clearTimeout(timer);
					socket.destroy();
					resolve(frame);
					return;
				}
			}
		});
	});
	assert.equal(reply.id, 0);
	assert.equal(reply.ok, true);
	assert.deepEqual(reply.result, { fencingEpoch: 0 });
	assert.deepEqual(await server.probe(), { mutations: 0 });
});

test("uds: frames pipelined after a failed connection never dispatch RPCs", UNIX_ONLY, async (t) => {
	const server = await isolatedServer(t);
	for (const frames of [
		[helloFrame, helloFrame, mutateFrame],
		[{ type: "hello", hello: { ...HELLO, protocolMajor: 999 } }, helloFrame, mutateFrame],
		[helloFrame, { type: "unknown" }, mutateFrame],
		[helloFrame, { type: "rpc", id: 2 }, mutateFrame],
	]) {
		await exchangeUntilClosed(server.endpointPath, frames);
		assert.deepEqual(await server.probe(), { mutations: 0 }, JSON.stringify(frames));
	}
});

test("uds: an unexpected hello handler failure is contained to its connection", UNIX_ONLY, async (t) => {
	const server = await isolatedServer(t, true);
	await exchangeUntilClosed(server.endpointPath, [helloFrame, mutateFrame]);
	assert.deepEqual(await server.probe(), { mutations: 0 });
});

test("uds: oversized UTF-8 frames and prehello slow-drip timeout only close the offender", UNIX_ONLY, async (t) => {
	const server = await isolatedServer(t);
	for (const prefix of ["", JSON.stringify(helloFrame) + "\n"]) {
		await new Promise<void>((resolve, reject) => {
			const socket = net.connect(server.endpointPath);
			socket.resume();
			const timer = setTimeout(() => { socket.destroy(); reject(new Error("oversized frame was not closed")); }, 1_000);
			socket.on("error", () => {});
			socket.on("close", () => { clearTimeout(timer); resolve(); });
			socket.on("connect", () => socket.write(prefix + "界".repeat(1500)));
		});
		assert.deepEqual(await server.probe(), { mutations: 0 });
	}
	await new Promise<void>((resolve, reject) => {
		const socket = net.connect(server.endpointPath);
		const start = Date.now();
		const drip = setInterval(() => socket.write(" "), 30);
		const timer = setTimeout(() => { socket.destroy(); reject(new Error("slow-drip renewed hello deadline")); }, 1_000);
		socket.on("error", () => {});
		socket.on("close", () => { clearTimeout(timer); clearInterval(drip); assert.ok(Date.now() - start < 900); resolve(); });
	});
	assert.deepEqual(await server.probe(), { mutations: 0 });
});

test("uds: bounded large multibyte payload and coalesced frames remain usable", UNIX_ONLY, async (t) => {
	const server = await isolatedServer(t);
	const client = await connectUdsClient({ endpointPath: server.endpointPath, clientHello: HELLO, maxFrameBytes: 4096 });
	t.after(() => client.close());
	const payload = "界".repeat(1000);
	assert.deepEqual(await Promise.all([client.rpc("echo", payload), client.rpc("echo", payload)]), [payload, payload]);
});

test("uds: a legitimate MiB-sized payload round-trips under the default client budget", UNIX_ONLY, async (t) => {
	const server = await isolatedServer(t, false, 2 * 1024 * 1024);
	const client = await connectUdsClient({ endpointPath: server.endpointPath, clientHello: HELLO });
	t.after(() => client.close());
	const payload = "x".repeat(1024 * 1024);
	assert.equal(await client.rpc("echo", payload), payload);
	assert.deepEqual(await server.probe(), { mutations: 0 });
});

test("uds: malformed failure replies cannot crash a real client process", UNIX_ONLY, async (t) => {
	const healthy = await isolatedServer(t);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-bad-peer-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const envelope = { code: "TF_COMMAND_FAILED", message: "expected", recoveryAction: "none", sideEffects: "none" };
	const failures = [
		{ ok: false }, { ok: false, error: null }, { ok: false, error: "bad" },
		{ ok: "false", error: envelope }, { error: envelope },
		{ ok: false, error: { ...envelope, code: "NOT_CLOSED" } },
		{ ok: false, error: { ...envelope, recoveryAction: "bad" } },
		{ ok: false, error: { ...envelope, sideEffects: "bad" } },
		{ ok: false, error: { ...envelope, commitSeq: "1" } },
		{ ok: false, error: { ...envelope, message: "" } },
		{ ok: false, error: { ...envelope, projectId: "not-a-uuid" } },
		{ ok: false, error: { ...envelope, extra: true } },
	];
	for (const stage of ["hello-ack", "rpc-result", "oversized-hello", "oversized-rpc"]) {
		for (const [i, failure] of (stage.startsWith("oversized") ? [{}] : failures).entries()) {
			const endpointPath = path.join(root, `${stage}-${i}.sock`);
			const sockets = new Set<net.Socket>();
			const bad = net.createServer((socket) => {
				sockets.add(socket);
				socket.on("error", () => {});
				socket.on("close", () => sockets.delete(socket));
				let buffer = "";
				socket.on("data", (chunk) => {
					buffer += chunk.toString();
					let index: number;
					while ((index = buffer.indexOf("\n")) >= 0) {
						const frame = JSON.parse(buffer.slice(0, index));
						buffer = buffer.slice(index + 1);
						if (stage === "oversized-hello" || (stage === "oversized-rpc" && frame.type === "rpc")) socket.write("界".repeat(1500));
						else if (stage === "hello-ack" || frame.type === "rpc") socket.write(JSON.stringify({ type: stage, id: frame.id, ...failure }) + "\n");
						else socket.write(JSON.stringify({ type: "hello-ack", ok: true, serverHello: HELLO, fencingEpoch: 1 }) + "\n");
					}
				});
			});
			await new Promise<void>((resolve) => bad.listen(endpointPath, resolve));
			try {
				const child = spawn(process.execPath, ["--conditions=development", "--experimental-strip-types", "--unhandled-rejections=strict", path.join(import.meta.dirname, "fixtures", "uds-malformed-client.ts")], {
					env: { ...process.env, TF_TEST_BAD_ENDPOINT: endpointPath, TF_TEST_GOOD_ENDPOINT: healthy.endpointPath }, stdio: ["ignore", "pipe", "pipe"],
				});
				let output = "";
				child.stdout.on("data", (chunk) => { output += chunk; });
				child.stderr.on("data", (chunk) => { output += chunk; });
				const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
				const [code] = await once(child, "exit");
				clearTimeout(timer);
				assert.equal(code, 0, `${stage} ${JSON.stringify(failure)}: ${output}`);
				assert.match(output, /SURVIVED/);
			} finally {
				for (const socket of sockets) socket.destroy();
				await new Promise<void>((resolve) => bad.close(() => resolve()));
			}
		}
	}
});
