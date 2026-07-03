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
import { getAgentDir } from "./paths.ts";
import type { Taskflow } from "./schema.ts";
import type { UsageStats } from "./usage.ts";
import type { DeclaredDeps } from "./flowir/meta.ts";
import type { ScorerResult } from "./scorers.ts";

export interface SavedFlow {
	name: string;
	scope: "user" | "project";
	filePath: string;
	def: Taskflow;
}

/** @internal */
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
	/** When this result was served from cache instead of executed:
	 *  'cross-run' = restored from the persistent cross-run store;
	 *  'run-only'  = within-run resume (a prior attempt with the same inputHash).
	 *  A phase with this set spent no new tokens this run. */
	cacheHit?: "cross-run" | "run-only";
	startedAt?: number;
	endedAt?: number;
	/** Live fan-out progress for map/parallel phases. */
	subProgress?: { done: number; total: number; running: number; failed: number };
	/** Latest activity line from the running subagent(s). */
	liveText?: string;
	/** Gate verdict (gate phases only). */
	gate?: {
		verdict: "pass" | "block";
		reason?: string;
		/** Deterministic scorer results (score gates only). Present whenever the
		 *  gate declared `score` and the scorers actually ran. `combined` is the
		 *  [0,1] combined score; `threshold` echoes the configured cutoff. */
		scores?: { results: ScorerResult[]; combined: number; threshold?: number };
	};
	/** True when this phase declared `idempotent: false` (irreversible side
	 *  effects). Such a phase is never cached (in any scope) and transient
	 *  provider errors are not auto-retried. De facto mutually exclusive with
	 *  `cacheHit` (caching is disabled for side-effecting phases). */
	sideEffect?: true;
	/** Total subagent attempts incl. retries (when > calls, a retry happened). */
	attempts?: number;
	/** True when the phase's `timeout` cap expired and the subagent was aborted.
	 *  The phase fails (status "failed") — this marker distinguishes a timeout
	 *  from an ordinary failure for renderers and post-hoc inspection. */
	timedOut?: boolean;
	/** True when a map/parallel fan-out was cut short by the budget cap, or by the
	 *  dynamic sub-flow fan-out safety limit (MAX_DYNAMIC_MAP_ITEMS). */
	budgetTruncated?: boolean;
	/** Human-in-the-loop outcome (approval phases only). */
	approval?: { decision: "approve" | "reject" | "edit"; note?: string; auto?: boolean };
	/** Loop iteration accounting (loop phases only). `reflexion` is the last
	 *  failure summary injected into an iteration (audit trail for reflexion loops). */
	loop?: { iterations: number; stop: "until" | "converged" | "maxIterations" | "failed" | "aborted"; reflexion?: string };
	/** Tournament outcome (tournament phases only). */
	tournament?: { variants: number; winner: number; mode: "best" | "aggregate"; reason?: string };
	/** Set when a `flow { def }` inline sub-flow definition could not be resolved,
	 *  parsed, validated, or verified. The phase fails-open: this records why. */
	defError?: string;
	/** Non-fatal diagnostic warnings accumulated during this phase (e.g.
	 *  unresolved interpolation placeholders, suspicious templates). */
	warnings?: string[];
	/** Observed readSet (M3): the upstream phase outputs this phase actually
	 *  consumed at interpolation time — not what it *declared* to depend on
	 *  (dependsOn), but what it truly *read* (`{steps.X...}`). Each entry
	 *  carries the version (= the read phase's inputHash) it consumed, so a
	 *  later staleness check (M4/M5) can tell whether the upstream has moved.
	 *  This is the overstory "observed readSet@version" moat: no other
	 *  orchestrator records what a result actually depended on. */
	reads?: Array<{ stepId: string; version?: string }>;
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
	/** OS PID of a detached runner process (set only for background runs). */
	pid?: number;
	/** True for runs spawned via `detach: true` (background execution). */
	detached?: boolean;
	/** Content fingerprint of the desugared flow definition (overstory hash
	 *  algorithm). Folded into every phase's cache key so a structural change
	 *  to the flow always invalidates cross-run cache hits — and an identical
	 *  re-run always reuses them. Filled once at run start; persisted for
	 *  audit/resume consistency. */
	flowDefHash?: string | "failed";
	/** Per-phase *declared* dependency footprint (M2), synthesized at compile
	 *  time from `{steps.X}` interpolation refs via `compileTaskflowToIR`.
	 *  This is the *declared* plane — distinct from the *observed* readSet
	 *  (`PhaseState.reads`, captured at runtime). Recompute staleness uses the
	 *  **union** (observed ∪ declared) so a declared-but-unobserved edge (e.g.
	 *  a `when` ref that never fired) still propagates. JSON-safe `Record`
	 *  shape so it round-trips through persistence. Audit/provenance only —
	 *  recompute derives this fresh from `def` so old runs (pre-H1) also get
	 *  union semantics. */
	declaredDeps?: Record<string, DeclaredDeps>;
	/** Per-phase structural sub-fingerprints (M6). Computed once per run
	 *  alongside `flowDefHash`. Each value is either a precise per-phase hash
	 *  (when sound) or the whole-flow `flowDefHash` (fallback for
	 *  shareContext / `flow` phases). Folded into the cross-run cache key as
	 *  `v3:phasefp:<subfp>` so editing phase B invalidates only B + its
	 *  transitive dependents. Audit/resume only — recompute derives fresh. */
	phaseFingerprints?: Record<string, string>;
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

