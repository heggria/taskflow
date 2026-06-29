/**
 * Resolve the base directory where taskflow persists saved flows and discovers
 * user agents. Vendored so taskflow-core does not import the pi host SDK.
 *
 * Resolution order (first hit wins):
 *   1. `TASKFLOW_AGENT_DIR`        — host-neutral override (codex, tests, …)
 *   2. `PI_CODING_AGENT_DIR`       — pi's own override (keeps pi users' existing
 *                                     `~/.pi/agent/taskflows` working)
 *   3. `~/.pi/agent`               — the historical default
 *
 * A host adapter can also inject a dir explicitly via `setAgentDir()` at
 * startup; that takes precedence over the env vars. Keeping the default at
 * `~/.pi/agent` means a user who upgrades from the single-package pi-taskflow
 * still finds every saved flow exactly where it was.
 */

import { homedir } from "node:os";
import { join } from "node:path";

let injectedDir: string | undefined;

/** Expand a leading `~` to the user's home directory. */
function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

/**
 * Override the agent dir for the current process (host adapters call this once
 * at startup). Pass `undefined` to clear and fall back to env / default.
 */
export function setAgentDir(dir: string | undefined): void {
	injectedDir = dir ? expandTilde(dir) : undefined;
}

/** The base directory for taskflow persistence + user-agent discovery. */
export function getAgentDir(): string {
	if (injectedDir) return injectedDir;
	const envDir = process.env.TASKFLOW_AGENT_DIR || process.env.PI_CODING_AGENT_DIR;
	if (envDir) return expandTilde(envDir);
	return join(homedir(), ".pi", "agent");
}
