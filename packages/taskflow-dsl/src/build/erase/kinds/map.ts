import ts from "typescript";
import { calleeName, diag } from "../ast.ts";
import { mergeOpts } from "../opts.ts";
import { eraseStringish } from "../templates.ts";
import { phaseByBinding, type PhaseDraft } from "../types.ts";
import { type EmitContext, nextSyntheticId, register } from "../context.ts";

export function emitMap(
	ctx: EmitContext,
	bindName: string | undefined,
	call: ts.CallExpression,
): string {
	const idBase = bindName ?? nextSyntheticId(ctx, "phase");
	const draft: PhaseDraft = {
		id: idBase,
		binding: idBase,
		type: "map",
		raw: { type: "map" },
		dependsOn: new Set(),
	};
	const overArg = call.arguments[0];
	const fnArg = call.arguments[1];
	const optsArg = call.arguments[2] as ts.Expression | undefined;
	if (overArg && ts.isIdentifier(overArg) && phaseByBinding(ctx.phases, overArg.text)) {
		const pid = phaseByBinding(ctx.phases, overArg.text)!.id;
		draft.dependsOn.add(pid);
		draft.raw.over = `{steps.${pid}.json}`;
	} else if (overArg && ts.isPropertyAccessExpression(overArg) && ts.isIdentifier(overArg.expression)) {
		const binding = overArg.expression.text;
		const pid = phaseByBinding(ctx.phases, binding)?.id;
		if (pid && (overArg.name.text === "json" || overArg.name.text === "output")) {
			draft.dependsOn.add(pid);
			draft.raw.over =
				overArg.name.text === "json" ? `{steps.${pid}.json}` : `{steps.${pid}.output}`;
		} else {
			ctx.diags.push(diag(ctx.file, ctx.sf, overArg, "TFDSL_DEP_DYNAMIC", `map source must be a phase handle, phase.json/output, or static interpolation string.`));
		}
	} else if (overArg && (ts.isStringLiteral(overArg) || ts.isNoSubstitutionTemplateLiteral(overArg))) {
		draft.raw.over = overArg.text;
	} else if (overArg) {
		ctx.diags.push(diag(ctx.file, ctx.sf, overArg, "TFDSL_DEP_DYNAMIC", `map source must be a phase handle, phase.json/output, or static interpolation string.`));
	}
	let itemName = "item";
	if (fnArg && (ts.isArrowFunction(fnArg) || ts.isFunctionExpression(fnArg))) {
		const p0 = fnArg.parameters[0];
		if (p0 && ts.isIdentifier(p0.name)) itemName = p0.name.text;
		// `item` is the core runtime default. Preserve omission so
		// decompile → build does not manufacture a field and alter FlowIR identity.
		if (itemName !== "item") draft.raw.as = itemName;
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
				if (inner.arguments.length < 1 || inner.arguments.length > 2) {
					ctx.diags.push(diag(ctx.file, ctx.sf, inner, "TFDSL_RUNE_ARITY", `map inner agent expects 1-2 arguments, got ${inner.arguments.length}.`));
					return register(ctx, draft);
				}
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
				const perItemKeys = new Set([
					"agent", "model", "thinking", "tools", "cwd", "output", "expect", "retry", "timeout",
					"optional", "idempotent", "context", "contextLimit", "cache", "shareContext",
				]);
				for (const [key, value] of Object.entries(iopts)) {
					if (perItemKeys.has(key)) draft.raw[key] = value;
					else {
						ctx.diags.push(
							diag(
								ctx.file,
								ctx.sf,
								inner.arguments[1] ?? inner,
								"TFDSL_MAP_INNER_OPTS",
								`Option '${key}' cannot be applied inside map's agent(); put phase-level routing options on map(..., ..., opts).`,
							),
						);
					}
				}
			}
		}
	}
	const opts = mergeOpts(ctx.sf, ctx.file, optsArg, ctx.diags, ctx.phases, { allowKeys: new Set(["as"]) });
	if (opts.as !== undefined && typeof opts.as !== "string") {
		ctx.diags.push(diag(ctx.file, ctx.sf, optsArg ?? call, "TFDSL_MAP_AS", `map option 'as' must be a static string.`));
		delete opts.as;
	}
	if (typeof opts.id === "string") draft.id = opts.id;
	Object.assign(draft.raw, opts);
	if (Array.isArray(opts.dependsOn)) for (const d of opts.dependsOn as string[]) draft.dependsOn.add(d);
	if (opts.final === true) draft.final = true;
	return register(ctx, draft);
}
