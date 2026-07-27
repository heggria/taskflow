# Taskflow Web benchmark — web-perf-v1

- Status: **structural-pass**
- Measured: 2026-07-27T04:07:30.648Z
- Source: `4c2b83c09e0b222cbee5959bb5eb53b1e8c862c2` (clean)
- Source digest: `sha256:6ca56cddda7ff711b41e16c23d8c1970d0fcfc1fb9c6d3b5110181843f2b0182`
- Environment: MacBook Pro / Apple M3 Pro / Node v24.18.0 / Chromium 149.0.7827.55
- Runtime preconditions: expected Node v24.18.0; version match yes; power AC Power; no thermal/performance warning yes; load average before 5.05/6.95/8.26 and after 7.97/7.62/8.20
- Canonical release profile: no; latency checks are informational
- Machine-readable evidence: [web-perf-v1.json](./web-perf-v1.json)

## Aggregates

| Metric | n | p50 | p95 | min | max |
|---|---:|---:|---:|---:|---:|
| coldHomeUsefulMs | 30 | 428.20 | 628.10 | 396.70 | 690.30 |
| coldOwnerReadyMs | 30 | 2841.26 | 5549.52 | 2529.17 | 18169.54 |
| coldLaunchToUsefulMs | 30 | 3352.07 | 6408.75 | 2993.30 | 18744.67 |
| warmHomeInteractiveMs | 30 | 457.70 | 558.80 | 340.50 | 582.30 |
| cachedProInteractionMs | 30 | 23.10 | 26.50 | 20.80 | 66.40 |
| eventToVisibleMs | 30 | 141.70 | 160.00 | 87.30 | 160.80 |
| eventCommitToReceiptMs | 30 | 57.80 | 73.40 | 25.20 | 82.80 |
| eventReceiptToVisibleMs | 30 | 79.20 | 102.40 | 50.20 | 106.80 |

## Checks

| Check | Status | Actual | Maximum | Unit | Applicable |
|---|---|---:|---:|---|---|
| simpleShellJs | pass | 211426 | 225280 | gzip-bytes | yes |
| coldHome | informational | 628.10 | 2000 | milliseconds-p95 | no |
| warmHome | informational | 558.80 | 1200 | milliseconds-p95 | no |
| cachedPro | informational | 26.50 | 250 | milliseconds-p95 | no |
| firstProUseful | informational | 90.10 | 1500 | milliseconds | no |
| eventToVisible | informational | 160.00 | 250 | milliseconds | no |
| listResponsive | informational | 23.60 | 250 | milliseconds | no |
| layoutShift | pass | 0.07 | 0.10 | cls | yes |
| cspClean | pass | — | — | boolean | yes |

Raw samples, fixture identity, asset hashes, procedure, and CSP evidence are retained in the JSON report.
