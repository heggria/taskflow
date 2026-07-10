import ts from "typescript";
import { diag } from "../ast.ts";
import { mergeOpts } from "../opts.ts";
import { eraseGateTask } from "../templates.ts";
import { phaseByBinding, type PhaseDraft } from "../types.ts";
import { type EmitContext, nextSyntheticId, register } from "../context.ts";

/** Plain gate(upstream, opts?, taskLambda?) — not gate.automated / gate.scored. */
export function emitGate(
	ctx: EmitContext,
	bindName: string | undefined,
	call: ts.CallExpression,
): string {
	const idBase = bindName ?? nextSyntheticId(ctx, "phase");
	const draft: PhaseDraft = {
		id: idBase,
		binding: idBase,
		type: "gate",
		raw: { type: "gate" },
		dependsOn: new Set(),
	};
	const up = call.arguments[0];
	if (up && ts.isIdentifier(up) && phaseByBinding(ctx.phases, up.text)) {
		draft.dependsOn.add(phaseByBinding(ctx.phases, up.text)!.id);
	} else if (up) {
		ctx.diags.push(diag(ctx.file, ctx.sf, up, "TFDSL_DEP_DYNAMIC", `gate upstream must be a previously declared phase handle.`));
	}
	const optsArg = call.arguments[1] as ts.Expression | undefined;
	const taskArg = call.arguments[2] as ts.Expression | undefined;
	const opts = mergeOpts(ctx.sf, ctx.file, optsArg, ctx.diags, ctx.phases);
	Object.assign(draft.raw, opts);
	if (typeof opts.id === "string") draft.id = opts.id;
	if (taskArg && (ts.isArrowFunction(taskArg) || ts.isFunctionExpression(taskArg))) {
		const p0 = taskArg.parameters[0];
		const param = p0 && ts.isIdentifier(p0.name) ? p0.name.text : "i";
		let expr: ts.Expression | undefined = ts.isBlock(taskArg.body)
			? undefined
			: (taskArg.body as ts.Expression);
		if (ts.isBlock(taskArg.body)) {
			for (const st of taskArg.body.statements) {
				if (ts.isReturnStatement(st) && st.expression) expr = st.expression;
			}
		}
		if (expr) {
			// Gate-only rewrite: (i) => `…${i.output}` — do NOT call eraseStringish first
			// (it would emit TFDSL_TMPL_UNERASABLE for the lambda param).
			const re = eraseGateTask(
				ctx.sf,
				ctx.file,
				expr,
				param,
				up && ts.isIdentifier(up) ? phaseByBinding(ctx.phases, up.text)?.id : undefined,
				ctx.phases,
				ctx.diags,
			);
			if (re) {
				draft.raw.task = re.text;
				for (const d of re.deps) draft.dependsOn.add(d);
			}
		}
	}
	if (Array.isArray(opts.dependsOn)) for (const d of opts.dependsOn as string[]) draft.dependsOn.add(d);
	if (opts.final === true) draft.final = true;
	return register(ctx, draft);
}
