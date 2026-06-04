/**
 * pi-taskflow — lightweight workflow orchestration for the Pi coding agent.
 *
 * Registers:
 *   - tool `taskflow`        : run inline / saved flows, save, resume (LLM-callable)
 *   - command `/tf`          : list | run | show | save | resume | runs (user)
 *   - command `/tf:<name>`   : per-saved-flow shortcut (registered on session_start)
 *
 * Intermediate phase outputs are held in the runtime and never pushed into the
 * host conversation context — only the final phase output is returned.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentScope, discoverAgents, readSubagentSettings } from "./agents.ts";
import { renderRunResult, summarizeRun } from "./render.ts";
import { RunHistoryComponent, type RunHistoryResult } from "./runs-view.ts";
import { executeTaskflow, type RuntimeResult } from "./runtime.ts";
import { finalPhase, type Taskflow, validateTaskflow } from "./schema.ts";
import {
	getFlow,
	listFlows,
	listRuns,
	loadRun,
	newRunId,
	type RunState,
	saveFlow,
	saveRun,
} from "./store.ts";

interface TaskflowDetails {
	state?: RunState;
	finalOutput?: string;
	action: string;
	message?: string;
}

/** pi reads `isError` at runtime to mark tool failures; it is not in the public type. */
type ToolResult = AgentToolResult<TaskflowDetails> & { isError?: boolean };

const TaskflowParams = Type.Object({
	action: StringEnum(["run", "save", "resume", "list"] as const, {
		description: "What to do: run a flow, save a definition, resume a paused run, or list saved flows",
		default: "run",
	}),
	name: Type.Optional(Type.String({ description: "Name of a saved flow (for run/save without inline define)" })),
	define: Type.Optional(
		Type.Unknown({
			description:
				"Inline taskflow definition (JSON object matching the taskflow DSL). Use to run or save a new flow.",
		}),
	),
	args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Invocation arguments for the flow" })),
	runId: Type.Optional(Type.String({ description: "Run id to resume (for action=resume)" })),
	scope: Type.Optional(
		StringEnum(["user", "project"] as const, { description: "Where to save (action=save)", default: "project" }),
	),
});

function resolveArgs(def: Taskflow, provided: Record<string, unknown> | undefined): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	for (const [key, spec] of Object.entries(def.args ?? {})) {
		if (provided && key in provided) args[key] = provided[key];
		else if (spec.default !== undefined) args[key] = spec.default;
	}
	// also pass through any extra provided args
	if (provided) for (const [k, v] of Object.entries(provided)) if (!(k in args)) args[k] = v;
	return args;
}

function makeRunState(def: Taskflow, args: Record<string, unknown>, cwd: string): RunState {
	return {
		runId: newRunId(def.name),
		flowName: def.name,
		def,
		args,
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
	};
}

async function runFlow(
	def: Taskflow,
	args: Record<string, unknown>,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	onUpdate: ((p: AgentToolResult<TaskflowDetails>) => void) | undefined,
	existing?: RunState,
): Promise<RuntimeResult> {
	const settings = readSubagentSettings();
	const scope: AgentScope = def.agentScope ?? "user";
	const { agents } = discoverAgents(ctx.cwd, scope, settings.agentOverrides);

	const state = existing ?? makeRunState(def, args, ctx.cwd);

	const emit = (s: RunState, finalOutput?: string) => {
		onUpdate?.({
			content: [{ type: "text", text: finalOutput ?? summarizeRun(s) }],
			details: { action: "run", state: s, finalOutput },
		});
	};

	// Throttled persistence: avoid disk writes on every sub-item event.
	let lastPersist = 0;
	const persistThrottled = (s: RunState) => {
		const now = Date.now();
		if (now - lastPersist >= 1000) {
			lastPersist = now;
			saveRun(s);
		}
	};

	// ~8fps heartbeat drives all rendering: it naturally caps the frame rate
	// (no event bursts) while keeping the spinner, elapsed timers, live tokens
	// and the latest message current. Phase events only mutate `state`.
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	if (onUpdate) {
		heartbeat = setInterval(() => {
			if (state.status === "running") emit(state);
		}, 120);
		(heartbeat as { unref?: () => void }).unref?.();
	}

	try {
		const result = await executeTaskflow(state, {
			cwd: ctx.cwd,
			agents,
			globalThinking: settings.globalThinking,
			signal,
			persist: persistThrottled,
		});
		return result;
	} finally {
		if (heartbeat) clearInterval(heartbeat);
		saveRun(state); // force-persist terminal state
		emit(state); // final render reflecting terminal state
	}
}

