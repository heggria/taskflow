# Taskflow Web benchmark — web-perf-v1

- Status: **structural-pass**
- Measured: 2026-07-24T06:24:38.853Z
- Source: `33202a9c26e2d3b86d8d661a09b4c9ef5f9a56e2` (clean)
- Source digest: `sha256:1d270e9e8c755ea1373b1e0ca524e5b37394b0522ec64d970057a6b7ca85a282`
- Environment: MacBook Pro / Apple M3 Pro / Node v24.18.0 / Chromium 149.0.7827.55
- Runtime preconditions: expected Node v24.18.0; version match yes; power AC Power; no thermal/performance warning yes; load average before 4.77/5.79/5.65 and after 7.40/6.52/5.96
- Canonical release profile: no; latency checks are informational
- Machine-readable evidence: [web-perf-v1.json](./web-perf-v1.json)

## Aggregates

| Metric | n | p50 | p95 | min | max |
|---|---:|---:|---:|---:|---:|
| coldHomeUsefulMs | 30 | 399.10 | 552.30 | 377.10 | 574.50 |
| coldOwnerReadyMs | 30 | 2611.81 | 3715.31 | 2527.19 | 3927.65 |
| coldLaunchToUsefulMs | 30 | 3063.29 | 4405.07 | 2944.52 | 4423.86 |
| warmHomeInteractiveMs | 30 | 437.50 | 650 | 331.60 | 835.80 |
| cachedProInteractionMs | 30 | 24.60 | 29.80 | 21.60 | 30.10 |
| eventToVisibleMs | 30 | 117.20 | 149.10 | 86.00 | 191.00 |
| eventCommitToReceiptMs | 30 | 59.60 | 79.20 | 20.30 | 80.00 |
| eventReceiptToVisibleMs | 30 | 62 | 75.10 | 46.70 | 125.10 |

## Checks

| Check | Status | Actual | Maximum | Unit | Applicable |
|---|---|---:|---:|---|---|
| simpleShellJs | pass | 209114 | 225280 | gzip-bytes | yes |
| coldHome | informational | 552.30 | 2000 | milliseconds-p95 | no |
| warmHome | informational | 650 | 1200 | milliseconds-p95 | no |
| cachedPro | informational | 29.80 | 250 | milliseconds-p95 | no |
| firstProUseful | informational | 110.70 | 1500 | milliseconds | no |
| eventToVisible | informational | 149.10 | 250 | milliseconds | no |
| listResponsive | informational | 12.60 | 250 | milliseconds | no |
| layoutShift | pass | 0.07 | 0.10 | cls | yes |
| cspClean | pass | — | — | boolean | yes |

Raw samples, fixture identity, asset hashes, procedure, and CSP evidence are retained in the JSON report.
