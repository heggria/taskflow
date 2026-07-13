# RFC: FlowIR Compilation Shadow (DSL → overstory FlowIR)

> Status: **Superseded in part by 0.2.0 S0** · Original: **Proposed** · Date: 2026-06-24
> Roadmap: [`overstory-convergence-roadmap.md`](./overstory-convergence-roadmap.md) §3 M1
> **Implementation note (2026-07-09):** The *shadow* / vendor-overstory plan below is **historical**.
> 0.2.0 S0 shipped a **self-owned** genuine compiler in `packages/taskflow-core/src/flowir/`:
> `compileTaskflowToFlowIR` + `hashFlowIR` → `ir:<64-hex>`, `usedFallbackHash: false` on well-formed IR.
> Public seam remains `compileTaskflowToIR(def)`. Stub `translate.ts` still exists for comparison /
> legacy paths but is **not** what `/tf ir` content-addresses after S0.
> Architecture parent: [`../rfc-0.2.0-architecture.md`](../rfc-0.2.0-architecture.md).
> Verifies (original intent): overstory IR contract; bridges to schema/compile/verify.

## TL;DR

Compile pi-taskflow's DSL into overstory's genuine `FlowIR` — **without touching any
execution path**. Add a read-only `/tf ir <flow>` command that emits the compiled IR,
a content-addressed `flowIRHash`, and structured `CompileError[]`. Vendor overstory's
pure compiler (it is `private: true`, unpublished) so the contract is **byte-level
identical** to overstory core. **Zero changes to `runtime.executePhase`, `cacheKey`,
`interpolate`, the 9 phase branches, `validateTaskflow`, or `verify`.** ~7 new files
under `extensions/flowir/` + one subcommand.

This is milestone **M1** of the convergence roadmap. It establishes the contract seam
that observed-readSet (M3) and minimal-recomputation (M5) structurally require.

## 1. Motivation

pi-taskflow's `{steps.ID.output}` implicit-interpolation model **is** overstory's
`inject`/`emits` context model — it is just *unnamed*. overstory VISION §2.1 argues
"compile, don't interpret": what can be known at compile time must not be guessed at
runtime. Today pi-taskflow compiles only to a Mermaid picture + a structural-verify
report; the **executable** IR (dependency edges, context edges, budget plan, cache-key
plan) does not exist as a first-class artifact.

Establishing that artifact now, identically to overstory core, does three things:

1. **A cross-run content-addressed key** (`flowIRHash`) — the prerequisite for M2's
   "identical re-run is free" cache behavior.
2. **LLM-consumable structured errors** — a model generating a flow can self-correct
   from `CompileError[]` instead of a thrown string.
3. **Named synthesized `inject`/`emits`** — so the observed readSet (M3) has something
   to be *named against*.

**Hard constraint:** zero behavior change for any flow that compiles and runs today.
The IR is a shadow, not the execution path — yet.

## 2. The one open decision: vendor, not import

overstory's monorepo `package.json` is `private: true` and the `overstory` package is
`0.1.0-dev.0`, unpublished. pi-taskflow ships as a zero-runtime-dependency pi-package.
Therefore M1 **vendors** overstory's pure compiler modules rather than depending on
them. Each vendored file becomes a one-line `import` swap the day overstory publishes.

**Vendored (pure, stable contracts):**
- `overstory/packages/core/src/ir/{compile,cond,hash,schema}.ts`
- `overstory/packages/core/src/result/` (the `Result`/`Err` value type — failures are values)
- `overstory/packages/core/src/identity/` (4 validation helpers)

**Sync guard:** `scripts/sync-flowir.mjs --check` pins to a specific overstory commit
and fails CI if a vendored file drifts. A **byte-parity test** (§6) is the hard
contract: pi-taskflow's `hashIR` output must equal overstory core's for pinned fixtures.

## 3. New module layout

