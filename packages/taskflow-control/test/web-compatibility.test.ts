/**
 * P17 v5 old/new compatibility vectors.
 *
 * The committed case list is deliberately independent of WEB_ENDPOINTS:
 * changing the endpoint registry cannot silently create a new presentation
 * extension point. Every approved producer stays closed, its matching old
 * consumer accepts only a new top-level presentation field, and required or
 * nested authority changes remain breaking.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	WEB_ENDPOINTS,
	WebApprovalDetailConsumerSchema,
	WebApprovalDetailSchema,
	WebApprovalSummaryConsumerSchema,
	WebApprovalSummarySchema,
	WebAttentionItemConsumerSchema,
	WebAttentionItemSchema,
	WebApiErrorResponseSchema,
	WebCommandOutcomeSchema,
	WebCommandRequestSchema,
	WebNodeDetailConsumerSchema,
	WebNodeDetailSchema,
	WebOverviewViewConsumerSchema,
	WebOverviewViewSchema,
	WebPageCursorPayloadSchema,
	WebPolicyExplanationConsumerSchema,
	WebPolicyExplanationSchema,
	WebProjectDetailConsumerSchema,
	WebProjectDetailSchema,
	WebProjectSummaryConsumerSchema,
	WebProjectSummarySchema,
	WebReceiptViewConsumerSchema,
	WebReceiptViewSchema,
	WebRunDetailConsumerSchema,
	WebRunDetailSchema,
	WebRunSummaryConsumerSchema,
	WebRunSummarySchema,
	WebStreamFrameSchema,
} from "../src/web-protocol.ts";
import {
	WebActionRequestBaseSchema,
	WebAvailableActionSchema,
	WebTaskPresentationConsumerSchema,
	WebTaskPresentationSchema,
	WebTaskPresentationSummaryConsumerSchema,
	WebTaskPresentationSummarySchema,
} from "../src/web-presentation-schema.ts";
import { TF_ERROR_CODES } from "../src/types.ts";
import {
	asSchema,
	synthesize,
	type SchemaRecord,
} from "./helpers/web-schema-fixture.ts";

type CompatibilityFixture = {
	readonly schemaVersion: "web-compatibility.v1";
	readonly futureTopLevelField: string;
	readonly cases: readonly string[];
	readonly closedUnions: Readonly<Record<string, readonly string[]>>;
};

const schemaPairs = {
	WebOverviewView: {
		producer: WebOverviewViewSchema,
		consumer: WebOverviewViewConsumerSchema,
	},
	WebProjectSummary: {
		producer: WebProjectSummarySchema,
		consumer: WebProjectSummaryConsumerSchema,
	},
	WebProjectDetail: {
		producer: WebProjectDetailSchema,
		consumer: WebProjectDetailConsumerSchema,
	},
	WebRunSummary: {
		producer: WebRunSummarySchema,
		consumer: WebRunSummaryConsumerSchema,
	},
	WebRunDetail: {
		producer: WebRunDetailSchema,
		consumer: WebRunDetailConsumerSchema,
	},
	WebTaskPresentationSummary: {
		producer: WebTaskPresentationSummarySchema,
		consumer: WebTaskPresentationSummaryConsumerSchema,
	},
	WebTaskPresentation: {
		producer: WebTaskPresentationSchema,
		consumer: WebTaskPresentationConsumerSchema,
	},
	WebNodeDetail: {
		producer: WebNodeDetailSchema,
		consumer: WebNodeDetailConsumerSchema,
	},
	WebApprovalSummary: {
		producer: WebApprovalSummarySchema,
		consumer: WebApprovalSummaryConsumerSchema,
	},
	WebApprovalDetail: {
		producer: WebApprovalDetailSchema,
		consumer: WebApprovalDetailConsumerSchema,
	},
	WebAttentionItem: {
		producer: WebAttentionItemSchema,
		consumer: WebAttentionItemConsumerSchema,
	},
	WebReceiptView: {
		producer: WebReceiptViewSchema,
		consumer: WebReceiptViewConsumerSchema,
	},
	WebPolicyExplanation: {
		producer: WebPolicyExplanationSchema,
		consumer: WebPolicyExplanationConsumerSchema,
	},
} as const satisfies Record<
	string,
	{ readonly producer: TSchema; readonly consumer: TSchema }
>;

function selectedBranch(schema: SchemaRecord, value: unknown): SchemaRecord {
	const alternatives = schema.anyOf;
	if (!Array.isArray(alternatives)) return schema;
	const selected = alternatives
		.map(asSchema)
		.find((alternative) => Value.Check(alternative, value));
	if (!selected) throw new Error("value matched no union branch");
	return selectedBranch(selected, value);
}

function findClosedNestedObjectPath(
	schemaValue: TSchema,
	value: unknown,
	depth = 0,
): readonly (string | number)[] | null {
	const schema = selectedBranch(asSchema(schemaValue), value);
	if (
		depth > 0 &&
		schema.type === "object" &&
		schema.additionalProperties === false &&
		schema["x-web-additive"] !== true
	) {
		return [];
	}
	if (
		schema.type === "object" &&
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value)
	) {
		const properties = asSchema(schema.properties ?? {}) as Record<
			string,
			TSchema
		>;
		for (const [key, child] of Object.entries(properties)) {
			if (!(key in value)) continue;
			const nested = findClosedNestedObjectPath(
				child,
				(value as Record<string, unknown>)[key],
				depth + 1,
			);
			if (nested) return [key, ...nested];
		}
	}
	if (
		schema.type === "array" &&
		Array.isArray(value) &&
		value.length > 0
	) {
		const nested = findClosedNestedObjectPath(
			asSchema(schema.items),
			value[0],
			depth + 1,
		);
		if (nested) return [0, ...nested];
	}
	return null;
}

function objectAtPath(
	value: unknown,
	pathParts: readonly (string | number)[],
): Record<string, unknown> {
	let current = value;
	for (const part of pathParts) {
		if (typeof current !== "object" || current === null) {
			throw new Error("compatibility path left the object tree");
		}
		current = (current as Record<string | number, unknown>)[part];
	}
	if (
		typeof current !== "object" ||
		current === null ||
		Array.isArray(current)
	) {
		throw new Error("compatibility path did not select an object");
	}
	return current as Record<string, unknown>;
}

function directUnionBranches(schemaValue: TSchema): readonly TSchema[] {
	const alternatives = asSchema(schemaValue).anyOf;
	if (!Array.isArray(alternatives)) {
		throw new Error("schema is not a direct union");
	}
	return alternatives.map(asSchema);
}

function availableActionBranches(): readonly TSchema[] {
	return directUnionBranches(WebAvailableActionSchema).flatMap((group) =>
		directUnionBranches(group),
	);
}

type NestedUnionOccurrence = {
	readonly root: string;
	readonly path: string;
	readonly schema: TSchema;
	readonly branches: readonly TSchema[];
};

function collectNestedUnions(
	root: string,
	schemaValue: TSchema,
	pathParts: readonly string[] = [],
): NestedUnionOccurrence[] {
	const schema = asSchema(schemaValue);
	const occurrences: NestedUnionOccurrence[] = [];
	const alternatives = schema.anyOf;
	if (Array.isArray(alternatives)) {
		const branches = alternatives.map(asSchema);
		occurrences.push({
			root,
			path: pathParts.join(".") || "$",
			schema: schemaValue,
			branches,
		});
		for (const [index, branch] of branches.entries()) {
			occurrences.push(
				...collectNestedUnions(
					root,
					branch,
					[...pathParts, `anyOf[${index}]`],
				),
			);
		}
	}
	const intersections = schema.allOf;
	if (Array.isArray(intersections)) {
		for (const [index, intersection] of intersections.entries()) {
			occurrences.push(
				...collectNestedUnions(
					root,
					asSchema(intersection),
					[...pathParts, `allOf[${index}]`],
				),
			);
		}
	}
	if (schema.type === "object") {
		const properties = asSchema(schema.properties ?? {}) as Record<
			string,
			TSchema
		>;
		for (const [name, property] of Object.entries(properties)) {
			occurrences.push(
				...collectNestedUnions(
					root,
					property,
					[...pathParts, name],
				),
			);
		}
	}
	if (schema.type === "array" && schema.items !== undefined) {
		const items = Array.isArray(schema.items)
			? schema.items
			: [schema.items];
		for (const [index, item] of items.entries()) {
			occurrences.push(
				...collectNestedUnions(
					root,
					asSchema(item),
					[...pathParts, `items[${index}]`],
				),
			);
		}
	}
	return occurrences;
}

function branchIdentity(value: unknown): string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("closed union branch is not an object");
	}
	const record = value as Record<string, unknown>;
	if (typeof record.state === "string" && typeof record.kind === "string") {
		return `${record.state}:${record.kind}`;
	}
	for (const key of ["status", "collection", "type", "kind"]) {
		if (typeof record[key] === "string") return record[key];
	}
	throw new Error("closed union branch has no known discriminant");
}

function assertClosedUnion(
	name: string,
	schema: TSchema,
	branches: readonly TSchema[],
	expectedIdentities: readonly string[],
): void {
	const actualIdentities: string[] = [];
	for (const [index, branch] of branches.entries()) {
		const value = synthesize(branch, index + 1);
		assert.equal(Value.Check(branch, value), true, `${name}[${index}]`);
		assert.equal(Value.Check(schema, value), true, `${name}[${index}]`);
		assert.deepEqual(
			JSON.parse(JSON.stringify(value)),
			value,
			`${name}[${index}] JSON round-trip`,
		);
		actualIdentities.push(branchIdentity(value));
		const unknownBranchField = {
			...(value as Record<string, unknown>),
			futureWireAuthority: true,
		};
		assert.equal(
			Value.Check(schema, unknownBranchField),
			false,
			`${name}[${index}] accepted an unknown authority field`,
		);
	}
	assert.deepEqual(actualIdentities, expectedIdentities, name);
}

test("P17 committed additive points distinguish minor from breaking changes", () => {
	const fixturePath = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"fixtures/web-v1/compatibility/additive-extension-points.json",
	);
	const fixture = JSON.parse(
		fs.readFileSync(fixturePath, "utf8"),
	) as CompatibilityFixture;
	assert.equal(fixture.schemaVersion, "web-compatibility.v1");
	assert.deepEqual(fixture.cases, Object.keys(schemaPairs));

	for (const name of fixture.cases) {
		const pair = schemaPairs[name as keyof typeof schemaPairs];
		assert.ok(pair, name);
		const producer = asSchema(pair.producer);
		const consumer = asSchema(pair.consumer);
		assert.equal(producer["x-web-additive"], true, name);
		assert.equal(producer.additionalProperties, false, name);
		assert.equal(consumer["x-web-additive"], true, name);
		assert.equal(consumer.additionalProperties, true, name);

		const oldPayload = synthesize(pair.producer);
		assert.equal(Value.Check(pair.producer, oldPayload), true, name);
		assert.equal(Value.Check(pair.consumer, oldPayload), true, name);

		const additivePayload = {
			...(oldPayload as Record<string, unknown>),
			[fixture.futureTopLevelField]: {
				label: "ignored by the old browser",
			},
		};
		assert.equal(Value.Check(pair.producer, additivePayload), false, name);
		assert.equal(Value.Check(pair.consumer, additivePayload), true, name);

		const firstRequired = (
			producer.required as readonly string[] | undefined
		)?.[0];
		assert.ok(firstRequired, `${name} has no required field`);
		const removedRequired = structuredClone(
			oldPayload,
		) as Record<string, unknown>;
		delete removedRequired[firstRequired];
		assert.equal(Value.Check(pair.producer, removedRequired), false, name);
		assert.equal(Value.Check(pair.consumer, removedRequired), false, name);

		const nestedPath = findClosedNestedObjectPath(
			pair.producer,
			oldPayload,
		);
		assert.ok(nestedPath, `${name} has no strict nested authority object`);
		const nestedBreaking = structuredClone(oldPayload);
		objectAtPath(nestedBreaking, nestedPath).futureAuthorityField = true;
		assert.equal(Value.Check(pair.producer, nestedBreaking), false, name);
		assert.equal(Value.Check(pair.consumer, nestedBreaking), false, name);
	}
});

test("P17 committed request/action/cursor/SSE unions cover every closed branch", () => {
	const fixturePath = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"fixtures/web-v1/compatibility/additive-extension-points.json",
	);
	const fixture = JSON.parse(
		fs.readFileSync(fixturePath, "utf8"),
	) as CompatibilityFixture;
	const unions = {
		WebCommandRequest: {
			schema: WebCommandRequestSchema,
			branches: directUnionBranches(WebCommandRequestSchema),
		},
		WebActionRequestBase: {
			schema: WebActionRequestBaseSchema,
			branches: directUnionBranches(WebActionRequestBaseSchema),
		},
		WebAvailableAction: {
			schema: WebAvailableActionSchema,
			branches: availableActionBranches(),
		},
		WebCommandOutcome: {
			schema: WebCommandOutcomeSchema,
			branches: directUnionBranches(WebCommandOutcomeSchema),
		},
		WebPageCursorPayload: {
			schema: WebPageCursorPayloadSchema,
			branches: directUnionBranches(WebPageCursorPayloadSchema),
		},
		WebStreamFrame: {
			schema: WebStreamFrameSchema,
			branches: directUnionBranches(WebStreamFrameSchema),
		},
	} as const;
	assert.deepEqual(Object.keys(unions), Object.keys(fixture.closedUnions));
	for (const [name, entry] of Object.entries(unions)) {
		assertClosedUnion(
			name,
			entry.schema,
			entry.branches,
			fixture.closedUnions[name] ?? [],
		);
	}
});

test("P17 every nested endpoint union branch is independently executable", () => {
	const roots: Array<readonly [string, TSchema]> = [];
	for (const [endpointId, endpoint] of Object.entries(WEB_ENDPOINTS)) {
		for (const [surface, schema] of [
			["params", endpoint.paramsSchema],
			["query", endpoint.querySchema],
			["body", endpoint.bodySchema],
			["success", endpoint.successDataSchema],
		] as const) {
			roots.push([`${endpointId}.${surface}`, schema]);
		}
	}
	roots.push(["failure", WebApiErrorResponseSchema]);
	const occurrences = roots.flatMap(([root, schema]) =>
		collectNestedUnions(root, schema),
	);
	let branchCount = 0;
	for (const occurrence of occurrences) {
		for (const [index, branch] of occurrence.branches.entries()) {
			const value = synthesize(branch, index + 1);
			assert.equal(
				Value.Check(branch, value),
				true,
				`${occurrence.root}:${occurrence.path}.anyOf[${index}]`,
			);
			assert.equal(
				Value.Check(occurrence.schema, value),
				true,
				`${occurrence.root}:${occurrence.path}`,
			);
			branchCount += 1;
		}
	}
	assert.deepEqual(
		{
			roots: roots.length,
			unionOccurrences: occurrences.length,
			unionBranches: branchCount,
		},
			{
				roots: 117,
				unionOccurrences: 1_063,
				unionBranches: 14_138,
			},
		);
});

test("P17 all 29 endpoint codecs have strict JSON-round-trip samples", () => {
	assert.equal(Object.keys(WEB_ENDPOINTS).length, 29);
	for (const [endpointId, endpoint] of Object.entries(WEB_ENDPOINTS)) {
		for (const [surface, schema] of [
			["params", endpoint.paramsSchema],
			["query", endpoint.querySchema],
			["body", endpoint.bodySchema],
			["success", endpoint.successDataSchema],
		] as const) {
			const sample = synthesize(schema);
			assert.equal(
				Value.Check(schema, sample),
				true,
				`${endpointId}.${surface}`,
			);
			const roundTrip = JSON.parse(JSON.stringify(sample)) as unknown;
			assert.deepEqual(
				roundTrip,
				sample,
				`${endpointId}.${surface} JSON round-trip`,
			);
			assert.equal(
				Value.Check(schema, roundTrip),
				true,
				`${endpointId}.${surface} decoded`,
			);
		}
		const success = synthesize(endpoint.successDataSchema);
		assert.equal(
			Value.Check(endpoint.consumerSuccessDataSchema, success),
			true,
			`${endpointId}.consumer`,
		);
	}
});

test("P17 failure envelope covers every closed ControlError code", () => {
	const base = synthesize(
		WebApiErrorResponseSchema,
	) as Record<string, unknown>;
	for (const code of TF_ERROR_CODES) {
		const sample = structuredClone(base) as {
			error: Record<string, unknown>;
		};
		sample.error.code = code;
		assert.equal(
			Value.Check(WebApiErrorResponseSchema, sample),
			true,
			code,
		);
		const unknownErrorField = structuredClone(sample);
		unknownErrorField.error.futureAuthority = true;
		assert.equal(
			Value.Check(WebApiErrorResponseSchema, unknownErrorField),
			false,
			`${code} accepted an unknown error field`,
		);
	}
});
