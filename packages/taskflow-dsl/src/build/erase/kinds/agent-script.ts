import ts from "typescript";
import { mergeOpts, phaseIdFromBinding } from "../opts.ts";
import { eraseStringish } from "../templates.ts";
import type { PhaseDraft } from "../types.ts";
import { type EmitContext, nextSyntheticId, register } from "../context.ts";

export function emitAgent(
	ctx: EmitContext,
	bindName: string | undefined,
	call: ts.CallExpression,
	itemParam?: string,
): string {
	const idBase = bindName ?? nextSyntheticId(ctx, "phase");
	const draft: PhaseDraft = {
		id: idBase,
		binding: idBase,
		type: "agent",
		raw: { type: "agent" },
		dependsOn: new Set(),
	};
	const taskArg = call.arguments[0];
	const optsArg = call.arguments[1] as ts.Expression | undefined;
	if (taskArg) {
		const erased = eraseStringish(ctx.sf, ctx.file, taskArg, itemParam, ctx.phases, ctx.diags);
		if (erased) {
			draft.raw.task = erased.text;
			for (const d of erased.deps) draft.dependsOn.add(d);
		}
	}
	const opts = mergeOpts(ctx.sf, ctx.file, optsArg, ctx.diags, ctx.phases);
	if (typeof opts.id === "string") draft.id = opts.id;
	else draft.id = phaseIdFromBinding(idBase, opts);
	Object.assign(draft.raw, opts);
	if (Array.isArray(opts.dependsOn)) for (const d of opts.dependsOn as string[]) draft.dependsOn.add(d);
	if (opts.final === true) draft.final = true;
	return register(ctx, draft);
}

export function emitScript(
	ctx: EmitContext,
	bindName: string | undefined,
	call: ts.CallExpression,
	itemParam?: string,
): string {
	const idBase = bindName ?? nextSyntheticId(ctx, "phase");
	const draft: PhaseDraft = {
		id: idBase,
		binding: idBase,
		type: "script",
		raw: { type: "script" },
		dependsOn: new Set(),
	};
	const taskArg = call.arguments[0];
	const optsArg = call.arguments[1] as ts.Expression | undefined;
	if (taskArg) {
		if (ts.isArrayLiteralExpression(taskArg)) {
			const arr = taskArg.elements.map((el) => {
				if (ts.isStringLiteral(el)) return el.text;
				const er = eraseStringish(ctx.sf, ctx.file, el as ts.Expression, itemParam, ctx.phases, ctx.diags);
				if (er) {
					for (const d of er.deps) draft.dependsOn.add(d);
					return er.text;
				}
				return "";
			});
			draft.raw.run = arr;
		} else {
			const erased = eraseStringish(ctx.sf, ctx.file, taskArg, itemParam, ctx.phases, ctx.diags);
			if (erased) {
				draft.raw.run = erased.text;
				for (const d of erased.deps) draft.dependsOn.add(d);
			}
		}
	}
	const opts = mergeOpts(ctx.sf, ctx.file, optsArg, ctx.diags, ctx.phases);
	if (typeof opts.id === "string") draft.id = opts.id;
	else draft.id = phaseIdFromBinding(idBase, opts);
	Object.assign(draft.raw, opts);
	if (Array.isArray(opts.dependsOn)) for (const d of opts.dependsOn as string[]) draft.dependsOn.add(d);
	if (opts.final === true) draft.final = true;
	return register(ctx, draft);
}