```
extensions/flowir/
├── contract.ts    # re-export of vendored FlowIR types (the stable surface)
├── identity.ts    # vendored identity/validation helpers
├── result.ts      # vendored Result type (failures are values, not exceptions)
├── compile.ts     # vendored overstory compiler (compileFlow / hashIR)
├── translate.ts   # ★ the ONLY new logic: Taskflow DSL → FlowIR
├── meta.ts        # TaskflowIRMeta, DeclaredDeps, sidecar types
└── index.ts       # public entry: compileTaskflowToIR(flow) → TaskflowIR
```

**The compile layer never throws into the runtime.** It returns `TaskflowIR` with an
`errors: CompileError[]` field; the runtime treats a non-empty `errors` (or
`usedFallbackHash`) as advisory only — the flow still compiles-and-runs byte-identically
to today.

## 4. The translate bridge (`translate.ts`) — 5 steps

`taskflowToFlow(flow: Taskflow): TaskflowIR` performs:

1. **Lift args/budget/concurrency** — copy flow-level scalars into the IR envelope.
2. **9→6 kind lowering (1:1 projection).** overstory's IR has 6 node kinds; pi-taskflow
   has 9 phase types. **M1 uses a 1:1 projection**: each phase becomes one IR node,
   preserving its pi-taskflow `type` in a sidecar. `lowerToOverstoryNative` (parallel→N
   siblings / tournament→map+gate / reduce→one-node-injects-many) is **defined but not
   called** — it is deliberately staged for the post-M5 kernel swap (see roadmap §6.1).
3. **`inject` synthesis** — reuse the existing `schema.ts:collectRefs` (extend it to
   scan `over`/`when`/`context`/`with`/`branches` too). Each `{steps.X…}` /
   `{args.X}` / `{item…}` reference becomes a declared `inject` edge. `emits = [id]`
   (a phase emits its own id).
4. **Condition rewrite** — translate pi-taskflow's `when` into overstory's condition IR
   where possible (`{steps.X.json.f} == v` → `cmp(ctx.X.f, "v")`). Unsupported syntax
   (e.g. `contains`) **degrades gracefully**: the raw `when` is moved to a sidecar,
   `node.when = undefined` in the IR, and `usedFallbackHash: true` is set. The hash
   then falls back to hashing the Taskflow itself (still deterministic; just not
   IR-canonical).
5. **Sidecar extraction** — every field the IR does not carry (pi-taskflow-specific:
   `retry`, `shareContext`, `cwd` keywords, `cache`, `optional`, raw `task` text, …)
   is lifted into `TaskflowIRMeta.sidecar` so the DSL is **fully reconstructable** from
   the IR + sidecar (round-trip property, §6).

## 5. Types

```ts
export interface TaskflowIR {
  ir?: FlowIR;                 // present unless translation hard-failed
  meta: TaskflowIRMeta;        // sidecar + declared deps + provenance
  hash?: string;               // flowIRHash (IR-canonical), or fallback hash
  warnings: CompileWarning[];
  errors: CompileError[];      // LLM-consumable; never thrown
  usedFallbackHash: boolean;   // true when raw-when/sidecar forced a fallback hash
}

export interface DeclaredDeps {
  reads: string[];   // synthesized inject keys (from collectRefs)
  writes: string[];  // emits = [nodeId]
}
```

overstory is **stricter** than pi-taskflow (no `contains`, no `join: "any"` exemption).
A flow that pi-taskflow accepts may therefore produce `CompileError[]` from the
vendored compiler. **That is advisory, not fatal**: `compileTaskflowToIR` falls back to
`usedFallbackHash` and the flow still runs exactly as before. M3 makes the observed
plane authoritative; until then declared is advisory.

## 6. Test plan

