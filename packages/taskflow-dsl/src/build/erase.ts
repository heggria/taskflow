/**
 * AST erase: .tf.ts source → Taskflow JSON (no execution of runes).
 * Uses TypeScript compiler API (read-only Program/SourceFile).
 */

import ts from "typescript";
import type { Diagnostic } from "../diagnostics.ts";

export interface EraseResult {
	ok: boolean;
	taskflow?: Record<string, unknown>;
	diagnostics: Diagnostic[];
}

const PHASE_RUNES = new Set([
	"agent",
	"parallel",
	"map",
	"gate",
	"reduce",
	"approval",
	"subflow",
	"loop",
	"tournament",
	"script",
	"race",
]);

interface PhaseDraft {
	id: string;
	type: string;
	raw: Record<string, unknown>;
	dependsOn: Set<string>;
	final?: boolean;
}

function posOf(sf: ts.SourceFile, node: ts.Node): { line: number; character: number } {
	const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
	return { line: line + 1, character: character + 1 };
}

function diag(
	file: string,
	sf: ts.SourceFile,
	node: ts.Node,
	code: string,
	message: string,
	severity: Diagnostic["severity"] = "error",
	hint?: string,
): Diagnostic {
	const p = posOf(sf, node);
	return {
		code,
		severity,
		message,
		file,
		range: { line: p.line, character: p.character },
		hint,
	};
}

function isIdentifier(n: ts.Node, name: string): boolean {
	return ts.isIdentifier(n) && n.text === name;
}

function calleeName(expr: ts.Expression): string | undefined {
	if (ts.isIdentifier(expr)) return expr.text;
	if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
		return `${expr.expression.text}.${expr.name.text}`;
	}
	return undefined;
}

function evalLiteral(node: ts.Expression): unknown {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	if (ts.isNumericLiteral(node)) return Number(node.text);
	if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
	if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
	if (node.kind === ts.SyntaxKind.NullKeyword) return null;
	if (ts.isArrayLiteralExpression(node)) {
		return node.elements.map((e) => (ts.isSpreadElement(e) ? undefined : evalLiteral(e as ts.Expression)));
	}
	if (ts.isObjectLiteralExpression(node)) {
		const o: Record<string, unknown> = {};
		for (const p of node.properties) {
			if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
				o[p.name.text] = evalLiteral(p.initializer);
			} else if (ts.isPropertyAssignment(p) && ts.isStringLiteral(p.name)) {
				o[p.name.text] = evalLiteral(p.initializer);
			}
		}
		return o;
	}
	return undefined;
}

