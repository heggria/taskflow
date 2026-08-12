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
import { parseJsonc } from "./jsonc.ts";
import { getAgentDir } from "./paths.ts";
import { parseStrict } from "./interpolate.ts";
import type { Taskflow } from "./schema.ts";
import { directoryIdentity, type DirectoryIdentity } from "./cwd-bridge.ts";
import type { UsageStats } from "./usage.ts";
import type { DeclaredDeps } from "./flowir/meta.ts";
import type { ScorerResult } from "./scorers.ts";
import type { FlowMeta } from "./library/types.ts";

export interface SavedFlow {
	name: string;
	scope: "user" | "project";
	/** Canonical physical definition path captured by the stable loader. */
	filePath: string;
	/** Identity of the canonical definition directory at load time. */
	sourceDirIdentity: DirectoryIdentity;
	def: Taskflow;
}

/**
 * Outcome of loading a user-authored file from disk. Failure is discriminated
 * by `reason` so callers can tell the user *why* it failed (and where):
 *
 * - `missing`    — the file does not exist / is unreadable.
 * - `unparseable`— the file exists but failed to parse; `detail` carries the
 *                  underlying error (e.g. a V8 `SyntaxError` with byte offset
 *                  + line/column), so flow authors can fix it in seconds.
 *
 * This replaces the old `T | null` contract that collapsed both cases into
 * `null` and produced messages like "not found or unparseable" — which hid the
 * real cause and the exact position of a malformed token.
 */
export type LoadResult<T> =
	| { ok: true; value: T }
	| { ok: false; reason: "missing" | "unparseable"; path: string; detail: string };

/** Build a single-line, user-facing message from a failed `LoadResult`. */
export function describeLoadFailure(
	r: Extract<LoadResult<unknown>, { ok: false }>,
	what: string,
): string {
	return r.reason === "missing"
		? `${what} not found: ${r.path}`
		: `${what} could not be parsed — ${r.detail} (${r.path})`;
}

/** Read+parse a user-authored file, distinguishing missing from malformed. */
function loadFile<T>(filePath: string, parse: (raw: string) => T): LoadResult<T> {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (e) {
		return { ok: false, reason: "missing", path: filePath, detail: errMessage(e) };
	}
	try {
		return { ok: true, value: parse(raw) };
	} catch (e) {
		return { ok: false, reason: "unparseable", path: filePath, detail: errMessage(e) };
	}
}

