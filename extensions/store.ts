/**
 * Persistence for taskflow definitions and run state.
 *
 *   Definitions:  .pi/taskflows/<name>.json          (project)
 *                 ~/.pi/agent/taskflows/<name>.json   (user)
 *   Run state:    .pi/taskflows/runs/<sanitizedFlowName>/<runId>.json
 *   Index:        .pi/taskflows/runs/index.json       (lookup accelerator)
 *
 *   Legacy layout (v0.0.8 and earlier):
 *     .pi/taskflows/runs/<runId>.json                 (flat, still readable)
 *
 *   v0.0.9 refactor: per-flow subdirectory layout + lightweight index + file
 *   lock + TTL/cap cleanup. Full backward compatibility with the flat layout
 *   is maintained: loadRun and listRuns still discover legacy flat files.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Taskflow } from "./schema.ts";
import type { UsageStats } from "./usage.ts";

export interface SavedFlow {
	name: string;
	scope: "user" | "project";
	filePath: string;
	def: Taskflow;
}

export type PhaseStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface PhaseState {
	id: string;
	status: PhaseStatus;
	output?: string;
	json?: unknown;
	usage?: UsageStats;
	model?: string;
	error?: string;
	inputHash?: string;
	/** When this result was served from cache: 'cross-run' for the persistent
	 *  cross-run store. (Within-run resume reuses prior state verbatim and is not
	 *  flagged here.) */
	cacheHit?: "cross-run";
	startedAt?: number;
	endedAt?: number;
	/** Live fan-out progress for map/parallel phases. */
	subProgress?: { done: number; total: number; running: number; failed: number };
	/** Latest activity line from the running subagent(s). */
	liveText?: string;
	/** Gate verdict (gate phases only). */
	gate?: { verdict: "pass" | "block"; reason?: string };
	/** Total subagent attempts incl. retries (when > calls, a retry happened). */
	attempts?: number;
	/** True when a map/parallel fan-out was cut short by the budget cap. */
	budgetTruncated?: boolean;
	/** Human-in-the-loop outcome (approval phases only). */
	approval?: { decision: "approve" | "reject" | "edit"; note?: string; auto?: boolean };
	/** Non-fatal diagnostic warnings accumulated during this phase (e.g.
	 *  unresolved interpolation placeholders, suspicious templates). */
	warnings?: string[];
	/** Truncated previews of interpolated strings used to execute this phase,
	 *  useful when diagnosing why a model saw a literal placeholder. */
	interpolation?: Array<{ source: string; text: string; missing?: string[] }>;
}

export interface RunState {
	runId: string;
	flowName: string;
	def: Taskflow;
	args: Record<string, unknown>;
	status: "running" | "completed" | "failed" | "paused" | "blocked";
	phases: Record<string, PhaseState>;
	createdAt: number;
	updatedAt: number;
	cwd: string;
}

// ---------------------------------------------------------------------------
// Index entry — lightweight lookup record persisted in runs/index.json.
// Enables listRuns to find files without a full directory scan.  Every
// non-terminal run and every terminal run within the retention window has an
// index entry; missing/stale entries are tolerated via degradation (rebuild).
// ---------------------------------------------------------------------------

export interface RunIndexEntry {
	runId: string;
	flowName: string;
	status: RunState["status"];
	createdAt: number;
	updatedAt: number;
	/** Path relative to runsRoot, e.g. "test-flow/test-roundtrip-001.json". */
	relPath: string;
}

// ---------------------------------------------------------------------------
// File-lock constants
// ---------------------------------------------------------------------------

/** Lock file considered stale after 30 s (orphaned from crash / kill -9). */
const LOCK_STALE_MS = 30_000;
/** Lock acquisition busy-wait interval. */
const LOCK_POLL_MS = 50;
/** Default acquisition timeout before throwing. */
const LOCK_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Cleanup throttle
// ---------------------------------------------------------------------------

