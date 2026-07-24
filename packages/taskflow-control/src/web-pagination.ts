/**
 * Browser-safe P17 page assembly helpers.
 *
 * The caller owns authorization, canonical ordering, cursor signing, and
 * snapshot/version binding. This helper owns the subtle full-envelope byte
 * budget and last-returned-key continuation rule.
 */

export const WEB_MAX_PAGE_ELEMENT_BYTES = 64 * 1024;

export class WebPageBudgetError extends Error {
	override readonly name = "WebPageBudgetError";
}

export function webUtf8ByteLength(value: string): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.codePointAt(index)!;
		if (code <= 0x7f) bytes += 1;
		else if (code <= 0x7ff) bytes += 2;
		else if (code <= 0xffff) bytes += 3;
		else {
			bytes += 4;
			index += 1;
		}
	}
	return bytes;
}

export function webJsonByteLength(value: unknown): number {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) {
		throw new TypeError("P17 JSON envelope is not serializable");
	}
	return webUtf8ByteLength(encoded);
}

export function strictlyAfterKeyset<Item, Key>(
	orderedItems: readonly Item[],
	after: Key | undefined,
	keyOf: (item: Item) => Key,
	compare: (left: Key, right: Key) => number,
): Item[] {
	if (after === undefined) return [...orderedItems];
	return orderedItems.filter((item) => compare(keyOf(item), after) > 0);
}

export function buildBoundedWebPage<Item, Key, Envelope>(options: {
	/** Already-authorized, canonically ordered items strictly after the cursor. */
	orderedItems: readonly Item[];
	limit: number;
	maximumLimit: number;
	responseBudgetBytes: number;
	keyOf: (item: Item) => Key;
	cursorAfter: (lastReturnedKey: Key) => string;
	envelope: (items: readonly Item[], nextCursor: string | undefined) => Envelope;
}): {
	items: Item[];
	nextCursor?: string;
	envelope: Envelope;
	encodedBytes: number;
	lastReturnedKey?: Key;
} {
	if (
		!Number.isSafeInteger(options.limit) ||
		options.limit < 1 ||
		options.limit > options.maximumLimit
	) {
		throw new RangeError(
			`page limit must be an integer from 1 through ${options.maximumLimit}`,
		);
	}
	if (
		!Number.isSafeInteger(options.responseBudgetBytes) ||
		options.responseBudgetBytes < 1
	) {
		throw new RangeError("responseBudgetBytes must be a positive safe integer");
	}

	const emptyEnvelope = options.envelope([], undefined);
	if (options.orderedItems.length === 0) {
		const encodedBytes = webJsonByteLength(emptyEnvelope);
		if (encodedBytes > options.responseBudgetBytes) {
			throw new WebPageBudgetError(
				"empty P17 response envelope exceeds its endpoint budget",
			);
		}
		return { items: [], envelope: emptyEnvelope, encodedBytes };
	}

	let accepted:
		| {
				items: Item[];
				nextCursor?: string;
				envelope: Envelope;
				encodedBytes: number;
				lastReturnedKey: Key;
		  }
		| undefined;
	const maximumRows = Math.min(options.limit, options.orderedItems.length);
	for (let index = 0; index < maximumRows; index += 1) {
		const item = options.orderedItems[index]!;
		if (webJsonByteLength(item) > WEB_MAX_PAGE_ELEMENT_BYTES) {
			throw new WebPageBudgetError(
				"one P17 page element exceeds the 64 KiB encoded limit",
			);
		}
		const items = options.orderedItems.slice(0, index + 1);
		const lastReturnedKey = options.keyOf(item);
		const hasMore = index + 1 < options.orderedItems.length;
		const nextCursor = hasMore
			? options.cursorAfter(lastReturnedKey)
			: undefined;
		const envelope = options.envelope(items, nextCursor);
		const encodedBytes = webJsonByteLength(envelope);
		if (encodedBytes > options.responseBudgetBytes) break;
		accepted = {
			items,
			...(nextCursor ? { nextCursor } : {}),
			envelope,
			encodedBytes,
			lastReturnedKey,
		};
	}

	if (!accepted) {
		throw new WebPageBudgetError(
			"non-empty P17 result cannot fit one element plus continuation metadata",
		);
	}
	return accepted;
}
