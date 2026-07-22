/**
 * Project control-domain identity (P3 / D6).
 *
 * Copy/clone/worktree of a ControlStore must never silently share the same
 * projectId/controlDomainId authority domain. Open either refuses (strict),
 * rebinds path for the same identity (explicit move), or mints a new identity.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ControlStoreHeader, DirectoryBinding } from "./types.ts";

export type IdentityOpenPolicy = "strict" | "rebind" | "new-identity";

export class IdentityMismatchError extends Error {
	readonly code = "TF_IDENTITY_MISMATCH" as const;
	readonly storedPath: string;
	readonly currentPath: string;
	readonly projectId: string;
	readonly controlDomainId: string;

	constructor(opts: {
		message: string;
		storedPath: string;
		currentPath: string;
		projectId: string;
		controlDomainId: string;
	}) {
		super(opts.message);
		this.name = "IdentityMismatchError";
		this.storedPath = opts.storedPath;
		this.currentPath = opts.currentPath;
		this.projectId = opts.projectId;
		this.controlDomainId = opts.controlDomainId;
	}
}

export function bindDirectory(projectRoot: string): DirectoryBinding {
	const resolved = path.resolve(projectRoot);
	let inode: string | undefined;
	let dev: string | undefined;
	try {
		const st = fs.statSync(resolved);
		inode = String(st.ino);
		dev = String(st.dev);
	} catch {
		/* path may not exist yet */
	}
	return { path: resolved, inode, dev };
}

/**
 * Decide how to treat an existing header when opening at `currentRoot`.
 * - same path: OK (refresh inode evidence)
 * - different path + strict: throw IdentityMismatchError (clone/worktree fail-closed)
 * - different path + rebind: keep identity, update directoryBinding
 * - different path + new-identity: caller must mint new ids (return action)
 */
export function resolveIdentityOnOpen(
	header: ControlStoreHeader,
	currentRoot: string,
	policy: IdentityOpenPolicy = "strict",
): { action: "keep" | "rebind" | "mint-new"; binding: DirectoryBinding } {
	const current = path.resolve(currentRoot);
	const stored = path.resolve(header.directoryBinding.path);
	const binding = bindDirectory(current);

	if (stored === current) {
		return { action: "keep", binding };
	}

	// Path differs — never silently share domain (clone / worktree / copy).
	if (policy === "strict") {
		throw new IdentityMismatchError({
			message:
				`TF_IDENTITY_MISMATCH: ControlStore bound to "${stored}" opened at "${current}". ` +
				`Copy/clone/worktree must not share controlDomainId=${header.controlDomainId}. ` +
				`Use identityPolicy: "rebind" (same domain, path move) or "new-identity" (mint domain).`,
			storedPath: stored,
			currentPath: current,
			projectId: header.projectId,
			controlDomainId: header.controlDomainId,
		});
	}

	if (policy === "rebind") {
		return { action: "rebind", binding };
	}

	// new-identity
	return { action: "mint-new", binding };
}
