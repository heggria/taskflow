# Taskflow Web benchmark — web-perf-v1

- Status: **structural-pass**
- Measured: 2026-07-24T07:50:07.499Z
- Source: `d8df9c650b68e4c0854aaad03e6da3ce0dc3352f` (clean)
- Source digest: `sha256:648b778e4e316be5f93e4ef2b68c07ba45bea4d0d2731a9dc2d471ec3b18c0b3`
- Environment: MacBook Pro / Apple M3 Pro / Node v24.18.0 / Chromium 149.0.7827.55
- Runtime preconditions: expected Node v24.18.0; version match yes; power AC Power; no thermal/performance warning yes; load average before 8.05/8.69/8.62 and after 7.56/8.73/8.86
- Canonical release profile: no; latency checks are informational
- Machine-readable evidence: [web-perf-v1.json](./web-perf-v1.json)

## Aggregates

| Metric | n | p50 | p95 | min | max |
|---|---:|---:|---:|---:|---:|
| coldHomeUsefulMs | 30 | 512 | 1268.10 | 375.30 | 1714.40 |
| coldOwnerReadyMs | 30 | 4331.58 | 25699.91 | 2564.79 | 26434.35 |
| coldLaunchToUsefulMs | 30 | 5360.37 | 27174.93 | 2999.70 | 28216.72 |
| warmHomeInteractiveMs | 30 | 430.20 | 904.70 | 207.10 | 922.10 |
| cachedProInteractionMs | 30 | 24.20 | 30.70 | 20.90 | 34.60 |
| eventToVisibleMs | 30 | 123.90 | 151.10 | 97.30 | 211.30 |
| eventCommitToReceiptMs | 30 | 54.70 | 76.90 | 27 | 83.20 |
| eventReceiptToVisibleMs | 30 | 66.20 | 95 | 53.30 | 147 |

## Checks

| Check | Status | Actual | Maximum | Unit | Applicable |
|---|---|---:|---:|---|---|
| simpleShellJs | pass | 209367 | 225280 | gzip-bytes | yes |
| coldHome | informational | 1268.10 | 2000 | milliseconds-p95 | no |
| warmHome | informational | 904.70 | 1200 | milliseconds-p95 | no |
| cachedPro | informational | 30.70 | 250 | milliseconds-p95 | no |
| firstProUseful | informational | 137.20 | 1500 | milliseconds | no |
| eventToVisible | informational | 151.10 | 250 | milliseconds | no |
| listResponsive | informational | 8.60 | 250 | milliseconds | no |
| layoutShift | pass | 0.08 | 0.10 | cls | yes |
| cspClean | pass | — | — | boolean | yes |

Raw samples, fixture identity, asset hashes, procedure, and CSP evidence are retained in the JSON report.
