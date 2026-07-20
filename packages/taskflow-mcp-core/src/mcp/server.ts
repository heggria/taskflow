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
 *   - taskflow_runs    : list/status/wait/cancel background runs
 *   - taskflow_list    : list saved flows discoverable in this cwd
 *   - taskflow_show    : show a saved flow's definition
 *   - taskflow_verify  : statically verify a flow (no execution)
 *   - taskflow_compile : render a flow as a DAG diagram (SVG image) + status line
 *   - taskflow_peek    : inspect a stored run's intermediate phase output
 *   - taskflow_trace   : read a run's append-only event trace
 *   - taskflow_replay  : re-evaluate a recorded trace under alternate knobs (zero tokens)
 *   - taskflow_why_stale / taskflow_recompute / taskflow_reconcile_workspace
 *   - taskflow_save / taskflow_search
 */

import { RpcError, RPC, serveStdio, type RpcContext, type RpcHandler } from "./jsonrpc.ts";
import { renderFlowSvg, renderFlowOutline, svgToBase64 } from "./svg.ts";
import {
	BACKGROUND_RUN_WARNING_THRESHOLD,
	cancelMcpBackgroundRun,
	formatBackgroundRun,
	launchMcpBackgroundRun,
	listMcpBackgroundRuns,
	refreshDetachedRun,
	waitForMcpBackgroundRun,
	type BackgroundRunFilter,
	type DetachedRunnerBinding,
} from "./background.ts";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
	discoverAgents,
	executeTaskflow,
	getFlowDiagnosed,
	listFlows,
	newRunId,
	peekRun,
	saveRun,
	readDefineFile,
	describeLoadFailure,
	compileTaskflow,
	verifyTaskflow,
	desugar,
	isShorthand,
	validateTaskflow,
	resolveArgs,
	cwdBridgeModeFromEnv,
	directoryIdentity,
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
	type TraceEvent,
	replayRun,
	upgradeTraceEvent,
	type ReplayReport,
	type ReplayOverrides,
	reconcileResolveOnlyWorkspace,
	clearDetachedCancelRequest,
	DETACHED_CONTROL_VERSION,
	WORKSPACE_RECONCILE_ACKNOWLEDGEMENT,
	workspaceReconcileAllowedFromEnv,
} from "taskflow-core";
import type { SubagentRunner, AgentConfig } from "taskflow-core";
import { getBuildInfo, type BuildInfo } from "taskflow-core";
import { builtinVerifiers, discoverVerifiers } from "taskflow-core";
import { forkRunForResume, validateResumeRequest, type ResumeOverrides } from "taskflow-core";
import {
	runsDir,
	traceFilePath,
	FileTraceSink,
	readTrace,
	loadRunDiagnosed,
	readMapOf,
	declaredReadMapOfDef,
	formatWhyStale,
	recomputeTaskflow,
	type RecomputeReport,
} from "taskflow-core";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_VERSION = readServerVersion();

/** Build the MCP serverInfo, reflecting the bound host identity (0.2.0 dogfood
 *  issue 4). The base name is `taskflow`; when a host adapter binds its runner
 *  (codex/claude/opencode/grok), the name becomes `taskflow-<host>` so a
 *  client can tell which host is executing subagents. */
function serverInfoFor(host?: string) {
	const name = host && host !== "taskflow" ? `taskflow-${host}` : "taskflow";
	return { name, title: "Taskflow", version: SERVER_VERSION } as const;
}

function readServerVersion(): string {
	try {
		const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
		const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
		if (typeof pkg === "object" && pkg !== null && "version" in pkg) {
			const version = (pkg as { version?: unknown }).version;
			if (typeof version === "string" && version) return version;
		}
	} catch {
		// Keep the handshake available even in unusual embedded/bundled layouts.
	}
	return getBuildInfo().packageVersion;
}

/** An MCP tool definition as returned by tools/list. */
interface McpTool {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

function validateToolValue(value: unknown, schema: Record<string, unknown>, path: string): string[] {
	const errors: string[] = [];
	const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
	if (enumValues && !enumValues.some((candidate) => Object.is(candidate, value))) {
		errors.push(`${path} must be one of ${enumValues.map(String).join(", ")}`);
		return errors;
	}
	const type = schema.type;
	if (type === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return [`${path} must be an object`];
		}
		const object = value as Record<string, unknown>;
		const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
		for (const required of Array.isArray(schema.required) ? schema.required : []) {
			if (typeof required === "string" && !(required in object)) errors.push(`${path}.${required} is required`);
		}
		if (schema.additionalProperties === false) {
			for (const key of Object.keys(object)) {
				if (!(key in properties)) errors.push(`${path}.${key} is not allowed`);
			}
		}
		for (const [key, childSchema] of Object.entries(properties)) {
			if (key in object) errors.push(...validateToolValue(object[key], childSchema, `${path}.${key}`));
		}
		return errors;
	}
	if (type === "array") {
		if (!Array.isArray(value)) return [`${path} must be an array`];
		const itemSchema = schema.items;
		if (typeof itemSchema === "object" && itemSchema !== null) {
			value.forEach((item, index) => errors.push(...validateToolValue(item, itemSchema as Record<string, unknown>, `${path}[${index}]`)));
		}
		return errors;
	}
	if (type === "string" && typeof value !== "string") errors.push(`${path} must be a string`);
	if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) errors.push(`${path} must be a finite number`);
	if (type === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value))) errors.push(`${path} must be an integer`);
	if (type === "boolean" && typeof value !== "boolean") errors.push(`${path} must be a boolean`);
	return errors;
}

