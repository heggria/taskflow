/**
 * Erase pipeline orchestrator: flow() discovery + body walk + kind dispatch.
 * Domain helpers live in sibling modules (ast / templates / opts / types).
 * Phase kinds live in erase/kinds/* — do not re-grow kind logic here.
 */

import ts from "typescript";
import type { Diagnostic } from "../../diagnostics.ts";
import { calleeName, diag, evalLiteral } from "./ast.ts";
import type { EraseResult, PhaseDraft } from "./types.ts";
import { PHASE_RUNES } from "./types.ts";
import type { EmitContext } from "./context.ts";
import { trySpecializedEmit } from "./kinds/index.ts";

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

	const emitCtx: EmitContext = { file, sf, diags, phases, order };

	const handleCall = (
		bindName: string | undefined,
		call: ts.CallExpression,
		itemParam?: string,
	): string | undefined => {
		const cn = calleeName(call.expression);
		if (!cn) return undefined;

		const specialized = trySpecializedEmit(emitCtx, cn, bindName, call, itemParam);
		if (specialized !== "continue") return specialized;

		if (!PHASE_RUNES.has(cn.split(".")[0]!) && !PHASE_RUNES.has(cn)) {
			if (cn === "json") return undefined;
			return undefined;
		}

		// Known rune prefix but no handler — should not happen if registry is complete.
		diags.push(
			diag(file, sf, call, "TFDSL_RUNE_UNHANDLED", `No erase handler for rune '${cn}'.`),
		);
		return undefined;
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
