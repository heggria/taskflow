/**
 * Shared Context Tree — the file-based blackboard + supervision-tree store.
 *
 * This module is the IPC substrate that lets isolated subagent processes share
 * context with each other (a horizontal blackboard) and report results upward
 * so a parent can react (a vertical supervision tree). It deliberately reuses
 * the SAME atomic-write + file-lock primitives as the run store (`store.ts`),
 * so it inherits the project's "all file ops are atomic" invariant for free.
 *
 * On-disk layout, rooted at PI_TASKFLOW_CTX_DIR (one directory per run):
 *
 *   <ctxDir>/
 *   ├── tree.json                  the node tree (who spawned whom + status)
 *   ├── tree.json.lock             lock guarding tree.json RMW cycles
 *   ├── findings/
 *   │   ├── <nodeId>.json          findings written by one node (last-write-wins per key)
 *   │   └── <nodeId>.json.lock
 *   ├── reports/
 *   │   └── <nodeId>.json          a node's upward report ({summary, structured?})
 *   └── pending/
 *       └── <nodeId>-<seq>.json    a ctx_spawn intent the runtime will pick up
 *
 * Why per-node findings files (not one shared findings.json): sibling subagents
 * run concurrently. Giving each node its OWN file means concurrent writers never
 * contend on the same lock — a node only locks its own file. A reader unions the
 * relevant nodes' files (its ancestors + completed siblings). This is the same
 * "shard by writer" trick the run index uses to avoid a global write bottleneck.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateRunId, withLock, writeFileAtomic } from "./store.ts";

// ---------------------------------------------------------------------------
// Guards (size + key charset). A subagent is untrusted input from the LLM's
// point of view; cap what it can write so a runaway tool call can't fill the
// disk or smuggle a path-traversal key.
// ---------------------------------------------------------------------------

/** Max bytes for a single findings value (after JSON.stringify). */
export const MAX_VALUE_BYTES = 256 * 1024; // 256 KB
/** Max bytes for a single report summary string. */
export const MAX_REPORT_BYTES = 256 * 1024;
/** Max bytes for a report's structured payload (after JSON.stringify). */
export const MAX_STRUCTURED_BYTES = 256 * 1024;
/** Max bytes for a single ctx_spawn task prompt. */
export const MAX_TASK_BYTES = 64 * 1024;
/** Max number of keys one node may write. */
export const MAX_KEYS_PER_NODE = 256;
/** Max assignments a single ctx_spawn call may queue. */
export const MAX_SPAWN_ASSIGNMENTS = 16;
/** Max bytes for a single ctx_spawn `subflow` payload (after JSON.stringify). */
export const MAX_SUBFLOW_BYTES = 256 * 1024; // 256 KB