/** Minimum ms between opportunistic cleanup runs (called inside saveRun). */
const CLEANUP_INTERVAL_MS = 60_000;
/** Retain at most this many terminal runs by default. */
const DEFAULT_MAX_KEPT_TERMINAL = 100;
/** Remove terminal runs older than this (days). */
const DEFAULT_MAX_AGE_DAYS = 30;

/** Last cleanup timestamp — module-level so it persists across calls. */
let lastCleanupAt = 0;

// ---------------------------------------------------------------------------
// Internal helpers — path construction & sanitisation
// ---------------------------------------------------------------------------

/**
 * Sanitise a flow name into a safe directory name. Same regex used by
 * saveFlow/newRunId — but that regex keeps `.` in its allow-list, so a
 * flowName of "." or ".." would pass through unchanged and let `flowRunDir`
 * resolve OUTSIDE the runs root (write-side path traversal). `def.name` is
 * internally derived and TypeBox only enforces Type.String() with no charset,
 * so a Taskflow literally named ".." is schema-valid. We therefore reject
 * bare-dot / leading-dot components after the character substitution so the
 * write path can never escape runs/ (risk-reviewer v0.0.9 audit, H1).
 */
function safeFlowDirName(flowName: string): string {
	let safe = flowName.replace(/[^\w.-]+/g, "_");
	// Collapse leading dots: blocks ".", "..", and hidden-dir names like ".git".
	safe = safe.replace(/^\.+/, "_");
	return safe || "_";
}

/** Return the per-flow run directory: runs/<sanitisedFlowName>. */
function flowRunDir(runsRoot: string, flowName: string): string {
	return path.join(runsRoot, safeFlowDirName(flowName));
}

/** Return the full path for a run file in the new subdirectory layout. */
function runFilePath(runsRoot: string, flowName: string, runId: string): string {
	return path.join(flowRunDir(runsRoot, flowName), `${runId}.json`);
}

/** Return the path to the run index file. */
function indexPath(runsRoot: string): string {
	return path.join(runsRoot, "index.json");
}

/** Return the lock-file path guarding all index.json read-modify-write cycles. */
function indexLockPath(runsRoot: string): string {
	return path.join(runsRoot, "index.json.lock");
}

/** Return the lock-file path for a given runId (placed next to the run file). */
function lockPathForRun(runsRoot: string, flowName: string, runId: string): string {
	return path.join(flowRunDir(runsRoot, flowName), `${runId}.json.lock`);
}

/**
 * Validate that a runId looks safe before performing any filesystem access.
 * Legitimate runIds are produced by newRunId() and contain only [A-Za-z0-9._-].
 */
function validateRunId(runId: string): boolean {
	return (
		typeof runId === "string" &&
		runId.length > 0 &&
		!runId.includes("/") &&
		!runId.includes("\\") &&
		!runId.includes("\0")
	);
}

// ---------------------------------------------------------------------------
// File-lock primitives — zero-dependency, using O_CREAT|O_EXCL (atomic)
// ---------------------------------------------------------------------------

/**
 * Acquire a file lock by atomically creating a lock file.
 *
 * Uses O_CREAT|O_EXCL (`wx` flag) which is atomic on POSIX and NTFS.
 * Stale locks (> LOCK_STALE_MS) are stolen via an atomic rename rather than a
 * naive unlink-then-create: a plain `unlinkSync` + `openSync('wx')` has a
 * TOCTOU window where two processes both unlink the same stale lock and both
 * then create a fresh one, yielding two simultaneous holders (risk-reviewer
 * v0.0.9 audit, L1). `rename` is atomic and removes the *specific* inode the
 * caller observed: only one racing process can win the rename of that exact
 * stale file, so at most one process proceeds to re-create the lock.
 * Throws on timeout.
 */