function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** @internal */
export type PhaseStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface PhaseState {
	id: string;
	status: PhaseStatus;
	/** Persisted execution policy for dynamically promoted phases. Parent-level
	 *  terminal accounting cannot look these ids up in the original definition. */
	optional?: boolean;
	output?: string;
	/** True only when a failed phase's output contains a genuine partial answer
	 *  rather than a transport diagnostic/placeholder. */
	partialOutput?: true;
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
	 *  failure summary injected into an iteration (audit trail for reflexion loops).
	 *  `failures` records each failed iteration's (sanitized) error — useful when a
	 *  reflexion loop continues past failures and only the terminal one would
	 *  otherwise survive in `error`. Bounded (most-recent kept). */
	loop?: { iterations: number; stop: "until" | "converged" | "maxIterations" | "failed" | "aborted"; reflexion?: string; failures?: Array<{ iteration: number; error: string }> };
	/** Tournament outcome (tournament phases only). */
	tournament?: { variants: number; winner: number; mode: "best" | "aggregate"; reason?: string };
	/** Set when a `flow { def }` inline sub-flow definition could not be resolved,
	 *  parsed, validated, or verified. The phase fails-open: this records why. */
	defError?: string;
	/** Child states promoted by an expand:graft phase. Retained on the expand
	 *  result so a within-run resume cache hit can restore the same parent DAG. */
	promotedPhases?: Record<string, PhaseState>;
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
	/** Prompt-size diagnostics for this phase's subagent call(s). Durable
	 *  (persisted) so post-hoc inspection can surface oversized prompts and
	 *  account for input size in reduce rounds. `calls` has one entry per
	 *  resolved subagent prompt (one for an agent phase; multiple for a tree
	 *  reduce). `reduceInputs` carries aggregate stats over the inputs being
	 *  reduced (reduce phases only). The token estimate is a conservative
	 *  `ceil(chars/4)` approximation, NOT a real tokenizer count. */
	promptStats?: {
		calls: Array<{ bytes: number; chars: number; estTokens: number }>;
		reduceInputs?: { count: number; totalBytes: number; totalChars: number; totalEstTokens: number };
	};
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
	/** Canonical source file for a saved flow or defineFile invocation. Runtime
	 * provenance only: inline definitions omit it, and flow data cannot set it. */
	flowSourceFile?: string;
	/** Physical identity of `dirname(flowSourceFile)` captured atomically with the
	 * definition. Revalidated immediately before a flow-relative script spawn. */
	flowSourceDirIdentity?: DirectoryIdentity;
	/** Root identity captured by a host when it creates the run. This closes the
	 * detached launch window, but does not itself grant/taint cwd-bridge use. */
	invocationRootSnapshot?: DirectoryIdentity;
	/** Immutable root binding set only after this run actually activates the cwd
	 * bridge. Its presence is the persisted authority/taint marker. */
	cwdRootBinding?: DirectoryIdentity;
	/** OS PID of a detached runner process (set only for background runs). */
	pid?: number;
	/** True for runs spawned via `detach: true` (background execution). */
	detached?: boolean;
	/** Wall-clock launch time for detached lifecycle/orphan diagnostics. */
	detachedStartedAt?: number;
	/** Version of the durable detached-control protocol understood by the
	 * worker. Missing means a legacy detached run that cannot safely accept
	 * cross-request lifecycle commands. */
	detachedControlVersion?: number;
	/** Unforgeable identity for one detached worker instance. Unlike a PID, this
	 * value cannot be silently reused by an unrelated OS process. */
	detachedInstanceId?: string;
	/** Retention policy frozen at detached dispatch so crash/orphan writes do
	 * not silently fall back to another session's defaults. */
	detachedRetention?: { maxKeep: number; maxAgeDays: number };
	/** Durable audit record for the cancellation request that paused this run. */
	detachedCancel?: { requestedAt: number; reason?: string };
	/** Final output persisted by a detached runner for later wait/status calls. */
	finalOutput?: string;
	/** Phase whose output supplied `finalOutput`, when attributable. */
	outputSourcePhaseId?: string;
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
	// ---- Build/host identity (0.2.0 dogfood issue 4) ----
	/** Package version of the engine that created/wrote this run (best-effort
	 *  audit). Absent on pre-0.2.0-metadata runs. */
	packageVersion?: string;
	/** Git commit the engine dist was built from (`"unknown"` in source/dev
	 *  checkouts). Audit only; never used to gate behavior. */
	gitCommit?: string;
	/** Which host wrote this run: `"pi"` for the Pi adapter, or the MCP host
	 *  identity (`"codex"`/`"claude"`/`"opencode"`/`"grok"`) for MCP runs. */
	host?: string;
	/** Run-state schema version (see CURRENT_RUN_STATE_SCHEMA_VERSION). Absent
	 *  on pre-0.2.0-metadata runs (treated as the baseline). */
	schemaVersion?: number;
	/** When this run is a resume fork (0.2.0 dogfood issue 5): the runId of the
	 *  parent run this one forked from. Absent for ordinary runs. */
	parentRunId?: string;
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
	/** Invocation cwd used to bind user-private detached lifecycle records.
	 * Absent on historical indexes; callers must retain a safe fallback. */
	cwd?: string;
	status: RunState["status"];
	createdAt: number;
	updatedAt: number;
	/** Path relative to runsRoot, e.g. "test-flow/test-roundtrip-001.json". */
	relPath: string;
	/** Which host wrote this run (0.2.0 dogfood issue 4): "pi" or the MCP
	 *  host identity. Absent on pre-0.2.0-metadata runs. */
	host?: string;
	/** Package version of the engine that wrote this run (audit). Absent on
	 *  pre-0.2.0-metadata runs. */
	packageVersion?: string;
	/** Parent runId when this run is a resume fork (issue 5). Absent for
	 *  ordinary runs. */
	parentRunId?: string;
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
/** Retention is opportunistic: never stall a foreground save behind cleanup. */
const CLEANUP_LOCK_TIMEOUT_MS = 250;

// ---------------------------------------------------------------------------
// Cleanup throttle
// ---------------------------------------------------------------------------

/** Minimum ms between opportunistic cleanup runs (called inside saveRun). */
const CLEANUP_INTERVAL_MS = 60_000;
/** Bound the project-keyed throttle so a long-lived multi-project host cannot
 * retain one map entry for every directory it has ever visited. */
const CLEANUP_THROTTLE_MAX_ROOTS = 256;
/** Retain at most this many terminal runs by default. */
const DEFAULT_MAX_KEPT_TERMINAL = 100;
/** Remove terminal runs older than this (days). */
const DEFAULT_MAX_AGE_DAYS = 30;

// Re-exported for use in TaskflowSettings defaults (agents.ts).
export const DEFAULT_KEPT_RUNS = DEFAULT_MAX_KEPT_TERMINAL;
export const DEFAULT_RUN_AGE_DAYS = DEFAULT_MAX_AGE_DAYS;

/** Per-runs-root cleanup timestamps. A process-global scalar lets one busy
 * project suppress retention in every other project served by the same host. */
const lastCleanupAtByRoot = new Map<string, number>();

/** Shared buffer for Atomics.wait in acquireLock busy-wait (Finding 6). */
const LOCK_WAIT_BUF = new Int32Array(new SharedArrayBuffer(4));

interface FileLockHandle {
	device: number;
	inode: number;
	token: string;
}

interface LockOwnerRecord {
	pid: number;
	ts: number;
	token?: string;
}

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

/** Return the path to a run's deterministic-replay trace (append-only JSONL).
 *  Sibling to `<runId>.json` in the same per-flow dir. Best-effort: the file
 *  only exists if a TraceSink was injected for the run. */
export function traceFilePath(runsRoot: string, flowName: string, runId: string): string {
	return path.join(flowRunDir(runsRoot, flowName), `${runId}.trace.jsonl`);
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
	// A single leading/trailing dot is safe once the id is used as
	// `${runId}.json`, and `newRunId()` has historically produced leading-dot
	// ids for valid flow names such as `.ci`. Reject separators and dot-dot
	// traversal, but retain compatibility with those already-persisted runs.
	return typeof runId === "string" && runId.length > 0 && runId.length <= 160 &&
		/^[A-Za-z0-9._-]+$/.test(runId) && !runId.includes("..");
}

/**
 * Validate an index path before it is joined to the runs root.
 *
 * Index files live in a project-controlled directory and may be stale or
 * manually edited. Only the two layouts Taskflow itself has ever emitted are
 * accepted: `<flowDir>/<runId>.json` and the legacy `<runId>.json`. Keeping
 * this check independent from the host OS also makes an index written on one
 * platform safe to consume on another (generated index paths always use `/`).
 */
function isSafeRunIndexRelPath(relPath: string, runId: string): boolean {
	if (!validateRunId(runId) || relPath.length === 0 || relPath.length > 420) return false;
	if (path.isAbsolute(relPath) || relPath.includes("\\")) return false;

	const parts = relPath.split("/");
	if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return false;
	if (parts.length === 1) return parts[0] === `${runId}.json`;
	if (parts.length !== 2) return false;

	const [flowDir, fileName] = parts;
	return flowDir!.length <= 255 && safeFlowDirName(flowDir!) === flowDir && fileName === `${runId}.json`;
}

/** Join an already-validated, platform-neutral index path to the runs root. */
function runIndexFilePath(runsRoot: string, relPath: string): string {
	return path.join(runsRoot, ...relPath.split("/"));
}

/** Canonical, bounded-LRU throttle for opportunistic per-project cleanup. */
function shouldRunCleanup(runsRoot: string, now: number): boolean {
	let key: string;
	try { key = fs.realpathSync(runsRoot); } catch { key = path.resolve(runsRoot); }
	const previous = lastCleanupAtByRoot.get(key);
	if (previous !== undefined && now - previous < CLEANUP_INTERVAL_MS) return false;

	// Refresh insertion order for simple LRU eviction.
	lastCleanupAtByRoot.delete(key);
	lastCleanupAtByRoot.set(key, now);
	while (lastCleanupAtByRoot.size > CLEANUP_THROTTLE_MAX_ROOTS) {
		const oldest = lastCleanupAtByRoot.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		lastCleanupAtByRoot.delete(oldest);
	}
	return true;
}

interface PhysicalDirectorySnapshot {
	realPath: string;
	device: number;
	inode: number;
}

/**
 * Resolve a physical directory only when it is a non-symlink descendant of
 * runsRoot. Retention performs destructive operations, so lexical containment
 * alone is insufficient: a checked-in `runs/<flow>` symlink could otherwise
 * redirect the run lock and unlink to an arbitrary directory.
 */
function physicalDirectoryInsideRunsRoot(
	runsRoot: string,
	candidate: string,
): PhysicalDirectorySnapshot | null {
	try {
		const rootReal = fs.realpathSync(runsRoot);
		const stat = fs.lstatSync(candidate);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
		const realPath = fs.realpathSync(candidate);
		const rel = path.relative(rootReal, realPath);
		if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
		return { realPath, device: stat.dev, inode: stat.ino };
	} catch {
		return null;
	}
}

function physicalDirectoryStillMatches(
	runsRoot: string,
	candidate: string,
	snapshot: PhysicalDirectorySnapshot,
): boolean {
	const current = physicalDirectoryInsideRunsRoot(runsRoot, candidate);
	return Boolean(
		current && current.realPath === snapshot.realPath &&
		current.device === snapshot.device && current.inode === snapshot.inode,
	);
}

/** Remove a Taskflow-owned artifact tree without following a project symlink. */
function removeArtifactDirectoryInsideRunsRoot(runsRoot: string, target: string): void {
	const parent = path.dirname(target);
	const parentSnapshot = physicalDirectoryInsideRunsRoot(runsRoot, parent);
	if (!parentSnapshot) return;
	try {
		const stat = fs.lstatSync(target);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return;
		const targetSnapshot = physicalDirectoryInsideRunsRoot(runsRoot, target);
		if (!targetSnapshot || !physicalDirectoryStillMatches(runsRoot, parent, parentSnapshot)) return;
		if (!physicalDirectoryStillMatches(runsRoot, target, targetSnapshot)) return;
		fs.rmSync(target, { recursive: true, force: true });
	} catch { /* missing / concurrently changed */ }
}

/** Accept a persisted cwd for control-record cleanup only when it resolves to
 * the same project run store currently being retained. */
function controlCwdForRunsRoot(runsRoot: string, candidate: unknown): string {
	const fallback = path.dirname(path.dirname(path.dirname(runsRoot)));
	if (typeof candidate !== "string" || candidate.length === 0) return fallback;
	try {
		if (fs.realpathSync(runsDir(candidate)) === fs.realpathSync(runsRoot)) return candidate;
	} catch { /* malformed, missing, or from another project */ }
	return fallback;
}

// ---------------------------------------------------------------------------
// File-lock primitives — zero-dependency, using O_CREAT|O_EXCL (atomic)
// ---------------------------------------------------------------------------

function readLockOwner(lockPath: string): LockOwnerRecord | null {
	try {
		const stat = fs.lstatSync(lockPath);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_096) return null;
		const raw = fs.readFileSync(lockPath, "utf-8");
		if (Buffer.byteLength(raw, "utf-8") > 4_096) return null;
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (!Number.isSafeInteger(parsed.pid) || typeof parsed.ts !== "number") return null;
		return {
			pid: parsed.pid as number,
			ts: parsed.ts,
			...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
		};
	} catch {
		return null;
	}
}

function sameLockOwner(left: LockOwnerRecord | null, right: LockOwnerRecord): boolean {
	return Boolean(
		left && left.pid === right.pid && left.ts === right.ts && left.token === right.token,
	);
}

/**
 * Serialize stale-lock stealers for one observed lock generation. Without this
 * claim, contender B can replace a dead lock and contender C — acting on its
 * earlier observation — can then rename B's fresh live lock.
 */
