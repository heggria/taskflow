import type ts from "typescript";
import { mergeOpts } from "../opts.ts";
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
		type: "approval",
		raw: { type: "approval" },
		dependsOn: new Set(),
	};
	const optsArg = call.arguments[0] as ts.Expression | undefined;
	const opts = mergeOpts(ctx.sf, ctx.file, optsArg, ctx.diags, ctx.phases);
	if (typeof opts.request === "string") draft.raw.task = opts.request;
	Object.assign(draft.raw, opts);
	delete draft.raw.request;
	if (typeof opts.id === "string") draft.id = opts.id;
	if (opts.final === true) draft.final = true;
	return register(ctx, draft);
}
