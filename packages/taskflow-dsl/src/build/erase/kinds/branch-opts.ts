/** Static branch options shared by parallel/race/tournament. */

import ts from "typescript";
import { diag } from "../ast.ts";
import { isTaskFileOptsLiteral, mergeOpts } from "../opts.ts";
import { eraseStringish } from "../templates.ts";
import type { EmitContext } from "../context.ts";

/**
 * Core's branch contract supports only an agent override plus load-time
 * `taskFile`. Phase-wide routing fields such as model/thinking/tools are not
 * applied per branch at runtime, so reject them here instead of emitting a
 * definition whose intent is ignored.
 */
export function mergeBranchAgentOpts(
	ctx: EmitContext,
	obj: ts.Expression | undefined,
	role: string,
): Record<string, unknown> {
	const parsed = mergeOpts(ctx.sf, ctx.file, obj, ctx.diags, ctx.phases);
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (key === "agent") out.agent = value;
		else if (key === "taskFile") out.taskFile = value;
		else {
			ctx.diags.push(
				diag(
					ctx.file,
					ctx.sf,
					obj ?? ctx.sf,
					"TFDSL_BRANCH_OPTS_UNSUPPORTED",
					`${role} option '${key}' is not supported by the runtime branch contract; only 'agent' and 'taskFile' are allowed. Put model/thinking/tools and other execution options on the enclosing phase.`,
				),
			);
		}
	}
	return out;
}

export function eraseBranchAgent(
	ctx: EmitContext,
	call: ts.CallExpression,
	itemParam: string | undefined,
	role: string,
	deps: Set<string>,
): Record<string, unknown> {
	const first = call.arguments[0];
	const second = call.arguments[1] as ts.Expression | undefined;
	const optsOnly = !!(isTaskFileOptsLiteral(first) && !second);
	const branch: Record<string, unknown> = {};
	if (!optsOnly && first) {
		const erased = eraseStringish(ctx.sf, ctx.file, first, itemParam, ctx.phases, ctx.diags);
		if (erased) {
			branch.task = erased.text;
			for (const dep of erased.deps) deps.add(dep);
		}
	}
	const bopts = mergeBranchAgentOpts(ctx, optsOnly ? first : second, role);
	const xor = typeof bopts.taskFile === "string" && typeof branch.task === "string" && branch.task.length > 0;
	if (xor) {
		ctx.diags.push({
			code: "TFDSL_TASKFILE_XOR",
			severity: "error",
			message: `${role}: 'task' and 'taskFile' are mutually exclusive`,
			file: ctx.file,
		});
	}
	Object.assign(branch, bopts);
	if (typeof branch.taskFile === "string" && !xor) delete branch.task;
	return branch;
}

