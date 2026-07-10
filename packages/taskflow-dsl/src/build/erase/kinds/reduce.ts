import ts from "typescript";
import { calleeName, diag } from "../ast.ts";
import { mergeOpts } from "../opts.ts";
import { eraseReduceTask } from "../templates.ts";
import { phaseByBinding, type PhaseDraft } from "../types.ts";
import { type EmitContext, nextSyntheticId, register } from "../context.ts";

export function emitReduce(
	ctx: EmitContext,
	bindName: string | undefined,
	call: ts.CallExpression,
): string {
	const idBase = bindName ?? nextSyntheticId(ctx, "phase");
	const draft: PhaseDraft = {
		id: idBase,
		binding: idBase,
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
			if (ts.isIdentifier(el) && phaseByBinding(ctx.phases, el.text)) {
				const pid = phaseByBinding(ctx.phases, el.text)!.id;
				fromIds.push(pid);
				draft.dependsOn.add(pid);
			} else {
				ctx.diags.push(diag(ctx.file, ctx.sf, el, "TFDSL_DEP_DYNAMIC", `reduce source must be a previously declared phase handle.`));
			}
		}
	} else if (fromArg) {
		ctx.diags.push(diag(ctx.file, ctx.sf, fromArg, "TFDSL_DEP_DYNAMIC", `reduce sources must be a static array of phase handles.`));
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
			if (expr.arguments.length < 1 || expr.arguments.length > 2) {
				ctx.diags.push(diag(ctx.file, ctx.sf, expr, "TFDSL_RUNE_ARITY", `reduce inner agent expects 1-2 arguments, got ${expr.arguments.length}.`));
				return register(ctx, draft);
			}
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
			const reduceAgentKeys = new Set([
				"agent", "model", "thinking", "tools", "cwd", "output", "expect", "retry", "timeout",
				"optional", "idempotent", "context", "contextLimit", "cache", "shareContext",
			]);
			for (const [key, value] of Object.entries(iopts)) {
				if (reduceAgentKeys.has(key)) draft.raw[key] = value;
				else {
					ctx.diags.push(
						diag(
							ctx.file,
							ctx.sf,
							expr.arguments[1] ?? expr,
							"TFDSL_REDUCE_INNER_OPTS",
							`Option '${key}' cannot be applied inside reduce's agent(); put phase-level routing options on reduce(..., ..., opts).`,
						),
					);
				}
			}
		}
	}
	const opts = mergeOpts(ctx.sf, ctx.file, optsArg, ctx.diags, ctx.phases);
	if (typeof opts.id === "string") draft.id = opts.id;
	Object.assign(draft.raw, opts);
	if (opts.final === true) draft.final = true;
	return register(ctx, draft);
}
