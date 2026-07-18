# RFC: Workspace Capabilities

> Status: **Design boundary active; control-plane scaffold partially shipped**
> Updated: **2026-07-18**
> Motivation: reusable dynamic working directories without false isolation,
> cache, or resume claims.

## Executive decision

Taskflow must not model dynamic workspaces as arbitrary string interpolation.
A path selected by an argument is useful, but resolving that path and isolating
a subprocess to it are different guarantees.

The durable model has four planes:

```text
Authority   Host policy → principal → authorized root grant
Resource    requirement → bound workspace → scoped path/capability
Execution   resolved resources → leases → sandbox/executor/file boundary
Durability  write intent → observation/checkpoint → run/cache/trace state
```

## Guarantee levels

| Mode | What Taskflow can claim |
|---|---|
| `resolve-only` | The selected canonical cwd stays within an authorized invocation root. This does **not** constrain every file the host subprocess may read or write. |
| `sandboxed` | Resolver containment plus an enforced subprocess/filesystem policy for the exact scoped grants. |

These labels are not interchangeable. A permission prompt, tool allowlist, or
successful `realpath` check is not evidence of an operating-system filesystem
boundary.

## Current 0.2.3 truth

The current release line ships a deliberately narrow compatibility bridge:

- an author-written phase may use the exact placeholder
  `cwd: "{args.package}"` when the argument is a typed `relative-path`;
- the bridge is default-off and requires
  `TASKFLOW_CWD_BRIDGE_MODE=resolve-only`;
- absolute paths, concatenated placeholders, step-derived paths, and generated
  sub-flow cwd/context authority are rejected;
- canonical containment is checked against the invocation root, including
  symlink resolution;
- potential writers in one invocation are serialized before durable lease
  acquisition;
- write intent, mutation permits, generations, and explicit reconciliation
  prevent a failed writer from being silently treated as clean;
- retries and output-only reuse are restricted where filesystem side effects
  cannot be restored safely;
- the checked-in native sandbox allowlist is empty, so no host is advertised as
  providing the canonical `sandboxed` workspace model.

The existing `packages/taskflow-core/src/resources/` modules are a host-neutral
control-plane scaffold. They are not a public claim that the full execution
backend, race-free file broker, or cross-host sandbox matrix is complete.

## Non-negotiable invariants

1. Flow JSON cannot grant itself a physical root or forge trusted provenance.
2. Generated/model-authored flows receive only explicitly attenuated authority.
3. Resolution, subprocess isolation, and Taskflow-owned file I/O use distinct,
   truthful capability claims.
4. Writable aliases and overlapping paths share one canonical lease/version
   domain.
5. Mutation intent is persisted before a side effect can begin.
6. Crash or uncertain cancellation leaves the workspace `dirty-unknown`; it is
   never silently upgraded to clean.
7. Reconciliation accepts the observed current state only after explicit human
   acknowledgement; it does not restore files.
8. A cache hit may skip model execution, but cannot skip authorization, version
   checks, leases, or state restoration required by the declared effects.
9. Nested flows can attenuate authority but never expand it.
10. Unsupported sandbox policies fail closed instead of degrading under a
    stronger label.

## Why `cwd.fromArg` is not the public model

A field-specific shortcut cannot answer:

- who authorized the selected root;
- whether the value is a path or arbitrary text;
- what subtree and access mode reach the subprocess;
- whether scripts and Taskflow-owned file reads obey the same boundary;
- how nested flows attenuate authority;
- how aliases and overlapping writes are coordinated;
- how crash, cache, resume, and relocation affect correctness.

Typed relative cwd remains a compatibility bridge. The canonical future model
uses host-authorized named roots, flow-declared logical requirements, scoped
path references, and runtime-minted handles.

## Delivery path

| Milestone | Exit condition |
|---|---|
| Current bridge | Resolve-only label, typed relative argument, containment, leases/journal/permits, explicit reconcile |
| Host feasibility | Versioned probes for exact host binary, OS/build, architecture, subprocess descendants, path-swap resistance, secrets, and cleanup |
| Single-root sandbox | One host passes a real Agent + Script + Taskflow file-I/O boundary with fail-closed policy negotiation |
| Multi-root capabilities | Named authorized roots, attenuation, atomic lease acquisition, and complete conformance matrix |
| Restorable state | Cache/resume can materialize and verify filesystem post-state rather than reusing output alone |
| Canonical 0.3 model | Public scoped capabilities/PathRefs replace raw physical-path authority |

No milestone is called secure based only on lexical or `realpath` containment.

## Code map

```text
packages/taskflow-core/src/
├── cwd-bridge.ts              typed relative cwd compatibility boundary
└── resources/
    ├── authority.ts           invocation authority
    ├── registry.ts            authorized roots/domains
    ├── resolve.ts             scoped resolution
    ├── leases.ts              persistent coordination
    ├── journal.ts             write-intent durability
    ├── permits.ts             attempt-bound mutation permission
    ├── persistence.ts         generations and recovery state
    ├── sandbox.ts             policy negotiation/contracts
    ├── backend.ts             future execution boundary
    └── baseline.ts            exact host evidence loader
```

## Rejected alternatives

| Alternative | Reason |
|---|---|
| Arbitrary cwd interpolation | Path and authority injection; non-portable identity |
| Realpath-only security claim | Does not constrain subprocess ambient access or close time-of-check/time-of-use races |
| Agent-runner-only sandbox | Script and Taskflow-owned file operations bypass it |
| Flow-supplied physical roots | Model-callable data would grant itself authority |
| Workspace-name-only locks | Aliases, overlaps, and cross-process writers bypass them |
| Prompt/tool-policy read-only | Not a filesystem enforcement boundary |

## Decision for 0.2.3

Keep the resolve-only bridge narrow, explicit, and accurately labeled. Preserve
the control-plane work, but do not expose a stronger public workspace API until
at least one exact host target passes the complete execution and filesystem
conformance boundary.
