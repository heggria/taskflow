/**
 * On-demand project mount for taskflowd (single-ingress).
 *
 * A writer may open a *new* MCP/CLI project only when:
 * 1. the client supplies an explicit absolute projectRoot, and
 * 2. that root passes the mount allowlist / containment policy (default deny).
 *
 * Already-mounted roots (operator `--project` / prior on-demand) are reused
 * before any allowlist decision — empty allowlist must not revoke a live mount.
 *
 * Identity is validated against the ControlStore header; the singleton writer
 * remains the sole mutator (no second writer process).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	bootstrapControl,
	type ControlHost,
	type SingletonMutationAuthority,
} from "taskflow-control";

export type MountResult =
	| { ok: true; host: ControlHost; mounted: boolean }
	| { ok: false; code: string; message: string };

/** Env key: path.delimiter-separated absolute roots allowed for on-demand mount. */
export const MOUNT_ALLOW_ROOTS_ENV = "TASKFLOW_DAEMON_MOUNT_ALLOW_ROOTS";

/**
 * Merge explicit allow roots with env. Empty means default deny for on-demand
 * mounts (pre-mounted projectRoots at daemon start are unrelated).
 */
export function resolveMountAllowRoots(
	explicit: readonly string[] | undefined,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const fromOpts = (explicit ?? []).map((r) => r.trim()).filter(Boolean);
	const raw = env[MOUNT_ALLOW_ROOTS_ENV] ?? "";
	const fromEnv = raw
		.split(path.delimiter)
		.map((s) => s.trim())
		.filter(Boolean);
	// Preserve order; de-dupe by resolved path string (lexical, not realpath).
	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of [...fromOpts, ...fromEnv]) {
		const key = path.resolve(r);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(r);
	}
	return out;
}

/**
 * Validate an admit-time projectRoot: must be absolute, existent directory.
 * Returns both the client-resolved form (for ControlStore open/identity) and
 * the realpath (for allowlist containment — defeats symlink escape).
 */
export function validateAbsoluteProjectRoot(
	projectRoot: unknown,
):
	| { ok: true; root: string; realRoot: string }
	| { ok: false; code: string; message: string } {
	if (typeof projectRoot !== "string" || !projectRoot.trim()) {
		return {
			ok: false,
			code: "TF_INVALID_ARGUMENT",
			message: "projectRoot required (absolute path) for on-demand mount",
		};
	}
	if (projectRoot.includes("\0")) {
		return {
			ok: false,
			code: "TF_INVALID_ARGUMENT",
			message: "projectRoot must not contain NUL",
		};
	}
	if (!path.isAbsolute(projectRoot)) {
		return {
			ok: false,
			code: "TF_INVALID_ARGUMENT",
			message: `projectRoot must be absolute (got relative: ${projectRoot})`,
		};
	}
	// Normalize . / .. without following symlinks yet.
	const resolved = path.resolve(projectRoot).replace(/\/$/, "") || path.resolve(projectRoot);
	let real: string;
	try {
		real = fs.realpathSync(resolved);
	} catch {
		return {
			ok: false,
			code: "TF_NOT_FOUND",
			message: `projectRoot does not exist: ${resolved}`,
		};
	}
	let st: fs.Stats;
	try {
		st = fs.statSync(real);
	} catch {
		return {
			ok: false,
			code: "TF_NOT_FOUND",
			message: `projectRoot not accessible: ${real}`,
		};
	}
	if (!st.isDirectory()) {
		return {
			ok: false,
			code: "TF_INVALID_ARGUMENT",
			message: `projectRoot is not a directory: ${real}`,
		};
	}
	return { ok: true, root: resolved, realRoot: real };
}

/**
 * Containment: realProject must equal or lie strictly under realAllow
 * (both realpath-resolved). Default-deny when allowRoots is empty.
 */