function validateToolArguments(tool: McpTool, value: unknown): Record<string, unknown> {
	const args = value ?? {};
	const errors = validateToolValue(args, tool.inputSchema, "arguments");
	if (errors.length > 0) throw new RpcError(RPC.INVALID_PARAMS, `Invalid ${tool.name} arguments: ${errors.join("; ")}`);
	return args as Record<string, unknown>;
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

/** Human-readable timeline of a run's deterministic-replay event trace (MCP).
 *  Output text is truncated so a fan-out's full transcripts don't flood the
 *  host context — pass json:true for the complete record. Mirrors the pi
 *  adapter's formatTrace. */
const TRACE_DEFAULT_LIMIT = 200;
const TRACE_MAX_LIMIT = 1000;
const TRACE_MAX_RESPONSE_CHARS = 120_000;
const TRACE_JSON_STRING_LIMIT = 4_000;

function traceLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return TRACE_DEFAULT_LIMIT;
	return Math.max(1, Math.min(TRACE_MAX_LIMIT, Math.floor(value)));
}

function boundedTraceEvents(events: TraceEvent[], requested: unknown): { total: number; events: TraceEvent[] } {
	const limit = traceLimit(requested);
	const bounded = events.slice(-limit).map((event) =>
		JSON.parse(
			JSON.stringify(event, (_key, value) =>
				typeof value === "string" && value.length > TRACE_JSON_STRING_LIMIT
					? `${value.slice(0, TRACE_JSON_STRING_LIMIT)}… (+${value.length - TRACE_JSON_STRING_LIMIT} chars)`
					: value,
			),
		) as TraceEvent,
	);
	while (bounded.length > 1) {
		const candidate = JSON.stringify({ total: events.length, returned: bounded.length, truncated: bounded.length < events.length, events: bounded }, null, 2);
		if (candidate.length <= TRACE_MAX_RESPONSE_CHARS) break;
		bounded.shift();
	}
	return { total: events.length, events: bounded };
}

export function formatTraceJsonMcp(events: TraceEvent[], requested?: unknown): string {
	const bounded = boundedTraceEvents(events, requested);
	return JSON.stringify({
		total: bounded.total,
		returned: bounded.events.length,
		truncated: bounded.events.length < bounded.total,
		events: bounded.events,
	}, null, 2);
}

function formatTraceMcp(events: TraceEvent[], runId: string, flowName: string, requested?: unknown): string {
	const bounded = boundedTraceEvents(events, requested);
	events = bounded.events;
	const lines: string[] = [`Trace — ${flowName} / ${runId}  (${events.length} events)`];
	if (events.length < bounded.total) lines.push(`Showing newest ${events.length} of ${bounded.total} events.`);
	lines.push("");
	const out = (text: string | undefined, limit = 400): string => {
		if (!text) return "";
		const t = text.length > limit ? `${text.slice(0, limit)}… (+${text.length - limit} chars)` : text;
		return t.replace(/\n/g, " ⏎ ");
	};
	for (const e of events) {
		const ts = new Date(e.ts).toISOString().slice(11, 23);
		if (e.kind === "phase-start") lines.push(`${ts}  ▶ ${e.phaseId} start`);
		else if (e.kind === "phase-end") lines.push(`${ts}  ■ ${e.phaseId} end${e.status ? ` [${e.status}]` : ""}${e.error ? ` — ${out(e.error, 120)}` : ""}`);
		else if (e.kind === "subagent-call" && e.input && e.output) {
			const node = e.input.nodePath !== e.phaseId ? ` @${e.input.nodePath}` : "";
			lines.push(`${ts}    ↳ ${e.input.agent}${node}: ${out(e.input.task, 160)}`);
			lines.push(`${ts}      → ${out(e.output.text, 200)}`);
		} else if (e.kind === "decision" && e.decision) {
			const d = e.decision;
			const summary =
				d.type === "gate-verdict" ? `gate ${d.value.toUpperCase()}${d.reason ? ` — ${out(d.reason, 120)}` : ""}`
				: d.type === "gate-score" ? `score ${d.combined.toFixed(2)} (≥${d.threshold ?? "—"}) → ${d.verdict.toUpperCase()}`
				: d.type === "tournament-winner" ? `winner #${d.value}`
				: d.type === "budget-hit" ? `budget hit — ${out(d.value, 120)}`
				: d.type === "cache-hit" ? `cache hit (${d.scope})`
				: d.type === "when-guard" ? `when-guard ${d.result ? "passed" : "skipped"}`
				: `unreplayable (${d.reason})`;
			lines.push(`${ts}    ◆ ${e.phaseId} decision: ${summary}`);
		}
	}
	lines.push("");
	lines.push("(Pass json:true for a bounded machine-readable envelope; total/returned/truncated report omitted events.)");
	return lines.join("\n");
}

/** Human-readable offline replay report (MCP). Zero tokens — re-folds the
 *  recorded trace under alternate decision knobs. */
function formatReplayMcp(r: ReplayReport, runId: string, flowName: string): string {
	const lines: string[] = [
		`Replay — ${flowName} / ${runId}  (${r.decisions.length} phase decision(s), zero tokens)`,
	];
	lines.push("");
	if (r.needsLiveRerun) lines.push("⚠ Some phases need a live re-run (model/args override).");
	lines.push(`Recorded usage cost ≈ $${r.totalUsage.cost.toFixed(4)}  tokens in=${r.totalUsage.input} out=${r.totalUsage.output}`);
	lines.push("");
	for (const d of r.decisions) {
		const prior = d.priorOutcome ? ` prior=${d.priorOutcome}` : "";
		const next = d.replayedOutcome ? ` → ${d.replayedOutcome}` : "";
		lines.push(`  • ${d.phaseId}: [${d.outcome}]${prior}${next} — ${d.reason}`);
	}
	lines.push("");
	lines.push("(Pass json:true for the full ReplayReport machine-readable record.)");
	return lines.join("\n");
}