export default function (pi: ExtensionAPI) {
	// ---- Register per-saved-flow shortcut commands on session start ----
	const registerSavedFlowCommands = (ctx: ExtensionContext) => {
		const flows = listFlows(ctx.cwd);
		for (const flow of flows) {
			const cmdName = `tf:${flow.name}`;
			pi.registerCommand(cmdName, {
				description: flow.def.description || `Run taskflow '${flow.name}'`,
				handler: async (args, cmdCtx) => {
					if (!cmdCtx.isIdle()) {
						cmdCtx.ui.notify("Agent is busy; try again when idle.", "warning");
						return;
					}
					const parsed = parseArgsString(args, flow.def);
					pi.sendUserMessage(
						`Run the saved taskflow "${flow.name}" using the taskflow tool with action="run", name="${flow.name}", args=${JSON.stringify(parsed)}.`,
					);
				},
			});
		}
	};

	pi.on("session_start", async (_e, ctx) => registerSavedFlowCommands(ctx));

	// ---- The LLM-callable tool ----
	pi.registerTool({
		name: "taskflow",
		label: "Taskflow",
		description: [
			"Orchestrate a multi-phase workflow of subagents from a declarative definition.",
			"Phases (agent, parallel, map, gate, reduce) form a DAG; intermediate outputs stay out of your context — only the final phase output is returned.",
			"Use action=run with an inline `define` (you write the DSL) or a saved `name`.",
			"Use action=save to persist a definition as a reusable /tf:<name> command. action=resume continues a paused run. action=list shows saved flows.",
			"DSL: {name, args?, concurrency?, phases:[{id, type, agent, task, dependsOn?, over?(map), as?(map), branches?(parallel), from?(reduce), output?:'json', final?}]}.",
			"Interpolation: {args.X}, {steps.ID.output}, {steps.ID.json}, {item} (map), {previous.output}.",
		].join(" "),
		parameters: TaskflowParams,
		promptSnippet: "Orchestrate many subagents over a whole codebase/many items (declarative DAG with map fan-out)",
		promptGuidelines: [
			"Prefer taskflow whenever a request spans a whole project/codebase or many items — e.g. 'explore / 探索 / 审计 / analyze the project', auditing endpoints, reviewing or migrating many files/modules, or cross-checked research. It fans out to many subagents across phases and aggregates the result, keeping intermediate work out of your context.",
			"Choose taskflow over ad-hoc parallel subagents when the work has multiple phases (discover → work → review → report), needs dynamic fan-out over a discovered list, or should be saved and rerun. Use the plain subagent tool only for a single delegated task.",
			"For taskflow map phases, have the upstream phase emit a JSON array and set output:'json'.",
		],

		async execute(_id, params, signal, onUpdate, ctx) {
			const action = params.action ?? "run";

			// list
			if (action === "list") {
				const flows = listFlows(ctx.cwd);
				const text = flows.length
					? flows.map((f) => `- ${f.name} (${f.scope}): ${f.def.description ?? ""}`).join("\n")
					: "No saved taskflows.";
				return { content: [{ type: "text", text }], details: { action } satisfies TaskflowDetails };
			}

			// resume
			if (action === "resume") {
				if (!params.runId)
					return errorResult(action, "action=resume requires 'runId'");
				const prev = loadRun(ctx.cwd, params.runId);
				if (!prev) return errorResult(action, `Run not found: ${params.runId}`);
				const result = await runFlow(prev.def, prev.args, ctx, signal, onUpdate as any, prev);
				return finalResult(action, result);
			}

			// resolve the definition (inline define wins, else saved name)
			let def: Taskflow | undefined;
			if (params.define) {
				const v = validateTaskflow(params.define);
				if (!v.ok) return errorResult(action, `Invalid taskflow:\n- ${v.errors.join("\n- ")}`);
				def = params.define as Taskflow;
			} else if (params.name) {
				const saved = getFlow(ctx.cwd, params.name);
				if (!saved) return errorResult(action, `Saved flow not found: ${params.name}`);
				def = saved.def;
			}
			if (!def) return errorResult(action, "Provide 'define' (inline) or 'name' (saved).");

			// save
			if (action === "save") {
				const v = validateTaskflow(def);
				if (!v.ok) return errorResult(action, `Invalid taskflow:\n- ${v.errors.join("\n- ")}`);
				const { filePath } = saveFlow(ctx.cwd, def, params.scope ?? "project");
				// Make the shortcut available immediately this session.
				pi.registerCommand(`tf:${def.name}`, {
					description: def.description || `Run taskflow '${def.name}'`,
					handler: async (args, cmdCtx) => {
						const parsed = parseArgsString(args, def!);
						if (cmdCtx.isIdle())
							pi.sendUserMessage(
								`Run the saved taskflow "${def!.name}" using the taskflow tool with action="run", name="${def!.name}", args=${JSON.stringify(parsed)}.`,
							);
					},
				});
				return {
					content: [
						{ type: "text", text: `Saved taskflow '${def.name}' → ${filePath}\nRun it with /tf:${def.name} or action=run.` },
					],
					details: { action, message: filePath } satisfies TaskflowDetails,
				};
			}

			// run
			const v = validateTaskflow(def);
			if (!v.ok) return errorResult(action, `Invalid taskflow:\n- ${v.errors.join("\n- ")}`);
			const args = resolveArgs(def, params.args);
			const result = await runFlow(def, args, ctx, signal, onUpdate as any);
			return finalResult(action, result);
		},

		renderCall(args, theme) {
			const action = args.action ?? "run";
			const name = args.name || (args.define as any)?.name || "(inline)";
			let text = theme.fg("toolTitle", theme.bold("taskflow ")) + theme.fg("accent", `${action} `) + theme.fg("muted", name);
			const phases = (args.define as Taskflow | undefined)?.phases;
			if (phases) text += theme.fg("dim", ` (${phases.length} phases)`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TaskflowDetails | undefined;
			if (!details?.state) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
			}
			return renderRunResult(details.state, details.finalOutput ?? "", theme, expanded);
		},
	});

	// ---- The /tf user command ----
	pi.registerCommand("tf", {
		description: "Taskflow: list | run <name> | show <name> | runs",
		getArgumentCompletions: (prefix) => {
			const subs = ["list", "run", "show", "runs", "resume"];
			const items = subs.map((s) => ({ value: s, label: s }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (argStr, ctx) => {
			const [sub, ...rest] = argStr.trim().split(/\s+/);
			const arg = rest.join(" ");

			if (!sub || sub === "list") {
				const flows = listFlows(ctx.cwd);
				if (flows.length === 0) {
					ctx.ui.notify("No saved taskflows. Ask the agent to create one.", "info");
					return;
				}
				ctx.ui.notify(flows.map((f) => `${f.name} (${f.scope}) — ${f.def.description ?? ""}`).join("\n"), "info");
				return;
			}

			if (sub === "show") {
				const flow = getFlow(ctx.cwd, arg);
				if (!flow) {
					ctx.ui.notify(`Flow not found: ${arg}`, "error");
					return;
				}
				ctx.ui.notify(JSON.stringify(flow.def, null, 2), "info");
				return;
			}

			if (sub === "runs") {
				const runs = listRuns(ctx.cwd, 50);
				if (runs.length === 0) {
					ctx.ui.notify("No taskflow runs yet.", "info");
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify(
						runs.map((r) => `${r.runId} [${r.status}] ${r.flowName} — ${summarizeRun(r)}`).join("\n"),
						"info",
					);
					return;
				}
				const result = await ctx.ui.custom<RunHistoryResult | undefined>((_tui, theme, _kb, done) => {
					return new RunHistoryComponent(runs, theme, (r) => done(r));
				});
				if (result?.action === "resume") {
					if (ctx.isIdle()) {
						pi.sendUserMessage(
							`Resume the taskflow run "${result.runId}" using the taskflow tool with action="resume", runId="${result.runId}".`,
						);
					} else {
						ctx.ui.notify("Agent is busy; try /tf resume when idle.", "warning");
					}
				}
				return;
			}

			if (sub === "run") {
				if (!arg) {
					ctx.ui.notify("Usage: /tf run <name> [args-json]", "warning");
					return;
				}
				const [name, ...maybeArgs] = arg.split(/\s+/);
				const flow = getFlow(ctx.cwd, name);
				if (!flow) {
					ctx.ui.notify(`Flow not found: ${name}`, "error");
					return;
				}
				if (!ctx.isIdle()) {
					ctx.ui.notify("Agent is busy; try again when idle.", "warning");
					return;
				}
				const parsed = parseArgsString(maybeArgs.join(" "), flow.def);
				pi.sendUserMessage(
					`Run the saved taskflow "${name}" using the taskflow tool with action="run", name="${name}", args=${JSON.stringify(parsed)}.`,
				);
				return;
			}

			if (sub === "resume") {
				if (!arg) {
					ctx.ui.notify("Usage: /tf resume <runId>", "warning");
					return;
				}
				if (!ctx.isIdle()) {
					ctx.ui.notify("Agent is busy; try again when idle.", "warning");
					return;
				}
				pi.sendUserMessage(`Resume the taskflow run "${arg}" using the taskflow tool with action="resume", runId="${arg}".`);
				return;
			}

			ctx.ui.notify(`Unknown subcommand: ${sub}`, "warning");
		},
	});
}

// --- helpers ---

function errorResult(action: string, message: string): ToolResult {
	return {
		content: [{ type: "text", text: message }],
		details: { action, message },
		isError: true,
	};
}

function finalResult(action: string, result: RuntimeResult): ToolResult {
	const fp = finalPhase(result.state.def.phases);
	const header = result.ok
		? `Taskflow '${result.state.flowName}' completed (${summarizeRun(result.state)}). Run id: ${result.state.runId}`
		: `Taskflow '${result.state.flowName}' ${result.state.status} (${summarizeRun(result.state)}). Run id: ${result.state.runId} — resume with action=resume.`;
	return {
		content: [{ type: "text", text: `${header}\n\n--- ${fp.id} ---\n${result.finalOutput}` }],
		details: { action, state: result.state, finalOutput: result.finalOutput },
		isError: !result.ok,
	};
}

/** Parse a CLI-ish arg string into an args object. Accepts JSON or key=value pairs. */
function parseArgsString(input: string, def: Taskflow): Record<string, unknown> {
	const trimmed = (input ?? "").trim();
	if (!trimmed) return {};
	if (trimmed.startsWith("{")) {
		try {
			return JSON.parse(trimmed);
		} catch {
			/* fall through */
		}
	}
	// key=value pairs
	const out: Record<string, unknown> = {};
	const pairs = trimmed.match(/(\w+)=("[^"]*"|\S+)/g);
	if (pairs) {
		for (const p of pairs) {
			const idx = p.indexOf("=");
			const k = p.slice(0, idx);
			let v: string = p.slice(idx + 1);
			if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
			out[k] = v;
		}
		return out;
	}
	// single positional → first declared arg
	const firstArg = Object.keys(def.args ?? {})[0];
	if (firstArg) return { [firstArg]: trimmed };
	return {};
}
