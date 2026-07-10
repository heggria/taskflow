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
export type PhaseRef<TJson = unknown> = {
	readonly __brand: "PhaseRef";
	readonly id?: string;
	readonly output: string;
	readonly json: TJson;
};

export type TemplateInput = string;

export interface ArgSpec {
	default?: unknown;
	description?: string;
	required?: boolean;
}

export interface FlowOptions {
	description?: string;
	version?: number;
	agentScope?: "user" | "project" | "both";
	strictInterpolation?: boolean;
	contextSharing?: boolean;
	incremental?: boolean;
}

export interface PhaseOptions<TJson = unknown> {
	id?: string;
	agent?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	cwd?: string;
	output?: "text" | "json" | JsonExpectMarker<TJson>;
	expect?: unknown;
	when?: string;
	join?: "all" | "any";
	dependsOn?: Array<string | PhaseRef<unknown>>;
	retry?: { max?: number; backoffMs?: number; factor?: number };
	timeout?: number;
	optional?: boolean;
	idempotent?: boolean;
	final?: boolean;
	concurrency?: number;
	context?: string[];
	contextLimit?: number;
	onBlock?: "halt" | "retry";
	eval?: string[];
	score?: unknown;
	cache?: {
		scope?: "run-only" | "cross-run" | "off";
		ttl?: string;
		fingerprint?: string[];
	};
	shareContext?: boolean;
	/** Brand from json<T>(). */
	jsonExpect?: unknown;
}

export interface FlowCtx {
	args: { declare(spec: Record<string, ArgSpec>): void };
	concurrency(n: number): void;
	budget(b: { maxUSD?: number; maxTokens?: number }): void;
}

export type TaskflowModuleDefault = { readonly __brand: "TaskflowModuleDefault" };

export interface InlineTaskflowPhase {
	id: string;
	type?: string;
	[key: string]: unknown;
}

export type InlineTaskflowDefinition =
	| { name?: string; phases: InlineTaskflowPhase[] }
	| InlineTaskflowPhase[];

export interface JsonExpectMarker<T> {
	readonly __brand: "JsonExpectMarker";
	readonly _type?: T;
}

export function json<T = unknown>(): JsonExpectMarker<T> {
	return eraseOnly("json");
}

export function flow(
	name: string,
	fn: (ctx: FlowCtx) => PhaseRef<unknown> | void,
): TaskflowModuleDefault;
export function flow(
	name: string,
	opts: FlowOptions,
	fn: (ctx: FlowCtx) => PhaseRef<unknown> | void,
): TaskflowModuleDefault;
export function flow(
	_name: string,
	_optsOrFn: FlowOptions | ((ctx: FlowCtx) => PhaseRef<unknown> | void),
	_fn?: (ctx: FlowCtx) => PhaseRef<unknown> | void,
): TaskflowModuleDefault {
	return eraseOnly("flow");
}

export function agent<TJson = unknown>(_task: TemplateInput, _opts?: PhaseOptions<TJson>): PhaseRef<TJson> {
	return eraseOnly("agent");
}

export function parallel(
	_branches: PhaseRef<unknown>[],
	_opts?: PhaseOptions,
): PhaseRef<unknown>[] & PhaseRef<unknown> {
	return eraseOnly("parallel");
}

export function map<TItem = unknown, TJson = unknown>(
	_source: PhaseRef<TItem[]> | string,
	_fn: (item: TItem) => PhaseRef<unknown>,
	_opts?: PhaseOptions<TJson>,
): PhaseRef<TJson> {
	return eraseOnly("map");
}

export function gate(
	_upstream: PhaseRef<unknown>,
	_opts?: PhaseOptions,
	_task?: (input: PhaseRef<unknown>) => TemplateInput,
): PhaseRef<unknown> {
	return eraseOnly("gate");
}

/** Zero-token pre-checks (`eval`); LLM `task` still required by engine if score absent. */
export function gateAutomated(
	_upstream: PhaseRef<unknown>,
	_opts: PhaseOptions & { pass: string[]; task?: TemplateInput },
): PhaseRef<unknown> {
	return eraseOnly("gate.automated");
}

/** Deterministic scorers (`score`); may omit LLM task when score alone decides. */
export function gateScored(
	_upstream: PhaseRef<unknown>,
	_opts: PhaseOptions & {
		scorers: Array<Record<string, unknown>>;
		combine?: "all" | "any" | "weighted";
		threshold?: number;
		weights?: number[];
		target?: string;
		judge?: { agent?: string; task?: string };
	},
): PhaseRef<unknown> {
	return eraseOnly("gate.scored");
}

gate.automated = gateAutomated;
gate.scored = gateScored;

export function reduce(
	_from: PhaseRef<unknown>[],
	_fn: (parts: Record<string, PhaseRef<unknown>>) => PhaseRef<unknown>,
	_opts?: PhaseOptions,
): PhaseRef<unknown> {
	return eraseOnly("reduce");
}

export function approval(_opts: { request: TemplateInput } & PhaseOptions): PhaseRef<unknown> {
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
	_def: PhaseRef<unknown> | string | InlineTaskflowDefinition,
	_opts?: PhaseOptions,
): PhaseRef<unknown> {
	return eraseOnly("subflow.def");
}
subflow.def = subflowDef;

export function loop(_opts: PhaseOptions & {
	task?: TemplateInput | ((prev: PhaseRef) => TemplateInput);
	until?: string;
	maxIterations?: number;
	convergence?: boolean;
	reflexion?: boolean;
}): PhaseRef<unknown> {
	return eraseOnly("loop");
}

export function tournament(_opts: PhaseOptions & {
	variants?: number;
	branches?: PhaseRef<unknown>[];
	mode?: "best" | "aggregate";
	judge?: string;
	judgeAgent?: string;
	task?: TemplateInput;
}): PhaseRef<unknown> {
	return eraseOnly("tournament");
}

export function script(
	_run: string | string[],
	_opts?: PhaseOptions & { input?: string },
): PhaseRef<unknown> {
	return eraseOnly("script");
}

/** Nested expand (isolated sub-flow). */
export function expandNested<TDef = unknown>(
	_def: PhaseRef<TDef> | string | TDef,
	_opts?: PhaseOptions & { maxNodes?: number },
): PhaseRef<unknown> {
	return eraseOnly("expand.nested");
}

/** Graft-promote expand: run fragment then promote phase states onto parent. */
export function expandGraft<TDef = unknown>(
	_def: PhaseRef<TDef> | string | TDef,
	_opts?: PhaseOptions & { maxNodes?: number },
): PhaseRef<unknown> {
	return eraseOnly("expand.graft");
}

export function expand<TDef = unknown>(
	_def: PhaseRef<TDef> | string | TDef,
	_opts?: PhaseOptions & { expandMode?: "nested" | "graft"; maxNodes?: number },
): PhaseRef<unknown> {
	return eraseOnly("expand");
}
expand.nested = expandNested;
expand.graft = expandGraft;

/** Race: first successful branch wins. */
export function race(
	_branches: PhaseRef<unknown>[],
	_opts?: PhaseOptions & { cancelLosers?: boolean },
): PhaseRef<unknown> {
	return eraseOnly("race");
}