/** Convert template / string expr to task string + deps. */
function eraseStringish(
	sf: ts.SourceFile,
	file: string,
	node: ts.Expression,
	itemParam: string | undefined,
	phases: Map<string, PhaseDraft>,
	diags: Diagnostic[],
): { text: string; deps: string[] } | undefined {
	const deps: string[] = [];

	const pushDep = (id: string) => {
		if (phases.has(id) && !deps.includes(id)) deps.push(id);
	};

	const propToPlaceholder = (expr: ts.Expression): string | undefined => {
		// item.foo / item
		if (ts.isIdentifier(expr) && itemParam && expr.text === itemParam) return "{item}";
		if (
			ts.isPropertyAccessExpression(expr) &&
			ts.isIdentifier(expr.expression) &&
			itemParam &&
			expr.expression.text === itemParam
		) {
			return `{item.${expr.name.text}}`;
		}
		// phase.output / phase.json / phase.json.field
		if (ts.isPropertyAccessExpression(expr)) {
			const chain: string[] = [];
			let cur: ts.Expression = expr;
			while (ts.isPropertyAccessExpression(cur)) {
				chain.unshift(cur.name.text);
				cur = cur.expression;
			}
			if (ts.isIdentifier(cur) && phases.has(cur.text)) {
				pushDep(cur.text);
				if (chain[0] === "output" && chain.length === 1) return `{steps.${cur.text}.output}`;
				if (chain[0] === "json") {
					if (chain.length === 1) return `{steps.${cur.text}.json}`;
					return `{steps.${cur.text}.json.${chain.slice(1).join(".")}}`;
				}
			}
		}
		// args.x
		if (
			ts.isPropertyAccessExpression(expr) &&
			ts.isIdentifier(expr.expression) &&
			expr.expression.text === "args"
		) {
			return `{args.${expr.name.text}}`;
		}
		return undefined;
	};

	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
		return { text: node.text, deps };
	}

	if (ts.isTemplateExpression(node)) {
		let text = node.head.text;
		for (const span of node.templateSpans) {
			const ph = propToPlaceholder(span.expression);
			if (ph) {
				text += ph;
			} else {
				// try simple identifiers that are phases → .output
				if (ts.isIdentifier(span.expression) && phases.has(span.expression.text)) {
					pushDep(span.expression.text);
					text += `{steps.${span.expression.text}.output}`;
				} else {
					diags.push(
						diag(
							file,
							sf,
							span.expression,
							"TFDSL_TMPL_UNERASABLE",
							`Cannot erase template expression to a placeholder (only phase.output/json, item.*, args.* supported in MVP).`,
						),
					);
					return undefined;
				}
			}
			text += span.literal.text;
		}
		return { text, deps };
	}

	// Identifier phase ref alone is not a string task
	if (ts.isIdentifier(node)) {
		diags.push(diag(file, sf, node, "TFDSL_RUNE_ARG", `Expected string or template for task text.`));
		return undefined;
	}

	const lit = evalLiteral(node);
	if (typeof lit === "string") return { text: lit, deps };

	diags.push(diag(file, sf, node, "TFDSL_RUNE_ARG", `Expected static string/template task text.`));
	return undefined;
}

function mergeOpts(
	sf: ts.SourceFile,
	file: string,
	obj: ts.Expression | undefined,
	diags: Diagnostic[],
	phases: Map<string, PhaseDraft>,
): Record<string, unknown> {
	if (!obj) return {};
	if (!ts.isObjectLiteralExpression(obj)) {
		diags.push(diag(file, sf, obj, "TFDSL_RUNE_OPTS", `Phase options must be an object literal.`));
		return {};
	}
	const out: Record<string, unknown> = {};
	for (const p of obj.properties) {
		if (!ts.isPropertyAssignment(p)) continue;
		const key = ts.isIdentifier(p.name)
			? p.name.text
			: ts.isStringLiteral(p.name)
				? p.name.text
				: undefined;
		if (!key) continue;

		if (key === "dependsOn" && ts.isArrayLiteralExpression(p.initializer)) {
			const ids: string[] = [];
			for (const el of p.initializer.elements) {
				if (ts.isStringLiteral(el)) ids.push(el.text);
				else if (ts.isIdentifier(el) && phases.has(el.text)) ids.push(el.text);
			}
			out.dependsOn = ids;
			continue;
		}

		if (key === "output") {
			if (ts.isCallExpression(p.initializer)) {
				const cn = calleeName(p.initializer.expression);
				if (cn === "json") {
					out.output = "json";
					out.expect = { type: "object" };
					continue;
				}
			}
			const v = evalLiteral(p.initializer);
			if (v === "json" || v === "text") {
				out.output = v;
				if (v === "json" && out.expect === undefined) out.expect = { type: "object" };
				continue;
			}
			diags.push(
				diag(file, sf, p.initializer, "TFDSL_RUNE_OPTS", `output must be "json" | "text" or json().`),
			);
			continue;
		}

		if (key === "agent" || key === "model" || key === "when" || key === "join" || key === "cwd") {
			const v = evalLiteral(p.initializer);
			if (v !== undefined) out[key] = v;
			continue;
		}
		if (key === "final" || key === "optional" || key === "idempotent" || key === "reflexion" || key === "convergence") {
			const v = evalLiteral(p.initializer);
			if (typeof v === "boolean") out[key] = v;
			continue;
		}
		if (key === "timeout" || key === "concurrency" || key === "maxIterations" || key === "variants") {
			const v = evalLiteral(p.initializer);
			if (typeof v === "number") out[key] = v;
			continue;
		}
		if (key === "retry" || key === "expect" || key === "tools" || key === "thinking") {
			const v = evalLiteral(p.initializer);
			if (v !== undefined) out[key] = v;
			continue;
		}
		if (key === "id") {
			const v = evalLiteral(p.initializer);
			if (typeof v === "string") out.id = v;
			continue;
		}
		if (key === "input" || key === "request" || key === "until" || key === "judge" || key === "judgeAgent" || key === "mode" || key === "use" || key === "onBlock") {
			const v = evalLiteral(p.initializer);
			if (v !== undefined) out[key] = v;
			continue;
		}
		// Unknown keys: warn (fail-open for forward-compat fields, never silent on known mistakes)
		diags.push(
			diag(
				file,
				sf,
				p,
				"TFDSL_RUNE_OPTS_UNKNOWN",
				`Unknown or non-static option '${key}' ignored in MVP erase.`,
				"warning",
			),
		);
	}
	return out;
}

