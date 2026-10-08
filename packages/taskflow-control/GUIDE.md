# Taskflow control plane

The implementation lives in a private workspace, but its compiled control and
project-administration binaries ship inside the existing `taskflow-mcp-core`
public package. No `taskflow-control` registry package is needed. The current
1.0.0 candidate is unreleased; publication and new-head CI remain separate gates.

A local candidate can be installed from its `taskflow-core` and
`taskflow-mcp-core` tarballs plus TypeBox, with npm lifecycle scripts disabled.
The control entry is `node_modules/taskflow-mcp-core/dist/control/control-cli.js`,
also linked as `node_modules/.bin/taskflow-control`. This guide is shipped as
`taskflow-mcp-core/CONTROL_GUIDE.md`. After authorized publication, install with
`npm install --save-exact taskflow-mcp-core@1.0.0 typebox@1.3.30`.

The control service mounts explicitly configured projects and routes requests by
their durable project identity. It authenticates local clients, rereads policy,
persists command results, coordinates capacity, and executes through the existing TE
runtime. Durable approval waits can survive an owner crash without repeating completed
phases. Receipts and explanations come from the project journal and runtime evidence.

## Local use

Use Node 22.19 or later. Keep the control home outside every execution project.

```sh
taskflow-control run --root /path/project --flow /path/flow.json --control-home /path/control-home
taskflow-control serve --root /path/project --root /path/another --control-home /path/control-home --console
taskflow-control status --root /path/project --control-home /path/control-home
taskflow-control mcp --root /path/project --control-home /path/control-home
```

`auto` starts an owner or attaches to the existing owner. `coordinated` requires an
existing owner; it does not silently start a standalone service. The console prints
a private handoff-file path. Its one-use browser token is not placed in a URL or
printed to stdout. Local policy files under the control home are checked on each
operation. The CLI runs scripts; embedded callers must configure an agent runner
for agent phases. MCP exposes the same authenticated Host operations.

Approval output edits use validated text artifacts. Plan edits are restricted to
unstarted downstream phase bodies in the same dependency graph; completed phases,
top-level settings, and resource declarations cannot be rewritten. Plan edits are
compiled again before readmission. The existing runtime executes the continuation.

## Explicit coordinator operators

Normal bootstrap credentials cannot change capacity or force-release reservations.
An OS owner must explicitly provision the separate operator credential and a
project-scoped operator policy. The key is never printed; the output identifies
its principal and policy file. Provisioning does not overwrite an existing policy.

```sh
taskflow-control operator-provision --root /path/project --control-home /path/control-home
taskflow-control coordinator-status --root /path/project --control-home /path/control-home --mode auto --operator
taskflow-control set-max-active-runs --root /path/project --control-home /path/control-home --mode auto --operator --command-id UUID --max-active-runs 4
taskflow-control force-release --root /path/project --control-home /path/control-home --mode auto --operator --command-id UUID --reservation UUID --acknowledge-risk --reason "operator reviewed retained effects"
taskflow-control mcp --root /path/project --control-home /path/control-home --operator
```

Replace each `UUID` with an actual identifier. Reuse the same command ID and
identical payload for a retry; a changed payload conflicts, and revocation is
checked again before replay. Mutations default to `coordinated`; the examples
explicitly permit `auto` to start the shared owner if absent. Capacity is a
user-global admitted-run limit, while reservation identifiers and force release
remain bound to the authenticated project. Reducing capacity below active use is
rejected. Status shows global aggregate counts and only authorized project rows.

Operator credentials grant project read plus the two coordinator mutations;
they do not inherit run submission or approval authority. Only an explicit
`mcp --operator` exposes the two operator mutation tools. A caller-supplied role
or credential label cannot replace the separate HMAC proof. The protected
`operator-policies` file is reread on each operation; removing a grant or revoking
the principal also rejects existing sessions and retries. Deleting/replacing
`operator.key` invalidates sessions; restart clients after deliberate key rotation.
Possession of that OS-user-protected key is the trust boundary, not isolation
from arbitrary processes running as the same OS user.

Force release frees accounting capacity without proving side effects have stopped.
It requires both explicit acknowledgement and a nonempty reason, persists the
request and `CoordinatorCommandRecord`, and records `operator-overridden`.
It does not fabricate a terminal Run or Receipt. Investigate unknown effects
before making this explicit decision.

## Offline project administration

```sh
taskflow-project-admin move-rebind --store /moved/project/.taskflow/control
taskflow-project-admin clone --store /source/.taskflow/control --destination /new/project/.taskflow/control
taskflow-project-admin export --store /project/.taskflow/control --output /private/export.json --kind readonly
```

Stop project writers before an offline filesystem move. `move-rebind` verifies the
same directory device/inode, absence of the old path, writer exclusion, and settled
history before preserving identity. `clone` creates a fresh, empty project/domain;
it does not copy authoritative run history. Export preserves source bytes, including
damaged journal evidence, and always states `executePromise: false`.

## Recovery boundaries

Missing or damaged headers, incomplete journals, ambiguous effects, unknown owners,
and changed directory identities fail closed. An interrupted script can leave a
dirty TE mutation even after its process exits: status remains `unknown`, capacity
is retained, and no terminal Receipt is fabricated. SIGINT first records a versioned
cancellation; a bounded process shutdown fallback still reaps owned children.

Legacy conflict detection covers observable core run records and locks. It stops
new attempts and never kills external writers. The trusted local
`LegacyConflictGuard.acknowledgeStopped()` API requires captured writers to be dead.
Invisible unmanaged writers require external service-manager exclusion. The managed
legacy mutex migration helper applies only to its directly supervised child writers.

The provider reports resolve-only containment and admission-time revocation. This
does not claim an OS sandbox, arbitrary in-flight recovery, cross-domain transfer,
or general DAG editing. Logical compaction retains the physical evidence journal.