function acquireLock(lockPath: string, timeoutMs: number = LOCK_TIMEOUT_MS): void {
	const start = Date.now();
	// Ensure parent directory exists (lock file lives inside the flow subdir).
	const dir = path.dirname(lockPath);
	fs.mkdirSync(dir, { recursive: true });

	while (true) {
		try {
			const fd = fs.openSync(lockPath, "wx");
			fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
			fs.closeSync(fd);
			return; // lock acquired
		} catch (e: unknown) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			// Lock file exists — check if stale.
			try {
				const stat = fs.statSync(lockPath);
				if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
					// Stale lock — steal it via atomic rename so only one racing
					// stealer can win (L1). The "graveyard" name is unique per
					// process+attempt; the winner unlinks it, losers see ENOENT
					// on their own rename and simply retry the acquire loop.
					const grave = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
					try {
						fs.renameSync(lockPath, grave);
						// We won the steal — discard the graveyard copy and retry
						// the loop, where openSync('wx') will create a fresh lock.
						try { fs.unlinkSync(grave); } catch { /* ignore */ }
					} catch { /* lost the steal race (ENOENT) — just retry */ }
					continue;
				}
			} catch {
				// ENOENT: another process released it between openSync and statSync — retry.
				continue;
			}
			// Lock is held and not stale — wait and retry.
			if (Date.now() - start > timeoutMs) {
				throw new Error(`Lock timeout after ${timeoutMs}ms waiting for ${path.basename(lockPath)}`);
			}
			// Busy-wait with Atomics.wait (CPU-efficient sleep).
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
		}
	}
}

/**
 * Release a file lock by deleting the lock file.  Ignores ENOENT (already
 * released by another process or stolen due to staleness).
 */
function releaseLock(lockPath: string): void {
	try { fs.unlinkSync(lockPath); } catch { /* ENOENT or other — ignore */ }
}

/**
 * Execute `fn` while holding a file lock.  Guarantees release even on throw.
 */
export function withLock<T>(lockPath: string, fn: () => T): T {
	acquireLock(lockPath);
	try {
		return fn();
	} finally {
		releaseLock(lockPath);
	}
}

// ---------------------------------------------------------------------------
// Index CRUD
// ---------------------------------------------------------------------------

/**
 * Extract a RunIndexEntry from a RunState + computed relative path.
 */
function extractIndexEntry(state: RunState, relPath: string): RunIndexEntry {
	return {
		runId: state.runId,
		flowName: state.flowName,
		status: state.status,
		createdAt: state.createdAt,
		updatedAt: state.updatedAt,
		relPath,
	};
}

