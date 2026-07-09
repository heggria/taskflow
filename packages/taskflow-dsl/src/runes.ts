/**
 * Authoring surface — compile-time directives (runes).
 * At Node runtime every call throws TFDSL_ERASE_ONLY.
 */

export class TfDslEraseOnlyError extends Error {
	readonly code = "TFDSL_ERASE_ONLY";
	constructor(rune: string) {
		super(
			`TFDSL_ERASE_ONLY: ${rune}() is a compile-time directive. Run \`taskflow-dsl build\` on this .tf.ts file; do not execute it as a program.`,
		);
		this.name = "TfDslEraseOnlyError";
	}
}

function eraseOnly(rune: string): never {
	throw new TfDslEraseOnlyError(rune);
}

/** Opaque phase handle — only meaningful to the compiler. */
export type PhaseRef = { readonly __brand: "PhaseRef"; readonly id?: string };

export type TemplateInput = string;

export interface ArgSpec {
	default?: unknown;
	description?: string;
	required?: boolean;
}

export interface FlowOptions {
	description?: string;
	version?: number;
}

export interface PhaseOptions {
	id?: string;
	agent?: string;
	model?: string;
	thinking?: string | boolean;
	tools?: string[];
	cwd?: string;
	output?: "text" | "json";
	expect?: unknown;
	when?: string;
	join?: "all" | "any";
	dependsOn?: string[];
	retry?: { max?: number; backoffMs?: number; factor?: number };
	timeout?: number;
	optional?: boolean;
	idempotent?: boolean;
	final?: boolean;
	concurrency?: number;
	/** Brand from json<T>(). */
	jsonExpect?: unknown;
}

export interface FlowCtx {
	args: { declare(spec: Record<string, ArgSpec>): void };
	concurrency(n: number): void;
	budget(b: { maxUSD?: number; maxTokens?: number }): void;
}

export type TaskflowModuleDefault = { readonly __brand: "TaskflowModuleDefault" };

export interface JsonExpectMarker<T> {
	readonly __brand: "JsonExpectMarker";
	readonly _type?: T;
}

export function json<T = unknown>(): JsonExpectMarker<T> {
	return eraseOnly("json");
}

export function flow(
	name: string,
	fn: (ctx: FlowCtx) => PhaseRef | void,
): TaskflowModuleDefault;
export function flow(
	name: string,
	opts: FlowOptions,
	fn: (ctx: FlowCtx) => PhaseRef | void,
): TaskflowModuleDefault;
export function flow(
	_name: string,
	_optsOrFn: FlowOptions | ((ctx: FlowCtx) => PhaseRef | void),
	_fn?: (ctx: FlowCtx) => PhaseRef | void,
): TaskflowModuleDefault {
	return eraseOnly("flow");
}

export function agent(_task: TemplateInput, _opts?: PhaseOptions): PhaseRef {
	return eraseOnly("agent");
}

export function parallel(
	_branches: PhaseRef[],
	_opts?: PhaseOptions,
): PhaseRef[] & PhaseRef {
	return eraseOnly("parallel");
}

export function map(
	_source: PhaseRef | string,
	_fn: (item: unknown) => PhaseRef,
	_opts?: PhaseOptions,
): PhaseRef {
	return eraseOnly("map");
}

export function gate(
	_upstream: PhaseRef,
	_opts?: PhaseOptions,
	_task?: (input: PhaseRef) => TemplateInput,
): PhaseRef {
	return eraseOnly("gate");
}

/** Zero-token pre-checks (`eval`); LLM `task` still required by engine if score absent. */
export function gateAutomated(
	_upstream: PhaseRef,
	_opts: PhaseOptions & { pass: string[]; task?: TemplateInput },
): PhaseRef {
	return eraseOnly("gate.automated");
}

/** Deterministic scorers (`score`); may omit LLM task when score alone decides. */
export function gateScored(
	_upstream: PhaseRef,
	_opts: PhaseOptions & {
		scorers: Array<Record<string, unknown>>;
		combine?: "all" | "any" | "weighted";
		threshold?: number;
		weights?: number[];
		target?: string;
		judge?: { agent?: string; task?: string };
	},
): PhaseRef {
	return eraseOnly("gate.scored");
}

gate.automated = gateAutomated;
gate.scored = gateScored;

export function reduce(
	_from: PhaseRef[],
	_fn: (parts: Record<string, PhaseRef>) => PhaseRef,
	_opts?: PhaseOptions,
): PhaseRef {
	return eraseOnly("reduce");
}

export function approval(_opts: { request: TemplateInput } & PhaseOptions): PhaseRef {
	return eraseOnly("approval");
}

export function subflow(
	_use: string,
	_withArgs?: Record<string, unknown>,
	_opts?: PhaseOptions,
): PhaseRef {
	return eraseOnly("subflow");
}

/** Nested dynamic sub-flow (compiles to type:flow def). */
export function subflowDef(
	_def: PhaseRef | string,
	_opts?: PhaseOptions,
): PhaseRef {
	return eraseOnly("subflow.def");
}
subflow.def = subflowDef;

export function loop(_opts: PhaseOptions & {
	task?: TemplateInput | ((prev: PhaseRef) => TemplateInput);
	until?: string;
	maxIterations?: number;
	convergence?: boolean;
	reflexion?: boolean;
}): PhaseRef {
	return eraseOnly("loop");
}

export function tournament(_opts: PhaseOptions & {
	variants?: number;
	branches?: PhaseRef[];
	mode?: "best" | "aggregate";
	judge?: string;
	judgeAgent?: string;
	task?: TemplateInput;
}): PhaseRef {
	return eraseOnly("tournament");
}

export function script(
	_run: string | string[],
	_opts?: PhaseOptions & { input?: string },
): PhaseRef {
	return eraseOnly("script");
}

/** Nested expand (isolated sub-flow). */
export function expandNested(
	_def: PhaseRef | string,
	_opts?: PhaseOptions & { maxNodes?: number },
): PhaseRef {
	return eraseOnly("expand.nested");
}

/** Graft-promote expand: run fragment then promote phase states onto parent. */
export function expandGraft(
	_def: PhaseRef | string,
	_opts?: PhaseOptions & { maxNodes?: number },
): PhaseRef {
	return eraseOnly("expand.graft");
}

export function expand(
	_def: PhaseRef | string,
	_opts?: PhaseOptions & { expandMode?: "nested" | "graft"; maxNodes?: number },
): PhaseRef {
	return eraseOnly("expand");
}
expand.nested = expandNested;
expand.graft = expandGraft;

/** Race: first completed branch wins. */
export function race(
	_branches: PhaseRef[],
	_opts?: PhaseOptions & { cancelLosers?: boolean },
): PhaseRef {
	return eraseOnly("race");
}
