# Merged Verdict — v0.0.6 Control Flow & Reliability

**Baseline:** Diff review of `ba35a43` (+2087/−298, 24 files)
**Correctness:** Self-audit report (9 extension modules, ~3,185 LOC, 185 tests passing)
**Edge:** Self-audit edge-case inventory (interpolation, parse, boundary, abort)
**Commit:** `4f67cb4` (README refresh) on top of `ba35a43`
**Date:** 2026-06-05

---

## Verdict

**Approve conditionally — one production bug remains, otherwise solid.**

The v0.0.6 release is a cohesive, well-structured feature drop: runtime warnings
for common authoring mistakes (`dependsOn`/`{steps.X.*}` mismatch), a
sanitization pipeline for upstream garbage (HTML error pages), structural
refactors (`usage.ts` leaf module, `foldEventLine` extraction, `resolveArgs`
deduplication), and thorough test coverage.

The self-audit found the codebase well-layered (acyclic dependency graph, pure
core with zero internal imports, correct injectable seam). The four HIGH bugs
identified by the audit (null-phase TypeError, abort-after-entry crash,
unguarded YAML parse, non-atomic writes) and two MED enablers (untyped
`_attempts`, missing `executeTaskflow` try/catch) were **fixed in a prior pass**
and verified.

The **single remaining production bug** is in the new `sanitizeErrorMessage`
function: title extraction is dead code because HTML tags are stripped before
the regex runs. This silently loses the page-title context from upstream error
hints (Cloudflare challenge pages, proxy error pages). The fix is small and
local.

---

## Must Fix Before Commit

### 1. Title extraction in `sanitizeErrorMessage` is dead code

**File:** `extensions/runner.ts:126-130` | **Severity:** High | **Source:** Baseline

```typescript
const stripped = cleaned.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const m = stripped.match(
    /(?:<title[^>]*>([^<]*)<\/title>|Unable to load site|Ray ID[: ]+([A-Za-z0-9]+)|[A-Z][a-z]+Error[: ]+(.{0,200}))/i,
);
const hint = m ? (m[1] || m[0]).trim() : stripped.slice(0, 200);
```

