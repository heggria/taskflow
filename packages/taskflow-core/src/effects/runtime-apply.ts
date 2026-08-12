/**
 * Runtime bridge from declared `fs.write` effects to the existing resource
 * control plane. Admission happens before the phase body and finalization uses
 * the same PathRef resolutions, persistent leases, durable journal intent, and
 * mutation permit. No effects-layer commit authority exists here.
 */

import type { ResolveOnlyPhaseBinding } from "../resources/execution.ts";
import type {
	FileTransactionResult,
	PreparedResourceFileTransaction,
} from "../resources/file-transaction.ts";
import type { PathRef } from "../resources/schema.ts";
import type { EffectDecl } from "./types.ts";
import { pathRefRelativeKey, pathsOverlap, validateEffectIR } from "./validate.ts";

export interface DeclaredFsWrite {
	effectId: string;
	relativePath: string;
	content: string | Buffer;
}

export type CollectDeclaredFsWritesResult =
	| { ok: true; writes: DeclaredFsWrite[] }
	| { ok: false; reason: string; code: string };

export interface PreparedDeclaredFsWrites {
	transaction: PreparedResourceFileTransaction;
	effects: unknown;
}

export type PrepareDeclaredFsWritesResult =
	| { ok: true; prepared?: PreparedDeclaredFsWrites }
	| { ok: false; reason: string; code: string };

export type FinalizePreparedDeclaredFsWritesResult =
	| { ok: true; intentId?: string; committedPaths: string[]; commitGeneration?: number }
	| {
			ok: false;
			intentId?: string;
			reason: string;
			code: string;
			restored: boolean;
	  };

export function precheckDeclaredFsWriteOverlap(
	writes: readonly DeclaredFsWrite[],
): { ok: true } | { ok: false; reason: string; pathA: string; pathB: string; effectIdA: string; effectIdB: string } {
	for (let i = 0; i < writes.length; i++) {
		const a = writes[i]!;
		for (let j = i + 1; j < writes.length; j++) {
			const b = writes[j]!;
			if (pathsOverlap(a.relativePath, b.relativePath)) {
				return {
					ok: false,
					reason:
						`mutating declared writes '${a.effectId}' and '${b.effectId}' overlap on path ` +
						`('${a.relativePath}' vs '${b.relativePath}')`,
					pathA: a.relativePath,
					pathB: b.relativePath,
					effectIdA: a.effectId,
					effectIdB: b.effectId,
				};
			}
		}
	}
	return { ok: true };
}

export function hasDeclaredFsWriteEffects(effects: unknown): boolean {
	return Array.isArray(effects) && effects.some((effect) =>
		effect !== null && typeof effect === "object" && (effect as { kind?: unknown }).kind === "fs.write");
}

export function validateDeclaredEffectsBeforeAdmission(effects: unknown): CollectDeclaredFsWritesResult {
	if (!Array.isArray(effects) || effects.length === 0) return { ok: true, writes: [] };
	const validation = validateEffectIR({ effects: effects as EffectDecl[] });
	if (!validation.ok) {
		return {
			ok: false,
			code: "effectir-invalid",
			reason: validation.issues
				.filter((issue) => issue.severity === "error")
				.map((issue) => issue.message)
				.join("; ") || "EffectIR validation failed",
		};
	}
	for (const effect of effects as EffectDecl[]) {
		if (effect.kind !== "fs.write") {
			return {
				ok: false,
				code: "unsupported-effect-kind",
				reason: `effect '${effect.id}': ${effect.kind} has no bound resource backend in the 0.3 fs.write slice`,
			};
		}
	}
	return { ok: true, writes: [] };
}

