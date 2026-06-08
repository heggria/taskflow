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

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentScope, discoverAgents, readSubagentSettings } from "./agents.ts";
import { renderRunResult, summarizeRun } from "./render.ts";
import { RunHistoryComponent, type RunHistoryResult } from "./runs-view.ts";
import { executeTaskflow, type ApprovalDecision, type ApprovalRequest, type RuntimeResult } from "./runtime.ts";
import { finalPhase, resolveArgs, type Taskflow, validateTaskflow, desugar, isShorthand } from "./schema.ts";
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
import { CacheStore } from "./cache.ts";

interface TaskflowDetails {
	state?: RunState;
	finalOutput?: string;
	action: string;
	message?: string;
}

/** pi reads `isError` at runtime to mark tool failures; it is not in the public type. */
type ToolResult = AgentToolResult<TaskflowDetails> & { isError?: boolean };

const ShorthandStep = Type.Object(
	{
		agent: Type.Optional(Type.String({ description: "Agent for this step (defaults to the first available agent)" })),
		task: Type.String({ description: "Task prompt for this step (supports {previous.output} in chains)" }),
	},
	{ additionalProperties: false },
);

const TaskflowParams = Type.Object({
	action: StringEnum(["run", "save", "resume", "list", "agents", "init", "cache-clear"] as const, {
		description: "What to do: run a flow, save a definition, resume a paused run, list saved flows, list available agents, init model role configuration, or clear the cross-run memoization cache",
		default: "run",
	}),
	name: Type.Optional(Type.String({ description: "Name of a saved flow (for run/save without inline define)" })),
	define: Type.Optional(
		Type.Unknown({
			description:
				"Inline taskflow definition (JSON object matching the taskflow DSL). Use to run or save a new flow.",
		}),
	),
	// --- Shorthand (non-DAG) modes, like the subagent tool. No DSL required. ---
	agent: Type.Optional(
		Type.String({ description: "Shorthand single mode: agent to run with `task` (like subagent single mode)" }),
	),
	task: Type.Optional(
		Type.String({ description: "Shorthand single mode: the task prompt (like subagent single mode)" }),
	),
	tasks: Type.Optional(
		Type.Array(ShorthandStep, {
			description: "Shorthand parallel mode: run these tasks concurrently and merge results (like subagent parallel)",
		}),
	),
	chain: Type.Optional(
		Type.Array(ShorthandStep, {
			description:
				"Shorthand chain mode: run sequentially; reference the prior step with {previous.output} (like subagent chain)",
		}),
	),
	args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Invocation arguments for the flow" })),
	runId: Type.Optional(Type.String({ description: "Run id to resume (for action=resume)" })),
	scope: Type.Optional(
		StringEnum(["user", "project"] as const, { description: "Where to save (action=save)", default: "project" }),
	),
});

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

	// Human-in-the-loop approver — only when an interactive UI is available.
	const requestApproval = ctx.hasUI
		? async (req: ApprovalRequest): Promise<ApprovalDecision> => {
				if (req.upstream?.trim()) {
					const snip = req.upstream.replace(/\s+/g, " ").trim();
					ctx.ui.notify(`[${def.name}/${req.phaseId}] ${snip.length > 280 ? `${snip.slice(0, 280)}…` : snip}`, "info");
				}
				const choice = await ctx.ui.select(
					`Taskflow approval — ${req.phaseId}: ${req.message}`,
					["Approve", "Reject", "Edit / add guidance"],
					{ signal },
				);
				if (!choice || choice === "Reject") return { decision: "reject" };
				if (choice.startsWith("Edit")) {
					const note = await ctx.ui.input("Guidance passed downstream as this phase's output", "type guidance…", {
						signal,
					});
					return { decision: "edit", note: note ?? "" };
				}
				return { decision: "approve" };
			}
		: undefined;

	try {
		// Discover settings/agents inside try so a YAML/IO crash in
		// discoverAgents or readSubagentSettings (F-001) is caught and
		// the heartbeat timer is cleared by the finally block below.
		const settings = readSubagentSettings();
		const scope: AgentScope = def.agentScope ?? "user";
		const { agents } = discoverAgents(ctx.cwd, scope, settings.agentOverrides, settings.modelRoles);

		// Hint: if any agent still has unresolved {{role}} references, suggest configuring modelRoles
		const unresolvedRoles = agents
			.filter(a => a.model && /^\{\{\w+\}\}$/.test(a.model))
			.map(a => a.model!.match(/^\{\{(\w+)\}\}$/)![1]);
		if (unresolvedRoles.length > 0) {
			const unique = [...new Set(unresolvedRoles)];
			console.warn(
				`[taskflow] Hint: ${unique.length} model role(s) not configured: ${unique.join(", ")}. ` +
				`Agents will use the default model (slower / less optimal). ` +
				`Run /tf init to auto-generate modelRoles config.`
			);
		}

		// Pre-flight: warn if any phase references an agent not in the registry
		const agentNames = new Set(agents.map(a => a.name));
		for (const p of def.phases ?? []) {
			if (p.agent && !agentNames.has(p.agent)) {
				console.warn(`[taskflow] Warning: phase '${p.id}' references agent '${p.agent}' which was not found. Available: ${[...agentNames].join(", ")}`);
			}
		}

		const result = await executeTaskflow(state, {
			cwd: ctx.cwd,
			agents,
			globalThinking: settings.globalThinking,
			signal,
			persist: persistThrottled,
			requestApproval,
			loadFlow: (name: string) => getFlow(ctx.cwd, name)?.def,
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

	pi.on("session_start", async (_e, ctx) => {
		registerSavedFlowCommands(ctx);

		// Hint: prompt to configure model roles if not set
		try {
			const settings = readSubagentSettings();
			if (!settings.modelRoles) {
				console.warn(
					`[taskflow] Model roles not configured — agents will use the default model. ` +
					`Run /tf init to generate a recommended modelRoles config.`
				);
			}
		} catch {}
	});

	// ---- The LLM-callable tool ----
	pi.registerTool({
		name: "taskflow",
		label: "Taskflow",
		description: [
			"Orchestrate a multi-phase workflow of subagents from a declarative definition.",
			"Phases (agent, parallel, map, gate, reduce, approval, flow) form a DAG; intermediate outputs stay out of your context — only the final phase output is returned.",
			"Use action=run with an inline `define` (you write the DSL) or a saved `name`.",
			"For simple non-DAG delegations (like the subagent tool) skip the DSL: pass `task` (+optional `agent`) for one task, `tasks:[{task,agent?}]` to run in parallel, or `chain:[{task,agent?}]` to run sequentially (reference the prior step with {previous.output}).",
			"Use action=save to persist a definition as a reusable /tf:<name> command. action=resume continues a paused run. action=list shows saved flows. Use action=agents to list available agents — do NOT invent agent names; either use an agent from that list or omit the 'agent' field to auto-select the default agent.",
			"DSL: {name, args?, concurrency?, budget?:{maxUSD,maxTokens}, phases:[{id, type, agent, task, dependsOn?, join?:'all'|'any', when?, retry?:{max,backoffMs,factor}, over?(map), as?(map), branches?(parallel), from?(reduce), use?(flow), with?(flow), output?:'json', final?}]}.",
			"Phase types: agent (one subagent), parallel (static branches), map (dynamic fan-out over an array), gate (VERDICT: PASS/BLOCK quality gate), reduce (aggregate from N phases), approval (human-in-the-loop pause), flow (run a saved sub-flow), loop (re-run a task until 'until' is truthy / converged / maxIterations; body reads {loop.iteration} and {loop.lastOutput}). join:'any' is an OR-join; when is a conditional guard; retry adds backoff; budget caps run cost.",
			"Interpolation: {args.X}, {steps.ID.output}, {steps.ID.json}, {item} (map), {previous.output}.",
		].join(" "),
		parameters: TaskflowParams,
		promptSnippet: "Orchestrate many subagents over a whole codebase/many items (declarative DAG with map fan-out)",
		promptGuidelines: [
			"Prefer taskflow whenever a request spans a whole project/codebase or many items — e.g. 'explore / 探索 / 审计 / analyze the project', auditing endpoints, reviewing or migrating many files/modules, or cross-checked research. It fans out to many subagents across phases and aggregates the result, keeping intermediate work out of your context.",
			"Choose taskflow over ad-hoc parallel subagents when the work has multiple phases (discover → work → review → report), needs dynamic fan-out over a discovered list, or should be saved and rerun. For simple single/parallel/chain delegations use the shorthand `task`/`tasks`/`chain` (no DSL) when you want the run tracked, resumable, or saveable; otherwise the plain subagent tool is fine.",
			"For taskflow map phases, have the upstream phase emit a JSON array and set output:'json'.",
		],

		async execute(_id, params, signal, onUpdate, ctx) {
			const action = params.action ?? "run";

			// init — configure model roles
	if (action === "init") {
		const settingsPath = path.join(getAgentDir(), "settings.json");
		let existing: Record<string, unknown> = {};
		try { existing = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch {}

		const roleDescs: Record<string, string> = {
			fast: "cheap & quick (executor, scout, recover, verifier, doc-writer, test-engineer)",
			strong: "balanced (planner, reviewer, executor-code)",
			thinker: "deep analysis (analyst, critic)",
			arbiter: "final judgment (plan-arbiter, final-arbiter)",
			vision: "multimodal (executor-ui, visual-explorer)",
			reasoner: "cautious reasoning (risk-reviewer, security-reviewer)",
		};

		if (existing.modelRoles) {
			const roles = existing.modelRoles as Record<string, string>;
			const text = [
				`Model roles already configured in ${settingsPath}:`,
				...Object.entries(roles).map(([k, v]) => `  ${k.padEnd(10)} → ${v}  (${roleDescs[k] ?? ""})`),
				``,
				`To reconfigure, run /tf init interactively or edit settings.json directly.`,
			].join("\n");
			return { content: [{ type: "text", text }], details: { action } satisfies TaskflowDetails };
		}

		const defaults: Record<string, string> = {
			fast: "openrouter/deepseek/deepseek-v4-flash",
			strong: "openrouter/xiaomi/mimo-v2.5-pro",
			thinker: "openrouter/deepseek/deepseek-v4-pro",
			arbiter: "openrouter/qwen/qwen3.7-max",
			vision: "minimax/MiniMax-M3",
			reasoner: "z-ai/glm-5.1",
		};

		const newSettings = { ...existing, modelRoles: defaults };
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		fs.writeFileSync(settingsPath, JSON.stringify(newSettings, null, 2) + "\n", "utf-8");

		const text = [
			`Wrote default model roles to ${settingsPath}:`,
			...Object.entries(defaults).map(([k, v]) => `  ${k.padEnd(10)} → ${v}  (${roleDescs[k]})`),
			``,
			`These models require provider-specific API keys. Edit settings.json or run /tf init interactively.`,
		].join("\n");
		return { content: [{ type: "text", text }], details: { action } satisfies TaskflowDetails };
	}

	// agents — list available agents the LLM can use in phase definitions
			if (action === "agents") {
				const scope = params.scope ?? "both";
				const settings2 = readSubagentSettings();
				const { agents } = discoverAgents(ctx.cwd, scope as AgentScope, undefined, settings2.modelRoles);
				const text = agents.length
					? agents
							.map(
								(a) =>
									`- ${a.name} (${a.source}): ${a.description}${a.model ? ` [model: ${a.model}]` : ""}${a.tools?.length ? ` [tools: ${a.tools.join(", ")}]` : ""}`,
							)
							.join("\n")
					: "No agents found. Use the default agent by omitting the 'agent' field in phases.";
				return { content: [{ type: "text", text }], details: { action } satisfies TaskflowDetails };
			}

			// list
			if (action === "list") {
				const flows = listFlows(ctx.cwd);
				const text = flows.length
					? flows.map((f) => `- ${f.name} (${f.scope}): ${f.def.description ?? ""}`).join("\n")
					: "No saved taskflows.";
				return { content: [{ type: "text", text }], details: { action } satisfies TaskflowDetails };
			}

			if (action === "cache-clear") {
				const removed = new CacheStore(ctx.cwd).clear();
				return {
					content: [{ type: "text", text: `Cleared ${removed} cross-run cache entr${removed === 1 ? "y" : "ies"}.` }],
					details: { action } satisfies TaskflowDetails,
				};
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

			// resolve the definition: inline `define` / shorthand (single|parallel|chain), else saved `name`.
			let def: Taskflow | undefined;

			// A shorthand spec can come from `define` (no phases) or top-level params.
			const shorthandSpec: unknown =
				params.define ??
				(params.chain
					? { chain: params.chain, name: params.name }
					: params.tasks
						? { tasks: params.tasks, name: params.name }
						: params.task
							? { task: params.task, agent: params.agent, name: params.name }
							: undefined);

			if (shorthandSpec !== undefined) {
				let candidate: unknown = shorthandSpec;
				if (isShorthand(candidate)) {
					try {
						candidate = desugar(candidate);
					} catch (e) {
						return errorResult(action, `Invalid shorthand: ${e instanceof Error ? e.message : String(e)}`);
					}
				}
				const v = validateTaskflow(candidate);
				if (!v.ok) return errorResult(action, `Invalid taskflow:\n- ${v.errors.join("\n- ")}`);
				def = candidate as Taskflow;
			} else if (params.name) {
				const saved = getFlow(ctx.cwd, params.name);
				if (!saved) return errorResult(action, `Saved flow not found: ${params.name}`);
				def = saved.def;
			}
			if (!def)
				return errorResult(action, "Provide 'define' (DSL), shorthand 'task'/'tasks'/'chain', or 'name' (saved).");

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
				const warningText = v.warnings.length ? `\n\nWarnings:\n- ${v.warnings.join("\n- ")}` : "";
				return {
					content: [
						{ type: "text", text: `Saved taskflow '${def.name}' → ${filePath}\nRun it with /tf:${def.name} or action=run.${warningText}` },
					],
					details: { action, message: filePath } satisfies TaskflowDetails,
				};
			}

			// run
			const args = resolveArgs(def, params.args);
			const v = validateTaskflow(def, { args, cwd: ctx.cwd });
			if (!v.ok) return errorResult(action, `Invalid taskflow:\n- ${v.errors.join("\n- ")}`);
			for (const w of v.warnings) {
				console.warn(`[taskflow:${def.name}] ${w}`);
			}
			const result = await runFlow(def, args, ctx, signal, onUpdate as any);
			// Surface the validation warnings in the tool result so the model
			// can acknowledge or fix them, and the user sees them in the chat.
			if (v.warnings.length) {
				result.finalOutput = `${result.finalOutput}\n\nWarnings:\n- ${v.warnings.join("\n- ")}`;
			}
			return finalResult(action, result);
		},

		renderCall(args, theme) {
			const action = args.action ?? "run";
			let label = args.name || (args.define as { name?: string } | undefined)?.name;
			let suffix = "";
			const phases = (args.define as Taskflow | undefined)?.phases;
			if (phases) suffix = ` (${phases.length} phases)`;
			else if (args.chain) {
				label ||= "chain";
				suffix = ` (${(args.chain as unknown[]).length} steps)`;
			} else if (args.tasks) {
				label ||= "parallel";
				suffix = ` (${(args.tasks as unknown[]).length} tasks)`;
			} else if (args.task) {
				label ||= "task";
			}
			label ||= "(inline)";
			let text =
				theme.fg("toolTitle", theme.bold("taskflow ")) + theme.fg("accent", `${action} `) + theme.fg("muted", label);
			if (suffix) text += theme.fg("dim", suffix);
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
		description: "Taskflow: list | run <name> | show <name> | runs | init",
		getArgumentCompletions: (prefix) => {
			const subs = ["list", "run", "show", "runs", "resume", "init"];
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

			if (sub === "init") {
				const settingsPath = path.join(getAgentDir(), "settings.json");
				let existing: Record<string, unknown> = {};
				try { existing = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch {}
				const currentRoles = (existing.modelRoles ?? {}) as Record<string, string>;

				// Role definitions: name → { description, recommended models }
				// Role definitions: name → description (no per-role filtering)
				const roleDefs: Array<{ role: string; desc: string }> = [
					{ role: "fast",     desc: "Cheap & quick — high-volume, low-stakes tasks (executor, scout, recover, verifier, doc-writer, test-engineer)" },
					{ role: "strong",   desc: "Balanced — planning, review, moderate complexity (planner, reviewer, executor-code)" },
					{ role: "thinker",  desc: "Deep analysis — requirements, ambiguity detection, critique (analyst, critic)" },
					{ role: "arbiter",  desc: "Final judgment — tiebreak, plan quality gates (plan-arbiter, final-arbiter)" },
					{ role: "vision",   desc: "Multimodal — UI work, design reading, Figma analysis (executor-ui, visual-explorer)" },
					{ role: "reasoner", desc: "Cautious reasoning — security, risk review, sensitive changes (risk-reviewer, security-reviewer)" },
				];

				if (!ctx.hasUI) {
					if (Object.keys(currentRoles).length > 0) {
						ctx.ui.notify(
							`Current model roles:\n` +
							Object.entries(currentRoles).map(([k, v]) => `  ${k.padEnd(10)} → ${v}`).join("\n"),
						"info"
						);
					} else {
						ctx.ui.notify(
							`No modelRoles configured. Run /tf init in an interactive session to select models.`,
						"warning"
						);
					}
					return;
				}

				// Use the user's scoped/enabled models (same list as /model command).
				// Fall back to all auth-configured models if none are scoped.
				const enabledModels = (existing.enabledModels as string[] | undefined) ?? [];
				const modelList = enabledModels.length > 0
					? enabledModels
					: ctx.modelRegistry.getAvailable().map(m => `${m.provider}/${m.id}`);

				// Interactive: walk through each role using the same model list
				const chosen: Record<string, string> = {};
				for (const rd of roleDefs) {
					const current = currentRoles[rd.role];

					const seen = new Set<string>();
					const options: string[] = [];
					for (const m of modelList) {
						if (seen.has(m)) continue;
						seen.add(m);
						options.push(m === current ? `${m} (current)` : m);
					}
					options.push("───────────────");
					options.push("Custom (type your own)");

					const title = `Model for '${rd.role}' — ${rd.desc}` + (current ? `\nCurrent: ${current}` : "");
					const pick = await ctx.ui.select(title, options, { signal: ctx.signal });

					if (!pick || pick.startsWith("───")) {
						chosen[rd.role] = current ?? modelList[0] ?? "";
						continue;
					}

					if (pick === "Custom (type your own)") {
						const custom = await ctx.ui.input(`Enter model identifier for '${rd.role}'`, "provider/model-id", { signal: ctx.signal });
						chosen[rd.role] = custom?.trim() || current || "";
					} else {
						chosen[rd.role] = pick.replace(" (current)", "");
					}
				}

				// Save
				const newSettings = { ...existing, modelRoles: chosen };
				fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
				fs.writeFileSync(settingsPath, JSON.stringify(newSettings, null, 2) + "\n", "utf-8");

				ctx.ui.notify(
					`Saved model roles to ${settingsPath}:\n` +
					Object.entries(chosen).map(([k, v]) => `  ${k.padEnd(10)} → ${v}`).join("\n"),
				"info"
				);
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
