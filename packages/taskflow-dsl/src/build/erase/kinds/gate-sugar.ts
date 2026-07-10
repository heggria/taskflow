import ts from "typescript";
import { diag, evalLiteral } from "../ast.ts";
import { mergeOpts } from "../opts.ts";
import { eraseStringish } from "../templates.ts";
import { phaseByBinding, type PhaseDraft } from "../types.ts";
import { type EmitContext, nextSyntheticId, register } from "../context.ts";

/** gate.automated / gate.scored */
export function emitGateSugar(
	ctx: EmitContext,
	cn: string,
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
		ctx.diags.push(diag(ctx.file, ctx.sf, up, "TFDSL_DEP_DYNAMIC", `${cn} upstream must be a previously declared phase handle.`));
	}
	const optsArg = call.arguments[1] as ts.Expression | undefined;
	const sugarKeys = new Set([
		"pass",
		"scorers",
		"combine",
		"threshold",
		"weights",
		"target",
		"judge",
		"task",
	]);
	const opts = mergeOpts(ctx.sf, ctx.file, optsArg, ctx.diags, ctx.phases, {
		allowKeys: sugarKeys,
	});
	if (typeof opts.id === "string") draft.id = opts.id;
	Object.assign(draft.raw, opts);

	if (cn === "gate.automated" && optsArg && ts.isObjectLiteralExpression(optsArg)) {
		for (const p of optsArg.properties) {
			if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
			if (p.name.text === "pass") {
				const v = evalLiteral(p.initializer);
				if (Array.isArray(v)) draft.raw.eval = v;
			}
			if (p.name.text === "task") {
				const er = eraseStringish(ctx.sf, ctx.file, p.initializer, undefined, ctx.phases, ctx.diags);
				if (er) {
					draft.raw.task = er.text;
					for (const d of er.deps) draft.dependsOn.add(d);
				}
			}
		}
		if (!draft.raw.task && !draft.raw.score) {
			draft.raw.task = "Gate (automated pre-checks failed or incomplete).";
		}
	}
	if (cn === "gate.scored" && optsArg && ts.isObjectLiteralExpression(optsArg)) {
		const score: Record<string, unknown> = {};
		for (const p of optsArg.properties) {
			if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
			const k = p.name.text;
			if (k === "scorers" || k === "combine" || k === "threshold" || k === "weights" || k === "target" || k === "judge") {
				const v = evalLiteral(p.initializer);
				if (v !== undefined) score[k] = v;
			}
			if (k === "task") {
				const er = eraseStringish(ctx.sf, ctx.file, p.initializer, undefined, ctx.phases, ctx.diags);
				if (er) {
					draft.raw.task = er.text;
					for (const d of er.deps) draft.dependsOn.add(d);
				}
			}
		}
		if (!score.combine) score.combine = "all";
		draft.raw.score = score;
		delete draft.raw.scorers;
		delete draft.raw.combine;
		delete draft.raw.threshold;
		delete draft.raw.weights;
		delete draft.raw.target;
		delete draft.raw.judge;
	}
	delete draft.raw.pass;
	if (opts.final === true) draft.final = true;
	return register(ctx, draft);
}
