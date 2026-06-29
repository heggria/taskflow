/**
 * Per-phase workspace isolation ("worktree isolation", STRATEGY H2).
 *
 * By default a phase's `cwd` is a literal path (or inherited from the run).
 * Three reserved keywords ask the runtime to ALLOCATE an isolated working
 * directory for the phase's subagent(s) and tear it down afterwards:
 *
 *   - `"temp"`      — an ephemeral dir under the OS tmpdir; removed when the
 *                     phase finishes (success or failure). For scratch work that
 *                     must not touch the main tree.
 *   - `"dedicated"` — a persistent dir under the run's own state directory
 *                     (`<runs>/ws/<runId>/<phaseId>`); kept after the phase so
 *                     its artifacts survive for inspection / downstream reuse.
 *                     Idempotent across resume (same path for the same phase).
 *   - `"worktree"`  — a real `git worktree` on a throwaway branch, rooted at the
 *                     run's git repo; removed (`git worktree remove --force`)
 *                     when the phase finishes. For changes you want to diff /
 *                     commit / discard in isolation. Falls back to a `temp` dir
 *                     (fail-open) when the base dir is not a git work tree.
 *
 * Invariants honoured (AGENTS.md "Critical invariants"):
 *  - Fail-open: any allocation/teardown error degrades gracefully and never
 *    sinks the phase (a failed allocation falls back to the base cwd).
 *  - No new deps: OS tmpdir via `fs.mkdtemp`, git via `child_process` (already
 *    a peer of the runner). No third-party libraries.
 *  - Resume-safe: `dedicated` is deterministic per (runId, phaseId) so a resume
 *    reuses the same dir; `temp`/`worktree` are re-allocated cleanly.
 *  - Path containment: `dedicated` dirs are contained under the run dir;
 *    sanitized phase ids prevent traversal.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The reserved `cwd` keywords that trigger workspace allocation. */
export const WORKSPACE_KEYWORDS = ["temp", "dedicated", "worktree"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KEYWORDS)[number];

export function isWorkspaceKeyword(cwd: string | undefined): cwd is WorkspaceKind {
	return cwd === "temp" || cwd === "dedicated" || cwd === "worktree";
}

/** A handle to an allocated workspace. `dir` is where the subagent runs. */
export interface Workspace {
	/** Resolved absolute working directory for the phase's subagent(s). */
	dir: string;
	/** What was actually allocated (may differ from requested on fail-open). */
	kind: WorkspaceKind | "inherited";
	/** Idempotent teardown — safe to call once, after the phase completes. */
	teardown(): void;
	/** For `worktree`: the throwaway branch name (diagnostics only). */
	branch?: string;
	/** Non-fatal diagnostic if allocation degraded (e.g. worktree→temp). */
	note?: string;
}

/** A no-op workspace: the phase runs in `baseCwd` and nothing is torn down. */
function inherited(baseCwd: string, note?: string): Workspace {
	return { dir: baseCwd, kind: "inherited", note, teardown() {} };
}

/** Sanitize a phase id for use as a path segment (mirrors safeFlowDirName). */
function safeSegment(id: string): string {
	const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
	return cleaned.slice(0, 100) || "phase";
}

/**
 * Best-effort recursive delete, restricted to dirs we ourselves allocate
 * (under the OS tmpdir or a run's `ws/` tree). The containment check is
 * defense-in-depth: every `dir` passed here is already constructed by this
 * module, but guarding ensures a future caller can't turn `rmrf` into an
 * arbitrary-path delete.
 */
function rmrf(dir: string, allowedRoots?: string[]): void {
	try {
		const resolved = path.resolve(dir);
		const roots = [path.resolve(os.tmpdir()), ...(allowedRoots ?? []).map((r) => path.resolve(r))];
		const contained = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
		if (!contained) return; // refuse to delete outside our own allocation roots
		fs.rmSync(resolved, { recursive: true, force: true });
	} catch {
		/* fail-open: best-effort cleanup */
	}
}

