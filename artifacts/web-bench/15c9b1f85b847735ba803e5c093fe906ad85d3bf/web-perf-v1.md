# Taskflow Web benchmark — web-perf-v1

- Status: **structural-pass**
- Measured: 2026-07-25T11:39:20.734Z
- Source: `15c9b1f85b847735ba803e5c093fe906ad85d3bf` (clean)
- Source digest: `sha256:bc67e72d8308cd3ef4cd0852df809a53f5889ce79127d2d3a38c1eabc32f8c8e`
- Environment: MacBook Pro / Apple M3 Pro / Node v24.18.0 / Chromium 149.0.7827.55
- Runtime preconditions: expected Node v24.18.0; version match yes; power AC Power; no thermal/performance warning yes; load average before 3.78/5.84/5.74 and after 3.02/4.44/5.14
- Canonical release profile: no; latency checks are informational
- Machine-readable evidence: [web-perf-v1.json](./web-perf-v1.json)

## Aggregates

| Metric | n | p50 | p95 | min | max |
|---|---:|---:|---:|---:|---:|
| coldHomeUsefulMs | 30 | 401.80 | 419.30 | 391.40 | 602.10 |
| coldOwnerReadyMs | 30 | 2576.52 | 4678.38 | 2414.09 | 7854.95 |
| coldLaunchToUsefulMs | 30 | 3013.58 | 5130.14 | 2854.30 | 8504.25 |
| warmHomeInteractiveMs | 30 | 368.60 | 464.10 | 283.90 | 975.90 |
| cachedProInteractionMs | 30 | 22 | 25.70 | 19.70 | 30.30 |
| eventToVisibleMs | 30 | 175.50 | 187.00 | 153.50 | 188.00 |
| eventCommitToReceiptMs | 30 | 58.60 | 68.20 | 45.60 | 77.60 |
| eventReceiptToVisibleMs | 30 | 117.20 | 129.80 | 97.90 | 130.40 |

## Checks

| Check | Status | Actual | Maximum | Unit | Applicable |
|---|---|---:|---:|---|---|
| simpleShellJs | pass | 211240 | 225280 | gzip-bytes | yes |
| coldHome | informational | 419.30 | 2000 | milliseconds-p95 | no |
| warmHome | informational | 464.10 | 1200 | milliseconds-p95 | no |
| cachedPro | informational | 25.70 | 250 | milliseconds-p95 | no |
| firstProUseful | informational | 64.40 | 1500 | milliseconds | no |
| eventToVisible | informational | 187.00 | 250 | milliseconds | no |
| listResponsive | informational | 2.70 | 250 | milliseconds | no |
| layoutShift | pass | 0.04 | 0.10 | cls | yes |
| cspClean | pass | — | — | boolean | yes |

Raw samples, fixture identity, asset hashes, procedure, and CSP evidence are retained in the JSON report.
