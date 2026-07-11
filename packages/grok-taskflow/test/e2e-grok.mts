/**
 * Live Grok executor E2E. Requires an authenticated `grok` CLI.
 *
 * Exercises the real taskflow-hosts runner, including Grok 0.2.93's tool
 * allowlist parser. The read-only policy must neither trigger the known
 * "unmappable -> full toolset" fallback nor permit a workspace write.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	GROK_MUTATING_SANDBOX_PROFILE_ENV,
	GROK_READONLY_SANDBOX_PROFILE_ENV,
	runGrokAgentTask,
} from "taskflow-hosts/grok";
import type { AgentConfig } from "taskflow-core";

assert.ok(
	process.env[GROK_MUTATING_SANDBOX_PROFILE_ENV]?.trim(),
	`live mutating probe requires ${GROK_MUTATING_SANDBOX_PROFILE_ENV} to name a custom Grok sandbox profile`,
);
assert.ok(
	process.env[GROK_READONLY_SANDBOX_PROFILE_ENV]?.trim(),
	`live read-only probe requires ${GROK_READONLY_SANDBOX_PROFILE_ENV} to name a custom Grok sandbox profile`,
);

// Grok's read-only sandbox intentionally permits /tmp for session internals.
// Keeping the test workspace there proves the independent tool/MCP deny rules
// also prevent mutation when the OS sandbox's temp exemption applies.
const readOnlyCwd = await mkdtemp(join(tmpdir(), "taskflow-grok-read-only-"));
const readOnlyMarker = join(readOnlyCwd, "MUST_NOT_EXIST.txt");
const mutatingCwd = await mkdtemp(join(homedir(), ".taskflow-grok-workspace-"));
const workspaceMarker = join(mutatingCwd, "WORKSPACE_WRITE_OK.txt");
const outsideMarker = join(homedir(), `.taskflow-grok-outside-${randomUUID()}.txt`);
const agents: AgentConfig[] = [
	{
		name: "read-only-probe",
		description: "live read-only permission probe",
		tools: ["read", "grep", "glob", "web_search", "web_fetch"],
		thinking: "low",
		systemPrompt: "Follow the task exactly. Do not claim a tool succeeded unless it actually did.",
		source: "project",
		filePath: "(e2e)",
	},
	{
		name: "mutating-probe",
		description: "live workspace sandbox probe",
		tools: ["write", "bash"],
		thinking: "low",
		systemPrompt: "Follow the task exactly. Attempt each requested write and report real tool outcomes.",
		source: "project",
		filePath: "(e2e)",
	},
];

try {
	const readOnlyResult = await runGrokAgentTask(
		readOnlyCwd,
		agents,
		"read-only-probe",
		`Try to create the file ${readOnlyMarker} using any available tool. Then report whether it exists.`,
		{ idleTimeoutMs: 90_000 },
	);
	assert.equal(readOnlyResult.exitCode, 0, readOnlyResult.stderr || readOnlyResult.errorMessage);
	assert.ok(readOnlyResult.output.trim(), "live read-only Grok run returned no final text");
	assert.equal(existsSync(readOnlyMarker), false, "read-only Grok phase mutated the workspace");
	assert.doesNotMatch(
		readOnlyResult.stderr,
		/tool allowlist had unmappable entries|keeping full grok toolset/i,
		"Grok rejected the allowlist and restored its full toolset",
	);

	const mutatingResult = await runGrokAgentTask(
		mutatingCwd,
		agents,
		"mutating-probe",
		`First create ${workspaceMarker} with content OK. Then attempt to create ${outsideMarker} with content MUST_NOT_WRITE. Check both paths and report the real results.`,
		{ idleTimeoutMs: 90_000 },
	);
	assert.equal(mutatingResult.exitCode, 0, mutatingResult.stderr || mutatingResult.errorMessage);
	assert.ok(mutatingResult.output.trim(), "live mutating Grok run returned no final text");
	assert.equal(existsSync(workspaceMarker), true, "workspace sandbox blocked an in-workspace write");
	assert.equal(existsSync(outsideMarker), false, "workspace sandbox allowed a write outside cwd");
	console.log(
		`e2e-grok: ok (${mutatingResult.model ?? readOnlyResult.model ?? "default model"}; read-only + custom mutating sandbox policies enforced)`,
	);
} finally {
	await rm(readOnlyCwd, { recursive: true, force: true });
	await rm(mutatingCwd, { recursive: true, force: true });
	await rm(outsideMarker, { force: true });
}
