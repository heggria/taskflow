# 0.3.0-beta.2 immutable candidate evidence v1

Status: local candidate evidence; not reviewed-tip, Conforming, wire-frozen, or
release evidence.

## Bound candidates

| Role | Git commit | Web manifest SHA-256 |
|---|---|---|
| old | `7e555c7d7f39109ee89a502f0d818cc34f1ce7fa` | `sha256:252a851c67aac16f53c57d57cb374d7647bfbca788328b4d17670ae67408ca1e` |
| new | `aa34369a5958ce34bbdad3eab973434a001d0738` | `sha256:d7b3c3930587c697779fcc37261dd87ce574316fae6c848248ce45650a9dbd69` |

Both builds were produced from detached worktrees with
`pnpm install --offline --frozen-lockfile` followed by `pnpm run build`.
`taskflow-core/dist/build-info.json` supplies the immutable commit identity;
the signed Web asset manifest supplies the independently distinct asset
identity.

## Cross-build compatibility

Reproduction command:

```text
npx --yes node@24.18.0 scripts/test-web-packaged-compatibility.mjs \
  --old-root <built-7e555c7d-root> \
  --new-root <built-aa34369a-root> \
  --output artifacts/web-compat/7e555c7d-to-aa34369a/report.json
```

Result:

- old client/new server: pass;
- new client/old server: pass;
- navigation and bootstrap: HTTP 200;
- bootstrap schema: `web.v1`;
- application console errors: 0;
- page errors: 0.

Evidence:

- report:
  `artifacts/web-compat/7e555c7d-to-aa34369a/report.json`;
- report SHA-256:
  `1bda883ebda78e104d2b721947c3f4b29d987d1d47e0ee0e98fd284a312ad15d`.

The report deliberately contains build identities rather than local absolute
paths. The harness rejects an identical manifest or an identical stamped
commit before opening a browser.

The evidence checker also requires the current evidence tip to descend from
the new build and rejects any production or benchmark source drift after that
build. Evidence-only documentation and artifact commits may follow the bound
source commit; a source change requires a new immutable build and rerun.

## Performance and large-data evidence

Reproduction command from the clean `aa34369a` source state:

```text
npx --yes node@24.18.0 scripts/bench-web.mjs
```

Evidence:

- JSON:
  `artifacts/web-bench/aa34369a5958ce34bbdad3eab973434a001d0738/web-perf-v1.json`;
- human summary:
  `artifacts/web-bench/aa34369a5958ce34bbdad3eab973434a001d0738/web-perf-v1.md`;
- JSON SHA-256:
  `14515e88518505f4e438b8fc765e9ea16a03eb158e07e4453923df1eb1c88004`;
- summary SHA-256:
  `5bb928a2ebd7e22bb8b896814decff0bec92aa86592de4dae77ed19ddfee954d`.

The schema-v4 report records:

- exact commit `aa34369a5958ce34bbdad3eab973434a001d0738`;
- `git.dirty:false`;
- source digest
  `sha256:f05e3aefb64dd3a5d115e4c975883ecf16e5830f7c9f225fb07962e317a40db4`;
- Node 24.18.0 and Chromium 149.0.7827.55;
- MacBook Pro / Apple M3 Pro / AC power;
- no recorded thermal or performance warning;
- 30 raw samples, 100 projects, 10,000 Runs and 2,000 graph nodes;
- a 209,803-byte gzip Simple shell;
- `structural-pass`.

This is not the RFC's canonical Mac mini M2 / 16 GiB profile. Its latency
numbers are informational even when they are below the numerical budgets.
The canonical M2 run remains a release gate. The non-canonical p95s were
511.8 ms cold Home, 887.4 ms warm Home, 55.7 ms cached Pro, 344.6 ms
event-to-visible, 123.8 ms commit-to-receipt, 281.4 ms receipt-to-visible,
13 ms list response, and 0.0616 CLS. Owner-ready and launch-to-useful p95s
were 4.977 s and 5.556 s. Event-to-visible is above the 250-ms canonical
budget in this non-canonical run; it is recorded as informational, not
silently passed. Load average rose from 5.54/6.51/7.58 to 9.70/8.09/7.94,
so an unloaded canonical-profile rerun remains mandatory.

## Pinned runtime and packaged browser matrices

The exact `aa34369a` source candidate also has candidate-bound aggregate
reports rather than console-only green runs.

Pinned Node evidence:

- Node 22.19.0, 24.18.0 and 26.5.0;
- eight protocol/transport suites and 62/62 tests per runtime;
- report:
  `artifacts/web-node-matrix/aa34369a5958ce34bbdad3eab973434a001d0738/report.json`;
- report SHA-256:
  `fa076b24843f1ebae5117b394284c3af168a8b4564d8edc6e90a7ea64b4fc893`.

Packaged browser evidence:

