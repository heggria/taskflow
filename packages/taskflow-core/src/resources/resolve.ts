import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { workspacePolicyError, type WorkspacePolicyError } from "./errors.ts";
import {
	accessAllows,
	lifetimeRank,
	normalizePortablePathSegment,
	normalizePortableRelativePath,
	validatePathRef,
	validateRelativePathExpr,
	type BoundCapabilityLifetime,
	type CapabilityLifetime,
	type HandleRef,
	type NormalizedPathRef,
	type PathIntent,
	type RelativePathExpr,
	type ScopedCapability,
	type WorkspaceAccess,
} from "./schema.ts";

const RESOLVED_PATH_REF: unique symbol = Symbol("taskflow.resolved-path-ref");
const resolvedPathRefs = new WeakSet<object>();

export interface PathArgumentEnvironment {
	/** Flow-authored argument declarations. Legacy declarations have no `type`. */
	definitions: Readonly<Record<string, unknown>>;
	/** Already validated invocation values; defaults are read from definitions if absent. */
	values: Readonly<Record<string, unknown>>;
}

export interface CapabilityEnvironment {
	workspaces: ReadonlyMap<string, ScopedCapability>;
	handles?: ReadonlyMap<string, ScopedCapability>;
	runId: string;
	phaseId: string;
	attemptId: string;
	resolutionTokenTtlMs?: number;
	now?: () => number;
	mintResolutionTokenId?: () => string;
}

export interface ResolvedPathRef {
	readonly [RESOLVED_PATH_REF]: true;
	readonly resolutionTokenId: string;
	readonly expiresAt: string;
	readonly capability: Readonly<ScopedCapability>;
	readonly logicalSubpath: string;
	readonly physicalPath: string;
	readonly intent: PathIntent;
}

export type ResolvePathRefResult =
	| { ok: true; value: ResolvedPathRef }
	| { ok: false; error: WorkspacePolicyError };

export type ResolveRelativePathResult =
	| { ok: true; value: string }
	| { ok: false; error: WorkspacePolicyError };

interface ArgSpecView {
	type?: unknown;
	default?: unknown;
	values?: unknown;
}

function invalidPath(message: string, logicalWorkspaceId?: string): WorkspacePolicyError {
	return workspacePolicyError("TFWS_INVALID_PATH", message, {
		...(logicalWorkspaceId === undefined ? {} : { logicalWorkspaceId }),
	});
}

function resolveArg(name: string, args: PathArgumentEnvironment):
	| { ok: true; spec: ArgSpecView; value: unknown }
	| { ok: false; error: WorkspacePolicyError } {
	const rawSpec = args.definitions[name];
	if (!Object.prototype.hasOwnProperty.call(args.definitions, name)) {
		return { ok: false, error: invalidPath(`Path argument '${name}' must have an explicit typed declaration`) };
	}
	if (typeof rawSpec !== "object" || rawSpec === null || Array.isArray(rawSpec)) {
		return { ok: false, error: invalidPath(`Path argument '${name}' must have an explicit typed declaration`) };
	}
	const spec = rawSpec as ArgSpecView;
	if (typeof spec.type !== "string") {
		return { ok: false, error: invalidPath(`Path argument '${name}' must have an explicit typed declaration`) };
	}
	const hasInvocationValue = Object.prototype.hasOwnProperty.call(args.values, name);
	const hasDefault = Object.prototype.hasOwnProperty.call(spec, "default");
	if (!hasInvocationValue && !hasDefault) {
		return { ok: false, error: invalidPath(`Path argument '${name}' has no invocation value or typed default`) };
	}
	const value = hasInvocationValue ? args.values[name] : spec.default;
	if (spec.type === "enum") {
		if (!Array.isArray(spec.values) || !spec.values.some((allowed) => Object.is(allowed, value))) {
			return { ok: false, error: invalidPath(`Path argument '${name}' does not match its typed enum declaration`) };
		}
	}
	return { ok: true, spec, value };
}

