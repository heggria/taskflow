/** Isolated fault-injection server; never uses a real control home or ledger. */
import { startUdsServer } from "../../src/uds.ts";
import { PROTOCOL_MAJOR } from "../../src/schema/transport.ts";

const endpointPath = process.env.TF_TEST_ENDPOINT;
if (!endpointPath) throw new Error("TF_TEST_ENDPOINT required");
let mutations = 0;
let failEpoch = process.env.TF_TEST_FAIL_EPOCH === "1";
const server = await startUdsServer({
	endpointPath,
	maxFrameBytes: Number(process.env.TF_TEST_MAX_FRAME_BYTES ?? 4096),
	helloTimeoutMs: 300,
	serverHello: {
		protocolMajor: PROTOCOL_MAJOR,
		supportedReadSchemas: ["taskflow.wire.v1"],
		supportedWriteSchemas: ["taskflow.wire.v1"],
		requiredFeatures: [],
		offeredFeatures: [],
		buildInfo: { packageVersion: "test", gitCommit: "test", schemaVersion: 1 },
	},
	getFencingEpoch: () => {
		if (failEpoch) {
			failEpoch = false;
			throw new Error("injected epoch failure");
		}
		return 1;
	},
	handleRpc: async (method, params, fencingEpoch) => {
		if (method === "echo") return params;
		if (method === "inspect-epoch") return { fencingEpoch };
		if (method === "mutate") mutations++;
		return { mutations };
	},
});
process.on("SIGTERM", () => { void server.close(); });
console.log("READY");
