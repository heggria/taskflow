import { createHash } from "node:crypto";

/**
 * RFC 8785 / JSON Canonicalization Scheme serializer for JSON-domain values.
 * It intentionally rejects values which JSON would silently coerce or discard.
 */
export function canonicalJson(value: unknown): string {
	const ancestors = new Set<object>();

	function encode(current: unknown): string {
		if (current === null) return "null";
		if (typeof current === "boolean") return current ? "true" : "false";
		if (typeof current === "string") {
			assertUnicodeScalarString(current);
			return JSON.stringify(current);
		}
		if (typeof current === "number") {
			if (!Number.isFinite(current)) throw new TypeError("canonical JSON requires finite numbers");
			return JSON.stringify(current);
		}
		if (typeof current !== "object") {
			throw new TypeError(`canonical JSON cannot encode ${typeof current}`);
		}
		if (ancestors.has(current)) throw new TypeError("canonical JSON cannot encode cycles");
		ancestors.add(current);
		try {
			if (Array.isArray(current)) {
				const items: string[] = [];
				for (let index = 0; index < current.length; index++) {
					if (!Object.hasOwn(current, index)) {
						throw new TypeError("canonical JSON cannot encode sparse arrays");
					}
					items.push(encode(current[index]));
				}
				return `[${items.join(",")}]`;
			}

			const prototype = Object.getPrototypeOf(current);
			if (prototype !== Object.prototype && prototype !== null) {
				throw new TypeError("canonical JSON requires plain objects");
			}
			const record = current as Record<string, unknown>;
			const keys = Object.keys(record).sort();
			const fields = keys.map((key) => {
				assertUnicodeScalarString(key);
				return `${JSON.stringify(key)}:${encode(record[key])}`;
			});
			return `{${fields.join(",")}}`;
		} finally {
			ancestors.delete(current);
		}
	}

	return encode(value);
}

export function sha256Canonical(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function assertUnicodeScalarString(value: string): void {
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				throw new TypeError("canonical JSON rejects lone UTF-16 surrogates");
			}
			index++;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			throw new TypeError("canonical JSON rejects lone UTF-16 surrogates");
		}
	}
}
