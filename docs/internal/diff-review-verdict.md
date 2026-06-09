# Diff Review Verdict — v0.0.6 Control Flow & Reliability

**Commit:** `4f67cb4` on top of `ba35a43`
**Scope:** 12 files, +822 / −42 lines

---

## Verdict

**Approve with one must-fix bug.** The diff is a well-structured feature release adding runtime warnings for common authoring mistakes (`dependsOn` / `{steps.X.*}` mismatch), a sanitization pipeline for upstream HTML error pages, and thorough test coverage. The core logic is sound; one bug needs fixing before commit.

---

## Must Fix

| # | Issue | File |
|---|-------|------|
| 1 | **Title extraction in `sanitizeErrorMessage` is dead code** — HTML tags are stripped before the title regex runs, so `<title>...</title>` can never match. The existing test passes because it falls through to another alternative, but the page title is silently lost. | `extensions/runner.ts:126-130` |

---

## Safe to Keep (5 items)

| # | Issue | Rationale |
|---|-------|-----------|
| 1 | `looksLikeHtmlOrJson` doesn't detect JSON | Documented behavior — only catches huge `{error:...}` blobs by size. Misleading name, correct behavior. |
| 2 | Double sanitization (runner + runtime) | Idempotent and defense-in-depth; harmless. |
| 3 | Regex heuristic not exhaustive | Misses tags like `<link>`, `<meta>`, `<img>`, but sufficient for Cloudflare/upstream error pages. |
| 4 | Error join re-sanitizes joined string | Truncation on join is arguably correct behavior; low risk. |
| 5 | Interpolation trace limits (5 traces, 300 chars) | Internal diagnostics; limits are fine for typical 1–3 interpolation sources. |

---

## Optional Follow-ups

| # | Issue | Note |
|---|-------|------|
| 1 | `ERROR_MESSAGE_MAX_LEN` checks `raw.length` before stripping whitespace | By design — a 5 KB space-padded blob is still 5 KB. Switch to `cleaned.length` if false positives arise. |
| 2 | `pathContains` uses `path.relative` | Works correctly on macOS/Linux; no action needed (project targets macOS/Node.js). |
| 3 | `failOnMissing` called twice for agent/gate/reduce phases | Correct but roundabout — consider renaming to `handleMissing` since it does more than "fail on missing". |

---

## Summary

| Category | Count |
|----------|-------|
| Must fix | 1 — dead title extraction |
| Safe to keep | 5 — naming, double sanitization, heuristic, error join, trace limits |
| Optional | 3 — whitespace bypass, platform note, naming |
