// Harmless stdio MCP server used only by the real CLI compatibility suite.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (request.id === undefined) continue;
	let result = {};
	if (process.env.TASKFLOW_COMPAT_AUDIT) appendFileSync(process.env.TASKFLOW_COMPAT_AUDIT, JSON.stringify({ method: request.method, params: request.params }) + "\n");
	if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "compat", version: "1" } };
	if (request.method === "tools/list") result = { tools: [{ name: "probe", description: "Harmless compatibility probe", inputSchema: { type: "object", properties: {} } }] };
	if (request.method === "tools/call") result = { content: [{ type: "text", text: "MCP_OK" }] };
	if (request.method === "resources/list") result = { resources: [{ uri: "compat://fixture", name: "Harmless fixture", mimeType: "text/plain" }] };
	if (request.method === "resources/templates/list") result = { resourceTemplates: [{ uriTemplate: "compat://{name}", name: "Harmless template" }] };
	if (request.method === "resources/read") result = { contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "RESOURCE_OK" }] };
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
