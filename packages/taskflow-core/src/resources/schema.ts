import * as path from "node:path";
import { Type, type TSchema } from "typebox";
import { Errors as SchemaErrors } from "typebox/value";

export const WORKSPACE_ACCESS = ["read-only", "read-write"] as const;
export const PATH_INTENTS = [
	"existing-file",
	"existing-directory",
	"create-file",
	"create-directory",
	"executable",
] as const;
export const CAPABILITY_LIFETIMES = ["phase", "run", "external"] as const;

export const WorkspaceAccessSchema = Type.Union(WORKSPACE_ACCESS.map((value) => Type.Literal(value)));
export type WorkspaceAccess = (typeof WORKSPACE_ACCESS)[number];

export const PathIntentSchema = Type.Union(PATH_INTENTS.map((value) => Type.Literal(value)));
export type PathIntent = (typeof PATH_INTENTS)[number];

export const CapabilityLifetimeSchema = Type.Union(
	CAPABILITY_LIFETIMES.map((scope) => Type.Object({ scope: Type.Literal(scope) }, { additionalProperties: false })),
);
export type CapabilityLifetime = { scope: "phase" } | { scope: "run" } | { scope: "external" };

export const BoundCapabilityLifetimeSchema = Type.Union([
	Type.Object(
		{
			scope: Type.Literal("phase"),
			runId: Type.String({ minLength: 1 }),
			phaseId: Type.String({ minLength: 1 }),
			attemptId: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ scope: Type.Literal("run"), runId: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			scope: Type.Literal("external"),
			bindingId: Type.String({ minLength: 1 }),
			providerInstanceId: Type.Optional(Type.String({ minLength: 1 })),
		},
		{ additionalProperties: false },
	),
]);
export type BoundCapabilityLifetime =
	| { scope: "phase"; runId: string; phaseId: string; attemptId: string }
	| { scope: "run"; runId: string }
	| { scope: "external"; bindingId: string; providerInstanceId?: string };

