/**
 * Erase pipeline orchestrator: flow() discovery + body walk + kind dispatch.
 * Domain helpers live in sibling modules (ast / templates / opts / types).
 * Phase kinds live in erase/kinds/* — do not re-grow kind logic here.
 */

import ts from "typescript";
import type { Diagnostic } from "../../diagnostics.ts";
import { calleeName, diag, evalLiteral } from "./ast.ts";
import { phaseByBinding, type EraseResult, type PhaseDraft } from "./types.ts";
import { PHASE_RUNES } from "./types.ts";
import type { EmitContext } from "./context.ts";
import { trySpecializedEmit } from "./kinds/index.ts";

const RUNE_ARITY: Readonly<Record<string, readonly [min: number, max: number]>> = {
	agent: [1, 2],
	parallel: [1, 2],
	map: [2, 3],
	gate: [1, 3],
	"gate.automated": [2, 2],
	"gate.scored": [2, 2],
	gateAutomated: [2, 2],
	gateScored: [2, 2],
	reduce: [2, 3],
	approval: [1, 1],
	subflow: [1, 3],
	"subflow.def": [1, 2],
	loop: [1, 1],
	tournament: [1, 1],
	script: [1, 2],
	expand: [1, 2],
	"expand.nested": [1, 2],
	"expand.graft": [1, 2],
	race: [1, 2],
};