export function assertMountAllowed(
	realProjectRoot: string,
	allowRoots: readonly string[],
): { ok: true } | { ok: false; code: string; message: string } {
	if (allowRoots.length === 0) {
		return {
			ok: false,
			code: "TF_POLICY_DENIED",
			message:
				"on-demand mount denied: empty mount allowlist (default deny; set mountAllowRoots or TASKFLOW_DAEMON_MOUNT_ALLOW_ROOTS)",
		};
	}
	const project = realProjectRoot.replace(/\/$/, "") || realProjectRoot;
	for (const allow of allowRoots) {
		let realAllow: string;
		try {
			realAllow = fs.realpathSync(path.resolve(allow));
		} catch {
			// Unresolvable allow entry cannot authorize anything.
			continue;
		}
		let st: fs.Stats;
		try {
			st = fs.statSync(realAllow);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		const base = realAllow.replace(/\/$/, "") || realAllow;
		if (project === base) return { ok: true };
		const prefix = base.endsWith(path.sep) ? base : base + path.sep;
		if (project.startsWith(prefix)) return { ok: true };
	}
	return {
		ok: false,
		code: "TF_POLICY_DENIED",
		message: `on-demand mount denied: projectRoot outside mount allowlist: ${project}`,
	};
}

/**
 * True when two absolute roots refer to the same directory.
 *
 * Identity is established by (device, inode) when both paths exist — not by
 * string equality of `realpath` alone. On case-insensitive volumes (APFS,
 * HFS+, default macOS), two spellings of one path share an inode but
 * `realpathSync` can return different case forms, so string compare falsely
 * reports "different projects" and empty-allowlist reuse falls through to
 * TF_POLICY_DENIED.
 */
export function sameProjectRoot(a: string, b: string): boolean {
	const ra = path.resolve(a).replace(/\/$/, "") || path.resolve(a);
	const rb = path.resolve(b).replace(/\/$/, "") || path.resolve(b);
	if (ra === rb) return true;
	try {
		const sa = fs.statSync(ra);
		const sb = fs.statSync(rb);
		if (
			sa.isDirectory() &&
			sb.isDirectory() &&
			sa.dev === sb.dev &&
			sa.ino === sb.ino
		) {
			return true;
		}
	} catch {
		/* fall through to realpath string compare */
	}
	try {
		const realA = fs.realpathSync(ra).replace(/\/$/, "") || fs.realpathSync(ra);
		const realB = fs.realpathSync(rb).replace(/\/$/, "") || fs.realpathSync(rb);
		return realA === realB;
	} catch {
		return false;
	}
}

export interface MountProjectOptions {
	/** Already-mounted hosts keyed by projectId (mutated on success). */
	hosts: Map<string, ControlHost>;
	env: NodeJS.ProcessEnv;
	holderId: string;
	projectRoot: string;
	/** When client supplies projectId, opened store must match. */
	expectedProjectId?: string;
	/**
	 * Absolute roots under which on-demand mounts are permitted.
	 * Empty = default deny.
	 */
	allowRoots: readonly string[];
	/** Parent singleton fence — daemon already holds the user-level writer lock. */
	mutationAuthority?: () => boolean;
	mutationFence?: <T>(fn: () => T) => T;
	mutationCapability?: SingletonMutationAuthority;
}

/**
 * Open (or reuse) a ControlHost for projectRoot under the daemon writer.
 * Never creates a second writer process — only mounts into the existing map.
 *
 * Order is intentional:
 * 1. validate absolute projectRoot identity,
 * 2. **reuse an already-mounted host** (operator pre-mount / prior on-demand),
 * 3. only then apply the on-demand allowlist for a *first-time* open.
 *
 * A project the operator already mounted via `--project` / projectRoots must
 * stay usable even when the allowlist is empty (default deny for new mounts).
 */
export function mountProject(opts: MountProjectOptions): MountResult {
	const validated = validateAbsoluteProjectRoot(opts.projectRoot);
	if (!validated.ok) return validated;

	const root = validated.root;

	// Reuse before allowlist: pre-mounted roots are operator-authorized already.
	for (const existing of opts.hosts.values()) {
		if (sameProjectRoot(existing.store.projectRoot, root)) {
			if (opts.expectedProjectId && existing.projectId !== opts.expectedProjectId) {
				return {
					ok: false,
					code: "TF_IDENTITY_MISMATCH",
					message: `mounted projectId ${existing.projectId} !== requested ${opts.expectedProjectId}`,
				};
			}
			return { ok: true, host: existing, mounted: false };
		}
	}

	// If expected projectId is already mounted at a different path — deny (no silent rebind).
	if (opts.expectedProjectId) {
		const byId = opts.hosts.get(opts.expectedProjectId);
		if (byId) {
			if (!sameProjectRoot(byId.store.projectRoot, root)) {
				return {
					ok: false,
					code: "TF_IDENTITY_MISMATCH",
					message: `projectId ${opts.expectedProjectId} already mounted at ${byId.store.projectRoot}, not ${root}`,
				};
			}
			return { ok: true, host: byId, mounted: false };
		}
	}

	// First-time open only: default-deny empty allowlist / containment policy.
	const policy = assertMountAllowed(validated.realRoot, opts.allowRoots);
	if (!policy.ok) return policy;

	let host: ControlHost;
	try {
		const boot = bootstrapControl({
			projectRoot: root,
			controlMode: "auto",
			env: opts.env,
			// Daemon already holds the user singleton writer lock.
			skipSingleton: true,
			holderId: `${opts.holderId}:${root}`,
			mutationAuthority: opts.mutationAuthority,
			mutationFence: opts.mutationFence,
			mutationCapability: opts.mutationCapability,
		});
		host = boot.host;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		const code =
			e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string"
				? (e as { code: string }).code
				: "TF_BOOTSTRAP_FAILED";
		return { ok: false, code, message: msg };
	}

	if (opts.expectedProjectId && host.projectId !== opts.expectedProjectId) {
		host.close();
		return {
			ok: false,
			code: "TF_IDENTITY_MISMATCH",
			message: `ControlStore projectId ${host.projectId} !== requested ${opts.expectedProjectId} at ${root}`,
		};
	}

	// Race: another concurrent mount may have won the same projectId.
	const raced = opts.hosts.get(host.projectId);
	if (raced && raced !== host) {
		if (sameProjectRoot(raced.store.projectRoot, root)) {
			host.close();
			return { ok: true, host: raced, mounted: false };
		}
		host.close();
		return {
			ok: false,
			code: "TF_IDENTITY_MISMATCH",
			message: `projectId ${host.projectId} already mounted at ${raced.store.projectRoot}`,
		};
	}

	opts.hosts.set(host.projectId, host);
	return { ok: true, host, mounted: true };
}
