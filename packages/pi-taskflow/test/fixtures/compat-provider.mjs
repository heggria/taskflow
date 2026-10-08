// Deterministic model at the provider boundary; the installed Pi CLI, extension,
// tool dispatch, child process and JSON/RPC protocols remain real.
export default function (pi) {
	if (!process.env.TASKFLOW_COMPAT_FIXTURE) throw new Error("Test fixture requires explicit opt-in");
	let attempts = 0;
	pi.registerProvider("taskflow-compat", {
		api: "taskflow-compat-api", baseUrl: "http://127.0.0.1", apiKey: "local-fixture",
		models: [{ id: "fixture", name: "Local fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
		streamSimple(model, context) {
			const user = context.messages.filter(m => m.role === "user").at(-1);
			const prompt = typeof user?.content === "string" ? user.content : (user?.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
			const results = context.messages.filter(m => m.role === "toolResult");
			const tool = (name, args) => [{ type: "toolCall", id: "compat-call", name, arguments: args }];
			let content = [{ type: "text", text: "CHILD_OK" }], stopReason = "stop", errorMessage;
			if (results.length) content = [{ type: "text", text: JSON.stringify(results.at(-1).content) }];
			else if (prompt.includes("CHILD_RETRY") && attempts++ === 0) {
				content = []; stopReason = "error"; errorMessage = "429 rate limit exceeded (local fixture)";
			} else if (prompt.includes("CHILD_IDENTITY")) content = [{ type: "text", text: process.env.PI_SUBAGENT_RUN_ID ?? "MISSING_ID" }];
			else if (prompt.includes("TOOL_NAMES")) {
				// Pi 0.x provides context.tools; Pi 1.x normalizes tools into system messages.
				const tools = context.tools ?? context.messages.filter(m => m.role === "system").flatMap(m => m.toolsAdded ?? []);
				content = [{ type: "text", text: JSON.stringify(tools.map(t => t.name).sort()) }];
			} else if (prompt.includes("CHILD_MCP")) content = tool("codemode", { code: "text(await tools.mcp__compat__probe({}));" });
			else if (prompt === "HOST:version") content = tool("taskflow", { action: "version" });
			else if (prompt === "HOST:approval") content = tool("taskflow", { action: "run", define: { name: "compat-approval", phases: [
				{ id: "review", type: "approval", task: "Approve fixture?" },
				{ id: "after", type: "script", run: "printf AFTER_APPROVAL", dependsOn: ["review"], final: true },
			] } });
			else if (prompt === "HOST:identity") content = tool("taskflow", { action: "run", define: { name: "compat-identity", phases: [
				{ id: "child", type: "agent", agent: "executor", task: "CHILD_IDENTITY", final: true },
			] } });
			if (content.some(c => c.type === "toolCall")) stopReason = "toolUse";
			const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now() };
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "start", partial: message };
					yield stopReason === "error" ? { type: "error", reason: "error", error: message } : { type: "done", reason: stopReason, message };
				},
				async result() { return message; },
			};
		},
	});
}
