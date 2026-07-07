/**
 * taskflow as an MCP server (host-neutral core).
 *
 * Exposes the taskflow engine as MCP tools so an MCP host (Codex, Claude Code,
 * or any MCP client) can declare and run verifiable task DAGs from inside its
 * own session. Each host adapter binds this server to its own `SubagentRunner`
 * (codex → `codex exec` subagents, claude → `claude -p` subagents), so the
 * whole thing closes the loop with no pi process required.
 *
 * Protocol: MCP over stdio, JSON-RPC 2.0 (newline-delimited). Implemented on the
 * dependency-free transport in ./jsonrpc.ts — taskflow-core keeps its zero-
 * runtime-deps guarantee; we do NOT use @modelcontextprotocol/sdk.
 *
 * This module is intentionally NOT in the barrel (index.ts) — hosts import it
 * via the `taskflow-mcp` package (it is NOT re-exported from taskflow-core.
 *
 * Tools exposed:
 *   - taskflow_run     : run an inline or saved flow, return the final output
 *   - taskflow_list    : list saved flows discoverable in this cwd
 *   - taskflow_show    : show a saved flow's definition
 *   - taskflow_verify  : statically verify a flow (no execution)
 *   - taskflow_compile : render a flow as a DAG diagram (SVG image) + status line
 *   - taskflow_peek    : inspect a stored run's intermediate phase output
 */

import { RpcError, RPC, serveStdio, type RpcHandler } from "./jsonrpc.ts";
import { renderFlowSvg, renderFlowOutline, svgToBase64 } from "./svg.ts";
import {
	discoverAgents,
	executeTaskflow,
	getFlowDiagnosed,
	listFlows,
	newRunId,
	peekRun,
	saveRun,
	DEFAULT_KEPT_RUNS,
	DEFAULT_RUN_AGE_DAYS,
	readDefineFile,
	describeLoadFailure,
	compileTaskflow,
	verifyTaskflow,
	desugar,
	isShorthand,
	validateTaskflow,
	readSubagentSettings,
	readMeta,
	saveFlowWithMeta,
	bumpReuseInSidecar,
	deriveMeta,
	searchLibrary,
	type LibraryDeps,
	type SearchInput,
	type RuntimeDeps,
	type RunState,
	type Taskflow,
	type VerificationIssue,
} from "taskflow-core";
import type { SubagentRunner, AgentConfig } from "taskflow-core";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "taskflow", title: "Taskflow", version: "0.1.5" } as const;

/** An MCP tool definition as returned by tools/list. */
interface McpTool {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

/**
 * MCP tools/call result with a single text block.
 *
 * IMPORTANT (rendering): the Codex desktop app renders a `text` content block
 * as a fixed grey "plaintext" <pre> box — it does NOT parse markdown or
 * highlight code, wraps on whitespace, and caps the box at ~192px tall with an
 * inner scroll; Claude Code's TUI shows tool results as monospace text. So
 * text here is written as *plain text*: no ```fences```, no markdown tables,
 * conclusion-first, and near-duplicate lines collapsed. Rich rendering
 * (structuredContent/_meta) is gated to Codex's first-party "Apps" server, so
 * third-party MCP output can't opt into it. See docs/codex-mcp.md.
 */
function textContent(text: string, isError = false) {
	return { content: [{ type: "text", text }], isError };
}

/** An MCP `image` content block, optionally followed by text blocks. Codex's
 *  desktop app renders the image as `<img src="data:…">` (an inline SVG shows as
 *  a real diagram) and shows the trailing text as a caption. The CLI/TUI can't
 *  render images — it prints a bare `<image content>` placeholder — so the
 *  trailing text MUST be self-sufficient there (and for vision-less models). */
function imageContent(base64: string, mimeType: string, texts: string[], isError = false) {
	const content: Array<Record<string, unknown>> = [{ type: "image", data: base64, mimeType }];
	for (const t of texts) if (t) content.push({ type: "text", text: t });
	return { content, isError };
}

/**
 * Collapse near-identical validation messages so N phases hitting the same rule
 * render as one line with a count instead of N wall-of-text repeats (the exact
 * ugliness this file is fighting). Strips a leading `Phase '<id>': ` / `Phase
 * '<id>' ` prefix, groups by the remaining message, and lists the affected ids.
 */
function dedupeMessages(msgs: string[]): string[] {
	const groups = new Map<string, string[]>();
	const order: string[] = [];
	for (const raw of msgs) {
		const m = raw.match(/^Phase '([^']+)':?\s+(.*)$/s);
		const key = m ? m[2] : raw;
		const id = m ? m[1] : "";
		if (!groups.has(key)) {
			groups.set(key, []);
			order.push(key);
		}
		if (id) groups.get(key)!.push(id);
	}
	return order.map((key) => {
		const ids = groups.get(key)!;
		if (ids.length === 0) return key;
		if (ids.length === 1) return `${key} (phase ${ids[0]})`;
		const shown = ids.slice(0, 4).join(", ");
		const more = ids.length > 4 ? ` +${ids.length - 4} more` : "";
		return `${key} (${ids.length} phases: ${shown}${more})`;
	});
}

