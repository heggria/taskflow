# Modularization notes (0.2.0)

Avoid monolith growth while S4 lands. Prefer **extract-by-kind / extract-by-phase** over more branches in giant files.

## taskflow-dsl erase

```
packages/taskflow-dsl/src/build/erase/
├─ pipeline.ts          ← flow() discovery + body walk only (~280 LOC)
├─ context.ts           ← EmitContext, register(), bindDefArg()
├─ ast.ts / opts.ts / templates.ts / types.ts
└─ kinds/
   ├─ index.ts          ← KIND_HANDLERS registry + trySpecializedEmit()
   ├─ agent-script.ts
   ├─ map.ts / parallel.ts / race.ts
   ├─ gate.ts / gate-sugar.ts
   ├─ reduce.ts / approval.ts / loop.ts / tournament.ts
   └─ expand-flow.ts    ← expand + subflow.def / subflow use
```

**Rule:** new phase kind → new file under `kinds/` + one entry in `KIND_HANDLERS`. Do not re-inflate `pipeline.ts`.

## taskflow-core runtime

```
packages/taskflow-core/src/runtime.ts   ← still large; strangler ongoing
packages/taskflow-core/src/runtime/phases/
├─ race.ts     ← race execution
└─ expand.ts   ← pure helpers (mode, maxNodes, prefix, promote)
```

Expand **execution** still shares the `flow|expand` block in `runtime.ts` (sub-run + budget clamp). Pure fragment transforms live in `phases/expand.ts`.

**Rule:** next peel candidates for `runtime.ts` — loop, tournament, map/parallel branches, approval — each into `runtime/phases/<kind>.ts` with a thin dispatch in `executePhaseInner`.

## Invariants

1. Kind emit must go through `register(ctx, draft)` so dependsOn/final/id stripping stay consistent.
2. Core must never import `taskflow-dsl`.
3. Dynamic expand uses `MAX_DYNAMIC_PHASES` from `schema.ts` (import it; do not re-define).
