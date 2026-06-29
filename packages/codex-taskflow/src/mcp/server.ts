/**
 * pi-taskflow as an MCP server for Codex (and any MCP client).
 *
 * Exposes the taskflow engine as MCP tools so a Codex user can declare and run
 * verifiable task DAGs from inside codex — the mirror of codex-runner.ts (which
 * lets taskflow *call* codex). Here taskflow is *called by* codex: each subagent
 * a flow spawns is itself a `codex exec` process (via codexSubagentRunner), so
 * the whole thing closes the loop with no pi process required.
 *
 * Protocol: MCP over stdio, JSON-RPC 2.0 (newline-delimited). Implemented on the
 * dependency-free transport in ./jsonrpc.ts — pi-taskflow keeps its zero-runtime
 * -deps guarantee; we do NOT use @modelcontextprotocol/sdk.
 *
 * Tools exposed:
 *   - taskflow_run     : run an inline or saved flow, return the final output
 *   - taskflow_list    : list saved flows discoverable in this cwd
 *   - taskflow_show    : show a saved flow's definition
 *   - taskflow_verify  : statically verify a flow (no execution)
 *   - taskflow_compile : render a flow as a Mermaid diagram + verify report
 */

import { RpcError, RPC, serveStdio, type RpcHandler } from "./jsonrpc.ts";
import { codexSubagentRunner } from "../codex-runner.ts";
import {
	discoverAgents,
	executeTaskflow,
	getFlow,
	listFlows,
	compileTaskflow,
	verifyTaskflow,
	desugar,
	isShorthand,
	validateTaskflow,
	type RuntimeDeps,
	type RunState,
	type Taskflow,
} from "taskflow-core";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "pi-taskflow", title: "pi-taskflow", version: "0.0.28" } as const;

/** An MCP tool definition as returned by tools/list. */
interface McpTool {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

/** MCP tools/call content block (text only — sufficient for our outputs). */
function textContent(text: string, isError = false) {
	return { content: [{ type: "text", text }], isError };
}

const TOOLS: McpTool[] = [
	{
		name: "taskflow_run",
		title: "Run a taskflow",
		description:
			"Run a taskflow DAG and return its final output. Provide EITHER `name` (a saved flow) OR `define` (an inline flow definition: {name, phases:[…]} or a shorthand {task} / {tasks} / {chain}). Subagents execute as codex sessions. Intermediate phase outputs stay in the runtime; only the final phase output is returned.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				name: { type: "string", description: "Name of a saved flow to run." },
				define: { type: "object", description: "Inline flow definition (full DAG or shorthand)." },
				args: { type: "object", description: "Invocation arguments interpolated as {args.X}." },
				incremental: { type: "boolean", description: "Default every phase to cross-run cache reuse." },
			},
		},
	},
	{
		name: "taskflow_list",
		title: "List saved taskflows",
		description: "List the saved taskflows discoverable from the current working directory (user + project scope).",
		inputSchema: { type: "object", additionalProperties: false, properties: {} },
	},
	{
		name: "taskflow_show",
		title: "Show a saved taskflow",
		description: "Show a saved flow's full definition as JSON.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { name: { type: "string", description: "Name of the saved flow." } },
			required: ["name"],
		},
	},
	{
		name: "taskflow_verify",
		title: "Verify a taskflow",
		description: "Statically verify a flow (cycles, missing deps, undefined refs, …) WITHOUT executing it. Provide `name` or `define`.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				name: { type: "string" },
				define: { type: "object" },
			},
		},
	},
	{
		name: "taskflow_compile",
		title: "Compile a taskflow to a diagram",
		description: "Render a flow as a Mermaid flowchart + a static verification report (markdown). No execution. Provide `name` or `define`.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				name: { type: "string" },
				define: { type: "object" },
			},
		},
	},
];

/** Resolve a flow from params: inline `define` (desugared) or saved `name`. */
function resolveFlow(cwd: string, params: { name?: string; define?: unknown }): Taskflow {
	if (params.define !== undefined && params.define !== null) {
		return isShorthand(params.define) ? desugar(params.define) : (params.define as Taskflow);
	}
	if (params.name) {
		const saved = getFlow(cwd, params.name);
		if (!saved) throw new RpcError(RPC.INVALID_PARAMS, `No saved flow named "${params.name}" found from ${cwd}.`);
		return saved.def;
	}
	throw new RpcError(RPC.INVALID_PARAMS, "Provide either `name` (a saved flow) or `define` (an inline flow).");
}

function mkRunState(def: Taskflow, args: Record<string, unknown>, cwd: string): RunState {
	return {
		runId: `mcp-${def.name ?? "flow"}-${Date.now()}`,
		flowName: def.name ?? "flow",
		def,
		args,
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
	};
}