/** A findings/report key must be a short, traversal-safe token. */
const KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function isValidKey(key: string): boolean {
	return typeof key === "string" && KEY_RE.test(key) && !key.includes("..");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NodeStatus = "running" | "done" | "failed";

/** One node in the supervision tree (one subagent task). */
export interface TreeNode {
	nodeId: string;
	phaseId: string;
	parentNodeId?: string;
	status: NodeStatus;
	createdAt: number;
	updatedAt: number;
}

export interface ContextTree {
	nodes: TreeNode[];
}

/** A node's findings — a flat string→JSON map. Last-write-wins per key. */
export type FindingsMap = Record<string, unknown>;

export interface NodeReport {
	nodeId: string;
	summary: string;
	structured?: unknown;
	at: number;
}

/**
 * A queued ctx_spawn intent, picked up by the runtime after the node finishes.
 * Each assignment is EITHER a flat task OR an inline sub-flow (DAG) — never both.
 *
 * - `task`         : a single prompt string (the agent named by `agent` runs it).
 * - `subflow`      : an inline Taskflow ({phases:[...]} or a bare phases array)
 *                    the runtime validates + runs as a nested sub-flow. Inner
 *                    phases without their own `agent` fall back to `defaultAgent`.
 *
 * `agent` (flat) means "who executes this task"; `defaultAgent` (subflow) means
 * "fallback agent for inner phases" — different semantics, hence different fields.
 */
export interface SpawnAssignment {
	task?: string;
	agent?: string;
	subflow?: unknown;
	defaultAgent?: string;
}

export interface PendingSpawn {
	parentNodeId: string;
	assignments: SpawnAssignment[];
	at: number;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function treePath(ctxDir: string): string {
	return path.join(ctxDir, "tree.json");
}
function treeLockPath(ctxDir: string): string {
	return path.join(ctxDir, "tree.json.lock");
}
function findingsDir(ctxDir: string): string {
	return path.join(ctxDir, "findings");
}
function findingsPath(ctxDir: string, nodeId: string): string {
	return path.join(findingsDir(ctxDir), `${nodeId}.json`);
}
function findingsLockPath(ctxDir: string, nodeId: string): string {
	return path.join(findingsDir(ctxDir), `${nodeId}.json.lock`);
}
function reportsDir(ctxDir: string): string {
	return path.join(ctxDir, "reports");
}
function reportPath(ctxDir: string, nodeId: string): string {
	return path.join(reportsDir(ctxDir), `${nodeId}.json`);
}
function pendingDir(ctxDir: string): string {
	return path.join(ctxDir, "pending");
}

/** Build the per-run ctx directory path under a runs root. */
export function ctxDirFor(runsRoot: string, runId: string): string {
	if (!validateRunId(runId)) throw new Error(`Unsafe runId for ctx dir: ${runId}`);
	return path.join(runsRoot, "ctx", runId);
}

/**
 * Ensure the ctx directory tree exists. Idempotent; safe to call repeatedly.
 * Returns the same ctxDir for chaining.
 */
export function initCtxDir(ctxDir: string): string {
	fs.mkdirSync(ctxDir, { recursive: true });
	fs.mkdirSync(findingsDir(ctxDir), { recursive: true });
	fs.mkdirSync(reportsDir(ctxDir), { recursive: true });
	fs.mkdirSync(pendingDir(ctxDir), { recursive: true });
	return ctxDir;
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

export function readTree(ctxDir: string): ContextTree {
	try {
		const raw = fs.readFileSync(treePath(ctxDir), "utf-8");
		const parsed = JSON.parse(raw) as ContextTree;
		if (parsed && Array.isArray(parsed.nodes)) return parsed;
	} catch {
		/* missing/corrupt → empty tree */
	}
	return { nodes: [] };
}

/**
 * Register (or update) a node in the tree. IDEMPOTENT — upserts by nodeId so a
 * resume that re-runs a phase does not duplicate tree entries (which would
 * double-count ancestor findings). This is the C3 resume-safety fix.
 */
export function registerNode(
	ctxDir: string,
	nodeId: string,
	phaseId: string,
	parentNodeId: string | undefined,
	status: NodeStatus = "running",
): void {
	if (!validateRunId(nodeId)) throw new Error(`Unsafe nodeId: ${nodeId}`);
	withLock(treeLockPath(ctxDir), () => {
		const tree = readTree(ctxDir);
		const now = Date.now();
		const idx = tree.nodes.findIndex((n) => n.nodeId === nodeId);
		if (idx >= 0) {
			const existing = tree.nodes[idx]!;
			tree.nodes[idx] = {
				...existing,
				phaseId,
				parentNodeId,
				status,
				updatedAt: now,
			};
		} else {
			tree.nodes.push({ nodeId, phaseId, parentNodeId, status, createdAt: now, updatedAt: now });
		}
		writeFileAtomic(treePath(ctxDir), JSON.stringify(tree, null, 2));
	});
}

export function setNodeStatus(ctxDir: string, nodeId: string, status: NodeStatus): void {
	withLock(treeLockPath(ctxDir), () => {
		const tree = readTree(ctxDir);
		const node = tree.nodes.find((n) => n.nodeId === nodeId);
		if (!node) return;
		node.status = status;
		node.updatedAt = Date.now();
		writeFileAtomic(treePath(ctxDir), JSON.stringify(tree, null, 2));
	});
}

/** Compute a node's depth (root = 0) by walking the parent chain. */
export function nodeDepth(tree: ContextTree, nodeId: string): number {
	let depth = 0;
	let current = tree.nodes.find((n) => n.nodeId === nodeId);
	const seen = new Set<string>();
	while (current?.parentNodeId && !seen.has(current.nodeId)) {
		seen.add(current.nodeId);
		depth++;
		const parentId = current.parentNodeId;
		current = tree.nodes.find((n) => n.nodeId === parentId);
	}
	return depth;
}

/** Return the ancestor chain nodeIds for a node (excluding itself), in nearest-first order (parent, grandparent, …). */
export function ancestorIds(tree: ContextTree, nodeId: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>([nodeId]);
	let current = tree.nodes.find((n) => n.nodeId === nodeId);
	while (current?.parentNodeId && !seen.has(current.parentNodeId)) {
		out.push(current.parentNodeId);
		seen.add(current.parentNodeId);
		const parentId = current.parentNodeId;
		current = tree.nodes.find((n) => n.nodeId === parentId);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Findings (the horizontal blackboard)
// ---------------------------------------------------------------------------

export function readNodeFindings(ctxDir: string, nodeId: string): FindingsMap {
	if (!validateRunId(nodeId)) return {}; // defense-in-depth: never build a path from an unsafe id
	try {
		const raw = fs.readFileSync(findingsPath(ctxDir, nodeId), "utf-8");
		const parsed = JSON.parse(raw) as FindingsMap;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
	} catch {
		/* missing/corrupt → empty */
	}
	return {};
}

/**
 * Write one finding (last-write-wins per key) into THIS node's findings file.
 * Only locks the node's own file → concurrent siblings never contend.
 * Throws on bad key / oversized value / too many keys (caller surfaces as tool error).
 */
export function writeFinding(ctxDir: string, nodeId: string, key: string, value: unknown): void {
	if (!validateRunId(nodeId)) throw new Error(`Unsafe nodeId: ${nodeId}`);
	if (!isValidKey(key)) throw new Error(`Invalid finding key '${key}' (allowed: [A-Za-z0-9._-], <=128 chars, no '..').`);
	const serialized = JSON.stringify(value ?? null);
	if (Buffer.byteLength(serialized, "utf-8") > MAX_VALUE_BYTES) {
		throw new Error(`Finding '${key}' exceeds ${MAX_VALUE_BYTES} bytes.`);
	}
	fs.mkdirSync(findingsDir(ctxDir), { recursive: true });
	withLock(findingsLockPath(ctxDir, nodeId), () => {
		const findings = readNodeFindings(ctxDir, nodeId);
		if (!(key in findings) && Object.keys(findings).length >= MAX_KEYS_PER_NODE) {
			throw new Error(`Node '${nodeId}' exceeds ${MAX_KEYS_PER_NODE} findings keys.`);
		}
		findings[key] = JSON.parse(serialized);
		writeFileAtomic(findingsPath(ctxDir, nodeId), JSON.stringify(findings, null, 2));
	});
}

/**
 * Read the findings visible to a node: its OWN findings unioned with its
 * ancestors' and all sibling/other nodes' findings that are already `done`.
 * "done" visibility prevents reading a half-written blackboard from a sibling
 * that is still running (eventual consistency: you see a sibling's findings
 * once it has reported completion). The node's own findings are always visible.
 *
 * On key conflicts: nearer scope wins (own > ancestors > completed others),
 * matching intuition that a node trusts its own/closer notes most.
 *
 * @param key  optional — return only that key's value (or undefined).
 */
export function readVisibleFindings(
	ctxDir: string,
	nodeId: string,
	key?: string,
): FindingsMap | unknown {
	if (!validateRunId(nodeId)) return key !== undefined ? undefined : {};
	const tree = readTree(ctxDir);
	const ancestors = new Set(ancestorIds(tree, nodeId));
	// Build layered maps; merge order = lowest priority first.
	const completedOthers: FindingsMap = {};
	const ancestorFindings: FindingsMap = {};
	for (const n of tree.nodes) {
		if (n.nodeId === nodeId) continue;
		const f = readNodeFindings(ctxDir, n.nodeId);
		if (ancestors.has(n.nodeId)) {
			Object.assign(ancestorFindings, f);
		} else if (n.status === "done") {
			Object.assign(completedOthers, f);
		}
	}
	const own = readNodeFindings(ctxDir, nodeId);
	const merged: FindingsMap = { ...completedOthers, ...ancestorFindings, ...own };
	if (key !== undefined) {
		if (!isValidKey(key)) return undefined;
		return merged[key];
	}
	return merged;
}

// ---------------------------------------------------------------------------
// Reports (the vertical upward channel)
// ---------------------------------------------------------------------------

export function writeReport(ctxDir: string, nodeId: string, summary: string, structured?: unknown): void {
	if (!validateRunId(nodeId)) throw new Error(`Unsafe nodeId: ${nodeId}`);
	if (Buffer.byteLength(String(summary ?? ""), "utf-8") > MAX_REPORT_BYTES) {
		throw new Error(`Report summary exceeds ${MAX_REPORT_BYTES} bytes.`);
	}
	if (structured !== undefined && Buffer.byteLength(JSON.stringify(structured ?? null), "utf-8") > MAX_STRUCTURED_BYTES) {
		throw new Error(`Report 'structured' payload exceeds ${MAX_STRUCTURED_BYTES} bytes.`);
	}
	fs.mkdirSync(reportsDir(ctxDir), { recursive: true });
	// No lock: each node owns its own report file and is a single process, so the
	// pure-overwrite writeFileAtomic is race-free here (unlike findings, which do
	// read-modify-write and therefore lock).
	const report: NodeReport = { nodeId, summary: String(summary ?? ""), structured, at: Date.now() };
	writeFileAtomic(reportPath(ctxDir, nodeId), JSON.stringify(report, null, 2));
}

export function readReport(ctxDir: string, nodeId: string): NodeReport | undefined {
	if (!validateRunId(nodeId)) return undefined;
	try {
		const raw = fs.readFileSync(reportPath(ctxDir, nodeId), "utf-8");
		const parsed = JSON.parse(raw) as NodeReport;
		if (parsed && typeof parsed.summary === "string") return parsed;
	} catch {
		/* none */
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Pending spawns (ctx_spawn intents → runtime supervision loop)
// ---------------------------------------------------------------------------

/** Queue a ctx_spawn intent. Each call writes a unique file the runtime picks up. */
export function queueSpawn(ctxDir: string, parentNodeId: string, assignments: SpawnAssignment[]): number {
	if (!validateRunId(parentNodeId)) throw new Error(`Unsafe nodeId: ${parentNodeId}`);
	if (!Array.isArray(assignments) || assignments.length === 0) {
		throw new Error("ctx_spawn requires a non-empty assignments array.");
	}
	if (assignments.length > MAX_SPAWN_ASSIGNMENTS) {
		throw new Error(`ctx_spawn limited to ${MAX_SPAWN_ASSIGNMENTS} assignments per call.`);
	}
	const clean: SpawnAssignment[] = assignments.map((a) => {
		if (!a || typeof a !== "object") {
			throw new Error("Each ctx_spawn assignment must be an object with 'task' or 'subflow'.");
		}
		const hasTask = typeof a.task === "string" && a.task.trim().length > 0;
		const hasSubflow = a.subflow !== undefined && a.subflow !== null;
		// XOR: exactly one of task / subflow. Check subflow first so a pure-subflow
		// assignment (no `task`) is never rejected by the task-required branch.
		if (hasSubflow) {
			if (hasTask) {
				throw new Error("A ctx_spawn assignment has both 'task' and 'subflow' — provide exactly one.");
			}
			const bytes = Buffer.byteLength(JSON.stringify(a.subflow), "utf-8");
			if (bytes > MAX_SUBFLOW_BYTES) {
				throw new Error(`ctx_spawn subflow exceeds ${MAX_SUBFLOW_BYTES} bytes.`);
			}
			return { subflow: a.subflow, defaultAgent: typeof a.defaultAgent === "string" ? a.defaultAgent : undefined };
		}
		if (hasTask) {
			if (Buffer.byteLength(a.task as string, "utf-8") > MAX_TASK_BYTES) {
				throw new Error(`ctx_spawn task exceeds ${MAX_TASK_BYTES} bytes.`);
			}
			return { task: a.task as string, agent: typeof a.agent === "string" ? a.agent : undefined };
		}
		throw new Error("Each ctx_spawn assignment needs exactly one of 'task' (non-empty string) or 'subflow' (object).");
	});
	fs.mkdirSync(pendingDir(ctxDir), { recursive: true });
	// Unique per call: time + crypto-random so two concurrent queueSpawn calls
	// from the same parent in the same ms cannot collide (and overwrite).
	const seq = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
	const payload: PendingSpawn = { parentNodeId, assignments: clean, at: Date.now() };
	writeFileAtomic(path.join(pendingDir(ctxDir), `${parentNodeId}-${seq}.json`), JSON.stringify(payload, null, 2));
	return clean.length;
}

/**
 * Drain (read + delete) all pending spawn intents queued by a parent node.
 * Returns the flattened assignment list. Used by the runtime supervision loop
 * after a node's subagent finishes.
 *
 * INVARIANT: only call this AFTER the parent subagent process has exited. The
 * read-then-unlink is not directory-locked, so a concurrent queueSpawn from a
 * still-running parent could be missed. The runtime drains post-exit, so no
 * concurrent writer exists.
 */
export function drainPendingSpawns(ctxDir: string, parentNodeId: string): SpawnAssignment[] {
	if (!validateRunId(parentNodeId)) return [];
	const dir = pendingDir(ctxDir);
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter((f) => f.startsWith(`${parentNodeId}-`) && f.endsWith(".json"));
	} catch {
		return [];
	}
	const out: SpawnAssignment[] = [];
	for (const f of files.sort()) {
		const full = path.join(dir, f);
		try {
			const parsed = JSON.parse(fs.readFileSync(full, "utf-8")) as PendingSpawn;
			if (parsed && Array.isArray(parsed.assignments)) out.push(...parsed.assignments);
		} catch {
			/* skip corrupt */
		}
		try {
			fs.unlinkSync(full);
		} catch {
			/* already gone */
		}
	}
	return out;
}
