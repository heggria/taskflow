# 0.3.0-beta.2 immutable candidate evidence v1

Status: local candidate evidence; not reviewed-tip, Conforming, wire-frozen, or
release evidence.

## Bound candidates

| Role | Git commit | Web manifest SHA-256 |
|---|---|---|
| old | `83021958b61d65425847817f3b5d275bd048979a` | `sha256:4f2107eb0b1065315929f6c060031a90f05cc329df9229eb3f01d314ed47de87` |
| new | `184fb5af9ee2f678e57ff33adc01e6c38fda1e59` | `sha256:e14f395eaec7b29cbae07f8ba89dca2c21f9f1b82766d0cb01d0580b1db1f13f` |

Both builds were produced from detached worktrees with
`pnpm install --offline --frozen-lockfile` followed by `pnpm run build`.
`taskflow-core/dist/build-info.json` supplies the immutable commit identity;
the signed Web asset manifest supplies the independently distinct asset
identity.

## Cross-build compatibility

Reproduction command:

```text
npx --yes node@24.18.0 scripts/test-web-packaged-compatibility.mjs \
  --old-root <built-83021958-root> \
  --new-root <built-184fb5af-root> \
  --output artifacts/web-compat/83021958-to-184fb5af/report.json
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
  `artifacts/web-compat/83021958-to-184fb5af/report.json`;
- report SHA-256:
  `f3275ecadf0eeaa47c845c0b02ca61e602a6bbaf9241dfe6ea5da6e94a9c4c06`.

The report deliberately contains build identities rather than local absolute
paths. The harness rejects an identical manifest or an identical stamped
commit before opening a browser.

The evidence checker also requires the current evidence tip to descend from
the new build and rejects any production or benchmark source drift after that
build. Evidence-only documentation and artifact commits may follow the bound
source commit; a source change requires a new immutable build and rerun.

## Performance and large-data evidence

Reproduction command from the clean `184fb5af` detached worktree:

```text
npx --yes node@24.18.0 scripts/bench-web.mjs
```

Evidence:

- JSON:
  `artifacts/web-bench/184fb5af9ee2f678e57ff33adc01e6c38fda1e59/web-perf-v1.json`;
- human summary:
  `artifacts/web-bench/184fb5af9ee2f678e57ff33adc01e6c38fda1e59/web-perf-v1.md`;
- JSON SHA-256:
  `2845eb2f47bea3448c071bf5aa8d0292ba486051fd3a68b7da68b762ad9f6462`;
- summary SHA-256:
  `65af3f3585d19513ee04e47d904df51a0654542d17fd74237217b71d5474f668`.

The schema-v4 report records:

- exact commit `184fb5af9ee2f678e57ff33adc01e6c38fda1e59`;
- `git.dirty:false`;
- source digest
  `sha256:a411eb10d10229eed5e84c61712d635c42e0ff60c6cccb18fdef6d6ead764902`;
- Node 24.18.0 and Chromium 149.0.7827.55;
- MacBook Pro / Apple M3 Pro / AC power;
- no recorded thermal or performance warning;
- 30 raw samples, 100 projects, 10,000 Runs and 2,000 graph nodes;
- a 209,367-byte gzip Simple shell;
- `structural-pass`.

This is not the RFC's canonical Mac mini M2 / 16 GiB profile. Its latency
numbers are informational even when they are below the numerical budgets.
The canonical M2 run remains a release gate. The non-canonical p95s were
1,217.9 ms cold Home, 465.0 ms warm Home, 24.4 ms cached Pro, 225.9 ms
event-to-visible, 81.5 ms commit-to-receipt, 161.3 ms receipt-to-visible,
8.5 ms list response, and 0.0742 CLS. Owner-ready and launch-to-useful p95s
were 18.286 s and 19.132 s. The report records a high pre-run load average of
11.69/7.97/7.26 and large process-owner launch outliers. Those startup
measurements are not hidden or promoted to release evidence; they make an
unloaded canonical-profile rerun especially important.

## Native Safari mutation smoke

Native Safari 26.3 on macOS 26.3 exercised the packaged `184fb5af` source
through a fresh isolated control store. The scoped run:

- exchanged an independent one-time launch capability;
- exposed the approval question and both allow/reject consequences;
- activated Allow from native keyboard focus and showed duplicate-safe pending
  copy;
- reached a completed task with 3/3 steps, partial verification, and result
  `published`;
- exposed the listener-wide revocation consequence, applied it, and rendered a
  deterministic localized signed-out screen instead of a false command error;
- interrupted the review hold and verified that its listener refused a
  subsequent connection.

Evidence:

- record:
  `docs/internal/webui/native-safari-mutation-smoke-v1.json`;
- record SHA-256:
  `b07732984e07739515f20604e0f5478092b5d1af2d3c6a6cccda53fd911a173e`.

This is a native AX/keyboard mutation smoke, not a VoiceOver attestation. It
does not claim native Safari reject, cancel-run, current-session logout,
independent peer-session invalidation, console/CSP automation, or human
approval.

## Remaining interpretation boundary

These local records close the first immutable cross-build execution gap and
replace working-tree-only performance evidence. They do not provide:

- human product/reference approval;
- five fresh English participant results;
- two native Simplified-Chinese reviews;
- native Edge; the remaining native Safari mutation/session cases; VoiceOver,
  Narrator, or NVDA evidence;
- the canonical M2 performance report;
- reviewed-tip evidence or a wire-freeze decision.