function parseReplayOverrides(args: Record<string, unknown>): ReplayOverrides {
	const o: ReplayOverrides = {};
	if (typeof args.budgetMaxUSD === "number") o.budgetMaxUSD = args.budgetMaxUSD;
	if (typeof args.budgetMaxTokens === "number") o.budgetMaxTokens = args.budgetMaxTokens;
	if (args.thresholds && typeof args.thresholds === "object" && !Array.isArray(args.thresholds)) {
		const t: Record<string, number> = {};
		for (const [k, v] of Object.entries(args.thresholds as Record<string, unknown>)) {
			if (typeof v === "number") t[k] = v;
		}
		if (Object.keys(t).length) o.thresholds = t;
	}
	if (args.models && typeof args.models === "object" && !Array.isArray(args.models)) {
		const m: Record<string, string> = {};
		for (const [k, v] of Object.entries(args.models as Record<string, unknown>)) {
			if (typeof v === "string") m[k] = v;
		}
		if (Object.keys(m).length) o.models = m;
	}
	return o;
}

/** Human-readable recompute dry-run report (MCP). Mirrors the pi adapter's
 *  formatRecompute. */
function formatRecomputeMcp(r: RecomputeReport): string {
	const lines: string[] = [`Recompute (DRY RUN — MCP never executes) — seed: ${r.seeds.join(", ")}`];
	lines.push("");
	lines.push(`▲ would re-run (${r.rerun.length}): ${r.rerun.join(", ") || "—"}`);
	lines.push(`✓ reused (outside frontier): ${r.reused.join(", ") || "—"}`);
	if (r.decisions && r.decisions.length > 0) {
		lines.push("");
		lines.push("Why:");
		for (const d of r.decisions) lines.push(`  • ${d.phaseId}: ${d.reason}`);
	}
	lines.push("");
	lines.push("To actually re-execute (spending tokens), use the Pi adapter: /tf recompute <runId> <phaseId> --apply");
	return lines.join("\n");
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
				mode: { type: "string", enum: ["foreground", "background"], description: "Execution mode. foreground (default) waits for the full DAG; background returns a runId immediately and continues even if the MCP request ends." },
			},
		},
	},
	{
		name: "taskflow_runs",
		title: "Manage background taskflow runs",
		description:
			"List recent background runs, inspect one run, wait for completion without losing it when the MCP request ends, or request cancellation. Use after taskflow_run with mode:'background'.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				action: { type: "string", enum: ["list", "status", "wait", "cancel"], description: "Lifecycle action." },
				runId: { type: "string", description: "Required for status, wait, and cancel." },
				timeoutMs: { type: "integer", description: "For wait: return after this many ms if still running (default 30000, max 300000)." },
				limit: { type: "integer", description: "For list: maximum recent background runs (default 10, max 50)." },
				status: { type: "string", enum: ["all", "running", "terminal"], description: "For list: show all runs (default), only active runs, or only terminal runs." },
				reason: { type: "string", description: "For cancel: optional audit reason." },
			},
			required: ["action"],
		},
	},
	{
		name: "taskflow_resume",
		title: "Resume a paused/failed run (forks a new run)",
		description:
			"Resume a stored run by forking a NEW run (the original run file is never modified). The child carries parentRunId pointing at the original. Reusable completed phases are copied (cache hits); the target phase + its transitive downstream re-run. With no overrides, ordinary resume re-runs the non-done phases. With overrides (requires phaseId + at least one of task/model/timeout/idleTimeout), exactly one phase is re-run with the patched values applied to the child's def only.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				runId: { type: "string", description: "The run to resume (from a prior taskflow_run)." },
				phaseId: { type: "string", description: "Target phase to re-run with overrides (required when any override field is supplied)." },
				task: { type: "string", description: "Override the target phase's task (requires phaseId). Applied to the forked child only — the parent is never modified." },
				model: { type: "string", description: "Override the target phase's model (requires phaseId)." },
				timeout: { type: "number", description: "Override the target phase's timeout in ms (>= 1000, requires phaseId)." },
				idleTimeout: { type: "number", description: "Override the target phase's idleTimeout in ms (>= 1000 or 0 to disable, requires phaseId)." },
			},
			required: ["runId"],
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
		name: "taskflow_lint",
		title: "Lint a taskflow with pluggable verifiers",
		description: "Run built-in and project-local pluggable verifiers (script-lint, custom checks) on a flow WITHOUT executing it. Discovers verifiers from .pi/taskflows/verifiers/. Provide `name`, `define`, or `defineFile`.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				name: { type: "string" },
				define: { type: "object" },
				defineFile: { type: "string", description: "Path to a JSON (or fenced-Markdown) flow file." },
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
		name: "taskflow_trace",
		title: "Show a run's deterministic-replay event trace",
		description:
			"Read the append-only event trace a run recorded (each subagent call's input/output + runtime decisions). Foundation for taskflow_replay. Responses are bounded; use limit to select up to 1000 newest events.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				runId: { type: "string", description: "The run to inspect (from a prior taskflow_run or the runs index)." },
				json: { type: "boolean", description: "Return a bounded machine-readable envelope instead of a human timeline. The envelope reports total/returned/truncated; oversized strings are truncated." },
				limit: { type: "number", minimum: 1, maximum: 1000, description: "Maximum newest trace events to return (default 200, max 1000). Large string fields and total response size are also bounded." },
			},
			required: ["runId"],
		},
	},
	{
		name: "taskflow_replay",
		title: "Replay a recorded run under alternate decision knobs (zero tokens)",
		description:
			"Re-evaluate a stored run's event trace offline against changed gate thresholds, budget caps, or model routes — without calling any model (zero tokens). Reports per-phase outcomes: reused, would-block, verdict-flipped, would-exceed-budget, needs-live-rerun, etc. Use after taskflow_trace when you want counterfactual analysis of a finished run.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				runId: { type: "string", description: "The run whose trace to replay (from a prior taskflow_run)." },
				json: { type: "boolean", description: "Return the full ReplayReport as JSON." },
				budgetMaxUSD: { type: "number", description: "Alternate max USD budget for would-exceed-budget checks." },
				budgetMaxTokens: { type: "number", description: "Alternate max token budget." },
				thresholds: {
					type: "object",
					additionalProperties: { type: "number" },
					description: "Map of phaseId → new score threshold (re-judges recorded gate-score events).",
				},
				models: {
					type: "object",
					additionalProperties: { type: "string" },
					description: "Map of phaseId → model id (currently marks needs-live-rerun; quality cannot be re-judged offline).",
				},
			},
			required: ["runId"],
		},
	},
	{
		name: "taskflow_why_stale",
		title: "Explain why a stored run is stale",
		description:
			"Given a runId (+ optional phaseId seed): with no seed, prints the observed dependency graph; with a seed, computes the transitive stale frontier — exactly which phases would need re-running and why (observed ∪ declared edges). Zero tokens. Read-only.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				runId: { type: "string", description: "The run to analyze." },
				phaseId: { type: "string", description: "Optional assumed-changed seed phase. Omit to print the observed dependency graph." },
			},
			required: ["runId"],
		},
	},
	{
		name: "taskflow_recompute",
		title: "Re-run a stored run's stale frontier (dry-run only)",
		description:
			"Report what would re-run if a phase changed — the stale frontier from the seed phase. Dry-run only in MCP (zero tokens): reports the re-run / cutoff / reused sets with per-phase reasons. To actually re-execute (spending tokens), use the Pi adapter's /tf recompute --apply. Never calls a model in MCP.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				runId: { type: "string", description: "The run whose frontier to compute." },
				phaseId: { type: "string", description: "The assumed-changed seed phase." },
			},
			required: ["runId", "phaseId"],
		},
	},
	{
		name: "taskflow_reconcile_workspace",
		title: "Acknowledge and reconcile the invocation workspace",
		description:
			"Explicitly accept the current external filesystem state after a resolve-only writer failed with an unknown outcome. This does not restore files or prove correctness: inspect or repair the workspace first. The host operator must also launch Taskflow with TASKFLOW_WORKSPACE_RECONCILE_MODE=explicit. Reconciliation takes an exclusive whole-root lease, durably clears dirty-unknown intents, and advances the workspace generation.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				acknowledgement: {
					type: "string",
					enum: [WORKSPACE_RECONCILE_ACKNOWLEDGEMENT],
					description: `Must exactly equal: ${WORKSPACE_RECONCILE_ACKNOWLEDGEMENT}`,
				},
				reason: { type: "string", description: "Short audit reason describing what was inspected or repaired." },
			},
			required: ["acknowledgement"],
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
	{
		name: "taskflow_version",
		title: "Show taskflow build/host identity",
		description:
			"Report the engine package version, the git commit the dist was built from, the bound host identity (codex/claude/opencode/grok), and the run-state schema version. Zero tokens, no execution. Use to verify which taskflow build a host is running.",
		inputSchema: { type: "object", additionalProperties: false, properties: {} },
	},
];