// Re-exported for use in TaskflowSettings defaults (agents.ts).
export const DEFAULT_KEPT_RUNS = DEFAULT_MAX_KEPT_TERMINAL;
export const DEFAULT_RUN_AGE_DAYS = DEFAULT_MAX_AGE_DAYS;

/** Last cleanup timestamp — module-level so it persists across calls. */
let lastCleanupAt = 0;

/** Shared buffer for Atomics.wait in acquireLock busy-wait (Finding 6). */
const LOCK_WAIT_BUF = new Int32Array(new SharedArrayBuffer(4));

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
export function safeFlowDirName(flowName: string): string {
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
export function validateRunId(runId: string): boolean {
	return (
		typeof runId === "string" &&
		runId.length > 0 &&
		!runId.includes("/") &&
		!runId.includes("\\") &&
		!runId.includes("\0") &&
		!runId.includes("..")
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
			Atomics.wait(LOCK_WAIT_BUF, 0, 0, LOCK_POLL_MS);
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

	const scanned = Array.from(entries.values());
	// Persist the rebuilt index under the index lock. Re-read the current
	// index inside the lock and merge by runId so concurrent writes are not
	// clobbered — scanned entries win on conflict (Finding 5).
	withLock(indexLockPath(runsRoot), () => {
		const currentIndex = readIndex(runsRoot);
		const merged = new Map<string, RunIndexEntry>();
		for (const e of currentIndex) merged.set(e.runId, e);
		for (const e of scanned) merged.set(e.runId, e); // scanned wins
		writeIndex(runsRoot, Array.from(merged.values()));
	});
	return scanned;
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
	const cleanupStarted = Date.now();
	const now = cleanupStarted;
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
		// Filter out entries with corrupt updatedAt (non-numeric/NaN) BEFORE sorting
		// to prevent NaN from corrupting sort order. Corrupt entries cannot be
		// reliably aged, so they are always moved to toRemove.
		const cleanTerminal: RunIndexEntry[] = [];
		for (const e of terminal) {
			if (typeof e.updatedAt === "number" && !Number.isNaN(e.updatedAt)) {
				cleanTerminal.push(e);
			} else {
				toRemove.push(e);
			}
		}
		cleanTerminal.sort((a, b) => b.updatedAt - a.updatedAt);

		for (let i = 0; i < cleanTerminal.length; i++) {
			const e = cleanTerminal[i]!;
			const expiredByAge = now - e.updatedAt > maxAgeMs;
			const excessByCount = i >= maxKeep;
			if (expiredByAge || excessByCount) {
				toRemove.push(e);
			}
		}

		if (toRemove.length === 0) return;

		// Commit the pruned index while holding the lock so a concurrent
		// updateIndexEntry cannot interleave and lose entries.
		const remaining = cleanTerminal.filter((e) => !toRemove.includes(e));
		writeIndex(runsRoot, [...active, ...remaining]);
	});

	if (toRemove.length === 0) return;

	console.warn(
		`[taskflow] Cleaning up ${toRemove.length} old run(s) ` +
		`(max ${maxKeep} runs, ${maxAgeDays} day age limit). ` +
		`Configure 'taskflow.maxKeptRuns' / 'taskflow.maxRunAgeDays' in settings.json (0 = keep all).`,
	);

	// Delete run files + lock files (outside the index lock).
	for (const e of toRemove) {
		const filePath = path.join(runsRoot, e.relPath);
		// Race guard: skip files modified after cleanup started (Finding 2).
		try { if (fs.statSync(filePath).mtimeMs > cleanupStarted) continue; } catch { continue; }
		try { fs.unlinkSync(filePath); } catch { /* already gone */ }
		// Also remove any orphaned lock file.
		try { fs.unlinkSync(filePath + ".lock"); } catch { /* ignore */ }
		// Also remove the per-run Shared Context Tree directory (C6). Orphaned
		// ctx dirs would otherwise accumulate under runs/ctx/ over many runs.
		try { fs.rmSync(path.join(runsRoot, "ctx", e.runId), { recursive: true, force: true }); } catch { /* ignore */ }
		// Also remove the per-run isolated-workspace dir tree (cwd:"dedicated").
		// `dedicated` workspaces are persistent by design; reclaim them once the
		// run is pruned. The dir name uses the same sanitization as workspace.ts.
		try {
			const wsSeg = e.runId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 100) || "phase";
			fs.rmSync(path.join(runsRoot, "ws", wsSeg), { recursive: true, force: true });
		} catch { /* ignore */ }
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

let _piCreationHinted = false;

export function saveFlow(
	cwd: string,
	def: Taskflow,
	scope: "user" | "project" = "project",
): { filePath: string } {
	const dir = scope === "user" ? userFlowsDir() : (findProjectFlowsDir(cwd, true) ?? path.join(cwd, ".pi", "taskflows"));
	if (!def.name || def.name.trim().length === 0) throw new Error("Flow name must not be empty");
	fs.mkdirSync(dir, { recursive: true });
	const safe = safeFlowDirName(def.name);
	const filePath = path.join(dir, `${safe}.json`);
	const fileLockPath = filePath + ".lock";
	withLock(fileLockPath, () => { writeFileAtomic(filePath, `${JSON.stringify(def, null, 2)}\n`); });

	// One-shot: let the user know about .pi/ directory on first save (Finding 8).
	if (!_piCreationHinted) {
		_piCreationHinted = true;
		const piExisted = fs.existsSync(path.join(dir, "..", ".."));
		console.warn(
			`[taskflow] ${piExisted ? "Using" : "Created"} .pi/taskflows/ for project-scoped flow storage. ` +
			`Add .pi/ to .gitignore if desired.`,
		);
	}

	return { filePath };
}


// --- Run state ---

export function runsDir(cwd: string): string {
	// Safe non-null assertion: create=true guarantees a non-null return because
	// findProjectFlowsDirInternal falls back to path.join(cwd, ".pi", "taskflows").
	const projDir = findProjectFlowsDir(cwd, true)!;
	return path.join(projDir, "runs");
}

/** Root dir for the cross-run memoization cache (sibling of `runs`). */
export function cacheDir(cwd: string): string {
	const projDir = findProjectFlowsDir(cwd, true)!;
	return path.join(projDir, "cache");
}

export function newRunId(flowName: string): string {
	// Collapse to a safe charset AND fold any dot-runs so the result can never
	// contain a '..' traversal token (validateRunId rejects '..').
	const safe = flowName.replace(/[^\w.-]+/g, "_").replace(/\.{2,}/g, "_").slice(0, 24);
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
export function saveRun(state: RunState, cleanup?: { maxKeep?: number; maxAgeDays?: number }): void {
	// Reject unsafe runIds before any filesystem access (Finding 1).
	if (!validateRunId(state.runId)) return;

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
	const maxKeep = cleanup?.maxKeep ?? DEFAULT_MAX_KEPT_TERMINAL;
	const maxAgeDays = cleanup?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
	if (maxKeep > 0 || maxAgeDays > 0) {
		cleanupTerminalRuns(root, maxKeep, maxAgeDays);
	}
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
	// Filter out entries with non-numeric/NaN updatedAt BEFORE sorting to
	// prevent NaN from corrupting V8's sort order (which can displace valid
	// entries when a limit is applied).
	const valid = entries.filter((e) => typeof e.updatedAt === "number" && !Number.isNaN(e.updatedAt));
	valid.sort((a, b) => b.updatedAt - a.updatedAt);
	const sliced = valid.slice(0, limit);

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
 * Check whether a process with the given PID is still alive.
 * Uses signal 0 (no signal sent) — succeeds if the process exists and we have
 * permission to signal it, throws ESRCH if it doesn't exist.
 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
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
