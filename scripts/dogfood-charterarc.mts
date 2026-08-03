import { createHash } from "node:crypto";
import { globSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProject } from "charterarc";
import { discoverAgents } from "taskflow-core";
import { grokSubagentRunner } from "taskflow-hosts/grok";
import project from "../charterarc.project.ts";

/** Defaults Grok sandbox profiles for self-dogfood; preserves operator overrides. */
export function configureDogfoodGrokSandbox(env: NodeJS.ProcessEnv = process.env): void {
	env.PI_TASKFLOW_GROK_MUTATING_SANDBOX_PROFILE ??= "charterarc-self-write";
	env.PI_TASKFLOW_GROK_READONLY_SANDBOX_PROFILE ??= "charterarc-self-review";
}

/** Immutable acceptance is verified outside the model-owned Taskflow. */
export function dogfoodAcceptanceDigest(cwd: string): string {
	const root = path.join(cwd, "packages/charterarc/test");
	const entries = globSync("**/*", { cwd: root, withFileTypes: true })
		.map((entry) => {
			const file = path.join(entry.parentPath, entry.name);
			return { entry, file, relative: path.relative(root, file) };
		})
		.sort((a, b) => a.relative.localeCompare(b.relative));
	const digest = createHash("sha256");
	for (const { entry, file, relative } of entries) {
		digest.update(relative);
		digest.update("\0");
		if (entry.isFile()) digest.update(readFileSync(file));
		else if (entry.isSymbolicLink()) digest.update(`link:${readlinkSync(file)}`);
		else digest.update("directory");
		digest.update("\0");
	}
	return digest.digest("hex");
}

async function main(): Promise<void> {
	configureDogfoodGrokSandbox();
	const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const acceptanceBefore = dogfoodAcceptanceDigest(cwd);
	const outcome = await runProject(project, {
		observeTimeoutMs: 120_000,
		taskflow: {
			cwd,
			agents: discoverAgents(cwd, "project").agents,
			runTask: grokSubagentRunner.runTask,
			usageAccounting: grokSubagentRunner.usageAccounting,
		},
	});
	const acceptanceAfter = dogfoodAcceptanceDigest(cwd);
	const acceptanceUnchanged = acceptanceBefore === acceptanceAfter;
	const reported = acceptanceUnchanged
		? outcome
		: {
				...outcome,
				ok: false,
				governance: {
					acceptanceUnchanged: false,
					summary: "packages/charterarc/test changed during the Grok maintenance Run",
				},
			};

	process.stdout.write(`${JSON.stringify(reported, null, 2)}\n`);
	if (!reported.ok) process.exitCode = 1;
}

if (
	process.argv[1] !== undefined &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	await main();
}