/**
 * Render verification issues as deduped, conclusion-friendly "Errors:" /
 * "Warnings:" plaintext blocks. `extraErrors`/`extraWarnings` fold in the raw
 * string messages from `validateTaskflow` so structural + quality issues share
 * one deduped view. Shared by taskflow_verify and taskflow_compile's fallback.
 */
function issueBlocks(
	issues: VerificationIssue[],
	extraErrors: string[] = [],
	extraWarnings: string[] = [],
): { errorCount: number; warningCount: number; text: string } {
	const toStr = (i: VerificationIssue) =>
		// verifyTaskflow messages already embed the phase id in prose ("Phase 'x'
		// is a terminal phase…"); only prepend the id for messages that don't, so
		// dedupeMessages can strip one consistent prefix and collapse same-rule hits.
		i.phaseId && !/^Phase '/.test(i.message) ? `Phase '${i.phaseId}': ${i.message}` : i.message;
	const rawErrors = [...extraErrors, ...issues.filter((i) => i.severity === "error").map(toStr)];
	const rawWarnings = [...extraWarnings, ...issues.filter((i) => i.severity === "warning").map(toStr)];
	// Count reflects the true number of issues; the lines below are the *deduped*
	// compact view (N same-rule hits collapse to one line + a phase list).
	const errors = dedupeMessages(rawErrors);
	const warnings = dedupeMessages(rawWarnings);
	const errBlock = errors.length ? `\n\nErrors:\n${errors.map((e) => `- ${e}`).join("\n")}` : "";
	const warnBlock = warnings.length ? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
	return { errorCount: rawErrors.length, warningCount: rawWarnings.length, text: `${errBlock}${warnBlock}` };
}

/** Pluralize a count for a compact status line. */
function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

