// Guard: the generated skill files (pi + codex) must match what
// scripts/build-skills.mjs produces from skills-src/taskflow/.
//
// The skills are authored ONCE in skills-src/ (single source of truth) and
// compiled per host. Editing a generated file directly, or editing the source
// without rebuilding, silently forks the two hosts' documentation — this test
// makes that a CI failure. Fix with: node scripts/build-skills.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("skills: generated skill files are in sync with skills-src (build-skills --check)", () => {
	try {
		execFileSync(process.execPath, [path.join(root, "scripts", "build-skills.mjs"), "--check"], {
			cwd: root,
			stdio: "pipe",
		});
	} catch (e) {
		const err = e as { stdout?: Buffer; stderr?: Buffer };
		const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
		assert.fail(`generated skill files drifted from skills-src:\n${out}\nRun: node scripts/build-skills.mjs`);
	}
});

test("skills: host-conditional filtering removed the other host's content", async () => {
	const { readFileSync } = await import("node:fs");
	const piSkill = readFileSync(path.join(root, "packages", "pi-taskflow", "skills", "taskflow", "SKILL.md"), "utf8");
	const cxSkill = readFileSync(
		path.join(root, "packages", "codex-taskflow", "plugin", "skills", "taskflow", "SKILL.md"),
		"utf8",
	);
	const clSkill = readFileSync(
		path.join(root, "packages", "claude-taskflow", "plugin", "skills", "taskflow", "SKILL.md"),
		"utf8",
	);
	const ocSkill = readFileSync(
		path.join(root, "packages", "opencode-taskflow", "plugin", "skills", "taskflow", "SKILL.md"),
		"utf8",
	);
	// No leftover markers in any output.
	for (const [name, text] of [["pi", piSkill], ["codex", cxSkill], ["claude", clSkill], ["opencode", ocSkill]] as const) {
		assert.ok(!/<!--\s*\/?host:/.test(text), `${name} SKILL.md must not contain host markers`);
	}
	// pi teaches its 13 actions; the MCP hosts must not (they're unreachable via MCP).
	assert.match(piSkill, /Actions \(all 13\)/);
	assert.doesNotMatch(cxSkill, /Actions \(all 13\)/);
	assert.doesNotMatch(clSkill, /Actions \(all 13\)/);
	assert.doesNotMatch(ocSkill, /Actions \(all 13\)/);
	assert.doesNotMatch(cxSkill, /action: "recompute"/);
	// The MCP hosts teach the MCP tools; pi must not.
	assert.match(cxSkill, /taskflow_verify/);
	assert.match(clSkill, /taskflow_verify/);
	assert.match(ocSkill, /taskflow_verify/);
	assert.doesNotMatch(piSkill, /taskflow_verify/);
	// Each MCP host names itself, not the others, in its host-binding preamble.
	assert.match(cxSkill, /# Taskflow \(Codex\)/);
	assert.match(clSkill, /# Taskflow \(Claude Code\)/);
	assert.match(ocSkill, /# Taskflow \(OpenCode\)/);
	assert.doesNotMatch(cxSkill, /claude -p|opencode run/);
	assert.doesNotMatch(clSkill, /codex exec|opencode run/);
	assert.doesNotMatch(ocSkill, /codex exec|claude -p/);
	// All hosts share the same core: flow design ladder + common-mistakes section.
	for (const text of [piSkill, cxSkill, clSkill, ocSkill]) {
		assert.match(text, /Flow design ladder/);
		assert.match(text, /Referencing `\{steps\.X\}` without `dependsOn/);
	}
});
