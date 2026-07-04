# Architecture Decisions (taskflow)

> Status: **living document**. Records the structural decisions behind the
> multi-host layout (taskflow-core / taskflow-mcp / pi-taskflow /
> codex-taskflow / claude-taskflow / opencode-taskflow), the trade-offs that
> were considered, and the direction to take as the host count grows.
>
> Written as the output of the PR #26 (claude + opencode hosts) architecture
> review. This is *not* a changelog — it captures *why* the structure is what
> it is and *what* should change next.

---

## The invariant that must never break

**The engine (`taskflow-core/src/runtime.ts`) is host-agnostic.** It speaks
only to the `SubagentRunner` contract (`runTask → RunResult`). Adding 4 hosts
(codex, claude, opencode, + pi) changed **zero** lines of engine code. Any
future restructuring MUST preserve this seam — it is the single reason a host
SDK breaking change cannot force an engine release.

Consequence: the spawn/classify/idle-watchdog boilerplate that every host
runner needs MUST stay funneled through the single `runSubagentProcess` in
`runner-core.ts`. A new host that copy-pastes its own process lifecycle is a
bug waiting to happen (the original 3-way copy-paste already diverged on
`contextTokens`). **One process lifecycle, ever.**

---

## Decision A — taskflow-hosts: a shared host-runner package (DONE)

### Status
**Implemented.** The three host runners (codex / claude / opencode) now live
in a single `taskflow-hosts` package. The three legacy delivery packages
(`codex-taskflow` / `claude-taskflow` / `opencode-taskflow`) keep their npm
names, install paths, version pins, and plugin scaffolds, and import their
runner from `taskflow-hosts`; each also re-exports the runner so its existing
public surface (`import ... from "codex-taskflow"`) is unchanged. A 4th host
now lands as one `<host>-runner.ts` in `taskflow-hosts`, not a whole new
runner-owning package.

### Context
codex-taskflow, claude-taskflow, and opencode-taskflow are each published as a
**separate npm package**. This was reasonable at 1 host (codex) and tolerable
at 3. The review's concern: at ~10–15 hosts this becomes the dominant
maintenance cost.

### The tension
There is a *real* reason adapters look like independent packages: each is a
host ecosystem's delivery artifact (`codex plugin add taskflow@taskflow`,
`npm i -g codex-taskflow`, an MCP server a user points their client at). But
there is *no* reason their release cadence is independent — adapters almost
never change except when `taskflow-core`'s contract changes or a host CLI
changes its flags. Today all six packages are **lockstep versioned** at the
same number, which makes a per-package semver meaningless: a codex flag fix
forces a new version of the untouched core engine.

### Cost projection at N hosts
| | 3 hosts (now) | 12 hosts |
|---|---|---|
| npm publishes per release | 6 | 15 |
| `package.json` to keep version-pinned | 6 | 15 |
| README/CHANGELOG to keep in sync | 6 | 15 |
| npm names consumed (`*-taskflow`) | 3 | 12 |

### Decision
**Keep the three existing packages for backward compatibility** (their names
are already in `codex plugin add`, `npm i` commands, user configs). **Do NOT
create a new package per future host.** Instead, introduce a single
**`taskflow-hosts`** package that re-exports all host runners + their MCP bins
from one published unit:

```
taskflow-hosts
├─ codex-runner.ts        ← re-export from codex-taskflow (existing)
├─ claude-runner.ts       ← re-export from claude-taskflow (existing)
├─ opencode-runner.ts     ← re-export from opencode-taskflow (existing)
├─ <future-host-a>.ts     ← lives here directly
├─ mcp/                   ← one thin bin per host
└─ test/                  ← all host arg-contract tests
```

- Publishes: `core → mcp → hosts` (3 publishes), not `core → mcp → ×N`.
- Future hosts ship in `taskflow-hosts` and are discovered via
  `npx -p taskflow-hosts <host>-mcp` or static import.
- The three legacy packages can later become thin re-exports of
  `taskflow-hosts` (deprecated in their READMEs) without breaking the install
  commands users already have.

### Trigger to act
✅ Done at 3 hosts (the moment adoption is lowest, so the migration is
cheapest). `taskflow-hosts` now exists; future hosts go here.

### What we explicitly reject
- **A unified `HostConfig` interface / generic command-builder.** Each host's
  argv genuinely differs (codex pastes the prompt; claude uses
  `--append-system-prompt`; opencode uses `provider/model` ids where codex/claude
  use flat ids; permission models are sandbox vs `--allowedTools` vs `--auto`).
  Forcing these into one interface produces an abstraction with a per-host
  parameter for every flag — more complex than the three ~15-line builders it
  replaces. Instead: each host owns a **pure, exported `buildXxxArgs`** builder
  (extracted in this PR) that is independently unit-tested. Shared *shape*,
  not shared *code*.

