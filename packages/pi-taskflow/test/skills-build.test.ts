// Guard: the generated skill files must match what
// scripts/build-skills.mjs produces from skills-src/taskflow/.
//
// The skills are authored ONCE in skills-src/ (single source of truth) and
// compiled per host. Editing a generated file directly, or editing the source
// without rebuilding, silently forks the hosts' documentation — this test
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

test("release discovery metadata advertises the complete MCP surface", async () => {
	const { readFileSync } = await import("node:fs");
	for (const file of [".claude-plugin/marketplace.json", ".grok-plugin/marketplace.json"]) {
		const text = readFileSync(path.join(root, file), "utf8");
		assert.match(text, /20 taskflow_\* MCP tools/);
		assert.match(text, /run\/runs\/resume\/version\/list/);
		assert.match(text, /plan\/analytics/);
		assert.match(text, /why_effect/);
	}
	const piSource = readFileSync(path.join(root, "packages", "pi-taskflow", "src", "index.ts"), "utf8");
	assert.match(piSource, /Use action=resume/);
	assert.match(piSource, /Use action=version/);
	for (const phase of ["agent", "parallel", "map", "gate", "reduce", "approval", "flow", "loop", "tournament", "script", "race", "expand"]) {
		assert.match(piSource, new RegExp(`Phase types:[^\\n]*\\b${phase}\\b`));
	}
});

test("skills: host-conditional filtering removed the other host's content", async () => {
	const { existsSync, readFileSync } = await import("node:fs");
	const piSkill = readFileSync(path.join(root, "packages", "pi-taskflow", "skills", "taskflow", "SKILL.md"), "utf8");
	const piCommands = readFileSync(path.join(root, "packages", "pi-taskflow", "skills", "taskflow", "commands.md"), "utf8");
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
	const gkSkill = readFileSync(
		path.join(root, "packages", "grok-taskflow", "plugin", "skills", "taskflow", "SKILL.md"),
		"utf8",
	);
	const hmSkill = readFileSync(
		path.join(root, "packages", "hermes-taskflow", "plugin", "skills", "taskflow", "SKILL.md"),
		"utf8",
	);
	// No leftover markers in any output.
	for (const [name, text] of [
		["pi", piSkill],
		["codex", cxSkill],
		["claude", clSkill],
		["opencode", ocSkill],
		["grok", gkSkill],
		["hermes", hmSkill],
	] as const) {
		assert.ok(!/<!--\s*\/?host:/.test(text), `${name} SKILL.md must not contain host markers`);
	}
	// The Pi command sidecar is generated only for Pi and is not part of the main skill.
	assert.match(piCommands, /\/tf list/);
	assert.match(piCommands, /\/tf resume/);
	assert.match(piCommands, /\/tf verify <name>/);
	assert.doesNotMatch(piCommands, /\/tf verify(?:\s+—|\s*$)/m);
	assert.doesNotMatch(piSkill, /\/tf(?: |:)/);
	for (const host of ["codex", "claude", "opencode", "grok", "hermes"]) {
		const dir = host === "codex" ? "codex-taskflow/plugin" : `${host}-taskflow/plugin`;
		assert.equal(existsSync(path.join(root, "packages", dir, "skills", "taskflow", "commands.md")), false, `${host} must not receive commands.md`);
	}
	const generatedSkills = [
		["pi", piSkill],
		["codex", cxSkill],
		["claude", clSkill],
		["opencode", ocSkill],
		["grok", gkSkill],
		["hermes", hmSkill],
	] as const;
	for (const [name, text] of generatedSkills) {
		if (name === "pi") {
			assert.match(text, /\| `commands\.md` \|/);
		} else {
			assert.doesNotMatch(text, /\| `commands\.md` \|/, `${name} SKILL.md must not reference commands.md`);
		}
		const description = text.match(/^description:\s*(.+)$/m)?.[1] ?? "";
		assert.match(description, /delegate or orchestrate bounded work with isolated subagents/, `${name} activation description must use bounded delegation`);
		assert.match(description, /cheaper or specialized agents/, `${name} activation description must name a concrete delegation benefit`);
		assert.doesNotMatch(description, /Orchestrate multi-phase subagent workflows/);
		assert.doesNotMatch(description, /Use whenever a request spans a whole project or many items/);
		assert.doesNotMatch(description, /Prefer this over ad-hoc parallel work when the task has multiple phases/);
	}
	// The accepted main-skill structure is exactly nine ordered top-level sections.
	const headings = [...piSkill.matchAll(/^## (\d+\. [^\n]+)/gm)].map((match) => match[1]);
	assert.deepEqual(headings, [
		"1. Decide whether Taskflow helps",
		"2. Choose the smallest useful shape",
		"3. Quick-start examples",
		"4. Proven task patterns",
		"5. Adapt the pattern safely",
		"6. Preflight → verify → plan → run",
		"7. When execution fails",
		"8. Advanced shapes",
		"9. Need more detail?",
	]);
	assert.match(piSkill, /\"name\": \"example-flow\"/);
	assert.match(piSkill, /\{steps\.produce\.output\}/);
	assert.match(piSkill, /\"from\": \[\"inspect-a\", \"inspect-b\"\]/);
	assert.match(piSkill, /\{previous\.output\}/);
	assert.match(piSkill, /per-call `timeout`/);
	assert.match(piSkill, /retry\.max: 0.*automatically retry/s);
	assert.match(piSkill, /user \| project \| both/);
	assert.match(piSkill, /unbounded.*static call estimate/s);
	assert.match(piSkill, /strictInterpolation: true/);
	assert.doesNotMatch(piSkill, /readSeek_|colgrep|hypa_|lens_|context-mode|packages_/);
	assert.doesNotMatch(piSkill, /Actions \(all 20\)/);
	// The MCP hosts teach the MCP tools; pi must not.
	assert.match(cxSkill, /taskflow_verify/);
	assert.match(clSkill, /taskflow_verify/);
	assert.match(ocSkill, /taskflow_verify/);
	assert.match(gkSkill, /taskflow_verify/);
	assert.match(hmSkill, /taskflow_verify/);
	assert.doesNotMatch(piSkill, /taskflow_verify/);
	// Each MCP host names itself, not the others, in its host-binding preamble.
	assert.match(cxSkill, /# Taskflow \(Codex\)/);
	assert.match(clSkill, /# Taskflow \(Claude Code\)/);
	assert.match(ocSkill, /# Taskflow \(OpenCode\)/);
	assert.match(gkSkill, /# Taskflow \(Grok Build\)/);
	assert.match(hmSkill, /# Taskflow \(Hermes Agent\)/);
	assert.doesNotMatch(cxSkill, /claude -p|opencode run|grok -p|hermes chat/);
	assert.doesNotMatch(clSkill, /codex exec|opencode run|grok -p|hermes chat/);
	assert.doesNotMatch(ocSkill, /codex exec|claude -p|grok -p|hermes chat/);
	assert.doesNotMatch(gkSkill, /codex exec|claude -p|opencode run|hermes chat/);
	assert.doesNotMatch(hmSkill, /codex exec|claude -p|opencode run|grok -p/);
	// All hosts share the accepted nine-section body and its DAG semantics.
	for (const text of [piSkill, cxSkill, clSkill, ocSkill, gkSkill, hmSkill]) {
		assert.match(text, /## 1\. Decide whether Taskflow helps/);
		assert.match(text, /## 9\. Need more detail\?/);
		assert.match(text, /Array order is not a dependency/);
		assert.match(text, /\{steps\.produce\.output\}/);
		assert.match(text, /\{previous\.output\}/);
	}
});
