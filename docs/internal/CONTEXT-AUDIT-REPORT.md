# `context` Feature Audit Report

Date: 2026-06-05
Resolved: 2026-06-08
Scope: `resolvePhaseContext` → `executePhase` integration in runtime.ts, schema, and tests.
Status: **✅ Resolved** — 2 critical + 4 medium + 3 low all addressed. See resolution notes at end.

---

## Critical Bugs (silent data loss)

### #1 — `parallel` phase drops `preRead`

`runtime.ts:490` computes `fullTask = preRead + r.text` for tracing, but returns `task: r.text` (without `preRead`). The subagent never sees the context content.

### #2 — `map` phase drops `preRead`

`runtime.ts:534` — identical pattern: returns `task: r.text` without `preRead`. The subagent receives only the loop-body task with no injected context.

**Both are uncaught:** the trace log shows `fullTask` (leading users to believe context is being injected), and no test exercises `context` on a `parallel` or `map` phase.

**Fix:** `task: preRead + r.text` in both branch/task return sites, plus `preRead` inclusion in `hashInput`.

---

## Medium Issues

### #3 — Cache invalidation broken for `parallel`/`map`

`hashInput` at lines 496 and 540 hashes `JSON.stringify(branches)` / `JSON.stringify(tasks)` where each entry's `task` is `r.text` (no `preRead`). If context files change, `agent` phases invalidate correctly (line 470 hashes `fullTask`), but `parallel`/`map` phases serve stale cached results.

**Fix:** include `preRead` or `fullTask` in the hash input for these phase types.

### #4 — No total aggregate cap on context size

Per-file capped at `contextLimit` (default 8,000 chars), but **total is unbounded**. If `{steps.scout.json}` resolves to 5,000 file paths: 5,000 × 8,000 = 40 MB in `preRead` alone — likely OOM or blown context window. No `maxContextFiles` or `maxTotalContextChars` guard exists.

**Fix:** add `MAX_TOTAL_CONTEXT_CHARS` (suggested 200,000) and truncate the joined `blocks` array when exceeded.

### #5 — Glob support claimed but not implemented

Schema (`schema.ts:108-109`) description: *"File paths, **globs**, or {steps.X} refs"*. `resolvePhaseContext` (`runtime.ts:263-308`) calls `fs.statSync(abs)` on each literal path — no glob expansion. `"src/**/*.ts"` silently matches nothing.

**Fix:** either implement glob expansion (e.g. `node:fs.glob`) or correct the schema description.

### #6 — Sequential synchronous I/O blocks event loop

`resolvePhaseContext` iterates with `for (const p of unique)` doing `fs.statSync` + `fs.readFileSync` — blocks the event loop for the full duration. For 100 files, 200 serial syscalls.

**Fix:** use `fs.promises` with a concurrency limiter (`Promise.all` + batch).

---

## Low Issues

### #7 — `trace` is diagnostically misleading for `parallel`

Line 485 traces `fullTask` (includes `preRead`), but line 490 sends `r.text` (no `preRead`). The PhaseState debug info shows context content the model never received.

### #8 — `flow` phase ignores `context` entirely

Line 615: `hashInput(...)` and sub-flow invocation both exclude `preRead`. Context on a `flow` phase is silently discarded.

### #9 — `catch {}` swallows all file-read errors

`runtime.ts:303` — `catch {}` with no warning. Combined with #5 (no glob support), a user who passes glob patterns gets zero feedback about missing files.

### #10 — Empty-string context entries cause wasted CWD stat

`context: [""]` → `path.resolve("")` = `process.cwd()` → `isFile()` returns false. Harmless but wasteful.

### #11 — `approval` hashes `preRead` but never displays it

Line 555 hashes `preRead + message`, line 571 sends only `message` to `requestApproval`. Causing cache misses without observable benefit.

---

## Test Gaps

| Gap | Would catch |
|-----|-------------|
| No `context` test for `parallel` | Bug #1 |
| No `context` test for `map` | Bug #2 |
| No `context` test for `flow` / `approval` | Bugs #8, #11 |
| No test for `contextLimit` truncation | Untested path |
| No test for files > `CONTEXT_MAX_FILE_BYTES` (10 MB) | Silent-skip path |
| No test for `strictInterpolation` + unresolvable context refs | Unknown behavior |
| All existing context tests use `type: "agent"` | Misses all other phase types |

---

## Design Observations

- **Deduplication** (`new Set(paths)`) and **per-file truncation** work correctly.
- **Interpolated array refs** are properly expanded (`safeParse` → `Array.isArray` → filter strings).
- **No path sanitization** — `"/etc/passwd"` or `"../../.env"` are read without sandbox checks. Not a new attack surface (subagent already has filesystem access), but a prompt-injection vector if upstream phase output controls context entries.
- **Race condition** — snapshot taken at context-resolution time; file changes between pre-read and execution are inherently stale. Subagent still has filesystem access as a workaround.

---

## Recommendation

**Revise** — Bugs #1 and #2 are functional regressions that silently drop user-declared context. Fix before merging:

1. `task: r.text` → `task: preRead + r.text` at line 490 (`parallel`) and line 534 (`map`)
2. Include `preRead` in `hashInput` at lines 496 and 540
3. Add `MAX_TOTAL_CONTEXT_CHARS` (post-join truncation of `blocks`)
4. Correct schema description to remove "globs" or implement glob expansion
5. Add dedicated tests for `context` on `parallel`, `map`, and `flow` phases
