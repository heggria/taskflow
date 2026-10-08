import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { startUdsServer, connectUdsClient } from "../src/uds.ts";
import type { NegotiationHandshake } from "../src/schema/transport.ts";

const UNIX_ONLY = { skip: process.platform === "win32", timeout: 15_000 };
const LIMIT = 512;
const HELLO: NegotiationHandshake = {
	protocolMajor: 1, supportedReadSchemas: ["taskflow.wire.v1"], supportedWriteSchemas: ["taskflow.wire.v1"],
	requiredFeatures: [], offeredFeatures: [], buildInfo: { packageVersion: "test", gitCommit: "test", schemaVersion: 1 },
};
const ACK = { type: "hello-ack", ok: true, serverHello: HELLO, fencingEpoch: 1 };
const ERROR = { code: "TF_COMMAND_FAILED", message: "rejected", recoveryAction: "none", sideEffects: "none" };
const line = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + "\n");
function endpoint(t: TestContext): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-wire-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return path.join(root, "control.sock");
}
function exactFrame(make: (text: string) => unknown, bytes = LIMIT): Buffer {
	const prefix = "中🙂";
	const text = prefix + "x".repeat(bytes - Buffer.byteLength(JSON.stringify(make(prefix))));
	const frame = line(make(text));
	assert.equal(frame.length - 1, bytes, "limit counts UTF-8 JSON bytes excluding LF");
	return frame;
}
async function server(t: TestContext, helloTimeoutMs = 150) {
	const endpointPath = endpoint(t);
	let calls = 0;
	const options = {
		endpointPath, serverHello: HELLO, maxFrameBytes: LIMIT, helloTimeoutMs,
		getFencingEpoch: () => 1,
		handleRpc: async () => ({ calls: ++calls }),
	};
	const service = await startUdsServer(options);
	t.after(() => service.close());
	return {
		endpointPath,
		get calls() { return calls; },
		async healthy() {
			const client = await connectUdsClient({ endpointPath, clientHello: HELLO });
			try { assert.ok(await client.rpc("healthy")); }
			finally { client.close(); }
		},
	};
}
async function rawClient(t: TestContext, endpointPath: string) {
	const socket = net.connect(endpointPath);
	t.after(() => socket.destroy());
	socket.on("error", () => { /* remote rejection may reset */ });
	let received = "";
	let closed = false;
	socket.on("data", (chunk: Buffer) => { received += chunk.toString(); });
	socket.on("close", () => { closed = true; });
	await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
	return {
		socket,
		async closedWithin(ms = 700) {
			const deadline = Date.now() + ms;
			while (!closed && Date.now() < deadline) await delay(10);
			assert.equal(closed, true, "connection must close before watchdog, even without LF");
		},
		async frames(count: number) {
			const deadline = Date.now() + 700;
			while (received.split("\n").length - 1 < count && !closed && Date.now() < deadline) await delay(10);
			const frames = received.trim().split("\n").filter(Boolean).map((text) => JSON.parse(text) as Record<string, unknown>);
			assert.equal(frames.length, count, received);
			return frames;
		},
	};
}

for (const terminated of [false, true]) {
	test(`uds wire: server rejects oversized ${terminated ? "terminated" : "unterminated"} UTF-8 frame`, UNIX_ONLY, async (t) => {
		const service = await server(t, 5_000);
		const client = await rawClient(t, service.endpointPath);
		client.socket.write(line({ type: "hello", hello: HELLO }));
		await client.frames(1);
		const oversized = exactFrame((params) => ({ type: "rpc", id: 1, method: "probe", params, fencingEpoch: 1 }), LIMIT + 1);
		client.socket.write(terminated ? oversized : oversized.subarray(0, -1));
		await client.closedWithin();
		assert.equal(service.calls, 0);
		await service.healthy();
	});
}

test("uds wire: server accepts exact byte boundary, split UTF-8 and coalesced frames over aggregate limit", UNIX_ONLY, async (t) => {
	const service = await server(t);
	const client = await rawClient(t, service.endpointPath);
	const frame = exactFrame((params) => ({ type: "rpc", id: 1, method: "probe", params, fencingEpoch: 1 }));
	client.socket.write(line({ type: "hello", hello: HELLO }));
	const split = frame.indexOf(Buffer.from("中")) + 1;
	client.socket.write(frame.subarray(0, split));
	await delay(20);
	client.socket.write(frame.subarray(split));
	const coalesced = Buffer.concat(Array.from({ length: 20 }, (_, index) => line({ type: "rpc", id: index + 2, method: "probe", fencingEpoch: 1 })));
	assert.ok(coalesced.length > LIMIT);
	client.socket.write(coalesced);
	for (const response of await client.frames(22)) assert.equal(response.ok, true);
	assert.equal(service.calls, 21);
});