const TOOLS: McpTool[] = [
	{
		name: "taskflow_run",
		title: "Run a taskflow",
		description:
			"Run a taskflow DAG and return its final output. Provide EITHER `name` (a saved flow) OR `define` (an inline flow definition: {name, phases:[…]} or a shorthand {task} / {tasks} / {chain}). Subagents execute as isolated host sessions. Intermediate phase outputs stay in the runtime; only the final phase output is returned — the reported runId can be passed to taskflow_peek to inspect intermediate phase outputs afterwards.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				name: { type: "string", description: "Name of a saved flow to run." },
				define: { type: "object", description: "Inline flow definition (full DAG or shorthand)." },
				defineFile: { type: "string", description: "Path to a file holding the flow definition (raw JSON, or Markdown with a ```json fence). Lets you verify/compile/run share ONE persisted draft (e.g. in the OS tmp dir) — edit the file between calls instead of re-sending the whole definition. Precedence: define > defineFile > name." },
				args: { type: "object", description: "Invocation arguments interpolated as {args.X}." },
				incremental: { type: "boolean", description: "Default every phase to cross-run cache reuse." },
				reusedFromSearch: { type: "boolean", description: "Set true when this run was chosen because of a prior taskflow_search → bumps the flow's reuseCount (the reuse flywheel). Default false; direct run-by-name does not bump." },
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
		description: "Statically verify a flow (cycles, missing deps, undefined refs, …) WITHOUT executing it. Provide `name`, `define`, or `defineFile`.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				name: { type: "string" },
				define: { type: "object" },
				defineFile: { type: "string", description: "Path to a JSON (or fenced-Markdown) flow file. See taskflow_run.defineFile." },
			},
		},
	},
	{
		name: "taskflow_compile",
		title: "Compile a taskflow to a diagram",
		description: "Render a flow's DAG as a diagram (an inline SVG image) with issues overlaid (red=error, amber=warning, green=final), plus a compact status line. No execution. Provide `name`, `define`, or `defineFile`.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				name: { type: "string" },
				define: { type: "object" },
				defineFile: { type: "string", description: "Path to a JSON (or fenced-Markdown) flow file. See taskflow_run.defineFile." },
			},
		},
	},
	{
		name: "taskflow_peek",
		title: "Peek at a run's phase output",
		description:
			"Inspect one phase's intermediate output from a stored run (post-hoc debugging). Use the runId reported by taskflow_run. Omit `phaseId` to list the run's phases. Output is hard-truncated (default 4000 chars) so a peek never floods the context window. Read-only.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				runId: { type: "string", description: "The run to inspect (from a prior taskflow_run or the runs index)." },
				phaseId: { type: "string", description: "Phase to peek at. Omit to list all phases with status + output size." },
				json: { type: "boolean", description: "Return the phase's parsed JSON instead of its text output." },
				item: { type: "number", description: "For map/parallel phases: the 1-based item section to extract." },
				limit: { type: "number", description: "Truncation cap in chars (default 4000, max 32000)." },
			},
			required: ["runId"],
		},
	},
	{
		name: "taskflow_save",
		title: "Save a reusable taskflow",
		description:
			"Save a flow as a reusable library asset: persists the flow AND a sidecar .meta.json with purpose/tags/notes + auto-derived structural metadata (phase signature, generality score) so taskflow_search can retrieve it later. Pass purpose + 2-4 tags for any flow you expect to reuse — this is what makes search recall work.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				name: { type: "string", description: "Flow name (also the filename stem)." },
				definition: { type: "object", description: "Full taskflow DSL object ({name, phases:[...]}) or shorthand ({task}|{tasks}|{chain})." },
				purpose: { type: "string", description: "One-line purpose — the single most important field for search recall. Write what the flow DOES and WHEN to use it." },
				tags: { type: "array", items: { type: "string" }, description: "2-4 reuse tags (e.g. audit, fan-out, migration, security)." },
				notes: { type: "string", description: "Free-form reuse notes (when NOT to use, required args, gotchas)." },
				scope: { type: "string", enum: ["project", "user"], description: "project (default) or user-global." },
			},
			required: ["name", "definition"],
		},
	},
	{
		name: "taskflow_search",
		title: "Search the taskflow library",
		description:
			"Search saved flows by purpose BEFORE authoring a new one — the reuse flywheel. Returns ranked matches with a score, why it matched, and a reuse hint (direct-reuse / copy-and-generalize / write-fresh). Falls back to keyword+structural ranking when no embedding backend is configured (structural mode); uses cosine similarity when one is (semantic/mixed mode).",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				query: { type: "string", description: "Natural-language purpose string (what you want the flow to do)." },
				limit: { type: "number", description: "Max results (default 5, max 20)." },
				structureOnly: { type: "boolean", description: "Skip embedding, use keyword+structural ranking only (zero latency)." },
				minScore: { type: "number", description: "Drop results below this score (0-1)." },
				scope: { type: "string", enum: ["project", "user", "both"], description: "Which scopes to search (default from settings: both)." },
			},
			required: ["query"],
		},
	},
];

/** Resolve a flow from params: inline `define` (desugared), `defineFile` (disk), or saved `name`. */
function resolveFlow(cwd: string, params: { name?: string; define?: unknown; defineFile?: unknown }): Taskflow {
	if (params.define === undefined && typeof params.defineFile === "string" && params.defineFile.trim()) {
		const fromFile = readDefineFile(params.defineFile);
		if (!fromFile.ok) throw new RpcError(RPC.INVALID_PARAMS, describeLoadFailure(fromFile, "defineFile"));
		params = { ...params, define: fromFile.value };
	}
	if (params.define !== undefined && params.define !== null) {
		return isShorthand(params.define) ? desugar(params.define) : (params.define as Taskflow);
	}
	if (params.name) {
		const r = getFlowDiagnosed(cwd, params.name);
		if (!r.ok) throw new RpcError(RPC.INVALID_PARAMS, describeLoadFailure(r, `Saved flow "${params.name}"`));
		return r.value.def;
	}
	throw new RpcError(RPC.INVALID_PARAMS, "Provide either `name` (a saved flow) or `define` (an inline flow).");
}

