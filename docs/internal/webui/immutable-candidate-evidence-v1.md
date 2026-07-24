# 0.3.0-beta.2 immutable candidate evidence v1

Status: local candidate evidence; not reviewed-tip, Conforming, wire-frozen, or
release evidence.

## Bound candidates

| Role | Git commit | Web manifest SHA-256 |
|---|---|---|
| old | `83021958b61d65425847817f3b5d275bd048979a` | `sha256:4f2107eb0b1065315929f6c060031a90f05cc329df9229eb3f01d314ed47de87` |
| new | `fb765b21cc284cf70e84a577f190c4bce38d0a79` | `sha256:d5c093782d9d10f266b82d1f1361e27032404220d3d6abbca31d8157cfa5df03` |

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
  --new-root <built-fb765b21-root> \
  --output artifacts/web-compat/83021958-to-fb765b21/report.json
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
  `artifacts/web-compat/83021958-to-fb765b21/report.json`;
- report SHA-256:
  `240344084a196829ec5f9fa504da6cb996ed4c73f9df05065a1bf3d468873c2c`.

The report deliberately contains build identities rather than local absolute
paths. The harness rejects an identical manifest or an identical stamped
commit before opening a browser.

## Performance and large-data evidence

Reproduction command from the clean `fb765b21` detached worktree:

```text
npx --yes node@24.18.0 scripts/bench-web.mjs
```

Evidence:

- JSON:
  `artifacts/web-bench/fb765b21cc284cf70e84a577f190c4bce38d0a79/web-perf-v1.json`;
- human summary:
  `artifacts/web-bench/fb765b21cc284cf70e84a577f190c4bce38d0a79/web-perf-v1.md`;
- JSON SHA-256:
  `57b711050516c941cd33afc6df95fa8f6793b93a1f211e272cfaa5b78828c8f4`;
- summary SHA-256:
  `e517212b26e62a49e22468f67ccbc539089abbd1dcc61879b831ed0465dda9cb`.

The schema-v4 report records:

- exact commit `fb765b21cc284cf70e84a577f190c4bce38d0a79`;
- `git.dirty:false`;
- source digest
  `sha256:3863805d98bfbd34856589501cc9ce3ab589c64365e380ed36e7e6fdde2f910c`;
- Node 24.18.0 and Chromium 149.0.7827.55;
- MacBook Pro / Apple M3 Pro / AC power;
- no recorded thermal or performance warning;
- 30 raw samples, 100 projects, 10,000 Runs and 2,000 graph nodes;
- `structural-pass`.

This is not the RFC's canonical Mac mini M2 / 16 GiB profile. Its latency
numbers are informational even when they are below the numerical budgets.
The canonical M2 run remains a release gate.
The non-canonical event-to-visible p95 was 574.6 ms, above the RFC's
250 ms canonical budget. It is therefore informational rather than a pass or
failure, and makes the canonical-profile rerun especially important.

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
