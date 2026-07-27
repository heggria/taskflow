/** UDS attach identity binding (P13): every RPC hello must match the singleton epoch. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { controlClientRpc } from "../src/index.ts";

test("control client: a mismatched hello epoch is rejected before any RPC side effect", async () => {
	if (process.platform === "win32") return;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-control-client-"));
	const socketPath = path.join(root, "forged.sock");
	let rpcReceived = false;
	let server: net.Server | undefined;
	try {
		server = net.createServer((socket) => {
			let buffered = "";
			socket.on("data", (chunk) => {
				buffered += chunk.toString("utf8");
				let newline: number;
				while ((newline = buffered.indexOf("\n")) >= 0) {
					const line = buffered.slice(0, newline);
					buffered = buffered.slice(newline + 1);
					const message = JSON.parse(line) as { type?: unknown; id?: unknown };
					if (message.type === "hello") {
						socket.write(
							JSON.stringify({
								type: "hello-ok",
								protocolMajor: 1,
								fencingEpoch: 8,
								role: "writer",
								capabilities: ["status"],
							}) + "\n",
						);
					} else if (message.type === "rpc") {
						rpcReceived = true;
						socket.write(JSON.stringify({ type: "rpc-result", id: message.id, result: {} }) + "\n");
					}
				}
			});
		});
		await new Promise<void>((resolve, reject) => {
			server!.once("error", reject);
			server!.listen(socketPath, resolve);
		});

		await assert.rejects(
			() =>
				controlClientRpc(
					"status",
					{ runId: "forged", projectId: "proj-forged" },
					{
						socketPath,
						expectedFencingEpoch: 7,
						expectedRole: "writer",
						timeoutMs: 1_000,
					},
				),
			(error: Error & { code?: string }) => error.code === "TF_BOOTSTRAP_FAILED",
		);
		assert.equal(rpcReceived, false, "identity mismatch must stop before the RPC is sent");
	} finally {
		if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
		fs.rmSync(root, { recursive: true, force: true });
	}
});
