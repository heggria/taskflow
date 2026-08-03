# CharterArc

CharterArc keeps one project promise true:

1. observe reality;
2. run one ordinary Taskflow only when drift is confirmed;
3. observe reality again.

```ts
import { defineProject } from "charterarc";
import maintain from "./maintain.js";

export default defineProject({
  desired: "main is releasable",
  observe: ({ cwd, signal }) => observeReality(cwd, signal),
  maintain,
});
```

`maintain` is a normal Taskflow value, including one compiled from `.tf.ts`.
Its existing `name` is the project's only machine identity; CharterArc does
not ask the declaration to name the same thing twice.
CharterArc adds no observer registry, phase kind, scheduler, host process,
daemon, persistence model, or second IR. The declaration contains its own
domain check; the application supplies only the existing Taskflow runtime:

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

This repository's self-evolution path uses Grok Build only. CharterArc itself
stays host-neutral: an application can inject another existing Taskflow runner
for a different, non-self-evolution use case.

The observer receives the project `cwd` and an abort `signal`. It returns only
`status` (`satisfied`, `drifted`, or `unknown`) and an optional `summary`.

- satisfied: return without a Run;
- unknown: return without mutation;
- drifted: pass the observation through `args.charterarc`, execute the
  maintenance Taskflow once, then observe again.

`runProject` owns that injected argument; maintenance flows do not repeat an
`args.charterarc` schema entry.

`outcome.status` reports the latest observed reality. It does not claim that
the Run caused that state; inspect `outcome.run?.ok` separately. `before` and
`after` are the corresponding observation results. Fail-closed cycle success is
`outcome.ok`: true only when the latest observation is `satisfied` and any
maintenance Run also succeeded.

`outcome.run?.usage` exposes the ordinary Taskflow Run's aggregated usage.
Read it together with `outcome.run?.usageAccounting`: a nonzero Grok value is
observed evidence, while `unavailable` means missing or zero fields are unknown
and cannot authorize a token or USD budget.

Repository, packed-consumer, and cross-repository experiments each bound one
project to one domain observer; none used a name registry. Three retained external projects
already use the private package; an explicit release decision is still required before
it leaves that private boundary.
