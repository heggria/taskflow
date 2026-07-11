/** Static branch options shared by parallel/race/tournament. */

import type ts from "typescript";
import { diag } from "../ast.ts";
import { mergeOpts } from "../opts.ts";
import type { EmitContext } from "../context.ts";

/**
 * Core's branch contract supports only an agent override. Phase-wide routing
 * fields such as model/thinking/tools are not applied per branch at runtime, so
 * reject them here instead of emitting a definition whose intent is ignored.
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
		else {
			ctx.diags.push(
				diag(
					ctx.file,
					ctx.sf,
					obj ?? ctx.sf,
					"TFDSL_BRANCH_OPTS_UNSUPPORTED",
					`${role} option '${key}' is not supported by the runtime branch contract; only 'agent' is allowed. Put model/thinking/tools and other execution options on the enclosing phase.`,
				),
			);
		}
	}
	return out;
}