| # | Test | What it locks |
|---|---|---|
| 1 | **Determinism property** (fast-check, ~1000 cases) | identical flow incl. whitespace/key-reorder ⟹ identical `flowIRHash` |
| 2 | **Hash sensitivity property** | single-field mutation ⟹ hash changes |
| 3 | **9-kind synthesis correctness** | each phase type ⟹ correct IR node + inject/emits |
| 4 | **Structural-equivalence canary** | synthesized data-edges ≡ the DAG implied by `dependenciesOf`/`topoLayers` |
| 5 | **Byte-parity** (★ hard contract) | pin 3 fixtures; pi-taskflow's `hashIR` == overstory core's `hashIR` byte-for-byte. **This is the proof the seam is real.** |
| 6 | Condition rewrite (both tiers) | supported `when` ⟹ IR condition; unsupported ⟹ sidecar + `usedFallbackHash` |
| 7 | Structured errors | malformed flow ⟹ `CompileError[]`, no throw |
| 8 | Advisory non-fatality | a `CompileError`-bearing flow still compiles+runs byte-identically to pre-M1 |
| 9 | Sidecar round-trip | `Taskflow` → IR+sidecar → reconstruct ≡ original (modulo IR-canonical normalization) |

Plus: `test/e2e-flowir.mts` (`/tf ir` on each `examples/*.json` ⟹ stable hash + correct
synthesized edges + structured diagnostics on a deliberately-broken flow), and a
vendored-sync mutation guard (mutate a vendored file ⟹ `sync-flowir.mjs --check` fails).

**Existing suite stays zero-diff** — M1 adds `test/flowir.test.ts` only; no existing
test file is edited (verified: M1 touches none of the 9 phase branches).

## 7. Integration touchpoints

- **New:** `/tf ir <flow>` subcommand (mirror the existing `/tf compile <name>` shape),
  and `action: "compile"` is **not** reused — `ir` is its own action/command family.
- **Untouched (M1):** `runtime.executePhase`, `cacheKey`, `interpolate`,
  `validateTaskflow`, `verify`, all 9 phase branches, `RunState` schema (hash lands in
  M2, not M1).

This is why M1 is `fit-10`: the blast radius is "one new read-only command + a new
folder that nothing imports yet."

## 8. Migration risks

| Risk | Mitigation |
|---|---|
| overstory compiler stricter ⟹ false `CompileError` on valid flows | advisory + `usedFallbackHash` fallback; never blocks; byte-identical run |
| Vendored drift (overstory `0.1.0-dev.0` churns) | pin commit + `sync-flowir.mjs --check` in CI + byte-parity test |
| Synthesized readSet ≠ actual interpolation reads | M3 observed plane is authoritative; declared is advisory discrepancies (report, never block) until then |
| 1:1 lowering ≠ future native lowering | documented as deliberate staging (`lowerToOverstoryNative` defined-not-called) |
| Strict TS (`noUnusedLocals`, `verbatimModuleSyntax`) on vendored code | vendor verbatim + `import type` for type-only |

## 9. Acceptance criteria

- [ ] `npm run typecheck` exit 0.
- [ ] `npm test`: existing 702 tests **green, zero diff** + new `test/flowir.test.ts`
      green (incl. property #1/#2 + byte-parity #5).
- [ ] All `test:e2e*.mts` green; new `e2e-flowir.mts` green.
- [ ] `pi /tf ir <each examples/*.json>` ⟹ stable hash + correct synthesized edges +
      structured diagnostics on a deliberately-broken flow.
- [ ] `node scripts/sync-flowir.mjs --check` green.

## 10. What M1 does **not** claim

M1 delivers **none** of VISION §4's three headline numbers (token savings, kill-9
recovery, incremental-recompute ratio). Its native validation is `flowIRHash`
determinism + byte-parity — the proof the compilation layer is a real seam, not a
shell. The three numbers are owned by M3 (kill-9 + readSet soundness) and M5
(recompute ratio + token savings); see roadmap §5.

---

*Next action (after the vendor-now decision in roadmap §8): vendor the 6 pure files,
write `translate.ts`, add `/tf ir`, wire byte-parity. Estimated ~7 files, no execution-path edit.*
