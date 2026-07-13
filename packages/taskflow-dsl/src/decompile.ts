/**
 * Taskflow JSON → .tf.ts (semantic, not literal round-trip).
 * MVP: agent / script / map / parallel / gate / reduce / approval / flow / loop / tournament.
 */

import { dependenciesOf, type Taskflow, type Phase } from "taskflow-core";

/**
 * Encode JSON-compatible data as a standalone JavaScript/TypeScript expression.
 *
 * This deliberately does not concatenate JSON.stringify() output into generated
 * source.  Every code-significant ASCII character in strings is escaped, as are
 * line separators and non-ASCII code units, so user-controlled Taskflow text can
 * never terminate a literal or create a script-closing sequence.  The recursive
 * encoder also rejects non-JSON values instead of silently changing semantics.
 */
function sourceLiteral(value: unknown, seen = new Set<object>()): string {
	if (value === null) return "null";
	if (typeof value === "string") {
		let out = '"';
		for (let i = 0; i < value.length; i++) {
			const code = value.charCodeAt(i);
			if (code === 0x22) out += '\\"';
			else if (code === 0x5c) out += "\\\\";
			else if (
				code >= 0x20 && code <= 0x7e &&
				code !== 0x26 && // ampersand: keep generated source inert in HTML/script transports
				code !== 0x3c && // less-than: prevents a literal </script sequence
				code !== 0x3e
			) out += value[i];
			else out += `\\u${code.toString(16).padStart(4, "0")}`;
		}
		return `${out}"`;
	}
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("TFDSL_DECOMPILE_UNSUPPORTED: non-finite number cannot be emitted");
		return Object.is(value, -0) ? "-0" : String(value);
	}
	if (typeof value !== "object") {
		throw new Error(`TFDSL_DECOMPILE_UNSUPPORTED: ${typeof value} is not a JSON source literal`);
	}
	if (seen.has(value)) throw new Error("TFDSL_DECOMPILE_UNSUPPORTED: cyclic value cannot be emitted");
	seen.add(value);
	try {
		if (Array.isArray(value)) return `[${value.map((item) => sourceLiteral(item, seen)).join(", ")}]`;
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) {
			throw new Error("TFDSL_DECOMPILE_UNSUPPORTED: non-plain object cannot be emitted");
		}
		const entries = Object.entries(value);
		if (entries.some(([key]) => key === "__proto__")) {
			throw new Error("TFDSL_DECOMPILE_UNSUPPORTED: '__proto__' object keys cannot round-trip safely");
		}
		return `{ ${entries
			.map(([key, item]) => `${sourceLiteral(key, seen)}: ${sourceLiteral(item, seen)}`)
			.join(", ")} }`;
	} finally {
		seen.delete(value);
	}
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