export function eraseSource(sourceText: string, file = "flow.tf.ts"): EraseResult {
	const diags: Diagnostic[] = [];
	const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const parseDiagnostics = (sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
	for (const d of parseDiagnostics) {
		const start = d.start ?? 0;
		const pos = sf.getLineAndCharacterOfPosition(start);
		diags.push({
			code: `TS${d.code}`,
			severity: "error",
			message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
			file,
			range: { line: pos.line + 1, character: pos.character + 1 },
		});
	}
	if (parseDiagnostics.length > 0) return { ok: false, diagnostics: diags };

	let taskflowImport = false;
	const importedRunes = new Set<string>();
	for (const stmt of sf.statements) {
		if (!ts.isImportDeclaration(stmt)) continue;
		if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
		if (stmt.moduleSpecifier.text === "taskflow-dsl") {
			taskflowImport = true;
			if (!stmt.importClause?.namedBindings || !ts.isNamedImports(stmt.importClause.namedBindings)) {
				diags.push(diag(file, sf, stmt, "TFDSL_IMPORT_SHAPE", `taskflow-dsl must use named imports.`));
			} else {
				for (const spec of stmt.importClause.namedBindings.elements) {
					if (spec.propertyName) {
						diags.push(diag(file, sf, spec, "TFDSL_IMPORT_ALIAS", `Aliased rune imports are not supported; import '${spec.propertyName.text}' directly.`));
					} else importedRunes.add(spec.name.text);
				}
			}
		}
	}
	if (!taskflowImport) {
		diags.push({
			code: "TFDSL_IMPORT_MISSING",
			severity: "error",
			message: `A named import from "taskflow-dsl" is required.`,
			file,
		});
	}

	// Find export default flow(...)
	let flowCall: ts.CallExpression | undefined;
	let defaultExports = 0;
	for (const stmt of sf.statements) {
		if (!ts.isExportAssignment(stmt) || stmt.isExportEquals) continue;
		defaultExports++;
		if (ts.isCallExpression(stmt.expression)) {
			const cn = calleeName(stmt.expression.expression);
			if (!flowCall && cn === "flow" && importedRunes.has("flow")) {
				flowCall = stmt.expression;
			}
		}
	}
	if (defaultExports > 1) {
		diags.push({ code: "TFDSL_ENTRY_MULTIPLE", severity: "error", message: `Exactly one default flow export is allowed.`, file });
		return { ok: false, diagnostics: diags };
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
	const missingRuneImports = new Set<string>();
	const checkRuneImports = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const name = calleeName(node.expression);
			const root = name?.split(".")[0];
			if (root && (PHASE_RUNES.has(root) || root === "json") && !importedRunes.has(root)) {
				missingRuneImports.add(root);
			}
		}
		ts.forEachChild(node, checkRuneImports);
	};
	checkRuneImports(flowCall);
	for (const rune of missingRuneImports) {
		diags.push({
			code: "TFDSL_IMPORT_SYMBOL",
			severity: "error",
			message: `Rune '${rune}' must be imported from "taskflow-dsl".`,
			file,
		});
	}

	const args = flowCall.arguments;
	if (args.length < 2 || args.length > 3) {
		diags.push(diag(file, sf, flowCall, "TFDSL_ENTRY_ARGS", `flow() requires (name, callback) or (name, options, callback).`));
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
			const evaluated = evalLiteral(a1);
			if (evaluated && typeof evaluated === "object" && !Array.isArray(evaluated)) {
				flowOpts = evaluated as Record<string, unknown>;
			} else {
				diags.push(diag(file, sf, a1, "TFDSL_FLOW_OPTS_DYNAMIC", `Flow options must be a static JSON object without shorthand or spread properties.`));
			}
			const allowedFlowOpts = new Set(["description", "version", "agentScope", "strictInterpolation", "contextSharing", "incremental"]);
			for (const [key, value] of Object.entries(flowOpts)) {
				if (!allowedFlowOpts.has(key)) {
					diags.push(diag(file, sf, a1, "TFDSL_FLOW_OPTS_UNKNOWN", `Unknown flow option '${key}'.`));
					continue;
				}
				const valid =
					(key === "description" && typeof value === "string") ||
					(key === "version" && typeof value === "number") ||
					(key === "agentScope" && (value === "user" || value === "project" || value === "both")) ||
					((key === "strictInterpolation" || key === "contextSharing" || key === "incremental") &&
						typeof value === "boolean");
				if (!valid) diags.push(diag(file, sf, a1, "TFDSL_FLOW_OPTS_TYPE", `Flow option '${key}' has an invalid static value.`));
			}
		} else {
			diags.push(diag(file, sf, a1, "TFDSL_FLOW_OPTS_DYNAMIC", `Flow options must be a static object literal.`));
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
	const ctxParamName = bodyFn.parameters[0] && ts.isIdentifier(bodyFn.parameters[0].name)
		? bodyFn.parameters[0].name.text
		: undefined;
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
		if (!cn) {
			diags.push(diag(file, sf, call, "TFDSL_RUNE_UNKNOWN", `Unsupported call expression cannot erase to a declarative phase.`));
			return undefined;
		}
		const arity = RUNE_ARITY[cn];
		if (arity && (call.arguments.length < arity[0] || call.arguments.length > arity[1])) {
			diags.push(
				diag(
					file,
					sf,
					call,
					"TFDSL_RUNE_ARITY",
					`${cn}() expects ${arity[0] === arity[1] ? arity[0] : `${arity[0]}-${arity[1]}`} argument(s), got ${call.arguments.length}.`,
				),
			);
			return undefined;
		}

		const specialized = trySpecializedEmit(emitCtx, cn, bindName, call, itemParam);
		if (specialized !== "continue") return specialized;

		if (!PHASE_RUNES.has(cn.split(".")[0]!) && !PHASE_RUNES.has(cn)) {
			if (cn === "json") return undefined;
			// Any unknown call in the flow body → hard error (no silent drop).
			// Covers bound (`const x = mystery()`), returned (`return mystery()`),
			// and bare expression statements (`mystery()`).
			diags.push(
				diag(
					file,
					sf,
					call,
					"TFDSL_RUNE_UNKNOWN",
					`Unknown rune or call '${cn}' cannot erase to a phase (typo?).`,
				),
			);
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
				if (ts.isIdentifier(obj) && obj.text === ctxParamName && (method === "budget" || method === "concurrency")) {
					const v = call.arguments[0] ? evalLiteral(call.arguments[0]) : undefined;
					if (method === "budget") {
						if (v && typeof v === "object" && !Array.isArray(v)) budget = v as Record<string, unknown>;
						else diags.push(diag(file, sf, call, "TFDSL_CTX_DYNAMIC", `ctx.budget() requires a static object literal.`));
					} else if (typeof v === "number") concurrency = v;
					else diags.push(diag(file, sf, call, "TFDSL_CTX_DYNAMIC", `ctx.concurrency() requires a static number.`));
					continue;
				}
				// ctx.args.declare
				if (
					ts.isPropertyAccessExpression(obj) &&
					ts.isIdentifier(obj.expression) &&
					obj.expression.text === ctxParamName &&
					obj.name.text === "args" &&
					method === "declare"
				) {
					const v = call.arguments[0] ? evalLiteral(call.arguments[0]) : undefined;
					if (v && typeof v === "object") topArgs = v as Record<string, unknown>;
					else diags.push(diag(file, sf, call, "TFDSL_CTX_DYNAMIC", `ctx.args.declare() requires a static object literal.`));
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
			continue;
		}
		if (ts.isExpressionStatement(st)) {
			diags.push(diag(file, sf, st, "TFDSL_BODY_UNSUPPORTED", `Unsupported expression in flow body; only rune and ctx.* calls are allowed.`));
			continue;
		}

		if (ts.isVariableStatement(st)) {
			for (const decl of st.declarationList.declarations) {
				if (!decl.initializer) {
					diags.push(diag(file, sf, decl, "TFDSL_BODY_UNSUPPORTED", `Flow-body declarations must bind a rune call.`));
					continue;
				}
				// const [a,b] = parallel([agent(...), agent(...)])
				// Desugar to independent agent phases with true ids (a, b) so
				// {steps.a.output} works. Concurrent because no dependsOn between them.
				if (ts.isArrayBindingPattern(decl.name) && ts.isCallExpression(decl.initializer)) {
					const cn = calleeName(decl.initializer.expression);
					if (cn === "parallel") {
						if (decl.initializer.arguments[1]) {
							diags.push(
								diag(
									file,
									sf,
									decl.initializer.arguments[1]!,
									"TFDSL_PARALLEL_DESTRUCTURE_OPTS",
									`parallel() options cannot be preserved when destructuring to independent phase handles; bind the parallel phase as one value or remove the options.`,
								),
							);
							continue;
						}
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
				if (!ts.isIdentifier(decl.name)) {
					diags.push(diag(file, sf, decl.name, "TFDSL_BODY_UNSUPPORTED", `Only identifier bindings or supported parallel destructuring are allowed.`));
					continue;
				}
				const name = decl.name.text;
				if (ts.isCallExpression(decl.initializer)) {
					handleCall(name, decl.initializer);
				} else if (
					ts.isAsExpression(decl.initializer) &&
					ts.isCallExpression(decl.initializer.expression)
				) {
					handleCall(name, decl.initializer.expression);
				} else {
					diags.push(diag(file, sf, decl.initializer, "TFDSL_BODY_UNSUPPORTED", `Flow-body declarations must bind a rune call.`));
				}
			}
			continue;
		}

		if (ts.isReturnStatement(st)) {
			if (!st.expression) {
				diags.push(diag(file, sf, st, "TFDSL_RETURN_UNSUPPORTED", `Flow return must be a phase handle or rune call.`));
			} else if (ts.isIdentifier(st.expression) && phaseByBinding(phases, st.expression.text)) {
				finalId = phaseByBinding(phases, st.expression.text)!.id;
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
			} else {
				diags.push(diag(file, sf, st.expression, "TFDSL_RETURN_UNSUPPORTED", `Flow return must reference a previously declared phase or be a rune call.`));
			}
			continue;
		}

		diags.push(diag(file, sf, st, "TFDSL_BODY_UNSUPPORTED", `Unsupported control flow or statement in declarative flow body.`));
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
			const raw: Record<string, unknown> = { ...ph.raw, id: ph.id };
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
	if (flowOpts.agentScope === "user" || flowOpts.agentScope === "project" || flowOpts.agentScope === "both") taskflow.agentScope = flowOpts.agentScope;
	if (typeof flowOpts.strictInterpolation === "boolean") taskflow.strictInterpolation = flowOpts.strictInterpolation;
	if (typeof flowOpts.contextSharing === "boolean") taskflow.contextSharing = flowOpts.contextSharing;
	if (typeof flowOpts.incremental === "boolean") taskflow.incremental = flowOpts.incremental;
	if (topArgs) taskflow.args = topArgs;
	if (concurrency !== undefined) taskflow.concurrency = concurrency;
	if (budget) taskflow.budget = budget;

	const ok = !diags.some((d) => d.severity === "error");
	return { ok, taskflow: ok ? taskflow : undefined, diagnostics: diags };
}