/** Resolve a flow from params: inline `define` (desugared), `defineFile` (disk), or saved `name`. */
function resolvePermittedDefineFile(cwd: string, requested: string): string {
	const lexical = resolve(cwd, requested);
	let candidate = lexical;
	try {
		candidate = realpathSync(lexical);
	} catch {
		// Keep the lexical path so a permitted-but-missing file still receives the
		// normal "not found" diagnostic from readDefineFile. Resolve its existing
		// parent so aliases such as macOS /tmp -> /private/tmp remain contained.
		try { candidate = join(realpathSync(dirname(lexical)), basename(lexical)); } catch { /* parent missing */ }
	}
	const rootCandidates = [cwd, tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"])]
		.map((root) => {
			try { return realpathSync(resolve(root)); } catch { return resolve(root); }
		});
	const allowed = rootCandidates.some((root) => {
		const rel = relative(root, candidate);
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	});
	if (!allowed) {
		throw new RpcError(
			RPC.INVALID_PARAMS,
			`defineFile must be contained in the server cwd or OS temp directory: ${requested}`,
		);
	}
	return candidate;
}

function resolveFlow(cwd: string, params: { name?: string; define?: unknown; defineFile?: unknown }): Taskflow {
	if (params.define === undefined && typeof params.defineFile === "string" && params.defineFile.trim()) {
		const filePath = resolvePermittedDefineFile(cwd, params.defineFile);
		const fromFile = readDefineFile(filePath);
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

/** Optional host-identity options for the MCP server (0.2.0 dogfood issue 4).
 *  `host` is the bound host identity (codex/claude/opencode/grok); it is
 *  stamped onto RunState.host and reported by `taskflow_version`. Defaults to
 *  `"taskflow"` when omitted so existing callers are unaffected. */
export interface McpHostOptions {
	host?: string;
	/** Resolvable host-runner module used by detached/background execution. */
	detachedRunner?: DetachedRunnerBinding;
}

/** Stamp a freshly-created RunState with build/host identity (0.2.0 dogfood
 *  issue 4). Backward-compatible: only sets optional fields. Pure (mutates the
 *  passed state in place for convenience). */
export function stampRunIdentity(state: RunState, host?: string): void {
	const info = getBuildInfo();
	state.packageVersion = info.packageVersion;
	state.gitCommit = info.gitCommit;
	state.schemaVersion = info.schemaVersion;
	if (host) state.host = host;
}

function mkRunState(def: Taskflow, args: Record<string, unknown>, cwd: string, host?: string): RunState {
	const state: RunState = {
		runId: newRunId(def.name ?? "flow"),
		flowName: def.name ?? "flow",
		def,
		args,
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
		invocationRootSnapshot: directoryIdentity(cwd),
	};
	stampRunIdentity(state, host);
	return state;
}

export function persistTerminalRun(
	state: RunState,
	cleanupConfig: Parameters<typeof saveRun>[1],
	write: typeof saveRun = saveRun,
): string | undefined {
	try {
		write(state, cleanupConfig);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
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
	opts?: McpHostOptions,
): Record<string, (args: Record<string, unknown>, context?: RpcContext) => Promise<unknown>> {
	const host = opts?.host;
	return {
		taskflow_run: async (args, context) => {
			const reusedSavedName =
				args.define === undefined && args.defineFile === undefined && typeof args.name === "string" && args.name.trim()
					? args.name.trim()
					: undefined;
			const def = resolveFlow(cwd, args);
			const structural = validateTaskflow(def);
			if (!structural.ok) return textContent(`Flow is invalid:\n- ${structural.errors.join("\n- ")}`, true);
			const providedArgs = args.args && typeof args.args === "object" && !Array.isArray(args.args)
				? args.args as Record<string, unknown>
				: {};
			const resolvedArgs = resolveArgs(def, providedArgs);
			const invocation = validateTaskflow(def, { args: resolvedArgs, cwd });
			if (!invocation.ok) return textContent(`Flow invocation is invalid:\n- ${invocation.errors.join("\n- ")}`, true);
			const usageAccounting = runner.usageAccounting;
			if (def.budget && usageAccounting === "unavailable") {
				return textContent(
					"This host does not report token or cost usage, so taskflow refuses to run a budgeted flow: the declared ceiling could not be enforced. Remove `budget` only if unmetered execution is intentional, or use a host with usage accounting.",
					true,
				);
			}
			if (def.budget?.maxUSD !== undefined && usageAccounting === "tokens-only") {
				return textContent(
					"This host reports token usage but not cost, so taskflow refuses budget.maxUSD: the declared dollar ceiling could not be enforced. Use budget.maxTokens or a host with cost accounting.",
					true,
				);
			}

			// Resolve model roles (e.g. {{fast}} -> a real model id) so the built-in
			// agents' placeholder models map to something the host can launch. This is
			// the same lookup the pi adapter does; without it every phase fails with
			// "Model metadata for {{fast}} not found".
			const settings = readSubagentSettings();
			const agentScope = def.agentScope ?? "both";
			const { agents } = discoverAgents(cwd, agentScope, settings.modelRoles, settings.taskflow);
			const deps: RuntimeDeps = {
				cwd,
				agents,
				globalThinking: settings.globalThinking,
				runTask: runner.runTask,
				signal: context?.signal,
				usageAccounting,
				cwdBridgeMode: cwdBridgeModeFromEnv(),
				loadFlow: (name: string) => {
					const loaded = getFlowDiagnosed(cwd, name);
					return loaded.ok ? loaded.value.def : undefined;
				},
			};
			const state = mkRunState(def, resolvedArgs, cwd, host);
			if (args.mode === "background") {
				if (!opts?.detachedRunner) {
					return textContent(
						"Background mode is unavailable because this MCP host did not provide a detached runner binding.",
						true,
					);
				}
				let pid: number;
				try {
					({ pid } = launchMcpBackgroundRun({
						state,
						runner: opts.detachedRunner,
						incremental: args.incremental === true,
						reusedSavedName: args.reusedFromSearch === true ? reusedSavedName : undefined,
						agents,
						globalThinking: settings.globalThinking,
						agentScope,
						maxKeptRuns: settings.taskflow.maxKeptRuns,
						maxRunAgeDays: settings.taskflow.maxRunAgeDays,
					}));
				} catch (error) {
					return textContent(
						`Failed to start background taskflow: ${error instanceof Error ? error.message : String(error)}`,
						true,
					);
				}

				let contentionWarning = "";
				try {
					const { activeCount } = listMcpBackgroundRuns(cwd, 0);
					contentionWarning = activeCount > BACKGROUND_RUN_WARNING_THRESHOLD
						? `\n\nWarning: ${activeCount} background runs are active in this project. Taskflow does not provide a global cross-host concurrency or budget coordinator; use taskflow_runs list/cancel if this is unintentional.`
						: "";
				} catch (error) {
					contentionWarning = `\n\nWarning: the run started successfully, but background contention could not be inspected: ${error instanceof Error ? error.message : String(error)}`;
				}
				return textContent(
					`↻ taskflow started in background\n\n${state.flowName} · pid ${pid} · run ${state.runId}\nUse taskflow_runs with action status, wait, or cancel.${contentionWarning}`,
				);
			}
			// Deterministic-replay trace (best-effort, fail-open).
			deps.trace = new FileTraceSink(traceFilePath(runsDir(cwd), state.flowName, state.runId));
			if (args.incremental === true) (deps as RuntimeDeps & { cacheScopeDefault?: string }).cacheScopeDefault = "cross-run";

			// Persist run state (throttled + final) so taskflow_peek / resume can read
			// intermediate phase outputs after the run — same contract as the pi adapter.
			const cleanupConfig = {
				maxKeep: settings.taskflow.maxKeptRuns,
				maxAgeDays: settings.taskflow.maxRunAgeDays,
			};
			let lastPersist = 0;
			deps.persist = (s) => {
				const now = Date.now();
				if (now - lastPersist >= 1000) {
					lastPersist = now;
					saveRun(s, cleanupConfig);
				}
			};

			let terminalPersistError: string | undefined;
			let res: Awaited<ReturnType<typeof executeTaskflow>>;
			try {
				res = await executeTaskflow(state, deps);
				state.finalOutput = res.finalOutput;
				state.outputSourcePhaseId = res.outputSourcePhaseId;
			} finally {
				// Terminal persist must survive a throwing runtime ("never lose work") —
				// and persistence itself must never sink a completed run.
				terminalPersistError = persistTerminalRun(state, cleanupConfig);
			}
			if (terminalPersistError !== undefined) {
				return textContent(
					`Taskflow execution finished, but terminal run persistence failed; no durable run ID can be promised: ${terminalPersistError}`,
					true,
				);
			}
			if (res.ok && args.reusedFromSearch === true && reusedSavedName) {
				try {
					bumpReuseInSidecar(cwd, reusedSavedName);
				} catch {
					/* fail-open: reuse bookkeeping is best-effort */
				}
			}
			const header = res.ok ? "✓ taskflow complete" : "✗ taskflow did not fully succeed";
			const u = res.totalUsage;
			// Label the output with the ACTUAL source phase (0.2.0 dogfood issue 6):
			// the phase whose output supplied finalOutput — never the designated
			// skipped/failed final phase. Omit the label only when no attribution is
			// available (no phase output).
			const sourceLabel = res.outputSourcePhaseId ? `--- ${res.outputSourcePhaseId} ---\n` : "";
			const usageLine = `\n\n— ${u.turns} turns · in ${u.input} · out ${u.output} tokens · run ${state.runId}`;
			return textContent(`${header}\n\n${sourceLabel}${res.finalOutput}${usageLine}`, !res.ok);
		},

		taskflow_runs: async (args, context) => {
			const action = String(args.action ?? "");
			if (action === "list") {
				const limit = Math.max(1, Math.min(50, typeof args.limit === "number" ? Math.floor(args.limit) : 10));
				const filter: BackgroundRunFilter = args.status === "running" || args.status === "terminal"
					? args.status
					: "all";
				const roster = listMcpBackgroundRuns(cwd, limit, filter);
				if (roster.runs.length === 0) {
					const scope = filter === "all" ? "" : `${filter} `;
					return textContent(`No ${scope}background taskflow runs found from this directory. ${roster.activeCount} active total.`);
				}
				const scope = filter === "all" ? "" : ` · ${filter}`;
				return textContent(
					`Background taskflow runs — ${roster.activeCount} active · ${roster.totalCount} total${scope}:\n${roster.runs.map((run) => formatBackgroundRun(run, false)).join("\n")}`,
				);
			}

			const runId = typeof args.runId === "string" ? args.runId.trim() : "";
			if (!runId) return textContent(`taskflow_runs action '${action}' requires \`runId\`.`, true);
			let state = refreshDetachedRun(cwd, runId);
			if (!state) return textContent(`Run \"${runId}\" was not found.`, true);
			if (!state.detached) return textContent(`Run \"${runId}\" is not a background run.`, true);

			if (action === "status") return textContent(formatBackgroundRun(state, true));
			if (action === "wait") {
				const timeoutMs = Math.max(0, Math.min(300_000, typeof args.timeoutMs === "number" ? Math.floor(args.timeoutMs) : 30_000));
				state = await waitForMcpBackgroundRun(cwd, runId, timeoutMs, context?.signal) ?? state;
				return textContent(formatBackgroundRun(state, true), state.status !== "running" && state.status !== "completed");
			}
			if (action === "cancel") {
				if (state.status !== "running") return textContent(`Run is already ${state.status}.\n${formatBackgroundRun(state, true)}`);
				if (state.detachedControlVersion !== DETACHED_CONTROL_VERSION) {
					return textContent(
						`Run \"${runId}\" was created by a legacy detached worker that does not support durable cross-request cancellation. Wait for it to finish or stop that worker through its original host.`,
						true,
					);
				}
				cancelMcpBackgroundRun(cwd, runId, typeof args.reason === "string" ? args.reason : undefined);
				const afterRequest = refreshDetachedRun(cwd, runId);
				if (afterRequest && afterRequest.status !== "running") {
					clearDetachedCancelRequest(afterRequest.cwd, afterRequest.runId);
					return textContent(`Run became ${afterRequest.status} before cancellation was delivered.\n${formatBackgroundRun(afterRequest, true)}`);
				}
				return textContent(`Cancellation requested.\n${formatBackgroundRun(state, false)}`);
			}
			return textContent(`Unknown taskflow_runs action: ${action}`, true);
		},

		taskflow_resume: async (args, context) => {
			// 0.2.0 dogfood issue 5: resume forks a NEW run; the original is never
			// mutated or overwritten. Optional overrides re-run exactly one phase.
			const runId = String(args.runId ?? "");
			if (!runId) return textContent("taskflow_resume requires `runId`.", true);
			const prevR = loadRunDiagnosed(cwd, runId);
			if (!prevR.ok) return textContent(describeLoadFailure(prevR, `Run "${runId}"`), true);
			const prev = prevR.value;
			const hasOverrideField =
				args.task !== undefined || args.model !== undefined ||
				args.timeout !== undefined || args.idleTimeout !== undefined;
			let overrides: ResumeOverrides | undefined;
			if (hasOverrideField) {
				if (typeof args.phaseId !== "string" || !args.phaseId)
					return textContent("taskflow_resume with overrides requires `phaseId` (the target phase to re-run).", true);
				overrides = {
					phaseId: String(args.phaseId),
					...(args.task !== undefined ? { task: String(args.task) } : {}),
					...(args.model !== undefined ? { model: String(args.model) } : {}),
					...(args.timeout !== undefined ? { timeout: Number(args.timeout) } : {}),
					...(args.idleTimeout !== undefined ? { idleTimeout: Number(args.idleTimeout) } : {}),
				};
			}
			const resumable = validateResumeRequest(prev, overrides);
			if (!resumable.ok) {
				const prefix = overrides ? "Invalid resume overrides:\n- " : "";
				return textContent(`${prefix}${resumable.errors.join(overrides ? "\n- " : "; ")}`, true);
			}
			const child = forkRunForResume(prev, { overrides, cwd, host });
			const settings = readSubagentSettings();
			const { agents } = discoverAgents(cwd, "both", settings.modelRoles, settings.taskflow);
			const deps: RuntimeDeps = {
				cwd,
				agents,
				runTask: runner.runTask,
				signal: context?.signal,
				usageAccounting: runner.usageAccounting,
				cwdBridgeMode: cwdBridgeModeFromEnv(),
				trace: new FileTraceSink(traceFilePath(runsDir(cwd), child.flowName, child.runId)),
			};
			const cleanupConfig = {
				maxKeep: settings.taskflow.maxKeptRuns,
				maxAgeDays: settings.taskflow.maxRunAgeDays,
			};
			let lastPersist = 0;
			deps.persist = (s) => { if (Date.now() - lastPersist >= 1000) { lastPersist = Date.now(); saveRun(s, cleanupConfig); } };
			let terminalPersistError: string | undefined;
			const res = await executeTaskflow(child, deps).finally(() => {
				terminalPersistError = persistTerminalRun(child, cleanupConfig);
			});
			if (terminalPersistError !== undefined)
				return textContent(`Resume finished, but terminal run persistence failed: ${terminalPersistError}`, true);
			const header = res.ok ? "✓ taskflow resume complete" : "✗ taskflow resume did not fully succeed";
			const parent = child.parentRunId ? ` (forked from ${child.parentRunId})` : "";
			const u = res.totalUsage;
			const sourceLabel = res.outputSourcePhaseId ? `--- ${res.outputSourcePhaseId} ---\n` : "";
			const usageLine = `\n\n— ${u.turns} turns · in ${u.input} · out ${u.output} tokens · run ${child.runId}${parent}`;
			return textContent(`${header}\n\n${sourceLabel}${res.finalOutput}${usageLine}`, !res.ok);
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

		taskflow_trace: async (args) => {
			const runId = String(args.runId ?? "");
			if (!runId) return textContent("taskflow_trace requires `runId`.", true);
			const runR = loadRunDiagnosed(cwd, runId);
			if (!runR.ok) return textContent(describeLoadFailure(runR, `Run "${runId}"`), true);
			const run = runR.value;
			const events = readTrace(traceFilePath(runsDir(cwd), run.flowName, run.runId));
			if (events.length === 0)
				return textContent(`No trace recorded for run "${runId}" (the run predates tracing, or no trace sink was injected).`, true);
			if (args.json === true) return textContent(formatTraceJsonMcp(events, args.limit));
			return textContent(formatTraceMcp(events, run.runId, run.flowName, args.limit));
		},

		taskflow_replay: async (args) => {
			const runId = String(args.runId ?? "");
			if (!runId) return textContent("taskflow_replay requires `runId`.", true);
			const runR = loadRunDiagnosed(cwd, runId);
			if (!runR.ok) return textContent(describeLoadFailure(runR, `Run "${runId}"`), true);
			const run = runR.value;
			const raw = readTrace(traceFilePath(runsDir(cwd), run.flowName, run.runId));
			if (raw.length === 0)
				return textContent(`No trace recorded for run "${runId}" (the run predates tracing, or no trace sink was injected).`, true);
			const events = raw.map((e) => upgradeTraceEvent(e as unknown as Record<string, unknown>));
			const report = replayRun(events, parseReplayOverrides(args));
			if (args.json === true) return textContent(JSON.stringify(report, null, 2));
			return textContent(formatReplayMcp(report, run.runId, run.flowName));
		},

		taskflow_why_stale: async (args) => {
			const runId = String(args.runId ?? "");
			if (!runId) return textContent("taskflow_why_stale requires `runId`.", true);
			const runR = loadRunDiagnosed(cwd, runId);
			if (!runR.ok) return textContent(describeLoadFailure(runR, `Run "${runId}"`), true);
			const run = runR.value;
			const reads = readMapOf(run.phases);
			const declared = declaredReadMapOfDef(run.def);
			const seeds = typeof args.phaseId === "string" ? [args.phaseId] : [];
			return textContent(formatWhyStale(run.runId, run.flowName, reads, seeds, declared));
		},

		taskflow_recompute: async (args, context) => {
			// MCP exposes recompute as DRY-RUN ONLY (never spends tokens). To actually
			// re-execute, hosts use the Pi adapter's /tf recompute --apply.
			const runId = String(args.runId ?? "");
			const phaseId = String(args.phaseId ?? "");
			if (!runId || !phaseId) return textContent("taskflow_recompute requires `runId` and `phaseId` (the seed).", true);
			const runR = loadRunDiagnosed(cwd, runId);
			if (!runR.ok) return textContent(describeLoadFailure(runR, `Run "${runId}"`), true);
			const run = runR.value;
			const settings = readSubagentSettings();
			const { agents } = discoverAgents(cwd, "both", settings.modelRoles, settings.taskflow);
			const deps: RuntimeDeps = { cwd, agents, runTask: runner.runTask, signal: context?.signal };
			const { report } = await recomputeTaskflow(run, deps, [phaseId], { dryRun: true });
			return textContent(formatRecomputeMcp(report));
		},

		taskflow_reconcile_workspace: async (args, context) => {
			try {
				const result = await reconcileResolveOnlyWorkspace({
					invocationRoot: cwd,
					signal: context?.signal,
					allowReconcile: workspaceReconcileAllowedFromEnv(),
				}, {
					acknowledgement: String(args.acknowledgement ?? ""),
					reason: typeof args.reason === "string" ? args.reason : undefined,
					signal: context?.signal,
				});
				const changed = result.reconciledIntentIds.length;
				return textContent(
					changed === 0
						? `Workspace is already clean at generation ${result.generation}; no dirty intent was changed.`
						: `Workspace reconciled: ${changed} dirty intent(s) accepted; generation ${result.previousGeneration} → ${result.generation}.`,
				);
			} catch (error) {
				return textContent(
					`Workspace reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
					true,
				);
			}
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

		taskflow_lint: async (args) => {
			const def = resolveFlow(cwd, args);
			const val = validateTaskflow(def);
			const phasesIterable = Array.isArray((def as { phases?: unknown }).phases);
			if (!phasesIterable) {
				const { text } = issueBlocks([], val.errors, val.warnings);
				return textContent(`✗ lint FAILED — flow is not lintable (phases not an array)${text}`, true);
			}
			// Discover project-local verifiers (fail-open).
			const discovered = await discoverVerifiers(cwd);
			const verifiers = [...builtinVerifiers, ...discovered.verifiers];
			const result = verifyTaskflow(def as Parameters<typeof verifyTaskflow>[0], { verifiers });
			// Filter to plugin-category issues only (built-in structural issues
			// are covered by taskflow_verify).
			const pluginIssues = result.issues.filter((i) => i.category === "plugin");
			const errorCount = pluginIssues.filter((i) => i.severity === "error").length;
			const warningCount = pluginIssues.filter((i) => i.severity === "warning").length;
			const passed = errorCount === 0;
			const head = passed
				? warningCount
					? `✓ lint PASSED — ${count(warningCount, "warning")}`
					: "✓ lint PASSED — no issues"
				: `✗ lint FAILED — ${count(errorCount, "error")}, ${count(warningCount, "warning")}`;
			const lines: string[] = [head];
			if (discovered.verifiers.length > 0) {
				lines.push(`Verifiers: ${[...builtinVerifiers, ...discovered.verifiers].map((v) => v.name).join(", ")}`);
			}
			if (discovered.warnings.length > 0) {
				lines.push(`Discovery warnings: ${discovered.warnings.join("; ")}`);
			}
			for (const issue of pluginIssues) {
				const icon = issue.severity === "error" ? "✗" : "⚠";
				const loc = issue.phaseId ? ` [${issue.phaseId}]` : "";
				const src = issue.source ? ` (${issue.source})` : "";
				lines.push(`  ${icon}${loc}${src} ${issue.message}`);
			}
			return textContent(lines.join("\n"), !passed);
		},

		taskflow_version: async () => {
			// 0.2.0 dogfood issue 4: report package/build/host identity.
			const info: BuildInfo = getBuildInfo();
			const hostName = host ?? "taskflow";
			const lines = [
				`taskflow ${info.packageVersion} · host ${hostName}`,
				`git commit: ${info.gitCommit}`,
				`run-state schema: v${info.schemaVersion}`,
			];
			if (info.buildTime !== undefined) lines.push(`built: ${new Date(info.buildTime).toISOString()}`);
			return textContent(lines.join("\n"));
		},
	};
}

/** Build the full MCP method dispatch table (protocol + tools). */
export function makeMcpHandlers(cwd: string, runner: SubagentRunner<AgentConfig>, opts?: McpHostOptions): Record<string, RpcHandler> {
	const tools = makeToolHandlers(cwd, runner, opts);
	const serverInfo = serverInfoFor(opts?.host);
	let initialized = false;

	return {
		initialize: () => {
			initialized = true;
			return {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: false } },
				serverInfo,
			};
		},
		// Client tells us it's ready — notification, no response.
		"notifications/initialized": () => {
			initialized = true;
		},
		ping: () => ({}),
		"tools/list": () => ({ tools: TOOLS }),
		"tools/call": async (params, context) => {
			const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
			const tool = tools[p.name ?? ""];
			if (!tool) throw new RpcError(RPC.INVALID_PARAMS, `Unknown tool: ${p.name}`);
			const descriptor = TOOLS.find((candidate) => candidate.name === p.name);
			if (!descriptor) throw new RpcError(RPC.INVALID_PARAMS, `Unknown tool schema: ${p.name}`);
			const args = validateToolArguments(descriptor, p.arguments);
			void initialized; // tolerant: we don't hard-gate on initialize ordering
			return await tool(args, context);
		},
	};
}

/** Start the stdio MCP server. Resolves when the client disconnects. */
export function startMcpServer(runner: SubagentRunner<AgentConfig>, cwd: string = process.cwd(), opts?: McpHostOptions): Promise<void> {
	return serveStdio(makeMcpHandlers(cwd, runner, opts));
}