export const HandleRefSchema = Type.Object(
	{
		producerPhaseId: Type.String({ minLength: 1 }),
		exportName: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export interface HandleRef {
	producerPhaseId: string;
	exportName: string;
}

const LiteralPathExprSchema = Type.Object(
	{
		literalPath: Type.String({ minLength: 1 }),
		argPath: Type.Optional(Type.Never()),
		segments: Type.Optional(Type.Never()),
	},
	{ additionalProperties: false },
);

const ArgPathExprSchema = Type.Object(
	{
		argPath: Type.String({ minLength: 1 }),
		literalPath: Type.Optional(Type.Never()),
		segments: Type.Optional(Type.Never()),
	},
	{ additionalProperties: false },
);

const SegmentExprSchema = Type.Union([
	Type.Object(
		{ segment: Type.String({ minLength: 1 }), argSegment: Type.Optional(Type.Never()) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ argSegment: Type.String({ minLength: 1 }), segment: Type.Optional(Type.Never()) },
		{ additionalProperties: false },
	),
]);

const SegmentsExprSchema = Type.Object(
	{
		segments: Type.Array(SegmentExprSchema, { minItems: 1 }),
		literalPath: Type.Optional(Type.Never()),
		argPath: Type.Optional(Type.Never()),
	},
	{ additionalProperties: false },
);

export const RelativePathExprSchema = Type.Union([
	LiteralPathExprSchema,
	ArgPathExprSchema,
	SegmentsExprSchema,
]);
export type RelativePathExpr =
	| { literalPath: string }
	| { argPath: string }
	| { segments: Array<{ segment: string } | { argSegment: string }> };

const pathRefBase = {
	subpath: Type.Optional(RelativePathExprSchema),
	access: Type.Optional(WorkspaceAccessSchema),
	maxLifetime: Type.Optional(CapabilityLifetimeSchema),
	intent: PathIntentSchema,
};

export const PathRefSchema = Type.Union([
	Type.Object(
		{ ...pathRefBase, workspace: Type.String({ minLength: 1 }), handle: Type.Optional(Type.Never()) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...pathRefBase, handle: HandleRefSchema, workspace: Type.Optional(Type.Never()) },
		{ additionalProperties: false },
	),
]);
interface PathRefBase {
	subpath?: RelativePathExpr;
	access?: WorkspaceAccess;
	maxLifetime?: CapabilityLifetime;
	intent: PathIntent;
}

export type PathRef = PathRefBase &
	({ workspace: string; handle?: never } | { handle: HandleRef; workspace?: never });
export type NormalizedPathRef = PathRef & { access: WorkspaceAccess };

export interface ResourceVersion {
	identityMode: "portable" | "path-bound" | "unavailable";
	contentId?: string;
	scopeDigest?: string;
	generation: number;
	state: "clean" | "write-pending" | "dirty-unknown";
}

export interface ScopedCapability {
	bindingId: string;
	resourceDomainId: string;
	providerInstanceId: string;
	logicalWorkspaceId: string;
	logicalPrefix: string;
	physicalScopeRoot: string;
	access: WorkspaceAccess;
	version: ResourceVersion;
	lifetime: BoundCapabilityLifetime;
}

export type ResourceSchemaResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const WINDOWS_RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/i;
const WINDOWS_FORBIDDEN_CHAR_RE = /[<>:"|?*]/;

function shapeErrors(schema: TSchema, input: unknown): string[] {
	return [...SchemaErrors(schema, input)].map((issue) => `${issue.instancePath || "/"}: ${issue.message}`);
}

function validateShape<T>(schema: TSchema, input: unknown): ResourceSchemaResult<T> {
	const errors = shapeErrors(schema, input);
	return errors.length === 0 ? { ok: true, value: input as T } : { ok: false, errors };
}

/** Normalize and validate the portable multi-segment relative-path grammar. */
export function normalizePortableRelativePath(input: unknown): ResourceSchemaResult<string> {
	if (typeof input !== "string") return { ok: false, errors: ["relative path must be a string"] };
	const normalized = input.normalize("NFC");
	if (normalized.length === 0) return { ok: false, errors: ["relative path must not be empty"] };
	if (normalized.includes("\0")) return { ok: false, errors: ["relative path must not contain NUL"] };
	if (/[\u0001-\u001f\u007f]/.test(normalized)) {
		return { ok: false, errors: ["relative path must not contain control characters"] };
	}
	if (normalized.includes("\\")) {
		return { ok: false, errors: ["relative path must use portable '/' separators"] };
	}
	if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
		return { ok: false, errors: ["relative path must not be absolute, drive-qualified, UNC, or device-qualified"] };
	}
	const segments = normalized.split("/");
	for (const segment of segments) {
		const segmentResult = normalizePortablePathSegment(segment);
		if (!segmentResult.ok) return segmentResult;
	}
	return { ok: true, value: segments.join("/") };
}

/** Normalize and validate exactly one portable path segment. */
export function normalizePortablePathSegment(input: unknown): ResourceSchemaResult<string> {
	if (typeof input !== "string") return { ok: false, errors: ["path segment must be a string"] };
	const normalized = input.normalize("NFC");
	if (normalized.length === 0) return { ok: false, errors: ["path segment must not be empty"] };
	if (normalized === "." || normalized === "..") {
		return { ok: false, errors: ["path segment must not be '.' or '..'"] };
	}
	if (normalized.includes("/") || normalized.includes("\\")) {
		return { ok: false, errors: ["path segment must contain exactly one segment"] };
	}
	if (normalized.includes("\0") || /[\u0001-\u001f\u007f]/.test(normalized)) {
		return { ok: false, errors: ["path segment must not contain NUL or control characters"] };
	}
	if (normalized.endsWith(".") || normalized.endsWith(" ")) {
		return { ok: false, errors: ["path segment must not end with a dot or space"] };
	}
	if (WINDOWS_FORBIDDEN_CHAR_RE.test(normalized) || WINDOWS_RESERVED_NAME_RE.test(normalized)) {
		return { ok: false, errors: [`path segment '${normalized}' is not portable`] };
	}
	return { ok: true, value: normalized };
}

function normalizeLogicalId(value: string): ResourceSchemaResult<string> {
	const normalized = value.normalize("NFC");
	if (normalized.length === 0 || normalized.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(normalized)) {
		return { ok: false, errors: ["logical identifier must be non-empty and contain no control characters"] };
	}
	return { ok: true, value: normalized };
}

export function validateWorkspaceAccess(input: unknown): ResourceSchemaResult<WorkspaceAccess> {
	return validateShape(WorkspaceAccessSchema, input);
}

export function validatePathIntent(input: unknown): ResourceSchemaResult<PathIntent> {
	return validateShape(PathIntentSchema, input);
}

export function validateCapabilityLifetime(input: unknown): ResourceSchemaResult<CapabilityLifetime> {
	return validateShape(CapabilityLifetimeSchema, input);
}

export function validateBoundCapabilityLifetime(input: unknown): ResourceSchemaResult<BoundCapabilityLifetime> {
	return validateShape(BoundCapabilityLifetimeSchema, input);
}

export function validateRelativePathExpr(input: unknown): ResourceSchemaResult<RelativePathExpr> {
	const shaped = validateShape<RelativePathExpr>(RelativePathExprSchema, input);
	if (!shaped.ok) return shaped;
	const expr = shaped.value;
	if ("literalPath" in expr && expr.literalPath !== undefined) {
		const normalized = normalizePortableRelativePath(expr.literalPath);
		return normalized.ok ? { ok: true, value: { literalPath: normalized.value } } : normalized;
	}
	if ("argPath" in expr && expr.argPath !== undefined) {
		const normalized = normalizeLogicalId(expr.argPath);
		return normalized.ok ? { ok: true, value: { argPath: normalized.value } } : normalized;
	}
	if (!("segments" in expr) || !Array.isArray(expr.segments)) {
		return { ok: false, errors: ["relative path expression must select exactly one expression form"] };
	}
	const segments: Array<{ segment: string } | { argSegment: string }> = [];
	for (const item of expr.segments) {
		if ("segment" in item && item.segment !== undefined) {
			const normalized = normalizePortablePathSegment(item.segment);
			if (!normalized.ok) return normalized;
			segments.push({ segment: normalized.value });
		} else if ("argSegment" in item && item.argSegment !== undefined) {
			const normalized = normalizeLogicalId(item.argSegment);
			if (!normalized.ok) return normalized;
			segments.push({ argSegment: normalized.value });
		} else {
			return { ok: false, errors: ["segment expression must select exactly one expression form"] };
		}
	}
	return { ok: true, value: { segments } };
}

export function validatePathRef(input: unknown): ResourceSchemaResult<NormalizedPathRef> {
	const shaped = validateShape<PathRef>(PathRefSchema, input);
	if (!shaped.ok) return shaped;
	const ref = shaped.value;
	const subpath = ref.subpath === undefined ? undefined : validateRelativePathExpr(ref.subpath);
	if (subpath !== undefined && !subpath.ok) return subpath;

	if ("workspace" in ref && ref.workspace !== undefined) {
		const workspace = normalizeLogicalId(ref.workspace);
		if (!workspace.ok) return workspace;
		return {
			ok: true,
			value: {
				workspace: workspace.value,
				intent: ref.intent,
				access: ref.access ?? "read-only",
				...(ref.maxLifetime === undefined ? {} : { maxLifetime: ref.maxLifetime }),
				...(subpath === undefined ? {} : { subpath: subpath.value }),
			},
		};
	}

	if (!("handle" in ref) || ref.handle === undefined) {
		return { ok: false, errors: ["path reference must select exactly one capability source"] };
	}
	const producerPhaseId = normalizeLogicalId(ref.handle.producerPhaseId);
	const exportName = normalizeLogicalId(ref.handle.exportName);
	if (!producerPhaseId.ok) return producerPhaseId;
	if (!exportName.ok) return exportName;
	return {
		ok: true,
		value: {
			handle: { producerPhaseId: producerPhaseId.value, exportName: exportName.value },
			intent: ref.intent,
			access: ref.access ?? "read-only",
			...(ref.maxLifetime === undefined ? {} : { maxLifetime: ref.maxLifetime }),
			...(subpath === undefined ? {} : { subpath: subpath.value }),
		},
	};
}

export function accessAllows(maximum: WorkspaceAccess, requested: WorkspaceAccess): boolean {
	return maximum === "read-write" || requested === "read-only";
}

export function lifetimeRank(lifetime: CapabilityLifetime | BoundCapabilityLifetime): number {
	return lifetime.scope === "phase" ? 0 : lifetime.scope === "run" ? 1 : 2;
}
