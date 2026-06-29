import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { allocateWorkspace, isWorkspaceKeyword, WORKSPACE_KEYWORDS } from "../src/workspace.ts";

function mkTmp(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("isWorkspaceKeyword: only the three reserved values", () => {
	for (const k of WORKSPACE_KEYWORDS) assert.equal(isWorkspaceKeyword(k), true);
	for (const v of ["", "temp/", "./temp", "src", undefined, "TEMP", "git"]) {
		assert.equal(isWorkspaceKeyword(v as string | undefined), false);
	}
});

test("temp: creates an ephemeral dir under tmpdir and teardown removes it", () => {
	const base = mkTmp("tf-ws-base-");
	const runsRoot = mkTmp("tf-ws-runs-");
	try {
		const ws = allocateWorkspace("temp", { baseCwd: base, runId: "r1", phaseId: "p1", runsRoot });
		assert.equal(ws.kind, "temp");
		assert.ok(fs.existsSync(ws.dir), "temp dir exists after alloc");
		assert.ok(ws.dir.startsWith(os.tmpdir()), "temp dir is under the OS tmpdir");
		assert.notEqual(path.resolve(ws.dir), path.resolve(base), "temp dir is not the base cwd");
		ws.teardown();
		assert.equal(fs.existsSync(ws.dir), false, "temp dir removed after teardown");
		// idempotent: a second teardown does not throw
		ws.teardown();
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
		fs.rmSync(runsRoot, { recursive: true, force: true });
	}
});

test("dedicated: persistent, deterministic per (runId, phaseId), survives teardown", () => {
	const base = mkTmp("tf-ws-base-");
	const runsRoot = mkTmp("tf-ws-runs-");
	try {
		const a = allocateWorkspace("dedicated", { baseCwd: base, runId: "run-xyz", phaseId: "audit", runsRoot });
		assert.equal(a.kind, "dedicated");
		assert.ok(fs.existsSync(a.dir));
		assert.ok(a.dir.startsWith(path.join(runsRoot, "ws")), "dedicated dir lives under runsRoot/ws");
		// write an artifact, then "resume": the same (runId, phaseId) yields the same dir
		fs.writeFileSync(path.join(a.dir, "artifact.txt"), "hi");
		a.teardown(); // no-op for dedicated
		assert.ok(fs.existsSync(a.dir), "dedicated dir kept after teardown");
		const b = allocateWorkspace("dedicated", { baseCwd: base, runId: "run-xyz", phaseId: "audit", runsRoot });
		assert.equal(path.resolve(b.dir), path.resolve(a.dir), "same path on re-alloc (resume-safe)");
		assert.equal(fs.readFileSync(path.join(b.dir, "artifact.txt"), "utf-8"), "hi", "artifact preserved across resume");
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
		fs.rmSync(runsRoot, { recursive: true, force: true });
	}
});

test("dedicated: phase id is sanitized into a safe path segment (no traversal)", () => {
	const base = mkTmp("tf-ws-base-");
	const runsRoot = mkTmp("tf-ws-runs-");
	try {
		const ws = allocateWorkspace("dedicated", { baseCwd: base, runId: "r", phaseId: "../../etc/passwd", runsRoot });
		const wsRoot = path.join(runsRoot, "ws");
		assert.ok(
			path.resolve(ws.dir).startsWith(path.resolve(wsRoot) + path.sep),
			`dedicated dir '${ws.dir}' must stay contained under '${wsRoot}'`,
		);
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
		fs.rmSync(runsRoot, { recursive: true, force: true });
	}
});

test("worktree: in a non-git base, falls open to a temp dir with a note", () => {
	const base = mkTmp("tf-ws-base-"); // a bare tmp dir is not a git work tree
	const runsRoot = mkTmp("tf-ws-runs-");
	try {
		const ws = allocateWorkspace("worktree", { baseCwd: base, runId: "r", phaseId: "p", runsRoot });
		assert.equal(ws.kind, "temp", "degrades to a temp dir");
		assert.match(ws.note ?? "", /not a git work tree/i);
		assert.ok(fs.existsSync(ws.dir));
		ws.teardown();
		assert.equal(fs.existsSync(ws.dir), false);
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
		fs.rmSync(runsRoot, { recursive: true, force: true });
	}
});

const hasGit = spawnSync("git", ["--version"], { encoding: "utf-8" }).status === 0;

test("worktree: in a real git repo, creates a worktree on a throwaway branch and removes it", { skip: !hasGit }, () => {
	const repo = mkTmp("tf-ws-repo-");
	const runsRoot = mkTmp("tf-ws-runs-");
	try {
		// Bootstrap a minimal git repo with one commit.
		const run = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf-8" });
		run("init", "-q");
		run("config", "user.email", "t@t.t");
		run("config", "user.name", "t");
		fs.writeFileSync(path.join(repo, "README.md"), "# t\n");
		run("add", "-A");
		run("commit", "-q", "-m", "init");

		const ws = allocateWorkspace("worktree", { baseCwd: repo, runId: "run1", phaseId: "edit", runsRoot });
		assert.equal(ws.kind, "worktree", `expected worktree, got ${ws.kind} (note: ${ws.note})`);
		assert.ok(fs.existsSync(path.join(ws.dir, "README.md")), "worktree checked out repo contents");
		assert.ok(ws.branch, "throwaway branch name recorded");

		// The worktree appears in `git worktree list`.
		const listed = spawnSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf-8" }).stdout;
		assert.ok(listed.includes(ws.dir) || listed.includes(fs.realpathSync(ws.dir)), "worktree is registered");

		ws.teardown();
		assert.equal(fs.existsSync(ws.dir), false, "worktree dir removed after teardown");
		const after = spawnSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf-8" }).stdout;
		assert.equal(after.includes(ws.dir), false, "worktree deregistered");
		const branches = spawnSync("git", ["-C", repo, "branch", "--list", ws.branch!], { encoding: "utf-8" }).stdout;
		assert.equal(branches.trim(), "", "throwaway branch deleted");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(runsRoot, { recursive: true, force: true });
	}
});
