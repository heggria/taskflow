# Modularization notes (0.2.0)

Avoid monolith growth while S4 lands and S5 preps. Prefer **extract-by-kind / extract-by-phase** over more branches in giant files.

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

## taskflow-core runtime (S5 strangler preheat)

```
packages/taskflow-core/src/runtime.ts   ← facade + orchestration still large; peels continue
packages/taskflow-core/src/runtime/phases/
├─ race.ts       ← executeRaceBranches
├─ expand.ts     ← pure helpers (mode, maxNodes, prefix, promote)
├─ script.ts     ← runScriptCommand + result → PhaseState
├─ parallel.ts   ← executeParallelBranches (inject runFanout + merge)
└─ approval.ts   ← approvalDecisionToPhaseState
```

| Kind | In `phases/` | Still in `runtime.ts` |
|------|--------------|------------------------|
| race | ✅ execute | thin dispatch + cache |
| expand | ✅ pure helpers | flow\|expand sub-run block |
| script | ✅ spawn + map | interpolate + cache |
| parallel | ✅ execute | branch resolve + cache |
| approval | ✅ decision map | message + requestApproval |
| map / loop / tournament / agent / gate / reduce / flow | ⬜ | full bodies |

**Rule:** next peels — `map`, `loop`, `tournament`, then agent/gate shared path. Each file takes injectables (`runOne`, `runFanout`, cache hooks); one-liner dispatch in `executePhaseInner`.

**S5 link:** kind modules make event-kernel handlers easier to add without editing a 3k-line unit. `race`/`expand` stay imperative until kernel step handlers exist.

## Invariants

1. Kind emit must go through `register(ctx, draft)` so dependsOn/final/id stripping stay consistent.
2. Core must never import `taskflow-dsl`.
3. Dynamic expand uses `MAX_DYNAMIC_PHASES` from `schema.ts` (import it; do not re-define).
4. Script timeouts and spawn errors remain uncached; non-zero exit remains cacheable.
