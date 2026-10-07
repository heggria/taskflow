# Taskflow control plane

This is a private implementation candidate. Release-owner integration, exact-head CI,
and publication acceptance remain separate from local source and packed-package tests.

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
