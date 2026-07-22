/**
 * Artifact URI / path ACL (fail-closed).
 * Rejects traversal, absolute escapes, and symlink escapes outside the project root.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type ArtifactUriDecision =
	| { ok: true; resolved: string; uri: string }
	| { ok: false; reason: string };

const SCHEME_RE = /^(file|artifact):\/\//i;

/**
 * Validate an artifact reference relative to projectRoot.
 * Accepts relative paths or file:// / artifact:// URIs.
 */
export function validateArtifactUri(
	projectRoot: string,
	ref: string,
	opts?: { mustExist?: boolean },
): ArtifactUriDecision {
	if (typeof ref !== "string" || ref.length === 0) {
		return { ok: false, reason: "empty artifact ref" };
	}
	if (ref.includes("\0")) {
		return { ok: false, reason: "NUL in artifact ref" };
	}

	let raw = ref;
	if (SCHEME_RE.test(raw)) {
		raw = raw.replace(SCHEME_RE, "");
		// file:///abs or file://host/abs — only local paths
		if (raw.startsWith("/")) {
			// absolute after strip
		} else if (raw.includes(":/")) {
			return { ok: false, reason: "non-local artifact URI host not allowed" };
		}
	}

	if (raw.includes("..")) {
		// Normalize and check containment — still reject obvious traversal tokens early
		// after resolve we re-check
	}

	// Use realpath of project root when available so macOS /var → /private/var matches.
	let root = path.resolve(projectRoot);
	try {
		if (fs.existsSync(root)) root = fs.realpathSync(root);
	} catch {
		/* keep resolve() */
	}
	const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);

	// Containment: resolved path must be under project root
	const rel = path.relative(root, candidate);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		return { ok: false, reason: `artifact path escapes project root: ${ref}` };
	}

	// Symlink escape: realpath of parent chain must stay inside root when exists
	try {
		if (fs.existsSync(candidate)) {
			const real = fs.realpathSync(candidate);
			const relReal = path.relative(root, real);
			if (relReal.startsWith("..") || path.isAbsolute(relReal)) {
				return { ok: false, reason: `artifact symlink escapes project root: ${ref}` };
			}
		} else if (opts?.mustExist) {
			return { ok: false, reason: `artifact does not exist: ${ref}` };
		} else {
			// Ensure parent of non-existing path doesn't escape via symlink
			let parent = path.dirname(candidate);
			while ((parent === root || parent.startsWith(root + path.sep)) && parent !== path.dirname(parent)) {
				if (fs.existsSync(parent)) {
					const realParent = fs.realpathSync(parent);
					const relP = path.relative(root, realParent);
					if (relP.startsWith("..") || path.isAbsolute(relP)) {
						return { ok: false, reason: `artifact parent symlink escapes project root: ${ref}` };
					}
					break;
				}
				const next = path.dirname(parent);
				if (next === parent) break;
				parent = next;
			}
		}
	} catch (e) {
		return {
			ok: false,
			reason: `artifact path unreadable: ${e instanceof Error ? e.message : String(e)}`,
		};
	}

	const resolved = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate;
	const relOut = path.relative(root, resolved);
	return {
		ok: true,
		resolved,
		uri: `artifact://${relOut.split(path.sep).join("/")}`,
	};
}
