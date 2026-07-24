# Taskflow Web benchmark — web-perf-v1

- Status: **structural-pass**
- Measured: 2026-07-24T09:10:50.545Z
- Source: `7e555c7d7f39109ee89a502f0d818cc34f1ce7fa` (clean)
- Source digest: `sha256:97076ba3daf5d08a405515cb89132f610a9b4fd04f7307d3b04d6e5123dc3e1c`
- Environment: MacBook Pro / Apple M3 Pro / Node v24.18.0 / Chromium 149.0.7827.55
- Runtime preconditions: expected Node v24.18.0; version match yes; power AC Power; no thermal/performance warning yes; load average before 9.75/8.42/7.44 and after 7.84/8.19/7.63
- Canonical release profile: no; latency checks are informational
- Machine-readable evidence: [web-perf-v1.json](./web-perf-v1.json)

## Aggregates

| Metric | n | p50 | p95 | min | max |
|---|---:|---:|---:|---:|---:|
| coldHomeUsefulMs | 30 | 497.70 | 1137.50 | 379.80 | 1410.50 |
| coldOwnerReadyMs | 30 | 3079.93 | 8778.70 | 2649.27 | 11648.10 |
| coldLaunchToUsefulMs | 30 | 3854.64 | 9772.42 | 3100.03 | 13378.68 |
| warmHomeInteractiveMs | 30 | 453.30 | 918.50 | 308.60 | 958.50 |
| cachedProInteractionMs | 30 | 25.80 | 50.30 | 21.10 | 57.20 |
| eventToVisibleMs | 30 | 126.70 | 178.10 | 87.40 | 196.10 |
| eventCommitToReceiptMs | 30 | 59.50 | 78.30 | 19.70 | 104.70 |
| eventReceiptToVisibleMs | 30 | 67.90 | 105.30 | 55.70 | 152.20 |

## Checks

| Check | Status | Actual | Maximum | Unit | Applicable |
|---|---|---:|---:|---|---|
| simpleShellJs | pass | 209410 | 225280 | gzip-bytes | yes |
| coldHome | informational | 1137.50 | 2000 | milliseconds-p95 | no |
| warmHome | informational | 918.50 | 1200 | milliseconds-p95 | no |
| cachedPro | informational | 50.30 | 250 | milliseconds-p95 | no |
| firstProUseful | informational | 97.80 | 1500 | milliseconds | no |
| eventToVisible | informational | 178.10 | 250 | milliseconds | no |
| listResponsive | informational | 6.70 | 250 | milliseconds | no |
| layoutShift | pass | 0.08 | 0.10 | cls | yes |
| cspClean | pass | — | — | boolean | yes |

Raw samples, fixture identity, asset hashes, procedure, and CSP evidence are retained in the JSON report.