---

## Decision B — host CLI contracts are locked by unit tests, not e2e

### Context
The executor e2e suites (`e2e-codex.mts`, `e2e-claude.mts`, `e2e-opencode.mts`)
spawn a **live** host CLI and need auth + spend tokens, so they never run in
CI. That left each host's argv construction (the `--json` / `--format json` /
`--output-format stream-json` flags, the permission→flag mapping, the
model-id resolution rules) **completely untested in CI**. A host renaming a
flag would only be caught by a user at runtime.

### Decision
Each host runner exposes a **pure `buildXxxArgs(ctx)`** (no `process.env`, no
spawn) plus its already-pure permission/model helpers, and these are covered by
`*-args.test.ts` files that run in the normal CI unit glob. The tests pin:

- the exact leading flags (`exec --json --skip-git-repo-check`, `-p --output-format stream-json --verbose --strict-mcp-config`, `run <prompt> --format json`);
- the permission mapping (read-only vs mutating whitelists → the right flag);
- model-id resolution (flat vs `provider/` path vs `{{placeholder}}` → pass-through vs drop);
- bin resolution (default + `PI_TASKFLOW_*_BIN` override).

The live e2e suites still exist (they verify the *event-stream parser* against
real captured fixtures and the real handshake), but the *flag contract* is now
CI-checked. A flag rename trips a unit test, not a user.

### What we explicitly reject
- Dropping the live e2e suites. They remain the only thing that catches a host
  changing its **event-stream JSON schema** (which `buildXxxArgs` cannot see).
  Two layers: unit (flag contract) + manual e2e (stream schema). Neither
  replaces the other.

---

## Decision C — structured run-log header is opt-in, stderr-only

### Context
Cross-host debugging ("why did my flow fail?") previously had only
`taskflow_peek` (phase output) and a 64KB-capped raw stderr per child. With 4
hosts, each child's stderr has a different CLI prefix (`codex exec`, `claude
-p`, `opencode run`), making it hard to tell which agent/bin produced a given
error blob.

### Decision
`runSubagentProcess` emits a structured header
`[taskflow:run] agent=<name> bin=<bin> model=<model> args=[...]` to the
**host process's stderr**, gated by `PI_TASKFLOW_RUN_LOG=1` and **default-off**.

- It is **never** written to stdout (stdout is the JSON-RPC channel for the
  MCP server; polluting it would break the protocol). This is pinned by a test.
- Default-off so it adds zero noise to a normal run; an operator turns it on
  when debugging.
- Lives in the one shared `runSubagentProcess` so all hosts get it for free —
  no per-host logging code to drift.

---

## Things deliberately left as-is (recorded so they aren't re-litigated)

- **`runner-core.ts` lives in `taskflow-core`.** It is host-neutral (no host
  SDK import — only `node:child_process`), so keeping it in core does not
  violate the "core has zero host-SDK deps" rule. Moving it out (e.g. into
  `taskflow-mcp`) would force every host adapter to depend on a second package
  for no benefit.
- **Skill generation is single-sourced** (`skills-src/` + `build-skills.mjs` +
  a drift-guard test). New hosts add one `entry.<host>.md` and extend the
  comma host list; the skill body is shared. Do not per-host the skill body.
- **MCP server is its own package (`taskflow-mcp`)** — a pure presentation
  layer over core. Pi users never pull MCP code. This boundary is correct.
- **Lockstep versioning is kept for now** (all packages share a version). It is
  crude but it is *less* work than tracking which subset of packages need a
  given bump, and at 6 packages the cost is low. Revisit when `taskflow-hosts`
  exists and core can finally move on its own cadence.

---

## Test-suite layering (current, acceptable)

| Layer | What | Runs in CI? |
|---|---|---|
| Unit | parsers, builders, permission/model helpers, verify, interpolate, cache | yes (`*.test.ts` glob) |
| Shared-process | `runSubagentProcess` spawn/idle/abort/classify | yes (`runner-process.test.ts`) |
| Arg-contract | each host's `buildXxxArgs` flag contract | **yes (added in this PR)** |
| E2E (stream schema + live handshake) | real host CLI over stdio | **manual** (needs auth/tokens) |

Full suite is ~1090 unit tests in ~25s on CI across node 22 + 24. Adding a
host now costs ~12 arg-contract tests (a few ms), not a new e2e job. This
scales fine to ~20 hosts.
