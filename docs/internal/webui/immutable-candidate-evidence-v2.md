# 0.3.0-beta.2 automated candidate evidence v2

Status: local automated candidate evidence; not human-approved, Conforming,
wire-frozen, or release evidence.

## Candidate lineage

The current immutable packaged/evidence build is the tracked-clean commit
`4c2b83c09e0b222cbee5959bb5eb53b1e8c862c2`. It descends from the prior
packaged candidate and adds request-scoped reuse of authoritative read
snapshots for nested Run and Node detail reads. The compatibility, Node,
performance and four-lane browser reports all bind this same packaged/evidence
build. The UI assets remain unchanged; the exact-source 149-render reference
set was regenerated against tracked-clean candidate
`382007f77687442b2e8ea0912dcfb705dba953cb`.

The production build identity is:

- Web build:
  `sha256:853edc81c345c5a06e105110c4f3cb0fabcfc79f0e73912f05fa636b56da624e`;
- Web manifest:
  `sha256:154fe609eb6bea194e6b241e1b3f7394ffcecbed7cf70352faf44b9eef08a9e6`;
- benchmark source digest:
  `sha256:6ca56cddda7ff711b41e16c23d8c1970d0fcfc1fb9c6d3b5110181843f2b0182`.

The evidence checker requires every evidence commit to be in this lineage and
rejects production or benchmark source drift after the immutable build.

The current reference render evidence binds candidate
`382007f77687442b2e8ea0912dcfb705dba953cb`, all 149 files under
`artifacts/web-reference/382007f77687/`, and
`docs/internal/webui/reference-set-v1/render-evidence.json` with SHA-256
`308bef04f43282d3865f2452165b1c1cbc0c4aa4ab805aec81feceac1f223e02`.
It remains `rendered-awaiting-human-approval`.

## Real old/new packaged compatibility

The browser harness cross-ran the independently built historical
`aa34369a5958ce34bbdad3eab973434a001d0738` package and the current
`4c2b83c09e0b222cbee5959bb5eb53b1e8c862c2` package under Node 24.18.0:

- old browser assets with the current gateway: pass;
- current browser assets with the old gateway: pass;
- navigation and bootstrap: HTTP 200;
- bootstrap schema: `web.v1`;
- application console and page errors: zero.

Evidence:

- `artifacts/web-compat/aa34369a-to-4c2b83c0/report.json`;
- SHA-256:
  `ac2229f06a0b0396a2490f9e7b776d3e2541ea3458c5f5e575d6ffbe12ecd423`.

This is real code/assets/gateway compatibility, not a DTO replay.

## Pinned Node matrix

The exact current source passed the eight protocol/transport suites on Node
22.19.0, 24.18.0 and 26.5.0. Every runtime reports 63/63 tests.

Evidence:

- `artifacts/web-node-matrix/4c2b83c09e0b222cbee5959bb5eb53b1e8c862c2/report.json`;
- SHA-256:
  `b70413e91e87fff788887875310f38677f3f332c49f67af8ff79dae82c4f1cf5`.

## Packaged browser matrix

The schema-v4 matrix, which also binds the executable browser harness bytes,
ran bundled Chromium 149.0.7827.55, Firefox 151.0,
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

- `artifacts/web-browser-matrix/4c2b83c09e0b222cbee5959bb5eb53b1e8c862c2/report.json`;
- SHA-256:
  `81a519ec614865fb6165bf581326d20911e09dc68c9147f9ee7522ef72107062`.

## Performance and large-data evidence

The tracked-clean Node 24.18.0 run retained 30 raw samples over 100 projects,
10,000 Runs and a 2,000-node graph. It is a `structural-pass` on a MacBook Pro
with Apple M3 Pro, AC power, and no recorded thermal or performance warning.

The current non-canonical measurements are:

- Simple shell: 211,426 gzip bytes (limit 225,280);
- cold Home p95: 628.1 ms;
- warm Home p95: 558.8 ms;
- cached Pro p95: 26.5 ms;
- event to visible p95: 160.0 ms;
- event commit to Receipt p95: 73.4 ms;
- Receipt to visible p95: 102.4 ms;
- list response: 23.6 ms;
- CLS: 0.0690.

Owner-ready and launch-to-useful p95 remain retained separately in the JSON.
These numbers are informational because this machine is not the RFC's
canonical Mac mini M2 / 16 GiB environment and the run recorded elevated host
load. The exact candidate now measures 160.0 ms event-to-visible on this
non-canonical host, below the nominal 250-ms budget, but only the canonical
unloaded-machine run can close the release gate.

Evidence:

- `artifacts/web-bench/4c2b83c09e0b222cbee5959bb5eb53b1e8c862c2/web-perf-v1.json`;
- JSON SHA-256:
  `987aba9f2e7cee870fbf8d0cf2e79f6ad0e2cd1ddd11f9ecd1ecf5615e1d8538`;
- `artifacts/web-bench/4c2b83c09e0b222cbee5959bb5eb53b1e8c862c2/web-perf-v1.md`;
- summary SHA-256:
  `f85201428ecab9eb5ffc913dd83dceac829fa617a1e63aee57233c55ae504d11`.

## Current-source native Safari scoped records

Native Safari 26.3 on macOS 26.3 has refreshed the read/keyboard and
Allow/revoke-all paths against tracked-clean production-source candidate
`4c2b83c09e0b222cbee5959bb5eb53b1e8c862c2`. Both records bind the benchmark
source digest, Web manifest and Web build identity listed above. The
Reject/current-session, live-cancel and normal/private two-cookie-jar paths
still require fresh native runs before the candidate checker may pass.

The read/keyboard path proved:

- one-time native Safari session exchange and Simple-by-default rendering;
- Home attention/active/recent sections plus completed Task state, steps,
  partial-verification limit and result;
- Simple → Pro identity preservation and native tab semantics;
- the two-node graph, accessible disclosure and single-selection list;
- native Arrow Down selection changing both the selected node and inspector;
- verification, Receipt manifest and artifact actions in Evidence.

The refreshed mutation path proved:

- native Allow activation, duplicate-safe pending copy, 3/3 completion,
  partial verification, `published`, and listener-wide revoke-all.

Evidence:

- `docs/internal/webui/native-safari-current-read-smoke-v1.json`,
  `b09cd7c93a9fb4f8c16a73e34ac5c11a3ce520205be84909d55d001c47667f4d`;
- `docs/internal/webui/native-safari-current-mutation-smoke-v1.json`,
  `b59927d15e2bd31354b9bc5f1810d998b3215c0b3e7576cbf02c96b1714726ff`.

These are scoped native-browser observations, not a VoiceOver or independent
reviewer attestation.

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
- native Edge review;
- VoiceOver, Narrator, NVDA or forced-colors review;
- the canonical Mac mini M2 / Node 24 performance run;
- reviewed-tip evidence and the separate wire-freeze decision.
