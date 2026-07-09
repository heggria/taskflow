# Modularization plan — avoid monoliths (0.2.0)

> Status: **in progress** · 2026-07-09  
> Principle: **low coupling, high cohesion** — one module, one job; new kinds land as plugins, not edits in a 3k-line file.

## Why

| Hotspot | Lines (approx) | Problem |
|---------|----------------|---------|
| `taskflow-core/src/runtime.ts` | ~3500 | All phase kinds + cache + spawn + layers in one unit |
| `taskflow-dsl/src/build/erase.ts` (was) | ~1200 | All rune emitters + templates + AST helpers |
| `schema.ts` / `store.ts` / `pi-taskflow/index.ts` | 1k–2k | Secondary; same pattern |

Adding `race` / `expand` by pasting into `runtime.ts` is exactly the anti-pattern we reject.

## Target shapes

### taskflow-dsl build (S4) — **done this PR**

```
src/build/
  erase/
    index.ts        # public: eraseSource
    types.ts        # PhaseDraft, EraseSession, PHASE_RUNES
    ast.ts          # calleeName, evalLiteral, diag  (no phase knowledge)
    templates.ts    # string/template → placeholders + deps
    opts.ts         # mergeOpts, registerDraft
    pipeline.ts     # flow() discovery + body walk + kind dispatch
  build.ts          # validate + FlowIR (depends on erase, not TS AST)
  erase.ts          # thin re-export for stable import path
```

**Rules**

- `ast.ts` must not import phase/kind logic.
- Kind-specific emit stays in `pipeline.ts` for now; next cut: `erase/kinds/*.ts` with a registry.
- `build.ts` never grows AST knowledge.

### taskflow-core runtime — **strangler**

```
src/runtime.ts              # facade: executeTaskflow, re-exports  (shrink over time)
src/runtime/
  types.ts                  # RuntimeDeps, RuntimeResult (extract later)
  phase-cache.ts            # cacheKeys, recordCache (extract later)
  layers.ts                 # runTaskflowLayers (extract later)
  phases/
    race.ts                 # ✅ executeRaceBranches (Horizon B)
    expand.ts               # next: peel flow/expand from executePhaseInner
    parallel.ts             # next
    map.ts                  # next
    …
```

**Rules for new phase kinds**

1. **New file under `runtime/phases/<kind>.ts`** (or shared helper) — no new 200-line blocks in `runtime.ts`.
2. Pure-ish API: inputs = phase + resolved branches/tasks + injectables (`runOne`, cache hooks).
3. Wire from `executePhaseInner` with a **one-liner** `if (type === "x") return await executeX(...)`.
4. Event kernel: either a matching `exec/step-kinds` handler **or** exclude from `EVENT_KERNEL_PHASE_TYPES` until then (race/expand already excluded).

### schema / FlowIR

- `PHASE_TYPES` remains the **single registry** of kind strings.
- FlowIR kinds follow automatically via `StringEnum(PHASE_TYPES)`.
- Validation per kind stays in `validateTaskflow` for now; optional later: `schema/kinds/<k>.ts` validators composed into one.

## Dependency direction (must stay acyclic)

```
taskflow-dsl ──▶ taskflow-core (schema, validate, FlowIR only)
                      │
                      ├─ runtime/phases/*  ──▶  schema, interpolate, usage, runner-core
                      ├─ exec/*            ──▶  schema, interpolate  (no runtime.ts import)
                      └─ flowir/*          ──▶  schema
```

`exec/*` must **never** import `runtime.ts` (already true; keep it).

## Migration checklist

| Step | Status |
|------|--------|
| Split DSL erase into `build/erase/*` | ✅ |
| Extract `race` phase module | ✅ |
| Extract `expand`/`flow` promote helpers | next |
| Extract map/parallel/gate from `executePhaseInner` | next |
| Split `schema` validators by kind | later |
| Split `pi-taskflow/src/index.ts` by command surface | later |

## PR policy

- Prefer **extract + rewire** over “rewrite while feature-adding”.
- Each extract PR: green unit suite for that kind; no behavior change expected (diff only structure).
- Feature PRs for new kinds: **must** add `runtime/phases/<kind>.ts` (or explicit exception in the PR body).

---

*One-liner: grow the system by adding modules, not by lengthening monoliths.*
