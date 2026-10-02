import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { test, type TestContext } from "node:test";
import { ControlError } from "../src/errors.ts";
import { PROTOCOL_MAJOR, type NegotiationHandshake } from "../src/schema/transport.ts";
import { connectUdsClient, type UdsClient } from "../src/uds.ts";

const hello: NegotiationHandshake = {
	protocolMajor: PROTOCOL_MAJOR,
	supportedReadSchemas: ["taskflow.wire.v1"], supportedWriteSchemas: ["taskflow.wire.v1"],
	requiredFeatures: [], offeredFeatures: [],
	buildInfo: { packageVersion: "test", gitCommit: "test", schemaVersion: 1 },
};

class TestSocket extends EventEmitter {
	requests: { id: number; method: string }[] = [];
	setEncoding(): void {}
	write(data: string): boolean {
		const frame = JSON.parse(data) as { type: string; id: number; method: string };
		if (frame.type === "hello") {
			queueMicrotask(() => this.emit("data", JSON.stringify({
				type: "hello-ack", ok: true, fencingEpoch: 1, serverHello: hello,
			}) + "\n"));
		} else this.requests.push(frame);
		return true;
	}
	destroy(): void { this.emit("close"); }
}

async function connect(t: TestContext, maxFrameBytes?: number): Promise<{ client: UdsClient; socket: TestSocket }> {
	const socket = new TestSocket();
	t.mock.method(net, "connect", () => {
		queueMicrotask(() => socket.emit("connect"));
		return socket;
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const client = await connectUdsClient({ endpointPath: "/test-only", clientHello: hello, rpcTimeoutMs: 1_000, maxFrameBytes });
	t.after(() => client.close());
	return { client, socket };
}

function success(id: number, result: string): string {
	return JSON.stringify({ type: "rpc-result", id, ok: true, result }) + "\n";
}

test("uds client: all coalesced replies settle without another data event", async (t) => {
	const { client, socket } = await connect(t);
	const results = Promise.all([client.rpc("one"), client.rpc("two"), client.rpc("three")]);
	socket.emit("data", success(3, "three") + success(1, "one") + success(2, "two"));
	assert.deepEqual(await results, ["one", "two", "three"]);
});

test("uds client: byte budget applies per frame, including split multibyte input", async (t) => {
	const { client, socket } = await connect(t, 4096);
	const payload = "界".repeat(1000);
	const results = Promise.all([client.rpc("one"), client.rpc("two")]);
	const first = success(1, payload);
	socket.emit("data", first.slice(0, 500));
	// This event exceeds the limit in total, but each individual frame fits.
	socket.emit("data", first.slice(500) + success(2, payload));
	assert.deepEqual(await results, [payload, payload]);
});

test("uds client: malformed failure rejects every pending RPC and stops pipelined replies", async (t) => {
	const { client, socket } = await connect(t);
	const results = Promise.allSettled([client.rpc("one"), client.rpc("two")]);
	socket.emit("data", JSON.stringify({ type: "rpc-result", id: 1, ok: false }) + "\n" + success(2, "must not resolve"));
	for (const result of await results) {
		assert.equal(result.status, "rejected");
		if (result.status === "rejected") assert.equal((result.reason as ControlError).code, "TF_JOURNAL_UNAVAILABLE");
	}
	await assert.rejects(client.rpc("after-close"), { code: "TF_JOURNAL_UNAVAILABLE" });
});

test("uds client: a negative reply id fails closed and rejects all pending RPCs", async (t) => {
	const { client, socket } = await connect(t);
	const results = Promise.allSettled([client.rpc("one"), client.rpc("two")]);
	socket.emit("data", success(-1, "invalid") + success(1, "must not resolve"));
	for (const result of await results) {
		assert.equal(result.status, "rejected");
		if (result.status === "rejected") assert.ok(result.reason instanceof ControlError);
	}
	await assert.rejects(client.rpc("after failure"), /closed/);
});

test("uds client: unterminated multibyte input closes at its byte limit", async (t) => {
	const { client, socket } = await connect(t, 4096);
	const result = client.rpc("one");
	socket.emit("data", "界".repeat(1000));
	socket.emit("data", "界".repeat(400));
	await assert.rejects(result, { code: "TF_JOURNAL_UNAVAILABLE" });
});

test("uds client: split frame followed by coalesced replies drains completely", async (t) => {
	const { client, socket } = await connect(t);
	const results = Promise.all([client.rpc("one"), client.rpc("two")]);
	const first = success(1, "one");
	socket.emit("data", first.slice(0, 13));
	socket.emit("data", first.slice(13) + success(2, "two"));
	assert.deepEqual(await results, ["one", "two"]);
});

test("uds client: error reply does not strand later successes or unknown IDs", async (t) => {
	const { client, socket } = await connect(t);
	const results = Promise.allSettled([client.rpc("one"), client.rpc("two"), client.rpc("three")]);
	const error = new ControlError("TF_COMMAND_FAILED", "expected error", { recoveryAction: "none", sideEffects: "none" });
	socket.emit("data", JSON.stringify({ type: "rpc-result", id: 1, ok: false, error: error.toEnvelope() }) + "\n"
		+ success(999, "unknown") + success(2, "two") + success(3, "three"));
	const [first, second, third] = await results;
	assert.equal(first.status, "rejected");
	if (first.status === "rejected") assert.equal((first.reason as ControlError).code, "TF_COMMAND_FAILED");
	assert.deepEqual([second, third], [{ status: "fulfilled", value: "two" }, { status: "fulfilled", value: "three" }]);
});