/** Is `dir` inside a git work tree? (cheap, no network, fail-closed to false) */
function isGitRepo(dir: string): boolean {
	try {
		const r = spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], {
			encoding: "utf-8",
			timeout: 5000,
		});
		return r.status === 0 && String(r.stdout).trim() === "true";
	} catch {
		return false;
	}
}

/** The absolute toplevel of the git work tree containing `dir`, or undefined. */
function gitToplevel(dir: string): string | undefined {
	try {
		const r = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
			encoding: "utf-8",
			timeout: 5000,
		});
		if (r.status === 0) return String(r.stdout).trim() || undefined;
	} catch {
		/* fall through */
	}
	return undefined;
}

interface AllocOpts {
	/** The phase's effective base cwd (where it would run without isolation). */
	baseCwd: string;
	/** Run id — anchors `dedicated` dirs and names throwaway worktree branches. */
	runId: string;
	/** Phase id — second path segment / branch suffix. */
	phaseId: string;
	/** The run's state dir root (`runsDir(cwd)`) for `dedicated` workspaces. */
	runsRoot: string;
}

/**
 * Allocate an isolated workspace for a phase. Always returns a usable handle:
 * on any failure it falls back to the base cwd (fail-open) with a `note`.
 */
export function allocateWorkspace(kind: WorkspaceKind, opts: AllocOpts): Workspace {
	const { baseCwd, runId, phaseId, runsRoot } = opts;
	const seg = safeSegment(phaseId);

	if (kind === "temp") {
		try {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-tf-ws-${seg}-`));
			return { dir, kind: "temp", teardown: () => rmrf(dir) };
		} catch (e) {
			return inherited(baseCwd, `temp workspace alloc failed: ${errMsg(e)}`);
		}
	}

	if (kind === "dedicated") {
		try {
			// Deterministic per (runId, phaseId) → resume reuses the same dir.
			const dir = path.join(runsRoot, "ws", safeSegment(runId), seg);
			fs.mkdirSync(dir, { recursive: true });
			// Persistent by design: teardown is a no-op (kept for inspection).
			return { dir, kind: "dedicated", teardown() {} };
		} catch (e) {
			return inherited(baseCwd, `dedicated workspace alloc failed: ${errMsg(e)}`);
		}
	}

	// kind === "worktree"
	if (!isGitRepo(baseCwd)) {
		// Fail-open: not a git repo → degrade to an ephemeral temp dir so the
		// phase still gets isolation (just without git semantics).
		const fb = allocateWorkspace("temp", opts);
		return { ...fb, note: "worktree requested but base cwd is not a git work tree; used a temp dir instead" };
	}
	const top = gitToplevel(baseCwd) ?? baseCwd;
	const branch = `tf/${safeSegment(runId)}/${seg}-${Date.now().toString(36)}`;
	let dir: string;
	try {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-tf-wt-${seg}-`));
	} catch (e) {
		const fb = allocateWorkspace("temp", opts);
		return { ...fb, note: `worktree temp path alloc failed: ${errMsg(e)}` };
	}
	// `git worktree add -b <branch> <dir>` creates the dir's contents itself, so
	// remove the empty mkdtemp dir first and let git recreate it.
	rmrf(dir);
	const add = spawnSync("git", ["-C", top, "worktree", "add", "-b", branch, dir, "HEAD"], {
		encoding: "utf-8",
		timeout: 60000,
	});
	if (add.status !== 0) {
		rmrf(dir);
		const fb = allocateWorkspace("temp", opts);
		return {
			...fb,
			note: `git worktree add failed (${String(add.stderr).trim().slice(0, 200)}); used a temp dir instead`,
		};
	}
	const teardown = () => {
		// Remove the worktree, then delete its throwaway branch. Both best-effort.
		try {
			spawnSync("git", ["-C", top, "worktree", "remove", "--force", dir], { timeout: 30000 });
		} catch {
			/* fall through to rmrf */
		}
		rmrf(dir);
		try {
			spawnSync("git", ["-C", top, "branch", "-D", branch], { timeout: 10000 });
		} catch {
			/* fail-open: leftover branch is harmless */
		}
	};
	return { dir, kind: "worktree", branch, teardown };
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
