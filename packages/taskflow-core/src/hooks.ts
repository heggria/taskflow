/**
 * Flow-level hooks — fire-and-forget notifications on terminal run outcomes.
 *
 * Payload is summary-only (never transcripts / phase outputs).
 * Hook failure must never change run status.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import { spawn } from "node:child_process";
import type { RunState } from "./store.ts";
import { countPhaseOutcomes } from "./savings.ts";
import { getBuildInfo } from "./build-info.ts";

export type HookEvent = "complete" | "fail" | "blocked";

export type HookAction =
	| { type: "webhook"; url: string; timeoutMs?: number }
	| { type: "file"; path: string }
	| { type: "command"; run: string[] };

export interface FlowHooks {
	onComplete?: HookAction[];
	onFail?: HookAction[];
	onBlocked?: HookAction[];
}

export interface HookPayload {
	schema: "taskflow.hook.v1";
	event: HookEvent;
	runId: string;
	flowName: string;
	status: string;
	host?: string;
	packageVersion?: string;
	startedAt?: number;
	endedAt?: number;
	phaseCounts: {
		total: number;
		completed: number;
		failed: number;
		skipped: number;
		cached: number;
	};
	usage?: { inputTokens?: number; outputTokens?: number; totalCost?: number };
	outputSourcePhaseId?: string;
	errorSummary?: string;
	approvalPhaseId?: string;
}

export interface HookDispatchResult {
	event: HookEvent;
	dispatched: number;
	errors: string[];
}

const MAX_HOOKS_PER_EVENT = 5;
const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000;

/** Map run status → hook event (or undefined if no hook fires). */
export function hookEventForStatus(status: string): HookEvent | undefined {
	if (status === "completed") return "complete";
	if (status === "failed") return "fail";
	if (status === "blocked" || status === "paused") return "blocked";
	return undefined;
}

export function actionsForEvent(hooks: FlowHooks | undefined, event: HookEvent): HookAction[] {
	if (!hooks) return [];
	const list =
		event === "complete" ? hooks.onComplete : event === "fail" ? hooks.onFail : hooks.onBlocked;
	return Array.isArray(list) ? list.slice(0, MAX_HOOKS_PER_EVENT) : [];
}

/** Build summary payload — never includes phase outputs. */
export function buildHookPayload(event: HookEvent, state: RunState): HookPayload {
	const counts = countPhaseOutcomes(state.phases);
	const build = getBuildInfo();
	const errorSummary = firstErrorSummary(state);
	const approvalPhaseId = findApprovalPhase(state);
	return {
		schema: "taskflow.hook.v1",
		event,
		runId: state.runId,
		flowName: state.flowName,
		status: state.status,
		host: state.host,
		packageVersion: state.packageVersion ?? build.packageVersion,
		startedAt: state.createdAt,
		endedAt: state.updatedAt ?? Date.now(),
		phaseCounts: {
			total: counts.total,
			completed: counts.completed,
			failed: counts.failed,
			skipped: counts.skipped,
			cached: counts.cached,
		},
		usage: aggregateUsageLite(state),
		outputSourcePhaseId: state.outputSourcePhaseId,
		...(errorSummary ? { errorSummary } : {}),
		...(approvalPhaseId ? { approvalPhaseId } : {}),
	};
}

function firstErrorSummary(state: RunState): string | undefined {
	for (const ps of Object.values(state.phases)) {
		if (ps.error) return String(ps.error).slice(0, 500);
		if (ps.gate?.verdict === "block" && ps.gate.reason) return String(ps.gate.reason).slice(0, 500);
	}
	if (state.finalOutput && state.status !== "completed") {
		return String(state.finalOutput).slice(0, 500);
	}
	return undefined;
}

function findApprovalPhase(state: RunState): string | undefined {
	for (const [id, ps] of Object.entries(state.phases)) {
		if (ps.approval) return id;
	}
	return undefined;
}

function aggregateUsageLite(state: RunState): HookPayload["usage"] {
	let inputTokens = 0;
	let outputTokens = 0;
	let totalCost = 0;
	let any = false;
	for (const ps of Object.values(state.phases)) {
		const u = ps.usage as { input?: number; output?: number; cost?: number } | undefined;
		if (!u) continue;
		any = true;
		if (typeof u.input === "number") inputTokens += u.input;
		if (typeof u.output === "number") outputTokens += u.output;
		if (typeof u.cost === "number") totalCost += u.cost;
	}
	if (!any) return undefined;
	return { inputTokens, outputTokens, totalCost };
}

/** Validate a single hook action; returns error string or null. */
export function validateHookAction(action: unknown, index: number, event: string): string | null {
	if (!action || typeof action !== "object" || Array.isArray(action)) {
		return `hooks.${event}[${index}] must be an object`;
	}
	const a = action as Record<string, unknown>;
	const type = a.type;
	if (type === "webhook") {
		if (typeof a.url !== "string" || !a.url.trim()) return `hooks.${event}[${index}].url is required`;
		const err = validateWebhookUrl(a.url.trim());
		if (err) return `hooks.${event}[${index}]: ${err}`;
		if (a.timeoutMs !== undefined && (typeof a.timeoutMs !== "number" || a.timeoutMs < 100 || a.timeoutMs > 60_000)) {
			return `hooks.${event}[${index}].timeoutMs must be 100–60000`;
		}
		return null;
	}
	if (type === "file") {
		if (typeof a.path !== "string" || !a.path.trim()) return `hooks.${event}[${index}].path is required`;
		if (path.isAbsolute(a.path) || a.path.split(/[/\\]/).includes("..")) {
			return `hooks.${event}[${index}].path must be project-relative without '..'`;
		}
		return null;
	}
	if (type === "command") {
		if (!Array.isArray(a.run) || a.run.length === 0 || !a.run.every((x) => typeof x === "string")) {
			return `hooks.${event}[${index}].run must be a non-empty string array (no shell string)`;
		}
		return null;
	}
	return `hooks.${event}[${index}].type must be webhook|file|command`;
}

