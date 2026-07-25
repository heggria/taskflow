# Taskflow Web benchmark — web-perf-v1

- Status: **structural-pass**
- Measured: 2026-07-25T13:14:32.429Z
- Source: `130e1a3f7c0bf991c96d6e0192a2517be43ff827` (clean)
- Source digest: `sha256:28142aa423b56628a67f9f38d2dbccf7ba985750a1ccca1d0cb4bc9e050a1682`
- Environment: MacBook Pro / Apple M3 Pro / Node v24.18.0 / Chromium 149.0.7827.55
- Runtime preconditions: expected Node v24.18.0; version match yes; power AC Power; no thermal/performance warning yes; load average before 3.06/6.53/6.27 and after 3.12/4.59/5.46
- Canonical release profile: no; latency checks are informational
- Machine-readable evidence: [web-perf-v1.json](./web-perf-v1.json)

## Aggregates

| Metric | n | p50 | p95 | min | max |
|---|---:|---:|---:|---:|---:|
| coldHomeUsefulMs | 30 | 396.90 | 405.70 | 391.80 | 409.90 |
| coldOwnerReadyMs | 30 | 2525.65 | 3074.66 | 2435.18 | 4140.26 |
| coldLaunchToUsefulMs | 30 | 2960.04 | 3509.38 | 2858.07 | 4562.72 |
| warmHomeInteractiveMs | 30 | 366.70 | 453.30 | 278.40 | 458 |
| cachedProInteractionMs | 30 | 19.70 | 24.40 | 17.90 | 27.30 |
| eventToVisibleMs | 30 | 262.10 | 291.80 | 189.50 | 323.40 |
| eventCommitToReceiptMs | 30 | 59.80 | 66.40 | 45.60 | 120.00 |
| eventReceiptToVisibleMs | 30 | 203.40 | 225 | 132.90 | 230.50 |

## Checks

| Check | Status | Actual | Maximum | Unit | Applicable |
|---|---|---:|---:|---|---|
| simpleShellJs | pass | 211426 | 225280 | gzip-bytes | yes |
| coldHome | informational | 405.70 | 2000 | milliseconds-p95 | no |
| warmHome | informational | 453.30 | 1200 | milliseconds-p95 | no |
| cachedPro | informational | 24.40 | 250 | milliseconds-p95 | no |
| firstProUseful | informational | 55.80 | 1500 | milliseconds | no |
| eventToVisible | informational | 291.80 | 250 | milliseconds | no |
| listResponsive | informational | 3.60 | 250 | milliseconds | no |
| layoutShift | pass | 0.04 | 0.10 | cls | yes |
| cspClean | pass | — | — | boolean | yes |

Raw samples, fixture identity, asset hashes, procedure, and CSP evidence are retained in the JSON report.
