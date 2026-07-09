import ts from "typescript";
import { calleeName } from "../ast.ts";
import { mergeOpts } from "../opts.ts";
import { eraseStringish } from "../templates.ts";
import type { PhaseDraft } from "../types.ts";
import { type EmitContext, nextSyntheticId, register } from "../context.ts";

export function emitTournament(
	ctx: EmitContext,
	bindName: string | undefined,
	call: ts.CallExpression,
): string {
	const idBase = bindName ?? nextSyntheticId(ctx, "phase");
	const draft: PhaseDraft = {
		id: idBase,
		type: "tournament",
		raw: { type: "tournament" },
		dependsOn: new Set(),
	};
	const optsArg = call.arguments[0] as ts.Expression | undefined;
	const opts = mergeOpts(ctx.sf, ctx.file, optsArg, ctx.diags, ctx.phases);
	Object.assign(draft.raw, opts);
	if (optsArg && ts.isObjectLiteralExpression(optsArg)) {
		for (const p of optsArg.properties) {
			if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
			if (p.name.text === "branches" && ts.isArrayLiteralExpression(p.initializer)) {
				const branches: Array<Record<string, unknown>> = [];
				for (const el of p.initializer.elements) {
					if (ts.isCallExpression(el) && calleeName(el.expression) === "agent") {
						const erased = eraseStringish(
							ctx.sf,
							ctx.file,
							el.arguments[0]!,
							undefined,
							ctx.phases,
							ctx.diags,
						);
						const b: Record<string, unknown> = {};
						if (erased) b.task = erased.text;
						const bopts = mergeOpts(
							ctx.sf,
							ctx.file,
							el.arguments[1] as ts.Expression | undefined,
							ctx.diags,
							ctx.phases,
						);
						Object.assign(b, bopts);
						branches.push(b);
					}
				}
				draft.raw.branches = branches;
			}
			if (p.name.text === "task") {
				const er = eraseStringish(ctx.sf, ctx.file, p.initializer, undefined, ctx.phases, ctx.diags);
				if (er) draft.raw.task = er.text;
			}
		}
	}
	if (typeof opts.id === "string") draft.id = opts.id;
	if (opts.final === true) draft.final = true;
	return register(ctx, draft);
}
