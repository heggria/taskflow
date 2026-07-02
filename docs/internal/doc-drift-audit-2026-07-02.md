# Documentation Drift Audit — Verified Report

**2026-07-02 · taskflow monorepo · multi-agent adversarial cross-review**
**Method:** 5 parallel `analyst` audits → `reviewer` adversarial re-verification → `critic` second-adversary report. Then main-agent independent spot-check of every high-impact claim (line numbers confirmed against the working tree).

> **Main-agent correction (agents could not know this):** the audit ran against branch `test/script-phase-coverage` (= `main` + 20 pending tests + README build-fix). So the **test-count** findings (897→917, 51→52 files) reflect *this branch*, not `main`. On `main` today the README's `897 tests / 51 files` is still accurate; those become wrong only once the test branch merges. Everything else below is **real drift on `main`.**

## Verdict

**44 unique findings** · 1 critical · 17 high · 20 medium · 6 low.
Root cause of 15/17 high: **the `script` phase type (merged to main via PR #4) is undocumented everywhere.**

## Confirmed on `main` (independently re-verified by main agent)

| Sev | Doc:line | Claim | Reality |
|-----|----------|-------|---------|
| CRIT | SECURITY.md:30 | `v0.0.14 (latest)` | actual 0.1.3 |
| HIGH | README.md:347–360 | phase table 9 rows, no `script` | schema.ts:17 → 10 types |
| HIGH | README.md:753/792 | "9 phase types"; cache excludes gate/approval/loop/tournament | 10 types; also excludes `script` |
| HIGH | README.zh-CN.md:289–299 | phase table 9 rows | 10 types |
| HIGH | pi SKILL.md:95–107 | phase table 9 rows, no run/input/timeout | 10 types + 3 new fields |
| HIGH | configuration.md:53,74 | "9 phase types" enum | 10 |
| HIGH | codex SKILL.md:54–58 | 9 types enumerated | 10 |
| HIGH | AGENTS.md:69,210 | "Phase Types (9 total)"; "all 9 phase types" | 10 |
| MED | CONTRIBUTING.md:12 | "872 tests" | ≈897 on main (stale even pre-branch) |
| MED | RELEASE.md:32 | "864/864 green" | ≈897 on main (stale) |
| MED | RELEASE.md:53 | `taskflow-core: 0.1.0` | 0.1.3 |
| MED | RELEASE.md:3 / SECURITY.md:5,8,14 | project called "pi-taskflow" | rebranded "taskflow" (pi-taskflow = one package) |
| MED | AGENTS.md (runtime line) | Node ≥ 22 | engines = >=22.19.0 |
| MED | codex SKILL.md:20 | `taskflow_compile` = "diagram + verification report" | SVG w/ issues overlaid + status line + text-outline fallback |

## Depends on merging the test branch (897→917)

README.md:11/753/758 badge + counts; README.zh-CN.md:11/634/639 (also has an internal 897-vs-895 inconsistency at L11 badge). Update these to `917 tests / 52 files` **when** the test branch lands.

## zh-CN structural drift vs English README (real, medium/low)

Missing sections/rows in README.zh-CN.md: Shared Context Tree section; Background (detached) section; comparison-table rows (iterative loops + tournament); control-flow bullets (`onBlock`, `eval`); interpolation rows (`{loop.*}`); flow `def` form; flow-level keys (`contextSharing`, `strictInterpolation`); examples table (2 files); "plan-then-execute" preview; storage-path missing `<flowName>/` segment (L459); dogfood table row; cache-exclusion missing `script`.

## Recommended fix groups

1. **Document `script`** in README.md, README.zh-CN.md, pi SKILL.md, configuration.md, codex SKILL.md, AGENTS.md. Spec: `run` (required, string|string[]), `input` (optional stdin, interpolation-enabled), `timeout` (optional, 1000–300000ms, default 60000); string-form `run` rejects `{interpolation}`; no `retry`; no `output:"json"`; blocked from cross-run cache; compile legend `⚡ script`.
2. **Fix SECURITY.md** version 0.0.14→0.1.3 + rebrand.
3. **Fix RELEASE.md** branding + `0.1.0`→`0.1.3` + tag example + stale count.
4. **Fix CONTRIBUTING.md** stale test count.
5. **Sync zh-CN** with English README (the structural gaps above).
6. **Test-count refresh** (897→917) — bundle with the test-branch merge.
7. *(optional)* enrich `server.ts:190` `taskflow_compile` tool description with the outline mention.

## Dropped as false-positive (auditable)

- codex-mcp.md "lists 9 phase types" — file has no phase enumeration; analyst confused it with codex SKILL.md.
- codex-mcp.md:109 tool table "overstates" — doc is accurate; reworded to a low code-side note (server.ts:190).
