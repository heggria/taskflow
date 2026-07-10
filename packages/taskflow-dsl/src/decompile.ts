/**
 * Taskflow JSON → .tf.ts (semantic, not literal round-trip).
 * MVP: agent / script / map / parallel / gate / reduce / approval / flow / loop / tournament.
 */

import type { Taskflow, Phase } from "taskflow-core";

function esc(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

const RESERVED = new Set([
	"break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete",
	"do", "else", "export", "extends", "false", "finally", "for", "function", "if", "import",
	"in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true",
	"try", "typeof", "var", "void", "while", "with", "yield", "let", "static", "await", "ctx",
	"flow", "agent", "map", "parallel", "gate", "reduce", "approval", "subflow", "loop",
	"tournament", "script", "race", "expand",
]);

function allocateBindings(phases: readonly Phase[]): Map<string, string> {
	const out = new Map<string, string>();
	const used = new Set<string>(RESERVED);
	for (const p of phases) {
		let base = p.id.replace(/[^A-Za-z0-9_$]/g, "_") || "phase";
		if (/^[0-9]/.test(base)) base = `p_${base}`;
		if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(base) || RESERVED.has(base)) base = `p_${base}`;
		let candidate = base;
		let suffix = 2;
		while (used.has(candidate)) candidate = `${base}_${suffix++}`;
		used.add(candidate);
		out.set(p.id, candidate);
	}
	return out;
}

function safeIdent(name: string, role: string): string {
	if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) || RESERVED.has(name)) {
		throw new Error(`TFDSL_DECOMPILE_UNSUPPORTED: ${role} ${JSON.stringify(name)} is not a safe identifier`);
	}
	return name;
}

const DECOMPILABLE = new Set([
	"agent",
	"script",
	"map",
	"parallel",
	"gate",
	"reduce",
	"approval",
	"flow",
	"loop",
	"tournament",
	"race",
	"expand",
]);

export function decompileTaskflow(def: Taskflow): string {
	for (const p of def.phases ?? []) {
		const type = p.type ?? "agent";
		if (!DECOMPILABLE.has(type)) {
			throw new Error(
				`TFDSL_DECOMPILE_UNSUPPORTED: phase type ${JSON.stringify(p.type)} (id=${p.id}) cannot be decompiled in MVP`,
			);
		}
	}

	const lines: string[] = [];
	const imports = new Set(["flow"]);
	for (const p of def.phases ?? []) {
		const kind = p.type ?? "agent";
		if (kind === "flow") imports.add("subflow");
		else imports.add(kind);
		if (["map", "parallel", "gate", "reduce", "race"].includes(kind)) imports.add("agent");
	}
	// Stable import order for golden/tests
	const order = [
		"flow",
		"agent",
		"map",
		"parallel",
		"gate",
		"reduce",
		"approval",
		"subflow",
		"loop",
		"tournament",
		"script",
		"race",
		"expand",
	];
	const importList = order.filter((n) => imports.has(n));
	lines.push(`import { ${importList.join(", ")} } from "taskflow-dsl";`);
	lines.push(``);
	const flowOpts: Record<string, unknown> = {};
	for (const key of ["description", "version", "agentScope", "strictInterpolation", "contextSharing", "incremental"] as const) {
		const value = (def as unknown as Record<string, unknown>)[key];
		if (value !== undefined) flowOpts[key] = value;
	}
	const flowOptText = Object.keys(flowOpts).length ? `, ${JSON.stringify(flowOpts)}` : "";
	lines.push(`export default flow(${JSON.stringify(def.name)}${flowOptText}, (ctx) => {`);

	if (def.budget) {
		lines.push(`  ctx.budget(${JSON.stringify(def.budget)});`);
	}
	if (typeof def.concurrency === "number") {
		lines.push(`  ctx.concurrency(${def.concurrency});`);
	}
	if (def.args && typeof def.args === "object") {
		lines.push(`  ctx.args.declare(${JSON.stringify(def.args)});`);
	}

	const byId = new Map((def.phases ?? []).map((p) => [p.id, p]));
	const bindings = allocateBindings(def.phases ?? []);
	let returnBind: string | undefined;

	for (const p of def.phases ?? []) {
		const bind = bindings.get(p.id)!;
		if (p.final) returnBind = bind;
		const line = decompilePhase(p, bind, byId, bindings);
		lines.push(`  ${line}`);
	}

	if (!returnBind && def.phases?.length) returnBind = bindings.get(def.phases[def.phases.length - 1]!.id);
	if (returnBind) {
		lines.push(`  return ${returnBind};`);
	}
	lines.push(`});`);
	lines.push(``);
	return lines.join("\n");
}

