/** Closed TypeBox contract for EffectIR. Runtime authority still lives in resources/*. */

import { Type } from "typebox";
import { PathRefSchema } from "../resources/schema.ts";
import { StringEnum } from "../typebox-helpers.ts";
import {
	CONFIDENTIALITY_LABELS,
	EFFECT_KINDS,
	INTEGRITY_LABELS,
	type EffectDecl,
} from "./types.ts";

const ConfidentialitySchema = StringEnum(CONFIDENTIALITY_LABELS);
const IntegritySchema = StringEnum(INTEGRITY_LABELS);

const common = {
	id: Type.String({ minLength: 1 }),
	confidentiality: Type.Optional(ConfidentialitySchema),
	integrity: Type.Optional(IntegritySchema),
	purpose: Type.Optional(Type.String()),
};

const PathTargetSchema = Type.Object(
	{ kind: Type.Literal("path"), path: PathRefSchema },
	{ additionalProperties: false },
);

const SecretTargetSchema = Type.Object(
	{
		kind: Type.Literal("secret"),
		secret: Type.Object(
			{
				secretId: Type.String({ minLength: 1 }),
				issuer: Type.Optional(Type.String({ minLength: 1 })),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const ServiceTargetSchema = Type.Object(
	{
		kind: Type.Literal("service"),
		service: Type.Object(
			{
				serviceId: Type.String({ minLength: 1 }),
				operation: Type.Optional(Type.String({ minLength: 1 })),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const fsKinds = EFFECT_KINDS.filter((kind) => kind.startsWith("fs."));

const ClosedEffectDeclSchema = Type.Union([
	...fsKinds.map((kind) => Type.Object(
		{ ...common, kind: Type.Literal(kind), target: PathTargetSchema },
		{ additionalProperties: false },
	)),
	Type.Object(
		{ ...common, kind: Type.Literal("secret.read"), target: SecretTargetSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...common, kind: Type.Literal("service.call"), target: ServiceTargetSchema },
		{ additionalProperties: false },
	),
]);

// PathRefSchema deliberately uses optional Never fields to encode XOR, which
// TypeBox validates correctly at runtime but currently infers as `never` when
// nested through a union. Preserve the closed runtime schema while exposing
// the independently reviewed EffectDecl TypeScript contract.
export const EffectDeclSchema = Type.Unsafe<EffectDecl>(ClosedEffectDeclSchema);

export const EffectIRSchema = Type.Object(
	{ effects: Type.Array(EffectDeclSchema) },
	{ additionalProperties: false },
);
