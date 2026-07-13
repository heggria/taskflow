/**
 * Shared emit context for kind handlers (one eraseSource() call).
 */

import ts from "typescript";
import type { Diagnostic } from "../../diagnostics.ts";
import { diag, evalLiteral } from "./ast.ts";
import { phaseByBinding, setPhaseBinding, type PhaseDraft } from "./types.ts";

export interface EmitContext {
	file: string;
	sf: ts.SourceFile;
	diags: Diagnostic[];
	phases: Map<string, PhaseDraft>;
	order: string[];
}

export function nextSyntheticId(ctx: EmitContext, prefix: string): string {
	return ctx.order.length === 0 ? "main" : `${prefix}-${ctx.order.length}`;
}

export function register(ctx: EmitContext, draft: PhaseDraft): string {
	delete draft.raw.id;
	// Union auto-wired deps with any explicit dependsOn already on raw (opts).
	const explicit = Array.isArray(draft.raw.dependsOn)
		? (draft.raw.dependsOn as unknown[]).filter((d): d is string => typeof d === "string")
		: [];
	for (const d of explicit) draft.dependsOn.add(d);
	if (draft.dependsOn.size) draft.raw.dependsOn = [...draft.dependsOn];
	else delete draft.raw.dependsOn;
	if (draft.final) draft.raw.final = true;
	const existing = ctx.phases.get(draft.id);
	if (existing && existing !== draft) {
		ctx.diags.push({
			code: "TFDSL_PHASE_ID_DUPLICATE",
			severity: "error",
			message: `Duplicate emitted phase id '${draft.id}'.`,
			file: ctx.file,
		});
		return draft.id;
	}
	ctx.phases.set(draft.id, draft);
	if (draft.binding) {
		const bound = phaseByBinding(ctx.phases, draft.binding);
		if (bound && bound !== draft) {
			ctx.diags.push({
				code: "TFDSL_BINDING_COLLISION",
				severity: "error",
				message: `Binding '${draft.binding}' collides with phase id '${bound.id}'.`,
				file: ctx.file,
			});
		} else {
			setPhaseBinding(ctx.phases, draft.binding, draft);
		}
	}
	if (!ctx.order.includes(draft.id)) ctx.order.push(draft.id);
	return draft.id;
}

/** Resolve def argument: plan.json / plan.output / string / phase id. */
export function bindDefArg(
	ctx: EmitContext,
	defArg: ts.Expression | undefined,
	draft: PhaseDraft,
): void {
	if (!defArg) return;
	const { phases } = ctx;
	if (tsIsPropertyAccess(defArg) && tsIsIdentifier(defArg.expression)) {
		const binding = defArg.expression.text;
		const pid = phaseByBinding(phases, binding)?.id;
		if (pid && (defArg.name.text === "json" || defArg.name.text === "output")) {
			draft.dependsOn.add(pid);
			draft.raw.def =
				defArg.name.text === "json" ? `{steps.${pid}.json}` : `{steps.${pid}.output}`;
		} else {
			ctx.diags.push(diag(ctx.file, ctx.sf, defArg, "TFDSL_INLINE_DEF_UNSUPPORTED", `def phase reference must be a previously declared phase.json or phase.output handle.`));
		}
	} else if (tsIsStringLiteral(defArg)) {
		draft.raw.def = defArg.text;
	} else if (tsIsIdentifier(defArg) && phaseByBinding(phases, defArg.text)) {
		const pid = phaseByBinding(phases, defArg.text)!.id;
		draft.dependsOn.add(pid);
		draft.raw.def = `{steps.${pid}.json}`;
	} else if (ts.isObjectLiteralExpression(defArg) || ts.isArrayLiteralExpression(defArg)) {
		const value = evalLiteral(defArg);
		if (containsUndefined(value)) {
			ctx.diags.push(diag(ctx.file, ctx.sf, defArg, "TFDSL_INLINE_DEF_DYNAMIC", `Inline def must contain only static JSON values.`));
		} else {
			draft.raw.def = value;
		}
	} else {
		ctx.diags.push(diag(ctx.file, ctx.sf, defArg, "TFDSL_INLINE_DEF_UNSUPPORTED", `def must be a phase handle, string, or static Taskflow object.`));
	}
}

function containsUndefined(value: unknown): boolean {
	if (value === undefined) return true;
	if (Array.isArray(value)) return value.some(containsUndefined);
	if (value && typeof value === "object") return Object.values(value).some(containsUndefined);
	return false;
}

function tsIsPropertyAccess(n: ts.Node): n is ts.PropertyAccessExpression {
	return ts.isPropertyAccessExpression(n);
}
function tsIsIdentifier(n: ts.Node): n is ts.Identifier {
	return ts.isIdentifier(n);
}
function tsIsStringLiteral(n: ts.Node): n is ts.StringLiteral {
	return ts.isStringLiteral(n);
}