export function validateWebhookUrl(url: string): string | null {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return "invalid URL";
	}
	if (u.protocol === "https:") return null;
	if (u.protocol === "http:") {
		const host = u.hostname.toLowerCase();
		if (host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1") return null;
		return "http URLs are only allowed for 127.0.0.1 / localhost (use https otherwise)";
	}
	return "URL scheme must be https (or http://127.0.0.1|localhost)";
}

/** Validate flow.hooks block; returns error strings. */
export function validateFlowHooks(hooks: unknown): string[] {
	if (hooks === undefined) return [];
	if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return ["hooks must be an object"];
	const h = hooks as Record<string, unknown>;
	const errors: string[] = [];
	for (const event of ["onComplete", "onFail", "onBlocked"] as const) {
		if (h[event] === undefined) continue;
		if (!Array.isArray(h[event])) {
			errors.push(`hooks.${event} must be an array`);
			continue;
		}
		if (h[event].length > MAX_HOOKS_PER_EVENT) {
			errors.push(`hooks.${event} allows at most ${MAX_HOOKS_PER_EVENT} actions`);
		}
		h[event].forEach((a, i) => {
			const e = validateHookAction(a, i, event);
			if (e) errors.push(e);
		});
	}
	for (const k of Object.keys(h)) {
		if (!["onComplete", "onFail", "onBlocked"].includes(k)) {
			errors.push(`hooks: unknown key '${k}'`);
		}
	}
	return errors;
}

async function dispatchOne(action: HookAction, payload: HookPayload, cwd: string): Promise<void> {
	if (action.type === "file") {
		const target = path.resolve(cwd, action.path);
		const root = path.resolve(cwd);
		if (!target.startsWith(root + path.sep) && target !== root) {
			throw new Error(`hook file path escapes project root: ${action.path}`);
		}
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
		fs.renameSync(tmp, target);
		return;
	}
	if (action.type === "webhook") {
		await postWebhook(action.url, payload, action.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS);
		return;
	}
	if (action.type === "command") {
		await runCommand(action.run, payload, cwd);
		return;
	}
}

function postWebhook(url: string, payload: HookPayload, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify(payload);
		const u = new URL(url);
		const lib = u.protocol === "https:" ? https : http;
		const req = lib.request(
			{
				protocol: u.protocol,
				hostname: u.hostname,
				port: u.port || (u.protocol === "https:" ? 443 : 80),
				path: `${u.pathname}${u.search}`,
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(body),
					"user-agent": "taskflow-hooks/1",
				},
				timeout: timeoutMs,
			},
			(res) => {
				res.resume();
				if (res.statusCode && res.statusCode >= 400) {
					reject(new Error(`webhook HTTP ${res.statusCode}`));
				} else {
					resolve();
				}
			},
		);
		req.on("timeout", () => {
			req.destroy();
			reject(new Error("webhook timeout"));
		});
		req.on("error", reject);
		req.write(body);
		req.end();
	});
}

function runCommand(argv: string[], payload: HookPayload, cwd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const [cmd, ...args] = argv;
		const child = spawn(cmd, args, {
			cwd,
			env: {
				...process.env,
				TASKFLOW_HOOK_PAYLOAD: JSON.stringify(payload),
				TASKFLOW_HOOK_EVENT: payload.event,
				TASKFLOW_HOOK_RUN_ID: payload.runId,
				TASKFLOW_HOOK_STATUS: payload.status,
			},
			stdio: "ignore",
		});
		const t = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error("hook command timeout"));
		}, 30_000);
		child.on("error", (e) => {
			clearTimeout(t);
			reject(e);
		});
		child.on("exit", (code) => {
			clearTimeout(t);
			if (code === 0) resolve();
			else reject(new Error(`hook command exit ${code}`));
		});
	});
}

/**
 * Dispatch hooks for a terminal run. Never throws; collects errors.
 */
export async function dispatchHooks(
	state: RunState,
	opts: { cwd: string; hooks?: FlowHooks },
): Promise<HookDispatchResult> {
	const event = hookEventForStatus(state.status);
	if (!event) return { event: "complete", dispatched: 0, errors: [] };
	const actions = actionsForEvent(opts.hooks ?? (state.def as { hooks?: FlowHooks }).hooks, event);
	if (!actions.length) return { event, dispatched: 0, errors: [] };
	const payload = buildHookPayload(event, state);
	const errors: string[] = [];
	let dispatched = 0;
	for (const action of actions) {
		try {
			await dispatchOne(action, payload, opts.cwd);
			dispatched++;
		} catch (e) {
			errors.push(e instanceof Error ? e.message : String(e));
		}
	}
	return { event, dispatched, errors };
}
