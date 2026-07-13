import * as fs from "node:fs";
import * as path from "node:path";
import { hasGrantAuthority, readonlyStringSet, type InvocationAuthority } from "./authority.ts";
import { workspacePolicyError, type WorkspacePolicyError } from "./errors.ts";
import { accessAllows, type ResourceVersion, type WorkspaceAccess } from "./schema.ts";

const ROOT_GRANT: unique symbol = Symbol("taskflow.root-grant");
const brandedRootGrants = new WeakSet<object>();

export const ROOT_ENFORCEMENT_MODES = ["native-single-root", "native-multi-root", "resolve-only"] as const;
export type RootEnforcement = (typeof ROOT_ENFORCEMENT_MODES)[number];

export interface RootGrant {
	readonly [ROOT_GRANT]: true;
	readonly grantId: string;
	readonly bindingId: string;
	readonly resourceDomainId: string;
	/** Canonical physical path; runtime-only and never persisted in portable records. */
	readonly physicalRoot: string;
	readonly maxAccess: WorkspaceAccess;
	readonly version?: Readonly<ResourceVersion>;
	readonly allowedPrincipals: ReadonlySet<string>;
	readonly enforcement: RootEnforcement;
}

export interface HostRootGrantInput {
	grantId: string;
	bindingId: string;
	resourceDomainId: string;
	physicalRoot: string;
	maxAccess: WorkspaceAccess;
	version?: ResourceVersion;
	allowedPrincipals: Iterable<string>;
	enforcement: RootEnforcement;
}

export interface RootRegistry {
	readonly registryId: string;
	authorize(
		grantId: string,
		principal: InvocationAuthority,
		requested: WorkspaceAccess,
	): RootGrant | WorkspacePolicyError;
}

export interface RootRegistryInput {
	registryId: string;
	grants: readonly RootGrant[];
}

/** Invalid trusted host policy; detected before an invocation can start. */
export class RootRegistryConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RootRegistryConfigurationError";
	}
}

function logicalId(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0 || value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new RootRegistryConfigurationError(`${field} must be a non-empty logical identifier`);
	}
	return value.normalize("NFC");
}

function validateVersion(version: ResourceVersion | undefined): Readonly<ResourceVersion> | undefined {
	if (version === undefined) return undefined;
	if (!["portable", "path-bound", "unavailable"].includes(version.identityMode)) {
		throw new RootRegistryConfigurationError("root grant version identityMode is invalid");
	}
	if (!Number.isSafeInteger(version.generation) || version.generation < 0) {
		throw new RootRegistryConfigurationError("root grant version generation must be a non-negative safe integer");
	}
	if (!["clean", "write-pending", "dirty-unknown"].includes(version.state)) {
		throw new RootRegistryConfigurationError("root grant version state is invalid");
	}
	for (const [field, value] of [["contentId", version.contentId], ["scopeDigest", version.scopeDigest]] as const) {
		if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
			throw new RootRegistryConfigurationError(`root grant version ${field} must be a non-empty string`);
		}
	}
	return Object.freeze({ ...version });
}

/**
 * Host-only RootGrant constructor.
 *
 * The private symbol plus WeakSet identity make grants non-forgeable by JSON,
 * object spread, structural casts, or structured cloning. Trusted delivery
 * code calls this while loading its local root policy.
 */
export function createHostRootGrant(input: HostRootGrantInput): RootGrant {
	if (!(["read-only", "read-write"] as const).includes(input.maxAccess)) {
		throw new RootRegistryConfigurationError("root grant maxAccess is invalid");
	}
	if (!ROOT_ENFORCEMENT_MODES.includes(input.enforcement)) {
		throw new RootRegistryConfigurationError("root grant enforcement is invalid");
	}

	let physicalRoot: string;
	try {
		physicalRoot = fs.realpathSync(input.physicalRoot);
		if (!fs.statSync(physicalRoot).isDirectory()) throw new Error("not-directory");
	} catch {
		throw new RootRegistryConfigurationError("root grant physicalRoot must resolve to an existing directory");
	}

	const grant = Object.freeze({
		[ROOT_GRANT]: true as const,
		grantId: logicalId(input.grantId, "grantId"),
		bindingId: logicalId(input.bindingId, "bindingId"),
		resourceDomainId: logicalId(input.resourceDomainId, "resourceDomainId"),
		physicalRoot,
		maxAccess: input.maxAccess,
		version: validateVersion(input.version),
		allowedPrincipals: readonlyStringSet(input.allowedPrincipals, "allowedPrincipals"),
		enforcement: input.enforcement,
	}) satisfies RootGrant;
	brandedRootGrants.add(grant);
	return grant;
}

export function isRootGrant(value: unknown): value is RootGrant {
	return typeof value === "object" && value !== null && brandedRootGrants.has(value);
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function physicalScopesOverlap(a: RootGrant, b: RootGrant): boolean {
	return isWithin(a.physicalRoot, b.physicalRoot) || isWithin(b.physicalRoot, a.physicalRoot);
}

class RootRegistryImpl implements RootRegistry {
	readonly registryId: string;
	readonly #grants: ReadonlyMap<string, RootGrant>;

	constructor(registryId: string, grants: ReadonlyMap<string, RootGrant>) {
		this.registryId = registryId;
		this.#grants = grants;
	}

	authorize(grantId: string, principal: InvocationAuthority, requested: WorkspaceAccess): RootGrant | WorkspacePolicyError {
		const grant = typeof grantId === "string" ? this.#grants.get(grantId.normalize("NFC")) : undefined;
		if (grant === undefined || !hasGrantAuthority(principal, grant)) {
			return workspacePolicyError("TFWS_UNAUTHORIZED_GRANT", "The invocation is not authorized for the requested root grant");
		}
		if (requested !== "read-only" && requested !== "read-write") {
			return workspacePolicyError("TFWS_ACCESS_ESCALATION", "The requested workspace access is invalid");
		}
		if (!accessAllows(grant.maxAccess, requested)) {
			return workspacePolicyError("TFWS_ACCESS_ESCALATION", "The requested workspace access exceeds the root grant");
		}
		return grant;
	}
}

/**
 * Build a registry and reject alias configurations that could split locking,
 * journaling, version, or cache identity for one writable physical resource.
 */
export function createRootRegistry(input: RootRegistryInput): RootRegistry {
	const registryId = logicalId(input.registryId, "registryId");
	const grants = new Map<string, RootGrant>();
	for (const grant of input.grants) {
		if (!isRootGrant(grant)) {
			throw new RootRegistryConfigurationError("registry grants must come from createHostRootGrant");
		}
		if (grants.has(grant.grantId)) {
			throw new RootRegistryConfigurationError(`duplicate root grant id '${grant.grantId}'`);
		}
		grants.set(grant.grantId, grant);
	}

	const entries = [...grants.values()];
	for (let i = 0; i < entries.length; i++) {
		for (let j = i + 1; j < entries.length; j++) {
			const a = entries[i]!;
			const b = entries[j]!;
			if (
				a.resourceDomainId !== b.resourceDomainId &&
				(a.maxAccess === "read-write" || b.maxAccess === "read-write") &&
				physicalScopesOverlap(a, b)
			) {
				throw new RootRegistryConfigurationError(
					`overlapping grants '${a.grantId}' and '${b.grantId}' require the same resourceDomainId when either is writable`,
				);
			}
		}
	}

	return new RootRegistryImpl(registryId, grants);
}
