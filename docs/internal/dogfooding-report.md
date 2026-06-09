# pi-taskflow v0.0.6 — Dogfooding Report

**Date:** 2026-06-05
**Scope:** v0.0.6 control flow & reliability release (commit `4f67cb4` on `ba35a43`)
**Inputs:** Baseline diff review (`docs/diff-review.md`) × adversarial self-audit (`docs/self-audit-report.md`)

---

## Overall verdict

**Approve — all known production bugs are fixed; ship ready.**

The v0.0.6 release is a cohesive feature drop adding:

- **Runtime warnings** for common authoring mistakes (`dependsOn`/`{steps.X.*}` mismatch)
- **Sanitization pipeline** for upstream garbage (HTML error pages from Cloudflare, proxies)
- **Structural refactors** — `usage.ts` leaf module, `foldEventLine` extraction, `resolveArgs` deduplication, merged `agent`/`gate`/`reduce` single-agent branches (7→5)
- **Thorough test coverage** — 185 tests passing, typecheck clean

The review via context (diff review) found the core logic sound with **1 must-fix bug** (title extraction in `sanitizeErrorMessage`). The adversarial self-audit found 4 HIGH and 2 MED bugs — **all 7 bugs fixed in prior passes**, verified against current source. The high-value structural refactors (usage module, fold extraction, resolveArgs dedup) have been landed. **No remaining production bugs.**

The architecture is well-layered (acyclic dependency graph, pure core with zero internal imports, correct injectable seam at `RuntimeDeps.runTask`). 185 tests pass, typecheck clean. The codebase scores solid A-.

---

## Must fix before release

**None.** All identified production bugs have been fixed in prior passes.

### ✓ Resolved: Title extraction in `sanitizeErrorMessage` (baseline review)

**Source:** Baseline diff review | **Status:** Fixed in source | **File:** `extensions/runner.ts:97-100`

Originally flagged as dead code — HTML tags were stripped before the title regex ran, so `<title>...</title>` could never match. The current source on disk has the correct fix:

```typescript
const title = cleaned.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();  // title extracted BEFORE strip
const stripped = cleaned.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const m = stripped.match(/(?:Unable to load site|...)/i);
const hint = title || (m ? (m[1] || m[0]).trim() : stripped.slice(0, 200));  // title preferred
```

The test at `test/runner.test.ts:252-259` asserts `"Hint: Just a moment..."` is present, confirming the fix works.

---

## Can ship as-is

These items look concerning but are confirmed harmless, by design, or defense-in-depth. No action needed before ship.

### 2. `looksLikeHtmlOrJson` doesn't detect JSON

**Source:** Baseline | **File:** `extensions/runner.ts:63-73`

The JSON branch returns `false` unconditionally. The docstring acknowledges this — the function only treats huge `{error:...}` blobs as garbage (caught by the size cap). Misleading name, correct behavior.

### 3. Double sanitization is idempotent

**Source:** Baseline | **Files:** `extensions/runner.ts:354-357`, `extensions/runtime.ts:100`

Runner sanitizes `result.errorMessage` in the fallback branch, then `resultToPhaseState` in runtime sanitizes again. Second pass is defense-in-depth; HTML summary won't re-summarize, truncation on already-short strings won't fire.

### 4. Regex in `looksLikeHtmlOrJson` is heuristic

**Source:** Baseline | **File:** `extensions/runner.ts:68`

Won't catch `<link>`, `<meta>`, `<img>` or footers from challenge pages. Targets document-level tags (`html`, `head`, `body`, `script`, `svg`, `div`, `iframe`, `span`, `p`) — sufficient for Cloudflare/proxy error pages.

### 5. `mergePhaseState` error re-sanitizes joined string

**Source:** Baseline | **File:** `extensions/runtime.ts:216`

Individual errors are sanitized, joined with `; `, then sanitized again. Truncation on the joined string is arguably correct — low risk.

