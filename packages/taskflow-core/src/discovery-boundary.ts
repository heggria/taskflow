/**
 * Shared walk-up discovery boundaries for project-local `.pi` trees.
 *
 * Never inherit `~/.pi` or the shared OS temp root while climbing ancestors.
 * Canonicalize paths so relative cwd / symlink aliases cannot bypass stops.
 * Reject a candidate `.pi` that is a symlink escaping the project directory
 * (or resolving to the user/temp `.pi` trees).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function canonicalDiscoveryPath(input: string): string {
	const absolute = path.resolve(input);
	try {
		return fs.realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

export function sameDiscoveryPath(a: string, b: string): boolean {
	if (process.platform === "win32") return a.toLowerCase() === b.toLowerCase();
	return a === b;
}

function isWithinRoot(root: string, candidate: string): boolean {
	const rel = path.relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export interface ProjectDotPiHit {
	/** Absolute path to the accepted `.pi` directory (physical when resolvable). */
	dotPiDir: string;
	/** Directory that contained the accepted `.pi` entry (walk stop). */
	projectDir: string;
}

/**
 * Walk from `cwd` toward filesystem root looking for a usable `.pi` directory.
 * Stops before home and OS temp roots. Returns null when none found.
 */
export function findProjectDotPiDir(cwd: string): ProjectDotPiHit | null {
	const home = canonicalDiscoveryPath(os.homedir());
	const tempRoot = canonicalDiscoveryPath(os.tmpdir());
	const homeDotPi = path.join(home, ".pi");
	const tempDotPi = path.join(tempRoot, ".pi");
	let dir = canonicalDiscoveryPath(cwd);

	while (true) {
		if (sameDiscoveryPath(dir, home) || sameDiscoveryPath(dir, tempRoot)) break;

		const candidate = path.join(dir, ".pi");
		if (fs.existsSync(candidate)) {
			const accepted = acceptProjectDotPi(candidate, dir, homeDotPi, tempDotPi);
			if (accepted) return { dotPiDir: accepted, projectDir: dir };
		}

		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function acceptProjectDotPi(
	candidate: string,
	projectDir: string,
	homeDotPi: string,
	tempDotPi: string,
): string | null {
	let physical: string;
	try {
		const st = fs.lstatSync(candidate);
		if (st.isSymbolicLink()) {
			physical = fs.realpathSync(candidate);
		} else if (st.isDirectory()) {
			try {
				physical = fs.realpathSync.native(candidate);
			} catch {
				physical = path.resolve(candidate);
			}
		} else {
			return null;
		}
	} catch {
		return null;
	}

	// Never treat the user/temp convention trees as a project marker via symlink.
	if (sameDiscoveryPath(physical, homeDotPi) || sameDiscoveryPath(physical, tempDotPi)) return null;
	// Symlink (or mount) must stay inside the project directory that owns the marker.
	if (!isWithinRoot(projectDir, physical)) return null;
	return physical;
}

/** Project-scope `taskflows` dir, or null. */
export function findProjectTaskflowsDir(cwd: string): string | null {
	const hit = findProjectDotPiDir(cwd);
	return hit ? path.join(hit.dotPiDir, "taskflows") : null;
}

/** Project-scope `taskflows/verifiers` dir, or null. */
export function findProjectVerifiersDir(cwd: string): string | null {
	const base = findProjectTaskflowsDir(cwd);
	return base ? path.join(base, "verifiers") : null;
}

/** Project-scope `agents` dir, or null. */
export function findProjectAgentsDir(cwd: string): string | null {
	const hit = findProjectDotPiDir(cwd);
	return hit ? path.join(hit.dotPiDir, "agents") : null;
}
