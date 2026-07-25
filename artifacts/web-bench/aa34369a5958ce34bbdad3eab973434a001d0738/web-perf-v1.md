# Taskflow Web benchmark — web-perf-v1

- Status: **structural-pass**
- Measured: 2026-07-25T05:24:48.266Z
- Source: `aa34369a5958ce34bbdad3eab973434a001d0738` (clean)
- Source digest: `sha256:f05e3aefb64dd3a5d115e4c975883ecf16e5830f7c9f225fb07962e317a40db4`
- Environment: MacBook Pro / Apple M3 Pro / Node v24.18.0 / Chromium 149.0.7827.55
- Runtime preconditions: expected Node v24.18.0; version match yes; power AC Power; no thermal/performance warning yes; load average before 5.54/6.51/7.58 and after 9.70/8.09/7.94
- Canonical release profile: no; latency checks are informational
- Machine-readable evidence: [web-perf-v1.json](./web-perf-v1.json)

## Aggregates

| Metric | n | p50 | p95 | min | max |
|---|---:|---:|---:|---:|---:|
| coldHomeUsefulMs | 30 | 394.30 | 511.80 | 380.30 | 617.90 |
| coldOwnerReadyMs | 30 | 2598.11 | 4977.16 | 2509.90 | 16784.29 |
| coldLaunchToUsefulMs | 30 | 3051.72 | 5555.64 | 2931.16 | 17474.28 |
| warmHomeInteractiveMs | 30 | 463.20 | 887.40 | 307.40 | 970.10 |
| cachedProInteractionMs | 30 | 27.60 | 55.70 | 21.60 | 76.60 |
| eventToVisibleMs | 30 | 295.20 | 344.60 | 109.70 | 794.40 |
| eventCommitToReceiptMs | 30 | 76.30 | 123.80 | 47.10 | 267.40 |
| eventReceiptToVisibleMs | 30 | 193.50 | 281.40 | 61.80 | 527 |

## Checks

| Check | Status | Actual | Maximum | Unit | Applicable |
|---|---|---:|---:|---|---|
| simpleShellJs | pass | 209803 | 225280 | gzip-bytes | yes |
| coldHome | informational | 511.80 | 2000 | milliseconds-p95 | no |
| warmHome | informational | 887.40 | 1200 | milliseconds-p95 | no |
| cachedPro | informational | 55.70 | 250 | milliseconds-p95 | no |
| firstProUseful | informational | 124.70 | 1500 | milliseconds | no |
| eventToVisible | informational | 344.60 | 250 | milliseconds | no |
| listResponsive | informational | 13 | 250 | milliseconds | no |
| layoutShift | pass | 0.06 | 0.10 | cls | yes |
| cspClean | pass | — | — | boolean | yes |

Raw samples, fixture identity, asset hashes, procedure, and CSP evidence are retained in the JSON report.