/**
 * Build the per-call tool handlers. `cwd` is the directory the server was
 * launched in (where saved flows + agents are discovered, and where codex
 * subagents run).
 */
export function makeToolHandlers(cwd: string): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
	return {
		taskflow_run: async (args) => {
			const def = resolveFlow(cwd, args);
			const v = validateTaskflow(def);
			if (!v.ok) return textContent(`Flow is invalid:\n- ${v.errors.join("\n- ")}`, true);

			const { agents } = discoverAgents(cwd, "both");
			const deps: RuntimeDeps = {
				cwd,
				agents,
				runTask: codexSubagentRunner.runTask,
			};
			const state = mkRunState(def, (args.args as Record<string, unknown>) ?? {}, cwd);
			if (args.incremental === true) (deps as RuntimeDeps & { cacheScopeDefault?: string }).cacheScopeDefault = "cross-run";

			const res = await executeTaskflow(state, deps);
			const header = res.ok ? "✓ taskflow complete" : "✗ taskflow did not fully succeed";
			const usage = res.totalUsage;
			const usageLine = `\n\n— usage: ${usage.turns} turns, in ${usage.input}, out ${usage.output}`;
			return textContent(`${header}\n\n${res.finalOutput}${usageLine}`, !res.ok);
		},

		taskflow_list: async () => {
			const flows = listFlows(cwd);
			if (flows.length === 0) return textContent("No saved taskflows found from this directory.");
			const lines = flows.map((f) => `- ${f.name} (${f.scope}) — ${f.def.phases.length} phase(s)`);
			return textContent(`Saved taskflows:\n${lines.join("\n")}`);
		},

		taskflow_show: async (args) => {
			const name = String(args.name ?? "");
			const saved = getFlow(cwd, name);
			if (!saved) return textContent(`No saved flow named "${name}".`, true);
			return textContent("```json\n" + JSON.stringify(saved.def, null, 2) + "\n```");
		},

		taskflow_verify: async (args) => {
			const def = resolveFlow(cwd, args);
			// Two layers: validateTaskflow catches structural errors (cycles, missing
			// deps, undefined refs); verifyTaskflow adds the deeper static-quality
			// issues. Combine both so the tool matches the `/tf verify` behavior.
			const val = validateTaskflow(def);
			const result = verifyTaskflow(def as Parameters<typeof verifyTaskflow>[0]);
			const errors = result.issues.filter((i) => i.severity === "error");
			const warnings = result.issues.filter((i) => i.severity === "warning");
			const passed = val.ok && result.ok && errors.length === 0;
			const ok = passed ? "✓ verification PASSED" : "✗ verification FAILED";
			const fmt = (i: { category: string; phaseId?: string; message: string }) =>
				`- ${i.category}${i.phaseId ? ` [${i.phaseId}]` : ""}: ${i.message}`;
			const valErrs = val.errors.length ? `\n\nErrors:\n- ${val.errors.join("\n- ")}` : "";
			const errs = errors.length ? `${valErrs ? "" : "\n\nErrors:"}\n${errors.map(fmt).join("\n")}` : "";
			const allWarn = [...val.warnings.map((w) => `- ${w}`), ...warnings.map(fmt)];
			const warns = allWarn.length ? `\n\nWarnings:\n${allWarn.join("\n")}` : "";
			return textContent(`${ok}${valErrs}${errs}${warns}`, !passed);
		},

		taskflow_compile: async (args) => {
			const def = resolveFlow(cwd, args);
			const result = compileTaskflow(def);
			return textContent(result.markdown, !result.verification.ok);
		},
	};
}

/** Build the full MCP method dispatch table (protocol + tools). */
export function makeMcpHandlers(cwd: string): Record<string, RpcHandler> {
	const tools = makeToolHandlers(cwd);
	let initialized = false;

	return {
		initialize: () => {
			initialized = true;
			return {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: false } },
				serverInfo: SERVER_INFO,
			};
		},
		// Client tells us it's ready — notification, no response.
		"notifications/initialized": () => {
			initialized = true;
		},
		ping: () => ({}),
		"tools/list": () => ({ tools: TOOLS }),
		"tools/call": async (params) => {
			const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
			const tool = tools[p.name ?? ""];
			if (!tool) throw new RpcError(RPC.INVALID_PARAMS, `Unknown tool: ${p.name}`);
			void initialized; // tolerant: we don't hard-gate on initialize ordering
			return await tool(p.arguments ?? {});
		},
	};
}

/** Start the stdio MCP server. Resolves when the client disconnects. */
export function startMcpServer(cwd: string = process.cwd()): Promise<void> {
	return serveStdio(makeMcpHandlers(cwd));
}
