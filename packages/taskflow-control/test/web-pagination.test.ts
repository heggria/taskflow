/** P17 full-envelope pagination invariants. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	WEB_ENDPOINTS,
	type WebEndpointPagination,
} from "../src/web-protocol.ts";
import {
	WEB_MAX_PAGE_ELEMENT_BYTES,
	WebPageBudgetError,
	buildBoundedWebPage,
	strictlyAfterKeyset,
	webJsonByteLength,
	webUtf8ByteLength,
} from "../src/web-pagination.ts";
import {
	asSchema,
	synthesize,
} from "./helpers/web-schema-fixture.ts";

type Row = {
	readonly id: number;
	readonly label: string;
};

type PagedEndpoint = {
	readonly querySchema: TSchema;
	readonly successDataSchema: TSchema;
	readonly successResponseSchema: TSchema;
	readonly responseBudgetBytes: number;
	readonly pagination: WebEndpointPagination;
};

function schemaAtPath(
	schema: TSchema,
	pathParts: readonly string[],
): TSchema {
	let current = asSchema(schema);
	for (const part of pathParts) {
		if (current.type !== "object") {
			throw new Error(`schema path left an object at ${part}`);
		}
		const properties = asSchema(current.properties ?? {}) as Record<
			string,
			TSchema
		>;
		const next = properties[part];
		if (!next) throw new Error(`schema path is missing ${part}`);
		current = asSchema(next);
	}
	return current;
}

function setAtPath(
	root: Record<string, unknown>,
	pathParts: readonly string[],
	value: unknown,
): void {
	let current = root;
	for (const part of pathParts.slice(0, -1)) {
		const next = current[part];
		if (
			typeof next !== "object" ||
			next === null ||
			Array.isArray(next)
		) {
			throw new Error(`fixture path left an object at ${part}`);
		}
		current = next as Record<string, unknown>;
	}
	const final = pathParts.at(-1);
	if (!final) throw new Error("fixture path cannot be empty");
	if (value === undefined) delete current[final];
	else current[final] = value;
}

function pagedEndpoints(): Array<readonly [string, PagedEndpoint]> {
	return Object.entries(WEB_ENDPOINTS)
		.filter((entry) => "pagination" in entry[1])
		.map(
			([endpointId, endpoint]) =>
				[endpointId, endpoint as PagedEndpoint] as const,
		);
}

function page(
	rows: readonly Row[],
	options: {
		readonly limit?: number;
		readonly budget?: number;
	} = {},
) {
	return buildBoundedWebPage({
		orderedItems: rows,
		limit: options.limit ?? 200,
		maximumLimit: 200,
		responseBudgetBytes: options.budget ?? 1024,
		keyOf: (row) => row.id,
		cursorAfter: (id) => `after:${id}`,
		envelope: (items, nextCursor) => ({
			ok: true,
			data: {
				items,
				...(nextCursor ? { nextCursor } : {}),
			},
		}),
	});
}

test("P17 pagination handles empty, single, and row-limit boundaries", () => {
	const empty = page([]);
	assert.deepEqual(empty.items, []);
	assert.equal(empty.nextCursor, undefined);
	assert.equal(empty.lastReturnedKey, undefined);
	assert.equal(
		empty.encodedBytes,
		webJsonByteLength(empty.envelope),
	);

	const single = page([{ id: 1, label: "one" }]);
	assert.deepEqual(single.items.map((row) => row.id), [1]);
	assert.equal(single.nextCursor, undefined);
	assert.equal(single.lastReturnedKey, 1);

	const limited = page(
		[
			{ id: 1, label: "one" },
			{ id: 2, label: "two" },
			{ id: 3, label: "three" },
		],
		{ limit: 2 },
	);
	assert.deepEqual(limited.items.map((row) => row.id), [1, 2]);
	assert.equal(limited.nextCursor, "after:2");
	assert.equal(limited.lastReturnedKey, 2);
});

test("P17 pagination concatenates variable-byte pages without loss or duplication", () => {
	const rows = Array.from({ length: 100 }, (_, index) => ({
		id: index + 1,
		label: `${index % 3 === 0 ? "任务" : "task"}-${index}-${"x".repeat(index % 17)}`,
	}));
	const concatenated: Row[] = [];
	let after: number | undefined;
	for (let pageCount = 0; pageCount < 100; pageCount += 1) {
		const remaining = strictlyAfterKeyset(
			rows,
			after,
			(row) => row.id,
			(left, right) => left - right,
		);
		if (remaining.length === 0) break;
		const built = page(remaining, {
			limit: 7,
			budget: 430,
		});
		assert.ok(built.items.length >= 1);
		assert.ok(built.items.length <= 7);
		assert.ok(built.encodedBytes <= 430);
		concatenated.push(...built.items);
		after = built.lastReturnedKey;
		if (!built.nextCursor) break;
	}
	assert.deepEqual(concatenated, rows);
	assert.equal(new Set(concatenated.map((row) => row.id)).size, rows.length);
});

test("P17 pagination rejects oversized elements and impossible envelopes", () => {
	const oversized = {
		id: 1,
		label: "x".repeat(WEB_MAX_PAGE_ELEMENT_BYTES + 1),
	};
	assert.throws(
		() =>
			page([oversized], {
				budget: WEB_MAX_PAGE_ELEMENT_BYTES * 2,
			}),
		WebPageBudgetError,
	);

	const row = { id: 1, label: "cannot fit" };
	const emptyBytes = page([], { budget: 1024 }).encodedBytes;
	assert.throws(
		() => page([row], { budget: emptyBytes }),
		WebPageBudgetError,
	);
	assert.throws(
		() => page([], { budget: 1 }),
		WebPageBudgetError,
	);
});

test("P17 pagination validates bounds and computes UTF-8 bytes exactly", () => {
	assert.equal(webUtf8ByteLength("Aé任😀"), 1 + 2 + 3 + 4);
	for (const limit of [0, 201, 1.5, Number.NaN]) {
		assert.throws(
			() =>
				buildBoundedWebPage({
					orderedItems: [] as Row[],
					limit,
					maximumLimit: 200,
					responseBudgetBytes: 1024,
					keyOf: (row) => row.id,
					cursorAfter: (id) => String(id),
					envelope: (items) => ({ items }),
				}),
			RangeError,
		);
	}
	for (const budget of [0, -1, 1.5, Number.NaN]) {
		assert.throws(
			() =>
				buildBoundedWebPage({
					orderedItems: [] as Row[],
					limit: 1,
					maximumLimit: 200,
					responseBudgetBytes: budget,
					keyOf: (row) => row.id,
					cursorAfter: (id) => String(id),
					envelope: (items) => ({ items }),
				}),
			RangeError,
		);
	}
});

test("P17 every registered paged endpoint closes empty/single/N+1/oversized boundaries", () => {
	const entries = pagedEndpoints();
	assert.deepEqual(
		entries.map(([endpointId]) => endpointId),
		[
			"projects",
			"runs",
			"runFragments",
			"runGraph",
			"runTimeline",
			"nodeAttempts",
			"runArtifacts",
			"runReceipt",
			"approvals",
			"attention",
		],
	);

	for (const [endpointId, endpoint] of entries) {
		const arraySchema = asSchema(
			schemaAtPath(
				endpoint.successDataSchema,
				endpoint.pagination.itemsPath,
			),
		);
		assert.equal(arraySchema.type, "array", `${endpointId}.itemsPath`);
		assert.equal(
			arraySchema.maxItems,
			endpoint.pagination.maximumLimit,
			`${endpointId}.response maximum`,
		);
		const queryProperties = asSchema(
			asSchema(endpoint.querySchema).properties ?? {},
		) as Record<string, TSchema>;
		assert.equal(
			asSchema(queryProperties.limit).maximum,
			endpoint.pagination.maximumLimit,
			`${endpointId}.request maximum`,
		);
		const itemSchema = asSchema(arraySchema.items);
		const first = synthesize(itemSchema, 10) as Record<string, unknown>;
		const second = synthesize(itemSchema, 100) as Record<string, unknown>;
		const keys = new Map<object, number>([
			[first, 1],
			[second, 2],
		]);
		const baseData = synthesize(
			endpoint.successDataSchema,
		) as Record<string, unknown>;
		const cursorAfter = (lastReturnedKey: number) =>
			`after-${endpointId}-${lastReturnedKey}`;
		const envelope = (
			items: readonly Record<string, unknown>[],
			nextCursor: string | undefined,
		) => {
			const data = structuredClone(baseData);
			setAtPath(
				data,
				endpoint.pagination.itemsPath,
				[...items],
			);
			setAtPath(
				data,
				endpoint.pagination.nextCursorPath,
				nextCursor,
			);
			return {
				ok: true as const,
				requestId: `request-${endpointId}`,
				schemaVersion: "web.v1" as const,
				data,
			};
		};
		const build = (
			items: readonly Record<string, unknown>[],
			budget: number,
		) =>
			buildBoundedWebPage({
				orderedItems: items,
				limit: endpoint.pagination.maximumLimit,
				maximumLimit: endpoint.pagination.maximumLimit,
				responseBudgetBytes: budget,
				keyOf: (item) => {
					const key = keys.get(item);
					if (key === undefined) {
						throw new Error(`${endpointId} item has no fixture key`);
					}
					return key;
				},
				cursorAfter,
				envelope,
			});

		const emptyEnvelope = envelope([], undefined);
		const emptyBytes = webJsonByteLength(emptyEnvelope);
		const empty = build([], emptyBytes);
		assert.equal(empty.encodedBytes, emptyBytes, `${endpointId}.empty.bytes`);
		assert.equal(
			Value.Check(endpoint.successResponseSchema, empty.envelope),
			true,
			`${endpointId}.empty.schema`,
		);
		assert.throws(
			() => build([], emptyBytes - 1),
			WebPageBudgetError,
			`${endpointId}.empty.impossible`,
		);

		const single = build([first], endpoint.responseBudgetBytes);
		assert.equal(single.items.length, 1, `${endpointId}.single.items`);
		assert.equal(single.nextCursor, undefined, `${endpointId}.single.cursor`);
		assert.equal(
			Value.Check(endpoint.successResponseSchema, single.envelope),
			true,
			`${endpointId}.single.schema`,
		);

		const firstPageEnvelope = envelope(
			[first],
			cursorAfter(1),
		);
		const exactBoundaryBytes = webJsonByteLength(firstPageEnvelope);
		const firstPage = build(
			[first, second],
			exactBoundaryBytes,
		);
		assert.equal(
			firstPage.encodedBytes,
			exactBoundaryBytes,
			`${endpointId}.boundary.bytes`,
		);
		assert.deepEqual(
			firstPage.items,
			[first],
			`${endpointId}.boundary.items`,
		);
		assert.equal(
			firstPage.nextCursor,
			cursorAfter(1),
			`${endpointId}.boundary.cursor`,
		);
		assert.equal(
			Value.Check(
				endpoint.successResponseSchema,
				firstPage.envelope,
			),
			true,
			`${endpointId}.boundary.schema`,
		);

		const remaining = strictlyAfterKeyset(
			[first, second],
			firstPage.lastReturnedKey,
			(item) => keys.get(item)!,
			(left, right) => left - right,
		);
		const secondPage = build(
			remaining,
			endpoint.responseBudgetBytes,
		);
		assert.deepEqual(
			[...firstPage.items, ...secondPage.items],
			[first, second],
			`${endpointId}.concatenated`,
		);
		assert.equal(
			secondPage.nextCursor,
			undefined,
			`${endpointId}.last-page`,
		);

		const oversized = {
			...first,
			fixturePadding: "x".repeat(
				WEB_MAX_PAGE_ELEMENT_BYTES,
			),
		};
		keys.set(oversized, 3);
		assert.throws(
			() =>
				build(
					[oversized],
					endpoint.responseBudgetBytes * 2,
				),
			WebPageBudgetError,
			`${endpointId}.oversized`,
		);
	}
});
