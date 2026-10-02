/** Local, deterministic provider for the real Pi CLI integration suite. No network or credentials. */
import { createFauxCore, fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";

export default function (pi: ExtensionAPI) {
	const handshake = process.env.TASKFLOW_E2E_TOKEN;
	if (!handshake) throw new Error("TASKFLOW_E2E_TOKEN is required by this local test fixture");
	let retries = 0;
	const core = createFauxCore({ provider: "taskflow-e2e", api: "taskflow-e2e-api", models: [{ id: "fixture", contextWindow: 200000, maxTokens: 4096 }] });
	pi.registerTool({
		name: "fixture_meter", label: "Fixture meter", description: "Return synthetic tool usage.", parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "METER_OK" }], details: {}, usage: {
				input: 100, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 300,
				cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
			} };
		},
	});
	core.setResponses(Array.from({ length: 30 }, () => async (context) => {
		const user = context.messages.filter((m) => m.role === "user").at(-1);
		const text = typeof user?.content === "string" ? user.content : (user?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
		const results = context.messages.filter((m) => m.role === "toolResult");
		if (text.includes("CHILD_FAIL") || (text.includes("CHILD_RETRY") && retries++ === 0)) {
			return fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 rate limit exceeded (local fixture)" });
		}
		if (text.includes("CHILD_SLOW")) {
			if (!process.env.TASKFLOW_E2E_WAIT_FILE) throw new Error("Missing cancellation handshake path");
			fs.writeFileSync(process.env.TASKFLOW_E2E_WAIT_FILE, String(process.pid));
			await new Promise((resolve) => setTimeout(resolve, 5000));
		}
		if (results.length) {
			return fauxAssistantMessage(text.includes("READ_TOKEN") ? JSON.stringify(results.at(-1)?.content) : "TOOLS_DONE");
		}
		if (text.startsWith("HOST:")) {
			const which = text.slice(5);
			if (which === "version") return fauxAssistantMessage(fauxToolCall("taskflow", { action: "version" }));
			if (which === "codemode") return fauxAssistantMessage(fauxToolCall("codemode", { code: 'text(await tools.taskflow({action:"version"}));' }));
			if (which === "shorthand") return fauxAssistantMessage(fauxToolCall("taskflow", { task: "CHILD_OK", agent: "executor" }));
			if (which === "approval") return fauxAssistantMessage(fauxToolCall("taskflow", { action: "run", define: { name: "rpc-approval", phases: [
				{ id: "review", type: "approval", task: "Approve running the harmless fixture command?" },
				{ id: "after", type: "script", run: "printf AFTER_APPROVAL", dependsOn: ["review"], final: true },
			] } }));
			if (which === "context") return fauxAssistantMessage(fauxToolCall("taskflow", { action: "run", define: { name: "ctx-e2e", contextSharing: true, phases: [
				{ id: "writer", type: "agent", agent: "executor", task: "WRITE_TOKEN" },
				{ id: "reader", type: "agent", agent: "executor", task: "READ_TOKEN", dependsOn: ["writer"], final: true },
			] } }));
			if (which === "dag") return fauxAssistantMessage(fauxToolCall("taskflow", { action: "run", define: { name: "dag-e2e", phases: [
				{ id: "seed", type: "agent", agent: "executor", task: "ARRAY", output: "json" },
				{ id: "fanout", type: "map", over: "{steps.seed.json}", as: "item", agent: "executor", task: "UPPER:{item.word}", dependsOn: ["seed"] },
				{ id: "join", type: "reduce", from: ["fanout"], agent: "executor", task: "JOIN:{steps.fanout.output}", dependsOn: ["fanout"], final: true },
			] } }));
			throw new Error(`Unknown fixture host request: ${which}`);
		}
		if (text.includes("CHILD_USAGE")) return fauxAssistantMessage(fauxToolCall("fixture_meter", {}));
		if (text.includes("WRITE_TOKEN")) return fauxAssistantMessage(fauxToolCall("ctx_write", { key: "handshake", value: handshake }));
		if (text.includes("READ_TOKEN")) return fauxAssistantMessage(fauxToolCall("ctx_read", { key: "handshake" }));
		if (text.includes("ARRAY")) return fauxAssistantMessage('[{"word":"one"},{"word":"two"}]');
		if (text.includes("UPPER:")) return fauxAssistantMessage(text.split("UPPER:").at(-1)!.trim().toUpperCase());
		if (text.includes("JOIN:")) return fauxAssistantMessage(text.split("JOIN:").at(-1)!);
		if (text.includes("CHILD_LEAK")) setInterval(() => {}, 1000);
		return fauxAssistantMessage("CHILD_OK");
	}));
	pi.registerProvider("taskflow-e2e", {
		api: "taskflow-e2e-api", baseUrl: "http://127.0.0.1", apiKey: handshake,
		models: [{ id: "fixture", name: "Local fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
		streamSimple: core.streamSimple,
	});
}
