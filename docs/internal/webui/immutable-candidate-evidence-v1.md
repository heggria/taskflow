# 0.3.0-beta.2 immutable candidate evidence v1

Status: local candidate evidence; not reviewed-tip, Conforming, wire-frozen, or
release evidence.

## Bound candidates

| Role | Git commit | Web manifest SHA-256 |
|---|---|---|
| old | `83021958b61d65425847817f3b5d275bd048979a` | `sha256:4f2107eb0b1065315929f6c060031a90f05cc329df9229eb3f01d314ed47de87` |
| new | `33202a9c26e2d3b86d8d661a09b4c9ef5f9a56e2` | `sha256:d5c093782d9d10f266b82d1f1361e27032404220d3d6abbca31d8157cfa5df03` |

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
  --new-root <built-33202a9c-root> \
  --output artifacts/web-compat/83021958-to-33202a9c/report.json
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
  `artifacts/web-compat/83021958-to-33202a9c/report.json`;
- report SHA-256:
  `795d985d13877bfd71f9915fe339483f24f14e64b70359978d5af2ff0b1ad1d3`.

The report deliberately contains build identities rather than local absolute
paths. The harness rejects an identical manifest or an identical stamped
commit before opening a browser.

## Performance and large-data evidence

Reproduction command from the clean `33202a9c` detached worktree:

```text
npx --yes node@24.18.0 scripts/bench-web.mjs
```

Evidence:

- JSON:
  `artifacts/web-bench/33202a9c26e2d3b86d8d661a09b4c9ef5f9a56e2/web-perf-v1.json`;
- human summary:
  `artifacts/web-bench/33202a9c26e2d3b86d8d661a09b4c9ef5f9a56e2/web-perf-v1.md`;
- JSON SHA-256:
  `762a656d8c6c9f221f574301a0cbd1c23083fd6339b2c6a4c8f7167377ab6631`;
- summary SHA-256:
  `a2dc6bad724bb2acafee4835ba3044a5665fa14418ad698f0cb543ebf89e45a8`.

The schema-v4 report records:

- exact commit `33202a9c26e2d3b86d8d661a09b4c9ef5f9a56e2`;
- `git.dirty:false`;
- source digest
  `sha256:1d270e9e8c755ea1373b1e0ca524e5b37394b0522ec64d970057a6b7ca85a282`;
- Node 24.18.0 and Chromium 149.0.7827.55;
- MacBook Pro / Apple M3 Pro / AC power;
- no recorded thermal or performance warning;
- 30 raw samples, 100 projects, 10,000 Runs and 2,000 graph nodes;
- `structural-pass`.

This is not the RFC's canonical Mac mini M2 / 16 GiB profile. Its latency
numbers are informational even when they are below the numerical budgets.
The canonical M2 run remains a release gate.

## Remaining interpretation boundary

These local records close the first immutable cross-build execution gap and
replace working-tree-only performance evidence. They do not provide:

- human product/reference approval;
- five fresh English participant results;
- two native Simplified-Chinese reviews;
- native Edge, full native Safari mutation, VoiceOver, Narrator, or NVDA
  evidence;
- the canonical M2 performance report;
- reviewed-tip evidence or a wire-freeze decision.
