import ts from "typescript";
import { calleeName } from "../ast.ts";
import { mergeOpts } from "../opts.ts";
import type { PhaseDraft } from "../types.ts";
import { type EmitContext, nextSyntheticId, register } from "../context.ts";
import { eraseBranchAgent } from "./branch-opts.ts";

export function emitParallel(
	ctx: EmitContext,
	bindName: string | undefined,
	call: ts.CallExpression,
	itemParam?: string,
): string {
	const idBase = bindName ?? nextSyntheticId(ctx, "phase");
	const draft: PhaseDraft = {
		id: idBase,
		binding: idBase,
		type: "parallel",
		raw: { type: "parallel" },
		dependsOn: new Set(),
	};
	const arr = call.arguments[0];
	const optsArg = call.arguments[1] as ts.Expression | undefined;
	const branches: Array<Record<string, unknown>> = [];
	if (arr && ts.isArrayLiteralExpression(arr)) {
		for (let bi = 0; bi < arr.elements.length; bi++) {
			const el = arr.elements[bi]!;
			if (ts.isCallExpression(el) && calleeName(el.expression) === "agent") {
				if (el.arguments.length < 1 || el.arguments.length > 2) {
					ctx.diags.push({
						code: "TFDSL_RUNE_ARITY",
						severity: "error",
						message: `parallel() branch agent expects 1-2 arguments, got ${el.arguments.length}.`,
						file: ctx.file,
					});
					continue;
				}
				branches.push(eraseBranchAgent(ctx, el, itemParam, `parallel branch ${bi + 1}`, draft.dependsOn));
			} else {
				ctx.diags.push({
					code: "TFDSL_BRANCH_KIND",
					severity: "error",
					message: `parallel() branch ${bi + 1} must be agent(...) — other expressions are not erasable.`,
					file: ctx.file,
				});
			}
		}
	}
	draft.raw.branches = branches;
	const opts = mergeOpts(ctx.sf, ctx.file, optsArg, ctx.diags, ctx.phases);
	if (typeof opts.id === "string") draft.id = opts.id;
	Object.assign(draft.raw, opts);
	if (opts.final === true) draft.final = true;
	return register(ctx, draft);
}