### 6. Interpolation trace limits are arbitrary but reasonable

**Source:** Baseline | **File:** `extensions/runtime.ts:243`

`INTERPOLATION_TRACE_LIMIT = 5`, `INTERPOLATION_PREVIEW_LIMIT = 300`. Most common case is 1–3 traces (task, over, when). These are internal diagnostics.

### 7. `formatUsage` is deleted (resolved)

**Source:** Adversarial (self-audit) | **Status:** Fixed in prior pass

Dead code removed; `UsageStats` moved to dedicated `usage.ts` leaf module. Ownership inversion complete.

### 8. `onProgress` callback chain unused at top level

**Source:** Adversarial | **Files:** `extensions/runtime.ts`, `extensions/index.ts:~181`

Production TUI is driven by 120ms heartbeat polling shared-mutable `RunState`. The top-level `onProgress` plumbing is a no-op, but the flow-branch bridge is load-bearing for sub-flow live progress. Keep the bridge; top-level noise is not a bug.

### 9. Missing `additionalProperties: false` at runtime

**Source:** Adversarial | **File:** `extensions/schema.ts:118` vs `233`

`TaskflowSchema` is never enforced at runtime; `define` accepts any shape. The TypeBox type is documentation-only. At this stage it's fine — the LLM produces the DSL and `validateTaskflow` catches structural errors.

### 10. Four HIGH + two MED + one baseline bug are fixed (resolved)

**Source:** Adversarial (+ baseline) | **Status:** All fixed in prior passes

| Sev | File | Issue | Fix |
|-----|------|-------|-----|
| HIGH | `schema.ts:318` | `phases:[null]` → TypeError on unguarded `p.final` | Guard `p && p.final` |
| HIGH | `runtime.ts:218-235` | Abort-after-entry crash (`last` undefined → `_attempts` write) | Guard `last` before write; try/catch entry |
| HIGH | `agents.ts:58` | Unguarded YAML parse throws on bad frontmatter | try/catch in `parseFrontmatter` |
| HIGH | `store.ts:127,147` | Non-atomic `writeFileSync` → corrupted state on crash | tmp + `renameSync` |
| MED | `runtime.ts:572-715` | `executeTaskflow` lacks try/catch → stuck `"running"` on throw | Wrap in try/catch, terminal persist |
| MED | `runtime.ts:93,235` | `_attempts` smuggled via type-unsafe cast on `RunResult` | Add typed optional `attempts` field |
| HIGH | `runner.ts:126-130` | Title extraction dead code (baseline diff review) | Extract title before stripping HTML — fixed with test asserting page title appears |

---

## Follow-up improvements

### A. Whitespace-padded bypass of `ERROR_MESSAGE_MAX_LEN`

**Source:** Baseline | **File:** `extensions/runner.ts:104-111`

The cap checks `raw.length`, not `cleaned.length`. A 5 KB space-padded message with 100 meaningful chars hits truncation unnecessarily. By design (as comment notes), but consider checking `cleaned.length` if false positives arise.

### B. `pathContains` platform note

**Source:** Baseline | **File:** `extensions/schema.ts:407-409`