/** Resolve a symbolic expression using only explicitly typed invocation args. */
export function resolveRelativePathExpr(input: unknown, args: PathArgumentEnvironment): ResolveRelativePathResult {
	const parsed = validateRelativePathExpr(input);
	if (!parsed.ok) return { ok: false, error: invalidPath(parsed.errors.join("; ")) };
	const expr: RelativePathExpr = parsed.value;
	if ("literalPath" in expr) {
		const normalized = normalizePortableRelativePath(expr.literalPath);
		return normalized.ok
			? { ok: true, value: normalized.value }
			: { ok: false, error: invalidPath(normalized.errors.join("; ")) };
	}
	if ("argPath" in expr) {
		const selected = resolveArg(expr.argPath, args);
		if (!selected.ok) return selected;
		if (selected.spec.type !== "relative-path") {
			return { ok: false, error: invalidPath(`argPath '${expr.argPath}' must consume a typed relative-path argument`) };
		}
		const normalized = normalizePortableRelativePath(selected.value);
		return normalized.ok
			? { ok: true, value: normalized.value }
			: { ok: false, error: invalidPath(normalized.errors.join("; ")) };
	}

	const segments: string[] = [];
	for (const item of expr.segments) {
		if ("segment" in item) {
			const normalized = normalizePortablePathSegment(item.segment);
			if (!normalized.ok) return { ok: false, error: invalidPath(normalized.errors.join("; ")) };
			segments.push(normalized.value);
			continue;
		}
		const selected = resolveArg(item.argSegment, args);
		if (!selected.ok) return selected;
		if (!["string", "relative-path", "enum"].includes(String(selected.spec.type))) {
			return { ok: false, error: invalidPath(`argSegment '${item.argSegment}' must consume a typed string-like argument`) };
		}
		const normalized = normalizePortablePathSegment(selected.value);
		if (!normalized.ok) return { ok: false, error: invalidPath(normalized.errors.join("; ")) };
		segments.push(normalized.value);
	}
	return { ok: true, value: segments.join("/") };
}

export function handleRefKey(handle: HandleRef): string {
	return `${handle.producerPhaseId}\0${handle.exportName}`;
}