function mkRunState(def: Taskflow, args: Record<string, unknown>, cwd: string): RunState {
	return {
		runId: newRunId(def.name ?? "flow"),
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
 * launched in (where saved flows + agents are discovered, and where subagents
 * run). `runner` is the host's SubagentRunner (codex/claude) — each phase's
 * subagent executes through it.
 */
export function makeToolHandlers(
	cwd: string,
	runner: SubagentRunner<AgentConfig>,
): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
	return {
		taskflow_run: async (args) => {
			const def = resolveFlow(cwd, args);
			const v = validateTaskflow(def);
			if (!v.ok) return textContent(`Flow is invalid:\n- ${v.errors.join("\n- ")}`, true);

			// Resolve model roles (e.g. {{fast}} -> a real model id) so the built-in
			// agents' placeholder models map to something the host can launch. This is
			// the same lookup the pi adapter does; without it every phase fails with
			// "Model metadata for {{fast}} not found".
			const settings = readSubagentSettings();
			const { agents } = discoverAgents(cwd, "both", settings.modelRoles, settings.taskflow);
			const deps: RuntimeDeps = {
				cwd,
				agents,
				runTask: runner.runTask,
			};
			const state = mkRunState(def, (args.args as Record<string, unknown>) ?? {}, cwd);
			if (args.incremental === true) (deps as RuntimeDeps & { cacheScopeDefault?: string }).cacheScopeDefault = "cross-run";

			// Persist run state (throttled + final) so taskflow_peek / resume can read
			// intermediate phase outputs after the run — same contract as the pi adapter.
			const cleanupConfig = { maxKeep: DEFAULT_KEPT_RUNS, maxAgeDays: DEFAULT_RUN_AGE_DAYS };
			let lastPersist = 0;
			deps.persist = (s) => {
				const now = Date.now();
				if (now - lastPersist >= 1000) {
					lastPersist = now;
					saveRun(s, cleanupConfig);
				}
			};

			const res = await executeTaskflow(state, deps).finally(() => {
				// Terminal persist must survive a throwing runtime ("never lose work") —
				// and persistence itself must never sink a completed run.
				try {
					saveRun(state, cleanupConfig);
				} catch {
					/* fail-open */
				}
			});
			if (res.ok && args.reusedFromSearch === true && typeof args.name === "string" && args.name.trim()) {
				try {
					bumpReuseInSidecar(cwd, args.name);
				} catch {
					/* fail-open: reuse bookkeeping is best-effort */
				}
			}
			const header = res.ok ? "✓ taskflow complete" : "✗ taskflow did not fully succeed";
			const u = res.totalUsage;
			const usageLine = `\n\n— ${u.turns} turns · in ${u.input} · out ${u.output} tokens · run ${state.runId}`;
			return textContent(`${header}\n\n${res.finalOutput}${usageLine}`, !res.ok);
		},

		taskflow_peek: async (args) => {
			const runId = String(args.runId ?? "");
			if (!runId) return textContent("taskflow_peek requires `runId`.", true);
			const res = peekRun(cwd, runId, {
				phaseId: typeof args.phaseId === "string" ? args.phaseId : undefined,
				json: args.json === true,
				item: typeof args.item === "number" ? args.item : undefined,
				limit: typeof args.limit === "number" ? args.limit : undefined,
			});
			return textContent(res.text, !res.ok);
		},

		taskflow_list: async () => {
			const flows = listFlows(cwd);
			if (flows.length === 0) return textContent("No saved taskflows found from this directory.");
			const lines = flows.map((f) => {
				const metaR = readMeta(cwd, f.name);
				const meta = metaR.ok ? metaR.value : undefined;
				if (meta?.purpose) {
					const purpose = meta.purpose.length > 20 ? meta.purpose.slice(0, 20) + "…" : meta.purpose;
					return `- ${f.name} (${f.scope}) — ${f.def.phases.length} phase(s) · ${purpose} · g=${meta.generality?.toFixed(2) ?? "?"} · used ${meta.reuseCount ?? 0}×`;
				}
				return `- ${f.name} (${f.scope}) — ${f.def.phases.length} phase(s)`;
			});
			return textContent(`Saved taskflows:\n${lines.join("\n")}`);
		},

		taskflow_show: async (args) => {
			const name = String(args.name ?? "");
			const savedR = getFlowDiagnosed(cwd, name);
			if (!savedR.ok) return textContent(describeLoadFailure(savedR, `Saved flow "${name}"`), true);
			const saved = savedR.value;
			const metaR = readMeta(cwd, name);
			const meta = metaR.ok ? metaR.value : undefined;
			if (meta) {
				const out = { definition: saved.def, library: { purpose: meta.purpose, tags: meta.tags, notes: meta.notes, generality: meta.generality, reuseCount: meta.reuseCount, version: meta.version, phaseSignature: meta.phaseSignature } };
				return textContent(JSON.stringify(out, null, 2));
			}
			// No ```json``` fence: Codex shows text blocks as raw plaintext, so a fence
			// would render as literal backticks. The JSON is already monospaced there.
			return textContent(JSON.stringify(saved.def, null, 2));
		},

		taskflow_save: async (args) => {
			const name = String(args.name ?? "");
			if (!name.trim()) return textContent("taskflow_save requires `name`.", true);
			if (!args.definition) return textContent("taskflow_save requires `definition` (the DSL object or shorthand).", true);
			// Resolve + validate the definition (mirrors resolveFlow + run's validation).
			let def: Taskflow;
			try {
				def = resolveFlow(cwd, { define: args.definition });
			} catch (e) {
				return textContent(`Invalid flow definition: ${e instanceof Error ? e.message : String(e)}`, true);
			}
			// Force the name to match the argument (resolveFlow/shorthand may synthesize one).
			def = { ...def, name };
			const v = validateTaskflow(def);
			if (!v.ok) return textContent(`Flow is invalid:\n- ${v.errors.join("\n- ")}`, true);
			const scope = args.scope === "user" ? "user" : "project";
			const prevMetaR = readMeta(cwd, name);
		const prevMeta = prevMetaR.ok ? prevMetaR.value : undefined;
			const meta = deriveMeta(def, {
				purpose: typeof args.purpose === "string" ? args.purpose : undefined,
				tags: Array.isArray(args.tags) ? args.tags.filter((t): t is string => typeof t === "string") : undefined,
				notes: typeof args.notes === "string" ? args.notes : undefined,
				prevMeta,
			});
			const { filePath } = saveFlowWithMeta(cwd, def, meta, scope);
			return textContent(`Saved taskflow '${name}' → ${filePath}\n  purpose: ${meta.purpose ?? "(none)"}\n  tags: ${(meta.tags ?? []).join(", ") || "(none)"}\n  phaseSignature: ${meta.phaseSignature}\n  generality: ${meta.generality.toFixed(2)}`);
		},

		taskflow_search: async (args) => {
			const query = String(args.query ?? "").trim();
			if (!query) return textContent("taskflow_search requires `query`.", true);
			const settings = readSubagentSettings();
			if (!settings.taskflow.library.enabled) {
				return textContent("Library is disabled (settings.json → taskflow.library.enabled = false).", true);
			}
			const deps: LibraryDeps = { settings: settings.taskflow.library, cwd };
			const input: SearchInput = {
				query,
				limit: typeof args.limit === "number" ? args.limit : undefined,
				structureOnly: args.structureOnly === true,
				minScore: typeof args.minScore === "number" ? args.minScore : undefined,
				scope: args.scope === "project" || args.scope === "user" || args.scope === "both" ? args.scope : undefined,
			};
			const res = await searchLibrary(deps, input);
			const lines: string[] = [];
			lines.push(`Library search — ${res.counts.scanned} flow(s) scanned · ${res.searchMode} mode${res.embedder ? ` · ${res.embedder}` : ""}`);
			if (res.results.length === 0) {
				lines.push("No matches. Consider authoring a new flow and saving it (taskflow_save with purpose+tags).");
			} else {
				for (const r of res.results) {
					lines.push(`- ${r.name} (${r.scope}) — score ${r.score.toFixed(2)} · ${r.phaseSignature || "?"} · g=${r.generality.toFixed(2)} · v${r.version} · used ${r.reuseCount}×`);
					if (r.purpose) lines.push(`    purpose: ${r.purpose}`);
					if (r.tags?.length) lines.push(`    tags: ${r.tags.join(", ")}`);
					lines.push(`    why: ${r.why}`);
					lines.push(`    → ${r.reuseHint}`);
				}
			}
			return textContent(lines.join("\n"));
		},

		taskflow_verify: async (args) => {
			const def = resolveFlow(cwd, args);
			const val = validateTaskflow(def);
			// verifyTaskflow iterates flow.phases and throws if it isn't an array
			// (e.g. a missing `phases`). Only skip it in that unsafe case; otherwise
			// run it so its static-quality warnings (e.g. terminal-not-final) still
			// surface alongside validateTaskflow's structural errors.
			const phasesIterable = Array.isArray((def as { phases?: unknown }).phases);
			const result = phasesIterable
				? verifyTaskflow(def as Parameters<typeof verifyTaskflow>[0])
				: { ok: false, issues: [] as ReturnType<typeof verifyTaskflow>["issues"] };
			const { errorCount, warningCount, text } = issueBlocks(result.issues, val.errors, val.warnings);
			const passed = val.ok && result.ok && errorCount === 0;
			// Conclusion-first (the plaintext box is short + scrolls): verdict + counts
			// on line 1, deduped detail below.
			const head = passed
				? warningCount
					? `✓ verification PASSED — ${count(warningCount, "warning")}`
					: "✓ verification PASSED"
				: `✗ verification FAILED — ${count(errorCount, "error")}, ${count(warningCount, "warning")}`;
			return textContent(`${head}${text}`, !passed);
		},

		taskflow_compile: async (args) => {
			const def = resolveFlow(cwd, args);
			const val = validateTaskflow(def);
			// compileTaskflow / verifyTaskflow / renderFlowSvg all assume phases is an
			// array of objects that each have a string id (they iterate it and index
			// id.replace(...)). A hard-malformed def (non-array phases, a phase missing
			// its id) would throw, so when the shape isn't renderable we return the
			// structured validation errors as text instead of rendering.
			const phases = (def as { phases?: unknown }).phases;
			const renderable =
				Array.isArray(phases) && phases.every((p) => p != null && typeof (p as { id?: unknown }).id === "string");
			if (!renderable) {
				const { errorCount, warningCount, text } = issueBlocks([], val.errors, val.warnings);
				const caption = `${def.name ?? "taskflow"} — ${count(errorCount, "error")} · ${count(warningCount, "warning")} · ✗ FAIL`;
				return textContent(`${caption}${text}`, true);
			}
			// Merge structural validation into the compile report. compileTaskflow's
			// own verification.ok is true even for a structurally-invalid (but
			// renderable) flow, so a validate-clean check is what stops a false ✓ PASS.
			// We still render the diagram + outline so such a flow can be inspected
			// visually; truncate coerces non-string fields so the renderer won't throw.
			const result = compileTaskflow(def);
			const v = result.verification;
			const { errorCount, warningCount, text } = issueBlocks(v.issues, val.errors, val.warnings);
			const passed = val.ok && v.ok && errorCount === 0;
			const status = passed ? "✓ PASS" : "✗ FAIL";
			const caption = `${def.name ?? "taskflow"} — ${count(def.phases?.length ?? 0, "phase")} · ${count(errorCount, "error")} · ${count(warningCount, "warning")} · ${status}`;
			// A text outline that stands on its own — the CLI/TUI can't render images
			// (it shows a bare `<image content>` placeholder), and a vision-less model
			// would otherwise see nothing. Includes the layered DAG + deduped issues.
			const outline = renderFlowOutline(def, v);
			const textReport = `${caption}\n\n${outline}${text}`;
			// Fold validation errors into the issue set the SVG colors by, so node
			// coloring matches the text report (a phase with only a validation error
			// still shows red). Validation messages start with `Phase '<id>':`.
			const mergedVerification = {
				...v,
				ok: passed,
				issues: [
					...v.issues,
					...val.errors.map((message) => {
						const m = /^Phase '([^']+)'/.exec(message);
						return { phaseId: m?.[1], message, severity: "error" as const, category: "ref-integrity" as const };
					}),
				],
			};
			// Desktop app: the SVG image renders as a real diagram; the outline rides
			// along as its caption/fallback. Oversized graphs skip the image and rely
			// on the text report alone.
			const svg = renderFlowSvg(def, mergedVerification);
			if (svg) return imageContent(svgToBase64(svg), "image/svg+xml", [textReport], !passed);
			return textContent(textReport, !passed);
		},
	};
}

/** Build the full MCP method dispatch table (protocol + tools). */
export function makeMcpHandlers(cwd: string, runner: SubagentRunner<AgentConfig>): Record<string, RpcHandler> {
	const tools = makeToolHandlers(cwd, runner);
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
export function startMcpServer(runner: SubagentRunner<AgentConfig>, cwd: string = process.cwd()): Promise<void> {
	return serveStdio(makeMcpHandlers(cwd, runner));
}