function tryStealDeadLock(lockPath: string, observed: fs.Stats, owner: LockOwnerRecord): boolean {
	if (probeProcess(owner.pid) !== "dead") return false;
	const generation = crypto.createHash("sha256")
		.update(`${observed.dev}\0${observed.ino}\0${owner.pid}\0${owner.ts}\0${owner.token ?? ""}`)
		.digest("hex")
		.slice(0, 16);
	const claimPath = `${lockPath}.steal.${generation}`;
	let claimFd: number;
	try {
		claimFd = fs.openSync(claimPath, "wx");
	} catch {
		return false;
	}

	const claimToken = crypto.randomBytes(16).toString("hex");
	let claimHandle: FileLockHandle | undefined;
	try {
		fs.writeFileSync(claimFd, JSON.stringify({ pid: process.pid, ts: Date.now(), token: claimToken }));
		const claimStat = fs.fstatSync(claimFd);
		claimHandle = { device: claimStat.dev, inode: claimStat.ino, token: claimToken };
		fs.closeSync(claimFd);
		claimFd = -1;

		const current = fs.lstatSync(lockPath);
		if (current.dev !== observed.dev || current.ino !== observed.ino) return false;
		if (!sameLockOwner(readLockOwner(lockPath), owner)) return false;

		const grave = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
		fs.renameSync(lockPath, grave);
		try { fs.unlinkSync(grave); } catch { /* best-effort grave cleanup */ }
		return true;
	} catch {
		return false;
	} finally {
		if (claimFd >= 0) {
			try { fs.closeSync(claimFd); } catch { /* ignore */ }
		}
		if (claimHandle) releaseLock(claimPath, claimHandle);
		else {
			// Initialization did not finish; only this exclusive creator can own it.
			try { fs.unlinkSync(claimPath); } catch { /* ignore */ }
		}
	}
}

/**
 * Acquire a file lock by atomically creating a lock file.
 *
 * Uses O_CREAT|O_EXCL (`wx` flag) which is atomic on POSIX and NTFS.
 * Stale locks (> LOCK_STALE_MS) are stolen only after their recorded owner PID
 * is definitively dead, then moved via an atomic rename. Age alone cannot prove
 * abandonment: stealing from a slow but live holder creates two simultaneous
 * critical sections, and the old holder can later unlink the new holder's lock.
 * Throws on timeout.
 */
