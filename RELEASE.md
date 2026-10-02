# Taskflow 1.0 release guide

This guide coordinates the ten-package Taskflow `1.0.0` release. Preparing
or merging a release change does not publish it. Publish only after the gates
below pass on the final release commit and the release owner authorizes the
tag. GitHub Releases and the npm registry record the completed publication.

## Public contract and package set

The stable contract is the existing declarative DAG runtime: twelve phase
kinds, validation/planning, retries and budgets where the host can enforce
them, Pi interactive approvals, resume/recompute/replay, background runs,
trace, the TypeScript DSL, and resource transactions for admitted declared
filesystem targets. MCP/headless approval phases reject automatically. Host
permissions and usage reporting remain host-specific; Grok rejects budgets
because its stream does not supply reliable usage.

The ten packages below publish together at exactly `1.0.0`, in this order:

1. `taskflow-core`
2. `taskflow-mcp-core`
3. `taskflow-hosts`
4. `taskflow-dsl`
5. `pi-taskflow`
6. `codex-taskflow`
7. `claude-taskflow`
8. `opencode-taskflow`
9. `grok-taskflow`
10. `hermes-taskflow`

Root and package versions, Codex/Claude/Grok plugin versions, and every host
MCP template pin must match. Local internal dependencies stay `workspace:*`;
the deterministic packer rewrites them to the exact release version. Published
exports must use shipped JavaScript/declarations and never source-only
`development` conditions. Codex/Claude/Grok plugin scaffolds are distributed
from the repository, separately from their npm delivery packages.

`taskflow-control` is private, workspace-only and experimental. Its Unix UDS
and store implementation does not constitute a complete control plane:
BoundPlan admission, authorized command-result replay, global concurrency, parked approvals/CAS/receipts,
registry coordination, Windows named pipes and WebUI are incomplete.
CharterArc retains its separate experimental version/tag/workflow and is
excluded from the ten-package transaction. These packaging boundaries do not
waive accepted specifications: 1.0 publication remains blocked on their
implementation and acceptance. Resolve-only path checks are not an OS sandbox; undeclared
writes remain host-policy dependent. SecretRef/ServiceRef have no live
vault/service backend. High-scale journals and full kernel parity are not
claimed; the optional event kernel still falls back for unsupported features.

## Required preparation and verification

Use the repository-pinned pnpm and Node **22.19.0 or newer**. Run the full unit
suite on Node 22 and Node 24; keep the three-OS process-supervisor checks and
Pi SDK compatibility matrix. Save commands, exit status, host/SDK/model
versions and final commit SHA in `docs/internal/1.0.0-ga-scoreboard.md`.

```sh
pnpm install --frozen-lockfile --registry https://registry.npmjs.org/
node scripts/verify-release-contract.mjs --candidate
pnpm run typecheck
pnpm test
pnpm run build
node scripts/pack-release-packages.mjs .release-tarballs
node scripts/smoke-packed-packages.mjs .release-tarballs
pnpm run test:pack-charterarc
pnpm --filter taskflow-dsl run test:e2e
pnpm run test:e2e-codex-mcp
pnpm run test:e2e-codex-mcp-full
pnpm run test:e2e-claude-mcp
pnpm run test:e2e-opencode-mcp
pnpm run test:e2e-grok-mcp
pnpm run test:e2e-hermes-mcp
pnpm audit --prod
TASKFLOW_BASE_PATH=/taskflow pnpm --dir website run build
```

The package gate repeat-packs deterministic bytes, clean-installs all ten
local tarballs, rejects leaked workspace ranges, and exercises public exports
and bins. It must also be run on Node 24. Source or fixture checks alone do not
prove an installed adapter can drive its real host.

Before approval, test the packed Pi extension against Pi 1.0 with a real
process, run identity, terminal completion/reap, retry, context tools and
resume. Verify the Pi TUI (approve/reject/edit, long proposal scrolling,
confirmation, Escape/Ctrl-C, timeout) and RPC/headless approval rejection.
Run live executor E2E for every available supported host using isolated profiles
and declared model/binary overrides:

```sh
pnpm run test:e2e-pi
node --conditions=development --experimental-strip-types packages/pi-taskflow/test/e2e.mts
pnpm run test:e2e-pi-terminal-reap
pnpm run test:e2e-codex
pnpm run test:e2e-claude
pnpm run test:e2e-opencode
pnpm run test:e2e-grok
```

Hermes currently has an MCP fixture suite, not a checked-in live executor E2E;
perform and record an installed Hermes list/verify/run round trip before
claiming live Hermes acceptance. Missing binaries, credentials or model access
are blocked checks, not passes. Process-fixture results and historical live
results must be labeled separately. Re-run SIGKILL recovery, writer races,
resource restoration, cancellation, descendant cleanup and detached resume
coverage in the full suite. Unix control transport tests stay Unix-only.

For each changed capability, update `skills-src/taskflow/`, run
`pnpm run build:skills`, and verify the generated host skill drift guard. Keep
Plugin Security Scan's score 80/high-severity gate and completed Cisco skill
coverage, plus CodeQL and all required exact-SHA CI jobs.

## Authorized tag and publish

After review, all exact-SHA checks and the required live/TUI evidence pass,
merge to `main`, rerun required checks there, and replace the `1.0.0` changelog
heading's `Unreleased` with the actual release date. Commit that change and
verify `node scripts/verify-release-contract.mjs --published`. The release
owner may then push annotated `v1.0.0` from that verified main commit.

`.github/workflows/publish.yml` alone publishes. It verifies tag/main ancestry,
the dated changelog, versions/pins, immutable reproducible packed consumers,
then publishes the ten packages with provenance to npm `latest`. Registry
owner, workflow/source commit and exact tarball integrity are verified for
every package, including already-existing versions on a rerun. A separate
least-privilege job creates the non-draft, non-prerelease GitHub Release only
after all package verification succeeds. A partial set is incomplete: repair
and rerun the same workflow; never replace the tag or manually publish a
missing adapter. The legacy beta dist-tag promotion workflow is not needed.

## Install and verify after publication

Use exact 1.0 pins for host installation, then verify the installed version:

```sh
pi install npm:pi-taskflow@1.0.0
codex plugin marketplace add heggria/taskflow
codex plugin add taskflow@taskflow
claude plugin marketplace add heggria/taskflow
claude plugin install claude-taskflow@taskflow
opencode mcp add taskflow -- npx -y -p opencode-taskflow@1.0.0 opencode-taskflow-mcp
grok mcp add taskflow -- npx -y -p grok-taskflow@1.0.0 grok-taskflow-mcp
hermes mcp add taskflow --command npx --args -y -p hermes-taskflow@1.0.0 hermes-taskflow-mcp
```

Verify all ten npm versions and `dist-tags.latest=1.0.0`, the completed publish
workflow, exact tag commit and stable GitHub Release, then installed
`taskflow_version=1.0.0`. Keep `.pi/taskflows/` and run history when upgrading.
Pin a previous complete ten-package version set to roll back, restart/reload
the host registrations, and verify their reported version. Do not mix adapter
and shared package versions; inspect definitions for fields unsupported by
the selected earlier release before rerunning them.
