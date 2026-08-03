import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	runProject,
	type ProjectOutcome,
} from "charterarc";
import { discoverAgents } from "taskflow-core";
import { grokSubagentRunner } from "taskflow-hosts/grok";
import project from "../charterarc.project.ts";

export function dogfoodSucceeded(outcome: ProjectOutcome): boolean {
	return outcome.status === "satisfied" &&
		(outcome.before.status === "satisfied" || outcome.run?.ok === true);
}

/** Defaults Grok sandbox profiles for self-dogfood; preserves operator overrides. */
export function configureDogfoodGrokSandbox(env: NodeJS.ProcessEnv = process.env): void {
	env.PI_TASKFLOW_GROK_MUTATING_SANDBOX_PROFILE ??= "charterarc-self-write";
	env.PI_TASKFLOW_GROK_READONLY_SANDBOX_PROFILE ??= "charterarc-self-review";
}

async function main(): Promise<void> {
	configureDogfoodGrokSandbox();
	const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const outcome = await runProject(project, {
		observeTimeoutMs: 120_000,
		taskflow: {
			cwd,
			agents: discoverAgents(cwd, "project").agents,
			runTask: grokSubagentRunner.runTask,
			usageAccounting: grokSubagentRunner.usageAccounting,
		},
	});

	process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
	if (!dogfoodSucceeded(outcome)) process.exitCode = 1;
}

if (
	process.argv[1] !== undefined &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	await main();
}
