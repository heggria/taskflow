# taskflow-hosts

> Shared host-runner collection for [taskflow](https://github.com/heggria/taskflow).

This package holds the `SubagentRunner` implementations for taskflow's non-pi
hosts — **codex**, **claude**, and **opencode** — plus their pure argv builders
(`buildCodexArgs` / `buildClaudeArgs` / `buildOpencodeArgs`) and event-stream
parsers. It is the **single place** host runners live; a new host adds a
`<host>-runner.ts` here.

## Why a separate package

Each host has two halves:

1. **The runner** — spawn that host's CLI, fold its JSON event stream into a
   host-neutral `RunResult`, classify the outcome. + the pure argv builder +
   permission/model helpers.
2. **The delivery** — the per-host MCP server + bin + plugin scaffold, which is
   that host ecosystem's install target (`codex plugin add`, `claude plugin
   install`, OpenCode config).

Half #1 is nearly identical in *shape* across hosts and changes for the same
reasons (a `taskflow-core` contract change, or a host CLI flag change). Half #2
is genuinely host-specific (different install mechanisms, different plugin
manifests). So #1 is collected here; #2 stays in `codex-taskflow` /
`claude-taskflow` / `opencode-taskflow`, which import their runner from this
package.

## Install

You usually don't install this directly — install the host delivery package:

```bash
npm install -g codex-taskflow     # or claude-taskflow / opencode-taskflow
```

For code-level use:

```bash
npm install taskflow-hosts
```

## Usage

```ts
// one host, tree-shaken:
import { codexSubagentRunner, buildCodexArgs } from "taskflow-hosts/codex";

// or the barrel:
import { claudeSubagentRunner, opencodeSubagentRunner } from "taskflow-hosts";
```

Each runner export includes: the `SubagentRunner` (`codexSubagentRunner` / …),
the `runXxxAgentTask` function, the pure `buildXxxArgs` builder, the
`foldXxxEventLine` parser + `newXxxAccumulator`, and the permission/model
helpers (`sandboxForTools`, `permissionArgsForTools`, `isReadOnlyPhase`,
`resolveXxxModel`, `xxxBin`).

## Adding a host

1. Add `<host>-runner.ts` in `src/` (model it on an existing one — a pure
   `buildXxxArgs` + the event parser + a `SubagentRunner` export).
2. Add an export entry in `src/index.ts`.
3. Add `*-runner.test.ts` (event-stream parser) + `*-args.test.ts` (argv
   contract — CI-locked) in `test/`.
4. The host's *delivery* (MCP server/bin + plugin scaffold) goes in a
   `taskflow-hosts`-depending package of its own.

See [`AGENTS.md`](../../AGENTS.md) and [`DECISIONS.md`](../../DECISIONS.md) in
the repo root for the full architecture and the packaging decision.

## License

MIT
