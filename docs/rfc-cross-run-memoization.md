# RFC: Cross-Run Memoization for pi-taskflow

> Status: **Implemented** (v0.0.13-dev) · Author: maintainer + agent · Date: 2026-06-08
> Companion: [`STRATEGY.md`](./STRATEGY.md) (white-space #2). Supersedes the
> "graph-position caching" idea, which this RFC shows is already covered by the
> existing `id`+content `inputHash` and is therefore *not* implemented.

## 0. TL;DR

pi-taskflow already content-addresses each phase by `hashInput(phase.id, model, <resolved inputs>)`
and reuses results **within a single run's resume**. This RFC extends that reuse
to a **persistent, cross-run cache**: if any prior run computed a phase with an
identical input hash, reuse its result for $0.00 — *but only when the author has
explicitly opted that phase into cross-run scope, and only when a set of
deterministic freshness guards all pass.*

The hard problem is **freshness/real-time correctness**: never serve a stale
result for a phase whose real-world inputs changed. We solve it with four gates,
and we are honest about the one thing we cannot guarantee (undeclared implicit
inputs read by a subagent mid-execution).

## 1. Motivation

- **No competitor has this.** Temporal replays skip re-execution *within a run*;
  LangGraph memoizes *within a session*. None cache phase results across
  independent runs by content hash (see `COMPETITORS.md`).
- **It's half-built.** We already have a deterministic, content-addressed
  `inputHash` per phase. The only missing piece is widening the lookup from
  "this run's `prior`" to "a global store".
- **Concrete payoff.** Run the same research/review workflow over 10 topics; the
  identical setup/boilerplate phases compute once and hit cache 9×.

## 2. Non-goals

- Caching phases with undeclared, unknowable inputs (network, clock, ambient
  files a subagent reads without declaring). These stay `run-only` by default.
- Caching `gate` / `approval` phases across runs (semantically wrong — a fresh
  verdict/human decision must be produced each run). **Hard-blocked.**
- Distributed / multi-machine cache. Local filesystem only (consistent with the
  zero-dependency, local-first design).

## 3. Where freshness can break (the core analysis)

| # | Failure source | Example | Covered by current `inputHash`? |
|---|----------------|---------|:-------------------------------:|
| 1 | **Declared input changed** | prompt text edited; an item in `over` changed; a file listed in `context` changed (it's pre-read into the task → into the hash) | ✅ yes — already in the hash |
| 2 | **Implicit upstream changed** | phase's subagent reads/greps a file *not* declared in `context`; that file changes | ❌ no |
| 3 | **External/time-varying source** | "latest npm version", "today's weather", `git HEAD` moved | ❌ no |

Source #1 is already correct today. This RFC must make #2 and #3 *safe* — not
necessarily *cached*, but never *stale*.

## 4. Design

### 4.1 New optional `cache` field on a phase

```jsonc
{
  "id": "analyze-auth",
  "type": "agent",
  "task": "Summarize how the auth module works.\n\n{steps.scout.json}",
  "context": ["src/auth/**/*.ts"],
  "cache": {
    "scope": "cross-run",                 // "run-only" (default) | "cross-run" | "off"
    "ttl": "6h",                          // optional max age; omit = no time bound
    "fingerprint": [                       // optional extra freshness inputs
      "git:HEAD",
      "glob:src/auth/**/*.ts",
      "file:package.json",
      "env:NODE_ENV"
    ]
  }
}
```

Schema (added to `PhaseSchema` in `schema.ts`):

```ts
const CacheSchema = Type.Object(
  {
    scope: Type.Optional(StringEnum(["run-only", "cross-run", "off"],
      { description: "Cache reuse scope (default: run-only = current behavior)", default: "run-only" })),
    ttl: Type.Optional(Type.String({ description: "Max cache age, e.g. '30m','6h','7d'. Omit = unbounded." })),
    fingerprint: Type.Optional(Type.Array(Type.String(),
      { description: "Extra freshness inputs hashed into the key: git:HEAD | glob:<pattern> | file:<path> | env:<NAME>" })),
  },
  { additionalProperties: false },
);
// in PhaseSchema:
cache: Type.Optional(CacheSchema),
```

### 4.2 Freshness gates (in priority order)

**Gate A — Default safe.** `scope` defaults to `"run-only"`, which is *exactly
today's behavior*. No phase becomes cross-run unless the author opts in. Zero
behavioral change for every existing flow. `"off"` disables reuse entirely
(even within-run) for debugging.

**Gate B — Hard-blocked phase types.** For `gate` and `approval` phases, a
declared `scope: "cross-run"` is rejected at validation time (`validateTaskflow`)
with a clear error. They may use `run-only` only.

**Gate C — Fingerprint encodes the world into the key.** When `fingerprint` is
present, each entry is resolved to a current value and folded into the hash, so
"the world changed" ⇒ "the key changed" ⇒ cache miss. All resolvers are
deterministic and zero-dependency:

| Prefix | Resolver | Determinism |
|--------|----------|-------------|
| `git:HEAD` | `git rev-parse HEAD` (cwd) | commit sha; empty string if not a git repo |
| `glob:<pat>` | sorted list of matched paths + each file's `size:mtimeMs`, hashed | filesystem mtime/size digest |
| `file:<path>` | sha256 of file contents (capped at existing `CONTEXT_MAX_FILE_BYTES`) | content hash |
| `env:<NAME>` | `process.env[NAME] ?? ""` | exact value |

Unknown prefix ⇒ validation error (fail closed, never silently ignored).

**Gate D — TTL.** Cache entries store `createdAt`. On lookup, if
`now - createdAt > ttl`, treat as miss. For inherently time-varying phases the
author sets a short TTL (or simply leaves `run-only`).

### 4.3 The cross-run cache store

Reuse the existing path conventions and the existing file-lock + atomic-write
helpers (no new dependencies):

```
.pi/taskflows/cache/<key>.json          # one file per memoized phase result
.pi/taskflows/cache/index.json          # {key -> {createdAt, runId, phaseId, bytes}} for TTL/LRU cleanup
```

Entry shape (a trimmed `PhaseState` — never store transcripts, only the result
surface that downstream phases consume):

```ts
interface CacheEntry {
  key: string;
  createdAt: number;
  output?: string;
  json?: unknown;
  model?: string;
  // usage intentionally re-zeroed on hit so budget reports $0.00 for cache hits
}
```

Cleanup piggybacks on the existing opportunistic-cleanup throttle
(`CLEANUP_INTERVAL_MS`): drop entries past TTL and enforce a max count/age
(`DEFAULT_MAX_*` equivalents) via the same LRU approach already used for runs.

### 4.4 Key computation

Today (unchanged for `run-only`):

```ts
const inputHash = hashInput(phase.id, phase.model ?? "", <resolved inputs>);
```

New, when `scope === "cross-run"`:

```ts
const fp = await resolveFingerprint(phase.cache?.fingerprint, cwd); // "" if none
const inputHash = hashInput(phase.id, phase.model ?? "", <resolved inputs>, fp);
```

Note `phase.id` stays in the key, so two phases can never collide — this is the
"graph-position" concern, already handled. (We deliberately keep `phase.id` in
the key rather than a structural graph position, because content+id is strictly
stronger and simpler.)

### 4.5 `cachedPhase` lookup change

```ts
function cachedPhase(
  prior: PhaseState | undefined,
  inputHash: string,
  opts: { scope: "run-only" | "cross-run" | "off"; ttl?: number; store: CacheStore },
): PhaseState | null {
  if (opts.scope === "off") return null;

  // 1. within-run (existing, fastest, always allowed unless off)
  if (prior && prior.status === "done" && prior.inputHash === inputHash) {
    return { ...prior, status: "done" };
  }

  // 2. cross-run (new, opt-in)
  if (opts.scope === "cross-run") {
    const e = opts.store.get(inputHash);
    if (e && (!opts.ttl || Date.now() - e.createdAt <= opts.ttl)) {
      return {
        id: e.phaseId, status: "done", inputHash,
        output: e.output, json: e.json, model: e.model,
        usage: emptyUsage(),            // $0.00 on hit
        cacheHit: "cross-run",          // for live render + observability
        endedAt: Date.now(),
      };
    }
  }
  return null;
}
```

On a successful **fresh compute** of a `cross-run` phase, write the trimmed entry
to the store (atomic write + index update, under the existing lock).

### 4.6 Observability (Gate D's companion)

- Live render shows `CACHED (cross-run · age 6m)` vs the existing within-run
  `CACHED`, so the author always sees *what* was reused and *how old* it is.
- A `cacheHit` field on `PhaseState` records `"run" | "cross-run" | null`.
- Escapes: `cache: false` per run (force recompute all), `scope: "off"` per
  phase, and a `cache clear` maintenance action.

## 5. Honest limits (state these in docs)

- **Undeclared implicit inputs cannot be auto-detected.** If a subagent reads a
  file it didn't declare in `context` or via `fingerprint`, and that file
  changes, a `cross-run` hit *can* be stale. Mitigation is **policy, not
  magic**: `run-only` default, opt-in only for phases whose output is a function
  of declared inputs, `fingerprint` for known implicit deps, TTL as a backstop.
- This is precisely why imperative frameworks (Claude, LangGraph) don't offer
  cross-run memoization: their input set is unknowable. Our **declarative +
  explicit `context` pre-read** model is what makes a *safe* version possible —
  but only for the declared-input subset. We must not oversell it.

## 6. Rollout

1. **Schema + validation** (S): add `CacheSchema`; block `cross-run` on
   `gate`/`approval`; validate fingerprint prefixes. Default `run-only` ⇒ no
   behavior change. Tests: schema accept/reject, hard-block errors.
2. **Fingerprint resolver** (S): `git:`/`glob:`/`file:`/`env:` resolvers, pure +
   deterministic. Tests: each resolver, unknown-prefix rejection, non-git repo.
3. **Cache store** (M): `CacheStore` over existing lock/atomic-write/cleanup;
   `cache/` dir + index; TTL + LRU cleanup. Tests: put/get, TTL expiry, eviction,
   concurrent write race (reuse the 8-process lock regression harness).
4. **Wire `cachedPhase`** (S): thread `scope/ttl/store`; write-on-fresh-compute;
   `cacheHit` + `usage=0`. Tests: cross-run hit, TTL miss, fingerprint-change
   miss, `off`, `cache:false`.
5. **Render + docs** (S): `CACHED (cross-run · age)`; README + this RFC's limits
   section.

## 7. Open decisions

1. **TTL default for `cross-run` with no `ttl`** — unbounded (rely on
   fingerprint/content) vs. a safe default like 7d? *Proposed: unbounded; force
   the author to think about freshness via fingerprint, with cleanup-cap as the
   only implicit bound.*
2. **Per-user vs shared cache** — cross-run cache lives under project
   `.pi/taskflows/cache/`. If committed/shared, a poisoned entry propagates.
   *Proposed: gitignore the cache dir by default; sharing is explicit opt-in
   with a `creator` field for audit.*
3. **`glob:` mtime vs content hash** — mtime is cheap but can miss content-
   preserving touches and false-positive on no-op rewrites; content hash is
   correct but costs IO. *Proposed: size+mtime digest by default; allow
   `glob!:<pat>` for content-hash mode when correctness matters.*
4. **Should `flow` (sub-flow) phases be cross-run cacheable?** Their result is a
   sub-run; caching it means caching a whole nested pipeline. *Proposed: allow,
   but the sub-flow's own phases also honor their own `cache` scopes; the outer
   `flow` hit short-circuits the nested run entirely.*
