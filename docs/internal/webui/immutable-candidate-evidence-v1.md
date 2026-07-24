# 0.3.0-beta.2 immutable candidate evidence v1

Status: local candidate evidence; not reviewed-tip, Conforming, wire-frozen, or
release evidence.

## Bound candidates

| Role | Git commit | Web manifest SHA-256 |
|---|---|---|
| old | `83021958b61d65425847817f3b5d275bd048979a` | `sha256:4f2107eb0b1065315929f6c060031a90f05cc329df9229eb3f01d314ed47de87` |
| new | `d8df9c650b68e4c0854aaad03e6da3ce0dc3352f` | `sha256:e14f395eaec7b29cbae07f8ba89dca2c21f9f1b82766d0cb01d0580b1db1f13f` |

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
  --new-root <built-d8df9c65-root> \
  --output artifacts/web-compat/83021958-to-d8df9c65/report.json
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
  `artifacts/web-compat/83021958-to-d8df9c65/report.json`;
- report SHA-256:
  `8f681f6cde03b41ebf52e79f1ce86b42958d7972e267f95501c8f4c209891ef4`.

The report deliberately contains build identities rather than local absolute
paths. The harness rejects an identical manifest or an identical stamped
commit before opening a browser.

The evidence checker also requires the current evidence tip to descend from
the new build and rejects any production or benchmark source drift after that
build. Evidence-only documentation and artifact commits may follow the bound
source commit; a source change requires a new immutable build and rerun.

## Performance and large-data evidence

Reproduction command from the clean `d8df9c65` detached worktree:

```text
npx --yes node@24.18.0 scripts/bench-web.mjs
```

Evidence:

- JSON:
  `artifacts/web-bench/d8df9c650b68e4c0854aaad03e6da3ce0dc3352f/web-perf-v1.json`;
- human summary:
  `artifacts/web-bench/d8df9c650b68e4c0854aaad03e6da3ce0dc3352f/web-perf-v1.md`;
- JSON SHA-256:
  `8dc2a14652caa24f95c69799280065bf4f67d6b4f00646f4fd0e7170b64082b8`;
- summary SHA-256:
  `f66d7ace514bd776850db251435cf95761524650c72c802b8c75194ccc2fdc39`.

The schema-v4 report records:

- exact commit `d8df9c650b68e4c0854aaad03e6da3ce0dc3352f`;
- `git.dirty:false`;
- source digest
  `sha256:648b778e4e316be5f93e4ef2b68c07ba45bea4d0d2731a9dc2d471ec3b18c0b3`;
- Node 24.18.0 and Chromium 149.0.7827.55;
- MacBook Pro / Apple M3 Pro / AC power;
- no recorded thermal or performance warning;
- 30 raw samples, 100 projects, 10,000 Runs and 2,000 graph nodes;
- a 209,367-byte gzip Simple shell;
- `structural-pass`.

This is not the RFC's canonical Mac mini M2 / 16 GiB profile. Its latency
numbers are informational even when they are below the numerical budgets.
The canonical M2 run remains a release gate. The non-canonical p95s were
1,268.1 ms cold Home, 904.7 ms warm Home, 30.7 ms cached Pro, 151.1 ms
event-to-visible, 76.9 ms commit-to-receipt, 95.0 ms receipt-to-visible,
8.6 ms list response, and 0.0784 CLS. Owner-ready and launch-to-useful p95s
were 25.700 s and 27.175 s. The report records a high pre-run load average of
8.05/8.69/8.62 and large process-owner launch outliers. Those startup
measurements are not hidden or promoted to release evidence; they make an
unloaded canonical-profile rerun especially important.

## Native Safari mutation smokes

Native Safari 26.3 on macOS 26.3 exercised the packaged `d8df9c65` source
through separate fresh isolated control stores. The allow/revoke-all run:

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

The reject/current-session run:

- reached both decision controls through native Tab focus and activated Reject
  with the keyboard;
- authoritatively settled the task as unable to continue, with 1/3 steps,
  `publish review` blocked, downstream pending, verification unavailable, and
  result `approval rejected`;
- exposed the current-session consequence, ended only that session, and
  rendered the localized current-tab signed-out screen;
- interrupted the review hold and verified that its listener refused a
  subsequent connection.

Evidence:

- record:
  `docs/internal/webui/native-safari-mutation-smoke-v1.json`;
- record SHA-256:
  `e949c3f3573c73dcf4d057245309f183917cfe25350025fe98a3a68c35a95540`;
- reject/current-session record:
  `docs/internal/webui/native-safari-reject-current-session-smoke-v1.json`;
- reject/current-session record SHA-256:
  `e3d9a1c26bcba19d5b2c6deaab28212420e3a61663fb991b5c6ab4eb8a07497c`.

These are native AX/keyboard mutation smokes, not VoiceOver attestations. They
do not claim native Safari cancel-run, independent peer-session invalidation,
console/CSP automation, or human approval. The reject record also retains one
discarded automation-only address-field attempt; no passing assertion derives
from it.

## Remaining interpretation boundary

These local records close the first immutable cross-build execution gap and
replace working-tree-only performance evidence. They do not provide:

- human product/reference approval;
- five fresh English participant results;
- two native Simplified-Chinese reviews;
- native Edge; native Safari cancel-run and independent peer-session
  invalidation; VoiceOver, Narrator, or NVDA evidence;
- the canonical M2 performance report;
- reviewed-tip evidence or a wire-freeze decision.
