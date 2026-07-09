/**
 * Kind emit registry — pipeline dispatches here; add kinds as new files.
 */

import type ts from "typescript";
import type { EmitContext } from "../context.ts";
import { emitAgent, emitScript } from "./agent-script.ts";
import { emitApproval } from "./approval.ts";
import { emitExpand, emitExpandNestedOrSubflowDef, emitSubflowUse } from "./expand-flow.ts";
import { emitGate } from "./gate.ts";
import { emitGateSugar } from "./gate-sugar.ts";
import { emitLoop } from "./loop.ts";
import { emitMap } from "./map.ts";
import { emitParallel } from "./parallel.ts";
import { emitRace } from "./race.ts";
import { emitReduce } from "./reduce.ts";
import { emitTournament } from "./tournament.ts";

export type KindHandler = (
	ctx: EmitContext,
	cn: string,
	bindName: string | undefined,
	call: ts.CallExpression,
	itemParam?: string,
) => string | undefined | false;

/**
 * Ordered specialized handlers. Return:
 * - string phase id if handled
 * - false if not this kind
 * - undefined only when intentionally no phase (e.g. json())
 *
 * Sugar / multi-name kinds first; then one handler per core rune.
 */
const KIND_HANDLERS: KindHandler[] = [
	(ctx, cn, bind, call) => {
		if (cn === "expand.nested" || cn === "subflow.def") {
			return emitExpandNestedOrSubflowDef(ctx, cn, bind, call);
		}
		return false;
	},
	(ctx, cn, bind, call) => {
		if (cn === "subflow") return emitSubflowUse(ctx, bind, call);
		return false;
	},
	(ctx, cn, bind, call, item) => {
		if (cn === "race") return emitRace(ctx, bind, call, item);
		return false;
	},
	(ctx, cn, bind, call) => {
		if (cn === "expand" || cn === "expand.graft") return emitExpand(ctx, cn, bind, call);
		return false;
	},
	(ctx, cn, bind, call) => {
		if (cn === "gate.automated" || cn === "gate.scored") return emitGateSugar(ctx, cn, bind, call);
		return false;
	},
	(ctx, cn, bind, call, item) => {
		if (cn === "agent") return emitAgent(ctx, bind, call, item);
		return false;
	},
	(ctx, cn, bind, call, item) => {
		if (cn === "script") return emitScript(ctx, bind, call, item);
		return false;
	},
	(ctx, cn, bind, call) => {
		if (cn === "map") return emitMap(ctx, bind, call);
		return false;
	},
	(ctx, cn, bind, call, item) => {
		if (cn === "parallel") return emitParallel(ctx, bind, call, item);
		return false;
	},
	(ctx, cn, bind, call) => {
		if (cn === "gate") return emitGate(ctx, bind, call);
		return false;
	},
	(ctx, cn, bind, call) => {
		if (cn === "reduce") return emitReduce(ctx, bind, call);
		return false;
	},
	(ctx, cn, bind, call) => {
		if (cn === "approval") return emitApproval(ctx, bind, call);
		return false;
	},
	(ctx, cn, bind, call) => {
		if (cn === "loop") return emitLoop(ctx, bind, call);
		return false;
	},
	(ctx, cn, bind, call) => {
		if (cn === "tournament") return emitTournament(ctx, bind, call);
		return false;
	},
];

/** Try kind emitters. Returns phase id, undefined (no phase), or "continue" if unknown. */
export function trySpecializedEmit(
	ctx: EmitContext,
	cn: string,
	bindName: string | undefined,
	call: ts.CallExpression,
	itemParam?: string,
): string | undefined | "continue" {
	for (const h of KIND_HANDLERS) {
		const r = h(ctx, cn, bindName, call, itemParam);
		if (r === false) continue;
		return r;
	}
	return "continue";
}
