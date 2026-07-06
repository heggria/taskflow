# Library: reusable flows & the search-before-author loop

taskflow saves flows you'll reuse into a **library** with metadata, so you can
`search` it before authoring a new flow — the **reuse flywheel**. The more you
save (with a good `purpose` + `tags`), the better future search gets.

> Full design: `docs/rfc-library-reuse.md`. This file is the agent-facing
> "when and how" guide.

<!-- host:pi -->
**Host binding (pi):** use the `taskflow` tool with `action: "search"` /
`action: "save"`, and `/tf list` / `/tf show <name>`.
<!-- /host:pi -->
<!-- host:codex,claude,opencode -->
**Host binding:** use the `taskflow_search`, `taskflow_save`, `taskflow_list`,
`taskflow_show` tools.
<!-- /host:codex,claude,opencode -->

## Before authoring a non-trivial flow: SEARCH first

Any time you're about to write a flow with ≥3 phases, fan-out, or a gate,
**search the library first**. It costs nothing and often finds a starter you
can adapt.

<!-- host:pi -->
```jsonc
{ "action": "search", "query": "audit API endpoints for missing auth", "limit": 5 }
```
<!-- /host:pi -->
<!-- host:codex,claude,opencode -->
```jsonc
{ "name": "taskflow_search", "arguments": { "query": "audit API endpoints for missing auth", "limit": 5 } }
```
<!-- /host:codex,claude,opencode -->

Read the results and the `→ reuseHint`:

| score | reuseHint | what to do |
|-------|-----------|------------|
| **≥ 0.8** | "直接复用" / direct reuse | Run by name (skip authoring). |
| **0.5 – 0.8** | "copy + 泛化" / copy & generalize | `show` it, copy, **generalize** (see checklist), save as a new version. |
| **< 0.5** or no matches | "从头编写" / write fresh | Author from scratch — then **save** it if reusable. |

`searchMode` tells you how the ranking was produced: `structural` (keyword +
phase-signature; no embedding backend configured), `semantic` (cosine over
embeddings), or `mixed` (some flows had vectors, some didn't). `structural` is
weaker on paraphrase — if it missed something obvious, try `structureOnly:
false` or a different phrasing.

## After a successful novel flow: SAVE it (if reusable)

When you finish a flow you expect to use again, save it **with a `purpose` and
2–4 `tags`**. These two fields are what search matches on — a flow saved
without them is nearly invisible to future search.

<!-- host:pi -->
```jsonc
{ "action": "save", "define": { "name": "audit-endpoints", "phases": [ ... ] },
  "purpose": "Audit a directory of API endpoints for missing auth checks",
  "tags": ["audit", "security", "auth", "fan-out"] }
```
<!-- /host:pi -->
<!-- host:codex,claude,opencode -->
```jsonc
{ "name": "taskflow_save",
  "arguments": { "name": "audit-endpoints", "definition": { "phases": [ ... ] },
    "purpose": "Audit a directory of API endpoints for missing auth checks",
    "tags": ["audit", "security", "auth", "fan-out"] } }
```
<!-- /host:codex,claude,opencode -->

`save` auto-derives structural metadata (phase signature, a `generality` score
in 0–1) and writes a sidecar `.meta.json` next to the flow file. You don't
compute any of that — just give `purpose` + `tags`.

## The generalization checklist (apply on every reuse)

When you copy + generalize a flow, make it **more reusable than the version you
found**. Each item raises the auto-derived `generality` score and broadens
future search recall:

- [ ] Hardcoded file/dir paths → `{args.X}` (with a `default`).
- [ ] Specific entity words ("endpoint", "route") → broaden in the discover
      prompt so the flow works for the whole class.
- [ ] Thresholds / counts → `{args.X}` with sensible defaults.
- [ ] Add `budget` / `retry` / `expect` if missing (production-grade knobs).
- [ ] Update `purpose` to reflect the wider scope.

Then save it back (version auto-bumps). Over time the library compounds: every
reuse leaves a more general flow behind.

## reuseCount & `reusedFromSearch`

Each saved flow has a `reuseCount`. It goes up by 1 **only when** a run was
chosen because of a prior search — set the `reusedFromSearch: true` flag on the
run. Direct run-by-name does **not** bump it (that's intentional: `reuseCount`
measures "found-via-search reuse", the high-quality signal for later auto-prune).

<!-- host:pi -->
```jsonc
// after search recommended "audit-endpoints", run it with the flag:
{ "action": "run", "name": "audit-endpoints", "args": { "dir": "src/api" }, "reusedFromSearch": true }
```
<!-- /host:pi -->
<!-- host:codex,claude,opencode -->
```jsonc
{ "name": "taskflow_run",
  "arguments": { "name": "audit-endpoints", "args": { "dir": "src/api" }, "reusedFromSearch": true } }
```
<!-- /host:codex,claude,opencode -->

## Judicious reuse — not every task needs the library

Skip search + save for:
- **One-off tasks** (a quick fix, a throwaway analysis) — `generality < 0.3`
  and obviously won't recur.
- **Trivial flows** (1–2 phases, no fan-out) — overhead isn't worth it.

The library pays off for *patterns* that recur across projects or sessions:
audits, migrations, reviews, fan-out summarization, plan→approve→execute, etc.

## Configuration (embedding backend — optional, Phase 2)

Search works with **zero config** (structural mode). For smarter paraphrase
recall, configure an embedding backend in `~/.pi/agent/settings.json`:

```jsonc
{ "taskflow": { "library": { "enabled": true, "scope": "both" },
  "embedder": { "kind": "http", "url": "http://127.0.0.1:8123/v1/embeddings", "model": "qwen3-embedding-0.6b" } } }
```

Without `embedder`, or if the embedder fails, search **degrades gracefully** to
structural mode — it never breaks. (See `docs/rfc-library-reuse.md` §4.)
