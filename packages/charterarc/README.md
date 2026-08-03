# CharterArc

CharterArc keeps declared project promises true by selecting an existing
Taskflow from observed reality:

1. observe one explicit project snapshot;
2. return immediately when reality is `satisfied` or `unknown`;
3. for confirmed drift, select the Flow whose key matches the observed target;
4. bind the target, desired promise, and snapshot into that ordinary Taskflow;
5. execute one bounded Run, then observe reality again.

```ts
import { defineProject } from "charterarc";
import type { Taskflow } from "taskflow-core";

declare const repairTypes: Taskflow;
declare const repairTests: Taskflow;

export default defineProject({
  desired: {
    types: "TypeScript contracts stay valid",
    tests: "Acceptance tests stay green",
  },
  observe: ({ cwd, signal }) => observeReality(cwd, signal),
  maintain: {
    types: repairTypes,
    tests: repairTests,
  },
});
```

The observer returns:

```ts
{
  status: "drifted",
  target: { desired: "types" },
  facts: { diagnostic: "TS2322" },
  summary: "packages/example.ts no longer typechecks"
}
```

`facts` is the explicit snapshot. A drifted snapshot must target one declared
desired key. An unbound or malformed target becomes `unknown` and starts no
Run. The selected Flow receives:

```ts
args.charterarc = {
  selection: { desired: "types", flow: "repair-types" },
  desired: "TypeScript contracts stay valid",
  snapshot: observation,
};
```

For a genuinely large project, an optional Module narrows the same mechanism:

```ts
defineProject({
  desired: {},
  maintain: {},
  modules: {
    docs: {
      desired: { catalog: "The phase catalog is complete" },
      maintain: { catalog: repairDocs },
    },
  },
  observe,
});
```

A Module is only a declaration scope. CharterArc adds no phase kind, DAG
engine, FlowIR, scheduler, host process, daemon, persistence model, or model
planner. Every selected Flow is statically verified and remains independently
executable through Taskflow.

The application injects the existing Taskflow runtime:

```ts
import { runProject } from "charterarc";
import { discoverAgents } from "taskflow-core";
import { grokSubagentRunner } from "taskflow-hosts/grok";
import project from "./project.js";

const cwd = process.cwd();
const outcome = await runProject(project, {
  taskflow: {
    cwd,
    agents: discoverAgents(cwd, "both").agents,
    runTask: grokSubagentRunner.runTask,
    usageAccounting: grokSubagentRunner.usageAccounting,
  },
});
```

CharterArc itself uses Grok Build for self-evolution. The package remains
host-neutral: other projects can inject any existing Taskflow runner.

`outcome.status` is the latest observed reality. `outcome.selection` records
which Flow was chosen, while `outcome.run` is the ordinary Taskflow result.
`outcome.ok` is true only when the latest observation is `satisfied` and the
Run, if one occurred, succeeded.

Healthy and unknown observations are fail-closed with respect to mutation:
neither starts a Run. Three retained external projects remain migration
candidates; none counts as active adoption until it uses this multi-Flow
surface in an ordinary maintenance cycle.

Install a pre-stable build with `npm install charterarc@experimental`. This
dist-tag does not promise stable compatibility; publication remains paused
until the M1 product contract passes and a fresh execution checklist is
approved.
