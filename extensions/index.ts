/**
 * pi-taskflow — a declarative, verifiable graph of task nodes for the Pi coding agent.
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
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	RECOMMENDED_DEFAULTS,
	readSettings,
	writeSettings,
	formatRolesReport,
	formatDiffReport,
	formatFlowResult,
	runInteractiveInit,
} from "./init.ts";
import { Type } from "typebox";
import { type AgentScope, discoverAgents, readSubagentSettings, shouldSyncBuiltinAgentsToProject, syncBuiltinAgentsToProject } from "./agents.ts";
import { renderRunResult, summarizeRun } from "./render.ts";
import { RunHistoryComponent, type RunHistoryResult } from "./runs-view.ts";
import { ApprovalViewComponent, type ApprovalChoice } from "./approval-view.ts";
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
	DEFAULT_KEPT_RUNS,
	DEFAULT_RUN_AGE_DAYS,
} from "./store.ts";
import { CacheStore } from "./cache.ts";
import { safeParse } from "./interpolate.ts";
import { formatWhyStale, readMapOf } from "./stale.ts";
import {
	isValidKey,
	queueSpawn,
	readVisibleFindings,
	readTree,
	nodeDepth,
	writeFinding,
	writeReport,
} from "./context-store.ts";
import { MAX_DYNAMIC_NESTING } from "./schema.ts";

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
		context: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"File paths to pre-read and inject before this step's task (same as Phase.context). In parallel `tasks` mode all branches SHARE the union of step contexts.",
			}),
		),
		contextLimit: Type.Optional(
			Type.Number({ description: "Max characters to read per context file (default 8000)." }),
		),
	},
	{ additionalProperties: false },
);

const TaskflowParams = Type.Object({
	action: StringEnum(["run", "save", "resume", "list", "agents", "init", "verify", "compile", "provenance", "why-stale", "cache-clear"] as const, {
		description: "What to do: run a flow, save a definition, resume a paused run, list saved flows, list available agents, init model role configuration, verify the DAG, compile the DAG to a Mermaid diagram + verification report, or clear the cross-run memoization cache",
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
	context: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Shorthand single mode: file paths to pre-read and inject before the task (same as Phase.context).",
		}),
	),
	contextLimit: Type.Optional(
		Type.Number({ description: "Shorthand single mode: max characters to read per context file (default 8000)." }),
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
	phaseId: Type.Optional(Type.String({ description: "Phase id — the assumed-changed seed for action=why-stale" })),
	scope: Type.Optional(
		StringEnum(["user", "project"] as const, { description: "Where to save (action=save)", default: "project" }),
	),
	mode: Type.Optional(
		StringEnum(["show", "apply-defaults", "interactive"] as const, {
			description:
				"Init action mode. 'show' is read-only (default); 'apply-defaults' requires force:true; 'interactive' requires a UI session.",
			default: "show",
		}),
	),
	force: Type.Optional(
		Type.Boolean({
			description:
				"Destructive: overwrites modelRoles in settings.json. Required for mode='apply-defaults'.",
		}),
	),
	detach: Type.Optional(
		Type.Boolean({
			description: "Run in background (detached child process); return runId immediately. Status polled via store.",
		}),
	),
});

function formatProvenance(run: RunState): string {
	const lines: string[] = [];
	lines.push(`Provenance — run ${run.runId} · flow "${run.flowName}" · ${run.status}`);
	lines.push("");
	const finalIds = new Set(run.def.phases.filter((p) => p.final).map((p) => p.id));
	const phases = Object.values(run.phases);
	const any = phases.some((p) => p.reads && p.reads.length > 0);
	if (!any) {
		lines.push(
			"(No observed readSets recorded. Reads are captured for agent/gate/reduce phases that interpolate {steps.*} — the overstory \"observed readSet@version\" moat.)",
		);
		return lines.join("\n");
	}
	for (const p of phases) {
		const reads = p.reads ?? [];
		lines.push(`■ ${p.id}  [${p.status}]${finalIds.has(p.id) ? " ★ final" : ""}`);
		if (reads.length) {
			lines.push("   observed reads:");
			for (const r of reads) lines.push(`     ← ${r.stepId}@${r.version ?? "?"}`);
		} else {
			lines.push("   (source — no upstream reads)");
		}
	}
	return lines.join("\n");
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
	const state = existing ?? makeRunState(def, args, ctx.cwd);

	const emit = (s: RunState, finalOutput?: string) => {
		onUpdate?.({
			content: [{ type: "text", text: finalOutput ?? summarizeRun(s) }],
			details: { action: "run", state: s, finalOutput },
		});
	};

	// Throttled persistence: avoid disk writes on every sub-item event.
	let lastPersist = 0;
	const cleanupConfig = { maxKeep: DEFAULT_KEPT_RUNS, maxAgeDays: DEFAULT_RUN_AGE_DAYS };
	const persistThrottled = (s: RunState) => {
		const now = Date.now();
		if (now - lastPersist >= 1000) {
			lastPersist = now;
			saveRun(s, cleanupConfig);
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
	// Renders a centered modal popup (TUI overlay) with a scrollable viewport
	// so long upstream output (e.g. a plan) can be reviewed in full before
	// deciding (mouse wheel / ↑↓ / PgUp / PgDn to scroll).
	const requestApproval = ctx.hasUI
		? async (req: ApprovalRequest): Promise<ApprovalDecision> => {
				const choice = await ctx.ui.custom<ApprovalChoice>(
					(tui, theme, _kb, done) => {
						const view = new ApprovalViewComponent(
							theme,
							{
								title: `Taskflow approval — ${def.name}/${req.phaseId}`,
								message: req.message,
								upstream: req.upstream,
							},
							done,
							() => tui.terminal.rows,
						);
						const onAbort = () => done("reject");
						signal?.addEventListener("abort", onAbort, { once: true });
						return {
							render: (w: number) => view.render(w),
							invalidate: () => view.invalidate(),
							handleInput: (data: string) => {
								view.handleInput(data);
								tui.requestRender();
							},
							dispose: () => {
								view.dispose();
								signal?.removeEventListener("abort", onAbort);
							},
						};
					},
					{
						overlay: true,
						overlayOptions: {
							width: "80%",
							minWidth: 60,
							maxHeight: "85%",
							anchor: "center",
						},
					},
				);
				if (choice === "reject") return { decision: "reject" };
				if (choice === "edit") {
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
		cleanupConfig.maxKeep = settings.taskflow.maxKeptRuns;
		cleanupConfig.maxAgeDays = settings.taskflow.maxRunAgeDays;
		const scope: AgentScope = def.agentScope ?? "user";
		const { agents } = discoverAgents(ctx.cwd, scope, settings.modelRoles, settings.taskflow);

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
		saveRun(state, cleanupConfig); // force-persist terminal state
		emit(state); // final render reflecting terminal state
	}
}

export default function (pi: ExtensionAPI) {
	// ---- Dual identity ----------------------------------------------------
	// When this extension is loaded INSIDE a subagent process that the taskflow
	// runtime spawned with Shared Context Tree enabled, PI_TASKFLOW_CTX_DIR +
	// PI_TASKFLOW_NODE_ID are present. In that case we register the ctx_* tools
	// (the blackboard + supervision API) instead of the host `taskflow` tool —
	// a subagent has no business orchestrating its own taskflows, and the host
	// tool's heavy machinery is irrelevant there. When the env is absent we are
	// the host: register `taskflow` + `/tf` exactly as before (zero change).
	const ctxDir = process.env.PI_TASKFLOW_CTX_DIR;
	const nodeId = process.env.PI_TASKFLOW_NODE_ID;
	if (ctxDir && nodeId) {
		registerCtxTools(pi, ctxDir, nodeId);
		return;
	}

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

		// Optional: copy built-in agents into .pi/agents/ so Pi's native
		// subagent tool (and other extensions) can discover them. This is
		// disabled by default to avoid surprising project file creation.
		try {
			const settings = readSubagentSettings();
			if (shouldSyncBuiltinAgentsToProject(settings.taskflow)) {
				syncBuiltinAgentsToProject(ctx.cwd);
			}
		} catch {
			// Best-effort: a locked or readonly .pi/ directory must not block
			// session startup.
		}

		// Upgrade hint: if the project already has .pi/agents/ with agent
		// files but no explicit taskflow settings, the user is upgrading
		// from the old default (sync=true) and may be surprised that sync
		// is now disabled by default.
		try {
			const raw = readSettings();
			if (!("taskflow" in raw)) {
				const fs = await import("node:fs");
				const path = await import("node:path");
				const projectAgentsDir = path.join(ctx.cwd, ".pi", "agents");
				try {
					const entries = fs.readdirSync(projectAgentsDir).filter((e: string) => e.endsWith(".md"));
					if (entries.length > 0) {
						console.warn(
							`[taskflow] Note: built-in agents are no longer synced to .pi/agents/ by default. ` +
							`If you rely on this, run /tf init → 'Configure taskflow preferences' to re-enable. ` +
							`(This is a one-time upgrade hint.)`,
						);
					}
				} catch { /* .pi/agents/ doesn't exist — no hint needed */ }
			}
		} catch {
			// Best-effort: settings.json missing or unreadable is not an error.
		}

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
			"IMPORTANT: Before using this tool for the first time in a session, invoke skill_load('taskflow') to read the full documentation (DSL syntax, examples, best practices). This tool description is a reference, not a tutorial.",
			"Shorthand (same API as subagent): pass `task` (+optional `agent`) for one task, `tasks:[{task,agent?}]` for parallel, or `chain:[{task,agent?}]` for sequential (use {previous.output}).",
			"DSL: use action=run with an inline `define` (you write the DAG) or a saved `name`. Phases (agent, parallel, map, gate, reduce, approval, flow, loop, tournament) form a DAG; intermediate outputs stay out of your context — only the final phase output is returned.",
			"Every delegation is tracked (runId), resumable across sessions, and saveable as /tf:<name> via action=save.",
			"Use action=agents to list the 18 built-in agents (executor, scout, planner, analyst, critic, reviewer, risk-reviewer, security-reviewer, plan-arbiter, final-arbiter, test-engineer, doc-writer, executor-code, executor-fast, executor-ui, recover, verifier, visual-explorer). Do NOT invent agent names.",
			"Phase types: agent, parallel (static branches), map (dynamic fan-out over array), gate (VERDICT: PASS/BLOCK), reduce (aggregate from N), approval (human-in-the-loop), flow (run saved sub-flow), loop (iterate until condition/convergence/cap), tournament (N variants, judge picks best/aggregate).",
			"Use action=compile to generate a Mermaid diagram + verification report from a saved or inline flow — 0 tokens.",
			"Interpolation: {args.X}, {steps.ID.output}, {steps.ID.json}, {item} (map), {previous.output}.",
		].join(" "),
		parameters: TaskflowParams,
		promptSnippet: "Declare a verifiable graph of subagent tasks (single, parallel, chain, or full DAG) — tracked, resumable, context-isolated. The runtime validates the graph before running. Replaces the subagent tool.",
		promptGuidelines: [
			"BEFORE FIRST USE: invoke skill_load('taskflow') to read the full skill documentation (DSL syntax, phase types, examples, best practices). This tool description is a condensed reference only — the skill is the authoritative guide.\n\nUse taskflow for ALL delegation — single tasks, parallel, chain, or full DAG orchestration. It fully replaces the subagent tool: every delegation is tracked with a runId, resumable across sessions, context-isolated (only final output returns), and saveable as /tf:<name>. Do NOT call the subagent tool directly; use taskflow shorthand (task/tasks/chain) for simple cases instead.",
			"For complex multi-phase work (explore / 审计 / analyze the project, auditing endpoints, reviewing or migrating many files/modules, cross-checked research), use the full DSL with phases. For taskflow map phases, have the upstream phase emit a JSON array and set output:'json'.",
			"For taskflow map phases, have the upstream phase emit a JSON array and set output:'json'.",
		],

		async execute(_id, params, signal, onUpdate, ctx) {
			const action = params.action ?? "run";

			// init — configure model roles
			if (action === "init") {
				let settings: Record<string, unknown>;
				try {
					settings = readSettings();
				} catch (e) {
					return errorResult(
						action,
						`Failed to read settings.json: ${e instanceof Error ? e.message : String(e)}. ` +
							`Fix the file or remove it.`,
					);
				}
				const current = (settings.modelRoles ?? {}) as Record<string, string>;
				const mode = params.mode;

				// v0.0.13 deprecation bridge: mode omitted → old behavior
				if (mode === undefined) {
					if (Object.keys(current).length === 0) {
						// v0.0.12 compat: auto-write recommended defaults when modelRoles is empty
						console.warn(
							"[taskflow] action=init with no mode is deprecated and will require explicit mode in v0.0.14. " +
								"Use mode='apply-defaults' with force=true.",
						);
						writeSettings({ ...settings, modelRoles: { ...RECOMMENDED_DEFAULTS } });
						const text = formatDiffReport({}, RECOMMENDED_DEFAULTS);
						return { content: [{ type: "text", text }], details: { action } satisfies TaskflowDetails };
					}
					// mode omitted + modelRoles exist → show
					const text = formatRolesReport(current);
					return { content: [{ type: "text", text }], details: { action } satisfies TaskflowDetails };
				}

				// mode === "show" (read-only, never overwrites)
				if (mode === "show") {
					const text = formatRolesReport(current);
					return { content: [{ type: "text", text }], details: { action } satisfies TaskflowDetails };
				}

				// mode === "apply-defaults" requires explicit force=true
				if (mode === "apply-defaults") {
					if (!params.force)
						return errorResult(action, "mode=apply-defaults requires force=true to overwrite.");
					const merged: Record<string, string> = { ...RECOMMENDED_DEFAULTS };
					for (const key of Object.keys(current)) {
						if (!(key in merged)) merged[key] = current[key]; // stale-preserved
					}
					writeSettings({ ...settings, modelRoles: merged });
					const text = formatDiffReport(current, merged);
					return { content: [{ type: "text", text }], details: { action } satisfies TaskflowDetails };
				}

				// mode === "interactive" — requires a UI session
				if (mode === "interactive") {
					if (!ctx.hasUI)
						return errorResult(action, "mode=interactive requires an interactive session.");
					const enabledModels = (settings.enabledModels as string[] | undefined) ?? [];
					const modelList =
						enabledModels.length > 0
							? enabledModels
									.map((id) => ctx.modelRegistry.find(id.split("/")[0], id.split("/").slice(1).join("/")))
									.filter((m): m is NonNullable<typeof m> => m !== undefined)
							: ctx.modelRegistry.getAvailable();
					const result = await runInteractiveInit({
						hasUI: ctx.hasUI,
						signal: signal ?? new AbortController().signal,
						ui: ctx.ui as ExtensionUIContext,
						modelRegistry: ctx.modelRegistry,
						modelList,
						currentRoles: current,
						currentTaskflowSettings: readSubagentSettings().taskflow,
					});
					const text = formatFlowResult(result);
					return { content: [{ type: "text", text }], details: { action } satisfies TaskflowDetails };
				}

				return errorResult(action, `Unknown init mode: ${String(mode)}`);
			}

	// agents — list available agents the LLM can use in phase definitions
			if (action === "agents") {
				const scope = params.scope ?? "both";
				const settings2 = readSubagentSettings();
				const { agents } = discoverAgents(ctx.cwd, scope as AgentScope, settings2.modelRoles, settings2.taskflow);
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

			if (action === "verify") {
				const { verifyTaskflow } = await import("./verify.ts");
				// Load definition: inline define takes priority, then saved name
				let def: Taskflow | undefined;
				let resolvedDefine: unknown = params.define;
				if (typeof resolvedDefine === "string") {
					const parsed = safeParse(resolvedDefine);
					if (parsed && typeof parsed === "object") resolvedDefine = parsed;
				}
				if (resolvedDefine) {
					const d = resolvedDefine as Record<string, unknown>;
					if (typeof d === "object" && d !== null && Array.isArray(d.phases)) {
						def = d as unknown as Taskflow;
					} else if (isShorthand(resolvedDefine)) {
						const r = validateTaskflow(resolvedDefine);
						if (r.ok) def = resolvedDefine as unknown as Taskflow;
					}
				} else if (params.name) {
					const saved = getFlow(ctx.cwd, params.name);
					if (saved) def = saved.def;
				}
				if (!def) {
					return errorResult(action, "Provide 'define' (DSL) or 'name' (saved flow) to verify.");
				}
				// Schema validation first
				const vr = validateTaskflow(def, { cwd: ctx.cwd ? String(ctx.cwd) : undefined });
				if (!vr.ok) {
					return errorResult(action, `Schema validation failed:\n${vr.errors.join("\n")}`);
				}
				const result = verifyTaskflow({ name: def.name!, phases: def.phases!, budget: def.budget, concurrency: def.concurrency });
				const lines: string[] = [];
				lines.push(`# Verification of "${def.name}"`);
				lines.push("");
				if (result.issues.length === 0) {
					lines.push("✅ No issues found.");
				} else {
					const errors = result.issues.filter((i) => i.severity === "error");
					const warnings = result.issues.filter((i) => i.severity === "warning");
					if (errors.length) {
						lines.push(`## Errors (${errors.length})`);
						for (const e of errors) lines.push(`- **${e.category}**${e.phaseId ? ` [${e.phaseId}]` : ""}: ${e.message}`);
					}
					if (warnings.length) {
						lines.push(`## Warnings (${warnings.length})`);
						for (const w of warnings) lines.push(`- ${w.category}${w.phaseId ? ` [${w.phaseId}]` : ""}: ${w.message}`);
					}
					lines.push("");
					lines.push(result.ok ? "Status: PASS (no errors)" : "Status: FAIL (errors found)");
				}
				return { content: [{ type: "text", text: lines.join("\n") }], details: { action } satisfies TaskflowDetails };
			}

			if (action === "compile") {
				const { compileTaskflow } = await import("./compile.ts");
				// Resolve definition: inline define (object or JSON/fenced string) then saved name.
				let def: Taskflow | undefined;
				let resolvedDefine: unknown = params.define;
				if (typeof resolvedDefine === "string") {
					const parsed = safeParse(resolvedDefine);
					if (parsed && typeof parsed === "object") resolvedDefine = parsed;
				}
				if (resolvedDefine) {
					const d = resolvedDefine as Record<string, unknown>;
					if (typeof d === "object" && d !== null && Array.isArray(d.phases)) {
						def = d as unknown as Taskflow;
					} else if (isShorthand(resolvedDefine)) {
						try {
							def = desugar(resolvedDefine) as Taskflow;
						} catch (e) {
							return errorResult(action, `Invalid shorthand: ${e instanceof Error ? e.message : String(e)}`);
						}
					}
				} else if (params.name) {
					const saved = getFlow(ctx.cwd, params.name);
					if (saved) def = saved.def;
				}
				if (!def) {
					return errorResult(action, "Provide 'define' (DSL) or 'name' (saved flow) to compile.");
				}
				// Schema validation first so a malformed graph gives a clean error
				// rather than a half-rendered diagram.
				const vr = validateTaskflow(def, { cwd: ctx.cwd ? String(ctx.cwd) : undefined });
				if (!vr.ok) {
					return errorResult(action, `Schema validation failed:\n${vr.errors.join("\n")}`);
				}
				const compiled = compileTaskflow(def);
				return {
					content: [{ type: "text", text: compiled.markdown }],
					details: { action } satisfies TaskflowDetails,
				};
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

			if (action === "provenance") {
				if (!params.runId)
					return errorResult(action, "action=provenance requires 'runId'");
				const run = loadRun(ctx.cwd, params.runId);
				if (!run) return errorResult(action, `Run not found: ${params.runId}`);
				return {
					content: [{ type: "text", text: formatProvenance(run) }],
					details: { action } satisfies TaskflowDetails,
				};
			}

			if (action === "why-stale") {
				if (!params.runId)
					return errorResult(action, "action=why-stale requires 'runId'");
				const run = loadRun(ctx.cwd, params.runId);
				if (!run) return errorResult(action, `Run not found: ${params.runId}`);
				const reads = readMapOf(run.phases);
				const seeds = params.phaseId ? [String(params.phaseId)] : [];
				return {
					content: [{ type: "text", text: formatWhyStale(run.runId, run.flowName, reads, seeds) }],
					details: { action } satisfies TaskflowDetails,
				};
			}

			// resolve the definition: inline `define` / shorthand (single|parallel|chain), else saved `name`.
			let def: Taskflow | undefined;

			// Auto-parse string `define` — LLMs sometimes pass a JSON string
			// instead of a parsed object. safeParse handles markdown fences too.
			let resolvedDefine: unknown = params.define;
			if (typeof resolvedDefine === "string") {
				const parsed = safeParse(resolvedDefine);
				if (parsed && typeof parsed === "object") {
					resolvedDefine = parsed;
				} else {
					return errorResult(
						action,
						`'define' was passed as a string, not a JSON object. Pass it as a proper object, e.g.:\n` +
							`define: {"name":"my-flow","phases":[{"id":"step1","task":"do something"}]}`,
					);
				}
			}

			// A shorthand spec can come from `define` (no phases) or top-level params.
			const shorthandSpec: unknown =
				resolvedDefine ??
				(params.chain
					? { chain: params.chain, name: params.name }
					: params.tasks
						? { tasks: params.tasks, name: params.name }
						: params.task
							? { task: params.task, agent: params.agent, name: params.name, context: params.context, contextLimit: params.contextLimit }
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
				if (!saved) {
					const available = listFlows(ctx.cwd);
					const hint = available.length
						? ` Available flows: ${available.map((f) => f.name).join(", ")}.`
						: " No saved flows found. Use action=save to create one, or pass 'define' for an inline flow.";
					return errorResult(action, `Saved flow '${params.name}' not found.${hint}`);
				}
				def = saved.def;
			}
			if (!def)
				return errorResult(
					action,
					`No taskflow definition provided. Use one of:\n` +
						`- define: {"name":"...","phases":[...]} (inline DSL object)\n` +
						`- task: "..." (shorthand single agent)\n` +
						`- tasks: [{"task":"..."},...] (shorthand parallel)\n` +
						`- chain: [{"task":"..."},...] (shorthand sequential)\n` +
						`- name: "saved-flow-name" (run a previously saved flow)`,
				);

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
			// Auto-parse string args — LLMs sometimes pass a JSON string.
			let resolvedArgs: Record<string, unknown> | undefined;
			if (typeof params.args === "string") {
				const parsed = safeParse(params.args);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					resolvedArgs = parsed as Record<string, unknown>;
				}
			} else if (params.args && typeof params.args === "object") {
				resolvedArgs = params.args as Record<string, unknown>;
			}
			const args = resolveArgs(def, resolvedArgs);
			const v = validateTaskflow(def, { args, cwd: ctx.cwd });
			if (!v.ok) return errorResult(action, `Invalid taskflow:\n- ${v.errors.join("\n- ")}`);
			for (const w of v.warnings) {
				console.warn(`[taskflow:${def.name}] ${w}`);
			}
			// Detached (background) execution: spawn a child process and return immediately.
			if (params.detach) {
				const state = makeRunState(def, args, ctx.cwd);
				state.detached = true;
				saveRun(state);

				// Serialize context for the detached runner script.
				const { writeFileSync } = await import("node:fs");
				const { spawn } = await import("node:child_process");
				const os = await import("node:os");
				const path = await import("node:path");
				const tmpFile = path.join(os.tmpdir(), `taskflow-detach-${state.runId}.json`);
				writeFileSync(tmpFile, JSON.stringify({
					runId: state.runId,
					defName: def.name,
					args,
					cwd: ctx.cwd,
				}));

				const runnerScript = path.join(path.dirname(new URL(import.meta.url).pathname), "detached-runner.ts");
				const child = spawn(process.execPath, ["--experimental-strip-types", runnerScript, tmpFile], {
					detached: true,
					stdio: "ignore",
				});
				child.unref();

				state.pid = child.pid ?? undefined;
				saveRun(state);

				return {
					content: [{ type: "text", text: `Taskflow '${def.name}' started in background (pid: ${child.pid}). Run id: ${state.runId}` }],
					details: { action, state, message: state.runId } satisfies TaskflowDetails,
				};
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
			let label = args.name;
		if (!label) {
			let define = args.define;
			if (typeof define === "string") {
				try { define = JSON.parse(define); } catch { /* not JSON */ }
			}
			label = (define as { name?: string } | undefined)?.name;
		}
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
		description: "Taskflow: list | run <name> | show <name> | compile <name> | runs | init",
		getArgumentCompletions: (prefix) => {
			const subs = ["list", "run", "show", "runs", "resume", "init", "save", "verify", "compile", "provenance", "why-stale"];
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

			if (sub === "compile") {
				if (!arg) {
					ctx.ui.notify("Usage: /tf compile <name> [lr|td]", "warning");
					return;
				}
				// `arg` may carry an optional direction suffix: "<name> lr" / "<name> td".
				const parts = arg.trim().split(/\s+/);
				const flowName = parts[0];
				const direction = parts[1]?.toLowerCase() === "lr" ? "LR" : "TD";
				const flow = getFlow(ctx.cwd, flowName);
				if (!flow) {
					ctx.ui.notify(`Flow not found: ${flowName}`, "error");
					return;
				}
				// Schema-validate before compiling so a malformed saved flow yields a
				// clean error rather than a half-rendered diagram (mirrors the tool action).
				const vr = validateTaskflow(flow.def, { cwd: ctx.cwd ? String(ctx.cwd) : undefined });
				if (!vr.ok) {
					ctx.ui.notify(`Schema validation failed:\n${vr.errors.join("\n")}`, "error");
					return;
				}
				const { compileTaskflow } = await import("./compile.ts");
				const compiled = compileTaskflow(flow.def, { direction });
				ctx.ui.notify(compiled.markdown, compiled.verification.ok ? "info" : "warning");
				return;
			}

			if (sub === "provenance") {
				if (!arg) {
					ctx.ui.notify("Usage: /tf provenance <runId>", "warning");
					return;
				}
				const run = loadRun(ctx.cwd, arg);
				if (!run) {
					ctx.ui.notify(`Run not found: ${arg}`, "error");
					return;
				}
				ctx.ui.notify(formatProvenance(run), "info");
				return;
			}

			if (sub === "why-stale") {
				if (!arg) {
					ctx.ui.notify("Usage: /tf why-stale <runId> [phaseId]", "warning");
					return;
				}
				const [rid, ...rest] = arg.trim().split(/\s+/);
				const run = loadRun(ctx.cwd, rid);
				if (!run) {
					ctx.ui.notify(`Run not found: ${rid}`, "error");
					return;
				}
				const reads = readMapOf(run.phases);
				ctx.ui.notify(formatWhyStale(run.runId, run.flowName, reads, rest), "info");
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
				const result = await ctx.ui.custom<RunHistoryResult | undefined>((tui, theme, _kb, done) => {
					const comp = new RunHistoryComponent(runs, theme, (r) => done(r), {
						refresh: () => listRuns(ctx.cwd, 50),
						requestRender: () => tui.requestRender(),
						intervalMs: 1000,
					});
					return comp;
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
				let settings: Record<string, unknown>;
				try {
					settings = readSettings();
				} catch (e) {
					ctx.ui.notify(
						`Failed to read settings.json: ${e instanceof Error ? e.message : String(e)}`,
						"error",
					);
					return;
				}
				const currentRoles = (settings.modelRoles ?? {}) as Record<string, string>;

				if (!ctx.hasUI) {
					if (Object.keys(currentRoles).length > 0) {
						ctx.ui.notify(
							formatRolesReport(currentRoles),
							"info",
						);
					} else {
						ctx.ui.notify(
							"No modelRoles configured. Run /tf init in an interactive session to select models.",
							"warning",
						);
					}
					return;
				}

				const enabledModels = (settings.enabledModels as string[] | undefined) ?? [];
				const modelList =
					enabledModels.length > 0
						? enabledModels
								.map((id) => ctx.modelRegistry.find(id.split("/")[0], id.split("/").slice(1).join("/")))
								.filter((m): m is NonNullable<typeof m> => m !== undefined)
						: ctx.modelRegistry.getAvailable();
				const result = await runInteractiveInit({
					hasUI: ctx.hasUI,
					signal: ctx.signal ?? new AbortController().signal,
					ui: ctx.ui,
					modelRegistry: ctx.modelRegistry,
					modelList,
					currentRoles,
					currentTaskflowSettings: readSubagentSettings().taskflow,
				});
				if (result.kind === "cancelled") {
					ctx.ui.notify("Init cancelled.", "info");
				} else {
					ctx.ui.notify(formatFlowResult(result), "info");
				}
				return;
			}

			ctx.ui.notify(`Unknown subcommand: ${sub}`, "warning");
		},
	});
}

// --- helpers ---

/**
 * Register the Shared Context Tree tools inside a subagent process. These read
 * & write the per-run blackboard at `ctxDir` on behalf of node `nodeId`.
 *
 * - ctx_read   : read findings visible to this node (own + ancestors + completed others)
 * - ctx_write  : write a finding (last-write-wins per key) so siblings can reuse it
 * - ctx_report : report a result upward to the parent
 * - ctx_spawn  : queue child tasks the runtime picks up after this node finishes
 */
function registerCtxTools(pi: ExtensionAPI, ctxDir: string, nodeId: string) {
	const textResult = (text: string, isError = false): ToolResult => ({
		content: [{ type: "text", text }],
		details: { action: "ctx" },
		...(isError ? { isError: true } : {}),
	});

	pi.registerTool({
		name: "ctx_read",
		label: "Context Read",
		description:
			"Read shared findings from the taskflow blackboard (what sibling/ancestor agents already discovered). Pass a key to read one value, or omit to list all visible findings. Use this BEFORE re-reading files another agent may have already mapped.",
		parameters: Type.Object({
			key: Type.Optional(Type.String({ description: "Specific finding key to read; omit to get all visible findings." })),
		}),
		async execute(_id, params) {
			try {
				const out = readVisibleFindings(ctxDir, nodeId, params.key);
				return textResult(typeof out === "string" ? out : JSON.stringify(out ?? null, null, 2));
			} catch (e) {
				return textResult(`ctx_read failed: ${e instanceof Error ? e.message : String(e)}`, true);
			}
		},
	});

	pi.registerTool({
		name: "ctx_write",
		label: "Context Write",
		description:
			"Write a finding to the shared taskflow blackboard so sibling/descendant agents can reuse it without re-reading files. Key must be [A-Za-z0-9._-] (<=128 chars). Value is any JSON. Last write wins per key.",
		parameters: Type.Object({
			key: Type.String({ description: "Finding key, e.g. 'endpoints' or 'auth.summary'." }),
			value: Type.Unknown({ description: "The value to store (string, number, object, or array)." }),
		}),
		async execute(_id, params) {
			if (!isValidKey(params.key)) {
				return textResult(`ctx_write rejected: invalid key '${params.key}'.`, true);
			}
			try {
				writeFinding(ctxDir, nodeId, params.key, params.value);
				return textResult(`Stored finding '${params.key}'.`);
			} catch (e) {
				return textResult(`ctx_write failed: ${e instanceof Error ? e.message : String(e)}`, true);
			}
		},
	});

	pi.registerTool({
		name: "ctx_report",
		label: "Context Report",
		description:
			"Report your result upward to the parent task. Provide a concise summary and optional structured JSON. The parent (and downstream phases) will see this report.",
		parameters: Type.Object({
			summary: Type.String({ description: "Concise summary of what you accomplished / found." }),
			structured: Type.Optional(Type.Unknown({ description: "Optional structured result (JSON)." })),
		}),
		async execute(_id, params) {
			try {
				writeReport(ctxDir, nodeId, params.summary, params.structured);
				return textResult("Report recorded.");
			} catch (e) {
				return textResult(`ctx_report failed: ${e instanceof Error ? e.message : String(e)}`, true);
			}
		},
	});

	pi.registerTool({
		name: "ctx_spawn",
		label: "Context Spawn",
		description:
			"Delegate sub-tasks to NEW child agents. After you finish, the runtime runs each child (isolated context) and folds their reports back into your output. Use when you discover the work needs to fan out. Each assignment is EITHER {task, agent?} for one flat task, OR {subflow, defaultAgent?} where subflow is an inline plan {phases:[...]} (a dependency-bearing DAG: phases can use dependsOn / map / gate / reduce). Use a subflow when the delegated work itself has multiple coordinated steps.",
		parameters: Type.Object({
			assignments: Type.Array(
				Type.Object({
					task: Type.Optional(Type.String({ description: "A single child task prompt (use this OR subflow, not both)." })),
					agent: Type.Optional(Type.String({ description: "Agent name for a flat task (optional)." })),
					subflow: Type.Optional(Type.Unknown({ description: "An inline Taskflow plan {phases:[...]} or a bare phases array, run as a nested validated sub-flow." })),
					defaultAgent: Type.Optional(Type.String({ description: "Fallback agent for subflow phases that don't name their own (optional)." })),
				}),
				{ description: "Child tasks to spawn (1..16). Each is a flat {task} or a {subflow} DAG." },
			),
		}),
		async execute(_id, params) {
			// Depth cap: walk the parent chain in the tree to find this node's depth.
			try {
				const depth = nodeDepth(readTree(ctxDir), nodeId);
				if (depth >= MAX_DYNAMIC_NESTING) {
					return textResult(
						`ctx_spawn rejected: depth ${depth} >= MAX_DYNAMIC_NESTING (${MAX_DYNAMIC_NESTING}). Do the work yourself.`,
						true,
					);
				}
				const n = queueSpawn(ctxDir, nodeId, params.assignments);
				return textResult(`Queued ${n} child task(s); they will run after you finish and their reports will be appended to your output.`);
			} catch (e) {
				return textResult(`ctx_spawn failed: ${e instanceof Error ? e.message : String(e)}`, true);
			}
		},
	});
}

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
	const pairs = trimmed.match(/(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g);
	if (pairs) {
		for (const p of pairs) {
			const idx = p.indexOf("=");
			const k = p.slice(0, idx);
			let v: string = p.slice(idx + 1);
			if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"');
			out[k] = v;
		}
		return out;
	}
	// single positional → first declared arg
	const firstArg = Object.keys(def.args ?? {})[0];
	if (firstArg) return { [firstArg]: trimmed };
	return {};
}
