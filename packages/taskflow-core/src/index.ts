/**
 * taskflow-core — the host-neutral engine.
 *
 * Barrel of everything the pi / codex adapters consume. The engine has no host
 * SDK dependency: schema (DSL + validation), runtime (DAG execution), cache,
 * interpolation, verification, the FlowIR compile seam, the shared context tree,
 * agent discovery, persistence, and the host-neutral SubagentRunner contract.
 *
 * Adapters inject their own subagent runner via `RuntimeDeps.runTask`.
 */

export * from "./schema.ts";
export * from "./jsonc.ts";
export * from "./contract.ts";
export * from "./scorers.ts";
export * from "./scorer-runtime.ts";
export * from "./reflexion.ts";
export * from "./peek.ts";
export * from "./runtime.ts";
export * from "./cache.ts";
export * from "./interpolate.ts";
export * from "./verify.ts";
export * from "./usage.ts";
export * from "./stale.ts";
export * from "./workspace.ts";
export * from "./context-store.ts";
export * from "./compile.ts";
// NOTE: detached-runner.ts is intentionally NOT re-exported — it is a spawn-only
// entry point with top-level argv parsing + process.exit. Importing it via the
// barrel would run that entry on every `import` of taskflow-core. The pi adapter
// spawns it directly by file path.
export * from "./store.ts";
export * from "./agents.ts";
export * from "./library/types.ts";
export * from "./library/meta.ts";
export * from "./library/search.ts";
export * from "./runner-core.ts";
export * from "./host/runner-types.ts";
export * from "./flowir/index.ts";
