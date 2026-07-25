# 0.3.0-beta.2 automated candidate evidence v2

Status: local automated candidate evidence; not human-approved, Conforming,
wire-frozen, or release evidence.

## Candidate lineage

The current production source is the tracked-clean build at
`15c9b1f85b847735ba803e5c093fe906ad85d3bf`. It contains source commit
`90df64c46695d70022228a08c2138a77b9f9ffe4` plus the exact-source reference
evidence commit. The later
`af40872f015d7592f949dc95dfe8905cc0b07d76` changes only the browser-matrix
evidence harness and is the tracked-clean browser-matrix candidate.

The production build identity is:

- Web build:
  `sha256:0ae85fbdcbe3d477b8ecb37fdee6aa91bb45c176e93c2085f269285bb3d7f351`;
- Web manifest:
  `sha256:fbf7570dc3b5e1a4ebc848015e30d7438dad42599055c635b0e30f654187d10e`;
- benchmark source digest:
  `sha256:bc67e72d8308cd3ef4cd0852df809a53f5889ce79127d2d3a38c1eabc32f8c8e`.

The evidence checker requires every evidence commit to be in this lineage and
rejects production or benchmark source drift after the immutable build.

## Real old/new packaged compatibility

The browser harness cross-ran the independently built historical
`aa34369a5958ce34bbdad3eab973434a001d0738` package and the current
`15c9b1f85b847735ba803e5c093fe906ad85d3bf` package under Node 24.18.0:

- old browser assets with the current gateway: pass;
- current browser assets with the old gateway: pass;
- navigation and bootstrap: HTTP 200;
- bootstrap schema: `web.v1`;
- application console and page errors: zero.

Evidence:

- `artifacts/web-compat/aa34369a-to-15c9b1f8/report.json`;
- SHA-256:
  `a1bd5087b82fe73344dafea3c726527d1d5d3c0229ba14d5e2c5980e5a69ec70`.

This is real code/assets/gateway compatibility, not a DTO replay.

## Pinned Node matrix

The exact current source passed the eight protocol/transport suites on Node
22.19.0, 24.18.0 and 26.5.0. Every runtime reports 63/63 tests.

Evidence:

- `artifacts/web-node-matrix/15c9b1f85b847735ba803e5c093fe906ad85d3bf/report.json`;
- SHA-256:
  `98ba5eee96f03682267af22768c9f42bff051fb888dc48285af9a540ad0ed096`.

## Packaged browser matrix

The schema-v3 matrix ran bundled Chromium 149.0.7827.55, Firefox 151.0,
WebKit 26.5 and native Chrome 150.0.7871.184. All four lanes passed on their
first attempt with:

- zero application console errors, page errors, CSP violations, runtime style
  insertions, final inline styles and 320-pixel horizontal overflow;
- SSE and three-second polling projection equivalence;
- restart-safe approval, live cancel, Receipt export, replay, keyboard/focus
  paths and listener-wide session invalidation;
- sensitive-artifact disclosure;
- decline issuing no download request or acknowledgement;
- confirm sending the exact acknowledgement and completing the download.

Firefox's six navigation-time EventSource diagnostics remain explicitly
classified transport diagnostics. Chromium and native Chrome have zero axe
violations on the tested Home and Task surfaces.

Evidence:

- `artifacts/web-browser-matrix/af40872f015d7592f949dc95dfe8905cc0b07d76/report.json`;
- SHA-256:
  `a3cbdbe8f2f982ed400144282cbbfff43cc2ad4a2520cc566a3cd34baf124772`.

## Performance and large-data evidence

The tracked-clean Node 24.18.0 run retained 30 raw samples over 100 projects,
10,000 Runs and a 2,000-node graph. It is a `structural-pass` on a MacBook Pro
with Apple M3 Pro, AC power, and no recorded thermal or performance warning.

The current non-canonical measurements are:

- Simple shell: 211,240 gzip bytes (limit 225,280);
- cold Home p95: 419.3 ms;
- warm Home p95: 464.1 ms;
- cached Pro p95: 25.7 ms;
- event to visible p95: 187.0 ms;
- event commit to Receipt p95: 68.2 ms;
- Receipt to visible p95: 129.8 ms;
- list response: 2.7 ms;
- CLS: 0.0439.

Owner-ready and launch-to-useful p95 are retained separately at 4.678 s and
5.130 s. These numbers are informational because this machine is not the RFC's
canonical Mac mini M2 / 16 GiB environment.

Evidence:

- `artifacts/web-bench/15c9b1f85b847735ba803e5c093fe906ad85d3bf/web-perf-v1.json`;
- JSON SHA-256:
  `c4521ffff96a733c71e57fc63876bdb1da7e0df7ba76ac23664ff62fc0ad0908`;
- `artifacts/web-bench/15c9b1f85b847735ba803e5c093fe906ad85d3bf/web-perf-v1.md`;
- summary SHA-256:
  `6e4c12006db3718540ea3f16cdded34306a1b22dcc18365432853d0a868e6cc1`.

## Historical native Safari records

The following records remain integrity-checked historical evidence for the
older `aa34369a` production source. The checker now proves that production
source changed after each record and therefore does **not** treat them as
current-source native Safari evidence:

- `docs/internal/webui/native-safari-mutation-smoke-v1.json`,
  `43bfad61e9669dcc71ccbaa2de16f4648ffb9ff3b9e292aca4f6bb1f555dda0d`;
- `docs/internal/webui/native-safari-reject-current-session-smoke-v1.json`,
  `d109297db75edb2d0c800bd9b26f467123631f188601da094a7bca8f8b68a320`;
- `docs/internal/webui/native-safari-cancel-smoke-v1.json`,
  `44f42094e75f1f0d5a2cbac50292f59b148e3c3bc705ee9cb39b6fb4f57accf0`;
- `docs/internal/webui/native-safari-peer-revocation-smoke-v1.json`,
  `0cee196d4f5db8681cdd2b84e6a39f1101d5bacf3ae7241ed0e0f899af4aef4a`;
- `docs/internal/webui/native-safari-two-session-revocation-smoke-v1.json`,
  `dae0dc546150bf1f707e9bdae0fc7e74bb210a472224e08240c72e54d41f8fe4`.

## Remaining release boundary

The automated candidate evidence is current. It does not close:

- product-owner reference approval;
- five fresh English participant sessions;
- two native Simplified-Chinese reviews;
- current-source native Safari or Edge review;
- VoiceOver, Narrator, NVDA or forced-colors review;
- the canonical Mac mini M2 / Node 24 performance run;
- reviewed-tip evidence and the separate wire-freeze decision.