/** Read the index file; return [] on any error (missing, corrupt, etc.). */
function readIndex(runsRoot: string): RunIndexEntry[] {
	try {
		const raw = fs.readFileSync(indexPath(runsRoot), "utf-8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		// Validate each entry minimally.
		return (parsed as RunIndexEntry[]).filter(
			(e) => e && typeof e.runId === "string" && typeof e.relPath === "string",
		);
	} catch {
		return [];
	}
}

/** Write the full index atomically. */
function writeIndex(runsRoot: string, entries: RunIndexEntry[]): void {
	writeFileAtomic(indexPath(runsRoot), JSON.stringify(entries, null, 2));
}

/** Upsert a single entry by runId (read → mutate → write). */
/**
 * Upsert a single entry by runId (read → mutate → write).
 *
 * Guarded by a dedicated index lock so concurrent saveRun calls for *different*
 * runIds (each holding only its own per-run lock) cannot interleave their
 * read-modify-write of the shared index and lose each other's entries
 * (risk-reviewer v0.0.9 audit, M1). The per-run lock protects the run file;
 * this index lock protects the shared index.
 */
function updateIndexEntry(runsRoot: string, entry: RunIndexEntry): void {
	withLock(indexLockPath(runsRoot), () => {
		const entries = readIndex(runsRoot);
		const idx = entries.findIndex((e) => e.runId === entry.runId);
		if (idx >= 0) {
			entries[idx] = entry;
		} else {
			entries.push(entry);
		}
		writeIndex(runsRoot, entries);
	});
}

// Note: removeIndexEntry is available but not currently called; cleanupTerminalRuns
// rewrites the full index instead. Kept as a comment for future use.

/**
 * Scan all subdirectories + legacy flat files and rebuild the full index.
 * Called when the index is missing or corrupt (self-healing).
 *
 * Deduplicates by runId: subdirectory entry wins over flat.
 */
function rebuildIndex(runsRoot: string): RunIndexEntry[] {
	const entries = new Map<string, RunIndexEntry>();

	let dirs: string[];
	try {
		dirs = fs.readdirSync(runsRoot, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
	} catch {
		dirs = [];
	}

	// Scan per-flow subdirectories.
	for (const dirName of dirs) {
		const dirPath = path.join(runsRoot, dirName);
		let files: string[];
		try {
			files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".json") && !f.includes(".lock"));
		} catch { continue; }

		for (const file of files) {
			try {
				const raw = fs.readFileSync(path.join(dirPath, file), "utf-8");
				const state = JSON.parse(raw) as RunState;
				if (state && typeof state.runId === "string") {
					entries.set(state.runId, extractIndexEntry(state, `${dirName}/${file}`));
				}
			} catch { /* skip corrupt */ }
		}
	}

	// Scan legacy flat files (runs/*.json, skip index.json).
	let flatFiles: string[];
	try {
		flatFiles = fs.readdirSync(runsRoot).filter(
			(f) => f.endsWith(".json") && f !== "index.json" && !f.includes(".lock"),
		);
	} catch {
		flatFiles = [];
	}

	for (const file of flatFiles) {
		if (entries.has(file.replace(/\.json$/, ""))) continue; // prefer subdir entry
		try {
			const raw = fs.readFileSync(path.join(runsRoot, file), "utf-8");
			const state = JSON.parse(raw) as RunState;
			if (state && typeof state.runId === "string" && !entries.has(state.runId)) {
				entries.set(state.runId, extractIndexEntry(state, file));
			}
		} catch { /* skip corrupt */ }
	}

	const result = Array.from(entries.values());
	// Persist the rebuilt index under the index lock so it does not race a
	// concurrent updateIndexEntry / cleanup write (M1).
	withLock(indexLockPath(runsRoot), () => writeIndex(runsRoot, result));
	return result;
}

// ---------------------------------------------------------------------------
// TTL / cap cleanup
// ---------------------------------------------------------------------------

/**
 * Remove excess and expired terminal (completed/failed) runs.
 *
 * Called opportunistically at the end of saveRun.  Throttled to at most once
 * per CLEANUP_INTERVAL_MS.  Active runs (running/paused/blocked) are never
 * touched.
 *
 * The index read-modify-write is performed under the index lock so it cannot
 * race a concurrent updateIndexEntry and clobber a freshly-added entry (M1).
 * We re-read the index *inside* the lock (rather than trusting a snapshot read
 * before locking) so the rewrite reflects the latest committed state. File and
 * directory unlinks happen after the lock is released to keep the critical
 * section short; deleting a file that is no longer in the index is harmless.
 */
