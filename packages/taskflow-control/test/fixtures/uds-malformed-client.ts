import assert from "node:assert/strict";
import { connectUdsClient } from "../../src/uds.ts";
import { PROTOCOL_MAJOR, type NegotiationHandshake } from "../../src/schema/transport.ts";

const clientHello: NegotiationHandshake = {
	protocolMajor: PROTOCOL_MAJOR,
	supportedReadSchemas: ["taskflow.wire.v1"], supportedWriteSchemas: ["taskflow.wire.v1"],
	requiredFeatures: [], offeredFeatures: [],
	buildInfo: { packageVersion: "test", gitCommit: "test", schemaVersion: 1 },
};
try {
	const client = await connectUdsClient({ endpointPath: process.env.TF_TEST_BAD_ENDPOINT!, clientHello, maxFrameBytes: 4096 });
	try { await client.rpc("probe"); }
	finally { client.close(); }
	throw new Error("malformed peer was accepted");
} catch (error) {
	assert.equal((error as { code?: string }).code, "TF_JOURNAL_UNAVAILABLE");
}
const healthy = await connectUdsClient({ endpointPath: process.env.TF_TEST_GOOD_ENDPOINT!, clientHello });
try { assert.deepEqual(await healthy.rpc("probe"), { mutations: 0 }); }
finally { healthy.close(); }
console.log("SURVIVED");