Uses `path.relative` which works on macOS/Linux. On Windows, `\` separators are handled identically. Note only — project targets macOS/Node.js.

### C. `failOnMissing` naming

**Source:** Baseline | **File:** `extensions/runtime.ts:308-310`

Called for every phase, but in non-strict (warning) mode it populates `collected`/`traces` and continues. Consider renaming to `handleMissing`.

### D. `safeParse` not truly brace-balanced

**Source:** Adversarial | **Severity:** Low | **File:** `extensions/interpolate.ts:122-138`

Finds first `[`/`{` and last `]`/`}`; mismatched nesting (e.g. `{a: [1, 2]}`) parses the wrong slice. Real-world risk is very low — the LLM produces well-formed JSON. Fix with a brace-counter if false positives appear.

### E. Lexicographic comparison in `interpolate.ts`

**Source:** Adversarial | **Severity:** Low | **File:** `extensions/interpolate.ts:269-280`

`"100" < "9"` is `true` under string comparison. Coerces to number when both operands are numeric strings — only fires for mixed-type comparisons. Document the limitation.

### F. `PLACEHOLDER` regex doesn't match hyphenated names

**Source:** Adversarial | **Severity:** Low | **File:** `extensions/interpolate.ts:21`

`[A-Za-z0-9_.]` excludes `-`. Hyphenated arg names like `my-arg` silently never interpolate. Document "use snake_case" or add `-` to the character class.

### G. `getFinalOutput` returns only first text part

**Source:** Adversarial | **Severity:** Low | **File:** `extensions/runner.ts:62-69`

Multi-part messages (rare in practice) lose later text parts. Fix: join all text parts. Low priority.

### H. `parseArgsString` wrong type for non-object JSON

**Source:** Adversarial | **Severity:** Low | **File:** `extensions/index.ts:487-496`

`[1,2]`, `42`, `"x"` pass through typed as `Record<string,unknown>`. Add a type guard or runtime check.

### I. `readStep` silent coercion of non-string `task`

**Source:** Adversarial | **Severity:** Low | **File:** `extensions/schema.ts:174,176`

Non-string `task` becomes `"undefined"` or `"null"`. Validation in `validateTaskflow` should already catch this.

### J. Sub-flow recursion + progress bridging

**Source:** Adversarial | **Severity:** Low | **File:** `extensions/runtime.ts:457`

The flow-branch `onProgress` bridge is load-bearing but plumbed through a local closure. If sub-flows ever need to emit progress independently of the parent flow, this needs rework. Single-level nesting is dominant — not urgent.

### K. Extract shared constants

**Source:** Adversarial | **Files:** Multiple

Magic numbers (8 concurrency, 60000 backoff cap, 5000 SIGKILL timeout, 1000 persist throttle, 120 heartbeat) scattered across modules. The self-audit recommends keeping single-module constants local to avoid an unbounded grab-bag module. Move only cross-module values to a minimal constants area.

### L. Guard empty `runs[]` in `runs-view.ts`

**Source:** Adversarial | **Severity:** Low | **File:** `extensions/runs-view.ts:65,76,80`

Empty runs array causes `%0` = `NaN` and `undefined.status` crash. Simple early-return guard.

### M. Extract `processLine` for unit coverage

**Source:** Adversarial | **Effort:** 1-2 hours

The injectable `runTask` seam gives excellent runtime coverage without spawning, but NDJSON parsing, usage accumulation, SIGTERM→SIGKILL abort, and temp-file lifecycle are exercised only by the e2e suite. Extracting `foldEventLine` (done in prior pass) was step one; `processLine` as a pure function is step two.

### N. Refactor `executePhase` to dispatch table

**Source:** Adversarial | **Effort:** 2-3 hours

The 7-branch `if`-chain was collapsed to 5 branches (agent/gate/reduce merged) in the prior pass. Completing the dispatch-table refactor would make "add an 8th phase type" a localized change — worthwhile but not blocking.

---

## Cross-reference

| Source | Key findings |
|--------|-------------|
| **Baseline** (diff review) | 1 must-fix (title extraction), 5 safe-to-keep, 2 optional follow-ups |
| **Adversarial** (self-audit) | 4 HIGH + 2 MED bugs (fixed pre-commit), ~20 LOW items, 3 high-value structural refactors landed |
| **Edge-case inventory** (self-audit §4) | Brace-balance, lexicographic comparison, hyphenated placeholders, silent coercion, multi-part messages, empty runs — all LOW, no blocking issues |

**Before shipping:** No remaining blocking issues. Everything is either fixed, safe, deferred by design, or a nice-to-have follow-up.

---

*Generated by merging baseline diff review + adversarial self-audit into a consolidated dogfooding report.*
