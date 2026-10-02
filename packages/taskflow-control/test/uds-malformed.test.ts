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

async function isolatedServer(t: TestContext, failEpoch = false) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-bad-uds-"));
	const endpointPath = path.join(root, "control.sock");
	const child = spawn(process.execPath, [
		"--conditions=development", "--experimental-strip-types", "--unhandled-rejections=strict",
		path.join(import.meta.dirname, "fixtures", "uds-malformed-server.ts"),
	], {
		env: { ...process.env, TF_TEST_ENDPOINT: endpointPath, TF_TEST_FAIL_EPOCH: failEpoch ? "1" : "0" },
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
	return new Promise((resolve, reject) => {
		const socket = net.connect(endpointPath);
		let response = "";
		const timer = setTimeout(() => { socket.destroy(); reject(new Error("bad client was not closed")); }, 2_000);
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => { response += chunk; });
		socket.on("error", () => { /* reset is a valid fail-closed outcome */ });
		socket.on("close", () => { clearTimeout(timer); resolve(response); });
		socket.on("connect", () => { socket.write(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n"); });
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
