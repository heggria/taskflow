# Diff review — v0.0.6 control flow & reliability

Commit `4f67cb4` on top of `ba35a43`.

Files touched: **12 files, +822 / −42 lines**

---

## Overall verdict

**Approve with one must-fix bug.** The diff is large but well-structured: a cohesive feature release adding runtime warnings for common authoring mistakes (`dependsOn` / `{steps.X.*}` mismatch), a sanitization pipeline for upstream garbage (HTML error pages), and thorough test coverage. The core logic is sound; the one real bug is in `sanitizeErrorMessage` title extraction (see below). Everything else is minor or personal preference.

The codebase quality is high — typing is consistent, error paths are handled, streaming/resume/budget/gate all interact correctly. The test suite matches the new functionality 1:1.

---

## Must fix before commit

### Bug: Title extraction in `sanitizeErrorMessage` is dead code

**File:** `extensions/runner.ts:126-130`

```typescript
const stripped = cleaned.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const m = stripped.match(
    /(?:<title[^>]*>([^<]*)<\/title>|Unable to load site|Ray ID[: ]+([A-Za-z0-9]+)|[A-Z][a-z]+Error[: ]+(.{0,200}))/i,
);
const hint = m ? (m[1] || m[0]).trim() : stripped.slice(0, 200);
```

HTML tags are stripped from `cleaned` before the regex runs, so the `<title[^>]*>([^<]*)<\/title>` alternative can **never** match — `stripped` no longer contains angle brackets. The intent (extract the page title for the hint) is silently defeated.

**Fix:** Match against `cleaned` (before stripping) for the title regex, or use a two-pass approach:
1. Extract title from `cleaned` with a pre-strip regex.
2. Strip HTML for the other alternatives.

Example fix sketch:

```typescript
// Extract title before stripping HTML
const titleMatch = cleaned.match(/<title[^>]*>([^<]*)<\/title>/i);
const stripped = cleaned.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const m = stripped.match(
    /(?:Unable to load site|Ray ID[: ]+([A-Za-z0-9]+)|[A-Z][a-z]+Error[: ]+(.{0,200}))/i,
);
const hint = titleMatch?.[1]?.trim() ?? m ? (m[1] || m[0]).trim() : stripped.slice(0, 200);
```

The existing test (`summarizes upstream HTML (Cloudflare challenge)`) continues to pass because it falls through to the "Unable to load site" alternative, but the title ("Just a moment...") is lost from the hint.

---

## Safe to keep

### `looksLikeHtmlOrJson` doesn't detect JSON

**File:** `extensions/runner.ts:63-73`

The function name suggests it detects HTML or JSON, but the JSON branch returns `false` unconditionally:

```typescript
if (t.startsWith("{")) {
    return false;
}
```

The docstring acknowledges this — it only treats huge `{error: ...}` blobs as garbage, which is caught by the size cap. The naming is slightly misleading but harmless. No fix needed; the behavior is correct.

### Double sanitization is idempotent

**File:** `extensions/runner.ts:354-357` (runner sanitizes), `extensions/runtime.ts:100` (runtime sanitizes again)

The runner sanitizes `result.errorMessage` in the fallback branch (`isFailed && !output`), then `resultToPhaseState` in runtime calls `sanitizeErrorMessage(errSource)` on the final state. The second pass is defense-in-depth and is idempotent (HTML summary won't re-summarize, truncation on already-short strings won't fire). The comment in `resultToPhaseState` acknowledges this. Not a bug, just slightly redundant — leave it as-is; defense-in-depth is cheap.

### Regex in `looksLikeHtmlOrJson` is a heuristic, not exhaustive

**File:** `extensions/runner.ts:68`

```typescript
/^<(?:!doctype\s+html|html|head|body|script|svg|div|iframe|span|p)\b/i
```

This won't catch `<link>`, `<meta>`, `<img>` or other common tags that could appear in a challenge page footer or a proxy error. The test only checks the document-level tags, which is fine for the intended use case (Cloudflare/upstream error pages). The heuristic is good enough — don't add more tags.

### `mergePhaseState` error join re-sanitizes

**File:** `extensions/runtime.ts:216`

```typescript
error: errors.length ? sanitizeErrorMessage(errors.join("; ")) : undefined,
```

Individual errors were already sanitized in `resultToPhaseState`, then joined with `; ` and sanitized again. If the joined string exceeds `ERROR_MESSAGE_MAX_LEN`, the second pass will truncate it — which is arguably the right behavior. Low risk.

### Interpolation trace limit is arbitrary but reasonable

**File:** `extensions/runtime.ts:243`

```typescript
const INTERPOLATION_TRACE_LIMIT = 5;
const INTERPOLATION_PREVIEW_LIMIT = 300;
```

5 traces, 300 chars each. Could miss diagnostic data on very complex flows (>5 interpolation sources), but the most common case is 1–3 (task, over, when). These are internal diagnostics, not user-facing — the limits are fine.

---

## Optional follow-ups

### `ERROR_MESSAGE_MAX_LEN` vs. whitespace-padded bypass

**File:** `extensions/runner.ts:104-111`

```typescript
const rawLen = raw.length;
if (rawLen > ERROR_MESSAGE_MAX_LEN) { ... }
```

The function checks `raw.length` (not `cleaned.length`) against the cap. A message padded with 5000 spaces and 100 meaningful chars would hit the truncation branch unnecessarily — stripping to `cleaned` would reveal it's short. This is by design (as the comment on line 109 says), and it's arguably safer (a 5 KB space-padded blob is still a 5 KB blob). But if false positives are an issue, consider checking `cleaned.length` instead.

### `pathContains` uses `path.relative` — OS path separator assumptions

**File:** `extensions/schema.ts:407-409`

```typescript
function pathContains(parent: string, child: string): boolean {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
```

Works correctly on macOS/Linux. On Windows, `path.relative` would use `\` separators, and `startsWith("..")` would work the same way. This is a note, not an action — the project targets macOS/Node.js.

### `failOnMissing` is called twice for agent/gate/reduce phases on the same `text`

**File:** `extensions/runtime.ts:308-310`

```typescript
const { text, missing } = interpolate(phase.task ?? "", ctx);
const strictFail = failOnMissing("task", text, missing);
if (strictFail) return strictFail;
```

`failOnMissing` internally calls `recordMissingPlaceholders` AND `trace`. For the non-strict (warning) path, this means `collected` and `traces` are populated but execution continues, then `resultToPhaseState` attaches them at line 317. This is correct — just slightly roundabout. Consider renaming to `handleMissing` since it does more than "fail on missing".

---

## Summary

| Category | Count | Items |
|---|---|---|
| **Must fix** | 1 | Dead title extraction in `sanitizeErrorMessage` |
| **Safe to keep** | 5 | `looksLikeHtmlOrJson` naming, double sanitization, heuristic regex, error join, trace limits |
| **Optional** | 2 | Whitespace-padded bypass, `pathContains` platform note, `failOnMissing` naming |
