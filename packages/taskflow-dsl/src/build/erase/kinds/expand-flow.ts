import ts from "typescript";
import { diag, evalLiteral } from "../ast.ts";
import { mergeOpts } from "../opts.ts";
import type { PhaseDraft } from "../types.ts";
import { bindDefArg, type EmitContext, nextSyntheticId, register } from "../context.ts";

/** expand.nested / subflow.def */
export function emitExpandNestedOrSubflowDef(
	ctx: EmitContext,
	cn: string,
	bindName: string | undefined,
	call: ts.CallExpression,
): string {
	const id =
		bindName ??
		(cn.startsWith("expand") ? `expand-${ctx.order.length}` : `flow-${ctx.order.length}`);
	const draft: PhaseDraft = {
		id,
		type: cn === "expand.nested" ? "expand" : "flow",
		raw:
			cn === "expand.nested"
				? { type: "expand", expandMode: "nested" }
				: { type: "flow" },
		dependsOn: new Set(),
	};
	bindDefArg(ctx, call.arguments[0], draft);
	const opts = mergeOpts(
		ctx.sf,
		ctx.file,
		call.arguments[1] as ts.Expression | undefined,
		ctx.diags,
		ctx.phases,
	);
	Object.assign(draft.raw, opts);
	if (typeof opts.id === "string") draft.id = opts.id;
	return register(ctx, draft);
}

/** subflow("name", with?, opts?) */
export function emitSubflowUse(
	ctx: EmitContext,
	bindName: string | undefined,
	call: ts.CallExpression,
): string {
	const id = bindName ?? `flow-${ctx.order.length}`;
	const draft: PhaseDraft = { id, type: "flow", raw: { type: "flow" }, dependsOn: new Set() };
	const useArg = call.arguments[0];
	if (useArg && ts.isStringLiteral(useArg)) draft.raw.use = useArg.text;
	else ctx.diags.push(diag(ctx.file, ctx.sf, call, "TFDSL_RUNE_ARG", `subflow(use) requires a string name.`));
	if (call.arguments[1] && ts.isObjectLiteralExpression(call.arguments[1])) {
		draft.raw.with = evalLiteral(call.arguments[1]);
	}
	const opts = mergeOpts(
		ctx.sf,
		ctx.file,
		call.arguments[2] as ts.Expression | undefined,
		ctx.diags,
		ctx.phases,
	);
	Object.assign(draft.raw, opts);
	if (typeof opts.id === "string") draft.id = opts.id;
	return register(ctx, draft);
}

/** expand(...) / expand.graft(...) */
export function emitExpand(
	ctx: EmitContext,
	cn: string,
	bindName: string | undefined,
	call: ts.CallExpression,
): string {
	const idBase = bindName ?? nextSyntheticId(ctx, "phase");
	const draft: PhaseDraft = {
		id: idBase,
		type: "expand",
		raw: {
			type: "expand",
			expandMode: cn === "expand.graft" ? "graft" : "nested",
		},
		dependsOn: new Set(),
	};
	bindDefArg(ctx, call.arguments[0], draft);
	const opts = mergeOpts(
		ctx.sf,
		ctx.file,
		call.arguments[1] as ts.Expression | undefined,
		ctx.diags,
		ctx.phases,
	);
	if (typeof opts.id === "string") draft.id = opts.id;
	if (cn === "expand.graft") draft.raw.expandMode = "graft";
	if (cn === "expand" && !draft.raw.expandMode) draft.raw.expandMode = "nested";
	Object.assign(draft.raw, opts);
	if (opts.final === true) draft.final = true;
	return register(ctx, draft);
}
