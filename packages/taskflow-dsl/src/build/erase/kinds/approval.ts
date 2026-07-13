import ts from "typescript";
import { mergeOpts } from "../opts.ts";
import { eraseStringish } from "../templates.ts";
import type { PhaseDraft } from "../types.ts";
import { type EmitContext, nextSyntheticId, register } from "../context.ts";

export function emitApproval(
	ctx: EmitContext,
	bindName: string | undefined,
	call: ts.CallExpression,
): string {
	const idBase = bindName ?? nextSyntheticId(ctx, "phase");
	const draft: PhaseDraft = {
		id: idBase,
		binding: idBase,
		type: "approval",
		raw: { type: "approval" },
		dependsOn: new Set(),
	};
	const optsArg = call.arguments[0] as ts.Expression | undefined;
	const opts = mergeOpts(ctx.sf, ctx.file, optsArg, ctx.diags, ctx.phases, { allowKeys: new Set(["request"]) });
	if (optsArg && ts.isObjectLiteralExpression(optsArg)) {
		for (const property of optsArg.properties) {
			if (!ts.isPropertyAssignment(property)) continue;
			const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
			if (key !== "request") continue;
			const erased = eraseStringish(ctx.sf, ctx.file, property.initializer, undefined, ctx.phases, ctx.diags);
			if (erased) {
				draft.raw.task = erased.text;
				for (const dep of erased.deps) draft.dependsOn.add(dep);
			}
		}
	}
	Object.assign(draft.raw, opts);
	delete draft.raw.request;
	if (typeof opts.id === "string") draft.id = opts.id;
	if (opts.final === true) draft.final = true;
	return register(ctx, draft);
}
