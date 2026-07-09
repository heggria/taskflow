import ts from "typescript";
import { calleeName } from "../ast.ts";
import { mergeOpts } from "../opts.ts";
import { eraseStringish } from "../templates.ts";
import type { PhaseDraft } from "../types.ts";
import { type EmitContext, nextSyntheticId, register } from "../context.ts";

export function emitMap(
	ctx: EmitContext,
	bindName: string | undefined,
	call: ts.CallExpression,
): string {
	const idBase = bindName ?? nextSyntheticId(ctx, "phase");
	const draft: PhaseDraft = {
		id: idBase,
		type: "map",
		raw: { type: "map" },
		dependsOn: new Set(),
	};
	const overArg = call.arguments[0];
	const fnArg = call.arguments[1];
	const optsArg = call.arguments[2] as ts.Expression | undefined;
	if (overArg && ts.isIdentifier(overArg) && ctx.phases.has(overArg.text)) {
		draft.dependsOn.add(overArg.text);
		draft.raw.over = `{steps.${overArg.text}.json}`;
	} else if (overArg && ts.isPropertyAccessExpression(overArg) && ts.isIdentifier(overArg.expression)) {
		const pid = overArg.expression.text;
		if (ctx.phases.has(pid)) {
			draft.dependsOn.add(pid);
			draft.raw.over =
				overArg.name.text === "json" ? `{steps.${pid}.json}` : `{steps.${pid}.output}`;
		}
	} else if (overArg && (ts.isStringLiteral(overArg) || ts.isNoSubstitutionTemplateLiteral(overArg))) {
		draft.raw.over = overArg.text;
	}
	let itemName = "item";
	if (fnArg && (ts.isArrowFunction(fnArg) || ts.isFunctionExpression(fnArg))) {
		const p0 = fnArg.parameters[0];
		if (p0 && ts.isIdentifier(p0.name)) itemName = p0.name.text;
		draft.raw.as = itemName;
		let inner: ts.Expression | undefined;
		if (ts.isBlock(fnArg.body)) {
			for (const st of fnArg.body.statements) {
				if (ts.isReturnStatement(st) && st.expression) inner = st.expression;
			}
		} else {
			inner = fnArg.body;
		}
		if (inner && ts.isCallExpression(inner)) {
			const innerCn = calleeName(inner.expression);
			if (innerCn === "agent") {
				const erased = eraseStringish(
					ctx.sf,
					ctx.file,
					inner.arguments[0]!,
					itemName,
					ctx.phases,
					ctx.diags,
				);
				if (erased) {
					draft.raw.task = erased.text;
					for (const d of erased.deps) draft.dependsOn.add(d);
				}
				const iopts = mergeOpts(
					ctx.sf,
					ctx.file,
					inner.arguments[1] as ts.Expression | undefined,
					ctx.diags,
					ctx.phases,
				);
				if (iopts.agent) draft.raw.agent = iopts.agent;
				if (iopts.output) draft.raw.output = iopts.output;
			}
		}
	}
	const opts = mergeOpts(ctx.sf, ctx.file, optsArg, ctx.diags, ctx.phases);
	if (typeof opts.id === "string") draft.id = opts.id;
	Object.assign(draft.raw, opts);
	if (Array.isArray(opts.dependsOn)) for (const d of opts.dependsOn as string[]) draft.dependsOn.add(d);
	if (opts.final === true) draft.final = true;
	return register(ctx, draft);
}