export async function preparePhaseDeclaredFsWrites(
	binding: ResolveOnlyPhaseBinding,
	opts: { effects: unknown; signal?: AbortSignal },
): Promise<PrepareDeclaredFsWritesResult> {
	const valid = validateDeclaredEffectsBeforeAdmission(opts.effects);
	if (!valid.ok) return valid;
	if (!hasDeclaredFsWriteEffects(opts.effects)) return { ok: true };
	const effects = opts.effects as EffectDecl[];
	const targets: Array<{ effectId: string; path: PathRef }> = [];
	for (const effect of effects) {
		if (effect.kind !== "fs.write") continue;
		if (effect.target.kind !== "path") {
			return {
				ok: false,
				code: "invalid-path-ref",
				reason: `effect '${effect.id}': fs.write requires a path target`,
			};
		}
		targets.push({ effectId: effect.id, path: effect.target.path });
	}
	try {
		const transaction = await binding.beginFileWriteTransaction(targets, {
			unitId: binding.phaseId,
			signal: opts.signal,
		});
		return { ok: true, prepared: { transaction, effects: opts.effects } };
	} catch (error) {
		return {
			ok: false,
			code: "resource-admission-failed",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

function fromFileTransactionResult(result: FileTransactionResult): FinalizePreparedDeclaredFsWritesResult {
	return result.ok
		? {
				ok: true,
				intentId: result.intentId,
				committedPaths: result.committedPaths,
				commitGeneration: result.commitGeneration,
			}
		: {
				ok: false,
				intentId: result.intentId,
				code: result.code,
				reason: result.reason,
				restored: result.restored,
			};
}

export async function finalizePreparedDeclaredFsWrites(
	prepared: PreparedDeclaredFsWrites | undefined,
	phaseOutput: string,
): Promise<FinalizePreparedDeclaredFsWritesResult> {
	if (!prepared) return { ok: true, committedPaths: [] };
	const collected = declaredFsWritesFromPhaseOutput(prepared.effects, phaseOutput);
	if (!collected.ok) {
		const rejected = await prepared.transaction.reject(collected.reason);
		return {
			ok: false,
			intentId: rejected.intentId,
			code: collected.code,
			reason: collected.reason,
			restored: !rejected.ok && rejected.restored,
		};
	}
	return fromFileTransactionResult(await prepared.transaction.commit(collected.writes));
}

export async function rejectPreparedDeclaredFsWrites(
	prepared: PreparedDeclaredFsWrites | undefined,
	reason: string,
): Promise<FinalizePreparedDeclaredFsWritesResult> {
	if (!prepared) return { ok: true, committedPaths: [] };
	return fromFileTransactionResult(await prepared.transaction.reject(reason));
}

/** Resolve phase output into the exact payload set admitted before execution. */
export function declaredFsWritesFromPhaseOutput(
	effects: unknown,
	phaseOutput: string,
): CollectDeclaredFsWritesResult {
	if (effects === undefined || effects === null) return { ok: true, writes: [] };
	if (!Array.isArray(effects)) {
		return { ok: false, code: "effects-not-array", reason: "phase.effects must be an array" };
	}
	if (effects.length === 0) return { ok: true, writes: [] };

	const declarations: Array<{ effectId: string; relativePath: string }> = [];
	for (const raw of effects) {
		if (!raw || typeof raw !== "object") {
			return { ok: false, code: "invalid-effect", reason: "each effect must be an object" };
		}
		const effect = raw as Record<string, unknown>;
		const effectId = typeof effect.id === "string" && effect.id.length > 0 ? effect.id : "";
		if (!effectId) return { ok: false, code: "invalid-effect", reason: "effect requires non-empty id" };
		if (effect.kind === "fs.delete") {
			return {
				ok: false,
				code: "unsupported-effect-kind",
				reason: `effect '${effectId}': fs.delete is not supported by the file transaction`,
			};
		}
		if (effect.kind !== "fs.write") continue;
		const target = effect.target;
		if (!target || typeof target !== "object" || (target as { kind?: unknown }).kind !== "path") {
			return { ok: false, code: "invalid-path-ref", reason: `effect '${effectId}': fs.write requires a path target` };
		}
		const pathRef = (target as { path?: unknown }).path;
		if (!pathRef || typeof pathRef !== "object") {
			return { ok: false, code: "invalid-path-ref", reason: `effect '${effectId}': fs.write path target requires PathRef` };
		}
		// Authority/path resolution already happened before the body through the
		// resource binding. Payload mapping needs only the stable effect id; retain
		// a diagnostic label for dynamic PathRefs instead of re-resolving them here.
		const relativePath = pathRefRelativeKey(pathRef as PathRef) ?? `<resolved:${effectId}>`;
		if (relativePath === "") {
			return { ok: false, code: "path-too-broad", reason: `effect '${effectId}': cannot write whole workspace root` };
		}
		declarations.push({ effectId, relativePath });
	}
	if (declarations.length === 0) return { ok: true, writes: [] };
	if (declarations.length === 1) {
		const declaration = declarations[0]!;
		return {
			ok: true,
			writes: [{ effectId: declaration.effectId, relativePath: declaration.relativePath, content: phaseOutput }],
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(phaseOutput);
	} catch {
		return {
			ok: false,
			code: "content-resolution-failed",
			reason: "multiple fs.write effects require a JSON object mapping effect id to string content",
		};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {
			ok: false,
			code: "content-resolution-failed",
			reason: "multiple fs.write effects require a JSON object mapping effect id to string content",
		};
	}
	const map = parsed as Record<string, unknown>;
	const writes: DeclaredFsWrite[] = [];
	for (const declaration of declarations) {
		const content = map[declaration.effectId];
		if (typeof content !== "string") {
			return {
				ok: false,
				code: "content-resolution-failed",
				reason: `missing string content for effect '${declaration.effectId}' in phase JSON output`,
			};
		}
		writes.push({ ...declaration, content });
	}
	return { ok: true, writes };
}