for (const dripping of [false, true]) {
	test(`uds wire: absolute hello deadline closes ${dripping ? "slow-drip" : "idle"} peers`, UNIX_ONLY, async (t) => {
		const service = await server(t, 150);
		const client = await rawClient(t, service.endpointPath);
		let interval: NodeJS.Timeout | undefined;
		if (dripping) interval = setInterval(() => client.socket.write(" "), 25);
		try { await client.closedWithin(700); }
		finally { clearInterval(interval); }
		await service.healthy();
	});
}

test("uds wire: successful hello cancels the server deadline", UNIX_ONLY, async (t) => {
	const service = await server(t, 100);
	const client = await connectUdsClient({ endpointPath: service.endpointPath, clientHello: HELLO });
	t.after(() => client.close());
	await delay(200);
	assert.ok(await client.rpc("after-deadline"));
});

async function clientProcess(t: TestContext, scenario: string, attack: (socket: net.Socket, frames: Record<string, unknown>[]) => void) {
	const endpointPath = endpoint(t);
	const sockets = new Set<net.Socket>();
	let connections = 0;
	const peer = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
		const healthy = ++connections > 1;
		let buffer = "";
		const frames: Record<string, unknown>[] = [];
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let index: number;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const frame = JSON.parse(buffer.slice(0, index)) as Record<string, unknown>;
				buffer = buffer.slice(index + 1);
				frames.push(frame);
				if (healthy) socket.write(line(frame.type === "hello" ? ACK : { type: "rpc-result", id: frame.id, ok: true, result: "healthy" }));
				else attack(socket, frames);
			}
		});
	});
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => peer.close(() => resolve()));
	});
	await new Promise<void>((resolve, reject) => { peer.once("error", reject); peer.listen(endpointPath, resolve); });
	const child = spawn(process.execPath, ["--conditions=development", "--experimental-strip-types", "--unhandled-rejections=strict", path.join(import.meta.dirname, "fixtures", "uds-wire-client.ts")], {
		env: { ...process.env, TF_TEST_ENDPOINT: endpointPath, TF_TEST_SCENARIO: scenario }, stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
	child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
	const code = await new Promise<number | null>((resolve, reject) => {
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`client fixture hung: ${output}`)); }, 5_000);
		child.once("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode); });
		child.once("error", reject);
	});
	assert.equal(code, 0, output);
	assert.match(output, /SURVIVED/);
}

const badPayloads = [
	{ name: "missing error", patch: {} },
	{ name: "null error", patch: { error: null } },
	{ name: "scalar error", patch: { error: "no" } },
	{ name: "incomplete envelope", patch: { error: { code: ERROR.code, message: ERROR.message } } },
	{ name: "invalid envelope fields", patch: { error: { ...ERROR, recoveryAction: "bogus", sideEffects: 7 } } },
	{ name: "nonboolean ok", patch: { ok: "false", error: ERROR } },
	{ name: "missing ok", patch: { ok: undefined, error: ERROR } },
];
for (const phase of ["hello", "rpc"] as const) {
	for (const payload of badPayloads) {
		test(`uds wire: client survives ${phase} ${payload.name} and settles pending work`, UNIX_ONLY, async (t) => {
			await clientProcess(t, `${phase}-rejection`, (socket, frames) => {
				if (phase === "hello") socket.write(line({ type: "hello-ack", ok: false, ...payload.patch }));
				else if (frames.length === 1) socket.write(line(ACK));
				else if (frames.length === 3) socket.write(line({ type: "rpc-result", id: 1, ok: false, ...payload.patch }));
			});
		});
	}
}
for (const terminated of [false, true]) {
	test(`uds wire: client rejects oversized ${terminated ? "terminated" : "unterminated"} hello response promptly`, UNIX_ONLY, async (t) => {
		await clientProcess(t, "hello-rejection", (socket) => {
			const frame = exactFrame((message) => ({ type: "hello-ack", ok: false, error: { ...ERROR, message } }), LIMIT + 1);
			socket.write(terminated ? frame : frame.subarray(0, -1));
		});
	});
	test(`uds wire: client rejects oversized ${terminated ? "terminated" : "unterminated"} response and cleans pending`, UNIX_ONLY, async (t) => {
		await clientProcess(t, "rpc-rejection", (socket, frames) => {
			if (frames.length === 1) socket.write(line(ACK));
			else if (frames.length === 3) {
				const frame = exactFrame((result) => ({ type: "rpc-result", id: 1, ok: true, result }), LIMIT + 1);
				socket.write(terminated ? frame : frame.subarray(0, -1));
			}
		});
	});
}

