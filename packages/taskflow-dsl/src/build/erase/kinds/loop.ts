import ts from "typescript";
import { mergeOpts } from "../opts.ts";
import { eraseLoopTask, eraseStringish } from "../templates.ts";
import type { PhaseDraft } from "../types.ts";
import { type EmitContext, nextSyntheticId, register } from "../context.ts";

export function emitLoop(
	ctx: EmitContext,
	bindName: string | undefined,
	call: ts.CallExpression,
): string {
	const idBase = bindName ?? nextSyntheticId(ctx, "phase");
	const draft: PhaseDraft = {
		id: idBase,
		binding: idBase,
		type: "loop",
		raw: { type: "loop" },
		dependsOn: new Set(),
	};
	const optsArg = call.arguments[0] as ts.Expression | undefined;
	const opts = mergeOpts(ctx.sf, ctx.file, optsArg, ctx.diags, ctx.phases, { allowKeys: new Set(["task"]) });
	if (typeof opts.id === "string") draft.id = opts.id;
	Object.assign(draft.raw, opts);
	// task: (prev) => `...` inside object — scan object for task method
	if (optsArg && ts.isObjectLiteralExpression(optsArg)) {
		for (const p of optsArg.properties) {
			if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
			if (p.name.text === "task") {
				if (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer)) {
					const prev = p.initializer.parameters[0];
					const prevNm = prev && ts.isIdentifier(prev.name) ? prev.name.text : "prev";
					let expr: ts.Expression | undefined = ts.isBlock(p.initializer.body)
						? undefined
						: (p.initializer.body as ts.Expression);
					if (ts.isBlock(p.initializer.body)) {
						for (const st of p.initializer.body.statements) {
							if (ts.isReturnStatement(st) && st.expression) expr = st.expression;
						}
					}
					if (expr) {
						const er = eraseLoopTask(ctx.sf, ctx.file, expr, prevNm, draft.id, ctx.diags);
						if (er) draft.raw.task = er;
					}
				} else {
					const er = eraseStringish(ctx.sf, ctx.file, p.initializer, undefined, ctx.phases, ctx.diags);
					if (er) draft.raw.task = er.text;
				}
			}
		}
	}
	if (opts.final === true) draft.final = true;
	return register(ctx, draft);
}