function cleanupTerminalRuns(
	runsRoot: string,
	maxKeep: number = DEFAULT_MAX_KEPT_TERMINAL,
	maxAgeDays: number = DEFAULT_MAX_AGE_DAYS,
): void {
	const now = Date.now();
	if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
	lastCleanupAt = now;

	const maxAgeMs = maxAgeDays * 86_400_000;
	let toRemove: RunIndexEntry[] = [];

	withLock(indexLockPath(runsRoot), () => {
		const entries = readIndex(runsRoot);
		const terminal: RunIndexEntry[] = [];
		const active: RunIndexEntry[] = [];

		for (const e of entries) {
			if (e.status === "completed" || e.status === "failed") {
				terminal.push(e);
			} else {
				active.push(e);
			}
		}

		// Sort terminal by updatedAt desc (newest first).
		terminal.sort((a, b) => b.updatedAt - a.updatedAt);

		for (let i = 0; i < terminal.length; i++) {
			const e = terminal[i]!;
			const expiredByAge = now - e.updatedAt > maxAgeMs;
			const excessByCount = i >= maxKeep;
			if (expiredByAge || excessByCount) {
				toRemove.push(e);
			}
		}

		if (toRemove.length === 0) return;

		// Commit the pruned index while holding the lock so a concurrent
		// updateIndexEntry cannot interleave and lose entries.
		const remaining = terminal.filter((e) => !toRemove.includes(e));
		writeIndex(runsRoot, [...active, ...remaining]);
	});

	if (toRemove.length === 0) return;

	// Delete run files + lock files (outside the index lock).
	for (const e of toRemove) {
		const filePath = path.join(runsRoot, e.relPath);
		try { fs.unlinkSync(filePath); } catch { /* already gone */ }
		// Also remove any orphaned lock file.
		try { fs.unlinkSync(filePath + ".lock"); } catch { /* ignore */ }
	}

	// Remove empty flow subdirectories.
	for (const e of toRemove) {
		const dirPath = path.dirname(path.join(runsRoot, e.relPath));
		try { fs.rmdirSync(dirPath); } catch { /* ENOTEMPTY or ENOENT — ignore */ }
	}
}

// ---------------------------------------------------------------------------
// Original helpers (unchanged)
// ---------------------------------------------------------------------------

function userFlowsDir(): string {
	return path.join(getAgentDir(), "taskflows");
}

