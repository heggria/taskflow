/**
 * Verifier discovery — convention-based loading of project-local verifiers.
 *
 * Discovers verifier modules from `.pi/taskflows/verifiers/` (project scope)
 * and `~/.pi/taskflows/verifiers/` (user scope). Each `.ts` or `.js` file in
 * the directory is dynamically imported; its default export (or named
 * `verifier` / `verifiers` export) is collected. Project-scope verifiers
 * shadow user-scope verifiers with the same `name`.
 *
 * This is the minimum-viable discovery deferred by #82: convention dir, no
 * config file, no registry. Programmatic registration via
 * `verifyTaskflow(flow, { verifiers })` always takes precedence.
 *
 * Discovery is async (dynamic import) and fail-open: a broken verifier module
 * is skipped with a warning, never crashes the host.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TaskflowVerifier } from "../verify.ts";

/** The convention directory name under `.pi/taskflows/`. */
const VERIFIERS_DIR = "verifiers";

/** Find the project-scope verifiers directory (walk-up, same as flows). */
function findProjectVerifiersDir(cwd: string): string | null {
	const home = os.homedir();
	let dir = cwd;
	while (true) {
		if (dir !== home) {
			const candidate = path.join(dir, ".pi", "taskflows", VERIFIERS_DIR);
			if (fs.existsSync(candidate)) return candidate;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** The user-scope verifiers directory. */
function userVerifiersDir(): string {
	return path.join(os.homedir(), ".pi", "taskflows", VERIFIERS_DIR);
}

/** List verifier files in a directory (`.ts` and `.js`, sorted). */
function listVerifierFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => /\.(ts|js|mjs)$/.test(f) && !f.startsWith("."))
		.sort()
		.map((f) => path.join(dir, f));
}

/** Extract verifiers from a dynamically imported module. */
function extractVerifiers(mod: unknown): TaskflowVerifier[] {
	if (!mod || typeof mod !== "object") return [];
	const m = mod as Record<string, unknown>;
	const result: TaskflowVerifier[] = [];

	// default export: single verifier or array
	if (m.default) {
		if (Array.isArray(m.default)) {
			for (const v of m.default) {
				if (isVerifier(v)) result.push(v);
			}
		} else if (isVerifier(m.default)) {
			result.push(m.default);
		}
	}

	// named `verifier` export: single verifier
	if (m.verifier && isVerifier(m.verifier)) {
		result.push(m.verifier);
	}

	// named `verifiers` export: array
	if (Array.isArray(m.verifiers)) {
		for (const v of m.verifiers) {
			if (isVerifier(v)) result.push(v);
		}
	}

	return result;
}

/** Shape-check a value as a TaskflowVerifier. */
function isVerifier(v: unknown): v is TaskflowVerifier {
	if (!v || typeof v !== "object") return false;
	const obj = v as Record<string, unknown>;
	return typeof obj.name === "string" && typeof obj.verify === "function";
}

export interface DiscoveredVerifiers {
	/** All discovered verifiers, project-scope shadowing user-scope by name. */
	verifiers: TaskflowVerifier[];
	/** Warnings for modules that failed to load or had no valid exports. */
	warnings: string[];
	/** Directories that were scanned. */
	dirs: string[];
}

/**
 * Discover project-local and user-scope verifiers from the convention
 * directories. Fail-open: broken modules are skipped with a warning.
 *
 * Project-scope verifiers shadow user-scope verifiers with the same `name`.
 * Within a scope, files are loaded in sorted order; later files do NOT shadow
 * earlier ones with the same name (first wins within a scope).
 */
export async function discoverVerifiers(cwd: string): Promise<DiscoveredVerifiers> {
	const warnings: string[] = [];
	const dirs: string[] = [];
	const byName = new Map<string, TaskflowVerifier>();

	// Load user-scope first (lower priority), then project-scope (shadows).
	const userDir = userVerifiersDir();
	const projectDir = findProjectVerifiersDir(cwd);

	for (const [scope, dir] of [["user", userDir], ["project", projectDir]] as const) {
		if (!dir || !fs.existsSync(dir)) continue;
		dirs.push(dir);

		for (const file of listVerifierFiles(dir)) {
			try {
				// Dynamic import with file:// URL for ESM compatibility.
				const mod = await import(`file://${file}`);
				const extracted = extractVerifiers(mod);
				if (extracted.length === 0) {
					warnings.push(`${scope} verifier ${path.basename(file)}: no valid TaskflowVerifier export found`);
					continue;
				}
				for (const v of extracted) {
					if (scope === "project" || !byName.has(v.name)) {
						byName.set(v.name, v);
					}
				}
			} catch (e) {
				warnings.push(
					`${scope} verifier ${path.basename(file)}: failed to load (${e instanceof Error ? e.message : String(e)})`,
				);
			}
		}
	}

	return { verifiers: [...byName.values()], warnings, dirs };
}

/**
 * Synchronous variant: discovers verifier files but does NOT import them
 * (import is async). Returns the file paths that would be loaded, for
 * diagnostics / `--list-verifiers` style commands.
 */
export function listVerifierPaths(cwd: string): { project: string[]; user: string[] } {
	const projectDir = findProjectVerifiersDir(cwd);
	return {
		project: projectDir ? listVerifierFiles(projectDir) : [],
		user: listVerifierFiles(userVerifiersDir()),
	};
}
