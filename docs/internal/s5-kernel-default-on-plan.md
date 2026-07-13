# S5 plan — event kernel default ON (differential strangler)

> Status: **PLAN** · 2026-07-09 · Branch `release/0.2.0`
> Parent: [`rfc-0.2.0-architecture.md`](../rfc-0.2.0-architecture.md) §9 S5
> Prerequisite: S0–S4 landed; claim ledger `claim-vs-impl-0.2.0.md`

## Goal

1. **Default execution path** = `exec/driver` (event kernel), not imperative `executePhaseInner`.
2. **Parity**: kernel outcomes match imperative for every admitted flow (status, finalOutput shape, gate/budget/when decisions).
3. **Safety**: advanced features still force imperative fallback until handlers exist.
4. **Flagship gate**: incremental recompute cost demo (Monday $6 → Tuesday ≤$0.40 narrative) measured or explicitly deferred with honest wording.

## Current baseline (do not regress)

| Fact | Location |
|------|----------|
| Kernel **opt-in** (`eventKernel` / `PI_TASKFLOW_EVENT_KERNEL=1`) | `exec/driver.ts` `eventKernelEnabled` |
| Kernel kinds = `PHASE_TYPES − {race, expand}` (10) | `exec/step.ts` `EVENT_KERNEL_PHASE_TYPES` |
| Fallback reasons (score, retry, expect, reflexion, cross-run cache, shareContext, onBlock:retry) | `exec/kernel-policy.ts` |
| Imperative path remains full 12 kinds | `runtime.ts` |
| Default OFF | env unset |

## Workstreams

### S5.0 — Differential harness (ship first)

- [ ] Golden suite: for each fixture under `test/fixtures/kernel-parity/` run **twice** (kernel on / off) with the same mock `runTask`.
- [ ] Assert: `status`, per-phase `status`/`output`/`gate`/`error` (normalize volatile fields: timestamps, runIds).
- [ ] Fixtures minimum set:
  - linear agent → gate → reduce
  - map + parallel
  - loop until
  - tournament best
  - script
  - flow{use} + flow{def} (dynamic empty + small plan)
  - when + join any
  - budget hit mid-map
- [ ] CI job: `pnpm run test:kernel-parity` fails the release if any fixture diverges.

### S5.1 — Close kernel feature gaps (priority order)

| Priority | Gap | Approach |
|----------|-----|----------|
| P0 | parity harness green on admitted set | S5.0 |
| P1 | `expect` contracts on agent/gate/reduce/loop | port contractCheck into step body |
| P1 | explicit `retry` | reuse runOne retry curve in step or shared helper |
| P2 | score gates | port scorers path or keep fallback (document) |
| P2 | reflexion loops | keep fallback until designed |
| P2 | cross-run cache in kernel | optional: call CacheStore from driver |
| P3 | shareContext | keep fallback (complex) |
| P3 | `race` / `expand` kernel handlers | new step kinds; or keep imperative forever |

**Policy:** S5 default ON only requires **parity on canUseEventKernel flows**. Flows that hit `kernelUnsupportedReason` stay on imperative **without** env flip required.

### S5.2 — Default flip

1. Change `eventKernelEnabled` default:
   - `undefined` → **true** (or env `PI_TASKFLOW_EVENT_KERNEL` default `"1"`).
   - Explicit `eventKernel: false` or env `0`/`false` keeps imperative.
2. Document migration: hosts that relied on imperative-only bugs must set `false`.
3. CHANGELOG: **breaking** if behavior differs; otherwise minor.

### S5.3 — Runtime strangler (enables safe flip)

Continue peel `runtime.ts` → `runtime/phases/*` so kernel step handlers and imperative share pure helpers:

| Kind | Imperative module | Kernel step |
|------|-------------------|-------------|
| race | ✅ `phases/race.ts` | optional later |
| expand helpers | ✅ `phases/expand.ts` | optional later |
| script / parallel / approval | ✅ peeled | share spawn/merge helpers |
| map / loop / tournament | ⬜ | extract before rewriting step |
| agent / gate / reduce | ⬜ shared body | de-dupe with step-kinds |

### S5.4 — Flagship cost demo (acceptance)

- [ ] Scripted flow (8 agent phases) + fingerprint change of one file.
- [ ] Measure: full run cost vs recompute cost ratio.
- [ ] Pass if recompute token/$ **strictly <** full (target narrative ≤ ~$0.40 vs ~$6 is aspirational — record real numbers).
- [ ] If infra cannot produce stable $ without live models: gate on **phase count re-executed** + cache hit counts only.

### S5.5 — Retirement (post-default)

- [ ] Mark imperative path as fallback-only in docs.
- [ ] No deletion of executePhase in same release as default flip.
- [ ] Next minor: reduce dual-path surface after 1 release of green parity.

## Non-goals (S5)

- Native multi-node FlowIR lowering (parallel → N IR nodes).
- Literal decompile round-trip.
- Host auto-build of `.tf.ts`.
- Experimental C-track runes.

## Exit criteria (S5 done)

1. Default ON in core; all host adapters inherit.
2. `test:kernel-parity` green in CI.
3. No known P0 divergence bugs open.
4. Flagship recompute metric recorded (or explicitly deferred with version note).
5. Docs/skills: “kernel default ON; race/expand + advanced features may still use imperative”.

## Suggested PR stack

1. **S5.0** parity harness + fixtures (no behavior change).
2. **S5.1-P1** expect + retry on kernel path.
3. **S5.3** map/loop peel (optional parallel).
4. **S5.2** default flip behind `PI_TASKFLOW_EVENT_KERNEL` still overridable.
5. **S5.4** demo script + numbers.
6. Docs/CHANGELOG/skills final.

## Risks

| Risk | Mitigation |
|------|------------|
| Silent behavior change on default flip | parity harness + canary env |
| Host runners ignore AbortSignal (race cancel) | already best-effort; document |
| Dual path drift after flip | single shared helpers in `phases/` + `step-kinds` |
| Cost demo unstable without live models | phase-count metric fallback |

## Immediate next coding step

Implement **S5.0** only: `packages/taskflow-core/test/kernel-parity/*.test.ts` + fixtures, no default flip.