function findProjectFlowsDirInternal(cwd: string, create = false): string | null {
	// Prefer an existing .pi dir up the tree; else use cwd/.pi when creating.
	// **Never treat `~/.pi/` as a project flow dir** — the home directory is
	// the user-scope boundary, and the user's `~/.pi/` is the agent dir, not a
	// project. We skip the home entry entirely during the walk-up, so even a
	// deeply nested cwd under home will return null (create=false) when no
	// project `.pi` exists on the path.
	const home = os.homedir();
	let dir = cwd;
	while (true) {
		if (dir !== home) {
			const candidate = path.join(dir, ".pi");
			if (fs.existsSync(candidate)) return path.join(candidate, "taskflows");
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return create ? path.join(cwd, ".pi", "taskflows") : null;
}

function readFlowFile(filePath: string, scope: "user" | "project"): SavedFlow | null {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const def = JSON.parse(raw) as Taskflow;
		if (!def?.name) return null;
		return { name: def.name, scope, filePath, def };
	} catch {
		return null;
	}
}

/** List all saved flows (project overrides user on name collision). */
/** Internal-but-exported for tests: walk-up `.pi` finder with home-dir stop. */
export function findProjectFlowsDir(cwd: string, create = false): string | null {
	return findProjectFlowsDirInternal(cwd, create);
}

export function listFlows(cwd: string): SavedFlow[] {
	const map = new Map<string, SavedFlow>();
	const dirs: Array<{ dir: string; scope: "user" | "project" }> = [{ dir: userFlowsDir(), scope: "user" }];
	const projDir = findProjectFlowsDir(cwd);
	if (projDir) dirs.push({ dir: projDir, scope: "project" });

	for (const { dir, scope } of dirs) {
		if (!fs.existsSync(dir)) continue;
		let entries: string[];
		try {
			entries = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (!name.endsWith(".json")) continue;
			const flow = readFlowFile(path.join(dir, name), scope);
			if (flow) map.set(flow.name, flow); // project after user → overrides
		}
	}
	return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getFlow(cwd: string, name: string): SavedFlow | null {
	return listFlows(cwd).find((f) => f.name === name) ?? null;
}

export function saveFlow(
	cwd: string,
	def: Taskflow,
	scope: "user" | "project" = "project",
): { filePath: string } {
	const dir = scope === "user" ? userFlowsDir() : (findProjectFlowsDir(cwd, true) ?? path.join(cwd, ".pi", "taskflows"));
	fs.mkdirSync(dir, { recursive: true });
	const safe = def.name.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `${safe}.json`);
	writeFileAtomic(filePath, `${JSON.stringify(def, null, 2)}\n`);
	return { filePath };
}

// --- Run state ---

function runsDir(cwd: string): string {
	const projDir = findProjectFlowsDir(cwd, true)!;
	return path.join(projDir, "runs");
}

/** Root dir for the cross-run memoization cache (sibling of `runs`). */
export function cacheDir(cwd: string): string {
	const projDir = findProjectFlowsDir(cwd, true)!;
	return path.join(projDir, "cache");
}

export function newRunId(flowName: string): string {
	const safe = flowName.replace(/[^\w.-]+/g, "_").slice(0, 24);
	return `${safe}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * Persist a run state to disk.
 *
 * v0.0.9: writes to `runs/<sanitisedFlowName>/<runId>.json` (per-flow
 * subdirectory) and updates the lightweight index.  Uses a per-run file lock
 * to prevent concurrent writes to the same runId.  After the write, runs
 * opportunistic cleanup of expired terminal runs.
 *
 * F-009: shallow-clones state before stamping updatedAt to avoid mutating the
 * caller's reference.
 */
export function saveRun(state: RunState): void {
	const root = runsDir(state.cwd);
	const flowDir = flowRunDir(root, state.flowName);
	fs.mkdirSync(flowDir, { recursive: true });

	// Clone before stamping updatedAt so the caller's RunState reference is not
	// mutated as a hidden side effect (v0.0.6 audit, F-009). Shallow clone is
	// sufficient: saveRun only serializes; it does not mutate nested objects.
	const toSave = { ...state, updatedAt: Date.now() };
	const filePath = runFilePath(root, state.flowName, state.runId);
	const lockPath = lockPathForRun(root, state.flowName, state.runId);

	withLock(lockPath, () => {
		writeFileAtomic(filePath, JSON.stringify(toSave, null, 2));
		updateIndexEntry(root, extractIndexEntry(toSave, path.basename(flowDir) + "/" + path.basename(filePath)));
	});

	// Opportunistic cleanup — throttled to once per CLEANUP_INTERVAL_MS.
	cleanupTerminalRuns(root);
}

/**
 * Load a single run by runId.
 *
 * Lookup chain (fast → slow):
 *   1. INDEX — read index.json, find entry with matching runId, read via relPath.
 *   2. SUBDIR SCAN — for each subdirectory in runsDir, check <subdir>/<runId>.json.
 *   3. FLAT FALLBACK — check runsDir/<runId>.json directly (legacy layout).
 *
 * All existing path-traversal, symlink, and realpath guards are preserved for
 * every path touched.
 */
export function loadRun(cwd: string, runId: string): RunState | null {
	if (!validateRunId(runId)) return null;

	const root = runsDir(cwd);

	// ---- Try index first ----
	const indexEntries = readIndex(root);
	const entry = indexEntries.find((e) => e.runId === runId);
	if (entry) {
		const filePath = path.join(root, entry.relPath);
		const state = tryReadRunFile(root, filePath);
		if (state) return state;
		// Index entry exists but file is gone or corrupt — fall through.
	}

	// ---- Try subdirectory scan ----
	let dirs: string[];
	try {
		dirs = fs.readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
	} catch { dirs = []; }

	for (const dirName of dirs) {
		const filePath = path.join(root, dirName, `${runId}.json`);
		const state = tryReadRunFile(root, filePath);
		if (state) return state;
	}

	// ---- Try legacy flat fallback ----
	const flatPath = path.join(root, `${runId}.json`);
	const state = tryReadRunFile(root, flatPath);
	if (state) return state;

	return null;
}

/**
 * Safely read a run file, performing all path-traversal / symlink guards.
 * Returns null on any violation or read error.
 */
function tryReadRunFile(runsRoot: string, filePath: string): RunState | null {
	// Lexical traversal guard.
	const rel = path.relative(runsRoot, filePath);
	if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;

	// Resolve symlinks on both runsRoot and the file so the containment check
	// uses consistent physical paths (macOS /var → /private/var etc.).
	let realDir: string;
	let realFilePath: string;
	try {
		realDir = fs.realpathSync(runsRoot);
		realFilePath = fs.realpathSync(filePath);
	} catch { return null; }

	const realRel = path.relative(realDir, realFilePath);
	if (realRel === ".." || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) return null;

	try {
		const raw = fs.readFileSync(realFilePath, "utf-8");
		return JSON.parse(raw) as RunState;
	} catch { return null; }
}

/**
 * List recent runs, sorted by updatedAt descending.
 *
 * v0.0.9: reads from index first, then merges any legacy flat files not yet in
 * the index.  If the index is missing/corrupt, calls rebuildIndex for
 * self-healing.
 *
 * F-010: drops records with non-numeric/NaN updatedAt before sorting.
 */
export function listRuns(cwd: string, limit = 20): RunState[] {
	const root = runsDir(cwd);
	if (!fs.existsSync(root)) return [];

	// Index-first path.
	let entries = readIndex(root);
	if (entries.length === 0) {
		// Index missing or corrupt — rebuild from filesystem.
		entries = rebuildIndex(root);
	}

	// Collect runIds from index for deduplication.
	const indexRunIds = new Set(entries.map((e) => e.runId));

	// Merge legacy flat files not yet in the index.
	let flatFiles: string[];
	try {
		flatFiles = fs.readdirSync(root).filter(
			(f) => f.endsWith(".json") && f !== "index.json" && !f.includes(".lock"),
		);
	} catch { flatFiles = []; }

	for (const file of flatFiles) {
		const runIdFromName = file.replace(/\.json$/, "");
		if (indexRunIds.has(runIdFromName)) continue;
		try {
			const raw = fs.readFileSync(path.join(root, file), "utf-8");
			const state = JSON.parse(raw) as RunState;
			if (state && typeof state.runId === "string" && !indexRunIds.has(state.runId)) {
				entries.push(extractIndexEntry(state, file));
				indexRunIds.add(state.runId);
			}
		} catch { /* skip corrupt */ }
	}

	// Sort by updatedAt desc, slice to limit.
	entries.sort((a, b) => b.updatedAt - a.updatedAt);
	const sliced = entries.slice(0, limit);

	// Read full RunState for each entry.
	const runs: RunState[] = [];
	for (const e of sliced) {
		try {
			const raw = fs.readFileSync(path.join(root, e.relPath), "utf-8");
			runs.push(JSON.parse(raw) as RunState);
		} catch { /* file may have been deleted since index was built — skip */ }
	}

	// F-010: filter out records with non-numeric/NaN updatedAt.
	return runs.filter((r) => typeof r.updatedAt === "number" && !Number.isNaN(r.updatedAt));
}

/** Stable hash of a phase's resolved task + inputs, for resume caching. */
export function hashInput(...parts: string[]): string {
	return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

/**
 * Write a file atomically: write to a unique temp file in the same directory,
 * then rename over the target (rename is atomic on the same filesystem). Prevents
 * a crash or concurrent write from leaving a half-written, corrupt JSON file.
 */
export function writeFileAtomic(filePath: string, data: string): void {
	// Ensure parent directory exists.
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(tmp, data, "utf-8");
		fs.renameSync(tmp, filePath);
	} catch (e) {
		try {
			if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
		} catch {
			/* ignore cleanup failure */
		}
		throw e;
	}
}
