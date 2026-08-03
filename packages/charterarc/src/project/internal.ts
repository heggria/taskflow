export function fail(label: string, message: string): never {
	throw new TypeError(`CHARTERARC_INVALID_${label.toUpperCase()}: ${message}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

export function assertOnlyKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	label: string,
): void {
	const allowedSet = new Set(allowed);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || !allowedSet.has(key)) {
			fail(label, `unknown field '${String(key)}'`);
		}
	}
}

export function requiredText(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		fail(label, "must be a non-empty string");
	}
	return value.trim();
}

export function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}
