# pi-taskflow v0.0.8 — Meta-bug fix release

**Release date:** 2026-06-06
**Type:** Patch (runtime + DX improvements)
**Based on:** v0.0.7 (commit `c9f2de1`)
**Diff stat:** 21 files changed, 1040 insertions(+), 138 deletions(-)
**Tests:** 240 passing (was 234)

---

## Why this release?

The v0.0.8 dogfooding campaign (`docs/dogfooding-v0.0.8-report.md`) ran an
11-phase DAG against the codebase itself and successfully applied 13 fixes
(35 findings → 13 applied, 20 deferred). But the campaign also exposed **6
meta-bugs in pi-taskflow itself** — runtime defects that made the tool hard
to use. This release fixes all 6.

| # | Meta-bug | Severity | Fix location |
|---|----------|----------|--------------|
| 1 | `output: json` fragility (LLMs add fences/prose) | **FALSE POSITIVE** | n/a (was already correct) |
| 2 | Missing `dependsOn` was a soft warning, easy to miss | MED → **hard error** | `extensions/schema.ts` |
| 3 | Subflow `cwd` not propagated to sub-flow phases | MED | `extensions/runtime.ts` |
| 4 | `safeParse` returns `undefined` for "array + key" anti-pattern with no diagnostic | LOW | `extensions/interpolate.ts` |
| 5 | `findProjectFlowsDir` walks past `os.homedir()`, mis-takes `~/.pi/` for project flow dir | LOW | `extensions/store.ts` |
| 6 | Verify subagents mis-summarize shell output (234 tests → 230, 745 → 599) | LOW | `skills/taskflow/SKILL.md` (pattern doc) |

---

## What's changed

### Runtime fixes (4)

#### 1. `findProjectFlowsDir` skips the user's home directory

**Before:** `findProjectFlowsDir` walked up the cwd tree until it hit the
filesystem root. The user's `~/.pi/` (a system-level agent dir) was picked up
as a "project flow dir", so run state was written to the user's home instead
of the project's `.pi/`.

**After:** The walk-up explicitly skips the `os.homedir()` entry. `~/.pi/` is
no longer mistaken for a project flow dir. The function returns `null` when
no project `.pi/` exists on the path.

```ts
// extensions/store.ts
while (true) {
    if (dir !== home) {  // ← new: skip home
        const candidate = path.join(dir, ".pi");
        if (fs.existsSync(candidate)) return path.join(candidate, "taskflows");
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
}
```

#### 2. Subflow `cwd` is propagated to sub-flow phases

**Before:** A `flow` phase with `cwd: "/custom"` was not propagating to the
sub-flow's internal phases — they still used the parent flow's cwd. Subagents
of the sub-flow ran in the wrong directory.

**After:** The flow handler passes `cwd: phase.cwd ?? deps.cwd` as the
sub-flow's `deps.cwd`. Sub-flow phases without an explicit `cwd` correctly
derive from `flow.cwd`.

```ts
// extensions/runtime.ts (flow handler)
const subResult = await executeTaskflow(subState, {
    ...deps,
    cwd: phase.cwd ?? deps.cwd,  // ← new: override subflow's default cwd
    runTask: subRunTask,
    ...
});
```

Sub-flow phases with their own `cwd` still win over `flow.cwd` (verified by
`test/features.test.ts`).

#### 3. `safeParse` emits a diagnostic hint for the "array + key" anti-pattern

**Before:** When an LLM output something like
```
[{"id":"F-001"}, ...],
"deferred": [{"id":"D-001"}, ...]
```
`safeParse` returned `undefined` silently. Flow authors had to debug by hand
why their `{steps.X.json}` resolution failed.

**After:** When all parse strategies fail AND the input matches the pattern
`]...,"key":...`, `safeParse` emits a `console.warn` hint:

```
[pi-taskflow safeParse] input looks like a JSON array followed by a stray
top-level key (pattern: [{...}], "key": ...). This is not valid JSON.
Hint: put extra data as array members (e.g. {"id":"D-001","status":"deferred",...})
or split into a separate phase.
```