function acquireLock(lockPath: string, timeoutMs: number = LOCK_TIMEOUT_MS): FileLockHandle {
	const start = Date.now();
	// Ensure parent directory exists (lock file lives inside the flow subdir).
	const dir = path.dirname(lockPath);
	fs.mkdirSync(dir, { recursive: true });

	while (true) {
		try {
			const fd = fs.openSync(lockPath, "wx");
			const token = crypto.randomBytes(16).toString("hex");
			try {
				fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now(), token }));
				const stat = fs.fstatSync(fd);
				return { device: stat.dev, inode: stat.ino, token };
			} catch (error) {
				// Creation succeeded but initialization did not. Remove only the inode
				// this process created so a partial lock cannot become unstealable.
				try {
					const held = fs.fstatSync(fd);
					const current = fs.lstatSync(lockPath);
					if (current.dev === held.dev && current.ino === held.ino) fs.unlinkSync(lockPath);
				} catch { /* best-effort rollback */ }
				throw error;
			} finally {
				fs.closeSync(fd);
			}
		} catch (e: unknown) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			// Lock file exists — check if stale.
			try {
				const stat = fs.lstatSync(lockPath);
				if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
					const owner = readLockOwner(lockPath);
					if (owner && tryStealDeadLock(lockPath, stat, owner)) continue;
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
 * Release a file lock only when the path still carries this holder's inode and
 * random ownership token. A dead-owner steal must never let an old finally
 * block delete the successor's lock.
 */
function releaseLock(lockPath: string, handle: FileLockHandle): void {
	try {
		const stat = fs.lstatSync(lockPath);
		if (!stat.isFile() || stat.dev !== handle.device || stat.ino !== handle.inode) return;
		if (readLockOwner(lockPath)?.token !== handle.token) return;
		fs.unlinkSync(lockPath);
	} catch { /* ENOENT, replaced, or corrupt — never unlink another owner's lock */ }
}

/**
 * Execute `fn` while holding a file lock.  Guarantees release even on throw.
 */
export function withLock<T>(lockPath: string, fn: () => T, timeoutMs: number = LOCK_TIMEOUT_MS): T {
	const handle = acquireLock(lockPath, timeoutMs);
	try {
		return fn();
	} finally {
		releaseLock(lockPath, handle);
	}
}

// ---------------------------------------------------------------------------
// Index CRUD
// ---------------------------------------------------------------------------

/**
 * Extract a RunIndexEntry from a RunState + computed relative path.
 * Exported for tests; pure.
 */
export function extractIndexEntry(state: RunState, relPath: string): RunIndexEntry {
	return {
		runId: state.runId,
		flowName: state.flowName,
		cwd: state.cwd,
		status: state.status,
		createdAt: state.createdAt,
		updatedAt: state.updatedAt,
		relPath,
		...(state.host !== undefined ? { host: state.host } : {}),
		...(state.packageVersion !== undefined ? { packageVersion: state.packageVersion } : {}),
		...(state.parentRunId !== undefined ? { parentRunId: state.parentRunId } : {}),
	};
}

/** Read the index file; return [] on any error (missing, corrupt, etc.). */
function readIndex(runsRoot: string): RunIndexEntry[] {
	try {
		const raw = fs.readFileSync(indexPath(runsRoot), "utf-8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		// Treat the project-controlled index as untrusted input. In particular,
		// never let a crafted relPath escape runsRoot during load or retention.
		return (parsed as RunIndexEntry[]).filter(
			(e) => e && typeof e.runId === "string" && typeof e.relPath === "string" &&
				isSafeRunIndexRelPath(e.relPath, e.runId),
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
			const loaded = tryReadRunFile(runsRoot, path.join(dirPath, file));
			if (loaded.ok && validateRunId(loaded.value.runId) && file === `${loaded.value.runId}.json`) {
				entries.set(loaded.value.runId, extractIndexEntry(loaded.value, `${dirName}/${file}`));
			}
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
		const loaded = tryReadRunFile(runsRoot, path.join(runsRoot, file));
		if (loaded.ok && validateRunId(loaded.value.runId) && file === `${loaded.value.runId}.json` &&
			!entries.has(loaded.value.runId)) {
			entries.set(loaded.value.runId, extractIndexEntry(loaded.value, file));
		}
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
 * Remove excess and expired inactive runs.
 *
 * Called opportunistically at the end of saveRun.  Throttled to at most once
 * per CLEANUP_INTERVAL_MS. Only actually executing (`running`) runs are never
 * touched. Paused and blocked runs remain resumable/inspectable inside the
 * configured retention window, but no longer bypass it forever.
 *
 * The index read-modify-write is performed under the index lock so it cannot
 * race a concurrent updateIndexEntry and clobber a freshly-added entry (M1).
 * We re-read the index *inside* the lock (rather than trusting a snapshot read
 * before locking) so the rewrite reflects the latest committed state. File and
 * directory unlinks happen after the index lock is released, but each candidate
 * is revalidated while holding its own run lock. This prevents cleanup from
 * unlinking a run that was resumed or otherwise saved after selection.
 */
function cleanupTerminalRuns(
	runsRoot: string,
	maxKeep: number = DEFAULT_MAX_KEPT_TERMINAL,
	maxAgeDays: number = DEFAULT_MAX_AGE_DAYS,
): void {
	const now = Date.now();
	if (!shouldRunCleanup(runsRoot, now)) return;

	const maxAgeMs = maxAgeDays * 86_400_000;
	let toRemove: RunIndexEntry[] = [];

	try {
		withLock(indexLockPath(runsRoot), () => {
			const entries = readIndex(runsRoot);
			const terminal: RunIndexEntry[] = [];
			const active: RunIndexEntry[] = [];

			for (const e of entries) {
				if (e.status !== "running") {
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
				const expiredByAge = maxAgeDays > 0 && now - e.updatedAt > maxAgeMs;
				const excessByCount = maxKeep > 0 && i >= maxKeep;
				if (expiredByAge || excessByCount) {
					toRemove.push(e);
				}
			}

			if (toRemove.length === 0) return;

			// Commit the pruned index while holding the lock so a concurrent
			// updateIndexEntry cannot interleave and lose entries.
			const removalSet = new Set(toRemove);
			const remaining = cleanTerminal.filter((e) => !removalSet.has(e));
			writeIndex(runsRoot, [...active, ...remaining]);
		}, CLEANUP_LOCK_TIMEOUT_MS);
	} catch {
		// Retention is opportunistic. A busy index must not stall or fail saveRun.
		return;
	}

	if (toRemove.length === 0) return;

	// Delete artifacts outside the index lock, but under the exact per-run lock
	// used by saveRun. Only the entries whose on-disk snapshots still match the
	// selected index entries are safe to remove.
	const removed: RunIndexEntry[] = [];
	for (const e of toRemove) {
		if (cleanupRunArtifactsIfSnapshotMatches(runsRoot, e)) removed.push(e);
	}

	if (removed.length > 0) {
		console.warn(
			`[taskflow] Cleaning up ${removed.length} old run(s) ` +
			`(max ${maxKeep} runs, ${maxAgeDays} day age limit). ` +
			`Configure 'taskflow.maxKeptRuns' / 'taskflow.maxRunAgeDays' in settings.json (0 = keep all).`,
		);
	}

	// Remove empty flow subdirectories.
	for (const e of removed) {
		const dirPath = path.dirname(runIndexFilePath(runsRoot, e.relPath));
		try { fs.rmdirSync(dirPath); } catch { /* ENOTEMPTY or ENOENT — ignore */ }
	}
}

/**
 * Remove one retention candidate if it is still the exact state selected from
 * the index. Returning false is deliberately fail-open: the run remains on
 * disk, and a changed valid snapshot is restored to the index.
 */
function cleanupRunArtifactsIfSnapshotMatches(runsRoot: string, entry: RunIndexEntry): boolean {
	if (!isSafeRunIndexRelPath(entry.relPath, entry.runId)) return false;
	const filePath = runIndexFilePath(runsRoot, entry.relPath);
	const fileDir = path.dirname(filePath);
	const directorySnapshot = physicalDirectoryInsideRunsRoot(runsRoot, fileDir);
	if (!directorySnapshot) return false;
	const restore = (state: RunState): void => {
		try { updateIndexEntry(runsRoot, extractIndexEntry(state, entry.relPath)); } catch { /* best effort */ }
	};

	try {
		return withLock(`${filePath}.lock`, () => {
			if (!physicalDirectoryStillMatches(runsRoot, fileDir, directorySnapshot)) return false;
			// saveRun holds this same run lock until its index upsert commits. If a
			// save won the race after cleanup pruned the old entry, that fresh entry
			// is now visible and owns the file even when Date.now() reused the same
			// millisecond/status values. Never remove a re-indexed candidate.
			const wasReindexed = withLock(indexLockPath(runsRoot), () =>
				readIndex(runsRoot).some((current) => current.runId === entry.runId),
				CLEANUP_LOCK_TIMEOUT_MS,
			);
			if (wasReindexed) return false;

			let state: RunState;
			let fileSnapshot: { device: number; inode: number };
			try {
				const stat = fs.lstatSync(filePath);
				if (!stat.isFile() || stat.isSymbolicLink()) return false;
				fileSnapshot = { device: stat.dev, inode: stat.ino };
				const loaded = tryReadRunFile(runsRoot, filePath);
				if (!loaded.ok) return false;
				state = loaded.value;
			} catch {
				return false;
			}

			if (state.runId !== entry.runId) return false;
			if (state.status === "running" || state.status !== entry.status || state.updatedAt !== entry.updatedAt) {
				restore(state);
				return false;
			}

			try {
				if (!physicalDirectoryStillMatches(runsRoot, fileDir, directorySnapshot)) {
					restore(state);
					return false;
				}
				const currentFile = fs.lstatSync(filePath);
				if (!currentFile.isFile() || currentFile.isSymbolicLink() ||
					currentFile.dev !== fileSnapshot.device || currentFile.ino !== fileSnapshot.inode) {
					restore(state);
					return false;
				}
				fs.unlinkSync(filePath);
			} catch {
				restore(state);
				return false;
			}

			// Remove deterministic-replay trace while respecting its append lock.
			const tracePath = filePath.replace(/\.json$/, ".trace.jsonl");
			try {
				withLock(
					`${tracePath}.lock`,
					() => { try { fs.unlinkSync(tracePath); } catch { /* missing */ } },
					CLEANUP_LOCK_TIMEOUT_MS,
				);
			} catch { /* best effort */ }
			// Remove per-run Shared Context Tree and isolated-workspace artifacts.
			removeArtifactDirectoryInsideRunsRoot(runsRoot, path.join(runsRoot, "ctx", entry.runId));
			const wsSeg = entry.runId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 100) || "phase";
			removeArtifactDirectoryInsideRunsRoot(runsRoot, path.join(runsRoot, "ws", wsSeg));

			// Remove user-private detached control records left by an interrupted worker.
			const controlCwd = controlCwdForRunsRoot(runsRoot, state.cwd);
			const controlDir = detachedControlDir(controlCwd);
			try { fs.unlinkSync(path.join(controlDir, `${entry.runId}.cancel.json`)); } catch { /* ignore */ }
			try { fs.unlinkSync(path.join(controlDir, `${entry.runId}.processes.json`)); } catch { /* ignore */ }
			try { fs.rmdirSync(controlDir); } catch { /* other runs / missing */ }
			return true;
		}, CLEANUP_LOCK_TIMEOUT_MS);
	} catch {
		// Retention is opportunistic and must never make saveRun fail.
		return false;
	}
}

// ---------------------------------------------------------------------------
// Original helpers (unchanged)
// ---------------------------------------------------------------------------

function userFlowsDir(): string {
	return path.join(getAgentDir(), "taskflows");
}

function canonicalDiscoveryPath(input: string): string {
	const absolute = path.resolve(input);
	try {
		return fs.realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

function sameDiscoveryPath(a: string, b: string): boolean {
	if (process.platform === "win32") return a.toLowerCase() === b.toLowerCase();
	return a === b;
}

function findProjectFlowsDirInternal(cwd: string, create = false): string | null {
	// Prefer an existing .pi dir up the tree; else use cwd/.pi when creating.
	// **Never inherit `~/.pi/` or the shared OS temp root's `.pi/` while walking
	// ancestors.** Resolve physical paths first so relative cwd values and symlink
	// aliases cannot bypass either boundary. An explicit create at cwd still uses
	// cwd/.pi; only ancestor discovery stops at these user/shared boundaries.
	const home = canonicalDiscoveryPath(os.homedir());
	const tempRoot = canonicalDiscoveryPath(os.tmpdir());
	const canonicalCwd = canonicalDiscoveryPath(cwd);
	let dir = canonicalCwd;
	while (true) {
		if (sameDiscoveryPath(dir, home) || sameDiscoveryPath(dir, tempRoot)) break;
		const candidate = path.join(dir, ".pi");
		if (fs.existsSync(candidate)) return path.join(candidate, "taskflows");
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return create ? path.join(canonicalCwd, ".pi", "taskflows") : null;
}

const MAX_FLOW_DEFINITION_BYTES = 1_048_576; // 1 MiB per JSON/JSONC/defineFile
const MAX_DISCOVERY_TOTAL_BYTES = 8_388_608; // 8 MiB across user + project discovery

interface DiscoveryBudget {
	entries: number;
	directories: number;
	files: number;
	bytes: number;
	exceeded: boolean;
}

interface StableSource<T> {
	value: T;
	filePath: string;
	sourceDirIdentity: DirectoryIdentity;
	byteLength: number;
}

function sameFileStat(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function sameDirectoryIdentityValue(a: DirectoryIdentity | undefined, b: DirectoryIdentity | undefined): boolean {
	return !!a && !!b && a.canonicalPath === b.canonicalPath && a.device === b.device && a.inode === b.inode;
}

/** Read a bounded regular file through one descriptor and bind parsed content to
 * a canonical path + parent identity. Symlink leaves and files changed during
 * the read fail closed. */
function loadStableSource<T>(
	filePath: string,
	parse: (raw: string) => T,
	budget?: DiscoveryBudget,
	allowedRootReal?: string | readonly string[],
): LoadResult<StableSource<T>> {
	const allowedRoots = allowedRootReal === undefined
		? []
		: (typeof allowedRootReal === "string" ? [allowedRootReal] : [...allowedRootReal]);
	const isAllowedSource = (candidate: string): boolean =>
		allowedRoots.length === 0 || allowedRoots.some((root) => isPhysicallyContained(root, candidate));
	let fd: number | undefined;
	try {
		const lexicalStat = fs.lstatSync(filePath, { bigint: true });
		if (lexicalStat.isSymbolicLink() || !lexicalStat.isFile()) {
			throw new Error("definition must be a regular non-symlink file");
		}
		const canonicalBefore = fs.realpathSync.native(filePath);
		if (allowedRoots.length > 0 && (
			!sameDiscoveryPath(canonicalBefore, path.resolve(filePath)) ||
			!isAllowedSource(canonicalBefore)
		)) {
			throw new Error("definition escaped or changed its canonical saved-flow root");
		}
		const sourceDirBefore = directoryIdentity(path.dirname(canonicalBefore));
		if (!sourceDirBefore) throw new Error("definition parent directory identity is unavailable");

		const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
		const before = fs.fstatSync(fd, { bigint: true });
		if (!before.isFile()) throw new Error("definition must remain a regular file");
		if (before.size > BigInt(MAX_FLOW_DEFINITION_BYTES)) {
			if (budget) budget.exceeded = true;
			throw new Error(`definition exceeds ${MAX_FLOW_DEFINITION_BYTES} byte limit`);
		}
		const byteLength = Number(before.size);
		if (budget && budget.bytes + byteLength > MAX_DISCOVERY_TOTAL_BYTES) {
			budget.exceeded = true;
			throw new Error(`flow discovery exceeds ${MAX_DISCOVERY_TOTAL_BYTES} cumulative byte limit`);
		}
		if (budget) budget.bytes += byteLength;

		const buffer = Buffer.allocUnsafe(byteLength + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const count = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
			if (count === 0) break;
			bytesRead += count;
		}
		const after = fs.fstatSync(fd, { bigint: true });
		if (bytesRead !== byteLength || !sameFileStat(before, after)) {
			throw new Error("definition changed while it was being read");
		}

		const lexicalAfter = fs.lstatSync(filePath, { bigint: true });
		if (lexicalAfter.isSymbolicLink() || !sameFileStat(after, lexicalAfter)) {
			throw new Error("definition path identity changed while it was being read");
		}
		const canonicalAfter = fs.realpathSync.native(filePath);
		const sourceDirAfter = directoryIdentity(path.dirname(canonicalAfter));
		if (
			canonicalAfter !== canonicalBefore ||
			(allowedRoots.length > 0 && !isAllowedSource(canonicalAfter)) ||
			!sameDirectoryIdentityValue(sourceDirBefore, sourceDirAfter)
		) {
			throw new Error("definition parent directory changed while it was being read");
		}

		const raw = buffer.subarray(0, bytesRead).toString("utf8");
		return {
			ok: true,
			value: {
				value: parse(raw),
				filePath: canonicalAfter,
				sourceDirIdentity: sourceDirAfter!,
				byteLength,
			},
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return {
			ok: false,
			reason: code === "ENOENT" || code === "EACCES" ? "missing" : "unparseable",
			path: filePath,
			detail: errMessage(error),
		};
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* best effort */ }
		}
	}
}

export interface LoadedDefineFile {
	value: unknown;
	filePath: string;
	sourceDirIdentity: DirectoryIdentity;
}

/** Stable defineFile loader used by execution hosts that need source provenance. */
export function readDefineFileWithSource(
	filePath: string,
	allowedRootReal?: string | readonly string[],
): LoadResult<LoadedDefineFile> {
	const loaded = loadStableSource(filePath, (raw) => parseStrict(raw, { allowFence: true }), undefined, allowedRootReal);
	if (!loaded.ok) return loaded;
	return {
		ok: true,
		value: {
			value: loaded.value.value,
			filePath: loaded.value.filePath,
			sourceDirIdentity: loaded.value.sourceDirIdentity,
		},
	};
}

export function readDefineFile(filePath: string): LoadResult<unknown> {
	const loaded = readDefineFileWithSource(filePath);
	return loaded.ok ? { ok: true, value: loaded.value.value } : loaded;
}

function readFlowFile(
	filePath: string,
	scope: "user" | "project",
	budget?: DiscoveryBudget,
	allowedRootReal?: string,
): LoadResult<SavedFlow> {
	const r = loadStableSource(filePath, (raw) => parseJsonc(raw) as Taskflow, budget, allowedRootReal);
	if (!r.ok) return r;
	if (!r.value.value?.name) {
		return { ok: false, reason: "unparseable", path: filePath, detail: "parsed OK but missing required field: name" };
	}
	return {
		ok: true,
		value: {
			name: r.value.value.name,
			scope,
			filePath: r.value.filePath,
			sourceDirIdentity: r.value.sourceDirIdentity,
			def: r.value.value,
		},
	};
}

const NESTED_FLOWS_DIR = "flows";
const MAX_NESTED_FLOW_DEPTH = 16;
const MAX_DISCOVERY_FILES = 1_000;
const MAX_DISCOVERY_ENTRIES = 10_000;
const MAX_DISCOVERY_DIRS = 512;

function codePointCompare(a: string, b: string): number {
	const left = Array.from(a);
	const right = Array.from(b);
	const length = Math.min(left.length, right.length);
	for (let i = 0; i < length; i++) {
		const l = left[i]!.codePointAt(0)!;
		const r = right[i]!.codePointAt(0)!;
		if (l !== r) return l - r;
	}
	return left.length - right.length;
}

function isFlowDefinitionFile(name: string): boolean {
	return name.endsWith(".json") && !name.endsWith(".meta.json") && !name.endsWith(".flowir.json");
}

/** The 0.2.9 top-level scanner excluded only metadata sidecars. In particular,
 * a valid flow named `release.flowir` is stored as `release.flowir.json` and
 * must remain discoverable. The new nested convention can still reserve that
 * suffix for generated FlowIR artifacts. */
function isLegacyFlowDefinitionFile(name: string): boolean {
	return name.endsWith(".json") && !name.endsWith(".meta.json");
}

function isPhysicallyContained(rootReal: string, candidateReal: string): boolean {
	const relative = path.relative(rootReal, candidateReal);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Validate every directory component from a trusted boundary (`.pi` for a
 * project, agent root for user flows) through the taskflows storage root.
 * Only an explicitly configured user agent boundary may itself be a symlink. */
function validateStorageRoot(root: string, boundary: string, allowBoundarySymlink = false): string | undefined {
	const rootAbs = path.resolve(root);
	const boundaryAbs = path.resolve(boundary);
	const lexicalRelative = path.relative(boundaryAbs, rootAbs);
	if (lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) return undefined;
	// The configured trust boundary itself may be a symlink (for example a
	// user moving ~/.pi/agent to another disk). Preserve that historical setup,
	// while still rejecting every symlink component *below* the boundary.
	let current = rootAbs;
	for (;;) {
		const atBoundary = sameDiscoveryPath(current, boundaryAbs);
		if (atBoundary && allowBoundarySymlink) break;
		try {
			const stat = fs.lstatSync(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
		} catch {
			return undefined;
		}
		if (atBoundary) break;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	try {
		const boundaryReal = fs.realpathSync.native(boundaryAbs);
		const rootReal = fs.realpathSync.native(rootAbs);
		if (!fs.statSync(boundaryReal).isDirectory() || !fs.statSync(rootReal).isDirectory()) return undefined;
		return isPhysicallyContained(boundaryReal, rootReal) ? rootReal : undefined;
	} catch {
		return undefined;
	}
}

function readDirectoryBounded(dir: string, budget: DiscoveryBudget): fs.Dirent[] {
	if (budget.exceeded || budget.directories >= MAX_DISCOVERY_DIRS) {
		budget.exceeded = true;
		return [];
	}
	budget.directories++;
	let handle: fs.Dir;
	try {
		handle = fs.opendirSync(dir);
	} catch {
		return [];
	}
	const entries: fs.Dirent[] = [];
	try {
		for (;;) {
			const entry = handle.readSync();
			if (!entry) break;
			budget.entries++;
			if (budget.entries > MAX_DISCOVERY_ENTRIES) {
				budget.exceeded = true;
				break;
			}
			entries.push(entry);
		}
	} catch {
		// Preserve the legacy listFlows contract: an unreadable or concurrently
		// replaced directory is skipped rather than escaping as a process-level
		// exception. Discard a partial read so precedence never depends on where
		// the failure happened.
		return [];
	} finally {
		try { handle.closeSync(); } catch { /* unreadable/replaced directory: skip */ }
	}
	return entries.sort((a, b) => codePointCompare(a.name, b.name));
}

function reserveFlowCandidate(budget: DiscoveryBudget): boolean {
	budget.files++;
	if (budget.files > MAX_DISCOVERY_FILES) {
		budget.exceeded = true;
		return false;
	}
	return true;
}

function canonicalRegularFile(candidate: string, rootReal: string): string | undefined {
	try {
		const stat = fs.lstatSync(candidate);
		if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
		const real = fs.realpathSync.native(candidate);
		return isPhysicallyContained(rootReal, real) ? real : undefined;
	} catch {
		return undefined;
	}
}

function listLegacyFlowFiles(rootReal: string, budget: DiscoveryBudget): string[] {
	const files: string[] = [];
	for (const entry of readDirectoryBounded(rootReal, budget)) {
		if (budget.exceeded) break;
		// Legacy 0.2.9 discovery accepted hidden top-level JSON definitions. Keep
		// that compatibility at the storage root; only the new recursive `flows/`
		// convention skips hidden entries/directories.
		if (entry.isSymbolicLink() || !entry.isFile() || !isLegacyFlowDefinitionFile(entry.name)) continue;
		const real = canonicalRegularFile(path.join(rootReal, entry.name), rootReal);
		if (!real || !reserveFlowCandidate(budget)) continue;
		files.push(real);
	}
	return files;
}

/** Deterministically discover ordinary JSON files below `<root>/flows/` under
 * one shared user+project budget. Every path component below the validated
 * storage root must remain a regular non-symlink directory/file. */
function listNestedFlowFiles(rootReal: string, budget: DiscoveryBudget): string[] {
	const conventionRoot = path.join(rootReal, NESTED_FLOWS_DIR);
	let conventionReal: string;
	try {
		const stat = fs.lstatSync(conventionRoot);
		if (stat.isSymbolicLink() || !stat.isDirectory()) return [];
		conventionReal = fs.realpathSync.native(conventionRoot);
		if (!isPhysicallyContained(rootReal, conventionReal)) return [];
	} catch {
		return [];
	}

	const found: string[] = [];
	const visit = (dir: string, depth: number): void => {
		if (budget.exceeded || depth > MAX_NESTED_FLOW_DEPTH) {
			budget.exceeded = true;
			return;
		}
		for (const entry of readDirectoryBounded(dir, budget)) {
			if (budget.exceeded) break;
			if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
			const candidate = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				try {
					const stat = fs.lstatSync(candidate);
					if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
					const real = fs.realpathSync.native(candidate);
					if (!isPhysicallyContained(conventionReal, real)) continue;
					visit(real, depth + 1);
				} catch {
					// Entry disappeared or changed; skip safely.
				}
			} else if (entry.isFile() && isFlowDefinitionFile(entry.name)) {
				const real = canonicalRegularFile(candidate, conventionReal);
				if (!real || !reserveFlowCandidate(budget)) continue;
				found.push(real);
			}
		}
	};
	visit(conventionReal, 0);
	return found.sort(codePointCompare);
}

function discoveryLimitDetail(): string {
	return `${MAX_DISCOVERY_FILES} flows, ${MAX_DISCOVERY_ENTRIES} entries, ` +
		`${MAX_DISCOVERY_DIRS} directories, ${MAX_DISCOVERY_TOTAL_BYTES} bytes, ` +
		`${MAX_FLOW_DEFINITION_BYTES} bytes/file, depth ${MAX_NESTED_FLOW_DEPTH}`;
}

function warnDiscoveryLimit(): void {
	console.warn(`[taskflow] Saved flow discovery failed closed after exceeding a safety limit (${discoveryLimitDetail()}).`);
}

/** Internal-but-exported for tests: walk-up `.pi` finder with home-dir stop. */
export function findProjectFlowsDir(cwd: string, create = false): string | null {
	return findProjectFlowsDirInternal(cwd, create);
}

interface FlowDiscoveryResult {
	flows: SavedFlow[];
	/** Same-scope winners before project-over-user precedence is applied. */
	scopedFlows: SavedFlow[];
	failures: Array<{
		scope: "user" | "project";
		filePath: string;
		result: Extract<LoadResult<SavedFlow>, { ok: false }>;
	}>;
	diagnostics: string[];
	exceeded: boolean;
}

/** One bounded discovery pass shared by list/get/diagnosed lookup. */
function discoverFlows(cwd: string): FlowDiscoveryResult {
	const map = new Map<string, SavedFlow>();
	const scopedFlows: SavedFlow[] = [];
	const failures: FlowDiscoveryResult["failures"] = [];
	const diagnostics: string[] = [];
	const budget: DiscoveryBudget = { entries: 0, directories: 0, files: 0, bytes: 0, exceeded: false };
	const agentRoot = getAgentDir();
	const dirs: Array<{ dir: string; boundary: string; scope: "user" | "project" }> = [
		{ dir: userFlowsDir(), boundary: agentRoot, scope: "user" },
	];
	const projDir = findProjectFlowsDir(cwd);
	if (projDir) dirs.push({ dir: projDir, boundary: path.dirname(projDir), scope: "project" });

	for (const { dir, boundary, scope } of dirs) {
		const rootReal = validateStorageRoot(dir, boundary, scope === "user");
		if (!rootReal) continue;
		const legacyFiles = listLegacyFlowFiles(rootReal, budget);
		const nestedFiles = listNestedFlowFiles(rootReal, budget);
		if (budget.exceeded) break;
		const scopeFlows = new Map<string, SavedFlow>();
		for (const filePath of [...legacyFiles, ...nestedFiles]) {
			const r = readFlowFile(filePath, scope, budget, rootReal);
			if (budget.exceeded) break;
			if (r.ok) {
				// Candidates are precedence-ordered: legacy top-level first, then
				// Unicode-scalar sorted nested paths. The first same-scope definition wins.
				const existing = scopeFlows.get(r.value.name);
				if (!existing) {
					scopeFlows.set(r.value.name, r.value);
				} else {
					diagnostics.push(
						`[taskflow] duplicate saved flow name '${r.value.name}' in ${scope} scope; ` +
							`using ${path.relative(rootReal, existing.filePath)} and ignoring ${path.relative(rootReal, filePath)}`,
					);
				}
			} else if (r.reason === "unparseable") {
				failures.push({ scope, filePath, result: r });
				diagnostics.push(
					`[taskflow] saved flow is corrupt and was excluded from the list: ${path.relative(rootReal, filePath)} — ${r.detail}`,
				);
			}
		}
		if (budget.exceeded) break;
		for (const flow of scopeFlows.values()) {
			scopedFlows.push(flow);
			map.set(flow.name, flow);
		}
	}
	return {
		flows: Array.from(map.values()).sort((a, b) => codePointCompare(a.name, b.name)),
		scopedFlows,
		failures,
		diagnostics,
		exceeded: budget.exceeded,
	};
}

/** List all saved flows (project overrides user on name collision). */
export function listFlows(cwd: string): SavedFlow[] {
	const discovery = discoverFlows(cwd);
	for (const diagnostic of discovery.diagnostics) console.warn(diagnostic);
	if (discovery.exceeded) {
		warnDiscoveryLimit();
		return [];
	}
	return discovery.flows;
}

export function getFlow(cwd: string, name: string): SavedFlow | null {
	return listFlows(cwd).find((f) => f.name === name) ?? null;
}

/**
 * Resolve a saved flow by name with diagnosable failure. Unlike `getFlow`
 * (which returns `null` for both "no such flow" and "file exists but corrupt",
 * because corrupt files are excluded from `listFlows`), this consumes the same
 * bounded discovery snapshot and reports a matching corrupt candidate without
 * rescanning the namespace.
 */
export function getFlowDiagnosed(cwd: string, name: string): LoadResult<SavedFlow> {
	const discovery = discoverFlows(cwd);
	if (discovery.exceeded) {
		return {
			ok: false,
			reason: "unparseable",
			path: name,
			detail: `saved flow discovery exceeded a safety limit (${discoveryLimitDetail()})`,
		};
	}
	const found = discovery.flows.find((flow) => flow.name === name);
	if (found) return { ok: true, value: found };

	// Preserve the old filename-based diagnosis, but consume the failures already
	// captured by the same bounded pass. Project scope wins over user scope.
	const expectedFilename = `${safeFlowDirName(name)}.json`;
	const matching = discovery.failures
		.filter((failure) => path.basename(failure.filePath) === expectedFilename)
		.sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "project" ? -1 : 1))[0];
	if (matching) return matching.result;
	return { ok: false, reason: "missing", path: name, detail: `no saved flow named '${name}'` };
}

let _piCreationHinted = false;

function ensureProjectStorageRoot(root: string, boundary: string): void {
	const rootAbs = path.resolve(root);
	const boundaryAbs = path.resolve(boundary);
	if (!sameDiscoveryPath(path.dirname(rootAbs), boundaryAbs)) {
		throw new Error("unsafe saved-flow storage: project root is not directly below .pi");
	}

	const ensurePlainDirectory = (dir: string, parentIdentity: DirectoryIdentity): DirectoryIdentity => {
		try {
			const stat = fs.lstatSync(dir);
			if (stat.isSymbolicLink() || !stat.isDirectory()) {
				throw new Error("unsafe saved-flow storage: project storage boundary must be a non-symlink directory");
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (!sameDirectoryIdentityValue(parentIdentity, directoryIdentity(path.dirname(dir)))) {
				throw new Error("unsafe saved-flow storage: project storage parent changed before creation");
			}
			try {
				fs.mkdirSync(dir);
			} catch (mkdirError) {
				if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
			}
			const created = fs.lstatSync(dir);
			if (created.isSymbolicLink() || !created.isDirectory()) {
				throw new Error("unsafe saved-flow storage: created project storage component is not a plain directory");
			}
		}
		const identity = directoryIdentity(dir);
		if (!identity || !sameDirectoryIdentityValue(parentIdentity, directoryIdentity(path.dirname(dir)))) {
			throw new Error("unsafe saved-flow storage: project storage changed during creation");
		}
		return identity;
	};

	const boundaryParent = path.dirname(boundaryAbs);
	const boundaryParentIdentity = directoryIdentity(boundaryParent);
	if (!boundaryParentIdentity) {
		throw new Error("unsafe saved-flow storage: project directory identity is unavailable");
	}
	const boundaryIdentity = ensurePlainDirectory(boundaryAbs, boundaryParentIdentity);
	ensurePlainDirectory(rootAbs, boundaryIdentity);
}

interface FlowSaveTarget {
	dir: string;
	filePath: string;
	expectedDirIdentity: DirectoryIdentity;
}

/** Preserve the path of an already-discovered flow in the requested scope.
 * New definitions retain the legacy top-level save location. */
function resolveFlowSaveTarget(cwd: string, flowName: string, scope: "user" | "project"): FlowSaveTarget {
	const discovery = discoverFlows(cwd);
	if (discovery.exceeded) {
		throw new Error(`cannot safely resolve saved flow path: discovery exceeded a safety limit (${discoveryLimitDetail()})`);
	}
	const existing = discovery.scopedFlows.find((flow) => flow.scope === scope && flow.name === flowName);
	if (existing) {
		return {
			dir: path.dirname(existing.filePath),
			filePath: existing.filePath,
			expectedDirIdentity: existing.sourceDirIdentity,
		};
	}
	const requestedDir =
		scope === "user" ? userFlowsDir() : (findProjectFlowsDir(cwd, true) ?? path.join(cwd, ".pi", "taskflows"));
	const boundary = scope === "user" ? getAgentDir() : path.dirname(requestedDir);
	if (scope === "project") ensureProjectStorageRoot(requestedDir, boundary);
	else fs.mkdirSync(requestedDir, { recursive: true });
	const dir = validateStorageRoot(requestedDir, boundary, scope === "user");
	if (!dir) throw new Error("unsafe saved-flow storage: target is outside a trusted storage root");
	const expectedDirIdentity = directoryIdentity(dir);
	if (!expectedDirIdentity) throw new Error("unsafe saved-flow storage: target directory identity is unavailable");
	return {
		dir,
		filePath: path.join(dir, `${safeFlowDirName(flowName)}.json`),
		expectedDirIdentity,
	};
}

function assertFlowSaveTarget(target: FlowSaveTarget): void {
	if (!sameDirectoryIdentityValue(target.expectedDirIdentity, directoryIdentity(target.dir))) {
		throw new Error("saved flow parent directory changed before write");
	}
}

export function saveFlow(
	cwd: string,
	def: Taskflow,
	scope: "user" | "project" = "project",
): { filePath: string } {
	if (!def.name || def.name.trim().length === 0) throw new Error("Flow name must not be empty");
	const target = resolveFlowSaveTarget(cwd, def.name, scope);
	const { dir, filePath } = target;
	assertFlowSaveTarget(target);
	const fileLockPath = filePath + ".lock";
	withLock(fileLockPath, () => {
		assertFlowSaveTarget(target);
		writeFileAtomic(filePath, `${JSON.stringify(def, null, 2)}\n`, () => assertFlowSaveTarget(target));
	});

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

// ---------------------------------------------------------------------------
// Library sidecar (.meta.json) — RFC docs/rfc-library-reuse.md
// ---------------------------------------------------------------------------

/** Path to a flow's library sidecar. Uses the SAME safeFlowDirName as the flow
 *  file itself (N1 fix) so path-safety normalization is consistent. */
export function sidecarPathFor(cwd: string, flowName: string, scope: "user" | "project" = "project"): string {
	const dir = scope === "user" ? userFlowsDir() : (findProjectFlowsDir(cwd) ?? path.join(cwd, ".pi", "taskflows"));
	return path.join(dir, `${safeFlowDirName(flowName)}.meta.json`);
}

/** Path to a flow's sidecar given its flow-file directory (avoids re-resolving
 *  scope when we already have the flow's filePath from listFlows). */
function sidecarPathIn(flowFilePath: string): string {
	return flowFilePath.replace(/\.json$/, ".meta.json");
}

/** Read a flow's library sidecar. Returns a `LoadResult`; missing/unparseable
 *  are discriminated by `reason`. */
export function readMeta(cwd: string, flowName: string): LoadResult<FlowMeta> {
	// A discovered flow owns the sidecar adjacent to its actual definition file.
	// This preserves metadata for nested convention-directory flows and avoids
	// accidentally pairing one with a stale top-level sidecar of the same name.
	const saved = getFlow(cwd, flowName);
	if (saved) return readMetaNextTo(saved.filePath);

	// No flow resolved (for example, a caller is about to save a new definition):
	// preserve the legacy ability to recover an orphaned top-level sidecar.
	for (const scope of ["project", "user"] as const) {
		const p = sidecarPathFor(cwd, flowName, scope);
		if (!fs.existsSync(p)) continue;
		const r = loadFile(p, (raw) => {
			const parsed = parseStrict(raw);
			if (!parsed || typeof parsed !== "object") {
				throw new Error("expected a JSON object at the top level");
			}
			return parsed as FlowMeta;
		});
		return r;
	}
	return { ok: false, reason: "missing", path: flowName, detail: "no sidecar .meta.json found" };
}

/** Read a sidecar next to a specific flow file (avoids name→scope lookup when
 *  we already have the SavedFlow from listFlows). */
export function readMetaNextTo(flowFilePath: string): LoadResult<FlowMeta> {
	const p = sidecarPathIn(flowFilePath);
	if (!fs.existsSync(p)) {
		return { ok: false, reason: "missing", path: p, detail: "no sidecar .meta.json next to flow file" };
	}
	return loadFile(p, (raw) => {
		const parsed = parseStrict(raw);
		if (!parsed || typeof parsed !== "object") {
			throw new Error("expected a JSON object at the top level");
		}
		return parsed as FlowMeta;
	});
}

/** Write a flow + its sidecar atomically (same withLock critical section — R2).
 *  Embedding (Phase 2) is computed by the caller BEFORE this call and passed in
 *  via meta; this function does only synchronous I/O under the lock (R2R3). */
export function saveFlowWithMeta(
	cwd: string,
	def: Taskflow,
	meta: FlowMeta,
	scope: "user" | "project" = "project",
): { filePath: string; metaPath: string } {
	if (!def.name || def.name.trim().length === 0) throw new Error("Flow name must not be empty");
	const target = resolveFlowSaveTarget(cwd, def.name, scope);
	const { filePath } = target;
	const metaPath = sidecarPathIn(filePath);
	assertFlowSaveTarget(target);
	const fileLockPath = filePath + ".lock"; // shared lock key for flow+sidecar (R2R5)
	withLock(fileLockPath, () => {
		assertFlowSaveTarget(target);
		writeFileAtomic(filePath, `${JSON.stringify(def, null, 2)}\n`, () => assertFlowSaveTarget(target));
		assertFlowSaveTarget(target);
		writeFileAtomic(metaPath, `${JSON.stringify(meta, null, 2)}\n`, () => assertFlowSaveTarget(target));
	});
	return { filePath, metaPath };
}

/** Bump reuseCount/lastUsedAt for a flow's sidecar. Idempotent under the flow
 *  lock. If no sidecar exists yet, creates a minimal one carrying just the
 *  reuse bookkeeping (structural fields are filled next time the flow is
 *  re-saved with deriveMeta). Returns the new reuseCount, or null if the flow
 *  itself doesn't exist. */
export function bumpReuseInSidecar(cwd: string, flowName: string): number | null {
	const saved = getFlow(cwd, flowName);
	if (!saved) return null;
	const target: FlowSaveTarget = {
		dir: path.dirname(saved.filePath),
		filePath: saved.filePath,
		expectedDirIdentity: saved.sourceDirIdentity,
	};
	const metaPath = sidecarPathIn(saved.filePath);
	assertFlowSaveTarget(target);
	const lockPath = saved.filePath + ".lock";
	return withLock(lockPath, () => {
		assertFlowSaveTarget(target);
		const existingR = readMetaNextTo(saved.filePath);
		const existing = existingR.ok ? existingR.value : undefined;
		const now = Date.now();
		const updated: FlowMeta = existing
			? { ...existing, reuseCount: (existing.reuseCount ?? 0) + 1, lastUsedAt: now }
			: {
					schemaVersion: 1,
					phaseSignature: "",
					phaseCount: 0,
					agentUsage: [],
					generality: 0,
					reuseCount: 1,
					lastUsedAt: now,
					createdAt: now,
					version: 1,
					embedding: null,
			  };
		assertFlowSaveTarget(target);
		writeFileAtomic(metaPath, `${JSON.stringify(updated, null, 2)}\n`, () => assertFlowSaveTarget(target));
		return updated.reuseCount;
	});
}

// --- Run state ---

export function runsDir(cwd: string): string {
	// Safe non-null assertion: create=true guarantees a non-null return because
	// findProjectFlowsDirInternal falls back to path.join(cwd, ".pi", "taskflows").
	const projDir = findProjectFlowsDir(cwd, true)!;
	return path.join(projDir, "runs");
}

/**
 * User-private control directory for one invocation root.
 *
 * Cancellation and process-registry markers must not live below a repository:
 * a checked-out `.pi` tree can contain symlinks controlled by project content.
 * Bind the control plane to the canonical directory identity and keep only its
 * digest in the user agent directory, so sibling worktrees remain isolated.
 */
export function detachedControlDir(cwd: string): string {
	const identity = directoryIdentity(cwd);
	const source = identity
		? `${identity.canonicalPath}\0${identity.device}\0${identity.inode}`
		: path.resolve(cwd);
	const key = crypto.createHash("sha256").update(source).digest("hex");
	return path.join(getAgentDir(), "taskflow-control", key);
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
/**
 * Diagnosable variant of `loadRun`. Returns a `LoadResult` so callers can tell
 * the user *why* a runId didn't resolve: a file exists for it but is corrupt
 * (`reason: "unparseable"`, with the parse error in `detail`) versus genuinely
 * absent (`reason: "missing"`). Used by user-facing paths (resume / show /
 * provenance / why-stale / recompute). Internal polling keeps the plain
 * `loadRun` (RunState | null) for API stability.
 */
export function loadRunDiagnosed(cwd: string, runId: string): LoadResult<RunState> {
	if (!validateRunId(runId)) {
		return { ok: false, reason: "missing", path: runId, detail: "invalid runId format" };
	}
	const root = runsDir(cwd);

	// Remember the first corrupt candidate so we can report "corrupt" rather
	// than "missing" when no candidate parses cleanly.
	let corrupt: Extract<LoadResult<RunState>, { ok: false }> | null = null;
	const probe = (filePath: string): RunState | undefined => {
		const r = tryReadRunFile(root, filePath);
		// A filename/index record must never alias a different run's state.
		if (r.ok) return r.value.runId === runId ? r.value : undefined;
		if (r.reason === "unparseable" && !corrupt) corrupt = r;
		return undefined;
	};

	// ---- Try index first ----
	const indexEntries = readIndex(root);
	const entry = indexEntries.find((e) => e.runId === runId);
	if (entry) {
		const found = probe(path.join(root, entry.relPath));
		if (found) return { ok: true, value: found };
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
		const found = probe(path.join(root, dirName, `${runId}.json`));
		if (found) return { ok: true, value: found };
	}

	// ---- Try legacy flat fallback ----
	const found = probe(path.join(root, `${runId}.json`));
	if (found) return { ok: true, value: found };

	if (corrupt) return corrupt; // file exists for this runId but won't parse
	return { ok: false, reason: "missing", path: runId, detail: `no run with id '${runId}'` };
}

export function loadRun(cwd: string, runId: string): RunState | null {
	const r = loadRunDiagnosed(cwd, runId);
	return r.ok ? r.value : null;
}

/**
 * Safely read a run file, performing all path-traversal / symlink guards.
 * Returns null on any violation or read error.
 */
function tryReadRunFile(runsRoot: string, filePath: string): LoadResult<RunState> {
	// Lexical traversal guard.
	const rel = path.relative(runsRoot, filePath);
	if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
		// Path-traversal violation — report opaquely as "missing" (do not leak
		// filesystem layout to the caller).
		return { ok: false, reason: "missing", path: filePath, detail: "outside runs root" };
	}

	// Resolve symlinks on both runsRoot and the file so the containment check
	// uses consistent physical paths (macOS /var → /private/var etc.).
	let realDir: string;
	let realFilePath: string;
	try {
		realDir = fs.realpathSync(runsRoot);
		realFilePath = fs.realpathSync(filePath);
	} catch {
		return { ok: false, reason: "missing", path: filePath, detail: "unresolvable path" };
	}

	const realRel = path.relative(realDir, realFilePath);
	if (realRel === ".." || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) {
		return { ok: false, reason: "missing", path: filePath, detail: "outside runs root" };
	}

	return loadFile(realFilePath, (raw) => JSON.parse(raw) as RunState);
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
		const loaded = tryReadRunFile(root, path.join(root, file));
		if (loaded.ok && validateRunId(loaded.value.runId) && file === `${loaded.value.runId}.json` &&
			!indexRunIds.has(loaded.value.runId)) {
			entries.push(extractIndexEntry(loaded.value, file));
			indexRunIds.add(loaded.value.runId);
		}
	}

	// Sort by updatedAt desc. Invalid/unreadable files do not consume the limit:
	// otherwise one corrupt or replaced high-ranked entry could hide healthy
	// history that follows it.
	// Filter out entries with non-numeric/NaN updatedAt BEFORE sorting to
	// prevent NaN from corrupting V8's sort order (which can displace valid
	// entries when a limit is applied).
	const valid = entries.filter((e) => typeof e.updatedAt === "number" && !Number.isNaN(e.updatedAt));
	valid.sort((a, b) => b.updatedAt - a.updatedAt);
	const targetLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : valid.length;

	// Read full RunState for each entry.
	const runs: RunState[] = [];
	for (const e of valid) {
		if (runs.length >= targetLimit) break;
		const loaded = tryReadRunFile(root, runIndexFilePath(root, e.relPath));
		if (loaded.ok && loaded.value.runId === e.runId) runs.push(loaded.value);
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
export type ProcessLiveness = "alive" | "dead" | "unknown";

export function probeProcess(
	pid: number,
	signalZero: (pid: number, signal: 0) => unknown = (candidate, signal) => process.kill(candidate, signal),
): ProcessLiveness {
	// Node/libuv rejects values outside the signed 32-bit PID range before an
	// OS probe occurs; those are definitively not live process identifiers.
	if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return "dead";
	try {
		signalZero(pid, 0);
		return "alive";
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error
			? String((error as { code?: unknown }).code ?? "")
			: "";
		if (code === "ESRCH") return "dead";
		// EPERM proves that a process exists but its identity is not observable.
		// Unknown platform errors must likewise never terminalize a live run.
		return "unknown";
	}
}

/** Back-compatible boolean probe. Unknown is conservatively treated as alive. */
export function isProcessAlive(pid: number): boolean {
	return probeProcess(pid) !== "dead";
}

/**
 * Write a file atomically: write to a unique temp file in the same directory,
 * then rename over the target (rename is atomic on the same filesystem). Prevents
 * a crash or concurrent write from leaving a half-written, corrupt JSON file.
 */
export function writeFileAtomic(filePath: string, data: string, guard?: () => void): void {
	// Ensure parent directory exists.
	guard?.();
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	guard?.();
	const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
	let fd: number | undefined;
	try {
		guard?.();
		// Open the unique temp path without following a pre-existing leaf and write
		// through the descriptor. If the parent is renamed/replaced after open,
		// the descriptor remains bound to the original directory's file instead of
		// redirecting content through a new symlinked lexical path.
		const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
		fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o666);
		// Close the final pre-open race: if the lexical parent changed between the
		// prior guard and openSync, fail before any definition bytes reach the fd.
		guard?.();
		fs.writeFileSync(fd, data, "utf-8");
		fs.closeSync(fd);
		fd = undefined;
		// The directory can be renamed/replaced while the temp file is written.
		// Revalidate immediately before the externally visible rename; on failure
		// the guarded path is left untouched and no file is promoted.
		guard?.();
		fs.renameSync(tmp, filePath);
	} catch (e) {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* ignore close failure */ }
		}
		// A guarded caller is protecting a directory-identity boundary. Once a
		// guard or write fails, the lexical temp path may already resolve through
		// a replacement directory/symlink; unlinking it could delete an unrelated
		// external same-name file. Fail closed and leave any temp artifact in the
		// original (possibly displaced) directory. Unguarded legacy callers keep
		// the original best-effort cleanup behavior.
		if (!guard) {
			try {
				if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
			} catch {
				/* ignore cleanup failure */
			}
		}
		throw e;
	}
}
