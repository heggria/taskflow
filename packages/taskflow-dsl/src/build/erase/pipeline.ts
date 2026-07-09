/**
 * Erase pipeline orchestrator: flow() discovery + body walk + kind dispatch.
 * Domain helpers live in sibling modules (ast / templates / opts / types).
 */

import ts from "typescript";
import type { Diagnostic } from "../../diagnostics.ts";
import { calleeName, diag, evalLiteral } from "./ast.ts";
import { mergeOpts, phaseIdFromBinding } from "./opts.ts";
import {
	eraseGateTask,
	eraseLoopTask,
	eraseReduceTask,
	eraseStringish,
} from "./templates.ts";
import type { EraseResult, PhaseDraft } from "./types.ts";
import { PHASE_RUNES } from "./types.ts";

export function eraseSource(sourceText: string, file = "flow.tf.ts"): EraseResult {
	const diags: Diagnostic[] = [];
	const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

	// Find export default flow(...)
	let flowCall: ts.CallExpression | undefined;
	for (const stmt of sf.statements) {
		if (!ts.isExportAssignment(stmt) || stmt.isExportEquals) continue;
		if (ts.isCallExpression(stmt.expression)) {
			const cn = calleeName(stmt.expression.expression);
			if (cn === "flow") {
				flowCall = stmt.expression;
				break;
			}
		}
	}
	if (!flowCall) {
		diags.push({
			code: "TFDSL_ENTRY_MISSING",
			severity: "error",
			message: `Expected \`export default flow("name", …)\`.`,
			file,
			hint: "Use `taskflow-dsl new` for a skeleton.",
		});
		return { ok: false, diagnostics: diags };
	}

	const args = flowCall.arguments;
	if (args.length < 2) {
		diags.push(diag(file, sf, flowCall, "TFDSL_ENTRY_ARGS", `flow() requires name and callback.`));
		return { ok: false, diagnostics: diags };
	}

	const nameArg = args[0]!;
	if (!ts.isStringLiteral(nameArg)) {
		diags.push(diag(file, sf, nameArg, "TFDSL_ENTRY_NAME", `flow name must be a string literal.`));
		return { ok: false, diagnostics: diags };
	}
	const flowName = nameArg.text;

	let flowOpts: Record<string, unknown> = {};
	let bodyFn: ts.ArrowFunction | ts.FunctionExpression | undefined;
	if (args.length === 2) {
		const a1 = args[1]!;
		if (ts.isArrowFunction(a1) || ts.isFunctionExpression(a1)) bodyFn = a1;
	} else {
		const a1 = args[1]!;
		const a2 = args[2]!;
		if (ts.isObjectLiteralExpression(a1)) {
			flowOpts = (evalLiteral(a1) as Record<string, unknown>) ?? {};
		}
		if (ts.isArrowFunction(a2) || ts.isFunctionExpression(a2)) bodyFn = a2;
	}
	if (!bodyFn) {
		diags.push(diag(file, sf, flowCall, "TFDSL_ENTRY_BODY", `flow() body must be an arrow or function expression.`));
		return { ok: false, diagnostics: diags };
	}

	const phases = new Map<string, PhaseDraft>();
	const order: string[] = [];
	let topArgs: Record<string, unknown> | undefined;
	let concurrency: number | undefined;
	let budget: Record<string, unknown> | undefined;
	let finalId: string | undefined;

	const body = bodyFn.body;
	const statements: ts.Statement[] = ts.isBlock(body)
		? [...body.statements]
		: [ts.factory.createReturnStatement(body as ts.Expression)];

	const handleCall = (
		bindName: string | undefined,
		call: ts.CallExpression,
		itemParam?: string,
	): string | undefined => {
		const cn = calleeName(call.expression);
		if (!cn) return undefined;

		// expand.nested → type:expand expandMode:nested; subflow.def → type:flow def
		if (cn === "expand.nested" || cn === "subflow.def") {
			const id = bindName ?? (cn.startsWith("expand") ? `expand-${order.length}` : `flow-${order.length}`);
			const draft: PhaseDraft = {
				id,
				type: cn === "expand.nested" ? "expand" : "flow",
				raw:
					cn === "expand.nested"
						? { type: "expand", expandMode: "nested" }
						: { type: "flow" },
				dependsOn: new Set(),
			};
			const defArg = call.arguments[0];
			if (defArg && ts.isPropertyAccessExpression(defArg) && ts.isIdentifier(defArg.expression)) {
				const pid = defArg.expression.text;
				if (phases.has(pid) && (defArg.name.text === "json" || defArg.name.text === "output")) {
					draft.dependsOn.add(pid);
					draft.raw.def = defArg.name.text === "json" ? `{steps.${pid}.json}` : `{steps.${pid}.output}`;
				}
			} else if (defArg && ts.isStringLiteral(defArg)) {
				draft.raw.def = defArg.text;
			} else if (defArg && ts.isIdentifier(defArg) && phases.has(defArg.text)) {
				draft.dependsOn.add(defArg.text);
				draft.raw.def = `{steps.${defArg.text}.json}`;
			}
			const opts = mergeOpts(sf, file, call.arguments[1] as ts.Expression | undefined, diags, phases);
			Object.assign(draft.raw, opts);
			if (typeof opts.id === "string") draft.id = opts.id;
			phases.set(draft.id, draft);
			order.push(draft.id);
			return draft.id;
		}

		if (cn === "subflow") {
			const id = bindName ?? `flow-${order.length}`;
			const draft: PhaseDraft = { id, type: "flow", raw: { type: "flow" }, dependsOn: new Set() };
			const useArg = call.arguments[0];
			if (useArg && ts.isStringLiteral(useArg)) draft.raw.use = useArg.text;
			else diags.push(diag(file, sf, call, "TFDSL_RUNE_ARG", `subflow(use) requires a string name.`));
			if (call.arguments[1] && ts.isObjectLiteralExpression(call.arguments[1])) {
				draft.raw.with = evalLiteral(call.arguments[1]);
			}
			const opts = mergeOpts(sf, file, call.arguments[2] as ts.Expression | undefined, diags, phases);
			Object.assign(draft.raw, opts);
			if (typeof opts.id === "string") draft.id = opts.id;
			phases.set(draft.id, draft);
			order.push(draft.id);
			return draft.id;
		}

		if (!PHASE_RUNES.has(cn.split(".")[0]!) && !PHASE_RUNES.has(cn)) {
			if (cn === "json") return undefined;
			// allow ignore non-phase
			return undefined;
		}

		const type = cn === "race" ? "race" : cn;
		// race([agent(...), ...], opts?)
		if (cn === "race") {
			const idBase = bindName ?? (order.length === 0 ? "main" : `phase-${order.length}`);
			const draft: PhaseDraft = {
				id: idBase,
				type: "race",
				raw: { type: "race" },
				dependsOn: new Set(),
			};
			const arr = call.arguments[0];
			const branches: Array<Record<string, unknown>> = [];
			if (arr && ts.isArrayLiteralExpression(arr)) {
				for (const el of arr.elements) {
					if (ts.isCallExpression(el) && calleeName(el.expression) === "agent") {
						const erased = eraseStringish(sf, file, el.arguments[0]!, itemParam, phases, diags);
						const b: Record<string, unknown> = {};
						if (erased) {
							b.task = erased.text;
							for (const d of erased.deps) draft.dependsOn.add(d);
						}
						const bopts = mergeOpts(sf, file, el.arguments[1] as ts.Expression | undefined, diags, phases);
						Object.assign(b, bopts);
						branches.push(b);
					}
				}
			}
			draft.raw.branches = branches;
			const opts = mergeOpts(sf, file, call.arguments[1] as ts.Expression | undefined, diags, phases);
			if (typeof opts.id === "string") draft.id = opts.id;
			if (typeof opts.cancelLosers === "boolean") draft.raw.cancelLosers = opts.cancelLosers;
			Object.assign(draft.raw, opts);
			delete draft.raw.id;
			if (draft.dependsOn.size) draft.raw.dependsOn = [...draft.dependsOn];
			if (opts.final === true) {
				draft.final = true;
				draft.raw.final = true;
			}
			phases.set(draft.id, draft);
			if (!order.includes(draft.id)) order.push(draft.id);
			return draft.id;
		}

		// expand(...) / expand.graft(...) — expand.nested handled above
		if (cn === "expand" || cn === "expand.graft") {
			const idBase = bindName ?? (order.length === 0 ? "main" : `phase-${order.length}`);
			const draft: PhaseDraft = {
				id: idBase,
				type: "expand",
				raw: {
					type: "expand",
					expandMode: cn === "expand.graft" ? "graft" : "nested",
				},
				dependsOn: new Set(),
			};
			const defArg = call.arguments[0];
			if (defArg && ts.isPropertyAccessExpression(defArg) && ts.isIdentifier(defArg.expression)) {
				const pid = defArg.expression.text;
				if (phases.has(pid) && (defArg.name.text === "json" || defArg.name.text === "output")) {
					draft.dependsOn.add(pid);
					draft.raw.def =
						defArg.name.text === "json" ? `{steps.${pid}.json}` : `{steps.${pid}.output}`;
				}
			} else if (defArg && ts.isStringLiteral(defArg)) {
				draft.raw.def = defArg.text;
			} else if (defArg && ts.isIdentifier(defArg) && phases.has(defArg.text)) {
				draft.dependsOn.add(defArg.text);
				draft.raw.def = `{steps.${defArg.text}.json}`;
			}
			const opts = mergeOpts(sf, file, call.arguments[1] as ts.Expression | undefined, diags, phases);
			if (typeof opts.id === "string") draft.id = opts.id;
			if (typeof opts.expandMode === "string") draft.raw.expandMode = opts.expandMode;
			if (typeof opts.maxNodes === "number") draft.raw.maxNodes = opts.maxNodes;
			// expand(...) default nested; expand.graft → graft
			if (cn === "expand.graft") draft.raw.expandMode = "graft";
			if (cn === "expand" && !draft.raw.expandMode) draft.raw.expandMode = "nested";
			Object.assign(draft.raw, opts);
			delete draft.raw.id;
			if (draft.dependsOn.size) draft.raw.dependsOn = [...draft.dependsOn];
			if (opts.final === true) {
				draft.final = true;
				draft.raw.final = true;
			}
			phases.set(draft.id, draft);
			if (!order.includes(draft.id)) order.push(draft.id);
			return draft.id;
		}

		// gate.automated / gate.scored → type:gate with eval / score
		if (cn === "gate.automated" || cn === "gate.scored") {
			const idBase = bindName ?? (order.length === 0 ? "main" : `phase-${order.length}`);
			const draft: PhaseDraft = {
				id: idBase,
				type: "gate",
				raw: { type: "gate" },
				dependsOn: new Set(),
			};
			const up = call.arguments[0];
			if (up && ts.isIdentifier(up) && phases.has(up.text)) draft.dependsOn.add(up.text);
			const optsArg = call.arguments[1] as ts.Expression | undefined;
			const opts = mergeOpts(sf, file, optsArg, diags, phases);
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
						const er = eraseStringish(sf, file, p.initializer, undefined, phases, diags);
						if (er) {
							draft.raw.task = er.text;
							for (const d of er.deps) draft.dependsOn.add(d);
						}
					}
				}
				// Engine requires task or score; default a minimal task if only eval given
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
						const er = eraseStringish(sf, file, p.initializer, undefined, phases, diags);
						if (er) {
							draft.raw.task = er.text;
							for (const d of er.deps) draft.dependsOn.add(d);
						}
					}
				}
				if (!score.combine) score.combine = "all";
				draft.raw.score = score;
				// strip score fields from top-level raw if mergeOpts put them
				delete draft.raw.scorers;
				delete draft.raw.combine;
				delete draft.raw.threshold;
				delete draft.raw.weights;
				delete draft.raw.target;
				delete draft.raw.judge;
			}
			delete draft.raw.id;
			delete draft.raw.pass;
			if (draft.dependsOn.size) draft.raw.dependsOn = [...draft.dependsOn];
			if (opts.final === true) {
				draft.final = true;
				draft.raw.final = true;
			}
			phases.set(draft.id, draft);
			if (!order.includes(draft.id)) order.push(draft.id);
			return draft.id;
		}

		const phaseType = type === "gate" ? "gate" : type;
		const idBase = bindName ?? (order.length === 0 ? "main" : `phase-${order.length}`);
		const draft: PhaseDraft = {
			id: idBase,
			type: phaseType,
			raw: { type: phaseType },
			dependsOn: new Set(),
		};

		if (type === "agent" || type === "script") {
			const taskArg = call.arguments[0];
			const optsArg = call.arguments[1] as ts.Expression | undefined;
			if (type === "agent" && taskArg) {
				const erased = eraseStringish(sf, file, taskArg, itemParam, phases, diags);
				if (erased) {
					draft.raw.task = erased.text;
					for (const d of erased.deps) draft.dependsOn.add(d);
				}
			}
			if (type === "script" && taskArg) {
				if (ts.isArrayLiteralExpression(taskArg)) {
					const arr = taskArg.elements.map((el) => {
						if (ts.isStringLiteral(el)) return el.text;
						const er = eraseStringish(sf, file, el as ts.Expression, itemParam, phases, diags);
						if (er) {
							for (const d of er.deps) draft.dependsOn.add(d);
							return er.text;
						}
						return "";
					});
					draft.raw.run = arr;
				} else {
					const erased = eraseStringish(sf, file, taskArg, itemParam, phases, diags);
					if (erased) {
						draft.raw.run = erased.text;
						for (const d of erased.deps) draft.dependsOn.add(d);
					}
				}
			}
			const opts = mergeOpts(sf, file, optsArg, diags, phases);
			if (typeof opts.id === "string") draft.id = opts.id;
			else draft.id = phaseIdFromBinding(idBase, opts);
			Object.assign(draft.raw, opts);
			if (Array.isArray(opts.dependsOn)) for (const d of opts.dependsOn as string[]) draft.dependsOn.add(d);
			if (opts.final === true) draft.final = true;
		} else if (type === "map") {
			const overArg = call.arguments[0];
			const fnArg = call.arguments[1];
			const optsArg = call.arguments[2] as ts.Expression | undefined;
			if (overArg && ts.isIdentifier(overArg) && phases.has(overArg.text)) {
				draft.dependsOn.add(overArg.text);
				draft.raw.over = `{steps.${overArg.text}.json}`;
			} else if (overArg && ts.isPropertyAccessExpression(overArg) && ts.isIdentifier(overArg.expression)) {
				const pid = overArg.expression.text;
				if (phases.has(pid)) {
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
				// body: agent(...) or block with return
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
						const erased = eraseStringish(sf, file, inner.arguments[0]!, itemName, phases, diags);
						if (erased) {
							draft.raw.task = erased.text;
							for (const d of erased.deps) draft.dependsOn.add(d);
						}
						const iopts = mergeOpts(sf, file, inner.arguments[1] as ts.Expression | undefined, diags, phases);
						if (iopts.agent) draft.raw.agent = iopts.agent;
						if (iopts.output) draft.raw.output = iopts.output;
					}
				}
			}
			const opts = mergeOpts(sf, file, optsArg, diags, phases);
			if (typeof opts.id === "string") draft.id = opts.id;
			Object.assign(draft.raw, opts);
			if (Array.isArray(opts.dependsOn)) for (const d of opts.dependsOn as string[]) draft.dependsOn.add(d);
			if (opts.final === true) draft.final = true;
		} else if (type === "parallel") {
			const arr = call.arguments[0];
			const optsArg = call.arguments[1] as ts.Expression | undefined;
			const branches: Array<Record<string, unknown>> = [];
			if (arr && ts.isArrayLiteralExpression(arr)) {
				for (const el of arr.elements) {
					if (ts.isCallExpression(el) && calleeName(el.expression) === "agent") {
						const erased = eraseStringish(sf, file, el.arguments[0]!, itemParam, phases, diags);
						const b: Record<string, unknown> = {};
						if (erased) {
							b.task = erased.text;
							for (const d of erased.deps) draft.dependsOn.add(d);
						}
						const bopts = mergeOpts(sf, file, el.arguments[1] as ts.Expression | undefined, diags, phases);
						Object.assign(b, bopts);
						branches.push(b);
					}
				}
			}
			draft.raw.branches = branches;
			const opts = mergeOpts(sf, file, optsArg, diags, phases);
			if (typeof opts.id === "string") draft.id = opts.id;
			Object.assign(draft.raw, opts);
			if (opts.final === true) draft.final = true;
		} else if (type === "gate") {
			const up = call.arguments[0];
			if (up && ts.isIdentifier(up) && phases.has(up.text)) draft.dependsOn.add(up.text);
			const optsArg = call.arguments[1] as ts.Expression | undefined;
			const taskArg = call.arguments[2] as ts.Expression | undefined;
			const opts = mergeOpts(sf, file, optsArg, diags, phases);
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
						sf,
						file,
						expr,
						param,
						up && ts.isIdentifier(up) ? up.text : undefined,
						phases,
						diags,
					);
					if (re) {
						draft.raw.task = re.text;
						for (const d of re.deps) draft.dependsOn.add(d);
					}
				}
			}
			if (Array.isArray(opts.dependsOn)) for (const d of opts.dependsOn as string[]) draft.dependsOn.add(d);
			if (opts.final === true) draft.final = true;
		} else if (type === "reduce") {
			const fromArg = call.arguments[0];
			const fnArg = call.arguments[1];
			const optsArg = call.arguments[2] as ts.Expression | undefined;
			const fromIds: string[] = [];
			if (fromArg && ts.isArrayLiteralExpression(fromArg)) {
				for (const el of fromArg.elements) {
					if (ts.isIdentifier(el) && phases.has(el.text)) {
						fromIds.push(el.text);
						draft.dependsOn.add(el.text);
					}
				}
			}
			draft.raw.from = fromIds;
			if (fnArg && (ts.isArrowFunction(fnArg) || ts.isFunctionExpression(fnArg))) {
				let expr: ts.Expression | undefined;
				if (ts.isBlock(fnArg.body)) {
					for (const st of fnArg.body.statements) {
						if (ts.isReturnStatement(st) && st.expression) expr = st.expression;
					}
				} else expr = fnArg.body;
				if (expr && ts.isCallExpression(expr) && calleeName(expr.expression) === "agent") {
					if (expr.arguments[0]) {
						const t2 = eraseReduceTask(sf, file, expr.arguments[0]!, fnArg, phases, diags);
						if (t2) {
							draft.raw.task = t2.text;
							for (const d of t2.deps) draft.dependsOn.add(d);
						}
					}
					const iopts = mergeOpts(sf, file, expr.arguments[1] as ts.Expression | undefined, diags, phases);
					if (iopts.agent) draft.raw.agent = iopts.agent;
				}
			}
			const opts = mergeOpts(sf, file, optsArg, diags, phases);
			if (typeof opts.id === "string") draft.id = opts.id;
			Object.assign(draft.raw, opts);
			if (opts.final === true) draft.final = true;
		} else if (type === "approval") {
			const optsArg = call.arguments[0] as ts.Expression | undefined;
			const opts = mergeOpts(sf, file, optsArg, diags, phases);
			if (typeof opts.request === "string") draft.raw.task = opts.request;
			Object.assign(draft.raw, opts);
			delete draft.raw.request;
			if (typeof opts.id === "string") draft.id = opts.id;
			if (opts.final === true) draft.final = true;
		} else if (type === "loop") {
			const optsArg = call.arguments[0] as ts.Expression | undefined;
			const opts = mergeOpts(sf, file, optsArg, diags, phases);
			if (typeof opts.id === "string") draft.id = opts.id;
			Object.assign(draft.raw, opts);
			// task: (prev) => `...` inside object — scan object for task method
			if (optsArg && ts.isObjectLiteralExpression(optsArg)) {
				for (const p of optsArg.properties) {
					if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
					if (p.name.text === "task") {
						if (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer)) {
							const prev = p.initializer.parameters[0];
							const prevNm = prev && ts.isIdentifier(prev.name) ? prev.name.text : "prev";
							let expr: ts.Expression | undefined = ts.isBlock(p.initializer.body)
								? undefined
								: (p.initializer.body as ts.Expression);
							if (ts.isBlock(p.initializer.body)) {
								for (const st of p.initializer.body.statements) {
									if (ts.isReturnStatement(st) && st.expression) expr = st.expression;
								}
							}
							if (expr) {
								const er = eraseLoopTask(sf, file, expr, prevNm, draft.id, diags);
								if (er) draft.raw.task = er;
							}
						} else {
							const er = eraseStringish(sf, file, p.initializer, undefined, phases, diags);
							if (er) draft.raw.task = er.text;
						}
					}
				}
			}
			if (opts.final === true) draft.final = true;
		} else if (type === "tournament") {
			const optsArg = call.arguments[0] as ts.Expression | undefined;
			const opts = mergeOpts(sf, file, optsArg, diags, phases);
			Object.assign(draft.raw, opts);
			if (optsArg && ts.isObjectLiteralExpression(optsArg)) {
				for (const p of optsArg.properties) {
					if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
					if (p.name.text === "branches" && ts.isArrayLiteralExpression(p.initializer)) {
						const branches: Array<Record<string, unknown>> = [];
						for (const el of p.initializer.elements) {
							if (ts.isCallExpression(el) && calleeName(el.expression) === "agent") {
								const erased = eraseStringish(sf, file, el.arguments[0]!, undefined, phases, diags);
								const b: Record<string, unknown> = {};
								if (erased) b.task = erased.text;
								const bopts = mergeOpts(sf, file, el.arguments[1] as ts.Expression | undefined, diags, phases);
								Object.assign(b, bopts);
								branches.push(b);
							}
						}
						draft.raw.branches = branches;
					}
					if (p.name.text === "task") {
						const er = eraseStringish(sf, file, p.initializer, undefined, phases, diags);
						if (er) draft.raw.task = er.text;
					}
				}
			}
			if (typeof opts.id === "string") draft.id = opts.id;
			if (opts.final === true) draft.final = true;
		}

		// strip non-schema keys
		delete draft.raw.id;
		if (draft.dependsOn.size) draft.raw.dependsOn = [...draft.dependsOn];
		if (draft.final) draft.raw.final = true;

		phases.set(draft.id, draft);
		if (!order.includes(draft.id)) order.push(draft.id);
		return draft.id;
	};

	for (const st of statements) {
		// ctx.budget / concurrency / args.declare
		if (ts.isExpressionStatement(st) && ts.isCallExpression(st.expression)) {
			const call = st.expression;
			if (ts.isPropertyAccessExpression(call.expression)) {
				const obj = call.expression.expression;
				const method = call.expression.name.text;
				// ctx.budget / ctx.concurrency
				if (ts.isIdentifier(obj) && (method === "budget" || method === "concurrency")) {
					const v = call.arguments[0] ? evalLiteral(call.arguments[0]) : undefined;
					if (method === "budget" && v && typeof v === "object") budget = v as Record<string, unknown>;
					if (method === "concurrency" && typeof v === "number") concurrency = v;
					continue;
				}
				// ctx.args.declare
				if (
					ts.isPropertyAccessExpression(obj) &&
					ts.isIdentifier(obj.expression) &&
					obj.name.text === "args" &&
					method === "declare"
				) {
					const v = call.arguments[0] ? evalLiteral(call.arguments[0]) : undefined;
					if (v && typeof v === "object") topArgs = v as Record<string, unknown>;
					continue;
				}
			}
			// bare call without binding (gate, etc.)
			if (ts.isCallExpression(call)) {
				const id = handleCall(undefined, call);
				if (id) {
					/* anonymous phase */
				}
			}
		}

		if (ts.isVariableStatement(st)) {
			for (const decl of st.declarationList.declarations) {
				if (!decl.initializer) continue;
				// const [a,b] = parallel([agent(...), agent(...)])
				// Desugar to independent agent phases with true ids (a, b) so
				// {steps.a.output} works. Concurrent because no dependsOn between them.
				if (ts.isArrayBindingPattern(decl.name) && ts.isCallExpression(decl.initializer)) {
					const cn = calleeName(decl.initializer.expression);
					if (cn === "parallel") {
						const bindNames = decl.name.elements
							.map((e) =>
								ts.isBindingElement(e) && ts.isIdentifier(e.name) ? e.name.text : undefined,
							)
							.filter((x): x is string => !!x);
						const arr = decl.initializer.arguments[0];
						if (!arr || !ts.isArrayLiteralExpression(arr) || arr.elements.length !== bindNames.length) {
							diags.push(
								diag(
									file,
									sf,
									decl.initializer,
									"TFDSL_PARALLEL_DESTRUCTURE",
									`parallel destructure requires matching binding count and array of agent() calls (got ${bindNames.length} binds).`,
								),
							);
							continue;
						}
						let ok = true;
						for (let i = 0; i < bindNames.length; i++) {
							const el = arr.elements[i]!;
							if (!ts.isCallExpression(el) || calleeName(el.expression) !== "agent") {
								diags.push(
									diag(
										file,
										sf,
										el,
										"TFDSL_PARALLEL_DESTRUCTURE",
										`parallel destructure branch ${i + 1} must be agent(...).`,
									),
								);
								ok = false;
								break;
							}
							handleCall(bindNames[i], el);
						}
						if (!ok) continue;
						continue;
					}
					if (cn === "race") {
						// race stays one phase — destructure not supported
						diags.push(
							diag(
								file,
								sf,
								decl.initializer,
								"TFDSL_RACE_DESTRUCTURE",
								`race() does not support array destructure — bind as a single phase: const winner = race([...]).`,
							),
						);
						continue;
					}
				}
				if (!ts.isIdentifier(decl.name)) continue;
				const name = decl.name.text;
				if (ts.isCallExpression(decl.initializer)) {
					handleCall(name, decl.initializer);
				} else if (
					ts.isAsExpression(decl.initializer) &&
					ts.isCallExpression(decl.initializer.expression)
				) {
					handleCall(name, decl.initializer.expression);
				}
			}
		}

		if (ts.isReturnStatement(st) && st.expression) {
			if (ts.isIdentifier(st.expression) && phases.has(st.expression.text)) {
				finalId = st.expression.text;
				const ph = phases.get(finalId)!;
				ph.final = true;
				ph.raw.final = true;
			} else if (ts.isCallExpression(st.expression)) {
				const id = handleCall(order.length === 0 ? "main" : `phase-${order.length}`, st.expression);
				if (id) {
					finalId = id;
					const ph = phases.get(id)!;
					ph.final = true;
					ph.raw.final = true;
				}
			}
		}
	}

	// Warn phases with no deps (not first)
	for (let i = 0; i < order.length; i++) {
		const id = order[i]!;
		const ph = phases.get(id)!;
		if (i > 0 && ph.dependsOn.size === 0 && !Array.isArray(ph.raw.dependsOn)) {
			diags.push({
				code: "TFDSL_DEP_NONE",
				severity: "warning",
				message: `Phase '${id}' has no automatic dependencies and is not first — add dependsOn if order matters.`,
				file,
			});
		}
	}

	if (order.length === 0) {
		diags.push({
			code: "TFDSL_ENTRY_EMPTY",
			severity: "error",
			message: `No phases found in flow body.`,
			file,
		});
		return { ok: false, diagnostics: diags };
	}

	// Ensure one final
	if (!finalId) {
		const last = order[order.length - 1]!;
		phases.get(last)!.raw.final = true;
	}

	const phaseList = order.map((id) => {
		const ph = phases.get(id)!;
		const raw = { ...ph.raw, id: ph.id };
		if (ph.dependsOn.size && !raw.dependsOn) raw.dependsOn = [...ph.dependsOn];
		// clean undefined-ish
		return raw;
	});

	const taskflow: Record<string, unknown> = {
		name: flowName,
		phases: phaseList,
	};
	if (typeof flowOpts.description === "string") taskflow.description = flowOpts.description;
	if (typeof flowOpts.version === "number") taskflow.version = flowOpts.version;
	if (topArgs) taskflow.args = topArgs;
	if (concurrency !== undefined) taskflow.concurrency = concurrency;
	if (budget) taskflow.budget = budget;

	const ok = !diags.some((d) => d.severity === "error");
	return { ok, taskflow: ok ? taskflow : undefined, diagnostics: diags };
}
