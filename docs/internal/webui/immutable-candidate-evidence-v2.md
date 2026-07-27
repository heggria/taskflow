# 0.3.0-beta.2 automated candidate evidence v2

Status: local automated candidate evidence; not human-approved, Conforming,
wire-frozen, or release evidence.

## Candidate lineage

The current immutable packaged/evidence build is the tracked-clean commit
`130e1a3f7c0bf991c96d6e0192a2517be43ff827`. It contains implementation source
`6f18a4eff57f1774328808cdfea22e58178555e4` plus the exact-source reference
renders. The compatibility, Node, performance and four-lane browser reports
all bind this same packaged/evidence build; the reference render itself remains
bound to the implementation source commit.

The production build identity is:

- Web build:
  `sha256:853edc81c345c5a06e105110c4f3cb0fabcfc79f0e73912f05fa636b56da624e`;
- Web manifest:
  `sha256:154fe609eb6bea194e6b241e1b3f7394ffcecbed7cf70352faf44b9eef08a9e6`;
- benchmark source digest:
  `sha256:28142aa423b56628a67f9f38d2dbccf7ba985750a1ccca1d0cb4bc9e050a1682`.

The evidence checker requires every evidence commit to be in this lineage and
rejects production or benchmark source drift after the immutable build.

## Real old/new packaged compatibility

The browser harness cross-ran the independently built historical
`aa34369a5958ce34bbdad3eab973434a001d0738` package and the current
`130e1a3f7c0bf991c96d6e0192a2517be43ff827` package under Node 24.18.0:

- old browser assets with the current gateway: pass;
- current browser assets with the old gateway: pass;
- navigation and bootstrap: HTTP 200;
- bootstrap schema: `web.v1`;
- application console and page errors: zero.

Evidence:

- `artifacts/web-compat/aa34369a-to-130e1a3f/report.json`;
- SHA-256:
  `3ec3ad43695ad52fa711deb517f2934c5cd6340494b8aafc1a9ece27bffa6ea4`.

This is real code/assets/gateway compatibility, not a DTO replay.

## Pinned Node matrix

The exact current source passed the eight protocol/transport suites on Node
22.19.0, 24.18.0 and 26.5.0. Every runtime reports 63/63 tests.

Evidence:

- `artifacts/web-node-matrix/130e1a3f7c0bf991c96d6e0192a2517be43ff827/report.json`;
- SHA-256:
  `752c9635c8d98e10bb0a62573a54379c1fe414e99011af237e88428afc040c65`.

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

- `artifacts/web-browser-matrix/130e1a3f7c0bf991c96d6e0192a2517be43ff827/report.json`;
- SHA-256:
  `7e0eb6071810a6e229cef2c6ebbfa910497a9224e024b7e2b0a4a403215eb680`.

## Performance and large-data evidence

The tracked-clean Node 24.18.0 run retained 30 raw samples over 100 projects,
10,000 Runs and a 2,000-node graph. It is a `structural-pass` on a MacBook Pro
with Apple M3 Pro, AC power, and no recorded thermal or performance warning.

The current non-canonical measurements are:

- Simple shell: 211,426 gzip bytes (limit 225,280);
- cold Home p95: 405.7 ms;
- warm Home p95: 453.3 ms;
- cached Pro p95: 24.4 ms;
- event to visible p95: 291.8 ms;
- event commit to Receipt p95: 66.4 ms;
- Receipt to visible p95: 225.0 ms;
- list response: 3.6 ms;
- CLS: 0.0397.

Owner-ready and launch-to-useful p95 are retained separately at 3.075 s and
3.509 s. These numbers are informational because this machine is not the RFC's
canonical Mac mini M2 / 16 GiB environment. In particular, the 291.8-ms event
measurement is above the canonical 250-ms budget and is not presented as a
pass. One preliminary run timed out while loading the 10,000-row list; an
immediate smoke and the retained 30-sample rerun completed. The canonical
unloaded-machine run remains the release gate.

Evidence:

- `artifacts/web-bench/130e1a3f7c0bf991c96d6e0192a2517be43ff827/web-perf-v1.json`;
- JSON SHA-256:
  `d8787cc2d0985f2b5bb04f6c8d3d62cbdf6d59c44ab9c887014496586ea3743e`;
- `artifacts/web-bench/130e1a3f7c0bf991c96d6e0192a2517be43ff827/web-perf-v1.md`;
- summary SHA-256:
  `9fddd7c088caf665d38bbdc223b42dddb81b137e612c7ba9ac4cc47988f38cf7`.

## Current-source native Safari scoped records

Native Safari 26.3 on macOS 26.3 exercised five scoped paths against
tracked-clean candidates `c04540019d99984366843536baa2b47771beb8fa` and
`f6dfc8017b6bc18d7179a5bfec4b5bb42956e268`. Neither candidate has
production-source drift from immutable build
`130e1a3f7c0bf991c96d6e0192a2517be43ff827`; every record binds the same
benchmark source digest, Web manifest and Web build identity listed above.

The read/keyboard path proved:

- one-time native Safari session exchange and Simple-by-default rendering;
- Home attention/active/recent sections plus completed Task state, steps,
  partial-verification limit and result;
- Simple → Pro identity preservation and native tab semantics;
- the two-node graph, accessible disclosure and single-selection list;
- native Arrow Down selection changing both the selected node and inspector;
- verification, Receipt manifest and artifact actions in Evidence.

The four mutation paths proved:

- keyboard-focused Allow, duplicate-safe pending copy, 3/3 completion,
  partial verification, `published`, and listener-wide revoke-all;
- keyboard traversal through both approval answers, authoritative Reject,
  blocked/pending downstream state, `approval rejected`, and current-session
  logout;
- a live cancellable provider Task, visible in-progress node, Stop activation,
  authoritative cancelled terminal, 0/1 steps, unavailable verification and
  no invented result;
- two independent one-time exchanges under one listener, using a normal Safari
  window and an unlocked private Safari window with distinct cookie jars;
  listener-wide revocation from the normal session ended both sessions, while
  the actor projected the all-tabs consequence and the private peer projected
  the current-tab consequence without changing Task state.

Evidence:

- `docs/internal/webui/native-safari-current-read-smoke-v1.json`,
  `7f66ed19caf1e554a7945f3b3e24c89f091ce579ce52580d74e1588e105edce3`;
- `docs/internal/webui/native-safari-current-mutation-smoke-v1.json`,
  `c91d3dce9471745a4eed15154c035987fe3c3203b1b1c46f0464fad009572501`;
- `docs/internal/webui/native-safari-current-reject-current-session-smoke-v1.json`,
  `68558f9737c4edeb846a5c0323b7d7c3873dca786b1ec80419c81756c439f349`;
- `docs/internal/webui/native-safari-current-cancel-smoke-v1.json`,
  `f39bdf0ee777bfc4ab26b7c3af936fb976c335833204ad181566d58310f79fd9`;
- `docs/internal/webui/native-safari-current-two-session-revocation-smoke-v1.json`,
  `ce3af2f4b9429d4b20ff898dc7f22f3f76bd473d7a43ed580b23d9b4004905ae`.

These are scoped native-browser observations, not a VoiceOver or independent
reviewer attestation. The two-session record is current-source local evidence
for independent peer/two-cookie invalidation; it is not an assistive-technology
or human-product-review result.

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
