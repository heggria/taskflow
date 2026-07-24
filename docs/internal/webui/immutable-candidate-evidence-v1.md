# 0.3.0-beta.2 immutable candidate evidence v1

Status: local candidate evidence; not reviewed-tip, Conforming, wire-frozen, or
release evidence.

## Bound candidates

| Role | Git commit | Web manifest SHA-256 |
|---|---|---|
| old | `d8df9c650b68e4c0854aaad03e6da3ce0dc3352f` | `sha256:e14f395eaec7b29cbae07f8ba89dca2c21f9f1b82766d0cb01d0580b1db1f13f` |
| new | `7e555c7d7f39109ee89a502f0d818cc34f1ce7fa` | `sha256:252a851c67aac16f53c57d57cb374d7647bfbca788328b4d17670ae67408ca1e` |

Both builds were produced from detached worktrees with
`pnpm install --offline --frozen-lockfile` followed by `pnpm run build`.
`taskflow-core/dist/build-info.json` supplies the immutable commit identity;
the signed Web asset manifest supplies the independently distinct asset
identity.

## Cross-build compatibility

Reproduction command:

```text
npx --yes node@24.18.0 scripts/test-web-packaged-compatibility.mjs \
  --old-root <built-d8df9c65-root> \
  --new-root <built-7e555c7d-root> \
  --output artifacts/web-compat/d8df9c65-to-7e555c7d/report.json
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
  `artifacts/web-compat/d8df9c65-to-7e555c7d/report.json`;
- report SHA-256:
  `15911df02a9fd53654184cc2c4d99c97d67ad087b5b1559a389eb88a0651a119`.

The report deliberately contains build identities rather than local absolute
paths. The harness rejects an identical manifest or an identical stamped
commit before opening a browser.

The evidence checker also requires the current evidence tip to descend from
the new build and rejects any production or benchmark source drift after that
build. Evidence-only documentation and artifact commits may follow the bound
source commit; a source change requires a new immutable build and rerun.

## Performance and large-data evidence

Reproduction command from the clean `7e555c7d` source state:

```text
npx --yes node@24.18.0 scripts/bench-web.mjs
```

Evidence:

- JSON:
  `artifacts/web-bench/7e555c7d7f39109ee89a502f0d818cc34f1ce7fa/web-perf-v1.json`;
- human summary:
  `artifacts/web-bench/7e555c7d7f39109ee89a502f0d818cc34f1ce7fa/web-perf-v1.md`;
- JSON SHA-256:
  `183f35222fdfc35d40a965e4cd9f339df81d33cfe6f67ace91032a907d809ca5`;
- summary SHA-256:
  `006db7d1210e51c100f507c063751e4121b0571a67c2a918c37fc3f61ac1c61b`.

The schema-v4 report records:

- exact commit `7e555c7d7f39109ee89a502f0d818cc34f1ce7fa`;
- `git.dirty:false`;
- source digest
  `sha256:97076ba3daf5d08a405515cb89132f610a9b4fd04f7307d3b04d6e5123dc3e1c`;
- Node 24.18.0 and Chromium 149.0.7827.55;
- MacBook Pro / Apple M3 Pro / AC power;
- no recorded thermal or performance warning;
- 30 raw samples, 100 projects, 10,000 Runs and 2,000 graph nodes;
- a 209,410-byte gzip Simple shell;
- `structural-pass`.

This is not the RFC's canonical Mac mini M2 / 16 GiB profile. Its latency
numbers are informational even when they are below the numerical budgets.
The canonical M2 run remains a release gate. The non-canonical p95s were
1,137.5 ms cold Home, 918.5 ms warm Home, 50.3 ms cached Pro, 178.1 ms
event-to-visible, 78.3 ms commit-to-receipt, 105.3 ms receipt-to-visible,
6.7 ms list response, and 0.0805 CLS. Owner-ready and launch-to-useful p95s
were 8.779 s and 9.772 s. The report records a high pre-run load average of
9.75/8.42/7.44, so an unloaded canonical-profile rerun remains mandatory.

## Native Safari mutation smokes

Native Safari 26.3 on macOS 26.3 exercised four scoped packaged mutation
paths. Each record binds the exact source commit actually observed. The
allow/revoke-all and reject/current-session records are ancestral evidence
from `d8df9c65`; cancel was observed on `794c85f8`; peer invalidation was
observed on the final immutable source commit `7e555c7d`.

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

The independent peer-invalidation run:

- kept the native Safari tab as the target peer;
- exchanged a fresh, independent second session from a packaged CLI launch and
  invoked the CSRF-protected revoke-all endpoint through a closed P17 HTTP
  client;
- received HTTP 200 for exchange and revocation, with three sessions revoked;
- made the Safari peer lose authorization and render the localized
  current-tab session-ended screen instead of a generic page failure.

The peer mutation actor was not an unlocked Safari private window. A private
window attempt was discarded when Safari required local authentication, and
an expired capability attempt was also discarded after its expected 401.
This record proves native Safari peer invalidation and presentation, not a
two-Safari-cookie-jar usability path.

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
  `59fc96d59d12e0fdc141f840fbab7dc95fadf305a6c7d163741e054c095d25e2`.

## Remaining interpretation boundary

These local records close the latest immutable cross-build execution gap,
replace the superseded performance report, and cover the scoped native Safari
cancel and peer-invalidation cases. They do not provide:

- human product/reference approval;
- five fresh English participant results;
- two native Simplified-Chinese reviews;
- native Edge or any VoiceOver, Narrator, or NVDA evidence;
- a two-unlocked-Safari-session usability run;
- the canonical M2 performance report;
- reviewed-tip evidence or a wire-freeze decision.
