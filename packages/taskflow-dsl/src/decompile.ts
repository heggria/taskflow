/**
 * Taskflow JSON → .tf.ts (semantic, not literal round-trip).
 * MVP: agent / script / map / parallel / gate / reduce / approval / flow / loop / tournament.
 */

import type { Taskflow, Phase } from "taskflow-core";

function esc(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function phaseBinding(id: string): string {
	// valid-ish JS identifier — never inject raw phase id into free-text template slots
	const b = id.replace(/[^A-Za-z0-9_$]/g, "_");
	const safe = /^[0-9]/.test(b) ? `p_${b}` : b || "phase";
	if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(safe)) {
		throw new Error(`TFDSL_DECOMPILE_UNSUPPORTED: phase id ${JSON.stringify(id)} is not a safe identifier`);
	}
	return safe;
}

function safeIdent(name: string, role: string): string {
	if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
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
		if (!DECOMPILABLE.has(p.type)) {
			throw new Error(
				`TFDSL_DECOMPILE_UNSUPPORTED: phase type ${JSON.stringify(p.type)} (id=${p.id}) cannot be decompiled in MVP`,
			);
		}
	}

	const lines: string[] = [];
	const imports = new Set([
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
	]);
	for (const p of def.phases ?? []) {
		if (p.type === "race") imports.add("race");
		if (p.type === "expand") imports.add("expand");
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
	const desc = def.description ? `, { description: ${JSON.stringify(def.description)} }` : "";
	lines.push(`export default flow(${JSON.stringify(def.name)}${desc}, (ctx) => {`);

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
	let lastBind: string | undefined;

	for (const p of def.phases ?? []) {
		const bind = phaseBinding(p.id);
		lastBind = bind;
		const line = decompilePhase(p, bind, byId);
		lines.push(`  ${line}`);
	}

	if (lastBind) {
		lines.push(`  return ${lastBind};`);
	}
	lines.push(`});`);
	lines.push(``);
	return lines.join("\n");
}

function decompilePhase(p: Phase, bind: string, _byId: Map<string, Phase>): string {
	const opts: string[] = [];
	if (p.agent) opts.push(`agent: ${JSON.stringify(p.agent)}`);
	if (p.final) opts.push(`final: true`);
	if (p.when) opts.push(`when: ${JSON.stringify(p.when)}`);
	if (p.dependsOn?.length) opts.push(`dependsOn: ${JSON.stringify(p.dependsOn)}`);
	if (p.output) opts.push(`output: ${JSON.stringify(p.output)}`);
	const optStr = opts.length ? `, { ${opts.join(", ")} }` : "";

	switch (p.type) {
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
			const upBind = upId ? phaseBinding(upId) : "upstream";
			const taskText = String(p.task ?? (upId ? `{steps.${upId}.output}` : "review"));
			return `const ${bind} = gate(${upBind}, { agent: ${JSON.stringify(p.agent ?? "reviewer")} }, (i) => \`${esc(taskText)}\`);`;
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
			return `const ${bind} = expand(${JSON.stringify(p.def)}, { expandMode: ${JSON.stringify(em)} });`;
		}
		case "reduce": {
			const from = (p.from ?? p.dependsOn ?? []).map((id) => phaseBinding(id));
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
			return `const ${bind} = subflow(${JSON.stringify(p.use ?? "child")}${optStr});`;
		case "loop":
			return `const ${bind} = loop({ task: \`${esc(String(p.task ?? ""))}\`, maxIterations: ${p.maxIterations ?? 10}, until: ${JSON.stringify(p.until ?? "false")}${p.agent ? `, agent: ${JSON.stringify(p.agent)}` : ""} });`;
		case "tournament":
			return `const ${bind} = tournament({ variants: ${p.variants ?? 2}, task: \`${esc(String(p.task ?? ""))}\`, mode: ${JSON.stringify(p.mode ?? "best")} });`;
		default:
			return `// TFDSL: unsupported-field type=${p.type} id=${p.id}`;
	}
}
