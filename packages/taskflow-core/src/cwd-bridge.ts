/**
 * 0.2.1 compatibility bridge for a phase cwd selected by one typed argument.
 *
 * This is deliberately narrower than general string interpolation:
 * `cwd` may be exactly `{args.X}`, and X must be declared as a
 * `relative-path`.  Resolution is anchored to the invocation root, requires an
 * existing directory, and rejects lexical and symlink escapes.
 *
 * Path resolution is defense in depth, not a filesystem sandbox.  The bridge
 * therefore stays disabled unless the host explicitly opts into the documented
 * `resolve-only` execution mode.  A future sandbox backend may add a stronger
 * mode after host conformance evidence exists.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const CWD_BRIDGE_MODE_ENV = "TASKFLOW_CWD_BRIDGE_MODE";
export type CwdBridgeMode = "resolve-only";

const EXACT_CWD_ARG_RE = /^\{args\.([a-zA-Z0-9_-]+)\}$/;
const WINDOWS_RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
const WINDOWS_FORBIDDEN_CHAR_RE = /[<>:"|?*]/;

export interface ResolvedCwdArg {
	argName: string;
	/** NFC-normalized, portable `/`-separated value used for diagnostics. */
	logicalPath: string;
	/** Canonical existing directory below the canonical invocation root. */
	absolutePath: string;
}

/** Persistable identity for an invocation-root directory binding. */
export interface DirectoryIdentity {
	canonicalPath: string;
	device: string;
	inode: string;
}

export function directoryIdentity(dir: string): DirectoryIdentity | undefined {
	try {
		const canonicalPath = fs.realpathSync(dir);
		const stat = fs.statSync(canonicalPath, { bigint: true });
		if (!stat.isDirectory()) return undefined;
		return { canonicalPath, device: stat.dev.toString(), inode: stat.ino.toString() };
	} catch {
		return undefined;
	}
}

export type CwdBridgeResult =
	| { ok: true; value: ResolvedCwdArg }
	| { ok: false; code: "TF_CWD_BRIDGE_DISABLED" | "TF_CWD_ARG_MISSING" | "TF_CWD_ARG_INVALID" | "TF_CWD_TARGET_INVALID"; message: string };

/** Return the selected arg name only for the exact whole-placeholder form. */
export function cwdArgName(cwd: string | undefined): string | undefined {
	if (typeof cwd !== "string") return undefined;
	return cwd.match(EXACT_CWD_ARG_RE)?.[1];
}

/** True when cwd contains interpolation syntax but is not the supported form. */
export function hasCwdPlaceholder(cwd: string): boolean {
	return /\{[^{}]+\}/.test(cwd);
}

/**
 * Validate and normalize a portable relative directory selector.
 *
 * The grammar intentionally rejects host-dependent spellings (backslashes,
 * drive/UNC/device paths, empty/dot segments, and Windows-reserved names) so a
 * flow cannot mean different locations on different hosts.
 */
export function normalizeRelativePath(value: unknown):
	| { ok: true; value: string }
	| { ok: false; message: string } {
	if (typeof value !== "string") {
		return { ok: false, message: `must be a string, got ${value === null ? "null" : typeof value}` };
	}
	const normalized = value.normalize("NFC");
	if (normalized.length === 0) return { ok: false, message: "must not be empty" };
	if (normalized.includes("\0")) return { ok: false, message: "must not contain NUL" };
	if (/[\u0001-\u001f\u007f]/.test(normalized)) return { ok: false, message: "must not contain control characters" };
	if (normalized.includes("\\")) return { ok: false, message: "must use portable '/' separators, not backslashes" };
	if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
		return { ok: false, message: "must be relative (absolute, drive, UNC, and device paths are forbidden)" };
	}

	const segments = normalized.split("/");
	for (const segment of segments) {
		if (segment.length === 0) return { ok: false, message: "must not contain empty path segments" };
		if (segment === "." || segment === "..") return { ok: false, message: "must not contain '.' or '..' segments" };
		if (segment.endsWith(".") || segment.endsWith(" ")) {
			return { ok: false, message: "segments must not end with a dot or space" };
		}
		if (WINDOWS_FORBIDDEN_CHAR_RE.test(segment) || WINDOWS_RESERVED_NAME_RE.test(segment)) {
			return { ok: false, message: `contains a non-portable segment '${segment}'` };
		}
	}
	return { ok: true, value: segments.join("/") };
}

export function isPathWithin(root: string, candidate: string): boolean {
	const rel = path.relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/** Resolve one typed cwd arg under an existing invocation root, fail-closed. */
export function resolveCwdArg(
	root: string,
	argName: string,
	argValue: unknown,
	mode: CwdBridgeMode | undefined,
): CwdBridgeResult {
	if (mode !== "resolve-only") {
		return {
			ok: false,
			code: "TF_CWD_BRIDGE_DISABLED",
			message:
				`cwd bridge for {args.${argName}} is disabled: no conforming sandbox backend is active. ` +
				`A host operator may explicitly opt into the lower resolve-only guarantee with ${CWD_BRIDGE_MODE_ENV}=resolve-only.`,
		};
	}
	if (argValue === undefined) {
		return { ok: false, code: "TF_CWD_ARG_MISSING", message: `cwd argument '${argName}' is required` };
	}
	const normalized = normalizeRelativePath(argValue);
	if (!normalized.ok) {
		return { ok: false, code: "TF_CWD_ARG_INVALID", message: `cwd argument '${argName}' ${normalized.message}` };
	}

	try {
		const rootReal = fs.realpathSync(root);
		if (!fs.statSync(rootReal).isDirectory()) {
			return { ok: false, code: "TF_CWD_TARGET_INVALID", message: "invocation root is not a directory" };
		}
		const candidate = path.resolve(rootReal, ...normalized.value.split("/"));
		if (!isPathWithin(rootReal, candidate)) {
			return { ok: false, code: "TF_CWD_TARGET_INVALID", message: `cwd argument '${argName}' escapes the invocation root` };
		}
		const targetReal = fs.realpathSync(candidate);
		if (!isPathWithin(rootReal, targetReal)) {
			return { ok: false, code: "TF_CWD_TARGET_INVALID", message: `cwd argument '${argName}' resolves outside the invocation root` };
		}
		if (!fs.statSync(targetReal).isDirectory()) {
			return { ok: false, code: "TF_CWD_TARGET_INVALID", message: `cwd argument '${argName}' does not select a directory` };
		}
		return {
			ok: true,
			value: { argName, logicalPath: normalized.value, absolutePath: targetReal },
		};
	} catch (error) {
		const detail = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code ?? "") : "";
		const suffix = detail ? ` (${detail})` : "";
		return {
			ok: false,
			code: "TF_CWD_TARGET_INVALID",
			message: `cwd argument '${argName}' must select an existing directory inside the invocation root${suffix}`,
		};
	}
}

/** Host-owned opt-in. Flow JSON and invocation args cannot select this mode. */
export function cwdBridgeModeFromEnv(value: string | undefined = process.env[CWD_BRIDGE_MODE_ENV]): CwdBridgeMode | undefined {
	return value === "resolve-only" ? value : undefined;
}