test("uds wire: client accepts exact boundary with split multibyte UTF-8", UNIX_ONLY, async (t) => {
	await clientProcess(t, "boundary", (socket, frames) => {
		if (frames.length === 1) socket.write(line(ACK));
		else {
			const frame = exactFrame((result) => ({ type: "rpc-result", id: 1, ok: true, result }));
			const split = frame.indexOf(Buffer.from("中")) + 1;
			socket.write(frame.subarray(0, split));
			setTimeout(() => socket.write(frame.subarray(split)), 20);
		}
	});
});

test("uds wire: client accepts coalesced valid responses above aggregate limit", UNIX_ONLY, async (t) => {
	await clientProcess(t, "coalesced", (socket, frames) => {
		if (frames.length === 1) socket.write(line(ACK));
		else if (frames.length === 21) {
			const responses = Buffer.concat(frames.slice(1).map((frame) => line({ type: "rpc-result", id: frame.id, ok: true, result: "中🙂" })));
			assert.ok(responses.length > LIMIT);
			socket.write(responses);
		}
	});
});

// Validate each discriminated reply before resolving or removing pending work.
const malformedHelloSuccess = [
	{ name: "missing serverHello", patch: { serverHello: undefined } },
	{ name: "null serverHello", patch: { serverHello: null } },
	{ name: "scalar serverHello", patch: { serverHello: "hello" } },
	{ name: "malformed serverHello", patch: { serverHello: { ...HELLO, requiredFeatures: {} } } },
	{ name: "missing epoch", patch: { fencingEpoch: undefined } },
	{ name: "null epoch", patch: { fencingEpoch: null } },
	{ name: "string epoch", patch: { fencingEpoch: "1" } },
	{ name: "fractional epoch", patch: { fencingEpoch: 1.5 } },
	{ name: "negative epoch", patch: { fencingEpoch: -1 } },
	{ name: "unsafe epoch", patch: { fencingEpoch: Number.MAX_SAFE_INTEGER + 1 } },
];
for (const payload of malformedHelloSuccess) {
	test(`uds wire: rejects successful hello with ${payload.name}`, UNIX_ONLY, async (t) => {
		await clientProcess(t, "hello-rejection", (socket) => socket.write(line({ ...ACK, ...payload.patch })));
	});
}
for (const ok of [true, false]) {
	for (const [name, id] of [
		["missing", undefined], ["null", null], ["string", "1"],
		["fractional", 1.5], ["negative", -1], ["unsafe", Number.MAX_SAFE_INTEGER + 1],
	] as const) {
		test(`uds wire: rejects ${ok ? "success" : "failure"} RPC response with ${name} id`, UNIX_ONLY, async (t) => {
			await clientProcess(t, "rpc-rejection", (socket, frames) => {
				if (frames.length === 1) socket.write(line(ACK));
				else if (frames.length === 3) socket.write(line({ type: "rpc-result", id, ok, ...(ok ? { result: "invalid" } : { error: ERROR }) }));
			});
		});
	}
}
for (const [phase, name, frame] of [
	["hello", "success carrying error", { ...ACK, error: ERROR }],
	["hello", "failure carrying success fields", { ...ACK, ok: false, error: ERROR }],
	["rpc", "success carrying error", { type: "rpc-result", id: 1, ok: true, result: "contradictory", error: ERROR }],
	["rpc", "failure carrying result", { type: "rpc-result", id: 1, ok: false, result: "contradictory", error: ERROR }],
] as const) {
	test(`uds wire: rejects contradictory ${phase} ${name}`, UNIX_ONLY, async (t) => {
		await clientProcess(t, `${phase}-rejection`, (socket, frames) => {
			if (phase === "hello") socket.write(line(frame));
			else if (frames.length === 1) socket.write(line(ACK));
			else if (frames.length === 3) socket.write(line(frame));
		});
	});
}

test("uds wire: preserves void and null results and ignores valid unmatched response IDs", UNIX_ONLY, async (t) => {
	await clientProcess(t, "compatible-results", (socket, frames) => {
		if (frames.length === 1) socket.write(line(ACK));
		else if (frames.length === 3) socket.write(Buffer.concat([
			line({ type: "rpc-result", id: 999, ok: true, result: "late unmatched response" }),
			line({ type: "rpc-result", id: 1, ok: true }),
			line({ type: "rpc-result", id: 2, ok: true, result: null }),
		]));
	});
});

test("uds wire: valid RPC failure preserves command error and usable connection", UNIX_ONLY, async (t) => {
	await clientProcess(t, "valid-failure", (socket, frames) => {
		if (frames.length === 1) socket.write(line(ACK));
		else if (frames.length === 2) socket.write(line({ type: "rpc-result", id: 1, ok: false, error: ERROR }));
		else socket.write(line({ type: "rpc-result", id: 2, ok: true, result: "healthy" }));
	});
});
