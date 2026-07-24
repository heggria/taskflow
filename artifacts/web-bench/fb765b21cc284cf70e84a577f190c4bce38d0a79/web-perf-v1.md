# Taskflow Web benchmark — web-perf-v1

- Status: **structural-pass**
- Measured: 2026-07-24T06:38:56.530Z
- Source: `fb765b21cc284cf70e84a577f190c4bce38d0a79` (clean)
- Source digest: `sha256:3863805d98bfbd34856589501cc9ce3ab589c64365e380ed36e7e6fdde2f910c`
- Environment: MacBook Pro / Apple M3 Pro / Node v24.18.0 / Chromium 149.0.7827.55
- Runtime preconditions: expected Node v24.18.0; version match yes; power AC Power; no thermal/performance warning yes; load average before 8.42/5.90/5.59 and after 14.65/8.55/6.69
- Canonical release profile: no; latency checks are informational
- Machine-readable evidence: [web-perf-v1.json](./web-perf-v1.json)

## Aggregates

| Metric | n | p50 | p95 | min | max |
|---|---:|---:|---:|---:|---:|
| coldHomeUsefulMs | 30 | 405.10 | 502 | 375.80 | 602.40 |
| coldOwnerReadyMs | 30 | 2681.27 | 3304.31 | 2530.79 | 4043.02 |
| coldLaunchToUsefulMs | 30 | 3136.32 | 3846.01 | 2964.55 | 4812.24 |
| warmHomeInteractiveMs | 30 | 427 | 537.70 | 292.50 | 869.60 |
| cachedProInteractionMs | 30 | 23.50 | 29 | 21.70 | 30.20 |
| eventToVisibleMs | 30 | 322.30 | 574.60 | 201.30 | 1001.50 |
| eventCommitToReceiptMs | 30 | 92.80 | 212.80 | 70.40 | 381.20 |
| eventReceiptToVisibleMs | 30 | 243.20 | 496.70 | 95.90 | 620.30 |

## Checks

| Check | Status | Actual | Maximum | Unit | Applicable |
|---|---|---:|---:|---|---|
| simpleShellJs | pass | 209114 | 225280 | gzip-bytes | yes |
| coldHome | informational | 502 | 2000 | milliseconds-p95 | no |
| warmHome | informational | 537.70 | 1200 | milliseconds-p95 | no |
| cachedPro | informational | 29 | 250 | milliseconds-p95 | no |
| firstProUseful | informational | 93.10 | 1500 | milliseconds | no |
| eventToVisible | informational | 574.60 | 250 | milliseconds | no |
| listResponsive | informational | 12.90 | 250 | milliseconds | no |
| layoutShift | pass | 0.03 | 0.10 | cls | yes |
| cspClean | pass | — | — | boolean | yes |

Raw samples, fixture identity, asset hashes, procedure, and CSP evidence are retained in the JSON report.
