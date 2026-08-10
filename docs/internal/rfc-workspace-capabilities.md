# RFC: Workspace Capabilities — authority, scoped resources, execution isolation, durable writes

> Status: **Proposed — design-review findings closed; implementation blocked until W0.5 feasibility and W1a prerequisites pass**
> Revision: **3**
> Updated: **2026-07-13**
> Targets: **0.2.1 compatibility bridge after W1a + 0.3.0 canonical model**
> Motivation: [#70](https://github.com/heggria/taskflow/issues/70)

## 0. Executive decision

Taskflow needs dynamic working directories to make flows reusable, but it must not
implement them as arbitrary string interpolation.

The durable design has four separate planes:

```text
Authority plane
HostPolicy → Principal → RootGrant → RootRegistry

Resource plane
WorkspaceRequirement → BoundWorkspace → ScopedCapability / PathRef

Execution plane
ResolvedPhaseResources → LeasePlan → SandboxPlan
                         → AgentExecutor / ScriptExecutor / FileBroker

Durability plane
WriteIntentJournal → snapshot/version commit → RunState/cache/trace
```

The execution order is normative:

```text
compile logical plan
→ authorize bindings for the invocation principal
→ phase becomes DAG-ready
→ determine cache eligibility from declared resource effects
→ lazily acquire providers
→ resolve scoped references
→ obtain trusted versions/fingerprints required for cache lookup
→ select a validated cache candidate or the live-execution path
→ prepare/negotiate the exact sandbox policy
→ acquire the leases required by the selected path
→ revalidate resource state under lease
→ persist and fsync write/restore intent when mutation is possible
→ atomically restore cached post-state or launch live execution
→ observe post-state and commit generation, or retain dirty/unknown
→ release leases and eligible providers
```

`when` skips, budget rejection, and dependency failure occur before lazy provider
acquisition. **Cache eligibility** may also be decided early, but a resource-bearing
cache lookup can require authorization, provider metadata, binding/version resolution,
or a read-only fingerprint. A cache hit may skip model/script execution; it does not
necessarily skip binding, provider acquisition, leases, write intent, or post-state
restoration. Unselected phases must not create a worktree, temp directory, artifact,
or write-intent record.

### 0.1 Two explicit guarantee levels

Path resolution and subprocess isolation are different guarantees:

| Mode | Guarantee | May execute a dynamic `cwd` phase? |
|---|---|---|
| `resolve-only` | Taskflow's own resolver proves the selected cwd stays within an authorized scope. It does **not** claim the Agent cannot read other ambient files. | Only behind an explicit host/user opt-in; not sufficient to close #70 as a secure cross-host feature |
| `sandboxed` | Resolver containment plus enforced subprocess filesystem policy for the scoped grants and host baseline. | Yes |

The 0.2.1 bridge is enabled only for hosts that pass the required single-root
`sandboxed` conformance suite. There is no bridge release before RootRegistry,
principal authorization, capability negotiation, single-root SandboxPlan, and the
script/FileBroker boundary exist.

## 1. Why `cwd.fromArg` is not the public model

`cwd: { fromArg: "repo_dir" }` answers only where one field gets a string. It does
not answer:

- who authorized the root;
- whether the argument is a path or an arbitrary string;
- what exact subtree and access mode reach the subprocess;
- whether scripts and Core file reads obey the same boundary;
- how nested flows attenuate authority;
- how aliases and overlapping paths are locked;
- how failure/crash affects cache and resume;
- how physical path relocation differs from resource replacement.

The public API therefore uses host-authorized named roots, flow-declared logical
workspaces, structured scoped path references, and runtime-minted handles.

## 2. Threat and trust model

### 2.1 Principals

| Principal | Trust and authority |
|---|---|
| Host policy owner | Configures physical roots, maximum access, host baseline, principals, unsafe opt-ins, and provider controller permissions |
| Invocation caller | Starts a run under an authenticated/identified `principalId`; may bind only grants allowed by host policy |
| Flow author | Declares requirements and requested access; cannot create a physical grant or claim trusted provenance through JSON fields |
| Runtime-generated/model-authored flow | Untrusted data; receives only explicitly exported attenuated capabilities; cannot use author-only unsafe switches |
| Agent/script subprocess | Least-trusted executor; receives only a phase SandboxPlan plus host baseline |
| Taskflow Core | Trusted policy enforcement process; all workspace/resource-bearing filesystem and process operations must go through the execution backend/FileBroker. RunStore, journal, lease registry, and trace persistence use a separate trusted control-plane storage boundary. |

“Authored” is provenance, not a boolean inside a flow. The loader attaches a trusted
`FlowProvenance` after loading from a host-approved local/signed source. Inline
definitions supplied through an LLM-callable MCP request and every `flow { def }`,
`expand`, or `ctx_spawn` definition are `model-generated` unless the host explicitly
attests otherwise.

```ts
type FlowProvenance =
  | { kind: "trusted-authored"; sourceId: string; digest: string }
  | { kind: "untrusted-inline"; digest: string }
  | { kind: "model-generated"; producerPhaseId: string; digest: string };
```

### 2.2 Authorization

Knowing a grant name is not authorization. Every run carries an invocation context:

```ts
interface InvocationAuthority {
  principalId: string;
  allowedGrantIds: ReadonlySet<string>;
  allowedProviderControllers: ReadonlySet<string>;
  allowedCredentialIds: ReadonlySet<string>;
  allowResolveOnly: boolean;
  allowUnsafeParallelWrites: boolean;
  allowWorkspaceStateRestore: boolean;
}
```

The host creates this context outside flow JSON. `workspaceBindings` is accepted only
after checking both:

1. the named grant exists; and
2. the invocation principal is allowed to use it at the requested access.

MCP configuration may expose `repo`, `specs`, and `secrets` roots while granting a
given Codex task only `repo`. The task cannot bind `secrets` merely by guessing its
name.

Credential requirements are likewise logical selections, not secret values. A phase
may request only IDs in `allowedCredentialIds`; authorization binds audience, purpose,
delivery mode, and maximum TTL before the requirement enters `SandboxPolicyPlan`.
`CredentialRegistry` returns a host-branded grant only when audience/purpose are
allowlisted and computes `ttlMs = min(request, grant, baseline broker limit)`. Flow JSON
cannot construct the grant or widen delivery/TTL after authorization.

### 2.3 Host baseline authority

A subprocess requires ambient runtime files that are not flow workspaces: executable
binaries, dynamic libraries, system certificates, secret-free provider metadata, and
a bounded temp/runtime directory. The host declares these separately:

```ts
type CredentialDelivery =
  | { mode: "opaque-broker"; brokerId: string; maxTtlMs: number }
  | {
      mode: "isolated-host-process";
      scrubToolEnvironment: true;
      denyProcessInspection: true;
    }
  | { mode: "unavailable" };

interface ProviderMetadataGrant {
  metadataId: string;
  kind: "exact-file";
  contentDigest: string;
  secretScanPolicyId: string;
}

interface HostBaselinePolicy {
  schemaVersion: 1;
  policyId: string;
  policyVersion: string;
  bodyDigest: string; // SHA-256 of canonical policy body excluding this field
  readableSystemClasses: Array<
    "runtime" | "dynamic-libraries" | "ca-certificates"
  >;
  providerMetadata: ProviderMetadataGrant[]; // empty means no provider metadata
  credentialDelivery: CredentialDelivery;
  temp: { mode: "private-per-execution"; access: "read-write" };
  network?: "host-policy" | "none";
}

interface HostBootstrapConfig {
  // Read by the trusted delivery process before launch; never mounted into a plan.
  sourceId: string;
  secretRefs: string[];
}
```

Baseline authority is not addressable by `PathRef`, cannot become a flow workspace,
and is excluded from workspace attenuation. Conformance verifies that subprocesses
cannot access unauthorized **user-data paths outside baseline and scoped grants**;
it does not claim that executables cannot read their required system runtime.

`HostBootstrapConfig` and credential material are not baseline filesystem grants.
Provider metadata is an exact-file, no-follow grant resolved by a trusted metadata
registry. Directory entries are invalid. The registry verifies the declared content
digest and secret-scan policy before every prepared plan; a missing, changed, symlinked,
or unscanned file fails closed.

Credentials are delivered by an opaque broker/keychain operation bound to execution
owner, audience, purpose, and TTL, without returning a bearer secret to Agent/tool
code; or remain in an isolated host process whose environment, process inspection,
debug interfaces, and child inheritance have passed conformance. Environment scrubbing
alone is insufficient. If an adapter must expose an API key, OAuth token, cookie store,
or credential-bearing config to Agent tools, it reports
`credentialDelivery.mode: "unavailable"` and rejects a plan requesting credentials.
A baseline never mounts an entire user config directory such as `~/.config`,
`~/.codex`, or an equivalent provider home. Writable shared temp is not ambient
baseline authority; flows that need it declare a normal leased/journaled workspace.

## 3. Normative invariants

1. **No authority from flow data.** Only a host-created, branded `RootGrant` binds a
   logical requirement to physical storage.
2. **Principal authorization precedes binding.** Registry membership alone is
   insufficient.
3. **Monotonic attenuation.** Root, physical scope prefix, logical prefix, access,
   lifetime, provider control, and handle rights can only stay equal or shrink.
4. **Model output cannot introduce or widen authority.** It may select a subpath
   inside an author-declared envelope; Core validates the selection and mints an
   attenuated handle.
5. **Path safety and sandbox enforcement are separate.** Resolver containment is
   mandatory defense in depth. `sandboxed` execution additionally requires an exact
   enforceable SandboxPlan.
6. **Subpath attenuation reaches the enforcement boundary.** A child scoped to
   `target/packages/api` gives the backend that physical subtree, never the original
   repository root.
7. **All workspace/resource-bearing execution and I/O share one backend.** Agent
   spawn, script spawn, context reads, workspace writes, fingerprints, provider
   operations, and artifacts cannot bypass policy through direct
   `spawn`/`readFileSync` paths. RunStore, journal, lease, and trace persistence remain
   trusted control-plane I/O and are not flow-addressable FileBroker resources.
8. **Capability failures fail closed.** Binding, authorization, provider acquisition,
   containment, lease, journal, snapshot, and sandbox negotiation never fall back to
   the invocation cwd.
9. **Locks follow canonical resources, not logical aliases.** Overlapping physical
   scopes conflict even when their workspace IDs differ.
10. **Write intent is durable before mutation.** Any uncertain/failed/crashed writer
    leaves the resource `dirty/unknown`, preventing stale cache reuse.
11. **Portable semantic records contain no physical paths.** Logical resource events
    are path-free. Free-form model/user diagnostics have a separate sensitivity and
    redaction policy.
12. **One capability resolver, surface-specific selector validators.** All paths start
    from the same scoped capability resolver; glob, git ref, script argv, JSON pointer,
    and artifact selectors retain dedicated validators.

## 4. Authority plane

### 4.1 Root grants and registry

`RootGrant` is runtime-only and cannot be constructed by JSON parsing:

```ts
declare const ROOT_GRANT: unique symbol;

interface RootGrant {
  readonly [ROOT_GRANT]: true;
  readonly grantId: string;
  readonly bindingId: string;       // stable host binding record
  readonly resourceDomainId: string; // underlying mutable resource identity
  readonly physicalRoot: string; // memory only
  readonly maxAccess: WorkspaceAccess;
  readonly version?: ResourceVersion;
  readonly allowedPrincipals: ReadonlySet<string>;
  readonly enforcement: "native-single-root" | "native-multi-root" | "resolve-only";
}

interface RootRegistry {
  readonly registryId: string; // stable host policy/lease namespace
  authorize(
    grantId: string,
    principal: InvocationAuthority,
    requested: WorkspaceAccess,
  ): RootGrant | WorkspacePolicyError;
}
```

The delivery layer constructs the registry from trusted host configuration. Flow JSON
and LLM-callable tools carry only logical binding names.

`grantId` denotes an authorization view, `bindingId` denotes the stable host binding
record used for relocation, and `resourceDomainId` denotes the underlying mutable
resource. Two aliases/bindings for the same directory/repository must share one
`resourceDomainId`. Registry startup rejects overlapping writable physical roots with
different domains unless the policy owner supplies an explicit shared-domain mapping;
otherwise aliases could bypass locking, versioning, journaling, and cache identity.

The overlap rule is not limited to two writable declarations: any canonical physical
overlap where **at least one view is writable** must share a resource domain or be
rejected, including a read-only parent plus writable child. The same check runs after
every dynamic provider acquisition, not only at registry startup. A derived
dedicated/worktree domain may stay distinct only when its data tree is physically
isolated from every existing data-plane grant; parent repository metadata access is
then represented by the separate parent control-plane domain. No runtime-created path
may silently introduce an overlapping independent domain.

### 4.2 Stable binding identity

`bindingId` identifies a host binding across relocation. `resourceDomainId` identifies
the mutable resource observed by locks/versioning/cache. Their source priority is:

1. host registry persisted UUID;
2. provider-owned persisted metadata UUID;
3. Git repository UUID stored in trusted local metadata, optionally associated with
   remote identity as a diagnostic;
4. machine-local filesystem identity for path-bound resume only;
5. no stable identity: portable resume disabled and the run records
   `identityMode: "unavailable"`.

Inode/device and path HMAC values are not claimed to survive copies or cross-volume
moves. A registry UUID can survive relocation because the policy owner explicitly
rebinds the same grant record. Replacing a directory at the same path requires a new
binding UUID or yields a version mismatch.

```ts
interface ResourceVersion {
  identityMode: "portable" | "path-bound" | "unavailable";
  contentId?: string; // content of this capability's exact logical scope
  scopeDigest?: string;
  generation: number; // resource-domain commit-WAL revision, not intent sequence
  state: "clean" | "write-pending" | "dirty-unknown";
}
```

### 4.3 Provider controller authority

Provider control-plane rights never reach Agent/script subprocesses:

```ts
interface ProviderControllerGrant {
  controllerId: string;
  provider: "temp" | "dedicated" | "worktree" | "artifact";
  baseBindingId?: string;
  operations: ReadonlySet<"create" | "resume" | "snapshot" | "release" | "reconcile">;
}
```

Creating a worktree needs controller permission to mutate parent Git metadata. The
resulting Agent receives only the derived worktree's data-plane scoped capability.
It does not receive access to the base repository's `.git` control plane.
Mutating controller operations acquire their own canonical control-plane lease and
write intent against the parent repository metadata before creation/removal.

## 5. Resource plane

### 5.1 Flow requirements and invocation bindings

```jsonc
{
  "name": "review-package",
  "workspaces": {
    "target": {
      "provider": "root",
      "access": "read-write"
    },
    "changes": {
      "provider": "worktree",
      "base": "target",
      "access": "read-write",
      "lifecycle": "run",
      "retain": "on-failure"
    }
  },
  "args": {
    "package": {
      "type": "relative-path",
      "required": true
    }
  },
  "phases": [
    {
      "id": "work",
      "type": "agent",
      "cwd": {
        "workspace": "target",
        "subpath": { "argPath": "package" },
        "access": "read-write",
        "intent": "existing-directory"
      },
      "task": "Review and fix the selected package"
    }
  ]
}
```

Invocation maps the flow requirement to a grant already authorized for the principal:

```jsonc
{
  "name": "review-package",
  "workspaceBindings": {
    "target": "repo"
  },
  "args": {
    "package": "packages/api"
  }
}
```

The host also creates an `invocation` grant for the run/server root. Its access is host
policy, not flow policy. Legacy relative cwd and the 0.2.1 bridge lower to this grant.

### 5.2 Providers and lifetimes

| Provider | Controller source | Data-plane lifetime | Resume | Cleanup |
|---|---|---|---|---|
| `root` | Authorized RootGrant | External | Binding/version rules | Never removed by Taskflow |
| `temp` | Temp controller | Phase only | Recreate; cannot be shared downstream | Phase terminal |
| `dedicated` | Run-store controller | Run/retained | `(runId, providerInstanceId, generation)` | Run retention |
| `worktree` | Worktree controller derived from writable root | Run by default | Repo ID + base commit + provider instance | Terminal/retention/reconcile |
| `artifact` | Artifact controller | Immutable | SHA-256 content ID | Ref-count/retention |

Provider acquisition is lazy and idempotent by
`(runId, logicalWorkspaceId, providerInstanceId)`. An acquisition failure fails closed.
Cleanup failure records `cleanupPending` and is retried; it does not rewrite completed
model work as failed.

### 5.3 Unambiguous path references

```ts
type WorkspaceAccess = "read-only" | "read-write";

type CapabilityLifetime =
  | { scope: "phase" }
  | { scope: "run" }
  | { scope: "external" };

type BoundCapabilityLifetime =
  | { scope: "phase"; runId: string; phaseId: string; attemptId: string }
  | { scope: "run"; runId: string }
  | { scope: "external"; bindingId: string; providerInstanceId?: string };

interface CapabilityView {
  maxLifetime?: CapabilityLifetime;
}

interface HandleRef {
  producerPhaseId: string;
  exportName: string;
}

type PathIntent =
  | "existing-file"
  | "existing-directory"
  | "create-file"
  | "create-directory"
  | "executable";

type RelativePathExpr =
  | { literalPath: string }
  | { argPath: string }
  | {
      segments: Array<
        | { segment: string }
        | { argSegment: string }
      >;
    };

type PathRef = CapabilityView & {
  subpath?: RelativePathExpr; // omitted means workspace root
  access?: WorkspaceAccess;  // new schema default: read-only
  intent: PathIntent;
} & (
  | { workspace: string; handle?: never }
  | { handle: HandleRef; workspace?: never }
);
```

Rules:

- `literalPath` and `argPath` may contain several `/`-separated relative segments.
- `segment` and `argSegment` must contain exactly one segment and cannot contain `/`
  or `\`.
- Backslash is rejected in the portable syntax; `/` is the canonical separator.
- `.` / `..`, NUL, empty internal segments, absolute/drive/UNC/device prefixes, and
  platform-reserved names are rejected.
- Omitted `subpath` means workspace root. An explicit empty `literalPath`, empty
  `argPath`, or empty segments list is invalid.
- A direct phase use defaults to phase lifetime. Child mappings and export envelopes
  must declare `maxLifetime` when the capability needs to outlive that execution unit.
  `phase < run < external`; attenuation may only move left. A phase-scoped handle is
  invalid after its owning phase and cannot be exported to a downstream phase.
- Flow JSON carries only `CapabilityLifetime`; Core binds the owning phase/run/binding
  into `BoundCapabilityLifetime`. Caller-supplied owner IDs are rejected.
- Direct cwd/context/script PathRefs are phase-scoped; a broader `maxLifetime` on those
  surfaces is rejected. Child mappings and export envelopes may request `run`, but a
  runtime workspace/artifact handle can never request `external`. External lifetime is
  reserved for host registry/provider capabilities and binds to the existing stable
  `bindingId` plus provider instance when applicable, not to cross-run flow handles.
- A `HandleRef` is symbolic. Compilation verifies the named producer/export and a DAG
  dependency but does not contain the opaque runtime handle ID. The consumer must have
  an explicit direct or transitive `dependsOn` path from the producer; the compiler
  does not synthesize hidden edges, and a missing dependency is a static error. That
  explicit edge participates in cycle detection, topological order, and FlowIR hash.
  The source is bound only after the producing attempt has completed successfully.
- Strings are normalized to Unicode NFC before validation and hashing. The original
  display value may be retained only in non-portable diagnostics.
- `intent` determines existence/type/create/no-follow validation and is never inferred
  from the consumer.

### 5.4 Typed and legacy args

0.2.x accepts a union:

```ts
interface LegacyArgSpec {
  default?: unknown;
  description?: string;
  required?: boolean;
}

type TypedArgSpec =
  | { type: "string"; default?: string; pattern?: string; required?: boolean; description?: string }
  | { type: "relative-path"; default?: string; required?: boolean; description?: string }
  | { type: "number"; default?: number; minimum?: number; maximum?: number; required?: boolean }
  | { type: "boolean"; default?: boolean; required?: boolean }
  | { type: "enum"; values: Array<string | number>; default?: string | number; required?: boolean };

type ArgSpec = LegacyArgSpec | TypedArgSpec;
```

Normalization rules:

- Legacy specs remain `type: "unknown"` and preserve current interpolation behavior.
- A legacy arg cannot be consumed by `PathRef` or the cwd bridge; authors opt into
  `type: "relative-path"` for that use.
- Schema version 2 requires typed args; version 1 accepts both.
- Invocation values for undeclared args remain accepted in schema version 1 for
  current compatibility but emit a warning under `strictInterpolation`; schema
  version 2 rejects them.
- There is no portable absolute `directory` arg. Physical roots enter only through
  authorized bindings.

### 5.5 Scoped capabilities

After binding and attenuation, the resource plane emits:

```ts
interface ScopedCapability {
  bindingId: string;
  resourceDomainId: string;
  providerInstanceId: string;
  logicalWorkspaceId: string;
  logicalPrefix: string;
  physicalScopeRoot: string; // memory only; exact attenuated subtree
  access: WorkspaceAccess;
  version: ResourceVersion;
  lifetime: BoundCapabilityLifetime;
}
```

`physicalScopeRoot` is the deepest enforced root after parent/child/phase attenuation.
The execution backend never reconstructs a broader root from `bindingId` or the
original RootGrant.

### 5.6 Dynamic selection and handles

The invariant is precise:

> Model output cannot introduce a new root, increase access/lifetime, or escape an
> authored selection envelope. It may choose a relative subpath inside that envelope;
> Core validates it and mints an attenuated handle.

```jsonc
{
  "id": "discover",
  "type": "agent",
  "output": "json",
  "task": "Return {\"path\":\"packages/api\"}",
  "exports": {
    "selected": {
      "kind": "workspace-handle",
      "within": {
        "workspace": "target",
        "access": "read-only",
        "maxLifetime": { "scope": "run" }
      },
      "subpathFrom": {
        "jsonPointer": "/path",
        "valueType": "relative-path"
      },
      "intent": "existing-directory"
    }
  }
}
```

`jsonPointer` has its own validator. The selected value then goes through the canonical
path resolver. Core records an opaque, unguessable registry handle. Downstream phases
refer to that handle symbolically rather than raw `{steps.discover.json.path}`:

```jsonc
{
  "cwd": {
    "handle": { "producerPhaseId": "discover", "exportName": "selected" },
    "subpath": { "literalPath": "src" },
    "access": "read-only",
    "intent": "existing-directory"
  }
}
```

- Workspace handles retain bounded mutable/RO authority.
- Artifact handles are immutable, content-addressed, and always read-only.
- Forged, expired, cross-run, unexported, or superseded-attempt handles fail closed.
- Handle registry state records the exact lifetime and expiry boundary. A generated
  export cannot request a lifetime broader than its authored `within.maxLifetime`.
- Each handle is bound to `(runId, producerPhaseId, attemptId, exportName,
  handleGeneration)`. Producer failure mints nothing; a retry/recompute that replaces
  the producer attempt revokes the previous generation before downstream binding.
  Same-run resume may revalidate a run-scoped handle against this registry record;
  a new run must obtain a newly authorized handle. Durable `ImmutableArtifactRef`
  records used by trusted cache storage are not flow-facing runtime handles.

## 6. Capability and selector resolution

### 6.1 Capability resolver

`resolvePathRef(ref, capabilityEnv, args)` performs only capability/path work:

1. validate the `PathRef` and workspace requirement;
2. resolve typed relative-path/segment args;
3. NFC-normalize and validate canonical segments;
4. authorize/bind/acquire the workspace lazily;
5. intersect host, flow, parent, handle, and phase access/lifetime/scope;
6. resolve the exact physical scope root and target according to `intent`;
7. for existing targets, compare `realpath` with scope-root `realpath`;
8. for create targets, resolve the nearest existing ancestor;
9. return a `ResolvedPathRef` and audit-safe logical descriptor.

```ts
declare const RESOLVED_PATH_REF: unique symbol;

interface ResolvedPathRef {
  readonly [RESOLVED_PATH_REF]: true;
  resolutionTokenId: string;
  expiresAt: string;
  capability: ScopedCapability;
  logicalSubpath: string;
  physicalPath: string; // memory only
  intent: PathIntent;
}
```

Resolver containment does not claim to close TOCTOU by itself. In `sandboxed` mode,
FileBroker preparation must convert the branded resolution into a no-follow open
descriptor, a safely opened parent-directory descriptor for create, or an equivalent
race-free native handle and bind the observed file identity into its sealed plan. A
backend without that primitive fails closed; path-string revalidation alone is allowed
only under the explicitly lower `resolve-only` guarantee. The execution sandbox also
enforces scope after resolution.

### 6.2 Surface-specific selector validators

The resolver establishes the authorized path base. Dedicated validators then handle:

| Surface | Additional validator |
|---|---|
| Context file | Existing regular file, byte/character caps, encoding policy |
| Glob fingerprint | Glob grammar, match-count cap, symlink traversal policy |
| Git fingerprint/worktree | Git ref option-injection guard, repository identity, controller permission |
| Script argv | Typed literal/arg/path tokens; no shell interpolation |
| Artifact export | JSON pointer grammar, expected relative-path value, copy/snapshot limits |
| Executable | Existing regular executable within allowed executable scope or host baseline |

This keeps `resolve.ts` cohesive instead of turning it into another monolith.

## 7. Execution plane

### 7.1 Sandbox plan preserves attenuation

```ts
interface SandboxGrant {
  bindingId: string;
  resourceDomainId: string;
  providerInstanceId: string;
  logicalWorkspaceId: string;
  logicalPrefix: string;
  physicalScopeRoot: string;
  scopeKind: "directory" | "file";
  access: WorkspaceAccess;
  lifetime: BoundCapabilityLifetime;
}

interface CredentialRequest {
  credentialId: string; // logical host-authorized credential capability
  audience: string;
  purpose: string;
  maxTtlMs: number;
}

declare const CREDENTIAL_GRANT: unique symbol;

interface CredentialGrant {
  readonly [CREDENTIAL_GRANT]: true;
  readonly credentialGrantId: string;
  readonly credentialId: string;
  readonly allowedAudiences: ReadonlySet<string>;
  readonly allowedPurposes: ReadonlySet<string>;
  readonly delivery: Exclude<CredentialDelivery, { mode: "unavailable" }>;
  readonly maxTtlMs: number;
}

interface BoundCredentialRequirement {
  credentialGrantId: string;
  credentialId: string;
  audience: string;
  purpose: string;
  ttlMs: number;
  delivery: Exclude<CredentialDelivery, { mode: "unavailable" }>;
}

interface CredentialRegistry {
  authorize(
    request: CredentialRequest,
    principal: InvocationAuthority,
    baseline: HostBaselinePolicy,
  ): BoundCredentialRequirement | WorkspacePolicyError;
}

interface SandboxPolicyPlan {
  mode: "sandboxed" | "resolve-only";
  cwd: ResolvedPathRef;
  grants: SandboxGrant[];
  baseline: HostBaselinePolicy;
  credentialRequirements: BoundCredentialRequirement[];
  policyDigest: string; // portable logical policy digest
}

declare const PREPARED_SANDBOX: unique symbol;

interface PreparedSandboxPlan {
  readonly [PREPARED_SANDBOX]: true;
  preparedPlanId: string;
  backendId: string;
  backendCapabilityVersion: string;
  owner: ExecutionOwner;
  policy: SandboxPolicyPlan;
  expiresAt: string;
}

interface SandboxPlan {
  prepared: PreparedSandboxPlan;
  mutationPermits: MutationPermit[];
  enforcementDigest: string; // process-local authenticated physical-plan digest
}

declare const PREPARED_FILE_BROKER: unique symbol;

interface PreparedFileBrokerPlan {
  readonly [PREPARED_FILE_BROKER]: true;
  preparedFilePlanId: string;
  operation: "read" | "write";
  owner: ExecutionOwner;
  ref: ResolvedPathRef;
  resourcePolicyDigest: string;
  expiresAt: string;
}

interface FileBrokerReadPlan {
  prepared: PreparedFileBrokerPlan & { operation: "read" };
  enforcementDigest: string;
}

interface FileBrokerWritePlan {
  prepared: PreparedFileBrokerPlan & { operation: "write" };
  permit: MutationPermit;
  enforcementDigest: string;
}
```

The grants carry the actual attenuated `physicalScopeRoot`, not the original grant
root. The backend can mount/expose only those scopes. A plan containing any
`read-write` grant must be sealed into a `SandboxPlan` containing a journal-issued
permit covering that canonical scope and execution owner. `prepareSandbox` happens
before write intent; sealing happens after the intents are durable.

For a file-only use, the backend must expose the exact file (`scopeKind: "file"`) or
serve it through FileBroker/pre-opened handles. It may not silently widen the grant to
the containing directory. If the host cannot represent the exact scope, capability
negotiation fails.

`policyDigest` is `tfws-policy:v1:<sha256-hex>` over RFC 8785 canonical JSON with
schema tag `tfws-policy/v1`. Its inputs are:

- plan mode;
- `HostBaselinePolicy.policyId`, `policyVersion`, and `bodyDigest`;
- backend ID and backend capability version;
- cwd's logical workspace/prefix/intent/access descriptor;
- grants sorted by `(resourceDomainId, logicalWorkspaceId, logicalPrefix, scopeKind,
  access)` including lifetime and file/directory scope;
- writable logical scopes and required permit coverage, sorted canonically;
- bound credential requirements including grant ID, audience, purpose, TTL, and
  delivery mode, sorted by `(credentialGrantId, audience, purpose)`.

Physical paths, raw credentials, bootstrap configuration, principal IDs, and free-form
diagnostics are excluded. The enforcement adapter receives physical mappings alongside
the digest in memory. A `(policyId, policyVersion)` pair is immutably bound by the host
registry to exactly one canonical `bodyDigest`; reuse with different contents fails.

`enforcementDigest` is `tfws-enforcement:v1:<keyId>:<hmac-sha256-hex>`, using a
per-host-install key over RFC 8785 canonical JSON containing the policy digest,
prepared-plan ID/expiry/owner, canonical physical scope mappings, resolved baseline
mounts, credential broker grants, and actual mutation-permit IDs/epochs. It is verified
at every spawn/restore activation and is never persisted or exported. Key rotation
invalidates all prepared plans from the previous key ID. Permit IDs are excluded from
the portable digest and validated independently. Any canonicalization/schema change
increments the corresponding digest schema tag.

FileBroker uses a separate
`tfws-filebroker:v1:<keyId>:<hmac-sha256-hex>` envelope. Its canonical inputs are
operation, owner, prepared-file-plan ID/expiry, branded resolution-token ID,
`resourceDomainId`, logical scope/access/intent, resource policy digest, and the
race-free opened descriptor/native-handle identity; writes additionally include the
permit ID/epoch. `prepareFileRead` / `prepareFileWrite` open and bind that identity
without performing the requested I/O; sealing signs it, and both `openRead` and
`openWrite` verify the envelope and expiry before activation. Unsupported race-free
preparation fails closed.

### 7.2 Unified execution and file backend

Agent execution is only one policy consumer. Core uses a unified boundary:

```ts
interface ImmutableArtifactRef {
  artifactId: string; // trusted control-plane identifier, not a physical path
  contentId: string;
  kind: "phase-output" | "workspace-snapshot";
  manifestDigest: string;
  scopeDigest?: string;
}

interface PostStateObservation {
  contentId?: string;
  restorableSnapshot?: ImmutableArtifactRef;
}

interface RestoreStateRequest {
  capability: ScopedCapability;
  snapshot: ImmutableArtifactRef;
  expectedBeforeContentId: string;
  expectedScopeDigest: string;
}

declare const PREPARED_RESTORE: unique symbol;

interface PreparedRestoreTransaction {
  readonly [PREPARED_RESTORE]: true;
  transactionId: string;
  transactionGroupId: string;
  requests: RestoreStateRequest[];
  expiresAt: string;
}

interface RestoreTransactionPlan {
  prepared: PreparedRestoreTransaction;
  permits: MutationPermit[];
  enforcementDigest: string;
}

interface RestoreMutationResult {
  resourceDomainId: string;
  observedAfterContentId: string;
  scopeDigest: string;
}

interface WorkspaceExecutionBackend {
  capabilities(): WorkspaceBackendCapabilities;
  versioning(capability: ScopedCapability): Promise<ResourceVersioningPlan>;
  prepareSandbox(
    plan: SandboxPolicyPlan,
    owner: ExecutionOwner,
  ): Promise<PreparedSandboxPlan>;
  sealSandbox(
    prepared: PreparedSandboxPlan,
    permits: MutationPermit[],
  ): Promise<SandboxPlan>;

  runAgent(plan: SandboxPlan, request: AgentRequest): Promise<RunResult>;
  runScript(plan: SandboxPlan, request: ScriptRequest): Promise<ScriptResult>;

  prepareFileRead(
    ref: ResolvedPathRef,
    owner: ExecutionOwner,
  ): Promise<PreparedFileBrokerPlan & { operation: "read" }>;
  prepareFileWrite(
    ref: ResolvedPathRef,
    owner: ExecutionOwner,
  ): Promise<PreparedFileBrokerPlan & { operation: "write" }>;
  sealFileRead(
    prepared: PreparedFileBrokerPlan & { operation: "read" },
  ): Promise<FileBrokerReadPlan>;
  openRead(plan: FileBrokerReadPlan): Promise<FileHandle>;
  sealFileWrite(
    prepared: PreparedFileBrokerPlan & { operation: "write" },
    permit: MutationPermit,
  ): Promise<FileBrokerWritePlan>;
  openWrite(plan: FileBrokerWritePlan): Promise<FileHandle>;
  fingerprint(
    plan: FileBrokerReadPlan,
    selector: FingerprintSelector,
  ): Promise<string>;
  observePostState(
    capability: ScopedCapability,
    permit: MutationPermit,
    plan: ResourceVersioningPlan,
  ): Promise<PostStateObservation>;
  prepareRestoreTransaction(
    transactionId: string,
    requests: RestoreStateRequest[],
  ): Promise<PreparedRestoreTransaction>;
  sealRestoreTransaction(
    prepared: PreparedRestoreTransaction,
    permits: MutationPermit[],
  ): Promise<RestoreTransactionPlan>;
  restoreTransaction(
    plan: RestoreTransactionPlan,
  ): Promise<RestoreMutationResult[]>;

  providerControl(
    grant: ProviderControllerGrant,
    request: ProviderControlRequest,
  ): Promise<ProviderControlResult>;
}
```

Consequences:

- `script` no longer directly uses Core `spawn()` under capability mode.
- `context` no longer directly calls unrestricted `readFileSync`.
- cache fingerprinting and Git operations go through backend selectors/controller.
- provider allocation/artifact copy use control-plane grants.
- legacy execution may retain old code paths only when capability mode is absent; no
  capability security claim applies to that path.
- `prepareSandbox` validates the complete concrete plan, not only a static capability
  enum. `runAgent` / `runScript` reject an expired/unprepared plan and every RW plan
  whose permit is absent, inactive, replayed, belongs to another attempt, or does not
  cover every writable scope.
- Only backend sealing methods can produce authenticated Sandbox/restore/FileBroker
  plans; callers cannot supply an enforcement digest string directly.

### 7.3 Backend capability negotiation

```ts
type VersionCommitMode =
  | "content-snapshot"
  | "generation-only"
  | "unavailable";

type ExternalMutationModel = "taskflow-managed" | "externally-mutable";
type RestoreStrategy = "replace-scope" | "provider-native";
type RestoreSafety =
  | "taskflow-exclusive"
  | "atomic-content-cas"
  | "external-fencing"
  | "none";

interface ResourceVersioningPlan {
  commitMode: VersionCommitMode;
  restore:
    | { mode: "none" }
    | {
        mode: "restorable-snapshot";
        strategy: RestoreStrategy;
        safety: RestoreSafety;
        transactionGroupId: string;
      };
  externalMutation: ExternalMutationModel;
}

interface SandboxFeatureSet {
  maxGrants: number;
  scopeKinds: Array<"file" | "directory">;
  perGrantAccess: boolean;
  denyAmbientUserData: boolean;
  exactBaselineMounts: boolean;
  privateTempPerExecution: boolean;
  descendantEnforcement: boolean;
  raceFreeFileBroker: boolean;
  networkModes: Array<"host-policy" | "none">;
  credentialModes: Array<"opaque-broker" | "isolated-host-process">;
}

interface WorkspaceBackendCapabilities {
  schemaVersion: 1;
  backendId: string;
  backendCapabilityVersion: string;
  agent: "native-single-root" | "native-multi-root" | "resolve-only";
  script: "native-single-root" | "native-multi-root" | "resolve-only";
  sandboxFeatures: SandboxFeatureSet;
  brokeredRead: boolean;
  brokeredWrite: boolean;
  versionCommitModes: VersionCommitMode[];
  restoreStrategies: RestoreStrategy[];
  baselinePolicyId: string;
}
```

Before a phase starts, Core first compares the plan with the advertised feature set,
then calls `prepareSandbox` on the complete concrete policy. Preparation must verify
exact file/subtree representation, every grant's RO/RW mode, denial of ambient user
paths, exact baseline mounts, private temp, network mode, descendant/tool inheritance,
and every credential requirement. It returns a branded, expiring plan or
`TFWS_UNSUPPORTED_SANDBOX_POLICY`. Static advertisement is only a fast rejection; it
is never proof. Execution never runs unconfined unless the invocation principal has
explicitly enabled `resolve-only` and the flow surface allows that lower guarantee.

Host adapters map SandboxPlan to their native mechanisms. Prompt instructions are not
enforcement. A `native-single-root` backend accepts only one effective scope; multi-root
phases fail before agent/script execution.

Capability negotiation checks both backend-wide supported modes and the selected
resource's `ResourceVersioningPlan`. A backend may support content snapshots for a
worktree provider but only generation commits for an external root. Advertising
`content-snapshot` means `observePostState` produces a trustworthy content ID;
`restorable-snapshot` additionally means immutable post-state can be restored under a
write permit. Neither capability is inferred from process exit code.

Atomic restore is negotiated for the **specific request set** through
`prepareRestoreTransaction`; matching `transactionGroupId` values are necessary but
not sufficient. The prepared transaction is branded/expiring, and the sealed
`RestoreTransactionPlan` receives the same HMAC/permit replay protections as
`SandboxPlan`. `restoreTransaction` must either apply every request or mutate none. On an
`externally-mutable` resource, `taskflow-exclusive` and `replace-scope` alone are not
safe: RW cache restoration is disabled unless preparation proves atomic
expected-before-content CAS or an external fencing mechanism.

## 8. Canonical leases and concurrency

### 8.1 Lock identity

Locks use physical resource identity and path overlap:

```ts
interface CanonicalLeaseKey {
  resourceDomainId: string;
  canonicalPrefix: string;
}

interface LeaseRequest {
  key: CanonicalLeaseKey;
  access: WorkspaceAccess;
  owner: ExecutionOwner;
}

interface ExecutionOwner {
  runId: string;
  phaseId: string;
  attemptId: string;
  unitId: string; // phase, map item, branch, race variant, tournament variant/judge
  ancestry: string[];
}
```

Two requests conflict when `resourceDomainId` matches, path prefixes overlap, and at
least one is writable. Logical workspace, grant, binding, and provider-instance aliases
do not bypass this test. External-root aliases share a domain; each independent
dedicated/worktree/artifact instance receives a new domain and records its parent
control-plane domain separately.

### 8.2 Execution-unit leases

Lease granularity is the actual concurrent unit:

- one ordinary phase call;
- each map item;
- each parallel/race/tournament branch or judge call;
- each loop iteration;
- each script invocation;
- each nested child phase.

A fan-out phase does not acquire one broad write lease and then start multiple writers.
Each unit acquires its declared scopes independently. By default overlapping writes
serialize. `unsafeParallelWrites` is honored only for trusted-authored provenance plus
an invocation principal allowed to enable it.

### 8.3 Nested reentrancy

A parent `flow` phase does not retain data-plane leases while executing its child.
It resolves and authorizes the child mapping, then child execution units acquire their
own leases. Provider controller ownership may remain with the parent run.

For operations that must nest under an existing lease, `ancestry` supports reentrant
attenuation only when the child scope is a subset and access does not widen. It cannot
upgrade a parent read lease to write.

### 8.4 Cross-run and cross-process lock domain

Correctness requires a host-level persistent lease coordinator shared by concurrent
runs/processes using the same registry:

- lock files or a local daemon keyed by an HMAC of canonical lease identity;
- atomic create/rename plus stale-owner recovery;
- PID/start-time/run ownership validation;
- deterministic sorted acquisition for multiple keys;
- abort/timeout cleanup and crash reconciliation.

An in-memory coordinator is acceptable only for a documented single-process
`resolve-only` development mode and cannot claim cross-run determinism.

This guarantee covers only Taskflow processes that use the same RootRegistry identity
and persistent coordinator. It cannot block an IDE, `git`, filesystem sync client, or
other external writer. Each resource therefore declares `externalMutation` in its
versioning plan. Externally mutable resources require a fresh trusted content
identity/fingerprint at every cross-run reuse boundary; generation-only state cannot
be treated as proof that no external write occurred.

That observation is boundary consistency, not snapshot isolation from external
programs. A phase that requires a stable read for its whole execution must bind an
immutable provider snapshot or an externally fenced view; neither live execution nor
an RO cache hit claims stronger isolation on an unfenced external root.

## 9. Durability plane

### 9.1 Write-intent journal

Process success alone is not a version commit. The protocol is:

1. acquire canonical write lease;
2. read clean scoped content evidence and current domain generation `N`, or
   reconcile/reject a dirty overlapping scope;
3. atomically allocate a unique intent sequence `I`, then append and fsync
   `write-intent(N, I, owner, scopes)`; intent order is not a content revision;
4. persist resource state `write-pending` before launch;
5. mint permits and seal the already prepared SandboxPlan;
6. execute through SandboxPlan, atomically activating its permits;
7. on success, call `observePostState` for each merged scope when required by the
   negotiated versioning plan;
8. at commit WAL append time, atomically allocate the next domain commit generation
   `G` in commit order; for `content-snapshot`, append/fsync
   `write-commit-content(I, G, scopedContentEvidence, snapshotHandles?)` only after
   the backend returns trustworthy scoped content identities;
9. for `generation-only`, append/fsync `write-commit-generation(I, G)`; this is a
   clean coordinator-local generation, not content identity;
10. for `unavailable`, or on error, timeout, abort, kill, commit failure, restore
   failure, or startup recovery of an uncommitted intent, append/fsync
   `write-unknown` and retain `dirty-unknown`;
11. settle permits and release the lease.

The fsynced WAL is the source of truth. `ResourceVersion`, RunState, and cache indexes
are rebuildable projections produced by folding WAL records; they never publish a
clean generation before its commit record is durable. A crash after filesystem change
but before commit leaves the pending intent dirty on recovery. A crash after commit but
before an index update replays the commit and reconstructs the same clean state.

```ts
interface ScopedContentEvidence {
  canonicalPrefix: string;
  scopeDigest: string;
  beforeContentId?: string;
  afterContentId?: string;
}

interface WriteIntentRecord {
  journalVersion: 1;
  intentId: string;
  resourceDomainId: string;
  providerInstanceId?: string; // diagnostics/lifecycle only, not journal identity
  scopes: ScopedContentEvidence[];
  owner: ExecutionOwner;
  beforeGeneration: number;
  intentSequence: number;
  commitGeneration?: number;
  journalEpoch: number;
  commitMode: VersionCommitMode;
  externalMutation: ExternalMutationModel;
  status:
    | "pending"
    | "committed-content"
    | "committed-generation"
    | "dirty-unknown";
  restorableSnapshotArtifactIds?: string[];
}

declare const MUTATION_PERMIT: unique symbol;

interface MutationPermit {
  readonly [MUTATION_PERMIT]: true;
  readonly permitId: string;
  readonly intentId: string;
  readonly journalEpoch: number;
  readonly owner: ExecutionOwner;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly scopes: CanonicalLeaseKey[];
}
```

Only the journal manager can mint a `MutationPermit`, and only after the pending
record and resource state are fsynced. The execution backend validates the permit
against the SandboxPlan before launching a mutable Agent/script or opening a write
handle. Flow data, adapters, and model output cannot construct one.

Permits are activation-once capabilities, not reusable bearer records. The trusted
permit registry tracks `issued → active → settled/expired` by `(permitId,
journalEpoch, owner.attemptId, nonce)`. At spawn/script/restore launch, the backend atomically
verifies the journal intent is still pending with identical owner/scopes/intent sequence,
then CAS-activates every permit for that one execution attempt. Reusing an active or
settled permit, changing scope/owner, using it after expiry, or replaying a sealed plan
fails before mutation. FileBroker writes validate the same active attempt; a brokered
single operation activates on first open and settles on final close. Commit, failure,
abort, and timeout settle all permits, and host-key rotation invalidates prepared plans.

Within one execution attempt, all RW uses of the same `resourceDomainId` are merged
into one intent. Canonical prefixes are reduced to a minimal non-overlapping cover (a
parent removes contained children; disjoint prefixes remain separate), and each prefix
has its own content/scope evidence. The journal coordinator allocates intent sequence
independently, then assigns a unique, monotonically increasing domain generation only
when the commit record is appended. Disjoint writers that finish out of reservation
order therefore cannot move generation backward or mutate content without a new
revision. One intent commits that generation and the full scope-evidence set; a
single content ID is never ambiguously treated as both whole-domain and per-prefix
identity.

Ordinary live execution across several resource domains is **not failure-atomic**.
Each domain has its own intent and commit: a participant with a durable commit remains
clean, while any pending/uncertain participant becomes dirty. The phase still fails,
all resource-dependent successors become stale, and resume may continue only from a
globally consistent retained checkpoint cut. Atomic multi-domain semantics are claimed
only for an explicitly prepared provider transaction such as cache restoration.

A `dirty-unknown` resource:

- cannot serve within-run or cross-run cache hits;
- marks dependent phases stale;
- cannot portable-resume as clean;
- must be snapshotted/reconciled under an exclusive lease before reuse;
- remains dirty if the backend cannot produce a trustworthy snapshot.

Version state, journal identity, leases, and cache resource identity are keyed by
`resourceDomainId`, not logical workspace/binding/provider-instance aliases, so two
views of one resource cannot maintain divergent generations.

### 9.2 Mutable version precision

Every successfully committed write intent receives a new generation in commit-WAL
order, even if no mutation is eventually observed. The negotiated commit mode
determines what that generation proves:

| Commit mode | Successful RW result | Cross-run cache/resume guarantee |
|---|---|---|
| `content-snapshot` | Commit allocated generation `G` plus trustworthy scoped `contentId`; optionally retain immutable restorable snapshots | Exact content-keyed reuse is permitted subject to the cache rules below |
| `generation-only` | Commit allocated generation `G` after successful execution | No content-dependent cross-run cache; portable writer resume is forbidden |
| `unavailable` | Retain `dirty-unknown` even when the process exits successfully | No resume skip or cache reuse until an exclusive reconciliation produces trusted state |

A content provider may commit the same before/after content ID while still recording
the attempted generation transition. Generation-only is precise only for writers
coordinated by the same lease/version registry. On `externally-mutable` roots, a fresh
trusted fingerprint/content observation is required after the lease is acquired and at
every cross-run boundary; generation alone never proves that an IDE, Git, sync client,
or other process did not mutate the resource.

Version state, journal identity, leases, and cache resource identity are all keyed by
`resourceDomainId`. Provider instance IDs remain lifecycle/reuse constraints, not an
alternative mutable-resource key.

### 9.3 Cache eligibility and state restoration

Output caching is valid only when the resource world state seen by downstream phases
is the same state represented by the cache record. Declaring `idempotent: false`
always disables phase caching. Otherwise:

```ts
interface PhaseCachePolicy {
  workspaceState?: "none" | "restore"; // default: none
}
```

`workspaceState: "restore"` is accepted only from trusted-authored flow provenance and
only when `InvocationAuthority.allowWorkspaceStateRestore` is true. Inline/generated
flows cannot enable it. The setting authorizes a conditional restoration protocol; it
does not widen workspace access or bypass provider/sandbox checks.

| Resource effect | Cache rule |
|---|---|
| No workspace/resource use | Normal deterministic output cache rules apply |
| Read-only use | Cacheable only after authorization/binding and a trusted current version or declared fingerprint have been obtained |
| Read-write use without a restorable post-state snapshot | Not cacheable, within-run or cross-run |
| Read-write use with `content-snapshot` + `restorable-snapshot` | Cacheable only with `workspaceState: "restore"`; a hit restores post-state under an exclusive write lease and durable write intent before exposing cached output |
| Externally mutable RW root without atomic content CAS/fencing | Not cacheable; a Taskflow lease cannot prevent overwriting an external writer |
| `temp` provider | Never cross-run cacheable; phase lifetime prevents reuse |
| `dedicated` / `worktree` | Reusable only when the current provider instance and trusted content identity match the cache record's expected before-state |
| `dirty-unknown` resource | Never serves a hit; it must reconcile or the phase fails |

```ts
interface CachedScopeTransition {
  logicalPrefix: string;
  scopeDigest: string;
  beforeContentId: string;
  afterContentId: string;
  snapshot: ImmutableArtifactRef;
}

interface CachedResourceTransition {
  resourceDomainId: string;
  access: "read-write";
  provider: "root" | "dedicated" | "worktree";
  providerInstanceId?: string;
  restoreStrategy: RestoreStrategy;
  transactionGroupId: string;
  scopes: CachedScopeTransition[];
}

interface ResourceCheckpointRef {
  checkpointId: string;
  resourceDomainId: string;
  generation: number;
  manifestDigest: string; // canonical base + ordered non-overlapping scope overlays
  materialization?: ImmutableArtifactRef;
}

interface AppliedResourceTransition {
  transitionId: string;
  source: "live" | "cache-restore";
  phaseId: string;
  attemptId: string;
  resourceDomainId: string;
  generation: number; // assigned at this commit, never copied from cache
  beforeCheckpoint?: ResourceCheckpointRef;
  afterCheckpoint?: ResourceCheckpointRef;
  providerInstanceId?: string;
  scopes: Array<{
    logicalPrefix: string;
    scopeDigest: string;
    beforeContentId?: string;
    beforeSnapshot?: ImmutableArtifactRef;
    afterContentId?: string;
    afterSnapshot?: ImmutableArtifactRef;
  }>;
}

interface PhaseCacheRecord {
  cacheSchemaVersion: 2;
  logicalInputHash: string;
  outputArtifact: ImmutableArtifactRef;
  resourceTransitions: CachedResourceTransition[];
}
```

For content-snapshot domains, the journal fold also produces a checkpoint manifest by
applying each committed scope overlay to the preceding manifest in WAL order. This
keeps disjoint-scope concurrency representable without pretending one prefix content
ID describes the entire domain. A provider that cannot verify the resulting manifest
or materialize a retained checkpoint simply does not advertise portable writer resume
for that domain.

Cache eligibility can be decided from declared effects before provider acquisition;
actual lookup cannot. A resource-bearing lookup proceeds as follows:

1. authorize the principal, bind/acquire providers, and resolve exact scopes;
2. obtain each current trusted version/fingerprint and negotiated versioning plan;
3. reject dirty resources, find a record by exact before-content/provider constraints,
   and pin the output plus every snapshot against GC;
4. before any intent, verify artifact existence, content ID, manifest, exact scope
   digest, provider format, and output integrity, then call
   `prepareRestoreTransaction` for that concrete request set;
5. acquire canonical read leases for every RO dependency and write leases for every RW
   transition in one deterministic acquisition, then re-read and require **all**
   versions/fingerprints plus RW provider instances/content IDs to equal the cache key
   and recorded before-state;
6. allocate fresh intent sequences, append/fsync all participant write intents plus
   one `restore-transaction-prepare(transactionId, participants)`, mint permits, and
   seal the prepared restore transaction;
7. atomically restore with expected-before CAS/fencing as negotiated; the backend
   returns observed content only and never commits or reuses cache generations;
8. verify every observed after-content/scope digest, atomically allocate each domain's
   next commit generation, then append/fsync one `restore-transaction-commit`
   containing all participant generations/evidence;
9. fold the WAL into `AppliedResourceTransition` records and only then expose the
   cached phase output and mark the phase completed.

For multiple RW domains, a cache record is eligible only when the backend/provider can
restore the full transition atomically, and the specific request set must receive one
prepared transaction group. There is no generic distributed rollback; without such
support the multi-domain RW phase is not cacheable. The transaction prepare/commit are
single WAL group records: a crash before commit makes all participants dirty during
recovery, while a committed record publishes all participant versions together.
A restore/verification failure leaves every possibly mutated domain `dirty-unknown`
and never returns cached output. An expected-before CAS mismatch guaranteed to mutate
nothing is recorded as an aborted clean transaction and becomes a normal cache miss;
an under-lease mismatch before intent is also a miss. Cache keys include logical
inputs, `resourceDomainId`, logical scope,
effective access, provider-instance constraint where applicable, and the trusted
before-content/fingerprint. Physical paths are never key material.

For an `externally-mutable` root, restoration requires atomic expected-before-content
CAS or external fencing; a lexical recheck followed by `replace-scope` is forbidden.
Successful restoration proves the post-state only at the commit boundary. It cannot
prevent a later external write.
Every downstream resource-bearing phase therefore performs its own fresh observation
after acquiring the lease appropriate to that phase, exactly as it would after live
execution.

Cache-record publication and artifact reference-count increments are one trusted
CacheStore transaction. Deletion first makes the record undiscoverable, then decrements
references; GC deletes only unpinned zero-reference artifacts. Lookup pins all
artifacts before validation and releases pins after output/state commit or abort, so a
snapshot/output cannot disappear after mutation begins.

### 9.4 RunState

```ts
interface WorkspaceSessionState {
  schemaVersion: 2;
  registryId: string;
  planHash: string;
  principalIdHash: string;
  bindings: Record<string, {
    provider: string;
    bindingId: string;
    resourceDomainId: string;
    providerInstanceId: string;
    logicalPrefix: string;
    access: WorkspaceAccess;
    version: ResourceVersion;
    versioning: ResourceVersioningPlan;
    lifetime: BoundCapabilityLifetime;
  }>;
  handles: Record<string, {
    kind: "workspace" | "artifact";
    bindingId: string;
    resourceDomainId: string;
    providerInstanceId: string;
    logicalPrefix: string;
    access: WorkspaceAccess;
    lifetime: BoundCapabilityLifetime;
    producerPhaseId: string;
    producerAttemptId: string;
    exportName: string;
    handleGeneration: number;
    expiresAt?: string;
    contentId?: string;
  }>;
  appliedTransitions: AppliedResourceTransition[]; // WAL-derived, journal order
  outstandingWriteIntents: string[];
  cleanupPending?: string[];
}
```

`RunState.cwd` remains loadable for old runs but is not the new resource source of
truth. Physical paths are not serialized in the portable workspace session.

### 9.5 Resume and relocation

Resume:

1. recompile and compare logical plan hash;
2. authorize/rebind through the current principal and require the same stable
   `registryId` lease/policy namespace;
3. require matching portable `bindingId`, or use path-bound resume only when the
   stored identity mode explicitly permits it;
4. recover pending write intents before cache evaluation;
5. fold the WAL/applied-transition ledger by resource domain and overlapping scope,
   then compute the terminal checkpoint at the resume frontier **before mutation**;
6. acquire applicable leases and compare current provider-instance/content manifest
   only with each domain's terminal checkpoint, never with every historical writer;
7. if all terminal checkpoints match, preserve all ancestor completed writers and
   invalidate only the ordinary DAG stale frontier;
8. if a terminal checkpoint mismatches, compute the earliest affected transitions and
   choose a globally consistent checkpoint cut whose complete materializations are
   retained; before mutation, append/fsync
   `resume-recovery-prepare(cut, invalidatedPhaseIds, participants)` so the WAL fold
   immediately projects every later writer/dependent as `stale-pending`; atomically
   restore that cut under the cache restoration protocol, then publish the restored
   generations and invalidation set in one `resume-recovery-commit` group record;
9. if no complete before-state checkpoint cut exists, fail resume or start a new run;
   never rerun a writer against an arbitrary current state;
10. fail or start a new run on identity replacement for write-capable roots.

A changed physical path with the same registry UUID is relocation. A different UUID
at the same path is replacement. If stable identity is unavailable, the system makes
no portability claim.

A generation-only writer may be skipped only inside the same uninterrupted,
Taskflow-managed coordinator session when generation ownership is still provable. It
is never a portable or cross-run writer-resume proof. Output-only resume of an RW phase
against a mismatched or unverified filesystem state is forbidden.

For example, if writer A produces checkpoint `c1` and later writer B on the same domain
produces `c2`, resume compares current state only with terminal `c2`. It never restores
or reruns A while retaining B as completed. Restoring `c1` is legal only as part of a
chosen checkpoint cut that first invalidates B and every dependent successor.

Checkpoint recovery's CAS/fence expects the freshly observed current content held at
the resume lease boundary. It never reuses a historical cache transition's
`beforeContentId` as the CAS expectation.

The recovery prepare record is deliberately conservative. A crash before any restore
may leave phases stale even if the old world is intact, but recovery can safely rerun
them. A crash after restoring the cut can never reconstruct B as completed because the
durable prepare already dominates older PhaseState. Pending recovery participants are
dirty until the group commit or an explicit mutation-free abort is proven.

### 9.6 Trace and redaction

Portable resource events never contain physical paths:

```text
workspace-authorized
workspace-bound
workspace-created
workspace-lease-acquired
write-intent
path-resolved
workspace-version
handle-minted
workspace-released
```

The no-path guarantee is scoped:

| Data class | Guarantee |
|---|---|
| Structured portable resource events | No physical root/path fields |
| Sandbox/backend structured errors | Redacted with known-root replacement before persistence |
| Agent/model/script stdout/stderr | May contain paths; tagged `sensitivity: user-output` and governed by trace retention/redaction policy |
| Local diagnostics | May contain physical paths; explicitly non-portable and excluded from portable trace/export |

Before persisting free-form backend diagnostics, recursive redaction replaces every
known physical root and normalized alias with `<workspace:ID>`. The RFC does not claim
it can remove a path invented or emitted by a model from arbitrary user output.

### 9.7 Replay

Offline replay uses recorded logical identities, versions, and outputs. It performs no
filesystem call, authorization, provider acquisition, or lease. If overrides change a
path-affecting arg or workspace binding, affected phases become `needs-live-rerun`.
Replay cannot mint a new live capability.

## 10. Nested flows and capability attenuation

### 10.1 Saved/authored flow

```jsonc
{
  "id": "audit-child",
  "type": "flow",
  "use": "package-audit",
  "withWorkspaces": {
    "source": {
      "workspace": "target",
      "subpath": { "argPath": "package" },
      "access": "read-only",
      "maxLifetime": { "scope": "phase" },
      "intent": "existing-directory"
    }
  }
}
```

Children see no parent workspace unless explicitly mapped. The mapping emits a new
ScopedCapability with the attenuated `physicalScopeRoot`. Child requirements are
checked before execution, but providers remain lazy until a child phase becomes ready.

### 10.2 Generated flow and expansion

`flow { def }`, `expand`, and `ctx_spawn` may use only handles/workspaces exported by
the trusted parent envelope. They cannot:

- bind host grants;
- allocate root/worktree provider control;
- widen subpath/access/lifetime;
- enable resolve-only or unsafe write modes;
- directly convert `{steps.*}` text into a PathRef.

`expand:graft` promotes phase results, not capability authority. Any promoted handle
retains its original registry provenance, lifetime, and scope.

## 11. FlowIR and compilation

FlowIR records logical resource semantics only:

```ts
// These fields extend the repository's canonical FlowIR/FlowIRNode contracts;
// they do not define a second parallel IR.
interface CanonicalFlowIR {
  workspaces?: Record<string, FlowIRWorkspaceRequirement>;
}

interface CanonicalFlowIRNode {
  resourceUses: FlowIRResourceUse[];
  cwdUseId?: string;
}

type FlowIRCapabilitySource =
  | { workspace: string }
  | { handle: HandleRef };

interface FlowIRResourceUseBase {
  useId: string;
  sourceRef: FlowIRCapabilitySource;
  scopeExpr?: RelativePathExpr;
  intent: PathIntent;
  access: WorkspaceAccess;
  maxLifetime: CapabilityLifetime;
}

type FlowIRResourceUse = FlowIRResourceUseBase & (
  | { purpose: "cwd"; selector?: never }
  | { purpose: "context"; selector: { kind: "context"; encoding?: string } }
  | { purpose: "script"; selector: { kind: "script-argv"; tokenIndex: number } }
  | {
      purpose: "fingerprint";
      selector: { kind: "fingerprint"; selector: FingerprintSelector };
    }
  | { purpose: "export"; selector: { kind: "export"; exportName: string } }
);

interface BoundResourceUse {
  useId: string;
  resourceDomainId: string;
  logicalWorkspaceId: string;
  logicalPrefix: string;
  intent: PathIntent;
  access: WorkspaceAccess;
  lifetime: BoundCapabilityLifetime;
}
```

Raw cwd/context/script/fingerprint/export fields are compile inputs and lower to one
canonical `resourceUses` entry each. `cwdUseId` points to that entry; there is no
parallel `cwdRef` truth source. Canonical hash and execution consume only
`resourceUses`, and duplicate/missing use IDs fail compilation.

FlowIR keeps symbolic `sourceRef` and `scopeExpr`; `argPath`, `argSegment`, and opaque
runtime handle IDs are unresolved at compile time. Invocation planning may prebind
static root/provider sources, but `BoundResourceUse` is produced per execution unit
when the phase becomes DAG-ready. At that late-bound boundary Core verifies the
producer completed, resolves the current handle generation, evaluates typed args,
applies lifetime/access attenuation, and only then produces `logicalPrefix` and the
SandboxPolicyPlan. No one-shot invocation plan claims to contain future handles.

```text
JSON / .tf.ts
→ normalize legacy forms
→ validate args, provenance restrictions, workspace graph, PathRefs, selectors
→ canonical logical FlowIR
→ authorize invocation bindings
→ phase-ready late binding of providers, typed scopes, and handle generations
→ SandboxPolicyPlan negotiation + LeasePlan + WritePlan + sealed SandboxPlan
→ imperative/event-kernel execution through the same backend
```

FlowIR hash includes logical workspace declarations and refs, not grant names,
physical paths, principal IDs, or machine identity. Execution/phase input hashes add
`resourceDomainId`, a provider-instance constraint only for instance-scoped providers,
scoped logical prefix, effective access, and the trusted committed content
version/fingerprint required by that phase.

W4 extends the existing TypeBox schema, canonical hash, JSON/DSL translator, and
compile/decompile migrations for these fields; it does not introduce a second FlowIR
implementation.

## 12. Filesystem-bearing surfaces

Every path begins with `PathRef`/ScopedCapability, then a surface validator:

```jsonc
{
  "context": [
    {
      "workspace": "target",
      "subpath": { "literalPath": "README.md" },
      "access": "read-only",
      "intent": "existing-file"
    }
  ],
  "run": [
    "node",
    {
      "path": {
        "workspace": "target",
        "subpath": { "literalPath": "scripts/check.mjs" },
        "access": "read-only",
        "intent": "existing-file"
      }
    },
    { "arg": "package" }
  ],
  "cache": {
    "fingerprint": [
      { "git": { "workspace": "target", "ref": "HEAD" } },
      { "glob": { "workspace": "target", "pattern": "src/**/*.ts", "content": true } },
      {
        "file": {
          "workspace": "target",
          "subpath": { "literalPath": "package.json" },
          "intent": "existing-file"
        }
      }
    ]
  }
}
```

Shell-string `run` remains non-interpolated. Structured array tokens distinguish
literal values, typed args, and resolved paths. Script execution receives a SandboxPlan
and filtered environment; it cannot use Core's legacy direct-spawn path in capability
mode. A literal argv[0] such as `node` must resolve through the host baseline executable
allowlist; a workspace-provided argv[0] uses `PathRef` with `intent: "executable"`.

## 13. TypeScript DSL

```ts
export default flow("review-package", (ctx) => {
  const target = ctx.workspace("target", {
    provider: "root",
    access: "read-write",
  });
  const pkg = ctx.args.relativePath("package", { required: true });

  return agent("Review and fix the selected package", {
    cwd: target.path(pkg, {
      access: "read-write",
      intent: "existing-directory",
    }),
  });
});
```

Rune erasure emits the canonical JSON shapes. Decompile and FlowIR round-trip preserve
typed refs, access, intent, provider, nested mappings, and export envelopes.

## 14. Compatibility and defaults

### 14.1 New versus legacy access defaults

| Surface | Default |
|---|---|
| New structured PathRef | `read-only` unless explicit |
| New agent cwd requiring writes | Must declare `access: "read-write"` |
| New script cwd | `read-only`; create/write PathRefs require explicit RW |
| Legacy flow with no cwd or relative literal cwd | Normalize to invocation scope with compatibility `read-write`, matching current behavior; emit migration warning |
| Legacy `temp` / `dedicated` / `worktree` | Normalize to anonymous provider with compatibility `read-write` |
| Unknown/custom tools | Never infer RO; legacy stays compatibility RW, new schema requires explicit access or fails verification |

Access is not inferred from model-facing tool names in the canonical model. Tool lists
are not a reliable filesystem effect system.

### 14.2 0.2.1 bridge for #70

```jsonc
{
  "args": {
    "package": { "type": "relative-path", "required": true }
  },
  "phases": [
    {
      "cwd": "{args.package}"
    }
  ]
}
```

Accepted only when:

- the entire cwd is exactly one `{args.X}` placeholder;
- `X` is a typed `relative-path` arg;
- it lowers to the authorized `invocation` grant plus `argPath`;
- intent is `existing-directory`;
- compatibility access is explicit in the normalized IR;
- the selected host passes single-root agent and script/FileBroker conformance;
- the invocation is `sandboxed`, unless the human principal explicitly opts into the
  documented lower `resolve-only` guarantee.

Absolute values, concatenation, `{steps.*}`, undeclared/legacy args, and unsupported
hosts reject. This bridge is not released before W1a. `cwd.fromArg` is never published.

### 14.3 Legacy lowering

| Existing form | Canonical normalization |
|---|---|
| no cwd | invocation root, compatibility RW |
| relative literal cwd | invocation root + `literalPath`, compatibility RW |
| `temp` | anonymous phase temp provider, compatibility RW |
| `dedicated` | anonymous run dedicated provider, compatibility RW |
| `worktree` | anonymous run worktree derived from invocation root, compatibility RW |
| absolute literal cwd | Legacy-only unsafe path; warning in 0.2.x; 0.3 requires an authorized containing root or explicit resolve-only legacy mode |

## 15. Implementation milestones

### 15.1 W0.5 host feasibility spike

The RFC does not assume that a host's tool permission UI or “safe mode” is an OS
filesystem boundary. Before W1a implementation, a versioned spike must test the real
host binaries on every supported OS/architecture and produce this evidence matrix:

| Host | Candidate Agent mechanism to probe | Script mechanism | Exact subtree status before spike | FileBroker |
|---|---|---|---|---|
| Pi | External/native sandbox wrapper; no built-in boundary is assumed | Taskflow sandbox backend | Unknown | Core-owned candidate; unverified |
| Codex | CLI sandbox/profile capabilities | Taskflow sandbox backend, independent of Codex Agent flags | Unknown; tool-child inheritance must be tested | Core-owned candidate; unverified |
| Claude | Native/external sandbox; permission or safe-mode policy alone is insufficient | Taskflow sandbox backend | Unknown | Core-owned candidate; unverified |
| OpenCode | Native/external sandbox; application permission policy alone is insufficient | Taskflow sandbox backend | Unknown | Core-owned candidate; unverified |
| Grok | Custom/native sandbox profile candidate | Taskflow sandbox backend | Unknown | Core-owned candidate; unverified |

The first W0.5 artifact is `host-support-baseline.json`:

```ts
interface HostProbeTarget {
  host: "pi" | "codex" | "claude" | "opencode" | "grok";
  hostVersion: string;
  hostBinarySha256: string;
  os: "macos" | "linux" | "windows";
  osVersion: string;
  osBuild: string;
  arch: "arm64" | "x64";
  sandboxMechanismVersion: string;
  backendCapabilityVersion: string;
}
```

Its exact checked-in entries are the normative supported target set for the workspace
capability claim. Before that file is approved, the set is empty and no host/OS may be
reported sandbox-conformant. W0.5 cannot exit until the file covers every platform and
host/OS build advertised by the corresponding release package. Each cell binds one
exact host binary digest, OS build, architecture, and sandbox mechanism version; a
single probe never proves a semver/OS range. A missing cell is `unsupported`, not
“probably equivalent”. A different binary/OS build requires a new checked-in result or
an on-machine self-probe with the same suite before sandboxed mode is enabled. Published
support ranges are derived only as the explicit finite set of passing cells; adding or
widening a range requires evidence for every newly claimed tuple first.

The spike records host version, OS/version/architecture, sandbox configuration,
backend capability version, and executable probes for: exact cwd; RO/RW enforcement;
parent/sibling denial;
symlink escape; child/tool process inheritance; baseline runtime usability; user-config
and credential denial; resolver-to-open path-swap/junction resistance; abort/descendant
cleanup; and unsupported-policy fail-closed.
Each host/OS result is classified as `sandboxed-single-root`,
`sandboxed-multi-root`, `resolve-only`, or `unsupported`.

W0.5 exits only with checked-in probe code, raw redacted results, and an owner/decision
for every unknown cell. A host that does not pass remains resolve-only/unsupported and
does not receive the 0.2.1 bridge; it does not block conforming hosts from shipping the
per-host bridge. If the release policy requires Pi support specifically, Pi's failed
spike remains an explicit release blocker rather than being bypassed by weaker claims.

### 15.2 Delivery milestones

The secure bridge cannot precede feasibility and enforcement prerequisites:

| Milestone | Deliverable | Exit condition |
|---|---|---|
| W0 | Resource schema, legacy normalization, typed args, pure path/selector validators, threat-model tests | No execution behavior change |
| W0.5 | Five-host/OS feasibility probes and versioned evidence matrix | At least one delivery host has a credible single-root mechanism; every host is classified without assuming prompt/tool policy is enforcement |
| W1a | Minimal principal authorization, RootRegistry, invocation grant, backend negotiation, single-root scoped SandboxPlan, ScriptExecutor/FileBroker, single-root cross-run/cross-process canonical lease coordinator, write-intent journal + mutation permits | Core workspace I/O/script tests and at least one AgentExecutor pass single-root, concurrent-run, crash, policy-digest, baseline-secret, and credential-isolation tests; bridge enablement remains per-host |
| W1b / 0.2.1 | Exact single typed-arg cwd bridge enabled only on conforming hosts; explicit resolve-only opt-in remains separately labeled | #70 reproduction passes without security overclaim |
| W2 | Multi-root sandbox plans, named root provider, multi-scope atomic lease acquisition, full five-host matrix | Unsupported hosts fail closed |
| W3 | Dedicated/temp/worktree/artifact providers, controller plane, nested attenuation with bound phase/run lifetimes, fan-out unit leases | Provider/lifecycle/nested/fan-out/lifetime tests green |
| W4 / 0.3.0 | PathRef across context/script/fingerprint/export, dynamic handle/export generation and expiry, FlowIR/event/resume/cache integration, content restoration | Full acceptance matrix green |
| W5 | Deprecate raw absolute cwd and remove canonical legacy branches after migration window | Docs/examples use only canonical form |

No milestone is called “secure” based solely on lexical/realpath containment.

## 16. Module layout

```text
packages/taskflow-core/src/resources/
├── schema.ts                 # Workspace/PathRef/selector public shapes
├── normalize.ts              # legacy → canonical forms
├── args.ts                   # typed + legacy arg normalization
├── provenance.ts             # trusted/untrusted flow provenance
├── authority.ts              # InvocationAuthority + authorization
├── registry.ts               # branded RootGrant / RootRegistry
├── policy.ts                 # access/lifetime/scope attenuation
├── resolve.ts                # capability/path resolver only
├── selectors/                # context/glob/git/script/artifact validators
├── leases.ts                 # canonical overlap + ownership protocol
├── journal.ts                # write-intent WAL + recovery
├── permits.ts                # attempt-bound activation/replay registry
├── checkpoints.ts            # scoped manifests + resume frontier/cuts
├── cache-transitions.ts      # cache eligibility + atomic restoration
├── sandbox.ts                # policy preparation/sealing/digests
├── credentials.ts            # logical requirements + opaque broker binding
├── session.ts                # durable logical workspace state/handles
├── backend.ts                # WorkspaceExecutionBackend contracts
├── provider.ts               # provider/controller interfaces
└── providers/
    ├── root.ts
    ├── temp.ts
    ├── dedicated.ts
    ├── worktree.ts
    └── artifact.ts
```

Integration points:

- `schema.ts`: imports resource schemas; retains no path implementation.
- `flowir/*`: logical requirements/uses only.
- imperative runtime and event kernel: consume one bound execution plan/backend.
- `runtime/phases/script.ts`: legacy adapter only; capability mode delegates to
  ScriptExecutor.
- `host/runner-types.ts`: agent request under SandboxPlan, not naked cwd alone.
- `cache.ts` and context pre-read: delegate to FileBroker/selectors.
- `store.ts`: workspace session + journal references.
- `trace.ts` / `exec/events.ts`: portable resource events + sensitivity labels.
- delivery packages: principal/root policy loading and backend conformance.

## 17. Error model

Workspace failures are structured and stable:

```ts
type WorkspaceErrorCode =
  | "TFWS_UNAUTHORIZED_GRANT"
  | "TFWS_UNKNOWN_WORKSPACE"
  | "TFWS_INVALID_PATH"
  | "TFWS_PATH_ESCAPE"
  | "TFWS_ACCESS_ESCALATION"
  | "TFWS_CREDENTIAL_DENIED"
  | "TFWS_PROVIDER_DENIED"
  | "TFWS_PROVIDER_ACQUIRE_FAILED"
  | "TFWS_PROVIDER_RELEASE_FAILED"
  | "TFWS_UNSUPPORTED_SANDBOX_POLICY"
  | "TFWS_LEASE_TIMEOUT"
  | "TFWS_WRITE_INTENT_FAILED"
  | "TFWS_RESOURCE_DIRTY"
  | "TFWS_VERSION_COMMIT_UNAVAILABLE"
  | "TFWS_CACHE_RESTORE_RACE"
  | "TFWS_STATE_RESTORE_FAILED"
  | "TFWS_IDENTITY_MISMATCH"
  | "TFWS_HANDLE_INVALID"
  | "TFWS_SELECTOR_INVALID";

interface WorkspacePolicyError {
  code: WorkspaceErrorCode;
  scope: "phase" | "run";
  retryable: boolean;
  terminal: boolean;
  retryScope: "none" | "same-attempt" | "new-attempt" | "after-reconcile" | "new-run";
  affectedResourceDomainIds?: string[];
  recoveryRequired?: "none" | "cleanup" | "reconcile" | "rebind";
  phaseId?: string;
  logicalWorkspaceId?: string;
  redactedMessage: string;
}
```

`retryable` states whether the operation may be attempted at `retryScope` after the
required recovery/backoff. `terminal` states whether this error instance ends its
declared scope; a terminal attempt may still allow a new-attempt/new-run retry. Thus an
initial lease timeout can be `retryable: true, terminal: false`; the final in-phase
attempt is `terminal: true` and may still declare `retryScope: "new-attempt"`.
Defaults before retry exhaustion are:

| Code | Scope | Retryable / scope | Terminal | Meaning |
|---|---|---|---:|---|
| `TFWS_UNAUTHORIZED_GRANT` | phase | no | yes | Principal cannot use named grant/access |
| `TFWS_UNKNOWN_WORKSPACE` | phase | no | yes | Logical workspace/handle not present |
| `TFWS_INVALID_PATH` | phase | no | yes | Relative path/segment/intent invalid |
| `TFWS_PATH_ESCAPE` | phase | no | yes | realpath/ancestor escapes scoped root |
| `TFWS_ACCESS_ESCALATION` | phase | no | yes | Requested access/lifetime/scope exceeds parent |
| `TFWS_CREDENTIAL_DENIED` | phase | no | yes | Credential ID/audience/purpose/delivery/TTL is unauthorized |
| `TFWS_PROVIDER_DENIED` | phase | no | yes | Provider controller permission missing |
| `TFWS_PROVIDER_ACQUIRE_FAILED` | phase | yes / new-attempt | no | Provider acquire/resume failed |
| `TFWS_PROVIDER_RELEASE_FAILED` | run | yes / after-reconcile | no | Provider release failed after work completion |
| `TFWS_UNSUPPORTED_SANDBOX_POLICY` | phase | no | yes | Backend cannot prepare the exact policy |
| `TFWS_LEASE_TIMEOUT` | phase | yes / new-attempt | no | Canonical resource lease unavailable before timeout |
| `TFWS_WRITE_INTENT_FAILED` | phase | yes / new-attempt | yes | Journal could not be durably persisted, so mutation did not launch |
| `TFWS_RESOURCE_DIRTY` | run | yes / after-reconcile | no | Resource has unresolved write intent/unknown content |
| `TFWS_VERSION_COMMIT_UNAVAILABLE` | run | yes / after-reconcile | no | RW result cannot be committed under the selected versioning plan |
| `TFWS_CACHE_RESTORE_RACE` | phase | yes / same-attempt | no | Prepared CAS/fence rejected with proof that no mutation occurred |
| `TFWS_STATE_RESTORE_FAILED` | run | yes / after-reconcile | yes | Restore may have mutated state; affected domains are dirty |
| `TFWS_IDENTITY_MISMATCH` | run | no | yes | Resume/reuse binding identity differs |
| `TFWS_HANDLE_INVALID` | phase | no | yes | Handle forged, expired, superseded, out of scope, or wrong run |
| `TFWS_SELECTOR_INVALID` | phase | no | yes | Surface-specific selector rejected |

Messages may include redacted logical workspace IDs. Portable errors do not include
physical roots. Callers branch on code and structured classification, not text. A
pre-intent cache before-state mismatch is a normal miss, not an error. Cleanup pending
is persisted run status; `TFWS_PROVIDER_RELEASE_FAILED` is emitted only for an actual
failed cleanup attempt and never rewrites completed model work as failed.

## 18. Validation and test matrix

### 18.1 Authority and provenance

- Grant name exists but principal is unauthorized: reject before provider/spawn.
- Inline/model flow cannot assert trusted-authored provenance.
- Unsafe parallel/resolve-only requires both trusted policy and principal opt-in.
- Workspace-state restoration requires trusted-authored provenance plus principal
  opt-in; inline/generated flows cannot enable it.
- Credential ID/audience/purpose/TTL are principal-authorized; no bearer value enters
  flow JSON or Agent-visible broker responses.
- Provider controller rights never appear in SandboxPlan.

### 18.2 Paths and selectors

- Reject POSIX absolute, drive, UNC, device, NUL, dot/dot-dot, empty, ambiguous
  backslash, invalid NFC/canonical segment cases.
- Distinguish `literalPath`, `argPath`, `segment`, and `argSegment` behavior.
- Enforce each `PathIntent` for existing/create/executable targets.
- Symlink/junction escape and non-existent target ancestor escape fail.
- Context/glob/git/script/artifact selectors retain separate grammar/caps.

### 18.3 Sandbox/backend

- SandboxPlan contains exact attenuated `physicalScopeRoot`.
- Agent and script can read/write only according to scoped grants plus baseline.
- Core workspace context/fingerprint/provider/artifact paths use backend/FileBroker;
  trusted RunStore/journal/lease/trace storage remains outside flow authority.
- `resolve-only` reports its lower guarantee and is never mistaken for sandboxed.
- Unsupported single/multi-root plans fail before execution.
- A lying/incomplete static feature advertisement is caught by `prepareSandbox` for
  exact file grants, mixed RO/RW, ambient denial, private temp, descendants, network,
  baseline mounts, and credentials.
- Prepared-plan expiry, HMAC/key rotation, owner mismatch, permit replay, second spawn,
  and FileBroker reuse all fail before mutation.
- Resolver-brand forgery and path swap between resolve/activation fail; FileBroker
  read/write/fingerprint require sealed race-free descriptor/native-handle identity.
- `policyDigest` is stable under canonical input reordering, changes on every normative
  logical policy input, and excludes physical paths/secrets; `enforcementDigest`
  changes with physical mappings/permit IDs and fails verification if tampered.
- Exact-file provider metadata fails on omission, symlink, content/scan digest change,
  directory widening, or secret-bearing content; Agent tools cannot read bootstrap
  config, credential stores, or whole user configuration directories.
- Sandbox temp is private per execution owner; shared writable temp is available only
  as an explicit workspace with domain/lease/journal semantics.

### 18.4 Leases

- Aliases to same root conflict.
- Every alias shares `resourceDomainId`; dedicated/worktree instances have distinct
  domains and a separate parent control-plane domain.
- Registry startup and runtime provider acquisition reject any physical overlap with
  at least one writable view unless domains are shared or data trees are isolated.
- Parent/child overlapping prefixes conflict correctly.
- Disjoint subtrees may run concurrently.
- Map items, parallel/race/tournament branches acquire unit leases.
- Nested flow does not self-deadlock; reentrancy cannot upgrade authority.
- Concurrent processes/runs share persistent locks; stale-owner recovery is safe.
- Abort/timeout/crash releases or reconciles ownership.
- An external writer is not mistaken for a coordinated Taskflow writer; externally
  mutable roots require fresh version/fingerprint observation.

### 18.5 Journal, resume, and cache

- Journal fsync precedes every mutating process launch.
- Partial write plus failure/timeout/kill leaves `dirty-unknown`.
- Crash after write but before commit is recovered as dirty, never clean N.
- Dirty resource cannot serve cache and marks dependents stale.
- `content-snapshot`, `generation-only`, and `unavailable` commit modes produce the
  specified clean/limited/dirty states.
- RW phases without restorable post-state are never output-cache hits.
- A RW hit acquires its write lease, fsyncs restore intent, restores state, verifies
  exact after-content, then and only then returns cached output.
- Cache output/snapshots are pinned and content/manifest/scope verified before intents;
  GC/tamper/missing artifacts produce a miss/failure without mutation.
- Multi-domain RW cache is rejected without atomic provider-backed restoration.
- `temp` never cross-run caches; dedicated/worktree reuse requires the exact provider
  instance and before-content identity.
- Restore failure leaves every possibly changed resource dirty and exposes no output.
- Historical cache generation is never reused: a hit against current generation 12
  allocates a fresh generation greater than 12.
- Restore-after-mutation/before-WAL-commit crash marks every transaction participant
  dirty; post-commit/pre-index crash folds to one clean group result.
- Same-domain multi-scope intents merge prefixes, retain per-scope evidence, and
  allocate commit-time monotonic domain generations when concurrent disjoint writers
  finish out of intent order.
- Serial writers A→B validate only terminal checkpoint B; restoring A first invalidates
  B and its descendants. Rerun without a materializable before checkpoint is rejected.
- Live multi-domain partial commit keeps committed participants clean, uncertain ones
  dirty, fails the phase, and requires a consistent checkpoint cut for resume.
- Externally mutable RW restore is disabled without atomic expected-content CAS or
  external fencing; a CAS race guaranteed mutation-free becomes a miss/live fallback.
- Generation-only is not a portable writer-resume proof.
- Reconciliation content snapshot commits a new version or remains dirty.
- Same persisted registry UUID at relocated path resumes.
- New UUID at same path does not reuse.
- Path-bound/no-identity modes never claim portable resume.

### 18.6 FlowIR, trace, and replay

- Logical FlowIR hash is machine/grant/principal independent.
- Logical workspace/path/access changes affect hash.
- FlowIR retains symbolic `scopeExpr`; only a bound execution plan resolves arg-driven
  `logicalPrefix`.
- Canonical FlowIR has one resource-use truth source with intent/selector and symbolic
  workspace/handle source; cwd points to it by `useId`.
- `argPath`, `argSegment`, and symbolic handles bind only at phase-ready time in both
  imperative/event-kernel paths.
- Phase terminal, retry replacement, producer failure, same-run resume, cross-run use,
  handle-generation replacement, and external-lifetime rejection enforce the declared
  lifetime/expiry rules.
- Portable resource events contain no physical roots.
- Structured backend errors redact all registered root aliases.
- Free-form user/model output is sensitivity-labeled, not falsely guaranteed path-free.
- Offline replay performs zero authorization/filesystem/provider calls.
- Path/binding override yields `needs-live-rerun`.
- Imperative/event-kernel resource state/events are equivalent.

### 18.7 Host conformance

For Pi, Codex, Claude, OpenCode, and Grok, separately test AgentExecutor and
ScriptExecutor/FileBroker:

1. read inside RO succeeds;
2. write inside RO fails;
3. write inside RW succeeds;
4. attenuated child scope cannot access parent remainder;
5. symlink escape fails;
6. unauthorized user-data path outside grants/baseline fails;
7. exact cwd and no broader writable scope reach the process;
8. unsupported multi-root fails before launch;
9. abort/timeout kills descendants and releases lease;
10. baseline runtime files remain usable without becoming PathRef-addressable;
11. bootstrap/provider credential data is not readable through env, filesystem,
    process inspection/debug, broker response, or descendants;
12. private temp and network policy are enforced for Agent, script, and descendants;
13. exact-file metadata/no-follow and mixed file/directory grant preparation work;
14. probe evidence matches a checked-in host version × OS/version × architecture cell.

### 18.8 Compatibility

- Legacy ArgSpec and undeclared args keep version-1 behavior with warnings.
- Typed relative-path bridge accepts only the exact whole-placeholder form.
- Existing flows normalize to explicit compatibility access without silent RO change.
- Old RunState/trace loads through versioned migration.
- JSON ↔ `.tf.ts` ↔ FlowIR round-trip preserves new and legacy normalized forms.

## 19. Acceptance criteria

The RFC may move from Proposed to Accepted only when design review confirms:

- [ ] Resolve-only and sandboxed claims are separated everywhere.
- [ ] W0.5 freezes and probes every supported host-version/OS-version/architecture cell
  before implementation relies on a sandbox mechanism.
- [ ] W1a enforcement prerequisites precede the 0.2.1 bridge.
- [ ] Scoped subpath attenuation survives into SandboxPlan.
- [ ] Full concrete policy preparation proves exact grants, baseline, private temp,
  descendants, network, and credentials; static backend claims are not sufficient.
- [ ] Mutation permits are attempt-bound, expiring, activation-once, journal-verified,
  and non-replayable across spawn/FileBroker/sealed-plan paths.
- [ ] Agent, script, workspace-bearing Core I/O, fingerprints, and providers share the
  execution backend; trusted control-plane storage is explicitly separate.
- [ ] Canonical overlap leases cover aliases, fan-out, nested flows, and concurrent runs.
- [ ] Lease, version, journal, and cache identities use one `resourceDomainId`, while
  external writers remain outside the coordinator guarantee.
- [ ] Write-intent recovery prevents stale generation/cache reuse after failure/crash.
- [ ] Version commit modes state exactly what success proves for content, generation,
  resume, and cross-run cache.
- [ ] RW cache hits restore and verify filesystem post-state before exposing output;
  ineligible provider/effect combinations fail closed.
- [ ] Cache generations rebase on the current WAL, artifacts are pinned/preflighted,
  multi-domain restore has a group WAL transaction, and external roots require CAS or
  fencing.
- [ ] Resume validates terminal domain checkpoints rather than historical writers and
  never reruns without a consistent materializable before-state cut.
- [ ] Principal authorization and flow provenance cannot be forged by flow JSON.
- [ ] Provider controller and Agent data-plane rights are separate.
- [ ] Path syntax, intents, Unicode, empty values, and legacy args are unambiguous.
- [ ] Binding identity states exactly when relocation is portable.
- [ ] FlowIR stores symbolic scope expressions and bound plans alone store resolved
  prefixes.
- [ ] Canonical FlowIR has one resource-use truth source and phase-ready late binding
  resolves symbolic handle generations.
- [ ] Capability lifetime is expressible and enforced across PathRefs, child mappings,
  exports, handles, RunState, and expiry.
- [ ] Trace guarantees distinguish resource events, structured errors, user output,
  and local diagnostics.
- [ ] Host baseline policy separates bootstrap secrets, allowlisted secret-free
  exact-file metadata, opaque credential use, and private temp; whole user config
  directories/shared ambient temp are forbidden.
- [ ] Policy digest canonical inputs/version/hash and structured error scope/retry/
  terminal semantics are executable and tested.
- [ ] Legacy/new/script access defaults are explicit and tested.
- [ ] One capability resolver coexists with surface-specific selector validators.

The implementation is complete for 0.3.0 only when all five host adapters either pass
the full conformance suite or reject unsupported policies fail-closed, and both runtime
paths pass differential tests.

## 20. Rejected alternatives

| Alternative | Reason |
|---|---|
| `cwd.fromArg` | Field-specific authority model with no host/root/resume semantics |
| Arbitrary cwd interpolation | Path/authority injection and non-portable identity |
| Realpath-only containment | Does not constrain subprocess ambient filesystem access or close TOCTOU |
| Agent-runner-only sandbox | Script and workspace-bearing Core I/O bypass it |
| Workspace-ID locks | Aliases, overlaps, fan-out, and cross-run processes bypass them |
| Generation bump only on success | Partial writes/crashes leave stale clean versions |
| Flow-supplied physical roots | LLM-callable flow data would grant itself authority |
| Prompt-based read-only policy | Not an enforcement boundary |

## 21. Review closure matrix

| Review item | Revision 2 resolution |
|---|---|
| B-1 | W1 split into W1a enforcement prerequisites and W1b bridge; explicit resolve-only vs sandboxed modes |
| B-2 | SandboxGrant carries attenuated `physicalScopeRoot` and logical prefix |
| B-3 | WorkspaceExecutionBackend covers Agent, script, FileBroker, fingerprints, version/restore operations, providers |
| B-4 | Canonical identity + overlapping prefixes + execution-unit leases + nested reentrancy + cross-process coordinator |
| B-5 | fsynced pre-write intent and dirty/unknown crash recovery |
| M-1 | Principals, InvocationAuthority, provenance, and principal→grant authorization defined |
| M-2 | ProviderControllerGrant separated from subprocess data-plane grants |
| M-3 | `literalPath`/`argPath` versus `segment`/`argSegment`, NFC, empty values, and PathIntent defined |
| M-4 | `LegacyArgSpec | TypedArgSpec`, versioned migration, undeclared arg behavior defined |
| M-5 | Dynamic model selection allowed only inside authored envelope and minted as attenuated handle |
| M-6 | Binding identity priority and path-bound/unavailable fallback defined without false relocation claims |
| M-7 | Path-free guarantee scoped to portable resource events; structured redaction and free-form sensitivity separated |
| M-8 | HostBaselinePolicy defined and excluded from flow-addressable authority |
| M-9 | New, legacy, script, and unknown-tool access defaults explicitly separated |
| M-10 | One capability resolver plus dedicated selector validators |

| Second-round item | Revision 3 resolution |
|---|---|
| B-1 cache/post-state | Added effect-based eligibility, artifact preflight/pinning, fresh-generation group WAL, CAS/fenced atomic restore, after-content verification, and terminal-checkpoint resume; RW without restorable state and temp cross-run cache are forbidden |
| M-1 version commit | Replaced `snapshot: boolean` with content-snapshot/generation-only/unavailable commit modes; restore returns observations while WAL alone commits generations |
| M-2 resource alias | Added `resourceDomainId` as the single lease/version/journal/cache identity; startup and runtime acquisition reject writable physical overlaps across domains |
| M-3 FlowIR dynamic scope | Canonical IR has one symbolic resource-use source including handle/intent/selector; phase-ready late binding alone produces resolved `logicalPrefix` |
| M-4 lifetime API | Split public lifetime limits from attempt/run/registry-bound lifetimes; added symbolic handle refs, generation/expiry, retry revocation, and no cross-run runtime handles |
| M-5 host feasibility | Added mandatory W0.5 host-version × OS-version × architecture baseline/probes and per-target bridge gating; FileBroker remains unverified until evidence exists |
| M-6 baseline secrets | Split host-only bootstrap config, exact-file scanned metadata, opaque credential delivery, and private temp; forbade whole user-config/shared ambient writable mounts |
| Minor: wording/versioning | Replaced “on successful”, defined portable/enforcement digests and baseline body binding, and narrowed Core I/O claims to workspace/resource-bearing operations |
| Minor: errors/leases | Defined error code/scope/retry/terminal/recovery semantics and explicitly bounded cross-run coordination against external writers |

| Revision 3 adversarial follow-up | Closure |
|---|---|
| Normative cache ordering | Executive order now prepares policy, acquires/revalidates under lease, fsyncs intent, then restores/executes |
| Resume A→B rollback | Resume folds terminal domain checkpoints and fsyncs a recovery-prepare invalidation set before restoring an earlier cut, so later writers cannot survive a crash as completed |
| Historical/concurrent generations | Cache records carry content only; intent sequence is separate and monotonic generation is allocated at commit WAL time, including out-of-order disjoint writers |
| RO cache race | Cache lookup acquires RO/RW leases together and revalidates every version/fingerprint under lease before returning output or mutating state |
| Multi-resource/multi-scope writes | Specific-set restore negotiation plus group prepare/commit WAL provides cache atomicity; same-domain scopes merge with per-scope evidence; ordinary live multi-domain writes explicitly remain non-atomic |
| External writer overwrite | Externally mutable RW restoration requires atomic expected-content CAS or external fencing; Taskflow-only recheck/replace is forbidden |
| Sandbox overclaim | Complete `prepareSandbox` negotiation validates exact grants/baseline/temp/network/descendants/credentials; static flags are only fast rejection |
| Permit replay | Journal-backed, attempt-bound, expiring, activation-once permits and sealed HMAC plans reject replay across Agent/script/restore/FileBroker |
| Credential attenuation | Branded CredentialGrant/registry binds allowlisted audience/purpose, delivery, and min TTL before the plan; flow data carries no secret or grant |
| FileBroker sealing | Branded resolver output becomes a prepared race-free descriptor/native handle and a separately HMAC-sealed read/write/fingerprint plan |
| Handle/FlowIR implementability | Added public symbolic HandleRef, producer-generation late binding, one canonical resource-use IR, and surface intent/selector fields |

## 22. Final recommendation

Revision 3 has no remaining known design-review Blocker or Major after cache,
durability, sandbox, credential, FileBroker, FlowIR, lifetime, and host-feasibility
adversarial regression. It is acceptance-ready for owner sign-off, but it is not an
implementation-complete claim: W0.5 evidence and the W1a conformance gates remain
mandatory, so the document stays `Proposed` until that sign-off/gate policy is applied.

Keep #70 open until W0.5 and W1a are complete. Then ship the exact typed relative-path
bridge in 0.2.1 only on conforming hosts, with resolve-only exposed as an explicit
lower-guarantee opt-in rather than a security-equivalent fallback.

Do not publish `cwd.fromArg`. Build 0.3.0 around principal-authorized named roots,
scoped capabilities, exact SandboxPlans, a unified execution/FileBroker boundary,
canonical persistent leases, explicit versioning modes, restorable cache transitions,
and write-intent durability. This is the minimum design that makes dynamic cwd reusable
without promising more isolation, cache, or resume correctness than the runtime can
actually enforce.
