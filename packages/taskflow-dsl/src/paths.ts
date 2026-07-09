/**
 * Path safety helpers for CLI -o / new.
 */

import path from "node:path";

/** Resolve `out` under `cwd`; reject path escape (e.g. ../../etc/passwd). */
export function resolveContainedOut(cwd: string, out: string): { ok: true; path: string } | { ok: false; message: string } {
	const base = path.resolve(cwd);
	const target = path.resolve(base, out);
	const rel = path.relative(base, target);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		return {
			ok: false,
			message: `TFDSL_IO_PATH: output path escapes --cwd (${out})`,
		};
	}
	return { ok: true, path: target };
}

export function resolveInput(cwd: string, file: string): string {
	return path.isAbsolute(file) ? file : path.resolve(cwd, file);
}
