/**
 * P17 application-shell asset manifest.
 *
 * Browser-safe schema only. The daemon owns filesystem verification and static
 * delivery; the web package owns manifest generation.
 */
import { type Static, type TLiteral, Type } from "typebox";
import { SAFE_ID_MAX_LENGTH, SAFE_ID_PATTERN } from "./validate-ids.ts";
import {
	WebNonNegativeSafeIntegerSchema,
	WebPositiveSafeIntegerSchema,
} from "./web-schema-primitives.ts";

const Sha256Schema = Type.String({
	pattern: "^sha256:[a-f0-9]{64}$",
});
const RelativeAssetPathSchema = Type.String({
	minLength: 1,
	maxLength: 512,
	pattern: "^(?:assets/[A-Za-z0-9._-]+|index\\.html)$",
});

const WEB_STATIC_MEDIA_TYPES = [
	"text/javascript; charset=utf-8",
	"text/css; charset=utf-8",
	"application/json; charset=utf-8",
	"application/manifest+json; charset=utf-8",
	"image/svg+xml",
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/x-icon",
	"font/woff2",
] as const;

function literalUnion<const Values extends readonly [string, ...string[]]>(
	values: Values,
) {
	return Type.Union(
		values.map((value) => Type.Literal(value)) as [
			TLiteral<Values[number]>,
			...TLiteral<Values[number]>[],
		],
	);
}

export const WebStaticMediaTypeSchema = literalUnion(WEB_STATIC_MEDIA_TYPES);

export const WebStaticRouteTokenSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("literal"),
			value: Type.String({
				minLength: 1,
				maxLength: SAFE_ID_MAX_LENGTH,
				pattern: SAFE_ID_PATTERN,
			}),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("safe-id"),
			name: Type.Union([
				Type.Literal("projectId"),
				Type.Literal("controlDomainId"),
				Type.Literal("runId"),
				Type.Literal("approvalRequestId"),
			]),
		},
		{ additionalProperties: false },
	),
]);

export const WebStaticRoutePatternSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			maxLength: 64,
			pattern: "^[a-z][a-z0-9-]*$",
		}),
		tokens: Type.Array(WebStaticRouteTokenSchema, { maxItems: 12 }),
	},
	{ additionalProperties: false },
);

export const WebAssetManifestSchema = Type.Object(
	{
		manifestVersion: Type.Literal("taskflow-web-assets.v1"),
		packageVersion: Type.String({ minLength: 1, maxLength: 128 }),
		webBuildId: Sha256Schema,
		protocolConsumer: Type.Object(
			{
				major: Type.Literal(1),
				minMinor: WebNonNegativeSafeIntegerSchema,
				maxMinor: WebNonNegativeSafeIntegerSchema,
			},
			{ additionalProperties: false },
		),
		entrypoint: Type.Object(
			{
				path: Type.Literal("index.html"),
				sha256: Sha256Schema,
			},
			{ additionalProperties: false },
		),
		assets: Type.Array(
			Type.Object(
				{
					path: RelativeAssetPathSchema,
					sha256: Sha256Schema,
					size: WebNonNegativeSafeIntegerSchema,
					mediaType: WebStaticMediaTypeSchema,
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 10_000 },
		),
		routeRegistry: Type.Object(
			{
				version: Type.Literal("taskflow-web-routes.v1"),
				patterns: Type.Array(WebStaticRoutePatternSchema, {
					minItems: 1,
					maxItems: 100,
				}),
				sha256: Sha256Schema,
			},
			{ additionalProperties: false },
		),
		contentCatalogs: Type.Object(
			{
				version: Type.Literal("taskflow-content.v1"),
				defaultLocale: Type.Literal("en"),
				supportedLocales: Type.Tuple([
					Type.Literal("en"),
					Type.Literal("zh-CN"),
				]),
				projectedKeysetSha256: Sha256Schema,
				staticKeysetSha256: Sha256Schema,
				keysetSha256: Sha256Schema,
				catalogs: Type.Tuple([
					Type.Object(
						{
							locale: Type.Literal("en"),
							path: RelativeAssetPathSchema,
							sha256: Sha256Schema,
							size: WebPositiveSafeIntegerSchema,
						},
						{ additionalProperties: false },
					),
					Type.Object(
						{
							locale: Type.Literal("zh-CN"),
							path: RelativeAssetPathSchema,
							sha256: Sha256Schema,
							size: WebPositiveSafeIntegerSchema,
						},
						{ additionalProperties: false },
					),
				]),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export type WebStaticMediaType = Static<typeof WebStaticMediaTypeSchema>;
export type WebStaticRouteToken = Static<typeof WebStaticRouteTokenSchema>;
export type WebStaticRoutePattern = Static<typeof WebStaticRoutePatternSchema>;
export type WebAssetManifest = Static<typeof WebAssetManifestSchema>;
