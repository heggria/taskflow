/**
 * Shared emit context for kind handlers (one eraseSource() call).
 */

import ts from "typescript";
import type { Diagnostic } from "../../diagnostics.ts";
import type { PhaseDraft } from "./types.ts";

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
	ctx.phases.set(draft.id, draft);
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
		const pid = defArg.expression.text;
		if (phases.has(pid) && (defArg.name.text === "json" || defArg.name.text === "output")) {
			draft.dependsOn.add(pid);
			draft.raw.def =
				defArg.name.text === "json" ? `{steps.${pid}.json}` : `{steps.${pid}.output}`;
		}
	} else if (tsIsStringLiteral(defArg)) {
		draft.raw.def = defArg.text;
	} else if (tsIsIdentifier(defArg) && phases.has(defArg.text)) {
		draft.dependsOn.add(defArg.text);
		draft.raw.def = `{steps.${defArg.text}.json}`;
	}
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
