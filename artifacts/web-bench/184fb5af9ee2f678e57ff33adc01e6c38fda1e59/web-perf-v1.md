# Taskflow Web benchmark — web-perf-v1

- Status: **structural-pass**
- Measured: 2026-07-24T07:11:00.008Z
- Source: `184fb5af9ee2f678e57ff33adc01e6c38fda1e59` (clean)
- Source digest: `sha256:a411eb10d10229eed5e84c61712d635c42e0ff60c6cccb18fdef6d6ead764902`
- Environment: MacBook Pro / Apple M3 Pro / Node v24.18.0 / Chromium 149.0.7827.55
- Runtime preconditions: expected Node v24.18.0; version match yes; power AC Power; no thermal/performance warning yes; load average before 11.69/7.97/7.26 and after 7.57/7.97/7.54
- Canonical release profile: no; latency checks are informational
- Machine-readable evidence: [web-perf-v1.json](./web-perf-v1.json)

## Aggregates

| Metric | n | p50 | p95 | min | max |
|---|---:|---:|---:|---:|---:|
| coldHomeUsefulMs | 30 | 408.30 | 1217.90 | 378.30 | 1751.90 |
| coldOwnerReadyMs | 30 | 3573.54 | 18286.13 | 2569.06 | 19685.50 |
| coldLaunchToUsefulMs | 30 | 4013.14 | 19131.97 | 3010.84 | 21517.32 |
| warmHomeInteractiveMs | 30 | 402.50 | 465 | 285.60 | 486.50 |
| cachedProInteractionMs | 30 | 22.30 | 24.40 | 19.20 | 29 |
| eventToVisibleMs | 30 | 127.30 | 225.90 | 85.50 | 226.20 |
| eventCommitToReceiptMs | 30 | 59.20 | 81.50 | 30.30 | 102 |
| eventReceiptToVisibleMs | 30 | 66.90 | 161.30 | 48.50 | 165.60 |

## Checks

| Check | Status | Actual | Maximum | Unit | Applicable |
|---|---|---:|---:|---|---|
| simpleShellJs | pass | 209367 | 225280 | gzip-bytes | yes |
| coldHome | informational | 1217.90 | 2000 | milliseconds-p95 | no |
| warmHome | informational | 465 | 1200 | milliseconds-p95 | no |
| cachedPro | informational | 24.40 | 250 | milliseconds-p95 | no |
| firstProUseful | informational | 93.80 | 1500 | milliseconds | no |
| eventToVisible | informational | 225.90 | 250 | milliseconds | no |
| listResponsive | informational | 8.50 | 250 | milliseconds | no |
| layoutShift | pass | 0.07 | 0.10 | cls | yes |
| cspClean | pass | — | — | boolean | yes |

Raw samples, fixture identity, asset hashes, procedure, and CSP evidence are retained in the JSON report.
