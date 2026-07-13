/** Invocation-scoped authority supplied by a trusted host, never by flow JSON. */

export interface InvocationAuthority {
	principalId: string;
	allowedGrantIds: ReadonlySet<string>;
	allowedProviderControllers: ReadonlySet<string>;
	allowedCredentialIds: ReadonlySet<string>;
	allowResolveOnly: boolean;
	allowUnsafeParallelWrites: boolean;
	allowWorkspaceStateRestore: boolean;
}

export interface InvocationAuthorityInput {
	principalId: string;
	allowedGrantIds?: Iterable<string>;
	allowedProviderControllers?: Iterable<string>;
	allowedCredentialIds?: Iterable<string>;
	allowResolveOnly?: boolean;
	allowUnsafeParallelWrites?: boolean;
	allowWorkspaceStateRestore?: boolean;
}

/** The minimum grant view needed for two-sided principal authorization. */
export interface GrantAuthorizationView {
	grantId: string;
	allowedPrincipals: ReadonlySet<string>;
}

class ReadonlySetSnapshot<T> implements ReadonlySet<T> {
	readonly #values: Set<T>;

	constructor(values: Iterable<T>) {
		this.#values = new Set(values);
	}

	get size(): number {
		return this.#values.size;
	}

	has(value: T): boolean {
		return this.#values.has(value);
	}

	entries(): SetIterator<[T, T]> {
		return this.#values.entries();
	}

	keys(): SetIterator<T> {
		return this.#values.keys();
	}

	values(): SetIterator<T> {
		return this.#values.values();
	}

	forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
		for (const value of this.#values) callbackfn.call(thisArg, value, value, this);
	}

	[Symbol.iterator](): SetIterator<T> {
		return this.#values[Symbol.iterator]();
	}

	get [Symbol.toStringTag](): string {
		return "ReadonlySet";
	}
}

function nonEmptyId(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0 || value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new TypeError(`${field} must be a non-empty logical identifier`);
	}
	return value.normalize("NFC");
}

export function readonlyStringSet(values: Iterable<string>, field: string): ReadonlySet<string> {
	const normalized: string[] = [];
	for (const value of values) normalized.push(nonEmptyId(value, field));
	return new ReadonlySetSnapshot(normalized);
}

/**
 * Host-side constructor that snapshots every allowlist.
 *
 * The returned sets expose no mutation methods, so changes to the host's input
 * sets cannot widen a live invocation after authorization begins.
 */
export function createHostInvocationAuthority(input: InvocationAuthorityInput): InvocationAuthority {
	return Object.freeze({
		principalId: nonEmptyId(input.principalId, "principalId"),
		allowedGrantIds: readonlyStringSet(input.allowedGrantIds ?? [], "allowedGrantIds"),
		allowedProviderControllers: readonlyStringSet(
			input.allowedProviderControllers ?? [],
			"allowedProviderControllers",
		),
		allowedCredentialIds: readonlyStringSet(input.allowedCredentialIds ?? [], "allowedCredentialIds"),
		allowResolveOnly: input.allowResolveOnly === true,
		allowUnsafeParallelWrites: input.allowUnsafeParallelWrites === true,
		allowWorkspaceStateRestore: input.allowWorkspaceStateRestore === true,
	});
}

/** Both the invocation allowlist and the grant's principal ACL must agree. */
export function hasGrantAuthority(authority: InvocationAuthority, grant: GrantAuthorizationView): boolean {
	return (
		authority.allowedGrantIds.has(grant.grantId) &&
		grant.allowedPrincipals.has(authority.principalId)
	);
}
