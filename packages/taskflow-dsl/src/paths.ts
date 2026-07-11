/**
 * Path safety helpers for CLI -o / new.
 */

import fs from "node:fs";
import path from "node:path";

export interface AtomicOutputOptions {
	/** Replace an existing regular file. Symlink outputs are always rejected. */
	force?: boolean;
}

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

/** Validate containment, symlink policy, and overwrite intent without writing. */
export function assertContainedOutputWritable(
	cwd: string,
	out: string,
	opts: AtomicOutputOptions = {},
): string {
	const resolved = resolveContainedOut(cwd, out);
	if (!resolved.ok) throw new Error(resolved.message);
	let existing: fs.Stats | undefined;
	try {
		existing = fs.lstatSync(resolved.path);
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	if (existing?.isSymbolicLink()) {
		throw new Error(`TFDSL_IO_PATH: refusing symlink output (${out})`);
	}
	if (existing && !existing.isFile()) {
		throw new Error(`TFDSL_IO_TYPE: refusing to replace non-regular output ${resolved.path}`);
	}
	if (existing && !opts.force) {
		throw new Error(`TFDSL_IO_EXISTS: refusing to overwrite ${resolved.path} (use --force)`);
	}
	return resolved.path;
}

/**
 * Write a CLI output beneath `cwd` without exposing a partially-written file.
 *
 * The default is create-only: `linkSync` commits the completed temporary file
 * and atomically fails with EEXIST if another file appeared after validation.
 * `force` uses an atomic rename, but still refuses a symlink at the destination
 * so an output option can never be used to follow a link outside `cwd`.
 */
export function writeContainedFileAtomic(
	cwd: string,
	out: string,
	content: string,
	opts: AtomicOutputOptions = {},
): string {
	const target = assertContainedOutputWritable(cwd, out, opts);
	const parent = path.dirname(target);
	fs.mkdirSync(parent, { recursive: true });

	// Revalidate after mkdir: every parent now exists, so symlink traversal is
	// checked all the way to the destination immediately before the write.
	const checked = assertContainedOutputWritable(cwd, path.relative(path.resolve(cwd), target), opts);
	if (checked !== target) throw new Error(`TFDSL_IO_PATH: output path changed during validation (${out})`);

	const temp = path.join(parent, `.${path.basename(target)}.${process.pid}.${randomSuffix()}.tmp`);
	let fd: number | undefined;
	let committed = false;
	try {
		fd = fs.openSync(temp, "wx", 0o666);
		fs.writeFileSync(fd, content, "utf8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;

		// Catch a parent directory swapped to a symlink while the temp file was
		// being written. The final operation itself is atomic.
		assertContainedOutputWritable(cwd, path.relative(path.resolve(cwd), target), opts);

		if (opts.force) {
			fs.renameSync(temp, target);
		} else {
			try {
				fs.linkSync(temp, target);
			} catch (error) {
				if (isAlreadyExists(error)) {
					throw new Error(`TFDSL_IO_EXISTS: refusing to overwrite ${target} (use --force)`);
				}
				throw error;
			}
			fs.unlinkSync(temp);
		}
		committed = true;
		return target;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		if (!committed || fs.existsSync(temp)) {
			try {
				fs.unlinkSync(temp);
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
		}
	}
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

function randomSuffix(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}
