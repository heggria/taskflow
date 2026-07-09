import ts from "typescript";
import { calleeName } from "../ast.ts";
import { mergeOpts } from "../opts.ts";
import { eraseReduceTask } from "../templates.ts";
import type { PhaseDraft } from "../types.ts";
import { type EmitContext, nextSyntheticId, register } from "../context.ts";

export function emitReduce(
	ctx: EmitContext,
	bindName: string | undefined,
	call: ts.CallExpression,
): string {
	const idBase = bindName ?? nextSyntheticId(ctx, "phase");
	const draft: PhaseDraft = {
		id: idBase,
		type: "reduce",
		raw: { type: "reduce" },
		dependsOn: new Set(),
	};
	const fromArg = call.arguments[0];
	const fnArg = call.arguments[1];
	const optsArg = call.arguments[2] as ts.Expression | undefined;
	const fromIds: string[] = [];
	if (fromArg && ts.isArrayLiteralExpression(fromArg)) {
		for (const el of fromArg.elements) {
			if (ts.isIdentifier(el) && ctx.phases.has(el.text)) {
				fromIds.push(el.text);
				draft.dependsOn.add(el.text);
			}
		}
	}
	draft.raw.from = fromIds;
	if (fnArg && (ts.isArrowFunction(fnArg) || ts.isFunctionExpression(fnArg))) {
		let expr: ts.Expression | undefined;
		if (ts.isBlock(fnArg.body)) {
			for (const st of fnArg.body.statements) {
				if (ts.isReturnStatement(st) && st.expression) expr = st.expression;
			}
		} else expr = fnArg.body;
		if (expr && ts.isCallExpression(expr) && calleeName(expr.expression) === "agent") {
			if (expr.arguments[0]) {
				const t2 = eraseReduceTask(ctx.sf, ctx.file, expr.arguments[0]!, fnArg, ctx.phases, ctx.diags);
				if (t2) {
					draft.raw.task = t2.text;
					for (const d of t2.deps) draft.dependsOn.add(d);
				}
			}
			const iopts = mergeOpts(
				ctx.sf,
				ctx.file,
				expr.arguments[1] as ts.Expression | undefined,
				ctx.diags,
				ctx.phases,
			);
			if (iopts.agent) draft.raw.agent = iopts.agent;
		}
	}
	const opts = mergeOpts(ctx.sf, ctx.file, optsArg, ctx.diags, ctx.phases);
	if (typeof opts.id === "string") draft.id = opts.id;
	Object.assign(draft.raw, opts);
	if (opts.final === true) draft.final = true;
	return register(ctx, draft);
}
