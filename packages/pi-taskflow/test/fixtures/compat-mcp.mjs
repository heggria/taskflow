// Harmless stdio MCP server used only by the real CLI compatibility suite.
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (request.id === undefined) continue;
	let result = {};
	if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "compat", version: "1" } };
	if (request.method === "tools/list") result = { tools: [{ name: "probe", description: "Harmless compatibility probe", inputSchema: { type: "object", properties: {} } }] };
	if (request.method === "tools/call") result = { content: [{ type: "text", text: "MCP_OK" }] };
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
