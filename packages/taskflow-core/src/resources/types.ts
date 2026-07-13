import * as path from "node:path";

export type ResourceAccess = "read-only" | "read-write";

export interface CanonicalLeaseKey {
	resourceDomainId: string;
	canonicalPrefix: string;
}

export interface ExecutionOwner {
	runId: string;
	phaseId: string;
	attemptId: string;
	unitId: string;
	ancestry: string[];
}

export interface LeaseRequest {
	key: CanonicalLeaseKey;
	access: ResourceAccess;
	owner: ExecutionOwner;
}

export interface ScopedContentEvidence {
	canonicalPrefix: string;
	scopeDigest: string;
	beforeContentId?: string;
	afterContentId?: string;
}

export type VersionCommitMode = "content-snapshot" | "generation-only" | "unavailable";
export type ExternalMutationModel = "taskflow-managed" | "externally-mutable";

export function normalizeCanonicalPrefix(prefix: string): string {
	if (typeof prefix !== "string" || prefix.length === 0 || !path.isAbsolute(prefix)) {
		throw new Error(`canonicalPrefix must be a non-empty absolute path: ${JSON.stringify(prefix)}`);
	}
	return path.normalize(prefix);
}

export function normalizeLeaseKey(key: CanonicalLeaseKey): CanonicalLeaseKey {
	if (typeof key.resourceDomainId !== "string" || key.resourceDomainId.trim().length === 0) {
		throw new Error("resourceDomainId must be a non-empty string");
	}
	return {
		resourceDomainId: key.resourceDomainId,
		canonicalPrefix: normalizeCanonicalPrefix(key.canonicalPrefix),
	};
}

export function canonicalPrefixContains(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export function canonicalLeaseKeysOverlap(a: CanonicalLeaseKey, b: CanonicalLeaseKey): boolean {
	if (a.resourceDomainId !== b.resourceDomainId) return false;
	return canonicalPrefixContains(a.canonicalPrefix, b.canonicalPrefix) ||
		canonicalPrefixContains(b.canonicalPrefix, a.canonicalPrefix);
}

export function compareLeaseKeys(a: CanonicalLeaseKey, b: CanonicalLeaseKey): number {
	return a.resourceDomainId.localeCompare(b.resourceDomainId) ||
		a.canonicalPrefix.localeCompare(b.canonicalPrefix);
}

export function sameExecutionOwner(a: ExecutionOwner, b: ExecutionOwner): boolean {
	return a.runId === b.runId &&
		a.phaseId === b.phaseId &&
		a.attemptId === b.attemptId &&
		a.unitId === b.unitId &&
		a.ancestry.length === b.ancestry.length &&
		a.ancestry.every((value, index) => value === b.ancestry[index]);
}

export function cloneExecutionOwner(owner: ExecutionOwner): ExecutionOwner {
	return {
		runId: owner.runId,
		phaseId: owner.phaseId,
		attemptId: owner.attemptId,
		unitId: owner.unitId,
		ancestry: [...owner.ancestry],
	};
}

/** Reduce same-domain writable scopes to a deterministic minimal prefix cover. */
export function minimalCanonicalScopeCover(scopes: readonly CanonicalLeaseKey[]): CanonicalLeaseKey[] {
	const sorted = scopes.map(normalizeLeaseKey).sort(compareLeaseKeys);
	const result: CanonicalLeaseKey[] = [];
	for (const scope of sorted) {
		if (result.some((existing) =>
			existing.resourceDomainId === scope.resourceDomainId &&
			canonicalPrefixContains(existing.canonicalPrefix, scope.canonicalPrefix))) {
			continue;
		}
		for (let i = result.length - 1; i >= 0; i--) {
			const existing = result[i];
			if (existing.resourceDomainId === scope.resourceDomainId &&
				canonicalPrefixContains(scope.canonicalPrefix, existing.canonicalPrefix)) {
				result.splice(i, 1);
			}
		}
		result.push(scope);
		result.sort(compareLeaseKeys);
	}
	return result;
}

export function sameCanonicalScopes(a: readonly CanonicalLeaseKey[], b: readonly CanonicalLeaseKey[]): boolean {
	const aa = minimalCanonicalScopeCover(a);
	const bb = minimalCanonicalScopeCover(b);
	return aa.length === bb.length && aa.every((scope, index) =>
		scope.resourceDomainId === bb[index].resourceDomainId &&
		scope.canonicalPrefix === bb[index].canonicalPrefix);
}