- bundled Chromium 149.0.7827.55, Firefox 151.0 and WebKit 26.5 plus native
  Chrome 150.0.7871.184;
- all four lanes passed on their first attempt with zero application
  console/page errors, CSP violations, runtime style insertion, inline style
  attributes or horizontal overflow at 320 CSS pixels;
- all four lanes proved SSE plus polling equivalence, contextual approval,
  live cancel, Receipt/artifact/export, zero-provider/zero-write replay,
  keyboard/focus paths, current-session logout and listener-wide peer-session
  invalidation;
- Chromium and native Chrome recorded zero axe violations on Home and Task;
- Firefox retained six classified navigation-time EventSource diagnostics,
  not application errors;
- report:
  `artifacts/web-browser-matrix/aa34369a5958ce34bbdad3eab973434a001d0738/report.json`;
- report SHA-256:
  `395e7a9048626e37a4390e41c25ccb65a67f2753281505a6c4eeda764940ac20`.

These automated reports do not substitute for native Safari/Edge,
assistive-technology or human-comprehension review.

## Native Safari mutation smokes

Native Safari 26.3 on macOS 26.3 exercised four scoped packaged mutation
paths. Each record binds the exact source commit actually observed. The
allow/revoke-all and reject/current-session records are ancestral evidence
from `d8df9c65`; cancel was observed on `794c85f8`; peer invalidation was
rerun on evidence tip `e19dfd45`, whose candidate source is byte-identical to
the bound `aa34369a` source.

The allow/revoke-all run:

- activated Allow from native keyboard focus and showed duplicate-safe pending
  copy;
- reached a completed task with 3/3 steps, partial verification, and result
  `published`;
- applied listener-wide revocation and rendered the localized all-tabs
  signed-out screen.

The reject/current-session run:

- reached both decision controls through native Tab focus and activated Reject
  with the keyboard;
- settled the approval node as blocked while downstream stayed pending;
- ended only the current session and rendered the localized current-tab
  signed-out screen.

The cancel run:

- started from a live cancellable provider task with its node visibly active;
- activated Stop task and reached the authoritative cancelled terminal;
- rendered `任务已停止`, 0/1 steps, the node as stopped, verification
  unavailable, and no invented result;
- discarded two earlier harness attempts that ended by short fixture duration
  or phase timeout rather than treating them as cancel evidence.

The current-source independent peer-invalidation run:

- kept the native Safari tab as the target peer;
- exchanged a fresh, independent second session from a packaged CLI launch and
  invoked the CSRF-protected revoke-all endpoint through a closed P17 HTTP
  client;
- received HTTP 200 for exchange and revocation, with three sessions revoked;
- made the Safari peer lose authorization and render the localized
  current-tab session-ended screen instead of a generic page failure.

The peer mutation actor was not an unlocked Safari private window. The staged
actor capability expired during native setup and returned 401 before creating
a session; a fresh same-listener capability was minted and consumed for the
passing run. This record proves current-source native Safari peer invalidation
and presentation, not a two-Safari-cookie-jar usability path.

All four passing holds ended with their loopback listener refusing a
subsequent connection. None of these records claim VoiceOver behavior,
automated Safari console/CSP coverage, or human comprehension.

Evidence:

- allow/revoke-all record:
  `docs/internal/webui/native-safari-mutation-smoke-v1.json`;
- allow/revoke-all SHA-256:
  `e949c3f3573c73dcf4d057245309f183917cfe25350025fe98a3a68c35a95540`;
- reject/current-session record:
  `docs/internal/webui/native-safari-reject-current-session-smoke-v1.json`;
- reject/current-session SHA-256:
  `e3d9a1c26bcba19d5b2c6deaab28212420e3a61663fb991b5c6ab4eb8a07497c`;
- cancel record:
  `docs/internal/webui/native-safari-cancel-smoke-v1.json`;
- cancel SHA-256:
  `6cd6ca7e5148a3df11ed63d2b818742008912d2f88f2b5387ebce2f4c7c48174`;
- peer-invalidation record:
  `docs/internal/webui/native-safari-peer-revocation-smoke-v1.json`;
- peer-invalidation SHA-256:
  `0cee196d4f5db8681cdd2b84e6a39f1101d5bacf3ae7241ed0e0f899af4aef4a`.

## Remaining interpretation boundary

These local records close the exact-source immutable cross-build, pinned
runtime, packaged browser, non-canonical performance and current-source native
Safari peer-invalidation evidence gaps. The other native Safari mutation
records remain useful ancestral evidence. They do not provide:

- human product/reference approval;
- five fresh English participant results;
- two native Simplified-Chinese reviews;
- native Edge or any VoiceOver, Narrator, or NVDA evidence;
- a two-unlocked-Safari-session usability run;
- the canonical M2 performance report;
- reviewed-tip evidence or a wire-freeze decision.