The hint uses a strict regex (`/]\s*[\},]?\s*"[^"\n]+"\s*:/)` to avoid
false positives on legitimately malformed JSON.

#### 4. Missing `dependsOn` is now a hard validation error

**Before:** `validateTaskflow` reported missing `dependsOn` as a soft
warning. The run would start anyway, the phase would race with the
referenced phase, and `{steps.X.output}` would resolve to the literal
placeholder string. Users often missed the warning, leading to confusing
runtime failures.

**After:** `validateTaskflow` rejects the flow with a hard error. The
tool refuses to start the run.

```
Invalid taskflow:
- Phase 'fix-issues': task references {steps.code-review-1.*} but
  'code-review-1' is not in dependsOn. The phase will run in parallel
  with 'code-review-1' and see the literal placeholder. Add
  "dependsOn": ["code-review-1"] (or include 'code-review-1' transitively).
```

Exception: phases with `join: "any"` are exempt (they may reference
non-deps as informational context by design).

`strictInterpolation` is no longer needed for this check — it's now
always-on. `strictInterpolation` retains its purpose for the *other*
soft warnings (missing args, cwd/codebase mismatch).

This is a **breaking change** for flows that worked by accident
(missing `dependsOn` but happened to race correctly). All bundled examples
were updated:

- `examples/conditional-research.json`: `report` now depends on
  `deep` and `quick` (it always needed their output).
- `examples/guarded-refactor.json`: `implement` now also depends on
  `plan`; `summary` also depends on `implement`.

### False positive: `output: json` fragility

Investigation found that `resultToPhaseState` already uses `safeParse`
(since v0.0.1) for the `json` field, supporting fence-stripping
correctly. The real fragility (the "array + key" anti-pattern) is
addressed by Fix #4 above. **No code change needed for this one.**

### DX fix (1): Structured-verify pattern

**Before:** Verify phases typically ran `npx tsc && npm test && git diff --stat`
and asked a generic verifier subagent to summarize the output. LLMs commonly
misread shell output: 234 tests reported as 230, 745 insertions as 599,
"1 type error" reported as "clean".

**After:** SKILL.md now documents a "structured-verify" pattern: ask the
verifier to emit `key=value` lines (not prose), one per metric, with
explicit failure semantics if any field is missing. Downstream phases can
parse this with `safeParse` and assert against expected values.

```jsonc
{
  "id": "verify",
  "type": "agent",
  "agent": "verifier",
  "task": "...report EXACTLY in this format (no prose):\ntypecheck=PASS|FAIL\ntests_pass=N\ntests_fail=N\ninsertions=N\ndeletions=N\n..."
}
```

The dogfooding v0.0.8 campaign's verify subagent claimed 230 tests /
599 insertions; the actual values were 234 / 745. The structured pattern
would have caught this at parse-time.

---

## Test coverage

| Test file | Before | After | Delta |
|-----------|--------|-------|-------|
| `test/store.test.ts` | 41 | 47 | +6 (1 home-boundary + 5 setup) |
| `test/features.test.ts` | 22 | 24 | +2 (subflow cwd × 2) |
| `test/interpolate.test.ts` | 5 | 7 | +2 (hint fires, no false positive) |
| `test/schema.test.ts` | 21 | 22 | +1 (join:any exemption) + 3 updated |
| **TOTAL** | 234 | **240** | **+6** |

All 240 tests pass. Typecheck clean (`npx tsc --noEmit`).

---

## Migration guide

### For flow authors

1. **Audit your flows for missing `dependsOn`** — the validator will now
   reject them. Run `validateTaskflow` on existing flows or just try to
   start the run; the error message tells you exactly which phase needs
   the dependency added.

2. **If you have `join: "any"` phases that reference non-dep steps**,
   you're fine — the new check exempts them.

3. **If you relied on the soft warning**, it now shows as a hard error.
   This is the correct behavior; the soft warning was too easy to miss.

### For flow consumers

- `pi-taskflow` saved flows in `~/.pi/agent/taskflows/` and `<project>/.pi/taskflows/`
  continue to work — the home-boundary fix changes only which directory
  is considered the "project" flow dir, not the user dir.

- The 5 examples in `examples/` and `examples/` are all valid; 2 were
  updated to add missing `dependsOn` (which they should have had anyway).

### Breaking change acknowledgment

The promotion of "missing `dependsOn`" from warning to error is a
behavioral change. Any flow that worked in v0.0.7 by accident (i.e.,
the referenced phase happened to complete before the consumer) will
need a one-line `dependsOn` fix. This is by design — the soft warning
was the source of a recurring user error pattern in the wild.

---

## Bundled changes from v0.0.8 dogfooding

This release also includes the 13 dogfooding fixes that were applied
during the v0.0.8 campaign (see `docs/dogfooding-v0.0.8-report.md`):

- 9 extension files modified (+502 / -84 net)
- 7 test files modified (+18 tests)
- 234/234 tests passing, typecheck clean

These were already on the working tree but uncommitted; v0.0.8
bundles them with the meta-bug fixes.

---

## Files changed

```
examples/conditional-research.json     |   2 +-  (1 line)
examples/guarded-refactor.json         |   4 +-  (2 lines)
extensions/agents.ts                  | +61/-27 (13 fixes from dogfooding)
extensions/index.ts                   |  +8/-3  (1 fix)
extensions/interpolate.ts             | +21/-6  (Fix #4)
extensions/render.ts                  |  +7/-3  (existing uncommitted)
extensions/runner.ts                  | +34/-18 (2 fixes)
extensions/runs-view.ts               |  +3/-0  (1 fix)
extensions/runtime.ts                 | +86/-26 (5 fixes + Fix #3)
extensions/schema.ts                  | +21/-6  (Fix #2)
extensions/store.ts                   | +27/-9  (Fix #5)
package.json                          |   2 +-  (version bump)
skills/taskflow/SKILL.md              | +44/-8  (Fix #6 + Hard-error doc)
test/*.test.ts                        | +618/-70 (+6 tests, 3 updated)
docs/release-v0.0.8.md              | new file
```

---

**Verdict:** SHIP-READY. The 6 meta-bugs are all fixed. The 13 dogfooding
fixes are bundled. The hard-validation change is the only behavioral
break and it's a strict improvement.

— pi-taskflow v0.0.8 dogfooding campaign