function decompilePhase(p: Phase, bind: string, _byId: Map<string, Phase>, bindings: Map<string, string>): string {
	const opts: string[] = [];
	if (bind !== p.id) opts.push(`id: ${JSON.stringify(p.id)}`);
	const raw = p as unknown as Record<string, unknown>;
	for (const key of [
		"agent", "model", "thinking", "tools", "cwd", "output", "expect", "when", "join", "dependsOn",
		"retry", "timeout", "optional", "idempotent", "final", "concurrency", "context", "contextLimit",
		"onBlock", "eval", "score", "cache", "shareContext", "convergence", "reflexion",
	] as const) {
		if (raw[key] !== undefined) opts.push(`${key}: ${JSON.stringify(raw[key])}`);
	}
	if ((p as { cancelLosers?: boolean }).cancelLosers === false) opts.push(`cancelLosers: false`);
	if (raw.input !== undefined) opts.push(`input: ${JSON.stringify(raw.input)}`);
	const maxNodes = (p as { maxNodes?: number }).maxNodes;
	if (typeof maxNodes === "number") opts.push(`maxNodes: ${maxNodes}`);
	const optStr = opts.length ? `, { ${opts.join(", ")} }` : "";
	const optObj = `{ ${opts.join(", ")} }`;

	switch (p.type ?? "agent") {
		case "agent":
			return `const ${bind} = agent(\`${esc(String(p.task ?? ""))}\`${optStr});`;
		case "script": {
			const run = p.run;
			if (Array.isArray(run)) {
				return `const ${bind} = script(${JSON.stringify(run)}${optStr});`;
			}
			return `const ${bind} = script(\`${esc(String(run ?? ""))}\`${optStr});`;
		}
		case "map": {
			const as = safeIdent(p.as ?? "item", "map.as");
			return `const ${bind} = map(${JSON.stringify(p.over ?? "[]")}, (${as}) => agent(\`${esc(String(p.task ?? "{item}"))}\`)${optStr});`;
		}
		case "parallel": {
			const branches = (p.branches ?? []).map(
				(b) => `agent(\`${esc(String(b.task ?? ""))}\`${b.agent ? `, { agent: ${JSON.stringify(b.agent)} }` : ""})`,
			);
			return `const ${bind} = parallel([${branches.join(", ")}]${optStr});`;
		}
		case "gate": {
			const upId = p.dependsOn?.[0];
			const upBind = upId ? bindings.get(upId) : undefined;
			if (!upBind) throw new Error(`TFDSL_DECOMPILE_UNSUPPORTED: gate ${JSON.stringify(p.id)} requires a known dependency`);
			const taskText = String(p.task ?? (upId ? `{steps.${upId}.output}` : "review"));
			return `const ${bind} = gate(${upBind}, ${optObj}, (i) => \`${esc(taskText)}\`);`;
		}
		case "race": {
			const branches = (p.branches ?? []).map(
				(b) => `agent(\`${esc(String(b.task ?? ""))}\`${b.agent ? `, { agent: ${JSON.stringify(b.agent)} }` : ""})`,
			);
			return `const ${bind} = race([${branches.join(", ")}]${optStr});`;
		}
		case "expand": {
			if (typeof p.def !== "string") {
				throw new Error(
					`TFDSL_DECOMPILE_UNSUPPORTED: expand phase ${JSON.stringify(p.id)} has non-string def (inline object cannot be recovered as a rune argument)`,
				);
			}
			const em = (p as { expandMode?: string }).expandMode ?? "nested";
			// Always emit expandMode + shared opts (dependsOn/final/when/maxNodes) so
			// decompile → rebuild keeps DAG edges that string-def alone would lose.
			const expandOpts = [`expandMode: ${JSON.stringify(em)}`, ...opts];
			return `const ${bind} = expand(${JSON.stringify(p.def)}, { ${expandOpts.join(", ")} });`;
		}
		case "reduce": {
			const from = (p.from ?? p.dependsOn ?? []).map((id) => {
				const b = bindings.get(id);
				if (!b) throw new Error(`TFDSL_DECOMPILE_UNSUPPORTED: reduce ${JSON.stringify(p.id)} references unknown phase ${JSON.stringify(id)}`);
				return b;
			});
			return `const ${bind} = reduce([${from.join(", ")}], (parts) => agent(\`${esc(String(p.task ?? "reduce"))}\`)${optStr});`;
		}
		case "approval":
			return `const ${bind} = approval({ request: \`${esc(String(p.task ?? "Approve?"))}\`${opts.length ? `, ${opts.join(", ")}` : ""} });`;
		case "flow":
			if (p.def !== undefined) {
				if (typeof p.def !== "string") {
					throw new Error(
						`TFDSL_DECOMPILE_UNSUPPORTED: flow phase ${JSON.stringify(p.id)} has non-string def (cannot decompile inline object)`,
					);
				}
				return `const ${bind} = subflow.def(${JSON.stringify(p.def)}${optStr});`;
			}
			return `const ${bind} = subflow(${JSON.stringify(p.use ?? "child")}, ${JSON.stringify(p.with ?? {})}${optStr});`;
		case "loop":
			return `const ${bind} = loop({ task: ${JSON.stringify(String(p.task ?? ""))}, maxIterations: ${p.maxIterations ?? 10}, until: ${JSON.stringify(p.until ?? "false")}${opts.length ? `, ${opts.join(", ")}` : ""} });`;
		case "tournament":
			return `const ${bind} = tournament({ variants: ${p.variants ?? 2}, task: ${JSON.stringify(String(p.task ?? ""))}, mode: ${JSON.stringify(p.mode ?? "best")}${p.branches ? `, branches: [${p.branches.map((b) => `agent(${JSON.stringify(b.task)}${b.agent ? `, { agent: ${JSON.stringify(b.agent)} }` : ""})`).join(", ")}]` : ""}${p.judge ? `, judge: ${JSON.stringify(p.judge)}` : ""}${p.judgeAgent ? `, judgeAgent: ${JSON.stringify(p.judgeAgent)}` : ""}${opts.length ? `, ${opts.join(", ")}` : ""} });`;
		default:
			return `// TFDSL: unsupported-field type=${p.type} id=${p.id}`;
	}
}