function branchSource(branch: Record<string, unknown>, role: string): string {
	const unsupported = Object.keys(branch).filter((key) => key !== "task" && key !== "agent");
	if (unsupported.length > 0) {
		throw new Error(
			`TFDSL_DECOMPILE_UNSUPPORTED: ${role} contains unsupported branch option(s): ${unsupported.join(", ")}; only task and agent are runtime-supported`,
		);
	}
	if (typeof branch.task !== "string") {
		throw new Error(`TFDSL_DECOMPILE_UNSUPPORTED: ${role}.task must be a string`);
	}
	if (branch.agent !== undefined && typeof branch.agent !== "string") {
		throw new Error(`TFDSL_DECOMPILE_UNSUPPORTED: ${role}.agent must be a string`);
	}
	const branchOpts = branch.agent === undefined ? "" : `, { agent: ${sourceLiteral(branch.agent)} }`;
	return `agent(${sourceLiteral(branch.task)}${branchOpts})`;
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

/**
 * Produce the least-disruptive topological order: an already-topological input
 * remains byte-for-byte ordered, while a consumer that precedes its dependency
 * moves just far enough for generated TypeScript bindings to be in scope.
 * `topoLayers().flat()` is intentionally not used here because breadth layers
 * can move unrelated phases across a consumer and break semantic round-trip
 * ordering even when the input was already valid TypeScript declaration order.
 */
function stableTopologicalPhases(phases: readonly Phase[]): Phase[] {
	const byId = new Map(phases.map((phase) => [phase.id, phase]));
	const inputIndex = new Map(phases.map((phase, index) => [phase.id, index]));
	const indegree = new Map(phases.map((phase) => [phase.id, 0]));
	const dependents = new Map(phases.map((phase) => [phase.id, [] as string[]]));

	for (const phase of phases) {
		for (const dependency of dependenciesOf(phase)) {
			if (!byId.has(dependency)) continue;
			indegree.set(phase.id, (indegree.get(phase.id) ?? 0) + 1);
			dependents.get(dependency)!.push(phase.id);
		}
	}

	const ready = phases
		.filter((phase) => (indegree.get(phase.id) ?? 0) === 0)
		.map((phase) => phase.id);
	const ordered: Phase[] = [];
	while (ready.length > 0) {
		ready.sort((a, b) => inputIndex.get(a)! - inputIndex.get(b)!);
		const id = ready.shift()!;
		ordered.push(byId.get(id)!);
		for (const dependent of dependents.get(id) ?? []) {
			const next = (indegree.get(dependent) ?? 0) - 1;
			indegree.set(dependent, next);
			if (next === 0) ready.push(dependent);
		}
	}
	return ordered;
}

export function decompileTaskflow(def: Taskflow): string {
	const inputPhases = def.phases ?? [];
	const phases = stableTopologicalPhases(inputPhases);
	if (phases.length !== inputPhases.length) {
		throw new Error(
			"TFDSL_DECOMPILE_UNSUPPORTED: phase graph cannot be topologically ordered",
		);
	}

	for (const p of phases) {
		const type = p.type ?? "agent";
		if (!DECOMPILABLE.has(type)) {
			throw new Error(
				`TFDSL_DECOMPILE_UNSUPPORTED: phase type ${sourceLiteral(p.type)} (id=${p.id}) cannot be decompiled in MVP`,
			);
		}
	}

	const lines: string[] = [];
	const imports = new Set(["flow"]);
	for (const p of phases) {
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
	const flowOptText = Object.keys(flowOpts).length ? `, ${sourceLiteral(flowOpts)}` : "";
	lines.push(`export default flow(${sourceLiteral(def.name)}${flowOptText}, (ctx) => {`);

	if (def.budget) {
		lines.push(`  ctx.budget(${sourceLiteral(def.budget)});`);
	}
	if (typeof def.concurrency === "number") {
		lines.push(`  ctx.concurrency(${def.concurrency});`);
	}
	if (def.args && typeof def.args === "object") {
		lines.push(`  ctx.args.declare(${sourceLiteral(def.args)});`);
	}

	const byId = new Map(inputPhases.map((p) => [p.id, p]));
	const bindings = allocateBindings(inputPhases);
	let returnBind: string | undefined;

	// Rune references are ordinary TypeScript bindings, so every dependency must
	// be declared before its consumer even though Taskflow JSON itself permits
	// phases in any order. Keep binding allocation and implicit-final selection
	// tied to the input order so topological emission changes no semantics.
	for (const p of phases) {
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
	if (bind !== p.id) opts.push(`id: ${sourceLiteral(p.id)}`);
	const raw = p as unknown as Record<string, unknown>;
	for (const key of [
		"agent", "model", "thinking", "tools", "cwd", "output", "expect", "when", "join", "dependsOn",
		"retry", "timeout", "optional", "idempotent", "final", "concurrency", "context", "contextLimit",
		"onBlock", "eval", "score", "cache", "shareContext", "convergence", "reflexion",
	] as const) {
		if (raw[key] !== undefined) opts.push(`${key}: ${sourceLiteral(raw[key])}`);
	}
	if ((p as { cancelLosers?: boolean }).cancelLosers === false) opts.push(`cancelLosers: false`);
	if (raw.input !== undefined) opts.push(`input: ${sourceLiteral(raw.input)}`);
	const maxNodes = (p as { maxNodes?: number }).maxNodes;
	if (typeof maxNodes === "number") opts.push(`maxNodes: ${maxNodes}`);
	const optStr = opts.length ? `, { ${opts.join(", ")} }` : "";
	const optObj = `{ ${opts.join(", ")} }`;

	switch (p.type ?? "agent") {
		case "agent":
			return `const ${bind} = agent(${sourceLiteral(String(p.task ?? ""))}${optStr});`;
		case "script": {
			const run = p.run;
			if (Array.isArray(run)) {
				return `const ${bind} = script(${sourceLiteral(run)}${optStr});`;
			}
			return `const ${bind} = script(${sourceLiteral(String(run ?? ""))}${optStr});`;
		}
		case "map": {
			const as = p.as ?? "item";
			const local = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(as) && !RESERVED.has(as) ? as : "item";
			const mapOpts = p.as === undefined ? opts : [`as: ${sourceLiteral(as)}`, ...opts];
			const mapOptStr = mapOpts.length ? `, { ${mapOpts.join(", ")} }` : "";
			return `const ${bind} = map(${sourceLiteral(p.over ?? "[]")}, (${local}) => agent(${sourceLiteral(String(p.task ?? `{${as}}`))})${mapOptStr});`;
		}
		case "parallel": {
			const branches = (p.branches ?? []).map((b, i) => branchSource(b as unknown as Record<string, unknown>, `parallel ${p.id} branch ${i}`));
			return `const ${bind} = parallel([${branches.join(", ")}]${optStr});`;
		}
		case "gate": {
			const upId = p.dependsOn?.[0];
			const upBind = upId ? bindings.get(upId) : undefined;
			if (!upBind) throw new Error(`TFDSL_DECOMPILE_UNSUPPORTED: gate ${sourceLiteral(p.id)} requires a known dependency`);
			if (p.task === undefined) return `const ${bind} = gate(${upBind}, ${optObj});`;
			return `const ${bind} = gate(${upBind}, ${optObj}, (i) => ${sourceLiteral(p.task)});`;
		}
		case "race": {
			const branches = (p.branches ?? []).map((b, i) => branchSource(b as unknown as Record<string, unknown>, `race ${p.id} branch ${i}`));
			return `const ${bind} = race([${branches.join(", ")}]${optStr});`;
		}
		case "expand": {
			if (typeof p.def !== "string") {
				throw new Error(
					`TFDSL_DECOMPILE_UNSUPPORTED: expand phase ${sourceLiteral(p.id)} has non-string def (inline object cannot be recovered as a rune argument)`,
				);
			}
			const em = (p as { expandMode?: string }).expandMode ?? "nested";
			// Always emit expandMode + shared opts (dependsOn/final/when/maxNodes) so
			// decompile → rebuild keeps DAG edges that string-def alone would lose.
			const expandOpts = [
				`expandMode: ${sourceLiteral(em)}`,
				...(p.with === undefined ? [] : [`with: ${sourceLiteral(p.with)}`]),
				...opts,
			];
			return `const ${bind} = expand(${sourceLiteral(p.def)}, { ${expandOpts.join(", ")} });`;
		}
		case "reduce": {
			const from = (p.from ?? p.dependsOn ?? []).map((id) => {
				const b = bindings.get(id);
				if (!b) throw new Error(`TFDSL_DECOMPILE_UNSUPPORTED: reduce ${sourceLiteral(p.id)} references unknown phase ${sourceLiteral(id)}`);
				return b;
			});
			return `const ${bind} = reduce([${from.join(", ")}], (parts) => agent(${sourceLiteral(String(p.task ?? "reduce"))})${optStr});`;
		}
		case "approval":
			return `const ${bind} = approval({ request: ${sourceLiteral(String(p.task ?? "Approve?"))}${opts.length ? `, ${opts.join(", ")}` : ""} });`;
		case "flow":
			if (p.def !== undefined) {
				if (typeof p.def !== "string") {
					throw new Error(
						`TFDSL_DECOMPILE_UNSUPPORTED: flow phase ${sourceLiteral(p.id)} has non-string def (cannot decompile inline object)`,
					);
				}
				const defOpts = p.with === undefined ? opts : [`with: ${sourceLiteral(p.with)}`, ...opts];
				const defOptStr = defOpts.length ? `, { ${defOpts.join(", ")} }` : "";
				return `const ${bind} = subflow.def(${sourceLiteral(p.def)}${defOptStr});`;
			}
			return `const ${bind} = subflow(${sourceLiteral(p.use ?? "child")}, ${sourceLiteral(p.with ?? {})}${optStr});`;
		case "loop":
			return `const ${bind} = loop({ task: ${sourceLiteral(String(p.task ?? ""))}, maxIterations: ${p.maxIterations ?? 10}, until: ${sourceLiteral(p.until ?? "false")}${opts.length ? `, ${opts.join(", ")}` : ""} });`;
		case "tournament": {
			const tournamentOpts = [
				...(p.variants === undefined ? [] : [`variants: ${p.variants}`]),
				...(p.task === undefined ? [] : [`task: ${sourceLiteral(p.task)}`]),
				...(p.mode === undefined ? [] : [`mode: ${sourceLiteral(p.mode)}`]),
				...(p.branches === undefined
					? []
					: [`branches: [${p.branches.map((b, i) => branchSource(b as unknown as Record<string, unknown>, `tournament ${p.id} branch ${i}`)).join(", ")}]`]),
				...(p.judge === undefined ? [] : [`judge: ${sourceLiteral(p.judge)}`]),
				...(p.judgeAgent === undefined ? [] : [`judgeAgent: ${sourceLiteral(p.judgeAgent)}`]),
				...opts,
			];
			return `const ${bind} = tournament({ ${tournamentOpts.join(", ")} });`;
		}
		default:
			return `// TFDSL: unsupported-field type=${p.type} id=${p.id}`;
	}
}
