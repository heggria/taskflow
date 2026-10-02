/** Runs vulnerable client callbacks in a disposable strict-rejection process. */
import assert from "node:assert/strict";
import { connectUdsClient } from "../../src/uds.ts";
import type { NegotiationHandshake } from "../../src/schema/transport.ts";

const endpointPath = process.env.TF_TEST_ENDPOINT!;
const scenario = process.env.TF_TEST_SCENARIO!;
const hello: NegotiationHandshake = {
	protocolMajor: 1, supportedReadSchemas: ["taskflow.wire.v1"], supportedWriteSchemas: ["taskflow.wire.v1"],
	requiredFeatures: [], offeredFeatures: [], buildInfo: { packageVersion: "test", gitCommit: "test", schemaVersion: 1 },
};
const options = { endpointPath, clientHello: hello, maxFrameBytes: 512, connectTimeoutMs: 3_000, rpcTimeoutMs: 3_000 };
async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("protocol rejection/cleanup exceeded 700ms")), 700);
		})]);
	} finally { clearTimeout(timer); }
}
function transportError(error: unknown): boolean {
	assert.ok(error instanceof Error);
	assert.ok("code" in error && ["TF_JOURNAL_UNAVAILABLE", "TF_PROTOCOL_INCOMPATIBLE"].includes(String(error.code)), String(error));
	return true;
}
if (scenario === "hello-rejection") {
	await assert.rejects(bounded(connectUdsClient(options)), transportError);
} else {
	const client = await connectUdsClient(options);
	try {
		if (scenario === "rpc-rejection") {
			const outcomes = await bounded(Promise.allSettled([client.rpc("one"), client.rpc("two")]));
			for (const outcome of outcomes) {
				assert.equal(outcome.status, "rejected");
				if (outcome.status === "rejected") transportError(outcome.reason);
			}
			await assert.rejects(bounded(client.rpc("after-failure")), transportError);
		} else if (scenario === "coalesced") {
			const values = await bounded(Promise.all(Array.from({ length: 20 }, () => client.rpc<string>("one"))));
			assert.deepEqual(values, Array(20).fill("中🙂"));
		} else if (scenario === "compatible-results") {
			const values = await bounded(Promise.all([client.rpc("void"), client.rpc("nullable")]));
			assert.deepEqual(values, [undefined, null]);
		} else if (scenario === "valid-failure") {
			await assert.rejects(bounded(client.rpc("fails")), (error: unknown) => {
				assert.ok(error instanceof Error && "code" in error);
				assert.equal(error.code, "TF_COMMAND_FAILED");
				return true;
			});
			assert.equal(await bounded(client.rpc("still-usable")), "healthy");
		} else {
			const value = await bounded(client.rpc<string>("one"));
			assert.ok(value.startsWith("中🙂"));
		}
	} finally { client.close(); }
}
// The rejecting peer must not poison later connections in this process.
const healthy = await connectUdsClient(options);
try { assert.equal(await healthy.rpc("healthy"), "healthy"); }
finally { healthy.close(); }
console.log("SURVIVED");