function phaseIdFromBinding(name: string, opts: Record<string, unknown>): string {
	if (typeof opts.id === "string" && opts.id) return opts.id;
	// convert camelCase binding to kebab for JSON culture, keep as-is if already simple
	return name;
}

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

		// expand.nested / subflow.def → flow phase
		if (cn === "expand.nested" || cn === "subflow.def") {
			const id = bindName ?? `flow-${order.length}`;
			const draft: PhaseDraft = {
				id,
				type: "flow",
				raw: { type: "flow" },
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
		if (type === "race") {
			diags.push(
				diag(
					file,
					sf,
					call,
					"TFDSL_PHASE_UNSUPPORTED",
					`Phase type "race" is designed (horizon B) but not implemented in the engine yet.`,
					"error",
					"Remove race() or wait for S4.x engine support.",
				),
			);
			return undefined;
		}

		const idBase = bindName ?? (order.length === 0 ? "main" : `phase-${order.length}`);
		const draft: PhaseDraft = {
			id: idBase,
			type,
			raw: { type },
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
			Object.assign(draft.raw, opts);
			// task: (prev) => `...` inside object — scan object for task method
			if (optsArg && ts.isObjectLiteralExpression(optsArg)) {
				for (const p of optsArg.properties) {
					if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
					if (p.name.text === "task") {
						if (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer)) {
							const prev = p.initializer.parameters[0];
							const prevName = prev && ts.isIdentifier(prev.name) ? prev.name.text : "prev";
							let expr: ts.Expression | undefined = ts.isBlock(p.initializer.body)
								? undefined
								: (p.initializer.body as ts.Expression);
							if (ts.isBlock(p.initializer.body)) {
								for (const st of p.initializer.body.statements) {
									if (ts.isReturnStatement(st) && st.expression) expr = st.expression;
								}
							}
							if (expr) {
								const er = eraseLoopTask(sf, file, expr, prevName, draft.id, diags);
								if (er) draft.raw.task = er;
							}
						} else {
							const er = eraseStringish(sf, file, p.initializer, undefined, phases, diags);
							if (er) draft.raw.task = er.text;
						}
					}
				}
			}
			if (typeof opts.id === "string") draft.id = opts.id;
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
				// const [a,b] = parallel(...)
				if (ts.isArrayBindingPattern(decl.name) && ts.isCallExpression(decl.initializer)) {
					const cn = calleeName(decl.initializer.expression);
					if (cn === "parallel") {
						handleCall("parallel-0", decl.initializer);
					}
					continue;
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

function eraseGateTask(
	sf: ts.SourceFile,
	file: string,
	expr: ts.Expression,
	param: string,
	upstreamId: string | undefined,
	phases: Map<string, PhaseDraft>,
	diags: Diagnostic[],
): { text: string; deps: string[] } | undefined {
	const deps: string[] = [];
	if (upstreamId) deps.push(upstreamId);

	const rewrite = (e: ts.Expression): string | undefined => {
		if (
			ts.isPropertyAccessExpression(e) &&
			ts.isIdentifier(e.expression) &&
			e.expression.text === param &&
			(e.name.text === "output" || e.name.text === "json")
		) {
			if (!upstreamId) return undefined;
			return e.name.text === "output" ? `{steps.${upstreamId}.output}` : `{steps.${upstreamId}.json}`;
		}
		return undefined;
	};

	if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return { text: expr.text, deps };
	if (ts.isTemplateExpression(expr)) {
		let text = expr.head.text;
		for (const span of expr.templateSpans) {
			const ph = rewrite(span.expression);
			if (ph) text += ph;
			else {
				const er = eraseStringish(sf, file, span.expression, undefined, phases, diags);
				if (!er) return undefined;
				text += er.text;
				for (const d of er.deps) if (!deps.includes(d)) deps.push(d);
			}
			text += span.literal.text;
		}
		return { text, deps };
	}
	return undefined;
}

function eraseLoopTask(
	sf: ts.SourceFile,
	file: string,
	expr: ts.Expression,
	prevName: string,
	loopId: string,
	diags: Diagnostic[],
): string | undefined {
	if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
	if (!ts.isTemplateExpression(expr)) {
		diags.push(diag(file, sf, expr, "TFDSL_RUNE_ARG", `loop task must be string or template.`));
		return undefined;
	}
	let text = expr.head.text;
	for (const span of expr.templateSpans) {
		const e = span.expression;
		if (
			ts.isPropertyAccessExpression(e) &&
			ts.isIdentifier(e.expression) &&
			e.expression.text === prevName &&
			e.name.text === "output"
		) {
			text += `{steps.${loopId}.output}`;
		} else if (ts.isIdentifier(e) && e.text === "loop") {
			text += `{loop.iteration}`;
		} else {
			diags.push(diag(file, sf, e, "TFDSL_TMPL_UNERASABLE", `Unsupported expression in loop task template.`));
			return undefined;
		}
		text += span.literal.text;
	}
	return text;
}

function eraseReduceTask(
	sf: ts.SourceFile,
	file: string,
	expr: ts.Expression,
	fn: ts.ArrowFunction | ts.FunctionExpression,
	phases: Map<string, PhaseDraft>,
	diags: Diagnostic[],
): { text: string; deps: string[] } | undefined {
	const p0 = fn.parameters[0];
	const partsName = p0 && ts.isIdentifier(p0.name) ? p0.name.text : "p";
	const deps: string[] = [];
	if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return { text: expr.text, deps };
	if (!ts.isTemplateExpression(expr)) return eraseStringish(sf, file, expr, undefined, phases, diags);
	let text = expr.head.text;
	for (const span of expr.templateSpans) {
		const e = span.expression;
		// p.auth.output
		if (
			ts.isPropertyAccessExpression(e) &&
			ts.isPropertyAccessExpression(e.expression) &&
			ts.isIdentifier(e.expression.expression) &&
			e.expression.expression.text === partsName
		) {
			const phaseId = e.expression.name.text;
			if (phases.has(phaseId)) deps.push(phaseId);
			if (e.name.text === "output") text += `{steps.${phaseId}.output}`;
			else if (e.name.text === "json") text += `{steps.${phaseId}.json}`;
			else text += `{steps.${phaseId}.output}`;
		} else {
			const er = eraseStringish(sf, file, e, undefined, phases, diags);
			if (!er) return undefined;
			text += er.text;
			for (const d of er.deps) deps.push(d);
		}
		text += span.literal.text;
	}
	return { text, deps };
}