HTML tags are stripped before the regex runs, so `<title>...</title>` can
**never** match. The title hint for Cloudflare challenge pages ("Just a
moment...") or proxy error pages is silently lost. Existing tests pass because
they fall through to the "Unable to load site" alternative.

**Fix:** Extract the title before stripping HTML:

```typescript
const titleMatch = cleaned.match(/<title[^>]*>([^<]*)<\/title>/i);
const stripped = cleaned.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const m = stripped.match(
    /(?:Unable to load site|Ray ID[: ]+([A-Za-z0-9]+)|[A-Z][a-z]+Error[: ]+(.{0,200}))/i,
);
const hint = titleMatch?.[1]?.trim() ?? m ? (m[1] || m[0]).trim() : stripped.slice(0, 200);
```

**Effort:** 5 minutes. **Test:** Update the "summarizes upstream HTML
(Cloudflare challenge)" test to assert `"Just a moment..."` appears in the hint.

---

## Safe Enough Now

Items that look concerning but are confirmed harmless, by design, or defense-in-depth.

### 2. `looksLikeHtmlOrJson` doesn't detect JSON

**File:** `extensions/runner.ts:63-73` | **Source:** Baseline

The JSON branch returns `false` unconditionally. The docstring acknowledges this
— the function only treats huge `{error:...}` blobs as garbage, caught by the
size cap. Misleading name, correct behavior. **No fix needed.**

### 3. Double sanitization is idempotent

**Files:** `extensions/runner.ts:354-357`, `extensions/runtime.ts:100` | **Source:** Baseline

Runner sanitizes `result.errorMessage`, then `resultToPhaseState` sanitizes
again. Second pass is defense-in-depth; HTML summary won't re-summarize,
truncation on short strings won't fire. **Leave as-is.**

### 4. Regex in `looksLikeHtmlOrJson` is heuristic

**File:** `extensions/runner.ts:68` | **Source:** Baseline

Won't catch `<link>`, `<meta>`, `<img>` or other tags in challenge-page
footers. The heuristic targets document-level tags (html, head, body, script,
svg, div, iframe, span, p) which is good enough for Cloudflare/proxy error
pages. **No expansion needed.**

### 5. `mergePhaseState` error re-sanitization

**File:** `extensions/runtime.ts:216` | **Source:** Baseline

Individual errors are sanitized, joined with `; `, then sanitized again. If the
joined string exceeds `ERROR_MESSAGE_MAX_LEN` the second pass truncates it —
which is correct. **Low risk.**

### 6. Interpolation trace limits are arbitrary but reasonable

**File:** `extensions/runtime.ts:243` | **Source:** Baseline

`INTERPOLATION_TRACE_LIMIT = 5`, `INTERPOLATION_PREVIEW_LIMIT = 300`. The most
common case is 1–3 traces (task, over, when). These are internal diagnostics.
**Limits are fine.**

### 7. `formatUsage` is dead code (zero non-test callers)

**File:** `extensions/runner.ts:328` | **Source:** Correctness

Exported, has 8 tests, but `render.ts` uses its own `compactUsage`/`liveUsageStr`.
The self-audit recommended deletion. The prior fix pass noted this was
deliberately deferred. **Low urgency — harmless dead code.**

### 8. `onProgress` callback chain unused in production

**File:** `extensions/runtime.ts` (dozens of sites) + `extensions/index.ts:~181` | **Source:** Correctness

Production TUI is driven by 120ms heartbeat polling shared-mutable `RunState`.
The `onProgress` plumbing is a no-op except the flow-branch bridge (load-bearing
for sub-flow live progress). This is accidental redundancy but not harmful.
**Keep the flow bridge; top-level plumbing is noise but not a bug.**

### 9. Missing `additionalProperties: false` at runtime

**File:** `extensions/schema.ts:118` vs `233` | **Source:** Correctness

`TaskflowSchema` is never enforced at runtime; `define` accepts any shape.
The TypeBox type is documentation-only. **At this stage this is fine** — the LLM
produces the DSL and `validateTaskflow` catches structural errors. Adding
`Value.Check` could be a one-liner if desired, but it hasn't been needed.

---

## Nice-to-Have Follow-Ups

### A. Whitespace-padded bypass of `ERROR_MESSAGE_MAX_LEN`

**File:** `extensions/runner.ts:104-111` | **Source:** Baseline

The cap checks `raw.length`, not `cleaned.length`. A 5 KB space-padded message
with 100 meaningful chars hits truncation unnecessarily. By design (as comment
notes), but if false positives become an issue, check `cleaned.length` instead.

### B. `pathContains` uses `path.relative` — OS separator assumptions

**File:** `extensions/schema.ts:407-409` | **Source:** Baseline

Works correctly on macOS/Linux. On Windows, `path.relative` uses `\` and
`startsWith("..")` works the same way. **Note, not an action** — project targets
macOS/Node.js.

### C. `failOnMissing` naming is misleading

**File:** `extensions/runtime.ts:308-310` | **Source:** Baseline

Called for every phase, but in non-strict (warning) mode it populates `collected`
and `traces` and continues — it does more than "fail on missing". Consider
renaming to `handleMissing`.

### D. `safeParse` not truly brace-balanced

**File:** `extensions/interpolate.ts:122-138` | **Severity:** Low | **Source:** Correctness

Finds first `[`/`{` and last `]`/`}`; mismatched nesting (e.g. `{a: [1, 2]}`)
parses the wrong slice. Real-world risk is very low — the LLM produces
well-formed JSON. Could be fixed with a brace-counter, but low ROI.

### E. Lexicographic comparison in `interpolate.ts`

**File:** `extensions/interpolate.ts:269-280` | **Severity:** Low | **Source:** Correctness

`"100" < "9"` is `true` under string comparison. The function coerces to number
when both operands are numeric strings, so this only fires for mixed-type
comparisons. Document the limitation; adding full type-aware comparison is
scope creep.

### F. `PLACEHOLDER` regex doesn't match hyphenated names

**File:** `extensions/interpolate.ts:21` | **Severity:** Low | **Source:** Correctness

`[A-Za-z0-9_.]` excludes `-`. Hyphenated arg names like `my-arg` never
interpolate. Either document "use snake_case" or add `-` to the character class.

### G. `getFinalOutput` returns only first text part

**File:** `extensions/runner.ts:62-69` | **Severity:** Low | **Source:** Correctness

Multi-part messages (rare in practice) lose later text parts. Fix would be
joining all text parts. Low priority — most agents emit single-part messages.

### H. `parseArgsString` returns wrong type for non-object JSON

**File:** `extensions/index.ts:487-496` | **Severity:** Low | **Source:** Correctness

`[1,2]`, `42`, `"x"` pass through as `Record<string,unknown>` — typed wrong but
few callers iterate keys. A type guard or runtime check would catch misuse.

### I. `readStep` silent coercion of non-string `task`

**File:** `extensions/schema.ts:174,176` | **Severity:** Low | **Source:** Correctness

Non-string `task` becomes `"undefined"` or `"null"`. Validation in
`validateTaskflow` should catch this; if not, add a type check.

### J. Sub-flow recursion + progress bridging

**File:** `extensions/runtime.ts:457` | **Severity:** Low | **Source:** Correctness

The flow-branch `onProgress` bridge is load-bearing but plumbed through a local
closure that rewires callbacks. If sub-flows ever need to emit progress to the
TUI independently of the parent flow, this will need rework. **Not urgent** —
single-level nesting is the dominant use case.

### K. Extract shared constants (nice, not blocking)

**Files:** `extensions/runtime.ts`, `extensions/runner.ts`, `extensions/index.ts`,
`extensions/store.ts` | **Source:** Correctness

Magic numbers (8 concurrency, 60000 backoff cap, 5000 SIGKILL timeout,
1000 persist throttle, 120 heartbeat, etc.) are scattered across modules.
Move to top-of-module `const` blocks or a minimal `constants.ts` for
cross-module values. The self-audit recommends keeping single-module constants
local to avoid an unbounded grab-bag module.

### L. Guard empty `runs[]` in `runs-view.ts`

**File:** `extensions/runs-view.ts:65,76,80` | **Severity:** Low | **Source:** Correctness

Empty runs array causes `%0` = `NaN` and `undefined.status` crash. Simple
early-return guard (`if (!runs.length) return "No runs found"`).

---

## Cross-Reference

| Source | Key Findings |
|--------|-------------|
| **Baseline** (diff-review) | 1 must-fix title-extraction bug, 5 safe-to-keep items, 2 optional follow-ups |
| **Correctness** (self-audit) | 4 HIGH + 2 MED bugs (all fixed pre-commit), ~20 LOW items, structural refactors landed |
| **Edge** (self-audit inventory) | Brace-balance, lexicographic comparison, hyphenated placeholders, silent coercion, multi-part messages, empty runs — all LOW, no blocking issues |

**Before shipping:** Fix title extraction in `sanitizeErrorMessage` (item #1).
Everything else is either safe, deferred by design, or a nice-to-have follow-up.