function sourceCapability(ref: NormalizedPathRef, env: CapabilityEnvironment):
	| { ok: true; value: ScopedCapability; source: "workspace" | "handle" }
	| { ok: false; error: WorkspacePolicyError } {
	if ("workspace" in ref && ref.workspace !== undefined) {
		const capability = env.workspaces.get(ref.workspace);
		return capability === undefined
			? {
				ok: false,
				error: workspacePolicyError("TFWS_UNKNOWN_WORKSPACE", `Logical workspace '${ref.workspace}' is not bound`, {
					logicalWorkspaceId: ref.workspace,
				}),
			}
			: { ok: true, value: capability, source: "workspace" };
	}
	const capability = env.handles?.get(handleRefKey(ref.handle));
	return capability === undefined
		? { ok: false, error: workspacePolicyError("TFWS_HANDLE_INVALID", "The workspace handle is unavailable or invalid") }
		: { ok: true, value: capability, source: "handle" };
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function checkCapabilityLifetime(capability: ScopedCapability, env: CapabilityEnvironment): WorkspacePolicyError | undefined {
	const lifetime = capability.lifetime;
	if (lifetime.scope === "run" && lifetime.runId !== env.runId) {
		return workspacePolicyError("TFWS_ACCESS_ESCALATION", "The workspace capability belongs to a different run");
	}
	if (
		lifetime.scope === "phase" &&
		(lifetime.runId !== env.runId || lifetime.phaseId !== env.phaseId || lifetime.attemptId !== env.attemptId)
	) {
		return workspacePolicyError("TFWS_ACCESS_ESCALATION", "The workspace capability belongs to a different phase attempt");
	}
	return undefined;
}

function bindLifetime(
	requested: CapabilityLifetime,
	parent: BoundCapabilityLifetime,
	env: CapabilityEnvironment,
): BoundCapabilityLifetime {
	if (requested.scope === "phase") {
		return { scope: "phase", runId: env.runId, phaseId: env.phaseId, attemptId: env.attemptId };
	}
	if (requested.scope === "run") return { scope: "run", runId: env.runId };
	if (parent.scope !== "external") throw new Error("external lifetime must have an external parent");
	return {
		scope: "external",
		bindingId: parent.bindingId,
		...(parent.providerInstanceId === undefined ? {} : { providerInstanceId: parent.providerInstanceId }),
	};
}

function nearestExistingAncestor(candidate: string):
	| { ok: true; lexicalPath: string; realPath: string }
	| { ok: false } {
	let current = candidate;
	while (true) {
		try {
			fs.lstatSync(current);
			return { ok: true, lexicalPath: current, realPath: fs.realpathSync(current) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false };
			const parent = path.dirname(current);
			if (parent === current) return { ok: false };
			current = parent;
		}
	}
}

function resolvePhysicalTarget(
	root: string,
	logicalSubpath: string,
	intent: PathIntent,
	logicalWorkspaceId: string,
): { ok: true; physicalPath: string } | { ok: false; error: WorkspacePolicyError } {
	let rootReal: string;
	try {
		rootReal = fs.realpathSync(root);
		if (!fs.statSync(rootReal).isDirectory()) throw new Error("not-directory");
	} catch {
		return { ok: false, error: invalidPath("The scoped workspace root is unavailable", logicalWorkspaceId) };
	}
	const candidate = logicalSubpath === "" ? rootReal : path.resolve(rootReal, ...logicalSubpath.split("/"));
	if (!isWithin(rootReal, candidate)) {
		return {
			ok: false,
			error: workspacePolicyError("TFWS_PATH_ESCAPE", "The selected path escapes its scoped workspace", {
				logicalWorkspaceId,
			}),
		};
	}

	if (intent === "create-file" || intent === "create-directory") {
		try {
			fs.lstatSync(candidate);
			return { ok: false, error: invalidPath("A create intent requires a non-existing target", logicalWorkspaceId) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				return { ok: false, error: invalidPath("The create target could not be inspected", logicalWorkspaceId) };
			}
		}
		const ancestor = nearestExistingAncestor(path.dirname(candidate));
		if (!ancestor.ok) return { ok: false, error: invalidPath("The create target has no usable ancestor", logicalWorkspaceId) };
		if (!isWithin(rootReal, ancestor.realPath)) {
			return {
				ok: false,
				error: workspacePolicyError("TFWS_PATH_ESCAPE", "The create target's existing ancestor escapes its scoped workspace", {
					logicalWorkspaceId,
				}),
			};
		}
		try {
			if (!fs.statSync(ancestor.realPath).isDirectory()) throw new Error("not-directory");
		} catch {
			return { ok: false, error: invalidPath("The create target's nearest ancestor is not a directory", logicalWorkspaceId) };
		}
		const suffix = path.relative(ancestor.lexicalPath, candidate);
		const physicalPath = path.resolve(ancestor.realPath, suffix);
		if (!isWithin(rootReal, physicalPath)) {
			return {
				ok: false,
				error: workspacePolicyError("TFWS_PATH_ESCAPE", "The create target escapes its scoped workspace", {
					logicalWorkspaceId,
				}),
			};
		}
		return { ok: true, physicalPath };
	}

	let targetReal: string;
	let stat: fs.Stats;
	try {
		targetReal = fs.realpathSync(candidate);
		stat = fs.statSync(targetReal);
	} catch {
		return { ok: false, error: invalidPath("The selected existing target is unavailable", logicalWorkspaceId) };
	}
	if (!isWithin(rootReal, targetReal)) {
		return {
			ok: false,
			error: workspacePolicyError("TFWS_PATH_ESCAPE", "The selected existing target resolves outside its scoped workspace", {
				logicalWorkspaceId,
			}),
		};
	}
	if (intent === "existing-file" && !stat.isFile()) {
		return { ok: false, error: invalidPath("The selected target is not a regular file", logicalWorkspaceId) };
	}
	if (intent === "existing-directory" && !stat.isDirectory()) {
		return { ok: false, error: invalidPath("The selected target is not a directory", logicalWorkspaceId) };
	}
	if (intent === "executable") {
		if (!stat.isFile()) return { ok: false, error: invalidPath("The selected executable is not a regular file", logicalWorkspaceId) };
		try {
			fs.accessSync(targetReal, fs.constants.X_OK);
		} catch {
			return { ok: false, error: invalidPath("The selected file is not executable", logicalWorkspaceId) };
		}
	}
	return { ok: true, physicalPath: targetReal };
}

export function resolvePathRef(
	input: unknown,
	env: CapabilityEnvironment,
	args: PathArgumentEnvironment,
): ResolvePathRefResult {
	const parsed = validatePathRef(input);
	if (!parsed.ok) return { ok: false, error: invalidPath(parsed.errors.join("; ")) };
	const ref = parsed.value;
	const source = sourceCapability(ref, env);
	if (!source.ok) return source;
	const capability = source.value;
	const lifetimeError = checkCapabilityLifetime(capability, env);
	if (lifetimeError !== undefined) return { ok: false, error: lifetimeError };
	if (!accessAllows(capability.access, ref.access)) {
		return {
			ok: false,
			error: workspacePolicyError("TFWS_ACCESS_ESCALATION", "The requested path access exceeds its workspace capability", {
				logicalWorkspaceId: capability.logicalWorkspaceId,
			}),
		};
	}
	const requestedLifetime = ref.maxLifetime ?? { scope: "phase" as const };
	if (lifetimeRank(requestedLifetime) > lifetimeRank(capability.lifetime) || (source.source === "handle" && requestedLifetime.scope === "external")) {
		return {
			ok: false,
			error: workspacePolicyError("TFWS_ACCESS_ESCALATION", "The requested path lifetime exceeds its workspace capability", {
				logicalWorkspaceId: capability.logicalWorkspaceId,
			}),
		};
	}
	const subpath = ref.subpath === undefined ? { ok: true as const, value: "" } : resolveRelativePathExpr(ref.subpath, args);
	if (!subpath.ok) return subpath;
	const physical = resolvePhysicalTarget(capability.physicalScopeRoot, subpath.value, ref.intent, capability.logicalWorkspaceId);
	if (!physical.ok) return physical;

	const logicalPrefix = [capability.logicalPrefix, subpath.value].filter((part) => part.length > 0).join("/");
	const ttlMs = env.resolutionTokenTtlMs ?? 30_000;
	if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 300_000) {
		return { ok: false, error: invalidPath("The resolver token lifetime is invalid", capability.logicalWorkspaceId) };
	}
	const now = env.now?.() ?? Date.now();
	if (!Number.isFinite(now)) return { ok: false, error: invalidPath("The resolver clock is invalid", capability.logicalWorkspaceId) };

	const attenuatedCapability = Object.freeze({
		...capability,
		logicalPrefix,
		physicalScopeRoot: physical.physicalPath,
		access: ref.access as WorkspaceAccess,
		lifetime: bindLifetime(requestedLifetime, capability.lifetime, env),
	});
	const resolved = Object.freeze({
		[RESOLVED_PATH_REF]: true as const,
		resolutionTokenId: env.mintResolutionTokenId?.() ?? randomUUID(),
		expiresAt: new Date(now + ttlMs).toISOString(),
		capability: attenuatedCapability,
		logicalSubpath: subpath.value,
		physicalPath: physical.physicalPath,
		intent: ref.intent,
	}) satisfies ResolvedPathRef;
	resolvedPathRefs.add(resolved);
	return { ok: true, value: resolved };
}

export function isResolvedPathRef(value: unknown): value is ResolvedPathRef {
	return typeof value === "object" && value !== null && resolvedPathRefs.has(value);
}
