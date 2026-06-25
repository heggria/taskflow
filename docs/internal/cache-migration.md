# Cross-run Cache Key Migration

## Background

The cross-run memoization cache (`extensions/cache.ts`) keys each phase result by
a content-addressed `inputHash` folded from the flow name, the phase identity,
the resolved task, the model/thinking/tools config, the pre-read context, and an
optional world-state fingerprint.

Before H1, the cache key folded the flow **definition** fingerprint under a bare
`flowdef:` prefix (or, in the earliest pre-flowDefHash era, omitted it entirely).
H1 versions the key with a `v2:` prefix and routes the fingerprint through the
FlowIR compile seam (`compileTaskflowToIR` → `flowDefHash`).

M6 replaces the whole-flow `v2:flowdef:` tier with a **per-phase structural
sub-fingerprint** (`v3:phasefp:`): the hash of a single phase plus its
transitive dependency closure. Editing phase B now invalidates only B and its
transitive dependents — independent sibling phase A keeps its cache hit.

To avoid a one-time miss-storm on upgrade, the runtime consults **four** keys
on every cross-run lookup, read-only for the fallback tiers.

## Key shapes (M6)

`cacheKeys()` (`extensions/runtime.ts`) returns four keys for a phase:

| Tier | Shape | Written by | Status |
|------|-------|-----------|--------|
| `key` (current) | `flow:<name>` + `v3:phasefp:<subfp>` + `<phase>` + `think/tools/ctx` + fingerprint | M6+ | **read + write** |
| `v2Key` | `flow:<name>` + `v2:flowdef:<flowDefHash>` + … | H1..M5 | **read-only** |
| `bareKey` | `flow:<name>` + `flowdef:<hash>` (bare, unversioned) + … | pre-H1 | **read-only** (removed in v0.1.0) |
| `legacyKey` | `flow:<name>` + … (flowdef line omitted) | pre-flowDefHash era | **read-only** (removed in v0.1.0) |

### The per-phase sub-fingerprint (`v3:phasefp`)

`phaseFingerprint(def, phaseId)` (`extensions/flowir/phasefp.ts`) hashes the
phase itself plus its transitive `dependsOn ∪ from` closure, reusing the vendored
`canonicalJson` + `hashCanonical` (byte-identical to overstory's contract). The
`cache` policy field is stripped (its sub-fields reach the key via other paths);
every other `Phase` field is hashed.

**Soundness fallback.** Per-phase invalidation is only sound when a phase's real
dependencies are fully captured by the static closure. `phaseFingerprint` returns
`undefined` (→ the caller folds the whole-flow `flowDefHash` instead, preserving
pre-M6 behavior) when:

- the flow has `contextSharing: true`, OR
- any phase in the closure (self included) has `shareContext: true`, OR
- any phase in the closure (self included) has `type: "flow"`.

These are the cases where a phase can read sibling state outside its declared
deps (Shared Context Tree) or where sub-structure is resolved at runtime
(`flow`). Sub-flow inner phases always use this fallback (their `phaseFp` is
absent → `flowDefHash`), so editing one phase inside a sub-flow invalidates all
sub-flow phases — a known, safe conservatism.

### Lookup order (`cachedPhase`)

1. within-run resume (`cc.prior.inputHash === keys.key`) — fastest, always allowed.
2. `store.get(keys.key)` — current v3 entry.
3. `store.get(keys.v2Key)` — pre-M6 v2 entry.
4. `store.get(keys.bareKey)` — pre-H1 bare entry.
5. `store.get(keys.legacyKey)` — pre-flowDefHash entry.

A hit on **any** tier is restored as a `cacheHit: "cross-run"` result with zero
usage. The restored `PhaseState.inputHash` is always `keys.key` (the current
shape), so downstream phases and recompute see a consistent identity.

### Write policy (`recordCache`)

Only `keys.key` (the current v3 shape) is ever written. v2/bare/legacy hits are
**not** write-through: re-storing under the new key would double the cache size
for no benefit. Legacy/bare/v2 entries age out naturally via the 90-day hard cap
(`DEFAULT_MAX_AGE_MS`) and the LRU cap (`DEFAULT_MAX_ENTRIES`).

## Why four tiers?

- **`v3:phasefp:` (current):** the per-phase structural sub-fingerprint enables
  precise invalidation — editing one phase no longer evicts independent
  siblings. The versioned prefix lets a future genuine overstory compiler
  advance to `v4:flowIR:` with its own fallback tier, without disturbing v3.
- **`v2:flowdef:` (pre-M6):** M5-and-earlier code wrote this whole-flow shape.
  Without this tier, every existing cross-run entry would silently miss on the
  M6 upgrade — a one-time miss-storm for opt-in cross-run users.
- **bare `flowdef:` (pre-H1):** pre-H1 code wrote this shape. Retained for
  completeness.
- **no-flowdef (pre-flowDefHash):** the very earliest cross-run entries, before
  the flow definition was folded into the key at all. Retained for completeness;
  these are rare.

### Upgrade note (one-time cost)

On the first post-M6 run, if a sibling phase was edited between the last
pre-M6 run and the upgrade, an *unchanged* independent phase may re-execute
once: its v2 entry was keyed on the old `flowDefHash`, which no longer matches.
This is bounded (per-flow, one-time, only when a sibling edit happened) and
amortized over subsequent runs as v3 entries take over. For unchanged flows the
v2 tier hits and no re-execution occurs.

## Retirement

- **v0.1.0:** remove the `bareKey` and `legacyKey` tiers. By then all pre-H1
  entries will have aged out (90-day hard cap).
- **Later:** remove the `v2Key` tier once all pre-M6 entries have aged out.
- The `v3:` prefix is retained as the version anchor for the *next* migration.

## See also

- `extensions/flowir/hash.ts` — the vendored overstory hash algorithm.
- `extensions/flowir/phasefp.ts` — the per-phase structural sub-fingerprint.
- `extensions/flowir/index.ts` — `compileTaskflowToIR` (the seam that produces
  `hash` and `meta.declaredDeps`) and `phaseFingerprint`.
- `docs/internal/overstory-convergence-roadmap.md` §3 (M1).
- `test/cache-migration.test.ts` — the migration contract tests.
- `test/cache-phasefp.test.ts` — the per-phase sub-fingerprint contract tests.
