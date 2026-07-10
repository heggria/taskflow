/**
 * Path safety helpers for CLI -o / new.
 */

import fs from "node:fs";
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
	const realBase = realPathIfExists(base);
	const existing = nearestExisting(target);
	if (realBase && existing) {
		const realExisting = fs.realpathSync(existing);
		const realRel = path.relative(realBase, realExisting);
		if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
			return { ok: false, message: `TFDSL_IO_PATH: output path escapes --cwd through a symlink (${out})` };
		}
	}
	return { ok: true, path: target };
}

export function resolveInput(cwd: string, file: string): string {
	const base = path.resolve(cwd);
	const target = path.isAbsolute(file) ? path.resolve(file) : path.resolve(base, file);
	const rel = path.relative(base, target);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`TFDSL_IO_PATH: input path escapes --cwd (${file})`);
	}
	const realBase = realPathIfExists(base);
	const existing = nearestExisting(target);
	if (realBase && existing) {
		const realTarget = fs.realpathSync(existing);
		const realRel = path.relative(realBase, realTarget);
		if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
			throw new Error(`TFDSL_IO_PATH: input path escapes --cwd through a symlink (${file})`);
		}
	}
	return target;
}

function realPathIfExists(value: string): string | undefined {
	return fs.existsSync(value) ? fs.realpathSync(value) : undefined;
}

function nearestExisting(value: string): string | undefined {
	let cursor = value;
	while (!fs.existsSync(cursor)) {
		const parent = path.dirname(cursor);
		if (parent === cursor) return undefined;
		cursor = parent;
	}
	return cursor;
}
